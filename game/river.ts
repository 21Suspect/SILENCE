import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RIVER_EXTENT, waterHeightAt, waterGradeAt, riverProfileGLSL, riverCourseGLSL, channelOffset } from './world';
import { BRANCHES, branchX } from './world-noise';
import { WORLD_V2 } from './world-flags';
import { LAKE_CENTER, LAKE_RADII, LAKE_LEVEL, SEA_LEVEL, lakeDistance, coastDistance, coastalGLSL } from './coastal-geography';

/** Live ripple rings: a footfall each stride, plus the small rings of drops coming back down. */
const RIPPLES=WORLD_V2?12:8;
const WATER_NORMAL_URL='/world/water/water-normal.png',WATER_FOAM_URL='/world/water/water-foam.png';

/** Until the baked textures arrive: a small tile of summed waves, so the first frames are rippled, not glass. Same encoding as the file. */
function fallbackWaterNormal(){
  const size=64,slope=new Float32Array(size*size*3),waves=[[1,2,.9,.3],[3,1,.7,1.9],[2,5,.5,4.1],[6,3,.4,2.7],[4,9,.3,5.2],[11,5,.25,.8]];
  let energy=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let sx=0,sy=0,h=0;
    for(const [kx,ky,a,ph] of waves){const t=(kx*x+ky*y)/size*Math.PI*2+ph,c=Math.cos(t)*a;sx+=c*kx;sy+=c*ky;h+=Math.sin(t)*a;}
    const i=(y*size+x)*3;slope[i]=sx;slope[i+1]=sy;slope[i+2]=h;energy+=sx*sx+sy*sy;
  }
  // The baked tile's RMS slope sits at .28 of full scale; match it so the stand-in is not glass.
  const k=.28*127.5/Math.sqrt(energy/(2*size*size)),data=new Uint8Array(size*size*4);
  for(let i=0;i<size*size;i++){
    data[i*4]=Math.max(0,Math.min(255,127.5+slope[i*3]*k));data[i*4+1]=Math.max(0,Math.min(255,127.5+slope[i*3+1]*k));data[i*4+2]=127.5+slope[i*3+2]*40;data[i*4+3]=255;
  }
  const t=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);configureWaterTexture(t,8);return t;
}
function fallbackWaterFoam(){const t=new THREE.DataTexture(new Uint8Array(4*4),2,2,THREE.RGBAFormat);configureWaterTexture(t,1);return t;}
function configureWaterTexture(t:THREE.Texture,anisotropy:number){
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.generateMipmaps=true;
  t.anisotropy=anisotropy;t.colorSpace=THREE.NoColorSpace;t.needsUpdate=true;
}

const WATER_GLSL=`
  vec2 waterJump(float n){return fract(sin(vec2(n*12.9898,n*78.233))*43758.5453)*23.;}
  // Two copies of a tile, each carried down the channel by the current and faded in and out half a period apart,
  // so that a copy is invisible at the moment it restarts. Normals blend so the amplitude holds at the cross-over.
  vec2 flowSlope(vec2 ch,float speed,float scale,float stretch,float period,float seed,mat2 rot){
    float c=uTime/period+seed*.318,pA=fract(c),pB=fract(c+.5),wA=smoothstep(.1,.9,1.-abs(1.-2.*pA)),wB=1.-wA;
    vec2 a=vec2(ch.x,ch.y+speed*pA*period)+waterJump(floor(c)+seed),b=vec2(ch.x,ch.y+speed*pB*period)+waterJump(floor(c+.5)+seed+.37);
    a.y*=stretch;b.y*=stretch;
    vec2 sA=texture2D(tWaterNormal,rot*a*scale).xy*2.-1.,sB=texture2D(tWaterNormal,rot*b*scale).xy*2.-1.;
    vec2 s=(sA*wA+sB*wB)*inversesqrt(wA*wA+wB*wB);
    s=s*rot;s.y*=stretch;return s;
  }
  vec3 flowFoam(vec2 ch,float speed,float scale,float stretch,float period,float seed){
    float c=uTime/period+seed*.318,pA=fract(c),pB=fract(c+.5),wA=smoothstep(.1,.9,1.-abs(1.-2.*pA)),wB=1.-wA;
    vec2 a=vec2(ch.x,ch.y+speed*pA*period)+waterJump(floor(c)+seed),b=vec2(ch.x,ch.y+speed*pB*period)+waterJump(floor(c+.5)+seed+.37);
    a.y*=stretch;b.y*=stretch;
    return texture2D(tWaterFoam,a*scale).rgb*wA+texture2D(tWaterFoam,b*scale).rgb*wB;
  }`;

// Which way the channel runs on the ground at this pixel, from how the channel coordinates and world position change on screen.
const WATER_FRAME_GLSL=`
        vec2 acrossDir=vec2(1.,0.),alongDir=vec2(0.,1.);
        {
          vec2 dWx=dFdx(vWater.xz),dWy=dFdy(vWater.xz),dCx=dFdx(vChannel),dCy=dFdy(vChannel);
          float det=dCx.x*dCy.y-dCy.x*dCx.y;
          if(abs(det)>1e-12){
            vec2 da=(dWx*dCy.y-dWy*dCx.y)/det,dl=(dWy*dCx.x-dWx*dCy.x)/det;
            float la=length(da),ll=length(dl);
            if(la>1e-5&&ll>1e-5){acrossDir=da/la;alongDir=dl/ll;}
          }
        }`;

const WATER_FLOW_GLSL=`
        // Channel space: across in metres from mid-stream, along the bed. The water runs towards decreasing along,
        // fastest down the middle. Every layer is advected in these coordinates, so the current follows any bend.
        float broad=step(1.5,vRibbon),ocean=step(2.5,vRibbon);
        float across=vChannel.x,along=vChannel.y,mid=(1.-smoothstep(.3,5.2,abs(across)))*(1.-broad),speed=mix(mix(.26,.92,mid),mix(.10,.34,ocean),broad);
        vec2 ch=vec2(across,along);
        // Riffles stand where the bed lifts: fixed in place while the water runs through them.
        float riffle=smoothstep(.5,.84,texture2D(tWaterFoam,vec2(across*.085+.37,along*.047)).b)*(.4+.6*mid)*(1.-broad);
        riffle=max(riffle,smoothstep(.08,.65,abs(vSlope.y))*(1.-broad));
        float rough=(.55+.8*riffle+.2*mid+.30*ocean)*mix(.4,1.,smoothstep(0.,.3,thickness));
        float nearFade=1.-smoothstep(9.,34.,vViewDepth),midFade=1.-smoothstep(26.,80.,vViewDepth),farFade=1.-smoothstep(50.,150.,vViewDepth);
        // Broad swell and mid ripples bend the bed and the reflection; the finest wrinkles only catch the light, since bending
        // the bed at that scale shatters the pebbles' outlines.
        vec2 bulk=flowSlope(ch,speed,.17,.6,3.6,0.,mat2(1.,0.,0.,1.))*(.3*farFade),fine=vec2(0.);
        if(uDetail>.5)bulk+=flowSlope(ch,speed*.96,.52,.6,2.7,1.,mat2(.857,.515,-.515,.857))*(.24*midFade);
        if(uDetail>1.5)fine=flowSlope(ch,speed*1.05,1.6,.6,2.1,2.,mat2(.921,-.391,.391,.921))*(.17*nearFade);
        bulk*=rough;fine*=rough;
        vec2 slopeCh=bulk+fine;
        vec2 detail=-(acrossDir*slopeCh.x+alongDir*slopeCh.y),soft=-(acrossDir*(bulk.x+fine.x*.3)+alongDir*(bulk.y+fine.y*.3));
        // Foam is carried by the current too, slower than the middle of the stream.
        vec3 fm=flowFoam(ch,speed*.75,.5,.3,4.,3.);
        float clumpF=smoothstep(.2,.75,fm.b),pat=max(smoothstep(.2,.9,fm.r)*(.5+.5*clumpF)*.85,fm.g*.9);
        // Rings spread from where the water was broken and are carried downstream.
        float ringFoam=0.,chop=clamp(length(slopeCh)*6.,0.,1.);
        for(int i=0;i<${RIPPLES};i++){
          vec4 r=uRipple[i];if(r.w<=0.)continue;
          // A footfall is a full ring; the few drops that land after it ring a few centimetres wide, and fade with distance.
          float sc=mix(.18,1.,smoothstep(.1,.7,r.w)),age=r.z;
          vec2 d=vWater.xz-(r.xy-alongDir*speed*age);
          float l=length(d)+.001,front=(.05+.46*pow(age,.6))*sc,reach=(.03+.045*age)*sc,k=6.283/(.045*sc);
          float env=exp(-pow((l-front)/reach,2.))*exp(-age*(1.5+2.*(1.-sc)))*r.w*(1.-(1.-sc)*smoothstep(5.,18.,vViewDepth));
          vec2 ringSlope=d/l*cos((l-front)*k)*env*.55;detail+=ringSlope;soft+=ringSlope*.7;
          ringFoam+=(exp(-age*4.)*(1.-smoothstep(0.,.1+.22*age,l/sc))*.9+env*.3)*sc;
        }
        `;

const WATER_FOAM_GLSL=`
        // Foam gathers where the water is thinnest (banks, stones), in the riffles, and where something has just broken the surface.
        float shore=1.-smoothstep(.012,.22,thickness);
        // Scum in pockets along the bank, broken by long gaps: never a drawn line.
        float edgeFoam=shore*smoothstep(.34,.82,pat*(.12+1.2*clumpF))*(.3+.4*smoothstep(0.,.05,thickness));
        // Thin broken swash bands advance and retreat across the sloping beach.
        float shoreMetres=-coastDistance(vWater.xz);
        float wavePhase=shoreMetres*.72+uTime*1.15+.5*sin(vWater.x*.047+vWater.z*.033);
        float breaker=pow(.5+.5*sin(wavePhase),9.)*(1.-smoothstep(5.,22.,shoreMetres));
        float swash=((1.-smoothstep(0.,3.5,abs(shoreMetres-2.4-1.8*sin(uTime*.55+vWater.x*.035))))+breaker)*ocean;
        edgeFoam+=swash*smoothstep(.22,.72,pat)*1.15;
        float riffleFoam=riffle*smoothstep(.45,.95,pat*(.3+.9*clumpF))*.48*smoothstep(.03,.14,thickness);
        float white=clamp((edgeFoam*.55+riffleFoam+ringFoam*(.4+.6*pat))*uFoamGain,0.,1.)*(1.-.5*smoothstep(15.,60.,vViewDepth));
        vec3 foamCol=mix(vec3(.17,.2,.19),vec3(.46,.5,.48),.3+.7*pat)*(1.-uDarkness*.96);
        result=mix(result,foamCol,white*.62);
        `;

/** A shallow, moving surface with a true opaque-scene refraction pass. */
export function createRiver(scene:THREE.Scene, riverX:(z:number)=>number, heightAt:(x:number,z:number)=>number) {
  const positions:number[]=[], indices:number[]=[], uv:number[]=[], ribbonKind:number[]=[];
  const rowStep=.5,rows=RIVER_EXTENT*2/rowStep,columns=24;
  // Extend under BOTH banks: the terrain's depth, not a visible strip edge, trims the water.
  // uv is (metres across the channel, metres along it), so the current can follow any bend.
  const ribbons=[{centre:riverX,half:8,from:0,to:rows,kind:0},...(WORLD_V2?BRANCHES:[]).map(b=>({centre:(z:number)=>branchX(b,z),half:6.5,from:Math.ceil((b.z0+RIVER_EXTENT)/rowStep),to:Math.floor((b.z1+RIVER_EXTENT)/rowStep),kind:1}))];
  const base:number[]=[];
  for(const r of ribbons){
    base.push(positions.length/3);
    let along=0,px=r.centre(-RIVER_EXTENT+r.from*rowStep),pz=-RIVER_EXTENT+r.from*rowStep;
    for(let j=r.from;j<=r.to;j++){
      const z=-RIVER_EXTENT+j*rowStep,cx=r.centre(z),s=WORLD_V2?(r.centre(z+.25)-r.centre(z-.25))/.5:0,l=Math.hypot(1,s),nx=1/l,nz=-s/l;
      along+=Math.hypot(cx-px,z-pz);px=cx;pz=z;
      for(let i=0;i<=columns;i++){
        const across=(i/columns-.5)*2*r.half,x=cx+across*nx,wz=z+across*nz;
        positions.push(x,-wz,0);if(WORLD_V2)uv.push(across,along);else uv.push(x,wz);ribbonKind.push(r.kind);
      }
    }
  }
  // Index by row, whichever ribbon a quad belongs to, so one draw range still covers only what is near the player.
  const rowIndexStart=new Int32Array(rows+2);
  for(let j=0;j<=rows;j++){
    rowIndexStart[j]=indices.length;
    if(j===rows)break;
    ribbons.forEach((r,n)=>{
      if(j<r.from||j>=r.to)return;
      for(let i=0;i<columns;i++){
        const a=base[n]+(j-r.from)*(columns+1)+i,b=a+columns+1;
        indices.push(a,b,a+1,a+1,b,b+1);
      }
    });
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setAttribute('aRibbon',new THREE.Float32BufferAttribute(ribbonKind,1));geometry.setIndex(indices);geometry.computeVertexNormals();
  // Baked tiles arrive after the first frames. Until then, a small procedural tile stands in for the normals and foam is off.
  const waterNormal=WORLD_V2?fallbackWaterNormal():null,waterFoam=WORLD_V2?fallbackWaterFoam():null;
  const stream=new Reflector(geometry,{textureWidth:768,textureHeight:768,clipBias:.004,multisample:0,
    shader:{name:'Shallow flowing water',uniforms:{
      tDiffuse:{value:null},color:{value:new THREE.Color()},textureMatrix:{value:new THREE.Matrix4()},
      tOpaque:{value:null},tOpaqueDepth:{value:null},uResolution:{value:new THREE.Vector2()},uInverseProjection:{value:new THREE.Matrix4()},uWorldToSurface:{value:new THREE.Matrix4()},uReflectionPlane:{value:new THREE.Vector4(0,1,0,-waterHeightAt(0))},
      tReflectionDepth:{value:null},uReflectionInverseProjection:{value:new THREE.Matrix4()},uReflectionCameraWorld:{value:new THREE.Matrix4()},uSunScatterColor:{value:new THREE.Color(1,.81,.52)},
      uTime:{value:0},uDarkness:{value:0},uReflectionDetail:{value:0},uReflectionSteps:{value:6},uSky:{value:new THREE.Color(0x879b98)},uSunDirection:{value:new THREE.Vector3(.3,.55,-.7).normalize()},uRipple:{value:Array.from({length:RIPPLES},()=>new THREE.Vector4(0,0,99,0))},
      ...(WORLD_V2?{tWaterNormal:{value:waterNormal},tWaterFoam:{value:waterFoam},uDetail:{value:2},uFoamGain:{value:0}}:{}),
    },
    vertexShader:`
      uniform mat4 textureMatrix,uWorldToSurface;uniform float uTime;
      varying vec4 vReflection;varying vec3 vWater,vEye;varying float vViewDepth;varying vec2 vSlope;
      ${WORLD_V2?'attribute float aRibbon;varying vec2 vChannel;varying float vRibbon;':''}
      ${riverProfileGLSL}
      ${WORLD_V2?coastalGLSL:''}
      void main(){
        vec3 p=position;
        float x=p.x,z=-p.y;
        ${WORLD_V2?'vChannel=uv;vRibbon=aRibbon;':''}
        float a=z*2.1-x*.65+uTime*1.15;
        float b=z*4.7+x*2.3+uTime*1.9;
        float c=z*8.1-x*3.4+uTime*2.6;
        p.z=sin(a)*.012+sin(b)*.006+sin(c)*.002;
        float grade=streamGrade(z),level=streamHeight(z);
        ${WORLD_V2?`if(aRibbon>1.5){grade=0.;level=aRibbon>2.5?${SEA_LEVEL.toFixed(4)}:${LAKE_LEVEL.toFixed(4)};}`:''}
        vSlope=vec2(-.65*cos(a)*.012+2.3*cos(b)*.006-3.4*cos(c)*.002,grade+2.1*cos(a)*.012+4.7*cos(b)*.006+8.1*cos(c)*.002);
        ${WORLD_V2?`if(aRibbon>2.5){
          float swell=x*.13+z*.085+uTime*.72,secondary=x*.047-z*.11+uTime*.48;
          float shore=-coastDistance(vec2(x,z));float swellFade=smoothstep(-4.,28.,shore);
          p.z+=.065*sin(shore*.65+uTime*1.15)*exp(-abs(shore)*.08);
          p.z+=(sin(swell)*.22+sin(secondary)*.10)*swellFade;
          vSlope+=vec2(.13*cos(swell)*.22+.047*cos(secondary)*.10,.085*cos(swell)*.22-.11*cos(secondary)*.10)*swellFade;
        }`:''}
        // World-space height follows the channel. The reflector itself tracks
        // its local tangent plane without bending or moving the visible stream.
        vec4 world=vec4(x,level+p.z,z,1.);
        vReflection=textureMatrix*uWorldToSurface*world;
        vWater=world.xyz;vEye=cameraPosition-world.xyz;
        vec4 view=viewMatrix*world;vViewDepth=-view.z;gl_Position=projectionMatrix*view;
      }`,
    fragmentShader:`
      uniform sampler2D tDiffuse,tOpaque,tOpaqueDepth,tReflectionDepth;uniform vec2 uResolution;
      uniform mat4 uInverseProjection,uReflectionInverseProjection,uReflectionCameraWorld;uniform vec4 uReflectionPlane;uniform float uTime,uDarkness,uReflectionDetail,uReflectionSteps;uniform vec3 uSky,uSunDirection,uSunScatterColor;
      varying vec4 vReflection;varying vec3 vWater,vEye;varying float vViewDepth;varying vec2 vSlope;
      ${WORLD_V2?'varying vec2 vChannel;varying float vRibbon;':''}
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      ${WORLD_V2?`${riverCourseGLSL}
      ${coastalGLSL}
      uniform vec4 uRipple[${RIPPLES}];uniform sampler2D tWaterNormal,tWaterFoam;uniform float uDetail,uFoamGain;
      ${WATER_GLSL}`:''}
      float viewDepth(vec2 uv){float d=texture2D(tOpaqueDepth,uv).x;vec4 p=uInverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);return -p.z/p.w;}
      float fogHash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
      float fogNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(fogHash(i),fogHash(i+vec3(1,0,0)),f.x),mix(fogHash(i+vec3(0,1,0)),fogHash(i+vec3(1,1,0)),f.x),f.y),mix(mix(fogHash(i+vec3(0,0,1)),fogHash(i+vec3(1,0,1)),f.x),mix(fogHash(i+vec3(0,1,1)),fogHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
      vec3 reflectedAtmosphere(vec3 color,vec2 uv,vec3 normal){
        float d=texture2D(tReflectionDepth,uv).r;
        vec4 view=uReflectionInverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);
        vec3 ray=reflect(-normalize(vEye),normal);float distanceToHit=180.;
        if(d<.99999&&abs(view.w)>.00001){
          vec3 hit=(uReflectionCameraWorld*vec4(view.xyz/view.w,1.)).xyz;
          vec3 delta=hit-vWater;distanceToHit=min(length(delta),180.);ray=normalize(delta);
        }
        // Only surface → reflected object is integrated here. The ordinary
        // atmosphere pass already handles the camera → water part of the path.
        // Density, wind and altitude falloff match the main forest atmosphere.
        float stepCount=max(uReflectionSteps,1.),stepLength=distanceToHit/stepCount,opticalDepth=0.;
        float cameraDistance=length(vEye);
        for(int i=0;i<6;i++){
          if(float(i)>=uReflectionSteps)break;
          float along=(float(i)+.5)*stepLength;vec3 p=vWater+ray*along;
          float billow=fogNoise((p+vec3(uTime*.10,0.,uTime*.035))*.085);
          float heightDensity=exp(-max(p.y-1.5,0.)*.050);
          float density=(.014+billow*.03)*heightDensity*smoothstep(1.5,16.,cameraDistance+along);
          opticalDepth+=density*stepLength;
        }
        float transmission=exp(-opticalDepth),day=1.-uDarkness;
        vec3 scattering=uSky*mix(.72,1.,uDarkness);
        float forwardScatter=.17+1.12*pow(max(dot(ray,uSunDirection),0.),5.);
        // Diffuse canopy visibility is deliberately modest; the main scene's
        // detailed shafts remain in its existing shadow-aware volume pass.
        scattering+=uSunScatterColor*forwardScatter*.20*day*day;
        return color*transmission+scattering*(1.-transmission);
      }
      void main(){
        ${WORLD_V2?WATER_FRAME_GLSL:''}
        vec2 screen=gl_FragCoord.xy/uResolution;
        float thickness=max(0.,viewDepth(screen)-vViewDepth);
        // Surface intersection is determined by the real depth-buffer shoreline.
        if(thickness<.001)discard;
        ${WORLD_V2?`
        // Broad surfaces own their shoreline pixels, so river junctions never
        // double-draw or z-fight against the lake or estuary.
        float lakeEdge=lakeDistance(vWater.xz),coastEdge=coastDistance(vWater.xz);
        if(vRibbon<1.5 && (lakeEdge<0. || coastEdge<3.))discard;
        // The terrain closes tributary heads and tapers the main source. The
        // water must obey the SAME channel mask, even if forest behind it is
        // lower than the water plane (depth testing alone cannot detect that).
        if(vRibbon<1.5 && (streamOffset(vWater.xz)>3.5 || abs(vWater.z)>${(RIVER_EXTENT-52).toFixed(1)}))discard;
        if(vRibbon>1.5 && vRibbon<2.5 && (lakeEdge>0. || coastEdge<0.))discard;
        if(vRibbon>2.5 && coastEdge>12.)discard;
        // Where a side channel meets the stream the two surfaces share a level. Each pixel goes to exactly one of them.
        float offMain=abs(vWater.x-streamCentre(vWater.z))/sqrt(1.+pow((streamCentre(vWater.z+.6)-streamCentre(vWater.z-.6))/1.2,2.));
        float toSide=smoothstep(4.2,6.2,offMain),stipple=hash(floor(gl_FragCoord.xy));
        if(vRibbon<1.5 && (vRibbon>.5?stipple>toSide:(stipple<toSide&&offMain<8.2&&offMain>4.2&&${BRANCHES.length?BRANCHES.map(b=>`vWater.z>${b.z0.toFixed(1)}&&vWater.z<${b.z1.toFixed(1)}`).join('||').replace(/^(.*)$/,'($1)'):'false'})))discard;`:''}
        ${WORLD_V2?WATER_FLOW_GLSL:`
        vec2 flow=vWater.xz*vec2(1.3,2.8)+vec2(uTime*.04,uTime*.35);
        float n1=noise(flow),n2=noise(flow*2.7+vec2(8.5,uTime*.4));
        vec2 detail=vec2(n1-.5,n2-.5)*.055;
        `}
        vec3 N=normalize(vec3(-vSlope.x+detail.x,1.,-vSlope.y+detail.y));
        float viewAngle=max(dot(normalize(vEye),N),0.);
        float fresnel=.022+.978*pow(1.-viewAngle,5.);
        vec2 distortion=${WORLD_V2?'(vSlope*.5+soft)*.042*(5./(vViewDepth+5.))':'(vSlope+detail)*.018'}*smoothstep(0.,.28,thickness);
        ${WORLD_V2?`
        // Ripples tilt the reflected ray twice as far as the surface, so they smear a reflection into streaks, mostly
        // up and down the screen. The smear grows with distance, where a pixel spans many ripples.
        vec2 reflectShift=(vSlope*.4+soft)*vec2(.07,.19)*(.6+.9*smoothstep(4.,36.,vViewDepth))*smoothstep(0.,.08,thickness);`:''}
        vec2 refractUv=clamp(screen+distortion,vec2(.001),vec2(.999));
        if(viewDepth(refractUv)<vViewDepth)refractUv=screen;
        float depth=min(thickness,4.);
        vec3 transmitted=texture2D(tOpaque,refractUv).rgb;
        vec3 absorption=exp(-${WORLD_V2?'vec3(.78,.44,.32)':'vec3(.54,.31,.22)'}*depth);
        vec3 waterTint=${WORLD_V2?'mix(mix(vec3(.03,.047,.04),vec3(.035,.105,.095),broad),vec3(.029,.075,.095),ocean)':'vec3(.021,.036,.032)'}*(1.-uDarkness*.97);
        vec3 underwater=transmitted*absorption+waterTint*(1.-absorption);
        vec2 reflectUv=clamp(vReflection.xy/vReflection.w+${WORLD_V2?'reflectShift':'distortion*.72'},vec2(.001),vec2(.999));
        vec3 reflection=uSky;
        float localReflection=uReflectionDetail*(1.-smoothstep(.25,1.2,abs(dot(vec4(vWater,1.),uReflectionPlane))));
        if(localReflection>.001){
          vec3 reflected=texture2D(tDiffuse,reflectUv).rgb;
          reflection=mix(uSky,reflectedAtmosphere(reflected,reflectUv,N),localReflection);
        }
        // A broken, moving surface scatters the sky; only near grazing does it approach a reflection.
        vec3 result=mix(underwater,reflection,${WORLD_V2?'min(fresnel*mix(.68,.88,broad),.85)*(1.-.3*chop)':'fresnel'});
        float glint=pow(max(dot(reflect(-uSunDirection,N),normalize(vEye)),0.),180.);
        result+=vec3(.55,.64,.60)*glint*.11*(1.-uDarkness);
        ${WORLD_V2?WATER_FOAM_GLSL:`
        // Tiny foam pockets occur only in the thin band touching submerged gravel.
        float edge=(1.-smoothstep(.02,.15,thickness))*smoothstep(.0,.02,thickness);
        float foam=step(.72,noise(vWater.xz*17.+vec2(0.,uTime*.4)))*edge*.10;
        result=mix(result,vec3(.18,.21,.19)*(1.-uDarkness*.96),foam);
        `}
        gl_FragColor=vec4(result,1.);
      }`
    }
  });
  stream.rotation.x=-Math.PI/2;stream.position.y=waterHeightAt(0);stream.layers.set(1);stream.name='River surface';stream.frustumCulled=false;
  // The reflection pass uses the whole forest (layer0), even though the water is
  // isolated on layer1 so that the opaque depth remains available for refraction.
  const reflectionTarget=stream.getRenderTarget();
  reflectionTarget.depthTexture=new THREE.DepthTexture(reflectionTarget.width,reflectionTarget.height,THREE.UnsignedIntType);
  const material=stream.material as THREE.ShaderMaterial;
  material.uniforms.tReflectionDepth.value=reflectionTarget.depthTexture;
  const reflect=stream.onBeforeRender;
  const reflectionPosition=new THREE.Vector3(),reflectionQuaternion=new THREE.Quaternion(),cameraQuaternion=new THREE.Quaternion(),cameraWorldPosition=new THREE.Vector3();
  const reflectionProjection=new THREE.Matrix4(),reflectionSky=new THREE.Color(),reflectionSun=new THREE.Vector3(),reflectionScatter=new THREE.Color();
  const reflectionPlane=new THREE.Plane(new THREE.Vector3(0,1,0),-waterHeightAt(0));
  let reflectionReady=false,reflectionTime=-Infinity,reflectionDarkness=0,reflectedFlashlight=false;
  const colorChanged=(a:THREE.Color,b:THREE.Color)=>Math.abs(a.r-b.r)+Math.abs(a.g-b.g)+Math.abs(a.b-b.b)>.002;
  // Reflections are deliberately allowed to reuse one texture for a short
  // interval when the camera is still. Waves continue animating in the water
  // shader, while the expensive reflected forest render is not repeated at
  // display refresh rate for a static view.
  const reflectionInterval=.032,reflectionMoveEpsilon=.015,reflectionTurnLimit=Math.cos(.0025*.5);
  const reflectionFar=240;
  stream.onBeforeRender=function(renderer,world,camera,geo,mat,group){
    if(import.meta.env.DEV&&world.userData.profileSkipReflection)return;
    const {uniforms}=material;
    if(uniforms.uReflectionDetail.value<.001){reflectionReady=false;return;}
    cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    // Reflector itself skips a surface that faces away from the camera. Keep
    // the cache invalid in that case, and force the water shader to use its
    // sky fallback rather than displaying a stale reflected frame.
    if(reflectionPlane.distanceToPoint(cameraWorldPosition)<0){reflectionReady=false;uniforms.uReflectionDetail.value=0;return;}
    camera.getWorldQuaternion(cameraQuaternion);
    const time=uniforms.uTime.value as number,darkness=uniforms.uDarkness.value as number;
    const flashlight=!!world.userData.flashlight;
    const cameraChanged=cameraWorldPosition.distanceToSquared(reflectionPosition)>reflectionMoveEpsilon**2||Math.abs(cameraQuaternion.dot(reflectionQuaternion))<reflectionTurnLimit;
    const lightingChanged=Math.abs(darkness-reflectionDarkness)>.002||flashlight!==reflectedFlashlight||colorChanged(uniforms.uSky.value,reflectionSky)||colorChanged(uniforms.uSunScatterColor.value,reflectionScatter)||reflectionSun.distanceToSquared(uniforms.uSunDirection.value)>1e-6;
    if(reflectionReady&&time>=reflectionTime&&time-reflectionTime<reflectionInterval&&!cameraChanged&&!lightingChanged&&!(import.meta.env.DEV&&world.userData.profileForceReflection))return;
    const background=world.background;world.background=world.userData.skyColor ?? background;
    const sourceCamera=camera as THREE.PerspectiveCamera;
    const sourceFar=sourceCamera.far;
    // Fog integration is capped at 180 m. Keep the reflected camera close to
    // that useful range so distant forest batches never enter the reflection
    // pass merely because the main view preserves a mountain horizon.
    if(sourceFar>reflectionFar){sourceCamera.far=reflectionFar;sourceCamera.updateProjectionMatrix();}
    const wasVisible=stream.visible;
    try{reflect.call(this,renderer,world,camera,geo,mat,group);}finally{
      stream.visible=wasVisible;
      if(sourceFar>reflectionFar){sourceCamera.far=sourceFar;sourceCamera.updateProjectionMatrix();}
      world.background=background;
    }
    // Reflector changes its projection for oblique water clipping. Invert the
    // final projection, not the player's unmodified camera matrix.
    uniforms.uReflectionInverseProjection.value.copy(stream.camera.projectionMatrix).invert();
    uniforms.uReflectionCameraWorld.value.copy(stream.camera.matrixWorld);
    reflectionPosition.copy(cameraWorldPosition);reflectionQuaternion.copy(cameraQuaternion);reflectionProjection.copy(camera.projectionMatrix);
    reflectionSky.copy(uniforms.uSky.value);reflectionScatter.copy(uniforms.uSunScatterColor.value);reflectionSun.copy(uniforms.uSunDirection.value);
    reflectionTime=time;reflectionDarkness=darkness;reflectedFlashlight=flashlight;reflectionReady=true;
  };
  scene.add(stream);
  // Broad bodies reuse this material and its one reflection target. Their actual
  // shoreline comes from the same geographic mask and opaque depth as terrain.
  function broadSurface(name:string,kind:number,x0:number,x1:number,z0:number,z1:number,nx:number,nz:number){
    const p:number[]=[],u:number[]=[],k:number[]=[],idx:number[]=[];
    const nearCoast=(t:number)=>{const signed=t*2-1,q=Math.abs(signed);return Math.sign(signed)*(q<.8?q/.8*850:850+3150*((q-.8)/.2)**2);};
    for(let j=0;j<=nz;j++)for(let i=0;i<=nx;i++){
      let x=THREE.MathUtils.lerp(x0,x1,i/nx),z=THREE.MathUtils.lerp(z0,z1,j/nz);
      if(kind===3){
        // Spend the same vertex budget on the walkable coastline; the distant
        // horizon needs very few vertices. Shore masks are still per fragment.
        x=nearCoast(i/nx);z=nearCoast(j/nz);
      }
      p.push(x,-z,0);u.push(x,z);k.push(kind);
    }
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++){const a=j*(nx+1)+i,b=a+nx+1;idx.push(a,b,a+1,a+1,b,b+1);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(u,2));g.setAttribute('aRibbon',new THREE.Float32BufferAttribute(k,1));g.setIndex(idx);
    const mesh=new THREE.Mesh(g,material);mesh.rotation.x=-Math.PI/2;mesh.layers.set(1);mesh.frustumCulled=false;mesh.name=name;
    mesh.onBeforeRender=(renderer,world,camera,_geo,_mat,group)=>stream.onBeforeRender(renderer,world,camera,geometry,material,group);
    scene.add(mesh);return mesh;
  }
  const lake=WORLD_V2?broadSurface('Lake — connected alpine watershed',2,LAKE_CENTER.x-LAKE_RADII.x*1.4,LAKE_CENTER.x+LAKE_RADII.x*1.4,LAKE_CENTER.z-LAKE_RADII.z*1.4,LAKE_CENTER.z+LAKE_RADII.z*1.4,52,72):null;
  const sea=WORLD_V2?broadSurface('Open sea — coastal horizon',3,-4000,4000,-4000,4000,80,100):null;
  const lakeBounds=new THREE.Box3(new THREE.Vector3(LAKE_CENTER.x-LAKE_RADII.x*1.4,LAKE_LEVEL-.2,LAKE_CENTER.z-LAKE_RADII.z*1.4),new THREE.Vector3(LAKE_CENTER.x+LAKE_RADII.x*1.4,LAKE_LEVEL+.2,LAKE_CENTER.z+LAKE_RADII.z*1.4));
  const seaBounds=new THREE.Box3(new THREE.Vector3(-4000,SEA_LEVEL-.3,-4000),new THREE.Vector3(4000,SEA_LEVEL+.3,4000));
  let lakeNearby=false,seaNearby=false;
  const frustum=new THREE.Frustum(),viewProjection=new THREE.Matrix4();
  const bounds:THREE.Box3[]=[];
  for(let z=-RIVER_EXTENT;z<RIVER_EXTENT;z+=20){
    const xs=[riverX(z),riverX(z+10),riverX(z+20)];
    if(WORLD_V2)for(const b of BRANCHES)if(z+20>=b.z0&&z<=b.z1)xs.push(branchX(b,Math.max(b.z0,z)),branchX(b,Math.min(b.z1,z+10)),branchX(b,Math.min(b.z1,z+20)));
    bounds.push(new THREE.Box3(new THREE.Vector3(Math.min(...xs)-(WORLD_V2?12:8),waterHeightAt(z)-.05,z-(WORLD_V2?6:0)),new THREE.Vector3(Math.max(...xs)+(WORLD_V2?12:8),waterHeightAt(z+20)+.05,z+20+(WORLD_V2?6:0))));
  }
  let nearby=true,rippleCursor=0,lastRipple=0,disposed=false,foamGain=0;
  const ripples=material.uniforms.uRipple.value as THREE.Vector4[];
  const ring=(x:number,z:number,strength:number)=>{ripples[rippleCursor].set(x,z,0,strength);rippleCursor=(rippleCursor+1)%RIPPLES;};
  // The baked tiles load in the background. Until each arrives its stand-in is bound, and the foam fades in once the real one is.
  const loadedTextures:THREE.Texture[]=[];
  if(WORLD_V2){
    const loader=new THREE.TextureLoader();
    const bake=(url:string,uniform:'tWaterNormal'|'tWaterFoam')=>loader.load(url,texture=>{
      if(disposed){texture.dispose();return;}
      configureWaterTexture(texture,Math.min(16,scene.userData.maxAnisotropy??16,scene.userData.graphicsAnisotropy??16));loadedTextures.push(texture);
      (material.uniforms[uniform].value as THREE.Texture|null)?.dispose();material.uniforms[uniform].value=texture;
      if(uniform==='tWaterFoam')foamGain=Math.max(foamGain,.001);
    },undefined,()=>{/* keep the stand-in */});
    bake(WATER_NORMAL_URL,'tWaterNormal');bake(WATER_FOAM_URL,'tWaterFoam');
    // Droplets coming back down ring the surface through this, so the spray module needs no reference to the river.
    scene.userData.waterRing=ring;
  }
  return {
    /** Rings spread from where the water was broken. */
    splash(x:number,z:number,strength:number){ring(x,z,strength);},
    setQuality(scale:number,requested=768,detail=2){const size=Math.min(requested,scale<.6?256:scale<.85?512:768);const target=stream.getRenderTarget();if(target.width!==size){target.setSize(size,size);reflectionReady=false;}material.uniforms.uReflectionSteps.value=scale<.6?4:scale<.85?5:6;if(WORLD_V2){material.uniforms.uDetail.value=Math.min(detail,scale<.6?0:scale<.85?1:2);const af=Math.min(16,scene.userData.maxAnisotropy??16,scene.userData.graphicsAnisotropy??16);for(const key of ['tWaterNormal','tWaterFoam']){const texture=material.uniforms[key].value as THREE.Texture;if(texture.anisotropy!==af){texture.anisotropy=af;texture.needsUpdate=true;}}}},
    bind(color:THREE.Texture,depth:THREE.DepthTexture,resolution:THREE.Vector2,projection:THREE.Matrix4){
      material.uniforms.tOpaque.value=color;material.uniforms.tOpaqueDepth.value=depth;
      material.uniforms.uResolution.value=resolution;material.uniforms.uInverseProjection.value=projection;
    },
    update(time:number,player:THREE.Vector3,darkness:number){
      const lakeNear=WORLD_V2?Math.max(0,lakeDistance(player.x,player.z)):Infinity,seaNear=WORLD_V2?Math.max(0,coastDistance(player.x,player.z)):Infinity;
      // Reflect the dominant local body; distant water transitions to fog/sky.
      const nearLake=lakeNear<55,nearSea=seaNear<85;
      const grade=nearSea||nearLake?0:waterGradeAt(player.z),intercept=nearSea?SEA_LEVEL:nearLake?LAKE_LEVEL:waterHeightAt(player.z)-grade*player.z;
      stream.rotation.x=-Math.PI/2-Math.atan(grade);stream.position.y=intercept;stream.updateMatrixWorld(true);
      material.uniforms.uWorldToSurface.value.copy(stream.matrixWorld).invert();
      reflectionPlane.normal.set(0,1,-grade).normalize();reflectionPlane.constant=-intercept/Math.sqrt(1+grade*grade);
      material.uniforms.uReflectionPlane.value.set(reflectionPlane.normal.x,reflectionPlane.normal.y,reflectionPlane.normal.z,reflectionPlane.constant);
      material.uniforms.uTime.value=time;material.uniforms.uDarkness.value=darkness;
      if(WORLD_V2&&foamGain>0)material.uniforms.uFoamGain.value=foamGain=Math.min(1,foamGain+Math.min(.1,Math.max(0,time-lastRipple))/1.4);
      for(const r of ripples){r.z+=Math.max(0,time-lastRipple);if(r.z>2.4)r.w=0;}lastRipple=time;
      if(scene.userData.fogColor)material.uniforms.uSky.value.copy(scene.userData.fogColor);
      if(scene.userData.sunScatterColor)material.uniforms.uSunScatterColor.value.copy(scene.userData.sunScatterColor);
      if(scene.userData.sunDirection)material.uniforms.uSunDirection.value.copy(scene.userData.sunDirection);
      const distance=WORLD_V2?channelOffset(player.x,player.z):Math.abs(player.x-riverX(player.z));
      nearby=distance<110&&Math.abs(player.z)<RIVER_EXTENT+110;lakeNearby=lakeNear<450;seaNearby=seaNear<1000;material.uniforms.uReflectionDetail.value=1-THREE.MathUtils.smoothstep(Math.min(distance,lakeNear,seaNear),23,55);
      // Keep a long continuous stream without submitting its entire kilometre
      // to either rasterisation or the reflection pass on every frame.
      const first=Math.min(rows,Math.max(0,Math.floor((player.z-135+RIVER_EXTENT)/rowStep)));
      const last=Math.max(0,Math.min(rows,Math.ceil((player.z+135+RIVER_EXTENT)/rowStep)));
      geometry.setDrawRange(rowIndexStart[first],Math.max(0,rowIndexStart[last]-rowIndexStart[first]));
    },
    prepare(camera:THREE.PerspectiveCamera){
      camera.updateMatrixWorld();
      if(reflectionReady&&!reflectionProjection.equals(camera.projectionMatrix))reflectionReady=false;
      viewProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);frustum.setFromProjectionMatrix(viewProjection);
      stream.visible=nearby&&bounds.some(box=>frustum.intersectsBox(box)&&Math.abs((box.min.z+box.max.z)*.5-camera.position.z)<115);
      if(lake)lake.visible=lakeNearby&&frustum.intersectsBox(lakeBounds);
      if(sea)sea.visible=seaNearby&&frustum.intersectsBox(seaBounds);
    },
    get visible(){return stream.visible||!!lake?.visible||!!sea?.visible;},
    get reflectionPlane(){return reflectionPlane;},
    dispose(){
      disposed=true;scene.remove(stream);stream.dispose();geometry.dispose();
      for(const body of [lake,sea])if(body){scene.remove(body);body.geometry.dispose();}
      if(WORLD_V2){waterNormal?.dispose();waterFoam?.dispose();for(const t of loadedTextures)t.dispose();if(scene.userData.waterRing===ring)delete scene.userData.waterRing;}
    }
  };
}
