import * as THREE from 'three';

/**
 * The sky as a physical atmosphere: single scattering by air (Rayleigh), haze (Mie) and absorption by ozone, along each view
 * ray through a planet-sized shell, lit by the sun and the moon, plus a small isotropic term for light scattered more than
 * once. Everything that has the sky's colour reads it from here: the dome, the haze that distant ridges fade into, the sun's
 * colour as the air reddens it, and the ambient light the sky throws on the world. One model, so they can never disagree.
 *
 * The GPU evaluates it into a small "sky view" table each frame (Hillaire 2020's parameterisation: azimuth from the sun on one
 * axis, elevation on the other, squeezed towards the horizon where the sky changes fastest). The CPU runs the same code with
 * fewer steps for the light colours. Units: radiance relative to the sun's illuminance at the top of the atmosphere.
 */

// Kilometres. Earth-like, with more haze than a clean day: the woods are humid and the references are hazy.
export const ATMOSPHERE = {
  ground: 6360, top: 6460, eye: .25,
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3] as const, rayleighHeight: 8,
  mieScattering: 3.996e-3 * 1.5, mieExtinction: 4.44e-3 * 1.5, mieHeight: 1.2, mieG: .8,
  ozone: [.65e-3, 1.881e-3, .085e-3] as const,
  /** A low layer of boundary-layer haze (humid air over the island): whitens the horizon and leaves the zenith blue. */
  haze: .04, hazeHeight: .45,
  /** Light that has scattered more than once, as a share of what single scattering gives: keeps dusk skies blue overhead. */
  multiple: 2.5,
};
/** The sun's illuminance at the top of the atmosphere, in the scene's light units (the sun light is this times what gets through). */
export const SUN_ILLUMINANCE = 1.62;
/** The moon's, relative to the sun's. The real ratio is about 1:400,000; the eye adapts and the game needs to be playable. */
export const MOON_ILLUMINANCE = SUN_ILLUMINANCE / 520;

export const SKY_LUT_SIZE = [192, 108] as const;

const glslNumber = (v: number) => { const s = v.toPrecision(9); return /[.e]/.test(s) ? s : s + '.'; };
const glslVec3 = (v: readonly number[]) => `vec3(${v.map(glslNumber).join(',')})`;

/** GLSL shared by the table pass and the shaders that read the table. */
export const SKY_LUT_GLSL = `
  // Elevation (radians) to the table's v and back: half the rows for the 20 degrees round the horizon.
  float skyLutV(float elevation){float x=clamp(elevation/1.5707963,-1.,1.);return .5+.5*sign(x)*sqrt(abs(x));}
  float skyLutElevation(float v){float s=v*2.-1.;return sign(s)*s*s*1.5707963;}
  // The table's u is the angle round from the sun's azimuth, 0..pi (the sky is mirror-symmetric about the sun's vertical plane).
  vec2 skyLutUv(vec3 dir,vec3 sunDir){
    vec2 d=dir.xz,s=sunDir.xz;float ld=length(d),ls=length(s);
    float c=(ld>1e-5&&ls>1e-5)?dot(d,s)/(ld*ls):1.;
    return vec2(acos(clamp(c,-1.,1.))/3.14159265,skyLutV(asin(clamp(dir.y,-1.,1.))));
  }
  vec3 skyLookup(sampler2D lut,vec3 dir,vec3 sunDir){return texture2D(lut,skyLutUv(dir,sunDir)).rgb;}
`;

/** The scattering itself, for the table pass. */
const SCATTER_GLSL = `
  const float RG=${glslNumber(ATMOSPHERE.ground)},RT=${glslNumber(ATMOSPHERE.top)},EYE=${glslNumber(ATMOSPHERE.eye)};
  const vec3 BR=${glslVec3(ATMOSPHERE.rayleigh)},BO=${glslVec3(ATMOSPHERE.ozone)};
  const float BMS=${glslNumber(ATMOSPHERE.mieScattering)},BME=${glslNumber(ATMOSPHERE.mieExtinction)},HR=${glslNumber(ATMOSPHERE.rayleighHeight)},HM=${glslNumber(ATMOSPHERE.mieHeight)},G=${glslNumber(ATMOSPHERE.mieG)},MS=${glslNumber(ATMOSPHERE.multiple)};
  const float HAZE=${glslNumber(ATMOSPHERE.haze)},HH=${glslNumber(ATMOSPHERE.hazeHeight)};
  // Distance along a ray from radius r with direction cosine mu to the shell of radius R (outside the ray's start), or -1.
  float toShell(float r,float mu,float R){float b=r*mu,c=r*r-R*R,d=b*b-c;if(d<0.)return -1.;float s=sqrt(d);float t=-b+s;return t;}
  float toGround(float r,float mu){float b=r*mu,c=r*r-RG*RG,d=b*b-c;if(d<0.||mu>0.)return -1.;return -b-sqrt(d);}
  vec3 extinctionAt(float h){
    float ozone=max(0.,1.-abs(h-25.)/15.);
    return BR*exp(-h/HR)+vec3(BME*exp(-h/HM)+HAZE*exp(-h/HH))+BO*ozone;
  }
  // Transmittance from radius r towards a direction of cosine mu, to the top of the atmosphere (0 if the ground is in the way).
  vec3 sunTransmittance(float r,float mu){
    if(toGround(r,mu)>0.)return vec3(0.);
    float len=toShell(r,mu,RT);vec3 depth=vec3(0.);
    for(int i=0;i<8;i++){float t=(float(i)+.5)/8.*len;float h=sqrt(r*r+t*t+2.*r*mu*t)-RG;depth+=extinctionAt(h)*len/8.;}
    return exp(-depth);
  }
  float rayleighPhase(float c){return .0596831*(1.+c*c);}
  float miePhase(float c){float g2=G*G;return .0795775*(1.-g2)/pow(1.+g2-2.*G*c,1.5)*1.5*(1.+c*c)/(2.+g2);}
  // Radiance along dir from the eye, lit by a light of illuminance E from lightDir.
  vec3 scatter(vec3 dir,vec3 lightDir,float E){
    float r=RG+EYE,mu=dir.y;
    float ground=toGround(r,mu),len=ground>0.?ground:toShell(r,mu,RT);
    float c=dot(dir,lightDir);
    float pr=rayleighPhase(c),pm=miePhase(c);
    vec3 sum=vec3(0.),depth=vec3(0.);
    const int N=24;
    for(int i=0;i<N;i++){
      float t0=len*pow(float(i)/float(N),2.),t1=len*pow(float(i+1)/float(N),2.),dt=t1-t0,t=.5*(t0+t1);
      vec3 p=vec3(0.,r,0.)+dir*t;float rp=length(p),h=rp-RG;
      vec3 sigmaR=BR*exp(-h/HR);float sigmaM=BMS*exp(-h/HM)+HAZE*.9*exp(-h/HH);
      vec3 ext=extinctionAt(h);
      vec3 view=exp(-(depth+ext*dt*.5));
      vec3 sun=sunTransmittance(rp,dot(p,lightDir)/rp);
      vec3 single=sigmaR*pr+vec3(sigmaM*pm);
      vec3 multi=(sigmaR+vec3(sigmaM))*.0795775*MS;
      // Light that has scattered several times has lost most of the direct beam's colour (the purple of ozone-filtered twilight
      // sunlight): feed the multiple-scattering term a desaturated beam.
      float sunLum=dot(sun,vec3(.2126,.7152,.0722));vec3 sunMs=mix(vec3(sunLum),sun,.35);
      sum+=view*(sun*single+sunMs*multi)*dt;
      depth+=ext*dt;
    }
    return sum*E;
  }
`;

/** A tiny CPU twin of the model: the same formulas, fewer steps. Used for light colours a few times a second. */
function extinctionAt(h: number, out: number[]) {
  const ozone = Math.max(0, 1 - Math.abs(h - 25) / 15), r = Math.exp(-h / ATMOSPHERE.rayleighHeight), m = ATMOSPHERE.mieExtinction * Math.exp(-h / ATMOSPHERE.mieHeight) + ATMOSPHERE.haze * Math.exp(-h / ATMOSPHERE.hazeHeight);
  for (let k = 0; k < 3; k++) out[k] = ATMOSPHERE.rayleigh[k] * r + m + ATMOSPHERE.ozone[k] * ozone;
  return out;
}
function toShell(r: number, mu: number, R: number) { const b = r * mu, d = b * b - (r * r - R * R); return d < 0 ? -1 : -b + Math.sqrt(d); }
function toGround(r: number, mu: number) { const b = r * mu, d = b * b - (r * r - ATMOSPHERE.ground ** 2); return d < 0 || mu > 0 ? -1 : -b - Math.sqrt(d); }
const scratch = [0, 0, 0];
/** Fraction of light from a direction of cosine `mu` (with the vertical) that reaches the eye, per channel. */
export function transmittance(mu: number, out = new THREE.Color(), steps = 24) {
  const r = ATMOSPHERE.ground + ATMOSPHERE.eye;
  if (toGround(r, mu) > 0) return out.setRGB(0, 0, 0);
  const len = toShell(r, mu, ATMOSPHERE.top), depth = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + .5) / steps * len, h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - ATMOSPHERE.ground;
    extinctionAt(h, scratch); for (let k = 0; k < 3; k++) depth[k] += scratch[k] * len / steps;
  }
  return out.setRGB(Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2]));
}
/** Sky radiance in a direction, lit by a light of illuminance E from lightDir (CPU, coarse). */
export function skyRadiance(dir: THREE.Vector3, lightDir: THREE.Vector3, E: number, out = new THREE.Color(), steps = 10) {
  const r = ATMOSPHERE.ground + ATMOSPHERE.eye, mu = dir.y, ground = toGround(r, mu), len = ground > 0 ? ground : toShell(r, mu, ATMOSPHERE.top);
  const c = dir.dot(lightDir), g = ATMOSPHERE.mieG, g2 = g * g;
  const pr = .0596831 * (1 + c * c), pm = .0795775 * (1 - g2) / Math.pow(1 + g2 - 2 * g * c, 1.5) * 1.5 * (1 + c * c) / (2 + g2);
  const sum = [0, 0, 0], depth = [0, 0, 0], sun = new THREE.Color(), p = new THREE.Vector3();
  for (let i = 0; i < steps; i++) {
    const t0 = len * (i / steps) ** 2, t1 = len * ((i + 1) / steps) ** 2, dt = t1 - t0, t = (t0 + t1) / 2;
    p.set(0, r, 0).addScaledVector(dir, t);
    const rp = p.length(), h = rp - ATMOSPHERE.ground, rr = Math.exp(-h / ATMOSPHERE.rayleighHeight), sm = ATMOSPHERE.mieScattering * Math.exp(-h / ATMOSPHERE.mieHeight) + ATMOSPHERE.haze * .9 * Math.exp(-h / ATMOSPHERE.hazeHeight);
    extinctionAt(h, scratch);
    // Transmittance from this point towards the light: the same as from the eye at that height, close enough at these scales.
    const muLight = p.dot(lightDir) / rp;
    sunTransmittanceAt(rp, muLight, sun);
    const sunRgb = [sun.r, sun.g, sun.b], sunLum = sun.r * .2126 + sun.g * .7152 + sun.b * .0722, sunMs = sunRgb.map(v => sunLum + (v - sunLum) * .35);
    for (let k = 0; k < 3; k++) {
      const sr = ATMOSPHERE.rayleigh[k] * rr, view = Math.exp(-(depth[k] + scratch[k] * dt * .5));
      const single = sr * pr + sm * pm, multi = (sr + sm) * .0795775 * ATMOSPHERE.multiple;
      sum[k] += view * (sunRgb[k] * single + sunMs[k] * multi) * dt;
      depth[k] += scratch[k] * dt;
    }
  }
  return out.setRGB(sum[0] * E, sum[1] * E, sum[2] * E);
}
function sunTransmittanceAt(r: number, mu: number, out: THREE.Color) {
  if (toGround(r, mu) > 0) return out.setRGB(0, 0, 0);
  const len = toShell(r, mu, ATMOSPHERE.top), depth = [0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const t = (i + .5) / 6 * len, h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - ATMOSPHERE.ground;
    extinctionAt(h, scratch); for (let k = 0; k < 3; k++) depth[k] += scratch[k] * len / 6;
  }
  return out.setRGB(Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2]));
}

/**
 * Irradiance the sky throws on an upward and on a downward... (for the ambient light): integrates the sky over the upper
 * hemisphere with a cosine weight. `lightDir`/`E` is the sun or the moon.
 */
export function skyIrradiance(lightDir: THREE.Vector3, E: number, out = new THREE.Color()) {
  const dir = new THREE.Vector3(), radiance = new THREE.Color();
  let r = 0, g = 0, b = 0, weight = 0;
  // A fixed spiral of directions over the hemisphere, cosine distributed (so each sample counts equally).
  const N = 40;
  for (let i = 0; i < N; i++) {
    const u = (i + .5) / N, phi = i * 2.39996323, cosTheta = Math.sqrt(1 - u), sinTheta = Math.sqrt(u);
    dir.set(Math.cos(phi) * sinTheta, cosTheta, Math.sin(phi) * sinTheta);
    skyRadiance(dir, lightDir, E, radiance, 8);
    r += radiance.r; g += radiance.g; b += radiance.b; weight++;
  }
  // E = integral of L cos over the hemisphere = pi * mean(L) under cosine-distributed sampling.
  return out.setRGB(r / weight * Math.PI, g / weight * Math.PI, b / weight * Math.PI);
}

/**
 * The sky-view table on the GPU. `update` re-renders it when the sun (and with it the moon) has moved; it costs well under
 * 0.1 ms (192 x 108 texels).
 */
export function createSkyLut(renderer: THREE.WebGLRenderer) {
  const [W, H] = SKY_LUT_SIZE;
  const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  const uniforms = { sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunE: { value: SUN_ILLUMINANCE }, moonE: { value: MOON_ILLUMINANCE }, airglow: { value: new THREE.Color(0.00006, 0.00008, 0.00016) } };
  const material = new THREE.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: `precision highp float;varying vec2 vUv;uniform vec3 sunDir,airglow;uniform float sunE,moonE;
      ${SKY_LUT_GLSL}${SCATTER_GLSL}
      void main(){
        // The table is in a frame where the sun's azimuth is 0: rebuild this texel's direction and the sun's in that frame.
        float az=vUv.x*3.14159265,el=skyLutElevation(vUv.y);
        vec3 dir=vec3(cos(el)*cos(az),sin(el),cos(el)*sin(az));
        float sunEl=asin(clamp(sunDir.y,-1.,1.));
        vec3 sun=vec3(cos(sunEl),sin(sunEl),0.);
        vec3 L=scatter(dir,sun,sunE)+scatter(dir,-sun,moonE);
        // Night air glows faintly on its own (airglow and starlight), strongest near the horizon where the path is longest.
        L+=airglow*(1.+2.*exp(-max(dir.y,0.)*6.));
        gl_FragColor=vec4(L,1.);
      }`,
  });
  const scene = new THREE.Scene(), camera = new THREE.Camera(), quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false; scene.add(quad);
  const last = new THREE.Vector3(Infinity, 0, 0);
  return {
    texture: target.texture,
    update(sunDir: THREE.Vector3) {
      // Only the sun's elevation matters (the table is relative to its azimuth).
      if (Math.abs(sunDir.y - last.y) < 2e-4 && Number.isFinite(last.x)) return;
      last.copy(sunDir); uniforms.sunDir.value.copy(sunDir);
      const previous = renderer.getRenderTarget(), info = renderer.info.render, { calls, triangles } = info;
      renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(previous);
      info.calls = calls; info.triangles = triangles;
    },
    dispose() { target.dispose(); material.dispose(); quad.geometry.dispose(); },
  };
}
export type SkyLut = ReturnType<typeof createSkyLut>;
