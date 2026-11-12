import { createEdgeAAMaterial, sharpnessFor } from '../post/sharpen';
import * as THREE from 'three';
import type { createRiver } from './river';
import { WORLD_V2 } from '../../sim/world/world-flags';
import { SKY_LUT_GLSL } from './sky-model';
import { createFinalImage, type Grade, type ToneMapper } from '../post/final-image';
import { perfOn } from '../../core/perf-flags';
import { createAmbientOcclusion } from '../post/ambient-occlusion';
import { aoQuality, AO_STRENGTH, SUNLIT_KEEP, AO_FADE_NEAR, AO_FADE_FAR } from '../post/ambient-occlusion-math';

// Integrate the participating medium at half resolution, then reconstruct it
// against full-resolution surface depth. Scene textures and silhouettes stay sharp.
export function createAtmosphere(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.PerspectiveCamera,water:ReturnType<typeof createRiver>,sun:THREE.DirectionalLight){
  const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,samples:Math.min(4,renderer.capabilities.maxSamples),minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  target.depthTexture=new THREE.DepthTexture(1,1,THREE.UnsignedIntType);
  // Only the water is drawn here. Its shader tests the opaque depth itself;
  // no full-screen colour/depth copy is needed before drawing the surface.
  // Water has its own depth-tested layer, but does not need the full opaque
  // target resolution.  Linear colour filtering keeps the shoreline soft when
  // this target is reduced on a slower device.
  const waterTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  waterTarget.depthTexture=new THREE.DepthTexture(1,1,THREE.UnsignedIntType);
  const fogTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  const resolvedTarget=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  // The fogged scene in linear light, for the final-image stage (exposure, bloom, grade, tone curve: game/render/post).
  const hdrTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
  const finalImage=createFinalImage(renderer);
  const aaMaterial=createEdgeAAMaterial();
  aaMaterial.uniforms.tDiffuse.value=resolvedTarget.texture;
  const waterResolution=new THREE.Vector2();
  water.bind(target.texture,target.depthTexture,waterResolution,camera.projectionMatrixInverse);
  const uniforms={
    tColor:{value:target.texture},tDepth:{value:target.depthTexture},tWater:{value:waterTarget.texture},tWaterDepth:{value:waterTarget.depthTexture},
    tFog:{value:fogTarget.texture},hasWater:{value:false},fogEnabled:{value:true},fogSize:{value:new THREE.Vector2()},fogSteps:{value:24},
    inverseProjection:{value:new THREE.Matrix4()},cameraWorld:{value:camera.matrixWorld},cameraPositionWorld:{value:camera.position},
    terrainSun:{value:null as THREE.Texture|null},terrainSunMatrix:{value:new THREE.Matrix4()},terrainSunOn:{value:0},terrainSunBias:{value:new THREE.Vector2(.002,.001)},
    time:{value:0},darkness:{value:0},fogColor:{value:new THREE.Color()},sunDirection:{value:new THREE.Vector3(25,37,-68).normalize()},sunScatterColor:{value:new THREE.Color(1,.81,.52)},
    flashShadow:{value:null as THREE.Texture|null},flashMatrix:{value:new THREE.Matrix4()},flashPosition:{value:new THREE.Vector3()},flashDirection:{value:new THREE.Vector3()},flashPower:{value:0},
    // Sun rays follow the sun's own direct light (0 with the sun down), and are shaded by the tree crowns overhead.
    sunLevel:{value:1},canopyCover:{value:null as THREE.Texture|null},canopyBox:{value:new THREE.Vector4(0,0,96,0)},canopyHeight:{value:12},
    // The torch as the spot light itself has it: shadow camera near and far, cone and penumbra cosines, decay, and its cookie.
    flashRange:{value:new THREE.Vector2(.06,48)},flashCone:{value:new THREE.Vector2(.866,.9945)},flashDecay:{value:1.35},flashCookie:{value:null as THREE.Texture|null},flashHasCookie:{value:0},
    // Ambient occlusion (post/ambient-occlusion.ts): r visibility, g direct-sun fraction, b linear depth, at aoSize.
    tAO:{value:null as THREE.Texture|null},aoSize:{value:new THREE.Vector2(1,1)},aoOn:{value:0},
    sunShadow:{value:null as THREE.Texture|null},sunMatrix:{value:sun.shadow.matrix},shadowTexel:{value:1/sun.shadow.mapSize.x},
    // The sky model's view table (game/render/world/sky-model.ts): the haze takes the sky's own colour towards the horizon.
    skyLut:{value:null as THREE.Texture|null},fogAmbient:{value:.8},fogDensity:{value:1},aerialDensity:{value:1/2600},
    // The ground mist is lit by the whole sky dome (and the ground below it), not by the bright horizon: its colour comes from the sky model.
    mistColor:{value:new THREE.Color(.1,.12,.14)},
  };
  // A top-down map of the tree crowns round the player, built from the trees' own colliders: 1 under a crown, 0 in a gap.
  // It is redrawn on the CPU only when the player has walked a few metres; the fog reads it along the sun's direction.
  const canopy=(()=>{
    const N=128,SIZE=96,data=new Uint8Array(N*N),texture=new THREE.DataTexture(data,N,N,THREE.RedFormat);
    texture.magFilter=texture.minFilter=THREE.LinearFilter;texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;texture.needsUpdate=true;
    uniforms.canopyCover.value=texture;
    let cx=Infinity,cz=Infinity,count=-1,frame=0;
    type Tree={tag?:string;ax?:number;az?:number;minY:number;maxY:number;crownBase?:number};
    return {
      update(eye:THREE.Vector3){
        const near=scene.userData.treesNear as ((x:number,z:number,r:number)=>Iterable<Tree>)|undefined;
        if(!WORLD_V2||!near){uniforms.canopyBox.value.w=0;return;}
        // Looked at again after a few metres of walking, or about once a second for trees that have streamed in since.
        if(Math.hypot(eye.x-cx,eye.z-cz)<6&&frame++%75!==0)return;
        const trees=[...near(eye.x,eye.z,SIZE*.5+6)].filter(t=>t.tag==='tree'&&t.ax!==undefined);
        if(Math.hypot(eye.x-cx,eye.z-cz)<6&&trees.length===count)return;
        cx=eye.x;cz=eye.z;count=trees.length;data.fill(0);
        const texel=SIZE/N;let height=0;
        for(const t of trees){
          const tall=t.maxY-t.minY,r=Math.min(5.5,Math.max(2,tall*.15)),u=(t.ax!-cx)/texel+N/2,v=(t.az!-cz)/texel+N/2,span=Math.ceil(r/texel);
          // Crowns differ in how much they let through; the seed is the tree's own place, so it never changes.
          const dense=.72+.28*Math.abs(Math.sin(t.ax!*12.9898+t.az!*78.233)*43758.5453%1);
          height+=((t.crownBase??t.minY+tall*.35)+t.maxY)*.5;
          for(let j=Math.max(0,Math.floor(v-span));j<=Math.min(N-1,Math.ceil(v+span));j++)for(let i=Math.max(0,Math.floor(u-span));i<=Math.min(N-1,Math.ceil(u+span));i++){
            const d=Math.hypot(i+.5-u,j+.5-v)*texel/r;if(d>=1)continue;
            const k=Math.min(1,(1-d)/.65),ragged=.78+.22*Math.abs(Math.sin((i+Math.floor(cx/texel))*91.7+(j+Math.floor(cz/texel))*47.3)*9973.1%1);
            const value=Math.round(255*dense*k*k*(3-2*k)*ragged),at=j*N+i;if(value>data[at])data[at]=value;
          }
        }
        texture.needsUpdate=true;
        uniforms.canopyBox.value.set(cx,cz,SIZE,trees.length?1:0);
        if(trees.length)uniforms.canopyHeight.value=height/trees.length;
      },
      dispose(){texture.dispose();},
    };
  })();
  const vertexShader='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
  const common=`
    precision highp float;
    uniform sampler2D tColor,tDepth,tWater,tWaterDepth,tFog,sunShadow,flashShadow;
    uniform mat4 flashMatrix;uniform vec3 flashPosition,flashDirection;uniform float flashPower;
    uniform sampler2D flashCookie;uniform vec2 flashRange,flashCone;uniform float flashDecay,flashHasCookie;
    uniform bool hasWater,fogEnabled;
    uniform mat4 inverseProjection,cameraWorld,sunMatrix;
    uniform vec3 cameraPositionWorld,fogColor,sunDirection,sunScatterColor;
    uniform vec2 fogSize;uniform float fogSteps;
    uniform float time,darkness,shadowTexel,sunLevel,fogDensity;
    uniform sampler2D skyLut;uniform float fogAmbient,aerialDensity;uniform vec3 mistColor;
    varying vec2 vUv;
    ${SKY_LUT_GLSL}
    // The light the mist itself is lit with from the sky: the sky's colour just above the horizon in this direction (so the haze
    // in front of a ridge is the colour of the sky behind it, warmer towards a low sun).
    vec3 hazeColor(vec3 ray){vec3 d=normalize(vec3(ray.x,max(ray.y,0.)*.35+.04,ray.z));return skyLookup(skyLut,d,sunDirection);}
    float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
    float surfaceDepth(vec2 uv){
      float opaqueDepth=texture2D(tDepth,uv).r;
      if(hasWater&&texture2D(tWater,uv).a>.5){
        float depth=texture2D(tWaterDepth,uv).r;
        return min(depth,opaqueDepth);
      }
      return opaqueDepth;
    }
    vec3 viewAt(vec2 uv,float d){vec4 p=inverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);return p.xyz/p.w;}
  `;
  const fogMaterial=new THREE.ShaderMaterial({uniforms,vertexShader,depthTest:false,depthWrite:false,fragmentShader:common+`
    float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
    float sunlight(vec3 p){
      vec4 projected=sunMatrix*vec4(p,1.);vec3 uv=projected.xyz/projected.w;
      if(uv.z<0.||uv.z>1.||uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)return 1.;
      float lit=0.;for(int s=0;s<2;s++){
        vec2 tap=vec2(s==0?-.75:.75)*shadowTexel;
        float d=dot(texture2D(sunShadow,uv.xy+tap),vec4(255./256.,255./65536.,255./16777216.,1./16777216.));
        lit+=smoothstep(uv.z-.0007,uv.z+.0007,d)*.5;
      }
      float border=min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y));
      return mix(1.,lit,smoothstep(0.,.055,border));
    }
    void main(){
      vec3 world=(cameraWorld*vec4(viewAt(vUv,surfaceDepth(vUv)),1.)).xyz;
      vec3 delta=world-cameraPositionWorld,ray=normalize(delta);
      float distanceToSurface=min(length(delta),180.);
      // Deterministic midpoint integration: no screen-space grain in distant fog.
      float jitter=.5;
      float stepLength=distanceToSurface/max(fogSteps,1.),opticalDepth=0.,illuminatedFog=0.,beamFog=0.;
      float day=1.-darkness;
      for(int i=0;i<24;i++){
        if(float(i)>=fogSteps)break;
        float distanceAlongRay=(float(i)+jitter)*stepLength;
        vec3 p=cameraPositionWorld+ray*distanceAlongRay;
        float billow=noise((p+vec3(time*.10,0.,time*.035))*.085);
        float heightDensity=exp(-max(p.y-1.5,0.)*.050);
        float density=(.014+billow*.03)*fogDensity*heightDensity*smoothstep(1.5,16.,distanceAlongRay);
        float extinction=density*stepLength;
        if(day>.025)illuminatedFog+=exp(-opticalDepth)*(1.-exp(-extinction))*sunlight(p);
        if(flashPower>0.){
          vec3 fromLamp=p-flashPosition;float lampDistance=length(fromLamp);
          float cone=smoothstep(.866,.98,dot(normalize(fromLamp),flashDirection));
          vec4 fp=flashMatrix*vec4(p,1.);vec3 fu=fp.xyz/fp.w;
          float visible=0.;
          if(fu.x>0.&&fu.x<1.&&fu.y>0.&&fu.y<1.&&fu.z>0.&&fu.z<1.){
            float fd=dot(texture2D(flashShadow,fu.xy),vec4(255./256.,255./65536.,255./16777216.,1./16777216.));
            visible=smoothstep(fu.z-.0004,fu.z+.0004,fd);
          }
          beamFog+=exp(-opticalDepth)*(1.-exp(-extinction))*cone*visible*flashPower/(1.+lampDistance*lampDistance)*.55;
        }
        opticalDepth+=extinction;
      }
      // Store optical quantities and path length together. Reconstruction needs
      // just four reads, without re-reading/reconstructing four depth samples.
      gl_FragColor=vec4(exp(-opticalDepth),illuminatedFog,distanceToSurface,beamFog);
    }`});
  const resolveHead=`
    uniform sampler2D tAO;uniform vec2 aoSize;uniform float aoOn;
    vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
    vec3 linearSrgb(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
    void main(){
      vec4 water=hasWater?texture2D(tWater,vUv):vec4(0.);
      float waterDepth=water.a>.5?texture2D(tWaterDepth,vUv).r:1.;
      float opaqueDepth=texture2D(tDepth,vUv).r;
      bool waterVisible=waterDepth<=opaqueDepth&&waterDepth<1.;
      vec3 color=waterVisible?water.rgb/water.a:texture2D(tColor,vUv).rgb;
      float depth=waterVisible?waterDepth:opaqueDepth;
      vec3 view=viewAt(vUv,depth);
      float distanceToSurface=min(length(view),180.);
      vec3 ray=normalize(mat3(cameraWorld)*view);
      // Ambient occlusion, before fog so haze still covers it. Joint-bilateral upsample from half resolution: the four nearest texels,
      // weighted by bilinear distance and by how close their own depth is to this pixel's, relative to the best match (as the fog does).
      if(aoOn>.5&&!waterVisible&&depth<1.){
        float z=-view.z;vec2 pixel=vUv*aoSize-.5,base=floor(pixel),f=fract(pixel);
        vec4 taps[4];float costs[4];float lowest=1e9;
        for(int i=0;i<4;i++){
          vec2 offset=vec2(float(i-i/2*2),float(i/2));
          taps[i]=texture2D(tAO,clamp((base+offset+.5)/aoSize,vec2(.0001),vec2(.9999)));
          float rel=(taps[i].b-z)/z;costs[i]=rel*rel*400.;lowest=min(lowest,costs[i]);
        }
        vec3 ao=vec3(0.);float weights=0.;
        for(int i=0;i<4;i++){
          vec2 offset=vec2(float(i-i/2*2),float(i/2));vec2 w2=mix(1.-f,f,offset);
          float weight=max(w2.x*w2.y,.002)*exp(lowest-costs[i]);
          ao+=taps[i].rgb*weight;weights+=weight;
        }
        ao/=max(weights,1e-6);
        // Only the ambient part of the light is occluded and it cannot be pulled out of the finished colour, so the occlusion is
        // weakened where the pixel is mostly direct sun (ao.g), and left at ${SUNLIT_KEEP} of its strength at full sun (see ambient-occlusion-math.ts).
        float fade=1.-smoothstep(${AO_FADE_NEAR.toFixed(1)},${AO_FADE_FAR.toFixed(1)},z);
        color*=1.-${AO_STRENGTH.toFixed(2)}*(1.-(1.-${SUNLIT_KEEP.toFixed(2)})*ao.g)*fade*(1.-ao.r);
      }
      // Long-range haze beyond the mist: the air itself, a few kilometres of visibility, tinted by the same sky. The sky
      // already contains its own air, so it is left alone.
      if(depth<.999999)color=mix(hazeColor(ray),color,exp(-length(view)*aerialDensity));
      // The HDR sky draws the moving solar disc, moon and stars before fog.
      if(fogEnabled){
`;
  const resolveFogLegacy=`        vec2 pixel=vUv*fogSize-.5,base=floor(pixel),f=fract(pixel);
        vec3 fog=vec3(0.);float weights=0.;
        for(int i=0;i<4;i++){
          vec2 offset=vec2(float(i-i/2*2),float(i/2));
          vec2 uv=clamp((base+offset+.5)/fogSize,vec2(.0001),vec2(.9999));
          vec4 sampleFog=texture2D(tFog,uv);
          float sampleDistance=sampleFog.b;
          // Correct optical path length at thin trunks/branches, so background
          // haze cannot leak over a foreground silhouette during upsampling.
          float corrected=pow(max(sampleFog.r,.0001),distanceToSurface/max(sampleDistance,.1));
          sampleFog.ga*=(1.-corrected)/max(1.-sampleFog.r,.0001);sampleFog.r=corrected;
          vec2 w=mix(1.-f,f,offset);
          float weight=w.x*w.y/(1.+abs(sampleDistance-distanceToSurface)*.5);
          fog+=sampleFog.rga*weight;weights+=weight;
        }
        fog/=max(weights,.00001);
        float forwardScatter=.17+1.12*pow(max(dot(ray,sunDirection),0.),5.);
        color=color*fog.r+mistColor*(1.-fog.r);
        color+=vec3(1.,.88,.70)*fog.z;
        color+=sunScatterColor*fog.g*forwardScatter*.50*pow(1.-darkness,2.);
`;
  const resolveTail=`      }
      gl_FragColor=vec4(max(color,0.),1.);
    }`;
  const resolveSource=(extra:string,fog:string)=>common+extra+resolveHead+fog+resolveTail;
  const resolveMaterial=new THREE.ShaderMaterial({uniforms,vertexShader,depthTest:false,depthWrite:false,fragmentShader:resolveSource('',resolveFogLegacy)});
  // ---------------------------------------------------------------------------
  // ?world-v2 sun shafts. The same medium, density and brightness as above, but
  // integrated so that the picture cannot depend on what stands behind a pixel:
  //  1. Every ray is cut into the same world-space slices (rayStart). A pixel's
  //     samples sit at fixed distances; only the final slice is shortened (and
  //     weighted by the length it really covers) where the ray meets a surface.
  //  2. Each pixel jitters inside its slices with a screen-stable noise, and a
  //     depth-aware blur at fog resolution averages the noise away. No history,
  //     so nothing can trail or ghost.
  //  3. The full-resolution resolve is a joint bilateral upsample on relative
  //     depth that always prefers the fog sample nearest in depth.
  //  4. Outside the sun shadow map the light is a mean of what the ray already
  //     saw inside it, instead of "fully lit".
  //  5. Terrain never casts into the sun shadow map, so a private terrain-only
  //     depth map (terrainSun) lets hills and the basin rim shade the fog. Without
  //     it, shafts glowed through mountains with the sun behind them.
  // ---------------------------------------------------------------------------
  const RAYS_NEAR=1.5,RAYS_FAR=180;
  const raysCommon=`
    const float RAYS_NEAR=${RAYS_NEAR.toFixed(1)},RAYS_FAR=${RAYS_FAR.toFixed(1)};
    // Distance where slice u (0..1) starts. Close to the camera slices are short, far away long.
    float rayStart(float u){return RAYS_NEAR+(RAYS_FAR-RAYS_NEAR)*u*u;}
  `;
  const fogMaterial2=new THREE.ShaderMaterial({uniforms,vertexShader,depthTest:false,depthWrite:false,fragmentShader:common+raysCommon+`
    float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
    uniform sampler2D terrainSun;uniform mat4 terrainSunMatrix;uniform float terrainSunOn;uniform vec2 terrainSunBias;
    // Is a hill between this point and the sun? The sun shadow map never contains terrain.
    float terrainSunlight(vec3 p){
      if(terrainSunOn<.5)return 1.;
      vec3 q=(terrainSunMatrix*vec4(p,1.)).xyz*.5+.5;
      float edge=smoothstep(0.,.06,min(min(q.x,1.-q.x),min(q.y,1.-q.y)));
      if(edge<=0.)return 1.;
      float blocker=texture2D(terrainSun,q.xy).r;
      // Depth is linear over the whole map. The bias hides the texel staircase on grazing ground.
      return mix(1.,smoothstep(q.z-terrainSunBias.x-terrainSunBias.y,q.z-terrainSunBias.x,blocker),edge);
    }
    // The crowns overhead. Canopies cast nothing into the sun shadow map (only trunks do), so without this the fog was lit
    // as if the forest had no roof, with thin dark stripes behind trunks. canopyCover is a top-down map of the real
    // crowns around the player; a fog sample looks up along the sun through it. Light gets through the gaps: beams.
    uniform sampler2D canopyCover;uniform vec4 canopyBox;uniform float canopyHeight;
    float canopyLight(vec3 p){
      if(canopyBox.w<.5)return 1.;
      float rise=canopyHeight-p.y;
      if(rise<=0.)return 1.;
      vec2 at=p.xz+sunDirection.xz/max(sunDirection.y,.07)*rise;
      vec2 uv=(at-canopyBox.xy)/canopyBox.z+.5;
      float edge=smoothstep(0.,.08,min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y)));
      // Beyond the map the light has come through an average wood. A low sun crosses more crown on its way down.
      float cover=mix(.5,texture2D(canopyCover,uv).r,edge);
      return pow(1.-.8*cover,min(2.4,1./max(sunDirection.y,.3)));
    }
    // Sun visibility from the shadow map. inside = 1 where the map really knows the answer, fading to 0 at its edge.
    float mappedSunlight(vec3 p,out float inside){
      vec4 projected=sunMatrix*vec4(p,1.);vec3 uv=projected.xyz/projected.w;
      float border=min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y));
      inside=smoothstep(0.,.055,border)*smoothstep(0.,.04,min(uv.z,1.-uv.z));
      if(inside<=0.)return 0.;
      float lit=0.;for(int s=0;s<2;s++){
        vec2 tap=vec2(s==0?-.75:.75)*shadowTexel;
        float d=dot(texture2D(sunShadow,uv.xy+tap),vec4(255./256.,255./65536.,255./16777216.,1./16777216.));
        lit+=smoothstep(uv.z-.0007,uv.z+.0007,d)*.5;
      }
      return lit;
    }
    void main(){
      vec3 world=(cameraWorld*vec4(viewAt(vUv,surfaceDepth(vUv)),1.)).xyz;
      vec3 delta=world-cameraPositionWorld,ray=normalize(delta);
      float surfaceDistance=min(length(delta),RAYS_FAR);
      float steps=max(fogSteps,1.);
      // Interleaved gradient noise on the fog pixel grid: fixed on screen, so it can never crawl.
      float jitter=fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715))));
      float opticalDepth=0.,illuminatedFog=0.,beamFog=0.,meanLit=0.,meanWeight=0.;
      float day=1.-darkness;
      for(int i=0;i<24;i++){
        if(float(i)>=steps)break;
        float a=rayStart(float(i)/steps);
        if(a>=surfaceDistance)break;
        // Slice [a,end]; only the slice holding the surface is cut short.
        float end=min(rayStart(float(i+1)/steps),surfaceDistance),sliceLength=end-a;
        float distanceAlongRay=a+jitter*sliceLength;
        vec3 p=cameraPositionWorld+ray*distanceAlongRay;
        float billow=noise((p+vec3(time*.10,0.,time*.035))*.085);
        float heightDensity=exp(-max(p.y-1.5,0.)*.050);
        float density=(.014+billow*.03)*fogDensity*heightDensity*smoothstep(1.5,16.,distanceAlongRay);
        float extinction=density*sliceLength;
        float scatter=exp(-opticalDepth)*(1.-exp(-extinction));
        if(sunLevel>.01){
          float inside;float lit=mappedSunlight(p,inside);
          float prior=(meanLit+.004)/(meanWeight+.008);
          illuminatedFog+=scatter*mix(prior,lit,inside)*terrainSunlight(p)*canopyLight(p);
          meanLit+=scatter*inside*lit;meanWeight+=scatter*inside;
        }
        opticalDepth+=extinction;
      }
      // The torch in the fog. It has its own short march, because everything it does happens in the first thirty metres
      // and the sun's slices are far too coarse there (two or three between 10 and 20 m). It is the same beam that lights
      // the ground: the spot light's own cone, cookie, falloff and shadow map.
      if(flashPower>0.){
        float reach=min(surfaceDistance,34.),beamJitter=fract(jitter+.61803),beamDepth=0.;
        for(int i=0;i<10;i++){
          float t0=.4+(reach-.4)*pow(float(i)/10.,1.5);
          if(t0>=reach)break;
          float t1=.4+(reach-.4)*pow(float(i+1)/10.,1.5),sliceLength=t1-t0,along=t0+beamJitter*sliceLength;
          vec3 p=cameraPositionWorld+ray*along;
          float extinction=.029*fogDensity*exp(-max(p.y-1.5,0.)*.050)*smoothstep(1.5,16.,along)*sliceLength;
          float scatter=exp(-beamDepth)*(1.-exp(-extinction));
          beamDepth+=extinction;
          vec3 fromLamp=p-flashPosition;float lampDistance=length(fromLamp);vec3 lampRay=fromLamp/max(lampDistance,1e-4);
          float cone=smoothstep(flashCone.x,flashCone.y,dot(lampRay,flashDirection));
          if(cone<=0.)continue;
          vec4 fp=flashMatrix*vec4(p,1.);vec3 fu=fp.xyz/fp.w;
          if(fu.x<=0.||fu.x>=1.||fu.y<=0.||fu.y>=1.||fu.z<=0.||fu.z>=1.)continue;
          // Shadow, compared in metres from the lamp. The depth buffer is so non-linear that a fixed tolerance in its own
          // units was centimetres at arm's length and nearly three metres at twenty, which left shade hanging in the air.
          float fd=dot(texture2D(flashShadow,fu.xy),vec4(255./256.,255./65536.,255./16777216.,1./16777216.));
          float occluder=flashRange.x*flashRange.y/(flashRange.y-fd*(flashRange.y-flashRange.x));
          float depth=dot(fromLamp,flashDirection),tolerance=.05+.015*depth;
          float visible=smoothstep(-tolerance,tolerance*.25,occluder-depth);
          float cookie=flashHasCookie>.5?dot(texture2D(flashCookie,fu.xy).rgb,vec3(.3333)):1.;
          // The spot light's own distance falloff (three.js: decay, then a soft cut at its range).
          float cut=clamp(1.-pow(lampDistance/flashRange.y,4.),0.,1.);
          float falloff=cut*cut/max(pow(lampDistance,flashDecay),.01);
          // Fog throws light mostly onwards. Whoever holds the torch sees its beam by what comes back: fainter than from in front.
          float cosine=dot(lampRay,-ray),phase=(1.-.16)/pow(1.16-.8*cosine,1.5);
          beamFog+=scatter*cone*visible*cookie*flashPower*falloff*mix(1.,phase,.6)*.16;
        }
        // A torch beam shows in the dark and is lost in daylight.
        beamFog*=mix(.12,1.,smoothstep(.2,.85,darkness));
      }
      gl_FragColor=vec4(exp(-opticalDepth),illuminatedFog,surfaceDistance,beamFog);
    }`});
  // Depth-aware separable blur at fog resolution. Removes the jitter noise without ever crossing a depth edge.
  const blurUniforms={tSrc:{value:fogTarget.texture as THREE.Texture},texel:{value:new THREE.Vector2()},axis:{value:new THREE.Vector2(1,0)}};
  const fogBlurMaterial=new THREE.ShaderMaterial({uniforms:blurUniforms,vertexShader,depthTest:false,depthWrite:false,fragmentShader:`
    precision highp float;
    uniform sampler2D tSrc;uniform vec2 texel,axis;varying vec2 vUv;
    void main(){
      vec4 c=texture2D(tSrc,vUv);
      float dc=max(c.b,.1);
      vec3 sum=c.rga;float total=1.;
      for(int k=1;k<=3;k++){
        float g=exp(-float(k*k)*.2);
        for(int s=0;s<2;s++){
          vec4 v=texture2D(tSrc,vUv+axis*texel*float(k)*(s==0?-1.:1.));
          float r=log(max(v.b,.1)/dc);
          float w=g*exp(-r*r*70.);
          sum+=v.rga*w;total+=w;
        }
      }
      sum/=total;
      gl_FragColor=vec4(sum.x,sum.y,c.b,sum.z);
    }`});
  const resolveFogV2=`        vec2 pixel=vUv*fogSize-.5,base=floor(pixel),f=fract(pixel);
        vec4 taps[4];float costs[4];float lowest=1e9;
        for(int i=0;i<4;i++){
          vec2 offset=vec2(float(i-i/2*2),float(i/2));
          taps[i]=texture2D(tFog,clamp((base+offset+.5)/fogSize,vec2(.0001),vec2(.9999)));
          float rel=log(max(taps[i].b,.1)/max(distanceToSurface,.1));
          costs[i]=rel*rel*(1./.0144);
          lowest=min(lowest,costs[i]);
        }
        vec3 fog=vec3(0.);float weights=0.;
        for(int i=0;i<4;i++){
          vec2 offset=vec2(float(i-i/2*2),float(i/2));
          vec2 w2=mix(1.-f,f,offset);
          // Bilinear weight, times a depth weight that is relative to the best match: the
          // nearest-depth sample always wins, so nothing is ever borrowed from a far surface.
          float weight=max(w2.x*w2.y,.002)*exp(lowest-costs[i]);
          float rel=log(max(taps[i].b,.1)/max(distanceToSurface,.1));
          // Slopes and near matches only: re-express the sample at this pixel's own path length.
          float scale=mix(1.,fogReach(distanceToSurface)/max(fogReach(taps[i].b),1e-3),smoothstep(.35,.15,abs(rel)));
          scale=clamp(scale,.25,4.);
          fog+=vec3(pow(max(taps[i].r,.0001),scale),taps[i].g*scale,taps[i].a*scale)*weight;weights+=weight;
        }
        fog/=max(weights,1e-6);
        float forwardScatter=.17+1.12*pow(max(dot(ray,sunDirection),0.),5.);
        color=color*fog.r+mistColor*(1.-fog.r);
        color+=vec3(1.,.88,.70)*fog.z;
        // As strong as the sun's direct light is: nothing once it is down, still full at a low golden sun.
        color+=sunScatterColor*fog.g*forwardScatter*.60*pow(sunLevel,.6);
`;
  const resolveExtraV2=`
    // How far into the fog's density ramp (smoothstep 1.5..16 m, then constant) a path of length d reaches.
    float fogReach(float d){float x=clamp((d-1.5)/14.5,0.,1.);return 14.5*(x*x*x-.5*x*x*x*x)+max(d-16.,0.);}
  `;
  const resolveMaterial2=new THREE.ShaderMaterial({uniforms,vertexShader,depthTest:false,depthWrite:false,fragmentShader:resolveSource(raysCommon+resolveExtraV2,resolveFogV2)});
  // Terrain is not a shadow caster (lighting would self-shadow at low sun), so hills could never shade the fog.
  // This private, terrain-only depth map seen from the sun answers "is a hill between this fog and the sun?".
  const terrainSun=!WORLD_V2?undefined:(()=>{
    const SIZE=1024,EXTENT=330,DISTANCE=900,FAR=DISTANCE+1500,TEXEL=EXTENT*2/SIZE,GRID=TEXEL*12;
    const depth=new THREE.DepthTexture(SIZE,SIZE,THREE.UnsignedIntType);
    depth.minFilter=THREE.NearestFilter;depth.magFilter=THREE.NearestFilter;
    const map=new THREE.WebGLRenderTarget(SIZE,SIZE,{depthTexture:depth,format:THREE.RedFormat,type:THREE.UnsignedByteType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    const cam=new THREE.OrthographicCamera(-EXTENT,EXTENT,EXTENT,-EXTENT,1,FAR);
    const proxyScene=new THREE.Scene(),material=new THREE.MeshBasicMaterial({colorWrite:false,side:THREE.DoubleSide});
    const proxies:THREE.Mesh[]=[],direction=new THREE.Vector3(),right=new THREE.Vector3(),up=new THREE.Vector3(),center=new THREE.Vector3(),worldUp=new THREE.Vector3(0,1,0);
    let signature=NaN,cellX=NaN,cellY=NaN;
    const isTerrain=(o:THREE.Object3D):o is THREE.Mesh=>(o.name==='Streamed forest terrain'||o.name==='Distant mountain basin')&&(o as THREE.Mesh).isMesh&&o.visible;
    return {
      texture:depth as THREE.Texture,matrix:new THREE.Matrix4(),
      /** Returns true when the map was redrawn. */
      update(sun:THREE.Vector3,player:THREE.Vector3,bias:THREE.Vector2){
        let sig=0;for(const o of scene.children)if(isTerrain(o))sig=(sig*31+o.id)|0;
        right.crossVectors(worldUp,sun).normalize();up.crossVectors(sun,right);
        const x=Math.round(player.dot(right)/GRID),y=Math.round(player.dot(up)/GRID);
        const elevation=Math.asin(THREE.MathUtils.clamp(sun.y,.02,1));
        bias.set(Math.min(Math.max(1.2+TEXEL*Math.cos(elevation)/Math.sin(elevation)*1.3,2),9)/(FAR-1),2/(FAR-1));
        if(sig===signature&&x===cellX&&y===cellY&&direction.angleTo(sun)<.0025)return false;
        signature=sig;cellX=x;cellY=y;direction.copy(sun);
        center.copy(right).multiplyScalar(x*GRID).addScaledVector(up,y*GRID).addScaledVector(sun,player.dot(sun));
        cam.position.copy(center).addScaledVector(sun,DISTANCE);cam.up.copy(up);cam.lookAt(center);cam.updateMatrixWorld(true);
        this.matrix.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse);
        // Share the live terrain geometry; never own it (the terrain system disposes its own chunks).
        proxyScene.clear();let n=0;
        for(const o of scene.children)if(isTerrain(o)){
          let proxy=proxies[n];if(!proxy){proxy=new THREE.Mesh(o.geometry,material);proxy.matrixAutoUpdate=false;proxy.frustumCulled=true;proxies[n]=proxy;}
          proxy.geometry=o.geometry;proxy.matrix.copy(o.matrixWorld);proxy.matrixWorld.copy(o.matrixWorld);proxyScene.add(proxy);n++;
        }
        const previous=renderer.getRenderTarget(),need=renderer.shadowMap.needsUpdate,auto=renderer.shadowMap.autoUpdate,info=renderer.info.render,{calls,triangles}=info;
        renderer.shadowMap.needsUpdate=false;renderer.shadowMap.autoUpdate=false;
        renderer.setRenderTarget(map);renderer.clear();renderer.render(proxyScene,cam);
        renderer.setRenderTarget(previous);renderer.shadowMap.needsUpdate=need;renderer.shadowMap.autoUpdate=auto;info.calls=calls;info.triangles=triangles;
        proxyScene.clear();
        return true;
      },
      dispose(){map.dispose();depth.dispose();material.dispose();proxyScene.clear();}
    };
  })();
  const ao=createAmbientOcclusion(renderer,camera,uniforms);
  let aoLevel=2;
  const fogBlurTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  const quadScene=new THREE.Scene(),quadCamera=new THREE.Camera();
  const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),resolveMaterial);quad.frustumCulled=false;quadScene.add(quad);
  const dawn=new THREE.Color(0x879b98),night=new THREE.Color(0x071015),clearColor=new THREE.Color();
  let useFxaa=true,lastFrame=-1;
  const toneMapper=((typeof location!=='undefined'&&new URLSearchParams(location.search).get('tonemap'))||'aces') as ToneMapper;
  let measureStage:((name:string,draw:()=>void)=>void)|undefined;
  const stage=(name:string,draw:()=>void)=>{if(measureStage)measureStage(name,draw);else draw();};
  return {
    async measure(time:number,darkness:number){
      const gl=renderer.getContext() as WebGL2RenderingContext,result:Record<string,number>={};
      const extension=gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if(!extension)throw new Error('GPU timing is unavailable');
      const queries:{name:string,query:WebGLQuery}[]=[];
      measureStage=(name,draw)=>{const query=gl.createQuery()!;gl.beginQuery(extension.TIME_ELAPSED_EXT,query);draw();gl.endQuery(extension.TIME_ELAPSED_EXT);queries.push({name,query});};
      try{this.render(time,darkness);}finally{measureStage=undefined;}
      for(const {name,query} of queries){
        while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))await new Promise(r=>setTimeout(r,8));
        if(gl.getParameter(extension.GPU_DISJOINT_EXT))throw new Error('GPU timer was interrupted');
        result[name]=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;gl.deleteQuery(query);
      }return result;
    },
    /** Every target follows the render size the player chose (game/core/quality.ts): the scene at full size, the fog at a fraction of it. */
    resize(width:number,height:number,ratio:number){
      const w=Math.round(width*ratio),h=Math.round(height*ratio);
      hdrTarget.setSize(w,h);finalImage.resize(w,h);
      const requested=scene.userData.graphicsAA??4;const samples=Math.min(requested<=1?0:requested,4,renderer.capabilities.maxSamples);if(target.samples!==samples){target.samples=samples;target.dispose();}
      // The edge pass (light FXAA, then sharpening that follows how far the browser stretches the picture: post/sharpen.ts) runs on
      // top of every MSAA level; "Off" is the only setting without it.
      useFxaa=requested!==0;
      const waterDetail=scene.userData.graphicsWaterDetail??2;
      const waterScale=waterDetail===0?.5:waterDetail===1?.72:1;
      const waterWidth=Math.max(1,Math.round(w*waterScale)),waterHeight=Math.max(1,Math.round(h*waterScale));
      if(useFxaa){resolvedTarget.setSize(w,h);aaMaterial.uniforms.resolution.value.set(1/w,1/h);aaMaterial.uniforms.sharpness.value=perfOn('sharpen')?sharpnessFor(ratio,window.devicePixelRatio||1):0;}else resolvedTarget.setSize(1,1);
      target.setSize(w,h);waterTarget.setSize(waterWidth,waterHeight);waterResolution.set(waterWidth,waterHeight);
      // Even offscreen water depth is bound by the fog shader. Allocate its new
      // storage before sampling, otherwise a hidden target can keep old-sized
      // immutable depth storage until the river first becomes visible.
      renderer.initRenderTarget(target);renderer.initRenderTarget(waterTarget);
      // The calibrated 24 samples at High; lower fog settings take fewer samples at a lower resolution over the same full path length
      // and midpoint integration.
      const fogQuality=scene.userData.graphicsFog??1;
      uniforms.fogSteps.value=fogQuality<.6?14:fogQuality<.85?18:24;
      const fogScale=fogQuality<.6?.35:fogQuality<.85?.42:.5;
      const fw=Math.max(1,Math.ceil(w*fogScale)),fh=Math.max(1,Math.ceil(h*fogScale));fogTarget.setSize(fw,fh);uniforms.fogSize.value.set(fw,fh);
      if(WORLD_V2){fogBlurTarget.setSize(fw,fh);blurUniforms.texel.value.set(1/fw,1/fh);}
      aoLevel=scene.userData.graphicsAO??2;ao.resize(w,h,aoLevel);uniforms.tAO.value=ao.texture;uniforms.aoSize.value.copy(ao.size);
    },
    render(time:number,darkness:number){
      uniforms.time.value=time;uniforms.darkness.value=darkness;uniforms.fogColor.value.copy(dawn).lerp(night,darkness);
      if(scene.userData.fogColor)uniforms.fogColor.value.copy(scene.userData.fogColor);
      if(scene.userData.sunDirection)uniforms.sunDirection.value.copy(scene.userData.sunDirection);
      if(scene.userData.sunScatterColor)uniforms.sunScatterColor.value.copy(scene.userData.sunScatterColor);
      if(!scene.userData.hasSky)scene.background=uniforms.fogColor.value;
      scene.userData.skyColor=uniforms.fogColor.value;
      uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
      if(scene.userData.skyLut)uniforms.skyLut.value=scene.userData.skyLut as THREE.Texture;
      uniforms.fogDensity.value=(scene.userData.fogDensity as number|undefined)??1;
      uniforms.fogAmbient.value=(scene.userData.fogAmbient as number|undefined)??.8;
      if(scene.userData.mistColor)uniforms.mistColor.value.copy(scene.userData.mistColor as THREE.Color);
      water.prepare(camera);uniforms.hasWater.value=water.visible;
      stage('opaque',()=>{renderer.setRenderTarget(target);renderer.render(scene,camera);});
      if(water.visible)stage('water',()=>{
        const mask=camera.layers.mask,background=scene.background,shadowAuto=renderer.shadowMap.autoUpdate,alpha=renderer.getClearAlpha();
        renderer.getClearColor(clearColor);renderer.setRenderTarget(waterTarget);renderer.setClearColor(0,0);renderer.clear();
        renderer.autoClear=false;renderer.shadowMap.autoUpdate=false;scene.background=null;camera.layers.set(1);
        renderer.render(scene,camera);
        camera.layers.mask=mask;scene.background=background;renderer.autoClear=true;renderer.shadowMap.autoUpdate=shadowAuto;renderer.setClearColor(clearColor,alpha);
      });
      // Hills shade the fog (see terrainSun). Needs the sun up; night fog takes no sun at all.
      if(terrainSun&&darkness<.975){
        stage('terrainSun',()=>{terrainSun.update(uniforms.sunDirection.value,camera.position,uniforms.terrainSunBias.value);});
        uniforms.terrainSun.value=terrainSun.texture;uniforms.terrainSunMatrix.value.copy(terrainSun.matrix);uniforms.terrainSunOn.value=1;
      }else uniforms.terrainSunOn.value=0;
      uniforms.sunLevel.value=(scene.userData.sunLevel as number|undefined)??Math.min(1,sun.intensity/1.32);
      canopy.update(camera.position);
      const flash=scene.userData.flashlight as THREE.SpotLight|null;
      uniforms.flashPower.value=flash?.intensity??0;
      if(flash){uniforms.flashShadow.value=flash.shadow.map?.texture??null;uniforms.flashMatrix.value.copy(flash.shadow.matrix);uniforms.flashPosition.value.copy(flash.position);uniforms.flashDirection.value.copy(flash.target.position).sub(flash.position).normalize();
        const cam=flash.shadow.camera as THREE.PerspectiveCamera;uniforms.flashRange.value.set(cam.near,cam.far);
        uniforms.flashCone.value.set(Math.cos(flash.angle),Math.cos(flash.angle*(1-flash.penumbra)));uniforms.flashDecay.value=flash.decay;
        uniforms.flashCookie.value=flash.map??null;uniforms.flashHasCookie.value=flash.map?1:0;}
      uniforms.sunShadow.value=sun.shadow.map?.texture??null;uniforms.shadowTexel.value=1/sun.shadow.mapSize.x;
      uniforms.fogEnabled.value=!(import.meta.env.DEV&&scene.userData.profileSkipFog);
      uniforms.aoOn.value=aoQuality(aoLevel).on&&perfOn('ambientOcclusion')?1:0;
      if(uniforms.aoOn.value>.5)stage('ao',()=>ao.render());
      stage('fog',()=>{if(uniforms.fogEnabled.value){
        quad.material=WORLD_V2?fogMaterial2:fogMaterial;renderer.setRenderTarget(fogTarget);renderer.render(quadScene,quadCamera);
        if(WORLD_V2){
          quad.material=fogBlurMaterial;
          blurUniforms.tSrc.value=fogTarget.texture;blurUniforms.axis.value.set(1,0);renderer.setRenderTarget(fogBlurTarget);renderer.render(quadScene,quadCamera);
          blurUniforms.tSrc.value=fogBlurTarget.texture;blurUniforms.axis.value.set(0,1);renderer.setRenderTarget(fogTarget);renderer.render(quadScene,quadCamera);
        }
      }});
      stage('resolve',()=>{quad.material=WORLD_V2?resolveMaterial2:resolveMaterial;renderer.setRenderTarget(hdrTarget);renderer.render(quadScene,quadCamera);});
      const now=performance.now(),dt=lastFrame<0?0:(now-lastFrame)/1000;lastFrame=now;
      const grade=scene.userData.grade as Grade|undefined;
      if(grade)stage('final',()=>{finalImage.render(hdrTarget.texture,useFxaa?resolvedTarget:null,grade,dt,toneMapper);});
      stage('antialias',()=>{if(useFxaa){quad.material=aaMaterial;renderer.setRenderTarget(null);renderer.render(quadScene,quadCamera);}});
    },
    /** The eye starts adapting afresh (teleports, loading). */
    resetExposure(){finalImage.resetExposure();},
    dispose(){ao.dispose();canopy.dispose();resolvedTarget.dispose();hdrTarget.dispose();finalImage.dispose();aaMaterial.dispose();target.dispose();waterTarget.dispose();fogTarget.dispose();fogBlurTarget.dispose();terrainSun?.dispose();fogMaterial.dispose();fogMaterial2.dispose();fogBlurMaterial.dispose();resolveMaterial.dispose();resolveMaterial2.dispose();quad.geometry.dispose();}
  };
}
