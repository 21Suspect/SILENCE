import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import type { createRiver } from './river';
import { WORLD_V2 } from './world-flags';

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
  const aaMaterial=new THREE.ShaderMaterial({uniforms:THREE.UniformsUtils.clone(FXAAShader.uniforms),vertexShader:FXAAShader.vertexShader,fragmentShader:FXAAShader.fragmentShader,depthTest:false,depthWrite:false});
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
    sunShadow:{value:null as THREE.Texture|null},sunMatrix:{value:sun.shadow.matrix},shadowTexel:{value:1/sun.shadow.mapSize.x},
  };
  const vertexShader='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
  const common=`
    precision highp float;
    uniform sampler2D tColor,tDepth,tWater,tWaterDepth,tFog,sunShadow,flashShadow;
    uniform mat4 flashMatrix;uniform vec3 flashPosition,flashDirection;uniform float flashPower;
    uniform bool hasWater,fogEnabled;
    uniform mat4 inverseProjection,cameraWorld,sunMatrix;
    uniform vec3 cameraPositionWorld,fogColor,sunDirection,sunScatterColor;
    uniform vec2 fogSize;uniform float fogSteps;
    uniform float time,darkness,shadowTexel;
    varying vec2 vUv;
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
        float density=(.014+billow*.03)*heightDensity*smoothstep(1.5,16.,distanceAlongRay);
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
        color=color*fog.r+fogColor*mix(.72,1.,darkness)*(1.-fog.r);
        color+=vec3(1.,.88,.70)*fog.z;
        color+=sunScatterColor*fog.g*forwardScatter*.50*pow(1.-darkness,2.);
`;
  const resolveTail=`      }
      float luminance=dot(color,vec3(.2126,.7152,.0722));
      // The original sky is calibrated from exact sRGB palette samples. Leave
      // its chroma intact; the forest retains its cinematic color treatment.
      // Both paths already received the same physically integrated fog above.
      float sky=step(.999999,depth);
      color=mix(mix(vec3(luminance),color,.76)*vec3(.94,1.,1.01),color,sky);
      // Modest dark adaptation preserves terrain/prop contrast in the darkest
      // part of the cycle. A tiny cool toe keeps even occluded surfaces legible.
      color+=vec3(.00065,.00085,.0011)*darkness;
      color=linearSrgb(aces(color*mix(1.24,1.65,darkness)));
      color*=1.-smoothstep(.16,.75,length((vUv-.5)*vec2(1.,.86)))*.24*(1.-sky*(1.-darkness));
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
        float density=(.014+billow*.03)*heightDensity*smoothstep(1.5,16.,distanceAlongRay);
        float extinction=density*sliceLength;
        float scatter=exp(-opticalDepth)*(1.-exp(-extinction));
        if(day>.025){
          float inside;float lit=mappedSunlight(p,inside);
          float prior=(meanLit+.004)/(meanWeight+.008);
          illuminatedFog+=scatter*mix(prior,lit,inside)*terrainSunlight(p);
          meanLit+=scatter*inside*lit;meanWeight+=scatter*inside;
        }
        if(flashPower>0.){
          vec3 fromLamp=p-flashPosition;float lampDistance=length(fromLamp);
          float cone=smoothstep(.866,.98,dot(normalize(fromLamp),flashDirection));
          vec4 fp=flashMatrix*vec4(p,1.);vec3 fu=fp.xyz/fp.w;
          float visible=0.;
          if(fu.x>0.&&fu.x<1.&&fu.y>0.&&fu.y<1.&&fu.z>0.&&fu.z<1.){
            float fd=dot(texture2D(flashShadow,fu.xy),vec4(255./256.,255./65536.,255./16777216.,1./16777216.));
            visible=smoothstep(fu.z-.0004,fu.z+.0004,fd);
          }
          beamFog+=scatter*cone*visible*flashPower/(1.+lampDistance*lampDistance)*.55;
        }
        opticalDepth+=extinction;
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
        color=color*fog.r+fogColor*mix(.72,1.,darkness)*(1.-fog.r);
        color+=vec3(1.,.88,.70)*fog.z;
        color+=sunScatterColor*fog.g*forwardScatter*.50*pow(1.-darkness,2.);
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
  const fogBlurTarget=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,depthBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  const quadScene=new THREE.Scene(),quadCamera=new THREE.Camera();
  const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),resolveMaterial);quad.frustumCulled=false;quadScene.add(quad);
  const dawn=new THREE.Color(0x879b98),night=new THREE.Color(0x071015),clearColor=new THREE.Color();
  let useFxaa=true;
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
    resize(width:number,height:number,ratio:number,quality=1){
      const w=Math.round(width*ratio),h=Math.round(height*ratio);
      const requested=scene.userData.graphicsAA??4;const samples=Math.min(requested<=1?0:requested,quality<.65?2:4,renderer.capabilities.maxSamples);if(target.samples!==samples){target.samples=samples;target.dispose();}
      // Keep the calibrated 4x-MSAA + FXAA look at normal and mid quality.
      // Only the constrained 2x-MSAA tier drops the extra full-screen pass;
      // this is where adaptive resolution already trades edge detail for
      // responsiveness.
      useFxaa=requested!==0&&(requested===1||quality>=.65||samples>=4);
      const waterDetail=Math.min(scene.userData.graphicsWaterDetail??2,quality<.65?0:quality<.9?1:2);
      const waterScale=waterDetail===0?.5:waterDetail===1?.72:1;
      const waterWidth=Math.max(1,Math.round(w*waterScale)),waterHeight=Math.max(1,Math.round(h*waterScale));
      if(useFxaa){resolvedTarget.setSize(w,h);aaMaterial.uniforms.resolution.value.set(1/w,1/h);}else resolvedTarget.setSize(1,1);
      target.setSize(w,h);waterTarget.setSize(waterWidth,waterHeight);waterResolution.set(waterWidth,waterHeight);
      // Even offscreen water depth is bound by the fog shader. Allocate its new
      // storage before sampling, otherwise a hidden target can keep old-sized
      // immutable depth storage until the river first becomes visible.
      renderer.initRenderTarget(target);renderer.initRenderTarget(waterTarget);
      // Keep the normal path at the calibrated 24 samples. Lower tiers shed
      // work before adaptive resolution becomes extreme, while retaining the
      // same full path length and midpoint integration.
      const fogQuality=scene.userData.graphicsFog??quality;
      uniforms.fogSteps.value=fogQuality<.6?14:fogQuality<.85?18:24;
      const fogScale=fogQuality<.6?.35:fogQuality<.85?.42:.5;
      const fw=Math.max(1,Math.ceil(w*fogScale)),fh=Math.max(1,Math.ceil(h*fogScale));fogTarget.setSize(fw,fh);uniforms.fogSize.value.set(fw,fh);
      if(WORLD_V2){fogBlurTarget.setSize(fw,fh);blurUniforms.texel.value.set(1/fw,1/fh);}
    },
    render(time:number,darkness:number){
      uniforms.time.value=time;uniforms.darkness.value=darkness;uniforms.fogColor.value.copy(dawn).lerp(night,darkness);
      if(scene.userData.fogColor)uniforms.fogColor.value.copy(scene.userData.fogColor);
      if(scene.userData.sunDirection)uniforms.sunDirection.value.copy(scene.userData.sunDirection);
      if(scene.userData.sunScatterColor)uniforms.sunScatterColor.value.copy(scene.userData.sunScatterColor);
      if(!scene.userData.hasSky)scene.background=uniforms.fogColor.value;
      scene.userData.skyColor=uniforms.fogColor.value;
      uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
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
      const flash=scene.userData.flashlight as THREE.SpotLight|null;
      uniforms.flashPower.value=flash?.intensity??0;
      if(flash){uniforms.flashShadow.value=flash.shadow.map?.texture??null;uniforms.flashMatrix.value.copy(flash.shadow.matrix);uniforms.flashPosition.value.copy(flash.position);uniforms.flashDirection.value.copy(flash.target.position).sub(flash.position).normalize();}
      uniforms.sunShadow.value=sun.shadow.map?.texture??null;uniforms.shadowTexel.value=1/sun.shadow.mapSize.x;
      uniforms.fogEnabled.value=!(import.meta.env.DEV&&scene.userData.profileSkipFog);
      stage('fog',()=>{if(uniforms.fogEnabled.value){
        quad.material=WORLD_V2?fogMaterial2:fogMaterial;renderer.setRenderTarget(fogTarget);renderer.render(quadScene,quadCamera);
        if(WORLD_V2){
          quad.material=fogBlurMaterial;
          blurUniforms.tSrc.value=fogTarget.texture;blurUniforms.axis.value.set(1,0);renderer.setRenderTarget(fogBlurTarget);renderer.render(quadScene,quadCamera);
          blurUniforms.tSrc.value=fogBlurTarget.texture;blurUniforms.axis.value.set(0,1);renderer.setRenderTarget(fogTarget);renderer.render(quadScene,quadCamera);
        }
      }});
      stage('resolve',()=>{quad.material=WORLD_V2?resolveMaterial2:resolveMaterial;renderer.setRenderTarget(useFxaa?resolvedTarget:null);renderer.render(quadScene,quadCamera);});
      stage('antialias',()=>{if(useFxaa){quad.material=aaMaterial;renderer.setRenderTarget(null);renderer.render(quadScene,quadCamera);}});
    },
    dispose(){resolvedTarget.dispose();aaMaterial.dispose();target.dispose();waterTarget.dispose();fogTarget.dispose();fogBlurTarget.dispose();terrainSun?.dispose();fogMaterial.dispose();fogMaterial2.dispose();fogBlurMaterial.dispose();resolveMaterial.dispose();resolveMaterial2.dispose();quad.geometry.dispose();}
  };
}
