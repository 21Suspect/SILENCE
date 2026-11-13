import * as THREE from 'three';
import { perfOn } from '../../core/perf-flags';

/**
 * The last stage of the picture: from the lit, fogged scene in linear HDR to the 8-bit image on screen.
 *
 *  1. Bloom. The HDR image is halved six times with a 13-tap filter (the first halving weights each tap by 1/(1+luma) so a
 *     single hot pixel cannot flare), then added back up level by level with a 3x3 tent (Jimenez, "Next generation post
 *     processing in Call of Duty: Advanced Warfare", 2014). It is mixed in at a few percent: real lenses and eyes glow round
 *     every bright thing, not just round chosen ones.
 *  2. Exposure, like an eye: the geometric mean of the scene's luminance (centre weighted) is read from the 1/32 level of the
 *     bloom chain and followed with a time constant, faster towards the light than towards the dark. The time of day sets a
 *     key and a range, so night stays dark however long you stand in it.
 *  3. Grade, in scene light before the tone curve: white balance, saturation, contrast round mid grey, cool shadows and warm
 *     highlights, and at night the eye's own grading: colour drains to blue-grey where the light is low (rods take over).
 *  4. The tone curve (ACES or AgX, three.js's own fits), then the sRGB encoding, film grain weighted towards the shadows, and
 *     triangular dither of one 8-bit step so dark gradients do not band.
 */

export type Grade = {
  /** Mid grey the exposure aims for, and the exposure range it may use (scene units). */
  key: number; minExposure: number; maxExposure: number;
  /** Where the eye rests in this light (an exposure), how much of what it meters it follows (0..1), and how far it may close
   *  down and open up from there (stops). See eyeExposure. */
  anchor: number; response: number; close: number; open: number;
  /** Extra exposure, in stops. */
  bias: number;
  /** White balance: -1 cool .. +1 warm, and green-magenta tint. */
  temperature: number; tint: number;
  saturation: number; contrast: number;
  shadows: THREE.Color; highlights: THREE.Color;
  /** 0..1: how much the night grade (blue-grey where it is dark) applies. */
  scotopic: number;
  vignette: number; grain: number; bloom: number;
};

/**
 * The eye's exposure. It used to be the key over what it metered, free across 4.5 stops by day and 8 at night: a lamp pool or
 * the torch's spot raised the meter and the eye closed so far that the moonlit wood round it went black, and the floor and
 * the sky swung the whole picture as the view tilted. Now it rests at the hour's anchor (where it settles in a typical view
 * of the wood in that light) and only leans towards the meter: by `response` of the way in stops, and never more than
 * `close` stops down or `open` stops up. A lamp you stand under still reads bright; the wood beyond it stays as it was.
 */
export function eyeExposure(metered: number, g: Pick<Grade, 'anchor' | 'response' | 'close' | 'open' | 'minExposure' | 'maxExposure'>) {
  const e = g.anchor * Math.pow(metered / g.anchor, g.response);
  return Math.min(g.maxExposure, Math.max(g.minExposure, Math.min(g.anchor * 2 ** g.open, Math.max(g.anchor * 2 ** -g.close, e))));
}

export const TONE_MAPPERS = { aces: 0, agx: 1, neutral: 2 } as const;
export type ToneMapper = keyof typeof TONE_MAPPERS;

const vertexShader = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';

const LEVELS = 6;

export function createFinalImage(renderer: THREE.WebGLRenderer) {
  const half = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping } as const;
  const chain = Array.from({ length: LEVELS }, () => new THREE.WebGLRenderTarget(1, 1, half));
  const adapted = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { ...half, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }));
  let current = 0, reset = true;

  const downMaterial = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() }, karis: { value: 0 } },
    vertexShader, depthTest: false, depthWrite: false,
    fragmentShader: `precision highp float;uniform sampler2D tSrc;uniform vec2 texel;uniform float karis;varying vec2 vUv;
      vec3 t(vec2 o){return texture2D(tSrc,vUv+o*texel).rgb;}
      float w(vec3 c){return karis>.5?1./(1.+dot(c,vec3(.2126,.7152,.0722))):1.;}
      void main(){
        vec3 a=t(vec2(-2,2)),b=t(vec2(0,2)),c=t(vec2(2,2)),d=t(vec2(-2,0)),e=t(vec2(0)),f=t(vec2(2,0)),g=t(vec2(-2,-2)),h=t(vec2(0,-2)),i=t(vec2(2,-2));
        vec3 j=t(vec2(-1,1)),k=t(vec2(1,1)),l=t(vec2(-1,-1)),m=t(vec2(1,-1));
        // Five overlapping boxes; with karis each box is weighted by its own brightness so fireflies cannot dominate.
        vec3 b0=(j+k+l+m)*.25,b1=(a+b+d+e)*.25,b2=(b+c+e+f)*.25,b3=(d+e+g+h)*.25,b4=(e+f+h+i)*.25;
        float w0=w(b0)*.5,w1=w(b1)*.125,w2=w(b2)*.125,w3=w(b3)*.125,w4=w(b4)*.125;
        vec3 c0=(b0*w0+b1*w1+b2*w2+b3*w3+b4*w4)/(w0+w1+w2+w3+w4);
        gl_FragColor=vec4(max(c0,vec3(0.)),1.);
      }`,
  });
  const upMaterial = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() } },
    vertexShader, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
    fragmentShader: `precision highp float;uniform sampler2D tSrc;uniform vec2 texel;varying vec2 vUv;
      vec3 t(vec2 o){return texture2D(tSrc,vUv+o*texel).rgb;}
      void main(){
        vec3 c=t(vec2(0))*4.+(t(vec2(-1,0))+t(vec2(1,0))+t(vec2(0,-1))+t(vec2(0,1)))*2.+t(vec2(-1,-1))+t(vec2(1,-1))+t(vec2(-1,1))+t(vec2(1,1));
        gl_FragColor=vec4(c/16.,1.);
      }`,
  });
  const adaptMaterial = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null as THREE.Texture | null }, tPrevious: { value: null as THREE.Texture | null }, reset: { value: 1 }, dt: { value: 0 } },
    vertexShader, depthTest: false, depthWrite: false,
    fragmentShader: `precision highp float;uniform sampler2D tSrc,tPrevious;uniform float reset,dt;varying vec2 vUv;
      void main(){
        // Metering like a histogram: the brightest part of the view sets the scale, and anything more than 4.5 stops darker
        // counts only at that floor. A plain average let a black night around a torch pool open the eye until the pool burnt out.
        float brightest=-30.;
        for(int j=0;j<9;j++)for(int i=0;i<16;i++){
          vec2 uv=(vec2(float(i),float(j))+.5)/vec2(16.,9.);
          brightest=max(brightest,log2(max(dot(texture2D(tSrc,uv).rgb,vec3(.2126,.7152,.0722)),1e-6)));
        }
        float sum=0.,weights=0.;
        for(int j=0;j<9;j++)for(int i=0;i<16;i++){
          vec2 uv=(vec2(float(i),float(j))+.5)/vec2(16.,9.);
          vec2 d=(uv-.5)*vec2(1.,.8);float w=exp(-dot(d,d)*5.);
          float lum=dot(texture2D(tSrc,uv).rgb,vec3(.2126,.7152,.0722));
          sum+=max(log2(max(lum,1e-6)),brightest-4.5)*w;weights+=w;
        }
        float target=sum/weights,previous=texture2D(tPrevious,vec2(.5)).r;
        // The eye opens slowly in the dark and closes faster in the light (seconds).
        float tau=target>previous?.7:2.2;
        float next=reset>.5?target:previous+(target-previous)*(1.-exp(-dt/tau));
        gl_FragColor=vec4(next,0.,0.,1.);
      }`,
  });
  const finalUniforms = {
    tHdr: { value: null as THREE.Texture | null }, tBloom: { value: null as THREE.Texture | null }, tAdapted: { value: null as THREE.Texture | null },
    toneMapper: { value: TONE_MAPPERS.aces as number }, key: { value: .16 }, exposureRange: { value: new THREE.Vector2(.25, 40) }, bias: { value: 0 },
    anchor: { value: 1 }, response: { value: 1 }, latitude: { value: new THREE.Vector2(20, 20) },
    whiteBalance: { value: new THREE.Vector3(1, 1, 1) }, saturation: { value: 1 }, contrast: { value: 1 },
    shadowTint: { value: new THREE.Color(1, 1, 1) }, highlightTint: { value: new THREE.Color(1, 1, 1) }, scotopic: { value: 0 },
    vignette: { value: .2 }, grain: { value: .02 }, bloom: { value: .04 }, frame: { value: 0 }, resolution: { value: new THREE.Vector2(1, 1) },
  };
  const finalMaterial = new THREE.ShaderMaterial({
    uniforms: finalUniforms, vertexShader, depthTest: false, depthWrite: false,
    fragmentShader: `precision highp float;varying vec2 vUv;
      uniform sampler2D tHdr,tBloom,tAdapted;uniform int toneMapper;
      uniform float key,bias,saturation,contrast,scotopic,vignette,grain,bloom,frame,anchor,response;uniform vec2 exposureRange,resolution,latitude;
      uniform vec3 whiteBalance,shadowTint,highlightTint;
      vec3 RRTAndODTFit(vec3 v){vec3 a=v*(v+.0245786)-.000090537;vec3 b=v*(.983729*v+.4329510)+.238081;return a/b;}
      vec3 aces(vec3 color){
        const mat3 inM=mat3(vec3(.59719,.07600,.02840),vec3(.35458,.90834,.13383),vec3(.04823,.01566,.83777));
        const mat3 outM=mat3(vec3(1.60475,-.10208,-.00327),vec3(-.53108,1.10813,-.07276),vec3(-.07367,-.00605,1.07602));
        color=inM*(color/.6);color=RRTAndODTFit(color);return clamp(outM*color,0.,1.);
      }
      const mat3 REC2020_TO_SRGB=mat3(vec3(1.6605,-.1246,-.0182),vec3(-.5876,1.1329,-.1006),vec3(-.0728,-.0083,1.1187));
      const mat3 SRGB_TO_REC2020=mat3(vec3(.6274,.0691,.0164),vec3(.3293,.9195,.0880),vec3(.0433,.0113,.8956));
      vec3 agxContrast(vec3 x){vec3 x2=x*x,x4=x2*x2;return 15.5*x4*x2-40.14*x4*x+31.96*x4-6.868*x2*x+.4298*x2+.1191*x-.00232;}
      vec3 agx(vec3 color){
        const mat3 inset=mat3(vec3(.856627153315983,.137318972929847,.11189821299995),vec3(.0951212405381588,.761241990602591,.0767994186031903),vec3(.0482516061458583,.101439036467562,.811302368396859));
        const mat3 outset=mat3(vec3(1.1271005818144368,-.1413297634984383,-.14132976349843826),vec3(-.11060664309660323,1.157823702216272,-.11060664309660294),vec3(-.016493938717834573,-.016493938717834257,1.2519364065950405));
        color=inset*(SRGB_TO_REC2020*color);
        color=clamp((log2(max(color,1e-10))+12.47393)/16.5,0.,1.);
        color=agxContrast(color);
        // "Punchy" look: a touch more saturation after the sigmoid, as in Blender.
        float l=dot(color,vec3(.2126,.7152,.0722));color=l+1.2*(color-l);
        color=outset*color;color=pow(max(color,0.),vec3(2.2));
        return clamp(REC2020_TO_SRGB*color,0.,1.);
      }
      vec3 neutral(vec3 color){
        const float startCompression=.8-.04,desaturation=.15;
        float x=min(color.r,min(color.g,color.b));float offset=x<.08?x-6.25*x*x:.04;color-=offset;
        float peak=max(color.r,max(color.g,color.b));if(peak<startCompression)return color;
        float d=1.-startCompression,newPeak=1.-d*d/(peak+d-startCompression);color*=newPeak/peak;
        float g=1.-1./(desaturation*(peak-newPeak)+1.);return mix(color,vec3(newPeak),g);
      }
      vec3 srgb(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
      float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
      void main(){
        vec3 color=texture2D(tHdr,vUv).rgb;
        color=mix(color,texture2D(tBloom,vUv).rgb,bloom);
        float adaptedLum=exp2(texture2D(tAdapted,vec2(.5)).r);
        // The eye rests where the light of the hour puts it and only leans towards what it meters (see eyeExposure in this file).
        float metered=key/max(adaptedLum,1e-6),exposure=anchor*pow(metered/anchor,response);
        exposure=clamp(clamp(exposure,anchor*exp2(-latitude.x),anchor*exp2(latitude.y)),exposureRange.x,exposureRange.y)*exp2(bias);
        color*=exposure;
        // Lens falloff, in light (before the curve), so it darkens like an aperture does.
        vec2 v=(vUv-.5)*vec2(resolution.x/resolution.y,1.);
        color*=1.-vignette*smoothstep(.35,1.25,dot(v,v)*1.6);
        color*=whiteBalance;
        float lum=dot(color,vec3(.2126,.7152,.0722));
        // Night vision: below a few hundredths of mid grey colour drains towards a cool blue-grey.
        float rods=scotopic*(1.-smoothstep(.006,.12,lum));
        color=mix(color,lum*vec3(.78,.9,1.16),rods);
        // Split toning by luminance, then contrast round mid grey in log space, then saturation.
        float tone=smoothstep(.02,.6,lum);
        color*=mix(shadowTint,highlightTint,tone);
        color=max(color,0.);
        vec3 logc=log2(color+1e-5);color=exp2((logc-log2(.18))*contrast+log2(.18))-1e-5;
        lum=dot(color,vec3(.2126,.7152,.0722));color=max(lum+(color-lum)*saturation,0.);
        color=toneMapper==1?agx(color):toneMapper==2?neutral(color):aces(color);
        color=srgb(color);
        // Film grain: zero-mean, a little stronger in the shadows, new every frame.
        float n=hash(gl_FragCoord.xy+frame*vec2(37.,17.))+hash(gl_FragCoord.xy*1.37+frame*vec2(11.,29.))-1.;
        float display=dot(color,vec3(.2126,.7152,.0722));
        color+=n*grain*mix(1.,.45,display);
        // One-step triangular dither for the 8-bit write.
        float d=hash(gl_FragCoord.xy+vec2(frame*.618,frame*.382)*61.)+hash(gl_FragCoord.yx*.73+frame)-1.;
        color+=d/255.;
        gl_FragColor=vec4(clamp(color,0.,1.),1.);
      }`,
  });

  const scene = new THREE.Scene(), camera = new THREE.Camera();
  const quad = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.PlaneGeometry(2, 2), downMaterial); quad.frustumCulled = false; scene.add(quad);
  const draw = (material: THREE.Material, target: THREE.WebGLRenderTarget | null) => { quad.material = material; renderer.setRenderTarget(target); renderer.render(scene, camera); };
  let width = 1, height = 1, frame = 0;
  const white = new THREE.Vector3();

  return {
    resize(w: number, h: number) {
      width = w; height = h;
      let cw = w, ch = h;
      for (const target of chain) { cw = Math.max(1, Math.ceil(cw / 2)); ch = Math.max(1, Math.ceil(ch / 2)); target.setSize(cw, ch); }
      finalUniforms.resolution.value.set(w, h);
      reset = true;
    },
    /** Next exposure measurement starts afresh (a teleport, a reload, the menu closing). */
    resetExposure() { reset = true; },
    /** `hdr` (linear scene light) to `output` (null: the canvas). */
    render(hdr: THREE.Texture, output: THREE.WebGLRenderTarget | null, grade: Grade, dt: number, toneMapper: ToneMapper = 'aces') {
      const autoClear = renderer.autoClear;
      // Down the chain.
      let source = hdr, sw = width, sh = height;
      for (let i = 0; i < LEVELS; i++) {
        downMaterial.uniforms.tSrc.value = source; downMaterial.uniforms.texel.value.set(1 / sw, 1 / sh); downMaterial.uniforms.karis.value = i === 0 ? 1 : 0;
        draw(downMaterial, chain[i]);
        source = chain[i].texture; sw = chain[i].width; sh = chain[i].height;
      }
      // Exposure from level 4 (1/32): before the chain is added back up.
      adaptMaterial.uniforms.tSrc.value = chain[4].texture; adaptMaterial.uniforms.tPrevious.value = adapted[current].texture;
      adaptMaterial.uniforms.reset.value = reset ? 1 : 0; adaptMaterial.uniforms.dt.value = Math.min(dt, .1);
      draw(adaptMaterial, adapted[1 - current]); current = 1 - current; reset = false;
      // Back up, adding each level into the next larger one.
      renderer.autoClear = false;
      for (let i = LEVELS - 1; i > 0; i--) {
        upMaterial.uniforms.tSrc.value = chain[i].texture; upMaterial.uniforms.texel.value.set(1 / chain[i].width, 1 / chain[i].height);
        draw(upMaterial, chain[i - 1]);
      }
      renderer.autoClear = autoClear;
      const u = finalUniforms;
      u.tHdr.value = hdr; u.tBloom.value = chain[0].texture; u.tAdapted.value = adapted[current].texture;
      u.toneMapper.value = TONE_MAPPERS[toneMapper]; u.key.value = grade.key; u.exposureRange.value.set(grade.minExposure, grade.maxExposure); u.bias.value = grade.bias;
      const anchored = perfOn('eyeAnchor');
      u.anchor.value = grade.anchor; u.response.value = anchored ? grade.response : 1; u.latitude.value.set(anchored ? grade.close : 20, anchored ? grade.open : 20);
      // White balance as a cheap Kelvin-like shift: warm lifts red and lowers blue, the tint trades green for magenta.
      white.set(1 + .09 * grade.temperature, 1 - .04 * grade.tint, 1 - .13 * grade.temperature);
      u.whiteBalance.value.copy(white); u.saturation.value = grade.saturation; u.contrast.value = grade.contrast;
      u.shadowTint.value.copy(grade.shadows); u.highlightTint.value.copy(grade.highlights); u.scotopic.value = grade.scotopic;
      // The bloom sum over six levels is about six times the image: normalise it so `bloom` is a plain mix factor.
      u.vignette.value = grade.vignette; u.grain.value = grade.grain; u.bloom.value = grade.bloom / LEVELS; u.frame.value = frame++ % 4096;
      draw(finalMaterial, output);
    },
    /** The adapted exposure, for diagnostics (reads the GPU: dev only). */
    debugTargets() { return { chain, adapted: adapted[current] }; },
    dispose() {
      for (const t of [...chain, ...adapted]) t.dispose();
      for (const m of [downMaterial, upMaterial, adaptMaterial, finalMaterial]) m.dispose();
      quad.geometry.dispose();
    },
  };
}
export type FinalImage = ReturnType<typeof createFinalImage>;
