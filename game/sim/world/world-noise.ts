/** Pure value noise and the seeded road and river courses. Only depends on the flags, so any module can load it first. */
import { WORLD_SEED, WORLD_V2 } from './world-flags';
import { buildRoadPlan, planAt, planGLSL, PLAN_DX, type LegSpec, type RoadPlan } from './road-plan';
export { WORLD_SEED };
export function hash(x:number,z:number) {
  const n=Math.sin(x*127.1+z*311.7)*43758.5453;
  return n-Math.floor(n);
}
export function smooth(value:number,min:number,max:number) {
  const t=Math.max(0,Math.min(1,(value-min)/(max-min)));
  return t*t*(3-2*t);
}
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
export function noise(x:number,z:number) {
  const ix=Math.floor(x),iz=Math.floor(z),u=smooth(x-ix,0,1),v=smooth(z-iz,0,1);
  return mix(mix(hash(ix,iz),hash(ix+1,iz),u),mix(hash(ix,iz+1),hash(ix+1,iz+1),u),v);
}
/** Layered noise in -1..1. */
export function fbm(x:number,z:number,octaves:number) {
  let amplitude=.5,frequency=1,sum=0,total=0;
  for(let i=0;i<octaves;i++){sum+=amplitude*(noise(x*frequency+i*17.3,z*frequency-i*9.1)*2-1);total+=amplitude;amplitude*=.5;frequency*=2.03;}
  return sum/total;
}
/** Phases that move the road, the river and the main trail with the seed. All zero for the original world. */
const rnd=(i:number)=>WORLD_SEED?hash(WORLD_SEED*.0137+i*7.3,i*3.1+WORLD_SEED*.0071):.0;
export const COURSE=Array.from({length:9},(_,i)=>rnd(i)*Math.PI*2);
/** Further phases for the bends of the seeded world. Kept apart so the first nine never change. */
const BEND=Array.from({length:12},(_,i)=>rnd(i+30)*Math.PI*2);
const SEED_X=WORLD_SEED*.731%1000,SEED_Z=WORLD_SEED*.417%1000;
const f=(v:number)=>`(${v.toFixed(5)})`;
export const ROAD_BASE=WORLD_SEED?-92+rnd(11)*30:-83;
// Long straights broken by real bends: how much a stretch is allowed to wander comes and goes along its length.
const trailBend=(z:number)=>.25+.75*smooth(Math.sin(z*.0091+BEND[0])+.5*Math.sin(z*.023+BEND[1]),-.4,.7);
const trailBendGLSL=`(.25+.75*smoothstep(-.4,.7,sin(z*.0091+${f(BEND[0])})+.5*sin(z*.023+${f(BEND[1])})))`;
export const pathX=(z:number)=>{
  const base=Math.sin(z*.31+COURSE[1])*.65+Math.sin(z*.117+COURSE[2])*1.4+Math.sin(z*.021+COURSE[0])*18+Math.sin(z*.069+COURSE[1])*6+Math.sin(z*.15+COURSE[2])*1.8;
  return WORLD_SEED?base+trailBend(z)*(Math.sin(z*.0107+BEND[2])*15+Math.sin(z*.038+BEND[3])*6):base;
};
// The stream runs straight at the crossings, where somebody had to build a bridge, and swings about everywhere else.
const riverCalm=(z:number)=>.12+.88*smooth(Math.abs(z-ROAD_BASE),55,125);
const riverBend=(z:number)=>riverCalm(z)*(.3+.7*smooth(Math.sin(z*.0113+BEND[4])+.5*Math.sin(z*.0293+BEND[5]),-.5,.75));
const riverShape=(z:number)=>{
  if(!WORLD_SEED)return Math.sin(z*.027+COURSE[3])*10+Math.sin(z*.071+COURSE[4])*2+Math.sin(z*.008+COURSE[5])*18;
  const e=riverBend(z);
  return Math.sin(z*.0082+COURSE[5])*24+Math.sin(z*.021+COURSE[3])*20*e+Math.sin(z*.047+COURSE[4])*13*e+Math.sin(z*.11+BEND[6])*2.6*e;
};
/** The stream keeps well clear of the main trail, whatever the phases do. */
export const RIVER_BASE=(()=>{
  if(!WORLD_SEED)return 39;
  let least=Infinity;for(let z=-470;z<=470;z+=5)least=Math.min(least,riverShape(z)-pathX(z));
  return Math.max(39,26-least)+rnd(10)*14;
})();
export const riverX=(z:number)=>RIVER_BASE+riverShape(z);
const ROAD_AT_RIVER=riverX(ROAD_BASE);
const roadBend=(x:number)=>.25+.75*smooth(Math.sin(x*.0079+BEND[7])+.5*Math.sin(x*.019+BEND[8]),-.4,.7);
/** The southern course: the road as it runs through the valley, past the bridge, the trailhead, the water tower and the chapel. */
const roadSouth=(x:number)=>{
  // Roads hold their line across a bridge.
  const a=smooth(Math.abs(x-ROAD_AT_RIVER),32,95);
  return ROAD_BASE+Math.sin(x*.013+COURSE[6])*29+a*(Math.sin(x*.103+COURSE[8])*1.35+Math.sin(x*.057+COURSE[7])*2.1+Math.sin(x*.041+COURSE[7])*6.2+Math.sin(x*.087+COURSE[8])*1.3+roadBend(x)*(Math.sin(x*.0063+BEND[9])*16+Math.sin(x*.027+BEND[10])*6));
};
const DEG=Math.PI/180;
/** How each end climbs into the mountains. Seeded, and different at the two ends: never a ruled line and never a mirror image. */
const legSpec=(i:number,side:number):LegSpec=>{
  const r=(k:number)=>rnd(i+k);
  const wave=95+55*r(5);
  // The foothills run along z = 385..410 at both ends; the east mouth lies a little further north and further in than the west one.
  return {targetX:side>0?388+14*r(0):420+14*r(0),targetZ:side>0?402+8*r(4):380+8*r(4),turnIn:100+40*r(1),
    swing:(7.5+2*r(6))*DEG,wave,phase:r(7)*Math.PI*2,swing2:(2+1*r(8))*DEG,wave2:wave*(.46+.12*r(9)),phase2:r(10)*Math.PI*2};
};
/** The road in the rebuilt world: a table of z along x, built once. */
export const ROAD_PLAN:RoadPlan|undefined=WORLD_V2&&WORLD_SEED?buildRoadPlan(roadSouth,legSpec(50,1),legSpec(70,-1)):undefined;
const planScratch={z:0,m:0};
export const roadZ=(x:number)=>{
  if(!WORLD_SEED)return ROAD_BASE+Math.sin(x*.013+COURSE[6])*29+Math.sin(x*.041+COURSE[7])*6.2+Math.sin(x*.087+COURSE[8])*1.3;
  if(ROAD_PLAN)return planAt(ROAD_PLAN.z,x,planScratch).z;
  const a=smooth(Math.abs(x-ROAD_AT_RIVER),32,95);
  return ROAD_BASE+Math.sin(x*.013+COURSE[6])*29+a*(Math.sin(x*.103+COURSE[8])*1.35+Math.sin(x*.057+COURSE[7])*2.1+Math.sin(x*.041+COURSE[7])*6.2+Math.sin(x*.087+COURSE[8])*1.3+roadBend(x)*(Math.sin(x*.0063+BEND[9])*16+Math.sin(x*.027+BEND[10])*6));
};
/** dz/dx of the road, from the same curve as {@link roadZ}: exact for the rebuilt world, a short difference otherwise. */
export const roadSlope=(x:number)=>ROAD_PLAN?planAt(ROAD_PLAN.z,x,planScratch).m:(roadZ(x+.25)-roadZ(x-.25))/.5;
/** The steepest dz/dx anywhere on the road, as sqrt(1 + m^2): a point further than d * ROAD_NORM away in z is further than d away. */
export const ROAD_NORM=(()=>{let m=1.5;if(ROAD_PLAN)for(let i=1;i<ROAD_PLAN.z.length-1;i++)m=Math.max(m,Math.abs(ROAD_PLAN.z[i+1]-ROAD_PLAN.z[i-1])/(2*PLAN_DX));return Math.hypot(1,m*1.08);})();
/** The point of the centre line nearest to a ground point: x and z of it, the slope there, and metres across (positive on the +z side). */
export interface RoadFoot{x:number;z:number;m:number;across:number}
const footScratch={z:0,m:0};
export function roadFoot(px:number,pz:number,out:RoadFoot):RoadFoot{
  const point=(x:number)=>ROAD_PLAN?planAt(ROAD_PLAN.z,x,footScratch):(footScratch.z=roadZ(x),footScratch.m=roadSlope(x),footScratch);
  let p=point(px),x=px+(pz-p.z)*p.m/(1+p.m*p.m);
  // The foot of the perpendicular is where the distance is least. Gauss-Newton settles on it in a couple of steps even on a
  // steep, curving stretch, where the first-order guess along the tangent is out by tens of centimetres.
  for(let k=0;k<3;k++){p=point(x);x-=((x-px)+(p.z-pz)*p.m)/(1+p.m*p.m);}
  p=point(x);
  out.x=x;out.z=p.z;out.m=p.m;out.across=((pz-p.z)-p.m*(px-x))/Math.hypot(1,p.m);
  return out;
}

/** A side channel: a braid leaves the stream and rejoins it round an island, a tributary comes in from the hills. */
export type RiverBranch={kind:'braid'|'tributary';z0:number;z1:number;side:number;reach:number;phase:number};
export const BRANCH_NARROW=1.55;
/** Metres from the main stream, along the row. */
function branchOffset(b:RiverBranch,z:number){
  const t=(z-b.z0)/(b.z1-b.z0);
  if(b.kind==='braid'){const lobe=Math.sin(Math.PI*Math.max(0,Math.min(1,t)));return b.side*(b.reach*lobe+Math.sin(z*.061+b.phase)*3.5*lobe);}
  const u=Math.max(0,Math.min(1,t));
  return b.side*(b.reach*Math.pow(u,.85)+Math.sin(z*.043+b.phase)*7*smooth(u,.1,.5));
}
export const branchX=(b:RiverBranch,z:number)=>riverX(z)+branchOffset(b,z);
/** Near a tributary's head the channel closes up into the hillside. */
export const branchPresence=(b:RiverBranch,z:number)=>{
  const t=(z-b.z0)/(b.z1-b.z0);
  return t<0||t>1?0:b.kind==='braid'?1:1-smooth(t,.84,1);
};
/** Which side channels this seed has. Always one or two, and never across the road, which has only one bridge. */
export const BRANCHES:RiverBranch[]=(()=>{
  if(!WORLD_SEED)return [];
  const north=ROAD_BASE+95,south=ROAD_BASE-95,flip=rnd(14)>.5,out:RiverBranch[]=[];
  const clearOfTrail=(side:number,z0:number,z1:number,reach:number)=>{for(let z=z0;z<=z1;z+=8)if((riverX(z)+side*reach)-pathX(z)<22)return false;return true;};
  const braidAt=(z0:number,z1:number)=>{
    const reach=23+rnd(15)*9,side=rnd(16)>.55&&clearOfTrail(-1,z0,z1,reach)?-1:1;
    out.push({kind:'braid',z0,z1,side,reach,phase:rnd(17)*6.28});
  };
  const tribAt=(z0:number,z1:number)=>out.push({kind:'tributary',z0,z1,side:1,reach:105+rnd(18)*55,phase:rnd(19)*6.28});
  if(flip){
    const z0=north+15+rnd(20)*70;braidAt(z0,z0+135+rnd(21)*60);
    const t=-405+rnd(22)*80;tribAt(t,Math.min(south,t+240));
  }else{
    const t=north+90+rnd(20)*60;tribAt(t,Math.min(425,t+235));
    const z1=south-15-rnd(21)*70;braidAt(z1-135-rnd(22)*60,z1);
  }
  // Roughly a third of worlds get a second braid on the other side of the road.
  if(rnd(23)>.62){
    if(flip){const z1=south-15-rnd(24)*30;if(z1-150>-440&&out[1].z0>z1+25)braidAt(z1-150,z1);else if(out[1].z1<south-190)braidAt(out[1].z1+20,out[1].z1+170);}
    else{const z0=north+5;if(out[0].z0>z0+175)braidAt(z0,z0+150);}
  }
  return out;
})();
const slopeOf=(fn:(z:number)=>number,z:number)=>(fn(z+.6)-fn(z-.6))/1.2;
/** Perpendicular metres from the middle of the nearest channel, wherever it is. */
export function channelOffset(x:number,z:number){
  if(!WORLD_SEED)return Math.abs(x-riverX(z));
  let best=Math.abs(x-riverX(z))/Math.hypot(1,slopeOf(riverX,z));
  for(const b of BRANCHES){
    if(z<b.z0||z>b.z1)continue;
    const c=branchX(b,z);if(Math.abs(x-c)>60)continue;
    const d=Math.abs(x-c)/Math.hypot(1,slopeOf(q=>branchX(b,q),z))+(1-branchPresence(b,z))*34;
    if(d<best)best=d;
  }
  return best;
}
/** Perpendicular metres from the nearest side channel only. Their valleys are wide, so buildings keep well back. */
export function sideChannelOffset(x:number,z:number){
  let best=Infinity;
  for(const b of BRANCHES){
    if(z<b.z0-40||z>b.z1+40)continue;
    const q=Math.max(b.z0,Math.min(b.z1,z));
    const d=Math.hypot((x-branchX(b,q))/Math.hypot(1,slopeOf(w=>branchX(b,w),q)),z-q);
    if(d<best)best=d;
  }
  return best;
}
/** 1 where the nearest channel is a side channel: {@link channelShape} sets it. */
export let channelBranch=0;
/** Distance from the channels as the land sees it: side channels are narrower, so they count as further away. */
export function channelShape(x:number,z:number){
  channelBranch=0;
  if(!WORLD_SEED)return Math.abs(x-riverX(z));
  let best=Math.abs(x-riverX(z))/Math.hypot(1,slopeOf(riverX,z));
  for(const b of BRANCHES){
    if(z<b.z0||z>b.z1)continue;
    const c=branchX(b,z);if(Math.abs(x-c)>80)continue;
    const raw=Math.abs(x-c)/Math.hypot(1,slopeOf(q=>branchX(b,q),z)),k=BRANCH_NARROW,knee=8/k;
    const d=(raw<knee?raw*k:8+raw-knee)+(1-branchPresence(b,z))*34;
    if(d<best){best=d;channelBranch=1;}
  }
  return best;
}
const branchOffsetGLSL=(b:RiverBranch)=>{
  const t=`clamp((z-(${b.z0.toFixed(3)}))/(${(b.z1-b.z0).toFixed(3)}),0.,1.)`;
  return b.kind==='braid'?`${b.side}.*(${b.reach.toFixed(3)}*sin(3.14159265*${t})+sin(z*.061+${f(b.phase)})*3.5*sin(3.14159265*${t}))`
    :`${b.side}.*(${b.reach.toFixed(3)}*pow(${t},.85)+sin(z*.043+${f(b.phase)})*7.*smoothstep(.1,.5,${t}))`;
};
/** The same courses for shaders. Only used by the seeded world; the original keeps its own expressions. */
export const courseGLSL=WORLD_SEED?`
  float trailXGen(float z){return sin(z*.31+${f(COURSE[1])})*.65+sin(z*.117+${f(COURSE[2])})*1.4+sin(z*.021+${f(COURSE[0])})*18.+sin(z*.069+${f(COURSE[1])})*6.+sin(z*.15+${f(COURSE[2])})*1.8+${trailBendGLSL}*(sin(z*.0107+${f(BEND[2])})*15.+sin(z*.038+${f(BEND[3])})*6.);}
  float streamBendGen(float z){return (.12+.88*smoothstep(55.,125.,abs(z-(${ROAD_BASE.toFixed(5)}))))*(.3+.7*smoothstep(-.5,.75,sin(z*.0113+${f(BEND[4])})+.5*sin(z*.0293+${f(BEND[5])})));}
  float streamXGen(float z){float e=streamBendGen(z);return ${RIVER_BASE.toFixed(5)}+sin(z*.0082+${f(COURSE[5])})*24.+sin(z*.021+${f(COURSE[3])})*20.*e+sin(z*.047+${f(COURSE[4])})*13.*e+sin(z*.11+${f(BEND[6])})*2.6*e;}
  ${planGLSL(ROAD_PLAN!.z)}
  ${BRANCHES.map((b,i)=>`float streamBranch${i}(float z){return streamXGen(z)+${branchOffsetGLSL(b)};}`).join('\n  ')}
  float streamOffset(vec2 p){
    float z=p.y,s=(streamXGen(z+.6)-streamXGen(z-.6))/1.2,d=abs(p.x-streamXGen(z))/sqrt(1.+s*s);
    ${BRANCHES.map((b,i)=>`if(z>${b.z0.toFixed(3)}&&z<${b.z1.toFixed(3)}){float c=streamBranch${i}(z),q=(streamBranch${i}(z+.6)-streamBranch${i}(z-.6))/1.2,r=abs(p.x-c)/sqrt(1.+q*q)*${BRANCH_NARROW.toFixed(2)}+${b.kind==='tributary'?`smoothstep(.84,1.,(z-(${b.z0.toFixed(3)}))/(${(b.z1-b.z0).toFixed(3)}))*34.`:'0.'};d=min(d,r);}`).join('\n    ')}
    return d;
  }
`:'';

/** Headwaters descend into a level lake; the outlet grades down to the sea. */
export const waterHeightAt=(z:number)=>{
  if(!WORLD_V2)return -1.17+.0075*(z+35)+.4*Math.sin((z+35)/110);
  if(z < -45)return -5.2 + 5.8 * smooth(z,-300,-45);
  if(z <= 245)return .6;
  const d=z-245;
  return .6 + .0005*d*d + .018*d + 2.4*smooth(z,310,319)+3.2*smooth(z,356,364)+4.5*smooth(z,403,411)+6*smooth(z,451,458)+9*smooth(z,500,508)+12*smooth(z,546,558);
};

/** Warped position shared by every large landform, so hills, shelves and ravines agree. */
export function warped(x:number,z:number):[number,number] {
  return [x+SEED_X+fbm(x*.0055+31+SEED_X,z*.0055-17,2)*42,z+SEED_Z+fbm(x*.0055-57,z*.0055+23+SEED_Z,2)*42];
}
/** 0 where soil lies deep, 1 where bedrock comes to the surface. */
export function rockMask(u:number,v:number) { return smooth(fbm(u*.011+40,v*.011-20,2),.1,.42); }
/** Stands of close timber broken by open glades. */
export function treeDensity(x:number,z:number) { return .34+.66*smooth(fbm((x+SEED_X)*.017+7,(z+SEED_Z)*.017+91,2),-.28,.2); }
