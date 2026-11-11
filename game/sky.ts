import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/** Solar geometry at a temperate northern latitude, in local solar hours.
 * World +X is east, +Z is south. The sun travels east → south → west. */
export function solarDirection(hours:number,latitude=49,declination=9) {
  const h=(hours-12)*Math.PI/12,lat=latitude*Math.PI/180,dec=declination*Math.PI/180;
  return new THREE.Vector3(-Math.cos(dec)*Math.sin(h),Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(h),Math.sin(lat)*Math.cos(dec)*Math.cos(h)-Math.cos(lat)*Math.sin(dec)).normalize();
}

/** Scene-referred floor for a dark-adapted eye, not a claim about stellar lux. */
export function nightVisibility(daylight:number) {
  const day=THREE.MathUtils.clamp(daylight,0,1);
  return {hemisphere:THREE.MathUtils.lerp(.17,1.0,day),environment:.04+.145*day};
}

/** Exact median-row sRGB samples from the native 1774 × 887 AI daytime
 * reference, ordered horizon → zenith. No eye-matched replacement colors.
 * Source rows: 443,388,332,277,221,166,111,55,0; all 1774 pixels per row. */
export const DAY_SKY_HEX=[0x88b9e6,0x62a0e0,0x4287d3,0x3074c5,0x2466b9,0x1d5caf,0x1955a6,0x18509d,0x185197] as const;

/** Inverse of the game's ACES fit, so sky reference colors survive exposure.
 * The sky bypasses the forest's desaturation in atmosphere.ts; fog is retained. */
export function skyDisplayRadiance(color:THREE.Color){
  const inverse=(y:number)=>{const a=2.51-2.43*y,b=.03-.59*y;return (-b+Math.sqrt(b*b+.56*a*y))/(2*a)/1.24;};
  return new THREE.Color(inverse(color.r),inverse(color.g),inverse(color.b));
}

/** Uniform solid-angle points avoid equirectangular pixel streaks at the poles.
 * Magnitude-like flux distribution: most stars are faint, very few are bright.
 * One immutable batch, with no per-frame object or texture generation. */
export function starCatalog(count=4200){
  let seed=8624;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const positions=new Float32Array(count*3),colors=new Float32Array(count*3),flux=new Float32Array(count),size=new Float32Array(count);
  const hues=[new THREE.Color(0xdbe8ff),new THREE.Color(0xe9efff),new THREE.Color(0xfff6e8),new THREE.Color(0xffe8cc)];
  for(let i=0;i<count;i++){
    const y=random()*2-1,phi=random()*Math.PI*2,r=Math.sqrt(1-y*y),bright=Math.pow(random(),8),hue=hues[Math.floor(random()*hues.length)];
    positions.set([Math.cos(phi)*r,y,Math.sin(phi)*r],i*3);colors.set([hue.r,hue.g,hue.b],i*3);
    flux[i]=.025+bright*1.6;size[i]=.30+bright*.24;
  }
  return {positions,colors,flux,size};
}

const cloudShader=`
  uniform sampler2D uCloudNoise;uniform float uCloudTime;uniform vec3 uCloudEye;
  float cloudNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return texture2D(uCloudNoise,(i+f+.5)/256.).r;}
  vec2 cloudField(vec3 ray){
    if(ray.y<=.06)return vec2(0.);
    vec2 p=(uCloudEye.xz+ray.xz*(max(120.,900.-uCloudEye.y)/max(ray.y,.008))+vec2(uCloudTime*4.2,uCloudTime*1.1))/180.;
    mat2 spin=mat2(.8,-.6,.6,.8);
    // Slowly evolving domain warp breaks up round value-noise islands; fine
    // octaves give the cloud edges torn, translucent wisps instead of blobs.
    p+=vec2(cloudNoise(p*.39+8.7),cloudNoise(p*.43+31.2))*.75;
    float broad=cloudNoise(p),detail=cloudNoise(spin*p*2.03+17.3);
    float field=broad*.51+detail*.25+cloudNoise(spin*p*4.17+vec2(31.7,uCloudTime*.003))*.13+cloudNoise(p*8.61+42.9)*.065+cloudNoise(spin*p*17.3+72.1)*.03+cloudNoise(p*35.1+98.4)*.015;
    float density=pow(smoothstep(.47,.72,field),1.45)*smoothstep(.06,.22,ray.y);
    return vec2(density,detail);
  }
  float cloudTransmission(float density){return exp(-density*4.7);}
`;

function cloudNoiseTexture(){
  const data=new Uint8Array(256*256*4);let seed=932814;
  for(let i=0;i<data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const v=seed>>>24;data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;}
  const texture=new THREE.DataTexture(data,256,256,THREE.RGBAFormat);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  texture.magFilter=texture.minFilter=THREE.LinearFilter;texture.needsUpdate=true;return texture;
}

/** Original HDR radiance illuminates PBR materials. The visible sky retains
 * the calibrated blue palette and resolved stars beneath advected cloud layers. */
export function createSky(renderer:THREE.WebGLRenderer,scene:THREE.Scene,sun:THREE.DirectionalLight,hemi:THREE.HemisphereLight) {
  const placeholder=new THREE.DataTexture(new Uint8Array([120,158,198,255]),1,1);placeholder.needsUpdate=true;
  const cloudTexture=cloudNoiseTexture(),cloudUniform={uCloudNoise:{value:cloudTexture},uCloudTime:{value:0},uCloudEye:{value:new THREE.Vector3()}};
  const uniform={...cloudUniform,nightMap:{value:placeholder as THREE.Texture},ready:{value:0},dayPalette:{value:DAY_SKY_HEX.map(hex=>new THREE.Color(hex))},daylight:{value:1},nightAmount:{value:0},twilight:{value:0},sunDirection:{value:solarDirection(6.4)},starRotation:{value:0}};
  const material=new THREE.ShaderMaterial({uniforms:uniform,side:THREE.BackSide,depthWrite:false,depthTest:true,
    vertexShader:`varying vec3 vDirection;void main(){vDirection=position;vec4 p=projectionMatrix*vec4(mat3(viewMatrix)*position,1.);gl_Position=vec4(p.xy,p.w*.999999,p.w);}`,
    fragmentShader:`
      precision highp float;varying vec3 vDirection;
      uniform sampler2D nightMap;uniform float daylight,nightAmount,twilight,starRotation,ready;uniform vec3 sunDirection,dayPalette[9];
      ${cloudShader}
      vec2 equirect(vec3 d){return vec2(atan(d.z,d.x)/6.28318530718+.5,asin(clamp(d.y,-1.,1.))/3.14159265359+.5);}
      vec3 panorama(sampler2D image,vec2 uv){
        // atan wraps from 1 to 0 at the panorama seam. Correct the derivatives
        // before mip selection, otherwise one screen column samples the whole
        // image's coarsest mip and appears as a dashed bright vertical stripe.
        vec2 gx=dFdx(uv),gy=dFdy(uv);
        gx.x-=floor(gx.x+.5);gy.x-=floor(gy.x+.5);
        vec3 color=texture2DGradEXT(image,uv,gx,gy).rgb;
        // The source pixels are retained verbatim. A narrow wrap blend is done
        // only while projecting the panorama onto the dome, hiding edge seams.
        float seam=1.-smoothstep(0.,.004,min(uv.x,1.-uv.x));
        if(seam>0.)color=mix(color,texture2DGradEXT(image,vec2(1.-uv.x,uv.y),vec2(-gx.x,gx.y),vec2(-gy.x,gy.y)).rgb,seam*.5);
        return color;
      }
      vec3 displayRadiance(vec3 y){vec3 a=2.51-2.43*y,b=.03-.59*y;return (-b+sqrt(b*b+.56*a*y))/(2.*a)/1.24;}
      vec3 referenceDay(vec3 ray){
        float elevation=asin(clamp(ray.y,0.,1.))*5.09295817894;
        vec3 color=dayPalette[8];
        for(int i=0;i<8;i++){if(elevation>=float(i)&&elevation<float(i+1))color=mix(dayPalette[i],dayPalette[i+1],elevation-float(i));}
        if(ray.y<0.)color*=exp(ray.y*4.);
        return displayRadiance(mix(dayPalette[2],color,.48));
      }
      void main(){
        vec3 ray=normalize(vDirection);
        vec3 day=referenceDay(ray);
        float sunFacing=pow(max(dot(normalize(vec3(ray.x,.05,ray.z)),normalize(vec3(sunDirection.x,.05,sunDirection.z))),0.),4.);
        float horizon=exp(-max(ray.y,0.)*7.);
        day*=mix(vec3(.45,.53,.74),vec3(1.),daylight);
        day+=vec3(.64,.26,.08)*twilight*horizon*(.22+.78*sunFacing);
        float c=cos(starRotation),s=sin(starRotation);
        // Rotate about the celestial pole (49° north), not about the zenith.
        vec3 axis=normalize(vec3(0.,.75471,-.65606));
        vec3 starRay=ray*c+cross(axis,ray)*s+axis*dot(axis,ray)*(1.-c);
        vec2 starUv=equirect(starRay);
        // Original HDR remains the low-frequency night radiance backdrop. Its
        // new star catalog is projected separately at actual screen resolution.
        vec3 stars=panorama(nightMap,starUv)*ready;
        // A photographed/generated panorama is not calibrated at its exact
        // pole; fade the last half-degree so stretched top-row pixels vanish.
        stars*=1.-smoothstep(.996,1.,starUv.y);
        stars*=smoothstep(-.06,.1,ray.y);
        vec3 color=day*daylight+stars*nightAmount;
        color+=vec3(.001,.002,.004)*(1.-daylight);
        float solar=smoothstep(cos(.0068),cos(.0062),dot(ray,sunDirection));
        float solarHalo=pow(max(dot(ray,sunDirection),0.),2400.)*.012;
        vec3 solarColor=displayRadiance(mix(vec3(1.,.12,.014),vec3(1.,.95,.84),smoothstep(.04,.48,sunDirection.y)))*1.2;
        color+=solarColor*(solar+solarHalo)*smoothstep(-.015,.025,sunDirection.y);
        vec3 moonDirection=-sunDirection;
        // Half-degree lunar disc, resolved with a pixel-wide antialiased limb.
        float moonAngle=acos(clamp(dot(ray,moonDirection),-1.,1.));
        float lunar=1.-smoothstep(.0045-fwidth(moonAngle),.0045+fwidth(moonAngle),moonAngle);
        if(lunar>0. && nightAmount>.001){
        vec3 moonRight=normalize(cross(vec3(0.,1.,0.),moonDirection));
        vec3 moonUp=cross(moonDirection,moonRight);
        vec2 moonUV=vec2(dot(ray,moonRight),dot(ray,moonUp))/.0045;
        float maria=cloudNoise(moonUV*3.7+91.)*.6+cloudNoise(moonUV*9.+34.)*.4;
        float moonShade=sqrt(max(0.,1.-dot(moonUV,moonUV)))*.55+.45;
        color+=vec3(.65,.66,.62)*lunar*nightAmount*moonShade*(.55+.45*maria);
        }
        vec2 cloud=cloudField(ray);float transmission=cloudTransmission(cloud.x);
        float rim=pow(max(dot(ray,sunDirection),0.),8.)*pow(1.-cloud.x,2.);
        // Optical thickness shades the underside while the thin fringes catch
        // the sun. Keep clear gaps completely untouched by this compositing.
        float shade=.22+.45*pow(1.-cloud.x,1.6)+.11*cloud.y+.15*max(sunDirection.y,0.);
        vec3 cloudDay=vec3(.47,.51,.57)*shade+vec3(.48,.43,.34)*rim;
        cloudDay=mix(cloudDay,vec3(.42,.22,.12)*(.65+rim),twilight*.55);
        float moonRim=pow(max(dot(ray,moonDirection),0.),12.)*.006;
        vec3 cloudNight=vec3(.0013,.0020,.0034)+vec3(.65,.75,1.)*moonRim;
        color=mix(mix(cloudNight,cloudDay,daylight),color,transmission);
        gl_FragColor=vec4(color,1.);
      }`});
  const dome=new THREE.Mesh(new THREE.SphereGeometry(1,48,24),material);dome.name='HDR sky with drifting clouds';dome.frustumCulled=false;dome.renderOrder=-1000;scene.add(dome);scene.background=null;scene.userData.hasSky=true;
  let disposed=false,dayTexture:THREE.DataTexture|undefined,nightTexture:THREE.DataTexture|undefined,environment:THREE.WebGLRenderTarget|undefined;
  const generator=new THREE.PMREMGenerator(renderer);generator.compileEquirectangularShader();
  const loader=new HDRLoader();
  loader.load('/sky/cloudless-day.hdr',texture=>{
    if(disposed){texture.dispose();return;}dayTexture=texture;texture.mapping=THREE.EquirectangularReflectionMapping;
    environment=generator.fromEquirectangular(texture);scene.environment=environment.texture;generator.dispose();
  },undefined,()=>{generator.dispose();});
  loader.load('/sky/starfield-night.hdr',texture=>{if(disposed){texture.dispose();return;}nightTexture=texture;texture.mapping=THREE.EquirectangularReflectionMapping;uniform.nightMap.value=texture;uniform.ready.value=1;});
  const catalog=starCatalog(),starGeometry=new THREE.BufferGeometry();
  starGeometry.setAttribute('position',new THREE.BufferAttribute(catalog.positions,3));
  starGeometry.setAttribute('color',new THREE.BufferAttribute(catalog.colors,3));
  starGeometry.setAttribute('flux',new THREE.BufferAttribute(catalog.flux,1));
  starGeometry.setAttribute('sigma',new THREE.BufferAttribute(catalog.size,1));
  const starUniform={...cloudUniform,rotation:uniform.starRotation,amount:uniform.nightAmount,pixelRatio:{value:renderer.getPixelRatio()}};
  const starMaterial=new THREE.ShaderMaterial({uniforms:starUniform,vertexColors:true,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:true,
    vertexShader:`attribute float flux,sigma;uniform float rotation,pixelRatio;varying vec3 tint;varying float brightness,width,extent,elevation;varying vec3 vStarRay;
      void main(){vec3 axis=normalize(vec3(0.,.75471,-.65606));float c=cos(-rotation),s=sin(-rotation);
        vec3 ray=position*c+cross(axis,position)*s+axis*dot(axis,position)*(1.-c);
        vStarRay=ray;elevation=ray.y;tint=color;brightness=flux;width=sigma*pixelRatio;
        extent=max(2.,ceil(width*6.));gl_PointSize=extent;
        vec4 p=projectionMatrix*vec4(mat3(viewMatrix)*ray,1.);gl_Position=vec4(p.xy,p.w*.999998,p.w);
      }`,
    fragmentShader:`uniform float amount;varying vec3 tint,vStarRay;varying float brightness,width,extent,elevation;
      ${cloudShader}
      void main(){vec2 p=(gl_PointCoord-.5)*extent;float profile=exp(-dot(p,p)/(2.*width*width));
        float extinction=smoothstep(-.015,.15,elevation)*mix(.35,1.,smoothstep(.02,.65,elevation));
        gl_FragColor=vec4(tint*brightness*profile*amount*extinction*cloudTransmission(cloudField(normalize(vStarRay)).x),1.);
      }`});
  const starPoints=new THREE.Points(starGeometry,starMaterial);starPoints.name='Resolved stellar points';starPoints.frustumCulled=false;starPoints.renderOrder=-999;scene.add(starPoints);
  const fog=new THREE.Color(),skyAmbient=new THREE.Color(),groundAmbient=new THREE.Color();
  const noonFog=new THREE.Color(0x849caa),dawnFog=new THREE.Color(0x9b9f91),nightFog=new THREE.Color(0x101b28);
  const warmSun=new THREE.Color(0xff753a),highSun=new THREE.Color(0xfff2dc);
  const brightSky=new THREE.Color(0xc2d9e5),darkSky=new THREE.Color(0x829bb4),brightGround=new THREE.Color(0x444b30),darkGround=new THREE.Color(0x52606b);
  return {
    update(hours:number,player:THREE.Vector3,time:number){
      cloudUniform.uCloudTime.value=time;cloudUniform.uCloudEye.value.copy(player);
      const direction=solarDirection(hours),elevation=direction.y;
      starUniform.pixelRatio.value=renderer.getPixelRatio();
      const daylight=THREE.MathUtils.smoothstep(elevation,-.14,.16);
      const darkness=1-daylight;
      starPoints.visible=darkness>.015;
      const twilight=Math.exp(-Math.pow((elevation-.015)/.16,2));
      uniform.sunDirection.value.copy(direction);uniform.daylight.value=daylight;uniform.nightAmount.value=Math.pow(darkness,2.2);uniform.twilight.value=twilight;uniform.starRotation.value=(hours-18)*Math.PI/12;
      sun.intensity=1.32*THREE.MathUtils.smoothstep(elevation,-.025,.30);sun.color.copy(warmSun).lerp(highSun,THREE.MathUtils.smoothstep(elevation,.03,.55));
      const visibility=nightVisibility(daylight);
      hemi.intensity=visibility.hemisphere;hemi.color.copy(skyAmbient.copy(darkSky).lerp(brightSky,daylight));hemi.groundColor.copy(groundAmbient.copy(darkGround).lerp(brightGround,daylight));
      scene.environmentIntensity=visibility.environment;
      fog.copy(noonFog).lerp(dawnFog,twilight*.6).lerp(nightFog,darkness);
      scene.userData.fogColor=fog;scene.userData.skyColor=fog;scene.userData.sunDirection=direction;scene.userData.sunScatterColor=sun.color;
      return {darkness,sunDirection:direction,sunElevation:elevation,daylight};
    },
    dispose(){disposed=true;scene.remove(dome,starPoints);starGeometry.dispose();starMaterial.dispose();dome.geometry.dispose();material.dispose();placeholder.dispose();cloudTexture.dispose();dayTexture?.dispose();nightTexture?.dispose();environment?.dispose();generator.dispose();if(scene.environment===environment?.texture)scene.environment=null;delete scene.userData.hasSky;delete scene.userData.sunDirection;delete scene.userData.fogColor;delete scene.userData.sunScatterColor;}
  };
}
