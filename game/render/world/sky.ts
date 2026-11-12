import { perfOn } from '../../core/perf-flags';
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createSkyLut, SKY_LUT_GLSL, SUN_ILLUMINANCE, MOON_ILLUMINANCE, transmittance, skyRadiance, skyIrradiance } from './sky-model';
import { gradeFor, fogDensityFor } from '../post/grade';
import type { Grade } from '../post/final-image';

/** Solar geometry at a temperate northern latitude, in local solar hours.
 * World +X is east, +Z is south. The sun travels east → south → west. */
export function solarDirection(hours:number,latitude=49,declination=9) {
  const h=(hours-12)*Math.PI/12,lat=latitude*Math.PI/180,dec=declination*Math.PI/180;
  return new THREE.Vector3(-Math.cos(dec)*Math.sin(h),Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(h),Math.sin(lat)*Math.cos(dec)*Math.cos(h)-Math.cos(lat)*Math.sin(dec)).normalize();
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
    float density=pow(smoothstep(.53,.86,field),1.7)*smoothstep(.06,.22,ray.y);
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

/**
 * The sky dome and the light the sky gives. Its colour comes from the physical atmosphere (game/render/world/sky-model.ts) in
 * linear light: the same table colours the haze, and the same model gives the sun its colour as it sinks and the sky its
 * ambient light. Clouds are lit by that sun and that sky. Stars and the moon come out as it gets dark. The static noon HDR
 * still lights specular reflections (scaled with the sky's brightness) until the environment follows the sky too.
 */
export function createSky(renderer:THREE.WebGLRenderer,scene:THREE.Scene,sun:THREE.DirectionalLight,hemi:THREE.HemisphereLight) {
  const placeholder=new THREE.DataTexture(new Uint8Array([120,158,198,255]),1,1);placeholder.needsUpdate=true;
  const lut=createSkyLut(renderer);
  const cloudTexture=cloudNoiseTexture(),cloudUniform={uCloudNoise:{value:cloudTexture},uCloudTime:{value:0},uCloudEye:{value:new THREE.Vector3()}};
  const uniform={...cloudUniform,skyLut:{value:lut.texture},nightMap:{value:placeholder as THREE.Texture},ready:{value:0},nightAmount:{value:0},sunDirection:{value:solarDirection(6.4)},starRotation:{value:0},
    sunRadiance:{value:new THREE.Color()},cloudSun:{value:new THREE.Color()},cloudSky:{value:new THREE.Color()},moonRadiance:{value:.02},starScale:{value:.0055}};
  const material=new THREE.ShaderMaterial({uniforms:uniform,side:THREE.BackSide,depthWrite:false,depthTest:true,
    vertexShader:`varying vec3 vDirection;void main(){vDirection=position;vec4 p=projectionMatrix*vec4(mat3(viewMatrix)*position,1.);gl_Position=vec4(p.xy,p.w*.999999,p.w);}`,
    fragmentShader:`
      precision highp float;varying vec3 vDirection;
      uniform sampler2D nightMap,skyLut;uniform float nightAmount,starRotation,ready,moonRadiance,starScale;uniform vec3 sunDirection,sunRadiance,cloudSun,cloudSky;
      ${cloudShader}
      ${SKY_LUT_GLSL}
      vec2 equirect(vec3 d){return vec2(atan(d.z,d.x)/6.28318530718+.5,asin(clamp(d.y,-1.,1.))/3.14159265359+.5);}
      vec3 panorama(sampler2D image,vec2 uv){
        // atan wraps from 1 to 0 at the panorama seam. Correct the derivatives
        // before mip selection, otherwise one screen column samples the whole
        // image's coarsest mip and appears as a dashed bright vertical stripe.
        vec2 gx=dFdx(uv),gy=dFdy(uv);
        gx.x-=floor(gx.x+.5);gy.x-=floor(gy.x+.5);
        vec3 color=texture2DGradEXT(image,uv,gx,gy).rgb;
        float seam=1.-smoothstep(0.,.004,min(uv.x,1.-uv.x));
        if(seam>0.)color=mix(color,texture2DGradEXT(image,vec2(1.-uv.x,uv.y),vec2(-gx.x,gx.y),vec2(-gy.x,gy.y)).rgb,seam*.5);
        return color;
      }
      void main(){
        vec3 ray=normalize(vDirection);
        // Below the horizon the dome is never seen through the ground; keep the air's colour there rather than black.
        vec3 color=skyLookup(skyLut,vec3(ray.x,max(ray.y,-.02),ray.z),sunDirection);
        float c=cos(starRotation),s=sin(starRotation);
        // Rotate about the celestial pole (49° north), not about the zenith.
        vec3 axis=normalize(vec3(0.,.75471,-.65606));
        vec3 starRay=ray*c+cross(axis,ray)*s+axis*dot(axis,ray)*(1.-c);
        vec2 starUv=equirect(starRay);
        vec3 stars=panorama(nightMap,starUv)*ready;
        stars*=1.-smoothstep(.996,1.,starUv.y);
        stars*=smoothstep(-.06,.1,ray.y);
        color+=stars*nightAmount*starScale;
        // The sun's disc: half a degree, its radiance already reddened by the air (capped so the bloom stays a glow).
        float solar=smoothstep(cos(.0068),cos(.0062),dot(ray,sunDirection));
        color+=sunRadiance*solar;
        vec3 moonDirection=-sunDirection;
        float moonAngle=acos(clamp(dot(ray,moonDirection),-1.,1.));
        float lunar=1.-smoothstep(.0045-fwidth(moonAngle),.0045+fwidth(moonAngle),moonAngle);
        if(lunar>0. && nightAmount>.001){
          vec3 moonRight=normalize(cross(vec3(0.,1.,0.),moonDirection));
          vec3 moonUp=cross(moonDirection,moonRight);
          vec2 moonUV=vec2(dot(ray,moonRight),dot(ray,moonUp))/.0045;
          float maria=cloudNoise(moonUV*3.7+91.)*.6+cloudNoise(moonUV*9.+34.)*.4;
          float moonShade=sqrt(max(0.,1.-dot(moonUV,moonUV)))*.55+.45;
          color+=vec3(.95,.97,1.)*moonRadiance*lunar*nightAmount*moonShade*(.55+.45*maria);
        }
        // Clouds: lit by the sun as the model colours it (bright fringes towards it) and by the sky's own light from above.
        vec2 cloud=cloudField(ray);float transmission=cloudTransmission(cloud.x);
        float toward=max(dot(ray,sunDirection),0.);
        float silver=pow(toward,8.)*pow(1.-cloud.x,2.)*2.5+pow(toward,2.)*.35;
        float body=.35+.55*pow(1.-cloud.x,1.4)+.1*cloud.y;
        vec3 cloudColor=cloudSun*(body*.6+silver)+cloudSky*(.65+.35*cloud.y);
        float moonRim=pow(max(dot(ray,moonDirection),0.),12.)*moonRadiance*.05*nightAmount;
        cloudColor+=vec3(.65,.75,1.)*moonRim;
        color=mix(cloudColor,color,transmission);
        gl_FragColor=vec4(color,1.);
      }`});
  const dome=new THREE.Mesh(new THREE.SphereGeometry(1,48,24),material);dome.name='HDR sky with drifting clouds';dome.frustumCulled=false;
  // Drawn last of the opaque scene: it sits at the far plane and tests depth, so it is shaded only where it shows. Drawn first
  // (-1000), the cloud shader ran under every tree and hill (-0.4 ms at spawn at 1920x1080 with the ground drawn late too).
  dome.renderOrder=perfOn('skyLast')?1000:-1000;scene.add(dome);scene.background=null;scene.userData.hasSky=true;
  scene.userData.skyLut=lut.texture;
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
  const starUniform={...cloudUniform,rotation:uniform.starRotation,amount:uniform.nightAmount,pixelRatio:{value:renderer.getPixelRatio()},starScale:uniform.starScale};
  const starMaterial=new THREE.ShaderMaterial({uniforms:starUniform,vertexColors:true,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:true,
    vertexShader:`attribute float flux,sigma;uniform float rotation,pixelRatio;varying vec3 tint;varying float brightness,width,extent,elevation;varying vec3 vStarRay;
      void main(){vec3 axis=normalize(vec3(0.,.75471,-.65606));float c=cos(-rotation),s=sin(-rotation);
        vec3 ray=position*c+cross(axis,position)*s+axis*dot(axis,position)*(1.-c);
        vStarRay=ray;elevation=ray.y;tint=color;brightness=flux;width=sigma*pixelRatio;
        extent=max(2.,ceil(width*6.));gl_PointSize=extent;
        vec4 p=projectionMatrix*vec4(mat3(viewMatrix)*ray,1.);gl_Position=vec4(p.xy,p.w*.999998,p.w);
      }`,
    fragmentShader:`uniform float amount,starScale;varying vec3 tint,vStarRay;varying float brightness,width,extent,elevation;
      ${cloudShader}
      void main(){vec2 p=(gl_PointCoord-.5)*extent;float profile=exp(-dot(p,p)/(2.*width*width));
        float extinction=smoothstep(-.015,.15,elevation)*mix(.35,1.,smoothstep(.02,.65,elevation));
        gl_FragColor=vec4(tint*brightness*profile*amount*starScale*extinction*cloudTransmission(cloudField(normalize(vStarRay)).x),1.);
      }`});
  const starPoints=new THREE.Points(starGeometry,starMaterial);starPoints.name='Resolved stellar points';starPoints.frustumCulled=false;starPoints.renderOrder=-999;scene.add(starPoints);
  // Light colours from the model, refreshed when the sun has moved a little (each is a few hundred small CPU evaluations).
  const mist=new THREE.Color(),groundBounce=new THREE.Color(),sunColor=new THREE.Color(),skyE=new THREE.Color(),moonSkyE=new THREE.Color(),horizon=new THREE.Color(),moonHorizon=new THREE.Color(),fog=new THREE.Color();
  const groundTint=new THREE.Color(.82,.9,.62),grade:Grade=gradeFor(1),side=new THREE.Vector3(),moonDir=new THREE.Vector3();
  const noonSky=skyIrradiance(new THREE.Vector3(0,.8,.6).normalize(),SUN_ILLUMINANCE),noonLuminance=noonSky.r*.2126+noonSky.g*.7152+noonSky.b*.0722;
  let lastElevation=Infinity;
  scene.userData.grade=grade;
  return {
    update(hours:number,player:THREE.Vector3,time:number){
      cloudUniform.uCloudTime.value=time;cloudUniform.uCloudEye.value.copy(player);
      const direction=solarDirection(hours),elevation=direction.y;
      starUniform.pixelRatio.value=renderer.getPixelRatio();
      const daylight=THREE.MathUtils.smoothstep(elevation,-.14,.16);
      const darkness=1-daylight;
      starPoints.visible=darkness>.015;
      uniform.sunDirection.value.copy(direction);uniform.nightAmount.value=Math.pow(darkness,2.2);uniform.starRotation.value=(hours-18)*Math.PI/12;
      lut.update(direction);
      if(Math.abs(elevation-lastElevation)>.0015){
        lastElevation=elevation;
        // The sun as it reaches the ground: the air's transmittance along its path, faded over the half-degree disc at the horizon.
        transmittance(elevation,sunColor);
        const disc=THREE.MathUtils.smoothstep(elevation,-.006,.012);
        sunColor.multiplyScalar(disc);
        moonDir.copy(direction).negate();
        skyIrradiance(direction,SUN_ILLUMINANCE,skyE);skyIrradiance(moonDir,MOON_ILLUMINANCE,moonSkyE);skyE.add(moonSkyE);
        // A floor of airglow and starlight (the sky model's night term, over the hemisphere).
        skyE.r+=.00006*Math.PI*1.6;skyE.g+=.00008*Math.PI*1.6;skyE.b+=.00016*Math.PI*1.6;
        side.set(Math.cos(Math.atan2(direction.z,direction.x)+Math.PI/2),.06,Math.sin(Math.atan2(direction.z,direction.x)+Math.PI/2)).normalize();
        skyRadiance(side,direction,SUN_ILLUMINANCE,horizon);skyRadiance(side,moonDir,MOON_ILLUMINANCE,moonHorizon);horizon.add(moonHorizon);
        const fogAmbient=.8;
        // Mist: lit from every side by the sky above and the dim ground below (isotropic scattering sees the average).
        mist.copy(skyE).multiplyScalar(1/Math.PI).add(groundBounce.copy(skyE).multiplyScalar(.04));
        fog.copy(mist);
        scene.userData.fogAmbient=fogAmbient;scene.userData.fogDensity=fogDensityFor(elevation);
        gradeFor(elevation,grade);
        uniform.sunRadiance.value.copy(sunColor).multiplyScalar(40);
        uniform.cloudSun.value.copy(sunColor).multiplyScalar(SUN_ILLUMINANCE/Math.PI*.9);
        uniform.cloudSky.value.copy(skyE).multiplyScalar(.9/Math.PI);
        const moonUp=THREE.MathUtils.smoothstep(-elevation,-.02,.1);
        uniform.moonRadiance.value=.03*moonUp;
      }
      sun.color.copy(sunColor);sun.intensity=SUN_ILLUMINANCE;
      hemi.color.copy(skyE);hemi.intensity=1;
      // The ground's bounce from below: a dark, green-brown forest floor lit by the sun and sky together.
      hemi.groundColor.copy(sunColor).multiplyScalar(SUN_ILLUMINANCE*Math.max(elevation,0)).add(skyE).multiply(groundTint).multiplyScalar(.11);
      const skyLuminance=skyE.r*.2126+skyE.g*.7152+skyE.b*.0722;
      scene.environmentIntensity=.185*Math.min(1.4,skyLuminance/noonLuminance);
      scene.userData.fogColor=fog;scene.userData.mistColor=mist;scene.userData.skyColor=fog;scene.userData.sunDirection=direction;scene.userData.sunScatterColor=sun.color;
      scene.userData.sunLevel=Math.min(1,(sunColor.r*.2126+sunColor.g*.7152+sunColor.b*.0722)/.8);
      return {darkness,sunDirection:direction,sunElevation:elevation,daylight};
    },
    dispose(){disposed=true;scene.remove(dome,starPoints);starGeometry.dispose();starMaterial.dispose();dome.geometry.dispose();material.dispose();placeholder.dispose();cloudTexture.dispose();dayTexture?.dispose();nightTexture?.dispose();environment?.dispose();generator.dispose();lut.dispose();if(scene.environment===environment?.texture)scene.environment=null;delete scene.userData.hasSky;delete scene.userData.sunDirection;delete scene.userData.fogColor;delete scene.userData.sunScatterColor;delete scene.userData.skyLut;delete scene.userData.grade;}
  };
}
