import { LIGHT_TUNING, lightTuningVersion } from '../../core/light-tuning';
import { mistWeather, createGameClock } from '../../sim/world/weather';
import { perfOn } from '../../core/perf-flags';
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createSkyLut, SKY_LUT_GLSL, SUN_ILLUMINANCE, MOON_ILLUMINANCE, transmittance, skyIrradiance } from './sky-model';
import { gradeFor, fogDensityFor } from '../post/grade';
import type { Grade } from '../post/final-image';

/** Solar geometry at a temperate northern latitude, in local solar hours.
 * World +X is east and -Z is south, where the sea is (coastal-geography.ts): the sun travels east, over the sea at noon, then
 * west, so the island's range and the far mountains (+Z) face it. With the sun over them at noon (+Z south) they stood against
 * it all day as flat, hazy silhouettes. The path is turned SUN_TURN west about the vertical: due south at noon it stood straight
 * behind anyone looking at the range from the lake, and every face, gully and stand of trees was lit head-on, flat and one
 * colour; from the south-west it rakes across them, one side of each rib and gully in sun and the other in shade, as in the
 * reference, and still lights the faces. */
export const SUN_TURN=35*Math.PI/180;
export function solarDirection(hours:number,latitude=49,declination=9) {
  const h=(hours-12)*Math.PI/12,lat=latitude*Math.PI/180,dec=declination*Math.PI/180,c=Math.cos(SUN_TURN),s=Math.sin(SUN_TURN);
  const x=-Math.cos(dec)*Math.sin(h),z=-(Math.sin(lat)*Math.cos(dec)*Math.cos(h)-Math.cos(lat)*Math.sin(dec));
  return new THREE.Vector3(x*c+z*s,Math.sin(lat)*Math.sin(dec)+Math.cos(lat)*Math.cos(dec)*Math.cos(h),-x*s+z*c).normalize();
}

/** How far apart (in the sun's elevation, a sine) two samples of the sky model may lie at `elevation`: the sun's colour and the sky's light
 * change by about 1/(elevation + .03) of themselves per unit of elevation, so the step is a fixed share of that and never under .0001 (the
 * disc fading in over the horizon) or over .012 (noon, where they hardly move). At most 6 % relative change a step: a blend of two
 * samples is then within .1 % of the model. */
export const keyStep=(elevation:number)=>Math.min(.012,Math.max(1e-4,.02*(Math.abs(elevation)+.004)));

/**
 * A smooth stand-in for a slow function of the sun's elevation that costs real CPU to evaluate (`evaluate` fills `size` numbers).
 * It keeps two evaluated samples round the last elevation asked for, one `keyStep` apart, and blends them linearly: the value moves with
 * the sun, one evaluation each time the sun leaves the pair (stepping forward or back, the next pair shares an end with the last), where
 * the function re-evaluated every .0015 of elevation changed in steps as visible as 5 % at dusk. `version` drops both samples when
 * whatever the function reads (the lighting tuning) has changed.
 */
export function elevationKeyframes(size:number,evaluate:(elevation:number,out:Float64Array)=>void,step=keyStep){
  let a=new Float64Array(size),b=new Float64Array(size),ea=NaN,eb=NaN,last=NaN,version=NaN;
  return {
    /** Evaluations so far (tests, measurements). */
    evaluations:0,
    sample(elevation:number,out:Float64Array,v=0){
      if(v!==version){version=v;ea=eb=NaN;}
      if(!(elevation>=ea&&elevation<=eb)){
        const up=!(elevation<last);
        if(up&&elevation>eb&&elevation-eb<=step(eb)&&Number.isFinite(eb)){[a,b]=[b,a];ea=eb;eb=ea+step(ea);evaluate(eb,b);this.evaluations++;}
        else if(!up&&elevation<ea&&ea-elevation<=step(ea)&&Number.isFinite(ea)){[a,b]=[b,a];eb=ea;ea=eb-step(eb);evaluate(ea,a);this.evaluations++;}
        else{
          // Asked for somewhere new (the first call, a jump of the clock): sample a pair that starts or ends here, by the way the sun is going.
          if(up){ea=elevation;eb=ea+step(ea);}else{eb=elevation;ea=eb-step(eb);}
          evaluate(ea,a);evaluate(eb,b);this.evaluations+=2;
        }
      }
      last=elevation;
      const t=(elevation-ea)/(eb-ea);
      for(let i=0;i<size;i++)out[i]=a[i]+(b[i]-a[i])*t;
    },
  };
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
  const lut=createSkyLut(renderer,()=>perfOn('skyLutSmooth'));
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
        // A night sky seen by an adapted eye is a dark grey with no hue, not the deep blue the model gives a moonlit sky.
        color=mix(color,vec3(1.03,1.,.94)*dot(color,vec3(.2126,.7152,.0722)),nightAmount*.8);
        float c=cos(starRotation),s=sin(starRotation);
        // Rotate about the celestial pole (49° up in the north, +Z), not about the zenith.
        vec3 axis=normalize(vec3(0.,.75471,.65606));
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
  dome.renderOrder=perfOn('skyLast')?1000:-1000;dome.layers.enable(3);scene.add(dome);scene.background=null;scene.userData.hasSky=true;
  scene.userData.skyLut=lut.texture;
  let disposed=false,dayTexture:THREE.DataTexture|undefined,nightTexture:THREE.DataTexture|undefined,environment:THREE.WebGLRenderTarget|undefined;
  const generator=new THREE.PMREMGenerator(renderer);generator.compileEquirectangularShader();
  const loader=new HDRLoader();
  loader.load('/sky/cloudless-day.hdr',texture=>{
    if(disposed){texture.dispose();return;}dayTexture=texture;texture.mapping=THREE.EquirectangularReflectionMapping;
    // This image is the ambient that every standard material takes as diffuse light too, at every hour: the open sky's full
    // blue. Anything neutral in shade came out blue (a brown path read blue-grey, 57/64/71). ENV_NEUTRAL of its colour takes the
    // same warm white as the sky light, at each pixel's own brightness; the dome itself is drawn from the sky model and stays blue.
    const data=texture.image.data as Uint16Array|Float32Array,half=texture.type===THREE.HalfFloatType;
    const read=(i:number)=>half?THREE.DataUtils.fromHalfFloat(data[i]):data[i],write=(i:number,v:number)=>{data[i]=half?THREE.DataUtils.toHalfFloat(v):v;};
    if(ENV_NEUTRAL>0)for(let i=0;i<data.length;i+=4){
      const r=read(i),g=read(i+1),b=read(i+2),l=r*.2126+g*.7152+b*.0722;
      write(i,r+(l*WARM_WHITE.r-r)*ENV_NEUTRAL);write(i+1,g+(l*WARM_WHITE.g-g)*ENV_NEUTRAL);write(i+2,b+(l*WARM_WHITE.b-b)*ENV_NEUTRAL);
    }
    texture.needsUpdate=true;
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
      void main(){vec3 axis=normalize(vec3(0.,.75471,.65606));float c=cos(-rotation),s=sin(-rotation);
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
  const starPoints=new THREE.Points(starGeometry,starMaterial);starPoints.name='Resolved stellar points';starPoints.frustumCulled=false;starPoints.renderOrder=-999;starPoints.layers.enable(3);scene.add(starPoints);
  // Light colours from the model, sampled on a grid of elevations and blended between samples (see lightKeys below).
  // The forest's haze by day: droplets and pollen lit by sun and sky together and scattered many times over, so it reads near
  // white and a touch warm, not the blue of the open sky that a single scattering of sky light gives. MIST_NEUTRAL of its colour
  // takes WARM_WHITE at the sky light's own brightness, by night too.
  // MIST_NEUTRAL .45 (it was .85): the mist keeps half the sky's own colour, a cool grey-blue in the shade that the sun warms where
  // it shines through; taken nearly all the way to one warm white it was the flat grey veil the player complained of.
  const MIST_NEUTRAL=.45,WARM_WHITE=new THREE.Color(1.04,1,.9),warmMist=new THREE.Color(),warmSky=new THREE.Color();
  // By day both are 0: the user chose the cooler day of before (2026-11-13, the w0 stills) over the warmed one (.5 and .65).
  const SKY_NEUTRAL_DAY=0,SKY_NEUTRAL_NIGHT=.85,ENV_NEUTRAL=0;
  const mist=new THREE.Color(),groundBounce=new THREE.Color(),sunColor=new THREE.Color(),skyE=new THREE.Color(),moonSkyE=new THREE.Color(),fog=new THREE.Color();
  const groundTint=new THREE.Color(.82,.9,.62),grade:Grade=gradeFor(1),moonDir=new THREE.Vector3(),keyDirection=new THREE.Vector3(),sampled=new Float64Array(6),sunAzimuth=new THREE.Vector2(1,0);
  const noonSky=skyIrradiance(new THREE.Vector3(0,.8,.6).normalize(),SUN_ILLUMINANCE),noonLuminance=noonSky.r*.2126+noonSky.g*.7152+noonSky.b*.0722;
  // The two lights the sun's elevation sets, evaluated by the sky model (about 110 us a call: 40 sky samples of 8 steps, twice, and the
  // sun's path). Recomputed only when the sun had moved .0015 in elevation, the colours stepped: at 1.9 steps a second the sun's
  // colour jumped by 1 to 5 % at each (up to 48 % at the horizon, where the disc fades) and the sky's by up to 15 % at twilight, a
  // flicker in everything the sun lights. They are now sampled on a grid of elevations that gets finer towards the horizon (relative
  // change under 6 % a step) and every frame is a blend of the two samples round the sun, so the light moves as smoothly as the sun does.
  const evaluate=(elevation:number,out:Float64Array)=>{
    const flat=Math.sqrt(Math.max(1-elevation*elevation,0));keyDirection.set(sunAzimuth.x*flat,elevation,sunAzimuth.y*flat);
    // The sun as it reaches the ground: the air's transmittance along its path, faded over the half-degree disc at the horizon.
    transmittance(elevation,sunColor);
    sunColor.multiplyScalar(THREE.MathUtils.smoothstep(elevation,-.006,.012));
    moonDir.copy(keyDirection).negate();
    skyIrradiance(keyDirection,SUN_ILLUMINANCE,skyE);skyIrradiance(moonDir,MOON_ILLUMINANCE,moonSkyE);skyE.add(moonSkyE);
    // A floor of airglow and starlight (the sky model's night term, over the hemisphere), lifted a little over the sky's own
    // so a moonless wood keeps the shapes of its nearest trunks and floor instead of pure black (night probe, work/gfx/torch-probe.js).
    // Its colour is a warm white, not the blue it was: the night sky's own glow is green and red airglow and sun-like starlight,
    // and the blue floor made every night frame 2.2 times bluer than red (the user wants the night air neutral and warm).
    // Lifted four times (3.4 to 14): the moon now lights the open ground itself, and where it does not (a trunk's shadow, under
    // the canopy) the floor keeps the ground readable, a quarter of the moonlit ground's light, instead of the near black it was.
    const floor=Math.PI*14*LIGHT_TUNING.night;skyE.r+=.000085*floor;skyE.g+=.000081*floor;skyE.b+=.000073*floor;
    // Under the canopy the sky's light reaches the ground through leaves and off trunks and floor, many times scattered: not the
    // open sky's blue. SKY_NEUTRAL of it takes a warm white at its own brightness, more at night, where a moonlit sky's blue
    // (a single scattering of moonlight) tinted the whole wood.
    const nightShare=1-THREE.MathUtils.smoothstep(elevation,-.1,.06),skyNeutral=SKY_NEUTRAL_DAY+(SKY_NEUTRAL_NIGHT-SKY_NEUTRAL_DAY)*nightShare;
    skyE.lerp(warmSky.copy(WARM_WHITE).multiplyScalar(skyE.r*.2126+skyE.g*.7152+skyE.b*.0722),skyNeutral);
    out[0]=sunColor.r;out[1]=sunColor.g;out[2]=sunColor.b;out[3]=skyE.r;out[4]=skyE.g;out[5]=skyE.b;
  };
  const lightKeys=elevationKeyframes(6,evaluate);let steppedAt=Infinity,steppedVersion=-1;
  // Moonlight. The moon stands opposite the sun (sky dome), and once the sun's own light is gone (6 thousandths below the horizon)
  // it is the key light: the same directional light and the same shadow maps, from the moon, a neutral white a touch cool, rising
  // with it. A fiftieth of the sun: far above a real full moon (a 400,000th), as games and films light a moonlit night, so the
  // open ground reads at about a tenth of white at the night's exposure and every trunk throws a moon shadow. Before it the night
  // had no key light at all: only the sky's dim floor, the ground near black and every lamp a blinding contrast against it.
  // (A sixtieth since the first look: at a fiftieth moonlit sand read nearly white.)
  const MOON_KEY=SUN_ILLUMINANCE/60,MOON_COLOUR=new THREE.Color(.93,.96,1),key=new THREE.Vector3(),scatter=new THREE.Color();
  scene.userData.grade=grade;
  // The mist's weather (sim/world/weather.ts) runs on the game's own hours, counted across midnight.
  const gameClock=createGameClock();
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
      // The sun's colour and the sky's light, blended between the two samples of the model that bracket the sun's elevation.
      sunAzimuth.set(direction.x,direction.z).normalize();
      if(perfOn('sunSmooth'))lightKeys.sample(elevation,sampled,lightTuningVersion);
      else if(Math.abs(elevation-steppedAt)>.0015||steppedVersion!==lightTuningVersion){steppedAt=elevation;steppedVersion=lightTuningVersion;evaluate(elevation,sampled);}   // the stepped light of before, for A/B
      sunColor.setRGB(sampled[0],sampled[1],sampled[2]);skyE.setRGB(sampled[3],sampled[4],sampled[5]);
      // Mist: lit from every side by the sky above and the dim ground below (isotropic scattering sees the average).
      mist.copy(skyE).multiplyScalar(1/Math.PI).add(groundBounce.copy(skyE).multiplyScalar(.04));
      // The same warm white day and night: the mist used to fade back to the sky's blue below the horizon, and the night read blue.
      mist.lerp(warmMist.copy(WARM_WHITE).multiplyScalar(mist.r*.2126+mist.g*.7152+mist.b*.0722),MIST_NEUTRAL);
      // The long-range air takes the sky's true horizon colour (atmosphere.ts), not the mist's whitened one.
      scene.userData.hazeNeutral=0;
      fog.copy(mist);
      scene.userData.fogAmbient=.8;
      gradeFor(elevation,grade);
      uniform.sunRadiance.value.copy(sunColor).multiplyScalar(40);
      uniform.cloudSun.value.copy(sunColor).multiplyScalar(SUN_ILLUMINANCE/Math.PI*.9);
      uniform.cloudSky.value.copy(skyE).multiplyScalar(.9/Math.PI);
      uniform.moonRadiance.value=.03*THREE.MathUtils.smoothstep(-elevation,-.02,.1);
      // The hour's mist times the weather's: a clear night, a thick one, mist lifting through the morning.
      const weather=mistWeather(gameClock(hours));scene.userData.mistWeather=weather;
      scene.userData.fogDensity=fogDensityFor(elevation)*LIGHT_TUNING.haze*weather;
      const moonUp=elevation<-.006,moonLight=moonUp?MOON_KEY*THREE.MathUtils.smoothstep(-elevation,0,.15):0;
      if(moonUp){key.copy(direction).negate();sun.color.copy(MOON_COLOUR);sun.intensity=moonLight*LIGHT_TUNING.sun;}
      else{key.copy(direction);sun.color.copy(sunColor);sun.intensity=SUN_ILLUMINANCE*LIGHT_TUNING.sun;}
      // The key light's colour with its strength against the sun's in it, as the water and the mist's shafts read it (they scale it
      // by the sun's illuminance): the moon's colour alone, at the sun's strength, lit the night sea a glowing daylight cyan.
      scatter.copy(sun.color).multiplyScalar(moonUp?moonLight/SUN_ILLUMINANCE:1);
      hemi.color.copy(skyE);hemi.intensity=LIGHT_TUNING.sky;
      // The ground's bounce from below: a dark, green-brown forest floor lit by the sun and sky together.
      hemi.groundColor.copy(sunColor).multiplyScalar(SUN_ILLUMINANCE*Math.max(elevation,0)).add(skyE).multiply(groundTint).multiplyScalar(.11);
      const skyLuminance=skyE.r*.2126+skyE.g*.7152+skyE.b*.0722;
      scene.environmentIntensity=.185*Math.min(1.4,skyLuminance/noonLuminance);
      // Everything lit by the key light takes its direction (the sun's by day, the moon's by night): shadows, horizons, water.
      scene.userData.fogColor=fog;scene.userData.mistColor=mist;scene.userData.skyColor=fog;scene.userData.sunDirection=key;scene.userData.sunScatterColor=scatter;
      // The sun's own height, for what follows the time of day rather than the light (the wind over water).
      scene.userData.solarElevation=elevation;
      scene.userData.sunLevel=Math.min(1,(sunColor.r*.2126+sunColor.g*.7152+sunColor.b*.0722)/.8);
      return {darkness,sunDirection:key,sunElevation:elevation,daylight,moonLight};
    },
    dispose(){disposed=true;scene.remove(dome,starPoints);starGeometry.dispose();starMaterial.dispose();dome.geometry.dispose();material.dispose();placeholder.dispose();cloudTexture.dispose();dayTexture?.dispose();nightTexture?.dispose();environment?.dispose();generator.dispose();lut.dispose();if(scene.environment===environment?.texture)scene.environment=null;delete scene.userData.hasSky;delete scene.userData.sunDirection;delete scene.userData.fogColor;delete scene.userData.sunScatterColor;delete scene.userData.skyLut;delete scene.userData.grade;}
  };
}
