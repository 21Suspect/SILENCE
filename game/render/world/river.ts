import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RIVER_EXTENT, waterHeightAt, waterGradeAt, riverProfileGLSL, riverCourseGLSL, channelOffset } from '../../sim/world/world';
import { BRANCHES, BRANCH_NARROW, branchX } from '../../sim/world/world-noise';
import { SUN_ILLUMINANCE } from './sky-model';
import { LIGHT_TUNING } from '../../core/light-tuning';
import { WORLD_V2 } from '../../sim/world/world-flags';
import { LAKE_CENTER, LAKE_RADII, LAKE_LEVEL, SEA_LEVEL, lakeDistance, coastDistance, coastalGLSL, lakeOutlineGLSL } from '../../sim/world/coastal-geography';

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
  mat2 waterSpin(float n){float a=fract(sin(n*91.7+.3)*4375.85)*6.2832,c=cos(a),s=sin(a);return mat2(c,s,-s,c);}
  // Two copies of a tile, each carried down the channel by the current and faded in and out half a period apart,
  // so that a copy is invisible at the moment it restarts. Normals blend so the amplitude holds at the cross-over.
  // Anti-tiling: each restart puts its copy at a new random offset (and, in world space, a new random turn), and ph shifts
  // the moment of restart from place to place (a smooth noise, metres to tens of metres across). The line where the restart
  // count changes is drawn only by the copy whose weight is zero there, so no seam shows, and at any moment every patch of
  // water shows the tile at its own offset and angle: no repeat lines up across a lake.
  vec2 flowSlope(vec2 ch,float speed,float scale,float stretch,float period,float seed,mat2 rot,float ph){
    float c=uTime/period+seed*.318+ph,pA=fract(c),pB=fract(c+.5),wA=smoothstep(.1,.9,1.-abs(1.-2.*pA)),wB=1.-wA;
    vec2 a=vec2(ch.x,ch.y+speed*pA*period)+waterJump(floor(c)+seed),b=vec2(ch.x,ch.y+speed*pB*period)+waterJump(floor(c+.5)+seed+.37);
    a.y*=stretch;b.y*=stretch;
    vec2 sA=texture2D(tWaterNormal,rot*a*scale).xy*2.-1.,sB=texture2D(tWaterNormal,rot*b*scale).xy*2.-1.;
    vec2 s=(sA*wA+sB*wB)*inversesqrt(wA*wA+wB*wB);
    s=s*rot;s.y*=stretch;return s;
  }
  vec3 flowFoam(vec2 ch,float speed,float scale,float stretch,float period,float seed,float ph){
    float c=uTime/period+seed*.318+ph,pA=fract(c),pB=fract(c+.5),wA=smoothstep(.1,.9,1.-abs(1.-2.*pA)),wB=1.-wA;
    vec2 a=vec2(ch.x,ch.y+speed*pA*period)+waterJump(floor(c)+seed),b=vec2(ch.x,ch.y+speed*pB*period)+waterJump(floor(c+.5)+seed+.37);
    a.y*=stretch;b.y*=stretch;
    return texture2D(tWaterFoam,a*scale).rgb*wA+texture2D(tWaterFoam,b*scale).rgb*wB;
  }
  // The same two crossfaded copies in world space, each carried along a velocity (a flow map): a feature at q is at q + vel*t.
  vec2 flowSlopeW(vec2 p,vec2 vel,float scale,float period,float seed,mat2 rot,float ph){
    float c=uTime/period+seed*.318+ph,pA=fract(c),pB=fract(c+.5),wA=smoothstep(.1,.9,1.-abs(1.-2.*pA)),wB=1.-wA;
    float nA=floor(c)+seed,nB=floor(c+.5)+seed+.37;mat2 rA=rot*waterSpin(nA),rB=rot*waterSpin(nB);
    vec2 a=p-vel*(pA*period)+waterJump(nA),b=p-vel*(pB*period)+waterJump(nB);
    vec2 sA=(texture2D(tWaterNormal,rA*a*scale).xy*2.-1.)*rA,sB=(texture2D(tWaterNormal,rB*b*scale).xy*2.-1.)*rB;
    return (sA*wA+sB*wB)*inversesqrt(wA*wA+wB*wB);
  }
  vec3 flowFoamW(vec2 p,vec2 vel,float scale,float period,float seed,float ph){
    float c=uTime/period+seed*.318+ph,pA=fract(c),pB=fract(c+.5),wA=smoothstep(.1,.9,1.-abs(1.-2.*pA)),wB=1.-wA;
    float nA=floor(c)+seed,nB=floor(c+.5)+seed+.37;
    vec2 a=p-vel*(pA*period)+waterJump(nA),b=p-vel*(pB*period)+waterJump(nB);
    return texture2D(tWaterFoam,waterSpin(nA)*a*scale).rgb*wA+texture2D(tWaterFoam,waterSpin(nB)*b*scale).rgb*wB;
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

// The ripple layers, turned into world-space slopes (bulk in .xy, the finest wrinkles in .zw), in either of two frames:
// channel space (ch: metres across, metres along; the pattern stretched along the current and carried down it), or world space
// with a velocity (a flow map: the pattern carried along vel, unstretched), which is what a lake, the sea and every junction use.
// The periods are short because the current is fast: the pattern slides at most a period's worth before it is crossfaded, and
// across a 1.5 m/s stream whose banks run at half that speed, 1.8 s of drift shears a 4 m wide band by 1.4 m (37%), not more.
const WATER_LAYERS_GLSL=`
  vec4 flowLayers(vec2 ch,float speed,vec2 acrossDir,vec2 alongDir,float farFade,float midFade,float nearFade,float ph){
    vec2 bulk=flowSlope(ch,speed,.17,.6,1.8,0.,mat2(1.,0.,0.,1.),ph)*(.3*farFade),fine=vec2(0.);
    if(uDetail>.5)bulk+=flowSlope(ch,speed*.96,.52,.6,1.4,1.,mat2(.857,.515,-.515,.857),ph*1.37)*(.24*midFade);
    if(uDetail>1.5)fine=flowSlope(ch,speed*1.05,1.6,.6,1.05,2.,mat2(.921,-.391,.391,.921),ph*.71)*(.17*nearFade);
    return vec4(-(acrossDir*bulk.x+alongDir*bulk.y),-(acrossDir*fine.x+alongDir*fine.y));
  }
  // Open water adds a long layer (an 18 m tile, between the others in no whole ratio), which carries the reflection's broad
  // undulation across a lake; the three short ones alone repeated every 5.9 m in a grid that showed at grazing angles.
  vec4 flowLayersW(vec2 p,vec2 vel,float farFade,float midFade,float nearFade,float ph,float large){
    vec2 bulk=flowSlopeW(p,vel,.17,1.8,0.,mat2(1.,0.,0.,1.),ph)*(.3*farFade),fine=vec2(0.);
    if(large>.001)bulk+=flowSlopeW(p,vel*.9,.055,2.7,4.,mat2(.6,.8,-.8,.6),ph*.53)*(.3*large);
    if(uDetail>.5)bulk+=flowSlopeW(p,vel*.96,.52,1.4,1.,mat2(.857,.515,-.515,.857),ph*1.37)*(.24*midFade);
    if(uDetail>1.5)fine=flowSlopeW(p,vel*1.05,1.6,1.05,2.,mat2(.921,-.391,.391,.921),ph*.71)*(.17*nearFade);
    return vec4(-bulk,-fine);
  }`;

/**
 * The rebuilt world's water, one shader for the river, its side channels, the lake and the sea. Every quantity that differs
 * between them (speed and direction of the current, roughness, colour, foam, swell) is a continuous function of position, so
 * where two surfaces meet (a river mouth, a side channel rejoining the stream) both draw the same thing on the line between
 * them and nothing marks it.
 */
const waterV2Main=(branchCount:number)=>`
      void main(){
        ${WATER_FRAME_GLSL}
        vec2 screen=gl_FragCoord.xy/uResolution,p=vWater.xz;
        float lakeEdge=lakeOutline(p),coastEdge=coastDistance(p);
        // Which way is inland, from how the coast's distance changes between neighbouring pixels (it is smooth, so a 2x2 quad's
        // difference is its gradient; two more evaluations of the coast cost the sea 1 ms a frame). Taken before any discard.
        vec2 dpx=dFdx(p),dpy=dFdy(p);float dcx=dFdx(coastEdge),dcy=dFdy(coastEdge),dpd=dpx.x*dpy.y-dpx.y*dpy.x;
        vec2 inland=abs(dpd)>1e-9?vec2(dcx*dpy.y-dpx.y*dcy,dpx.x*dcy-dcx*dpy.x)/dpd:vec2(0.,1.);
        float thickness=max(0.,viewDepth(screen)-vViewDepth);
        // Metres of water under the surface to the ground seen through this pixel (across the surface, which tilts down a
        // stream's steps: measured straight down, water above the eye on a cascade had no depth and vanished), and along the
        // view ray. Points on one ray scale with view depth, so the ground lies thickness/vViewDepth of vEye further on.
        float through=thickness/max(vViewDepth,.001),below=max(dot(vEye,normalize(vec3(-vSlope.x,1.,-vSlope.y))),0.)*through,path=length(vEye)*through;
        // Metres across the bed to the waterline: the depth over how fast it grows from pixel to pixel. A flat sandy shallow
        // and a steep bank then get the same narrow fringe of froth, where a band of depth alone covered the whole flat.
        float bedSlope=max((abs(dFdx(below))+abs(dFdy(below)))/max(length(dpx)+length(dpy),1e-4),.04),shoreDist=below/bedSlope;
        // Surface intersection is determined by the real depth-buffer shoreline.
        if(thickness<.001)discard;
        float river=step(vRibbon,1.5),isLake=step(1.5,vRibbon)*(1.-step(2.5,vRibbon)),isSea=step(2.5,vRibbon);
        // Who draws which pixel. The river owns its channel (the mouth-rounded channel mask) down to the shoreline; the lake and
        // the sea own everything past it, and a little beyond their outlines outside the channel, so a bank that dips under
        // their level is still covered. A pixel goes to exactly one surface: they never double-draw or z-fight.
        float inChannel=0.;
        if(river>.5||isLake>.5&&lakeEdge>0.||isSea>.5&&coastEdge>3.)inChannel=step(mouthRound(streamOffset(p),p),3.5)*step(abs(p.y),${(RIVER_EXTENT-52).toFixed(1)});
        // Where two surfaces meet each reaches 0.6 m past the line and the depth test settles the band between them: on the line
        // both draw the same colour, so whichever is nearer by a hair shows the same thing, and no pixel is left to neither.
        if(river>.5&&(lakeEdge<-.6||coastEdge<2.4||inChannel<.5))discard;
        if(isLake>.5&&(coastEdge<0.||lakeEdge>0.&&(inChannel>.5||lakeEdge>4.)))discard;
        if(isSea>.5&&coastEdge>3.&&(inChannel>.5||coastEdge>12.))discard;
        // Near its mouth the river becomes the water it runs into: 1 at the shoreline, fading out 50 m upstream.
        float mouthSea=river*(1.-smoothstep(3.,50.,coastEdge)),mouthLake=river*(1.-smoothstep(0.,50.,lakeEdge)),mouth=max(mouthSea,mouthLake);
        float broad=max(1.-river,mouth),ocean=max(isSea,mouthSea),seaShare=ocean/max(broad,.001);
        // The current. Speed follows the bed's grade (Manning: v grows as the square root of the slope), from 0.45 m/s in the
        // level reaches by the lake to 1.4 m/s at a 1% grade, 2.1 m/s at 3% and 3 m/s down the cascades, fastest mid-stream and
        // at about half that by the banks. It runs down the channel's own line, worked out here from the course itself, so a side
        // channel and the stream it rejoins agree on it where they meet.
        float vMid=0.,prof=0.,side=0.,cascade=0.;vec2 vel=vec2(0.);
        if(river>.5){
          float sM=(streamCentre(p.y+.6)-streamCentre(p.y-.6))/1.2,dM=abs(p.x-streamCentre(p.y))/sqrt(1.+sM*sM);
          float dB=1e4,rawB=1e4,sB=0.;
          ${branchCount?'branchDistance(p,dB,rawB,sB);':''}
          // A side channel and the stream share their level; the pixel goes to whichever line is nearer (the side channel's
          // distance counted as the ground counts it, BRANCH_NARROW times longer).
          if(vRibbon<.5&&dB<dM-.3)discard;
          if(vRibbon>.5&&dB>dM+.3)discard;
          float grade=abs(streamGrade(p.y));
          vMid=clamp(.45+9.*sqrt(grade),.45,3.);
          // Down the steps of the cascades (grades of 0.15 and more) the stream is white water from bank to bank.
          cascade=smoothstep(.12,.4,grade);
          prof=1.-smoothstep(.4,4.6,dM);
          vel=-normalize(vec2(sM,1.))*vMid*mix(.5,1.,prof);
          if(dB<1e3){
            float wB=smoothstep(-2.,2.,dM-dB),profB=1.-smoothstep(.3,3.,rawB);
            vel=mix(vel,-normalize(vec2(sB,1.))*vMid*.85*mix(.5,1.,profB),wB);prof=mix(prof,profB,wB);
            side=1.-smoothstep(.4,2.4,abs(dM-dB));
          }
        }
        // The lake drifts slowly in the wind; the sea's surface is carried onshore, up the slope of the coast's distance field.
        vec2 onshore=length(inland)>1e-4?normalize(inland):vec2(0.,1.);
        vec2 broadVel=mix(vec2(.07,-.1),onshore*.38,seaShare);
        // A low wave runs in to the beach and on up a river's mouth, dying away inland (it tilts the normal only: see the vertices).
        float shoreWave=-coastEdge;
        vec2 shoreSlope=ocean>.001?-.042*cos(shoreWave*.65+uTime*1.15)*exp(-abs(shoreWave)*.08)*onshore*ocean:vec2(0.);
        // The open sea's swell, also as a slope per pixel: the sea's mesh is 26 m a cell along the coast, too coarse for a 40 m
        // swell, which displaced there stood as facets and stood off the river's surface where the two met.
        if(ocean>.001){
          float swell=p.x*.13+p.y*.085+uTime*.72,secondary=p.x*.047-p.y*.11+uTime*.48,swellFade=smoothstep(-4.,28.,shoreWave)*ocean;
          shoreSlope+=vec2(.13*cos(swell)*.22+.047*cos(secondary)*.10,.085*cos(swell)*.22-.11*cos(secondary)*.10)*swellFade;
        }
        float chSpeed=length(vel);
        vel=mix(vel,broadVel,broad);
        // The river's interior keeps its streaks stretched along the current (channel space); mouths and junctions are drawn
        // in world space, the same on both sides of the line, and blended into the channel's pattern away from it.
        float worldShare=river>.5?max(mouth,side):1.;
        float mid=prof*(1.-broad);
        float nearFade=1.-smoothstep(9.,34.,vViewDepth),midFade=1.-smoothstep(26.,80.,vViewDepth),farFade=1.-smoothstep(50.,150.,vViewDepth);
        vec4 layers=vec4(0.);vec3 fm=vec3(0.);float riff=0.;
        if(worldShare<.999){
          // Restart moments vary along the stream and across it, slowly enough that the current's drift does not shear the pattern.
          float phC=noise(vChannel*vec2(.09,.021)+7.)*1.1;
          layers=flowLayers(vChannel,chSpeed,acrossDir,alongDir,farFade,midFade,nearFade,phC);
          // Foam is carried by the current too, a little slower than the middle of the stream.
          fm=flowFoam(vChannel,chSpeed*.8,.5,.3,2.4,3.,phC);
          // Riffles stand where the bed lifts: fixed in place while the water runs through them.
          riff=texture2D(tWaterFoam,vec2(vChannel.x*.085+.37,vChannel.y*.047)).b;
        }
        if(worldShare>.001){
          // Two independent patterns summed lose amplitude where they cross; dividing by the weights' length keeps it.
          // Restart moments vary over patches 10 to 80 m across.
          float phW=noise(p*.07)*1.6+noise(p*.0131+19.)*1.2;
          vec4 w=flowLayersW(p,vel,farFade,midFade,nearFade,phW,broad*(1.-smoothstep(120.,320.,vViewDepth)));float k=worldShare;
          layers=(layers*(1.-k)+w*k)*inversesqrt((1.-k)*(1.-k)+k*k);
          fm=mix(fm,flowFoamW(p,vel*.8,.5,2.4,3.,phW),k);
          riff=mix(riff,texture2D(tWaterFoam,p*vec2(.085,.047)+.37).b,k);
        }
        // White water: riffles where the bed lifts in a running stream, and over the steep steps of the cascades.
        float running=smoothstep(.5,1.3,vMid);
        float riffle=smoothstep(.5,.84,riff)*(.4+.6*mid)*(1.-broad)*running;
        riffle=max(riffle,smoothstep(.06,.5,abs(vSlope.y))*(1.-broad));
        // A fast stream's surface is broken all over, not only in its riffles: half as rough again down a running middle.
        // Wind lies on open water in patches: glassy calms where the shore reflects whole, and darker rough cat's-paws, drifting
        // with the gusts, tens of metres across. They break up whatever pattern remains and give a wide lake its scale.
        float wind=1.;
        // How much wind there is today (uWind, river.ts update): glassy in still air, broken in a breeze; the sea keeps a swell.
        if(broad>.001){float gust=noise(p*.017+uTime*vec2(.021,.009))*.62+noise(p*.047-uTime*vec2(.012,.03))*.38;wind=mix(1.,mix(.28,1.45,smoothstep(.28,.72,gust))*mix(uWind,max(uWind,.9),ocean),broad);}
        float rough=(.55+.8*riffle+.55*mid*running+.30*ocean)*wind*mix(.4,1.,smoothstep(0.,.08,below));
        vec2 bulk=layers.xy*rough,fine=layers.zw*rough;
        vec2 detail=bulk+fine,soft=bulk+fine*.3;
        float clumpF=smoothstep(.2,.75,fm.b),pat=max(smoothstep(.2,.9,fm.r)*(.5+.5*clumpF)*.85,fm.g*.9);
        // Rings spread from where the water was broken and are carried downstream.
        float ringFoam=0.,chop=clamp(length(detail)*6.,0.,1.);
        for(int i=0;i<${RIPPLES};i++){
          vec4 r=uRipple[i];if(r.w<=0.)continue;
          // A footfall is a full ring; the few drops that land after it ring a few centimetres wide, and fade with distance.
          float sc=mix(.18,1.,smoothstep(.1,.7,r.w)),age=r.z;
          vec2 d=p-(r.xy+vel*age);
          float l=length(d)+.001,front=(.05+.46*pow(age,.6))*sc,reach=(.03+.045*age)*sc,k=6.283/(.045*sc);
          float env=exp(-pow((l-front)/reach,2.))*exp(-age*(1.5+2.*(1.-sc)))*r.w*(1.-(1.-sc)*smoothstep(5.,18.,vViewDepth));
          vec2 ringSlope=d/l*cos((l-front)*k)*env*.55;detail+=ringSlope;soft+=ringSlope*.7;
          ringFoam+=(exp(-age*4.)*(1.-smoothstep(0.,.1+.22*age,l/sc))*.9+env*.3)*sc;
        }
        detail-=shoreSlope;
        vec3 N=normalize(vec3(-vSlope.x+detail.x,1.,-vSlope.y+detail.y));
        float viewAngle=max(dot(normalize(vEye),N),0.);
        float fresnel=.02+.98*pow(1.-viewAngle,5.);
        // The bed's image is bent less where the water is only a film over it.
        vec2 distortion=(vSlope*.5+soft)*.042*(1.+.8*mid*running)*(5./(vViewDepth+5.))*smoothstep(0.,.12,below);
        // Ripples tilt the reflected ray twice as far as the surface. That bends the image by an angle, the same at any distance
        // (only the ripples shrink on screen), and seen at a low angle mostly up and down. It was three times this and grew with
        // distance, and tore the mountains in the lake into noisy shards; real water wobbles a reflection and draws it out
        // downwards. A lake lies calmer than a stream or the sea, so the shore stands nearly whole in it where the wind drops.
        vec2 reflectShift=(vSlope*.4+soft)*vec2(.026,.06)*smoothstep(0.,.03,below)*mix(1.,.6,broad*(1.-ocean));
        // How far the image is drawn out downward: by the ripples' slope (each takes a band of the reflected world, not a point).
        float streak=min(length(soft)*.12,.03)*smoothstep(0.,.03,below);
        vec2 refractUv=clamp(screen+distortion,vec2(.001),vec2(.999));
        if(viewDepth(refractUv)<vViewDepth)refractUv=screen;
        vec3 transmitted=texture2D(tOpaque,refractUv).rgb;
        // Light from the bed: clear mountain water takes red first and keeps green and blue almost alike, so the bed shows through
        // a cool, clean teal (a metre keeps .76/.92/.91 of it in the stream, .74/.91/.90 in the lake) that deepens to the water's
        // own dark blue-green past several metres. Taking blue faster than green (.26/.48 a metre, tried first) turned it olive
        // and murky; the old .78/.44/.32 kept blue longest, and over pale sand that is a tropical lagoon. Absorbed along the view
        // ray and on the light's way down to the bed.
        vec3 absorb=mix(vec3(.28,.085,.095),mix(vec3(.3,.09,.1),vec3(.34,.08,.08),seaShare),broad);
        vec3 absorption=exp(-absorb*min(path+below,24.));
        // Is the sun on the water here? The water knows nothing of the trees' shadows, but the bed under it does: taken as ground
        // of albedo 0.3, the light the bed shows, less the sky's, over the sun's, is how much of the sun gets through. Over deep
        // water, where the bed is lost, a stream is taken as mostly shaded and open water as sunlit. It lights the water's own
        // colour, its foam and its glints, which by the sun's full light glowed in the shade of the wood.
        const vec3 LUM=vec3(.2126,.7152,.0722);
        vec3 sunAt=uSunLight*(max(uSunDirection.y,0.)/3.14159);
        float absL=dot(absorption,LUM),sunVis=clamp((dot(transmitted,LUM)/max(absL,.05)/.3-dot(uSky,LUM))/max(dot(sunAt,LUM),1e-5),0.,1.);
        sunVis=mix(mix(.4,1.,broad),smoothstep(.2,.8,sunVis),smoothstep(.15,.4,absL));
        vec3 light=uSky+sunAt*sunVis;
        vec3 albedo=mix(RIVER_ALBEDO,mix(LAKE_ALBEDO,SEA_ALBEDO,seaShare),broad);
        vec3 underwater=transmitted*absorption+albedo*light*(1.-absorption);
        vec2 reflectUv=clamp(vReflection.xy/vReflection.w+reflectShift,vec2(.001),vec2(.999));
        // Where there is no reflected image (far water) the sky stands in: the haze's colour low down, and a cooler, deeper sky
        // the higher the reflected ray climbs, so ripples still show as they tilt it.
        float rise=reflect(-normalize(vEye),N).y;
        vec3 skyBack=mix(uSky,uSky*vec3(.6,.74,.95),smoothstep(.06,.6,rise));
        vec3 reflection=skyBack;
        float localReflection=uReflectionDetail*(1.-smoothstep(.25,1.2,abs(dot(vec4(vWater,1.),uReflectionPlane))));
        if(localReflection>.001){
          // Five reads down a short vertical band, weighted to the middle: soft streaks, not a mirror, where the water ripples.
          vec3 reflected=texture2D(tDiffuse,reflectUv).rgb*.32;
          reflected+=texture2D(tDiffuse,clamp(reflectUv+vec2(0.,streak*.5),vec2(.001),vec2(.999))).rgb*.22;
          reflected+=texture2D(tDiffuse,clamp(reflectUv-vec2(0.,streak*.5),vec2(.001),vec2(.999))).rgb*.22;
          reflected+=texture2D(tDiffuse,clamp(reflectUv+vec2(0.,streak),vec2(.001),vec2(.999))).rgb*.12;
          reflected+=texture2D(tDiffuse,clamp(reflectUv-vec2(0.,streak),vec2(.001),vec2(.999))).rgb*.12;
          reflection=mix(skyBack,reflectedAtmosphere(reflected,reflectUv,N),localReflection);
        }
        // A broken, moving surface scatters the sky; only near grazing does it approach a reflection.
        // A lake at a grazing angle is mostly its reflection (Fresnel), the sky and the far shore in it; chop takes some of it.
        vec3 result=mix(underwater,reflection,min(fresnel*mix(.75,1.,broad),.96)*(1.-.22*chop));
        float glint=pow(max(dot(reflect(-uSunDirection,N),normalize(vEye)),0.),180.);
        result+=uSunLight*glint*.04*sunVis;
        // Where the water thins to nothing over the ground it fades into the ground itself, over the last few centimetres of
        // depth (on a 1:3 bank about 15 cm, on the beach about a metre), so the shoreline is never the pixel staircase where a
        // flat plane cuts the terrain's triangles.
        result=mix(texture2D(tOpaque,screen).rgb,result,smoothstep(0.,.045,below));
        // Foam gathers where the water is thinnest (banks, stones), in the riffles, and where something has just broken the surface.
        float shore=(1.-smoothstep(.1,.7,shoreDist))*(1.-smoothstep(.01,.06,below));
        // Scum in pockets along the bank, broken by long gaps: never a drawn line.
        float edgeFoam=shore*smoothstep(.34,.82,pat*(.12+1.2*clumpF))*(.3+.4*smoothstep(0.,.02,below));
        // The water's edge laps: a faint, broken rim of froth that creeps up the bank and back, strongest where the sea's swash
        // runs up a beach. Thin and bright it read as a dashed line drawn along every shore; soft and faint it is only wet froth.
        float lapAt=.15+.35*(.5+.5*sin(uTime*(.9+.6*ocean)+dot(p,vec2(.23,.17))));
        float lap=(1.-smoothstep(lapAt*.15,lapAt,shoreDist))*smoothstep(.002,.012,below)*smoothstep(.45,.9,noise(p*.6+vec2(uTime*.06,uTime*-.04))*.6+pat*.5)*mix(.35,1.,ocean);
        // Thin broken swash bands advance and retreat across the sloping beach; breakers run in, and on into a river's mouth.
        float shoreMetres=-coastEdge,surf=smoothstep(-18.,-3.,shoreMetres);
        float wavePhase=shoreMetres*.72+uTime*1.15+.5*sin(p.x*.047+p.y*.033);
        float breaker=pow(.5+.5*sin(wavePhase),9.)*(1.-smoothstep(5.,22.,shoreMetres))*surf;
        float swash=((1.-smoothstep(0.,3.5,abs(shoreMetres-2.4-1.8*sin(uTime*.55+p.x*.035))))+breaker)*ocean;
        // The swell's foam lines run along the shore as long, soft, uneven streaks: a slow noise along them breaks them up, and the
        // foam texture only roughens them, so they never read as rows of dashes.
        float swashBreak=.15+.85*smoothstep(.3,.7,noise(vec2(shoreMetres*.04,dot(p,vec2(.8,.6))*.045)+uTime*.012));
        edgeFoam+=swash*swashBreak*(.7+.3*smoothstep(.15,.7,pat))*.8;
        float riffleFoam=riffle*smoothstep(.45,.95,pat*(.3+.9*clumpF))*.6*smoothstep(.02,.1,below);
        // Flecks and threads of froth ride down the fast middle of a running stream, carried at its speed.
        riffleFoam+=mid*smoothstep(.9,2.,vMid)*smoothstep(.62,.95,pat)*.32*smoothstep(.05,.2,below);
        // Aerated water tumbling down a step: a sheet of froth, streaked and torn by the current, thinning only at its edges.
        // A smooth sheet of it read as snow: torn into streaks and clots by the foam's own pattern, with clear water between.
        riffleFoam=max(riffleFoam,cascade*smoothstep(.22,.7,pat*(.6+.6*clumpF))*(.6+.4*prof)*smoothstep(.02,.1,below));
        float white=clamp((edgeFoam*.55+lap*.22+riffleFoam+ringFoam*(.4+.6*pat))*uFoamGain,0.,1.)*(1.-.5*smoothstep(15.,60.,vViewDepth));
        // Foam is a white, rough surface lit like the ground: by the sky, and by the sun where it is open.
        vec3 foamCol=vec3(.62,.66,.65)*(.55+.45*pat)*light;
        result=mix(result,foamCol,white*.7);
        gl_FragColor=vec4(result,1.);
      }`;

// Distance from the nearest side channel in reach at this z (d counted as the ground counts it, raw in metres) and its slope dx/dz.
const branchDistanceGLSL=`
  void branchDistance(vec2 p,inout float d,inout float raw,inout float s){
    float z=p.y;
    ${BRANCHES.map((b,i)=>`if(z>${b.z0.toFixed(3)}&&z<${b.z1.toFixed(3)}){float c=streamBranch${i}(z),q=(streamBranch${i}(z+.6)-streamBranch${i}(z-.6))/1.2,r=abs(p.x-c)/sqrt(1.+q*q),e=r*${BRANCH_NARROW.toFixed(2)}+${b.kind==='tributary'?`smoothstep(.84,1.,(z-(${b.z0.toFixed(3)}))/(${(b.z1-b.z0).toFixed(3)}))*34.`:'0.'};if(e<d){d=e;raw=r;s=q;}}`).join('\n    ')}
  }`;

// Albedo of the water body itself (light scattered back up out of the water column), per kind: a deep, clean blue-green, a
// little bluer at sea. Clear deep water sends back only a few per cent. The fixed tints these replace
// (.035/.105/.095 for the lake) were not lit at all and were as bright as the noon sky's own radiance (fog colour .1): the lake
// read as a tiled pool by day and, when the eye opened up at golden hour (exposure 4.7 to 8.4), glowed mint under a sky three
// times dimmer than it.
const WATER_ALBEDO=`
      const vec3 RIVER_ALBEDO=vec3(.009,.022,.026),LAKE_ALBEDO=vec3(.007,.022,.03),SEA_ALBEDO=vec3(.007,.021,.034);`;

/** A shallow, moving surface with a true opaque-scene refraction pass. */
export function createRiver(scene:THREE.Scene, riverX:(z:number)=>number, heightAt:(x:number,z:number)=>number) {
  const positions:number[]=[], indices:number[]=[], uv:number[]=[], ribbonKind:number[]=[];
  const rowStep=.5,rows=RIVER_EXTENT*2/rowStep,columns=WORLD_V2?32:24;
  // Extend under BOTH banks: the terrain's depth, not a visible strip edge, trims the water.
  // uv is (metres across the channel, metres along it), so the current can follow any bend.
  const ribbons=[{centre:riverX,half:WORLD_V2?12:8,from:0,to:rows,kind:0},...(WORLD_V2?BRANCHES:[]).map(b=>({centre:(z:number)=>branchX(b,z),half:6.5,from:Math.ceil((b.z0+RIVER_EXTENT)/rowStep),to:Math.floor((b.z1+RIVER_EXTENT)/rowStep),kind:1}))];
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
      uTime:{value:0},uDarkness:{value:0},uMist:{value:1},uReflectionDetail:{value:0},uReflectionSteps:{value:6},uSky:{value:new THREE.Color(0x879b98)},uSunDirection:{value:new THREE.Vector3(.3,.55,-.7).normalize()},uRipple:{value:Array.from({length:RIPPLES},()=>new THREE.Vector4(0,0,99,0))},
      ...(WORLD_V2?{tWaterNormal:{value:waterNormal},tWaterFoam:{value:waterFoam},uDetail:{value:2},uFoamGain:{value:0},uWind:{value:1},uSunLight:{value:new THREE.Color(1.5,1.35,1.15)}}:{}),
    },
    vertexShader:`
      uniform mat4 textureMatrix,uWorldToSurface;uniform float uTime;
      varying vec4 vReflection;varying vec3 vWater,vEye;varying float vViewDepth;varying vec2 vSlope;
      ${WORLD_V2?'attribute float aRibbon;varying vec2 vChannel;varying float vRibbon;':''}
      ${riverProfileGLSL}

      void main(){
        vec3 p=position;
        float x=p.x,z=-p.y;
        ${WORLD_V2?'vChannel=uv;vRibbon=aRibbon;':''}
        float a=z*2.1-x*.65+uTime*1.15;
        float b=z*4.7+x*2.3+uTime*1.9;
        float c=z*8.1-x*3.4+uTime*2.6;
        // The small ripples only tilt the normal in the rebuilt world. Displaced, they were sampled on each surface's own grid
        // (half a metre on the river, six on the lake, twenty on the sea), so where two surfaces met they stood at different
        // heights and the line between them showed as a row of gaps.
        p.z=${WORLD_V2?'0.':'sin(a)*.012+sin(b)*.006+sin(c)*.002'};
        float grade=streamGrade(z),level=streamHeight(z);
        ${WORLD_V2?`if(aRibbon>1.5){grade=0.;level=aRibbon>2.5?${SEA_LEVEL.toFixed(4)}:${LAKE_LEVEL.toFixed(4)};}`:''}
        vSlope=vec2(-.65*cos(a)*.012+2.3*cos(b)*.006-3.4*cos(c)*.002,grade+2.1*cos(a)*.012+4.7*cos(b)*.006+8.1*cos(c)*.002);
        // World-space height follows the channel. The reflector itself tracks
        // its local tangent plane without bending or moving the visible stream.
        vec4 world=vec4(x,level+p.z,z,1.);
        vReflection=textureMatrix*uWorldToSurface*world;
        vWater=world.xyz;vEye=cameraPosition-world.xyz;
        vec4 view=viewMatrix*world;vViewDepth=-view.z;gl_Position=projectionMatrix*view;
      }`,
    fragmentShader:`
      uniform sampler2D tDiffuse,tOpaque,tOpaqueDepth,tReflectionDepth;uniform vec2 uResolution;
      uniform mat4 uInverseProjection,uReflectionInverseProjection,uReflectionCameraWorld;uniform vec4 uReflectionPlane;uniform float uTime,uDarkness,uMist,uReflectionDetail,uReflectionSteps;uniform vec3 uSky,uSunDirection,uSunScatterColor;
      varying vec4 vReflection;varying vec3 vWater,vEye;varying float vViewDepth;varying vec2 vSlope;
      ${WORLD_V2?'varying vec2 vChannel;varying float vRibbon;':''}
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      ${WORLD_V2?`${riverCourseGLSL}
      ${riverProfileGLSL}
      ${coastalGLSL}
      ${lakeOutlineGLSL}
      uniform vec4 uRipple[${RIPPLES}];uniform sampler2D tWaterNormal,tWaterFoam;uniform float uDetail,uFoamGain,uWind;uniform vec3 uSunLight;
      ${WATER_GLSL}`:''}
      float viewDepth(vec2 uv){float d=texture2D(tOpaqueDepth,uv).x;vec4 p=uInverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);return -p.z/p.w;}
      float fogHash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
      float fogNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(fogHash(i),fogHash(i+vec3(1,0,0)),f.x),mix(fogHash(i+vec3(0,1,0)),fogHash(i+vec3(1,1,0)),f.x),f.y),mix(mix(fogHash(i+vec3(0,0,1)),fogHash(i+vec3(1,0,1)),f.x),mix(fogHash(i+vec3(0,1,1)),fogHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
      vec3 reflectedAtmosphere(vec3 color,vec2 uv,vec3 normal){
        float d=texture2D(tReflectionDepth,uv).r;
        vec4 view=uReflectionInverseProjection*vec4(uv*2.-1.,d*2.-1.,1.);
        vec3 ray=reflect(-normalize(vEye),normal);float distanceToHit=180.;
        // Nothing near in the reflection: the far pass's mountains, distant shore or sky. Kilometres of air lie between, as in the
        // main view (atmosphere.ts): the lower the reflected ray, the longer its path and the more of the sky's horizon colour.
        if(d>=.99999)color=mix(color,uSky,(1.-smoothstep(0.,.22,ray.y))*.4);
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
          // As the main mist (atmosphere.ts): falling off every 14 m of height, and as thick as the hour, the weather and the open
          // water make it (uMist).
          float heightDensity=exp(-max(p.y-1.5,0.)*.07);
          float density=(.017+billow*.034)*uMist*heightDensity*smoothstep(1.5,16.,cameraDistance+along);
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
      ${WORLD_V2?`${WATER_ALBEDO}${WATER_LAYERS_GLSL}${branchDistanceGLSL}${waterV2Main(BRANCHES.length)}`:`
      void main(){
        vec2 screen=gl_FragCoord.xy/uResolution;
        float thickness=max(0.,viewDepth(screen)-vViewDepth);
        // Surface intersection is determined by the real depth-buffer shoreline.
        if(thickness<.001)discard;
        vec2 flow=vWater.xz*vec2(1.3,2.8)+vec2(uTime*.04,uTime*.35);
        float n1=noise(flow),n2=noise(flow*2.7+vec2(8.5,uTime*.4));
        vec2 detail=vec2(n1-.5,n2-.5)*.055;
        vec3 N=normalize(vec3(-vSlope.x+detail.x,1.,-vSlope.y+detail.y));
        float viewAngle=max(dot(normalize(vEye),N),0.);
        float fresnel=.022+.978*pow(1.-viewAngle,5.);
        vec2 distortion=(vSlope+detail)*.018*smoothstep(0.,.28,thickness);
        vec2 refractUv=clamp(screen+distortion,vec2(.001),vec2(.999));
        if(viewDepth(refractUv)<vViewDepth)refractUv=screen;
        float depth=min(thickness,4.);
        vec3 transmitted=texture2D(tOpaque,refractUv).rgb;
        vec3 absorption=exp(-vec3(.54,.31,.22)*depth);
        vec3 waterTint=vec3(.021,.036,.032)*(1.-uDarkness*.97);
        vec3 underwater=transmitted*absorption+waterTint*(1.-absorption);
        vec2 reflectUv=clamp(vReflection.xy/vReflection.w+distortion*.72,vec2(.001),vec2(.999));
        vec3 reflection=uSky;
        float localReflection=uReflectionDetail*(1.-smoothstep(.25,1.2,abs(dot(vec4(vWater,1.),uReflectionPlane))));
        if(localReflection>.001){
          vec3 reflected=texture2D(tDiffuse,reflectUv).rgb;
          reflection=mix(uSky,reflectedAtmosphere(reflected,reflectUv,N),localReflection);
        }
        vec3 result=mix(underwater,reflection,fresnel);
        float glint=pow(max(dot(reflect(-uSunDirection,N),normalize(vEye)),0.),180.);
        result+=vec3(.55,.64,.60)*glint*.11*(1.-uDarkness);
        // Tiny foam pockets occur only in the thin band touching submerged gravel.
        float edge=(1.-smoothstep(.02,.15,thickness))*smoothstep(.0,.02,thickness);
        float foam=step(.72,noise(vWater.xz*17.+vec2(0.,uTime*.4)))*edge*.10;
        result=mix(result,vec3(.18,.21,.19)*(1.-uDarkness*.96),foam);
        gl_FragColor=vec4(result,1.);
      }`}`
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
  // Two passes into the one reflection target. First the far world (layer 3: the island seen from afar, the far range and the
  // sky) out to the main camera's far plane; then, with only the depth cleared, the near world (layer 0: the ground round the
  // player, trees, props) out to REFLECTION_NEAR, drawn over it. One pass at 240 m left the lake's far shore and every mountain
  // out of the lake; one pass out to 20 km would draw the whole island's forest twice.
  const REFLECTION_NEAR=320,FAR_LAYER=3;
  // The mist over water and its shores, as a share of the wood's (mist-cover.ts: .08 over water, .28 on open land).
  const MIST_OVER_WATER=.2;
  let skyObjects:THREE.Object3D[]|undefined;
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
    const sourceFar=sourceCamera.far,virtual=stream.camera,clearColour=renderer.autoClearColor,autoClear=renderer.autoClear;
    skyObjects??=['HDR sky with drifting clouds','Resolved stellar points'].map(name=>world.getObjectByName(name)).filter((o):o is THREE.Object3D=>!!o);
    const skyShown=skyObjects.map(o=>o.visible);
    const wasVisible=stream.visible;
    try{
      // The far world and the sky, at the main camera's own far plane.
      virtual.layers.set(FAR_LAYER);
      reflect.call(this,renderer,world,camera,geo,mat,group);
      // The near world over it: depth cleared, colour kept, the sky left out (it would cover the far pass from its far depth).
      // The water pass runs with autoClear off, which makes the Reflector clear everything itself; with autoClear on and the
      // colour's clear off, only the depth is cleared.
      if(sourceFar>REFLECTION_NEAR){sourceCamera.far=REFLECTION_NEAR;sourceCamera.updateProjectionMatrix();}
      virtual.layers.set(0);for(const o of skyObjects)o.visible=false;
      renderer.autoClear=true;renderer.autoClearColor=false;stream.visible=wasVisible;
      reflect.call(this,renderer,world,camera,geo,mat,group);
    }finally{
      renderer.autoClear=autoClear;renderer.autoClearColor=clearColour;stream.visible=wasVisible;
      skyObjects.forEach((o,i)=>{o.visible=skyShown[i];});
      if(sourceFar>REFLECTION_NEAR){sourceCamera.far=sourceFar;sourceCamera.updateProjectionMatrix();}
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
    // Out to 16 km: the camera now sees the far mountains (far-range.ts), and an edge of the sea at 4 km showed under them.
    const nearCoast=(t:number)=>{const signed=t*2-1,q=Math.abs(signed);return Math.sign(signed)*(q<.8?q/.8*850:850+15150*((q-.8)/.2)**2);};
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
  const sea=WORLD_V2?broadSurface('Open sea — coastal horizon',3,-16000,16000,-16000,16000,80,100):null;
  const lakeBounds=new THREE.Box3(new THREE.Vector3(LAKE_CENTER.x-LAKE_RADII.x*1.4,LAKE_LEVEL-.2,LAKE_CENTER.z-LAKE_RADII.z*1.4),new THREE.Vector3(LAKE_CENTER.x+LAKE_RADII.x*1.4,LAKE_LEVEL+.2,LAKE_CENTER.z+LAKE_RADII.z*1.4));
  const seaBounds=new THREE.Box3(new THREE.Vector3(-16000,SEA_LEVEL-.3,-16000),new THREE.Vector3(16000,SEA_LEVEL+.3,16000));
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
    setQuality(requested=768,detail=2){const size=Math.min(requested,768);const target=stream.getRenderTarget();if(target.width!==size){target.setSize(size,size);reflectionReady=false;}material.uniforms.uReflectionSteps.value=6;if(WORLD_V2){material.uniforms.uDetail.value=Math.min(detail,2);const af=Math.min(16,scene.userData.maxAnisotropy??16,scene.userData.graphicsAnisotropy??16);for(const key of ['tWaterNormal','tWaterFoam']){const texture=material.uniforms[key].value as THREE.Texture;if(texture.anisotropy!==af){texture.anisotropy=af;texture.needsUpdate=true;}}}},
    bind(color:THREE.Texture,depth:THREE.DepthTexture,resolution:THREE.Vector2,projection:THREE.Matrix4){
      material.uniforms.tOpaque.value=color;material.uniforms.tOpaqueDepth.value=depth;
      material.uniforms.uResolution.value=resolution;material.uniforms.uInverseProjection.value=projection;
    },
    update(time:number,player:THREE.Vector3,darkness:number){
      const lakeNear=WORLD_V2?Math.max(0,lakeDistance(player.x,player.z)):Infinity,seaNear=WORLD_V2?Math.max(0,coastDistance(player.x,player.z)):Infinity;
      const distance=WORLD_V2?channelOffset(player.x,player.z):Math.abs(player.x-riverX(player.z));
      // Reflect the body that matters most from here. A lake or the sea mirrors the land round it from across its whole width
      // (out to 320 m and 260 m away), not only within a few steps of its edge; a river only close by (55 m), and the river's
      // tilted plane wins only when the player stands by it rather than by the lake or the sea.
      const lakeWeight=WORLD_V2?1-THREE.MathUtils.smoothstep(lakeNear,150,320):0,seaWeight=WORLD_V2?1-THREE.MathUtils.smoothstep(seaNear,120,260):0;
      const riverWeight=1-THREE.MathUtils.smoothstep(distance,23,55);
      const nearLake=lakeWeight>0&&lakeWeight>=riverWeight&&lakeWeight>=seaWeight,nearSea=!nearLake&&seaWeight>0&&seaWeight>=riverWeight;
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
      // The sun's light at the ground, which lights the water's own colour and its foam (the sky's is uSky).
      if(WORLD_V2&&scene.userData.sunScatterColor)(material.uniforms.uSunLight.value as THREE.Color).copy(scene.userData.sunScatterColor).multiplyScalar(SUN_ILLUMINANCE*LIGHT_TUNING.sun);
      nearby=distance<110&&Math.abs(player.z)<RIVER_EXTENT+110;lakeNearby=lakeNear<450;seaNearby=seaNear<1000;
      material.uniforms.uReflectionDetail.value=Math.max(lakeWeight,seaWeight,riverWeight);
      // The mist the reflected light crosses: the hour's and the weather's (sky.ts), as thin as it lies over water (mist-cover.ts).
      if(WORLD_V2)material.uniforms.uMist.value=((scene.userData.fogDensity as number|undefined)??1)*MIST_OVER_WATER;
      // The wind over open water. Mountain air is still at night and in the early morning (mist forms in it, and a lake goes
      // glassy and mirrors the land), stirs once the sun is well up and blows hardest under a high sun. Where the mist's
      // weather is thick (sim/world/weather.ts) the air is stiller still. 0.15 is a glassy calm, 1.1 a fresh breeze.
      if(WORLD_V2){
        const sunUp=Math.max(0,(scene.userData.sunDirection as THREE.Vector3|undefined)?.y??0),afternoon=THREE.MathUtils.smoothstep(sunUp,.3,.8);
        const weather=(scene.userData.mistWeather as number|undefined)??1;
        material.uniforms.uWind.value=THREE.MathUtils.clamp(.18+.9*afternoon-(weather-1)*.35,.15,1.1);
      }
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
