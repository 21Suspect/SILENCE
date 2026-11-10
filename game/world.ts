/** Shared deterministic geography. Metres, with the original clearing at (0, 0). */
export const WORLD_RADIUS = 600;
export const WORLD_EXTENT = 768;
export const RIVER_EXTENT = 470;
export const TERRAIN_CHUNK = 32;
export const TERRAIN_SEGMENTS = 48;
export const TERRAIN_STEP = TERRAIN_CHUNK / TERRAIN_SEGMENTS;

import { hash, smooth, noise, fbm, pathX, riverX, roadZ, warped, rockMask, COURSE, RIVER_BASE, ROAD_BASE, WORLD_SEED, waterHeightAt, channelOffset, channelShape, channelBranch, courseGLSL } from './world-noise';
import { landform } from './world-landform';
import { WORLD_V2 } from './world-flags';
import { ROAD } from './road-profile';
import { GROUND_PADS, POI_PLACEMENTS, ROAD_ENDS, SCATTER_PLACEMENTS, TRAIL_LINES, placeLocal } from './world-layout';
export { hash, smooth, noise, pathX, riverX, roadZ, channelOffset };
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
export const pathWidth=(z:number)=>.34+noise(z*.055,43)*.55+noise(z*.23,81)*.14;
export const branchPathWidth=(x:number,z:number)=>.42+noise(x*.075+19,z*.075)*.65+noise(x*.3,z*.3+91)*.16;
export const pathDistance=(x:number,z:number)=>Math.abs(x-pathX(z))/Math.sqrt(1+(pathX(z+.5)-pathX(z-.5))**2);
// The stream descends towards -Z. A continuous 0.39–1.12% grade avoids a
// perfectly level canal without introducing uphill flow or detached pools.
export { waterHeightAt };
export const waterGradeAt=(z:number)=>.0075+(.4/110)*Math.cos((z+35)/110);
export const riverProfileGLSL=`
  float streamHeight(float z){return -1.17+.0075*(z+35.)+.4*sin((z+35.)/110.);}
  float streamGrade(float z){return .0075+(.4/110.)*cos((z+35.)/110.);}
`;
export const riverPresence=(z:number)=>1-smooth(Math.abs(z),RIVER_EXTENT-52,RIVER_EXTENT-8);
export const trailPresence=(x:number,z:number)=>1-smooth(Math.hypot(x,z),428,446);
// The road does not fade out: it runs to a tunnel mouth at each end of the valley and stops there.
const ROAD_EAST=WORLD_V2?ROAD_ENDS.find(e=>e.side>0)!.x:1e9,ROAD_WEST=WORLD_V2?ROAD_ENDS.find(e=>e.side<0)!.x:-1e9;
/**
 * Metres from the road's centre line, measured across it (not along z, which on a diagonal stretch is up to 1.5 times
 * longer). The shader measures the same thing. Beyond the verge it only has to be big, so the far field is cheap.
 */
export function roadDistance(x:number,z:number){
  const dz=Math.abs(z-roadZ(x));
  if(dz>21)return dz/1.5;
  const m=roadZ(x+.5)-roadZ(x-.5);
  return dz/Math.sqrt(1+m*m);
}
export const roadPresence=(x:number,z:number)=>WORLD_V2?(1-smooth(x,ROAD_EAST-.5,ROAD_EAST+2.5))*(1-smooth(-x,-ROAD_WEST-.5,-ROAD_WEST+2.5)):trailPresence(x,z);
// --- rebuilt world: trails, pads and rock, all sampled from the same data everywhere -------------
const trailCells=new Map<string,number[]>();const trailSegments:number[]=[];
const trailOwner:[number,number][]=[];
if(WORLD_V2)for(const line of TRAIL_LINES)for(let k=0;k<line.length-1;k++){
  const [x0,z0]=line[k],[x1,z1]=line[k+1],index=trailSegments.length;trailSegments.push(x0,z0,x1,z1);trailOwner.push([TRAIL_LINES.indexOf(line),k]);
  for(let cx=Math.floor((Math.min(x0,x1)-6)/12);cx<=Math.floor((Math.max(x0,x1)+6)/12);cx++)for(let cz=Math.floor((Math.min(z0,z1)-6)/12);cz<=Math.floor((Math.max(z0,z1)+6)/12);cz++){
    const key=`${cx},${cz}`;let bucket=trailCells.get(key);if(!bucket){bucket=[];trailCells.set(key,bucket);}bucket.push(index);
  }
}
let nearestTrailSegment=-1,nearestTrailT=0;
function trailDistanceV2(x:number,z:number){
  const bucket=trailCells.get(`${Math.floor(x/12)},${Math.floor(z/12)}`);if(!bucket)return Infinity;
  let best=Infinity;
  for(const i of bucket){
    const ax=trailSegments[i],az=trailSegments[i+1],dx=trailSegments[i+2]-ax,dz=trailSegments[i+3]-az,t=Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/(dx*dx+dz*dz)));
    const d=Math.hypot(x-ax-dx*t,z-az-dz*t);
    if(d<best){best=d;nearestTrailSegment=i/4;nearestTrailT=t;}
  }
  return best;
}
/** The height a footpath has been worn to: its line of ground, smoothed and never steeper than a person will walk. */
let trailGrade:Float32Array[]|undefined;
function buildTrailGrade(){
  return TRAIL_LINES.map(line=>{
    const n=line.length,raw=Float32Array.from(line,([x,z])=>landform(x,z,Math.hypot(x,z)));
    let out=raw;
    for(let pass=0;pass<4;pass++){const next=out.slice();for(let i=1;i<n-1;i++)next[i]=(out[i-1]+out[i]*2+out[i+1])/4;out=next;}
    const run=(i:number)=>Math.hypot(line[i][0]-line[i-1][0],line[i][1]-line[i-1][1]);
    for(let i=1;i<n;i++){const m=run(i)*.42;out[i]=Math.max(out[i-1]-m,Math.min(out[i-1]+m,out[i]));}
    for(let i=n-1;i>0;i--){const m=run(i)*.42;out[i-1]=Math.max(out[i]-m,Math.min(out[i]+m,out[i-1]));}
    return out;
  });
}
const PADS=[...GROUND_PADS.map(p=>({x:p.x,z:p.z,radius:p.radius,falloff:p.falloff,rise:0,reach:p.radius+p.falloff,level:p.level as number|undefined,small:true,fixed:p.level!==undefined})),
  ...POI_PLACEMENTS.filter(p=>p.pad).map(p=>({x:p.x,z:p.z,radius:p.pad!.radius,falloff:p.pad!.falloff,rise:p.pad!.rise??0,reach:p.pad!.radius+p.pad!.falloff,level:undefined as number|undefined,small:false}))];
const FOOTPRINTS=POI_PLACEMENTS.filter(p=>p.footprint).map(p=>{
  const [x,z]=placeLocal(p,p.footprint!.cx,p.footprint!.cz);
  return {x,z,hx:p.footprint!.hx,hz:p.footprint!.hz,c:Math.cos(p.yaw),s:Math.sin(p.yaw),reach:Math.hypot(p.footprint!.hx,p.footprint!.hz)};
});
const CLEARINGS=POI_PLACEMENTS.filter(p=>p.clearing).map(p=>({x:p.x,z:p.z,r:p.clearing!}));
/** Metres outside the object's real rectangle; negative inside it. Buildings have corners, so the grass must too. */
function footprintDistance(f:typeof FOOTPRINTS[number],x:number,z:number){
  const dx=x-f.x,dz=z-f.z,lx=Math.abs(dx*f.c-dz*f.s)-f.hx,lz=Math.abs(dx*f.s+dz*f.c)-f.hz;
  return Math.hypot(Math.max(lx,0),Math.max(lz,0))+Math.min(Math.max(lx,lz),0);
}
function nearestFootprint(x:number,z:number){
  let best=Infinity;
  for(const f of FOOTPRINTS)if(Math.abs(x-f.x)<f.reach+9&&Math.abs(z-f.z)<f.reach+9)best=Math.min(best,footprintDistance(f,x,z));
  return best;
}
const OBSTACLE_RADIUS:Record<string,number>={bench:1.9,wall:2.7,wall_gap:2.7,effigy:1.5,rock_a:6,rock_b:6,rock_c:6,rock_d:6,deerstand:2,pole:.9,drum:.6,crate:.7,tire:.7,roadsign:.4,canline:4.2,fence:2.8,guardrail:4.6,guardrail_end:4.6,guardrail_endr:4.6,outhouse:1.6,picnic_table:1.8,totem:1.6,wheelbarrow:1.2,firewood:1.5,sawhorse:1.6,pallet:1,chair:.9};
const obstacleCells=new Map<string,{x:number;z:number;r:number}[]>();
if(WORLD_V2)for(const s of SCATTER_PLACEMENTS){
  const r=OBSTACLE_RADIUS[s.asset]??1;
  for(let cx=Math.floor((s.x-r)/16);cx<=Math.floor((s.x+r)/16);cx++)for(let cz=Math.floor((s.z-r)/16);cz<=Math.floor((s.z+r)/16);cz++){
    const key=`${cx},${cz}`;let bucket=obstacleCells.get(key);if(!bucket){bucket=[];obstacleCells.set(key,bucket);}bucket.push({x:s.x,z:s.z,r});
  }
}
/** Trees and plants stay off paths, building pads and rock. */
function exclusionV2(x:number,z:number){
  const width=branchPathWidth(x,z);
  let v=1-smooth(trailDistanceV2(x,z),width*.6,width+.85);
  // Grass grows right up to the walls. Trees only stand back a few metres, so the forest closes around a place.
  const wall=nearestFootprint(x,z);
  if(wall<7)v=Math.max(v,1-smooth(wall,.05,.9),.62*(1-smooth(wall,3,6.5)));
  for(const c of CLEARINGS){const d=Math.hypot(x-c.x,z-c.z);if(d<c.r+2)v=Math.max(v,.62*(1-smooth(d,c.r-2,c.r+2)));}
  for(const o of obstacleCells.get(`${Math.floor(x/16)},${Math.floor(z/16)}`)??[]){const d=Math.hypot(x-o.x,z-o.z);if(d<o.r+.5)v=1;}
  return v;
}
export function vegetationExclusion(x:number,z:number){
  const presence=trailPresence(x,z);
  const base=Math.max((1-smooth(pathDistance(x,z),pathWidth(z)*.6,pathWidth(z)+.7))*presence,
    (1-smooth(WORLD_V2?channelShape(x,z):Math.abs(x-riverX(z)),4.1,6.8))*riverPresence(z),
    WORLD_V2?(1-smooth(roadDistance(x,z),ROAD.clearFrom,ROAD.clearTo))*roadPresence(x,z):(1-smooth(Math.abs(z-roadZ(x)),1.25,2.65))*roadPresence(x,z));
  return WORLD_V2?Math.max(base,exclusionV2(x,z)):base;
}
/** The rendered ground: [worn earth 0..1, exposed rock 0..1]. */
export function groundMasks(x:number,z:number):[number,number]{
  const width=branchPathWidth(x,z), edge=(noise(x*1.4,z*1.4)-.5)*.22;
  let worn=(1-smooth(trailDistanceV2(x,z)+edge,width*.25,width+.4))*(.8+.18*noise(x*.24,z*.24));
  // Bare, trodden ground right against whatever people kept walking around, broken up so it has no outline.
  const wall=nearestFootprint(x,z);
  if(wall<4)worn=Math.max(worn,(1-smooth(wall,.2,3.4))*(.25+.75*noise(x*.42+5,z*.42)));
  const [u,v]=warped(x,z);
  return [worn,rockMask(u,v)];
}
// The mine is driven into a hillside: a horseshoe of ground rises around its yard and runs on behind the rock.
const MINE=POI_PLACEMENTS.find(p=>p.id==='mine');
function mineHill(x:number,z:number){
  if(!MINE)return 0;
  const dx=x-MINE.x,dz=z-MINE.z,c=Math.cos(MINE.yaw),s=Math.sin(MINE.yaw),lx=dx*c-dz*s,lz=dx*s+dz*c;
  // Local -z runs into the hill. The cut face is a horseshoe open to the yard; the slope carries on up behind it.
  const back=.1+.05*lx*lx-lz;
  if(back<=0)return 0;
  const reach=1-smooth(Math.hypot(lx,lz+16),34,72);
  if(reach<=0)return 0;
  // The heading itself stays at floor level. The rock model roofs it over.
  const corridor=(1-smooth(Math.abs(lx),3,4.2))*smooth(lz,-13.5,-11.5);
  return reach*(6.8*(1-smooth(Math.abs(lx),7,13))*smooth(back,0,1.7)+8.5*smooth(back,1,32))*(1-corridor)*smooth(Math.abs(x-pathX(z)),8,34);
}
let groundPadWeight=0;
function shapedGround(x:number,z:number,radius:number,road:number,path:number,detail:number){
  let h=landform(x,z,radius),roadGrade=0,roadHold=0,roadAcross=99;
  // The road was cut and filled: it holds a gentle grade with banks either side. The grade is the one at the nearest point of
  // the centre line, so a section across the carriageway is level even where the road runs diagonally, as far out as the shoulder.
  const roadDz=z-roadZ(x);
  if(Math.abs(roadDz)<40){
    const m=roadZ(x+.5)-roadZ(x-.5),k=1/(1+m*m),across=Math.abs(roadDz)*Math.sqrt(k);
    roadAcross=across;
    if(across<ROAD.ease+1){
      const xc=x+roadDz*m*k;
      const cz=(px:number)=>landform(px,roadZ(px),Math.hypot(px,roadZ(px)));
      const grade=(cz(xc-16)+cz(xc-8)+cz(xc)+cz(xc+8)+cz(xc+16))/5;
      h=mix(grade,h,Math.max(smooth(across,ROAD.level,ROAD.ease),1-roadPresence(x,z)));
      roadGrade=grade;roadHold=(1-smooth(across,ROAD.level,ROAD.level+5.6))*roadPresence(x,z);
    }
  }
  const trailOff=trailDistanceV2(x,z);
  if(trailOff<5.5&&nearestTrailSegment>=0){
    trailGrade??=buildTrailGrade();
    const [line,k]=trailOwner[nearestTrailSegment],g=trailGrade[line];
    h=mix(mix(g[k],g[k+1],nearestTrailT),h,smooth(trailOff,1.2,5.5));
  }
  const trail=1-smooth(trailOff,.7,3.2);
  h+=detail*(1-Math.max(path,road,trail)*.72)-Math.max(path,trail)*.09;
  let padWeight=0,smallPad=0,buildingPad=0,fixedPad=0;
  groundPadWeight=0;
  for(const p of PADS){
    const dx=x-p.x,dz=z-p.z,d=Math.hypot(dx,dz),wobble=1+(noise(Math.atan2(dz,dx)*2.2+p.x,p.z*.1)-.5)*.3;
    if(d>p.reach*1.2)continue;
    if(p.level===undefined)p.level=landform(p.x,p.z,Math.hypot(p.x,p.z))+p.rise;
    const w=1-smooth(d,p.radius,p.radius+p.falloff*wobble);
    // A raised site stands back from the road: its rise fades out towards the carriageway instead of ending in a wall.
    const toRoad=p.rise&&roadAcross<16?smooth(roadAcross,ROAD.level+2,16):1;
    h=mix(h,p.level-p.rise*(1-toRoad),w);padWeight=Math.max(padWeight,w);if(p.small)smallPad=Math.max(smallPad,w);else buildingPad=Math.max(buildingPad,w);
    if((p as {fixed?:boolean}).fixed)fixedPad=Math.max(fixedPad,w);
    // A raised site must look like ground that was always high: broken slopes, never a turned dome.
    if(p.rise)h+=fbm(x*.042+p.x,z*.042-p.z,3)*4.2*Math.sin(Math.PI*w)*toRoad;
  }
  // Levelling is only true under the building; a few metres out the old lumpy floor comes back.
  groundPadWeight=buildingPad;
  if(padWeight>0)h+=((noise(x*.15+3,z*.15-8)-.5)*1.25+(noise(x*.41,z*.41+5)-.5)*.42+detail)*padWeight*smooth(nearestFootprint(x,z),.8,5)*(1-smallPad);
  // The road keeps its own grade through everything levelled or graded beside it (a building's pad, a path joining it):
  // the carriageway never tilts. Only the bridge approaches, which are set to the deck's level, overrule it.
  if(roadHold>0)h=mix(h,roadGrade,roadHold*(1-fixedPad));
  // Added after the levelling: the yard stays flat and the hillside stands up behind it.
  h+=mineHill(x,z);
  return h;
}

export interface BiomeWeights {forest:number;grove:number;heath:number;alpine:number;}
export function biomeAt(x:number,z:number):BiomeWeights {
  const alpine=smooth(Math.hypot(x,z),430,540);
  const grove=smooth(noise(x*.005+15,z*.005-8)*.47+Math.exp(-((x+170)**2+(z-165)**2)/42000)*.69,.43,.79)*(1-alpine);
  const heath=smooth(noise(x*.006-31,z*.006+11)*.25+Math.exp(-((x-265)**2+(z-200)**2)/22000)*.8+Math.exp(-((x+265)**2+(z+255)**2)/17000)*.65,.36,.75)*(1-alpine)*(1-grove);
  return {forest:Math.max(0,1-grove-heath-alpine),grove,heath,alpine};
}

export function rawHeight(x:number,z:number) {
  const radius=Math.hypot(x,z),angle=Math.atan2(z,x),presence=trailPresence(x,z);
  const path=(1-smooth(pathDistance(x,z),pathWidth(z)*.65,pathWidth(z)+.8))*presence;
  const road=WORLD_V2?(1-smooth(roadDistance(x,z),ROAD.half,ROAD.level))*roadPresence(x,z):(1-smooth(Math.abs(z-roadZ(x)),1.55,2.65))*roadPresence(x,z);
  const base=2.2+(noise(x*.025,z*.025)-.5)*5.2+(noise(x*.085,z*.085)-.5)*1.15;
  const rolling=(noise(x*.008+9,z*.008-5)-.5)*12*smooth(radius,70,220);
  const ridge=14*Math.exp(-((x-265)**2+(z-200)**2)/23000)+7*Math.exp(-((x+265)**2+(z+255)**2)/14000);
  const detail=(noise(x*.48,z*.48)-.5)*.23+(noise(x*1.25,z*1.25)-.5)*.05;
  // A low, eroded ridge encloses the valley. Its short inner escarpment blocks
  // walking physically, while narrow crests and outer gullies create peaks,
  // not the old 200m-tall plateau or an infinitely rising bowl.
  const wallStart=493+Math.sin(angle*3)*13+Math.sin(angle*7+1)*8+Math.sin(angle*17)*2.7;
  const d=radius-wallStart;
  // The road was driven through the foothills in a cutting: it stays at the valley's level all the way to the tunnel
  // mouth, and the ground stands up on either side of it.
  const cutting=WORLD_V2?(1-smooth(Math.abs(z-roadZ(x)),7,26))*roadPresence(x,z):0;
  const foothills=8*smooth(radius,420,wallStart+5)*(1-cutting);
  const escarpment=(WORLD_V2?20:34)*smooth(d,0,22)*(1-smooth(d,41,102));
  let crest=0,folds=0;
  if(radius>430&&radius<680){
    const angularWarp=(noise(Math.cos(angle)*7+19,Math.sin(angle)*7-11)-.5)*3.1;
    const tooth=Math.pow(1-Math.abs(Math.sin(angle*13+angularWarp)),2.2);
    const secondary=Math.pow(1-Math.abs(Math.sin(angle*23+1.7-angularWarp*.8)),3.1);
    const crestOffset=27+Math.sin(angle*9+angularWarp)*5;
    const width=14+noise(Math.cos(angle)*11,Math.sin(angle)*11)*9;
    crest=(WORLD_V2?.5:1)*(7+20*tooth+10*secondary)*Math.exp(-Math.pow(Math.abs((d-crestOffset)/width),1.18));
    const warp=noise(x*.027,z*.027)*5;
    const crags=Math.pow(1-Math.abs(noise(x*.12+warp,z*.12-warp)-.5)*2,3)*6;
    const gullies=(noise(x*.085+11,z*.085-7)-.5)*5.2;
    folds=(crags+gullies)*smooth(d,1,18)*(1-smooth(d,65,110));
    crest*=smooth(radius,430,450);
  }
  const mountains=escarpment+crest+folds;
  const land=WORLD_V2?shapedGround(x,z,radius,road,path,detail):Math.max(-.55,base+rolling+ridge)+detail*(1-Math.max(path,road)*.72)-path*.07;
  const ground=land+foothills+mountains;
  const distance=WORLD_V2?channelShape(x,z):Math.abs(x-riverX(z)),water=waterHeightAt(z);
  const sideChannel=WORLD_V2?channelBranch:0;
  const width=1.15+noise(z*.055,7)*.55;
  const bed=water-.61+noise(x*.75,z*.75)*.12+Math.sin(z*.23)*.035;
  // A gravel shelf, gentle near bank and long transition into the forest
  // replace the deep V-shaped ditch. Both shores meet the actual water level.
  const shelf=mix(bed,water+.16,smooth(distance,width,3.3+noise(z*.035,24)*.55));
  const lowBank=Math.max(water+.5,Math.min(ground,water+1.65));
  const bank=mix(shelf,lowBank,smooth(distance,3.6,8.8));
  const fromRoad=WORLD_V2?Math.abs(z-roadZ(x)):99,atBridge=WORLD_V2?1-smooth(fromRoad,8,48):0,atAbutment=WORLD_V2?1-smooth(fromRoad,6.5,13):0;
  // A side channel cuts its own valley, wider where it has more hill to get through.
  const relief=WORLD_V2?Math.max(0,ground-water-1.65)*(sideChannel?1.9:1.4)*(1-atBridge):0;
  // The wall rises to just under the road, and a concrete abutment holds the last three metres.
  const wallTop=mix(ground,ground-3.2,atAbutment);
  const channel=atAbutment>.001
    ?mix(mix(bank,wallTop,smooth(distance,mix(9,11.8,atBridge),mix(19,14.9,atBridge)+relief)),ground,smooth(distance,14.9,15.7)*atAbutment+(1-atAbutment)*smooth(distance,mix(9,11.8,atBridge),mix(19,14.9,atBridge)+relief))
    :mix(bank,ground,smooth(distance,mix(9,11.8,atBridge),mix(19,14.9,atBridge)+relief));
  const out=mix(ground,channel,riverPresence(z)*(WORLD_V2?1-groundPadWeight:1));
  return WORLD_V2&&!tunnelsOff?tunnelGround(x,z,out):out;
}
// The road tunnels are driven into the foot of the mountain: the ground stands up behind each mouth and runs on up
// the slope, while the bore itself stays at road level. The rock model roofs the bore over and hides the cut.
let tunnelsOff=false;
const TUNNELS=WORLD_V2?ROAD_ENDS.map(e=>({...e,level:undefined as number|undefined})):[];
function tunnelGround(x:number,z:number,h:number){
  for(const t of TUNNELS){
    const dx=x-t.x,dz=z-t.z;
    if(dx*dx+dz*dz>70*70)continue;
    if(t.level===undefined){
      // The mouth is cut into the foot of the slope: its floor is the road's own level a little way back down it.
      tunnelsOff=true;t.level=Math.min(rawHeight(t.x,t.z),rawHeight(t.x+Math.sin(t.yaw)*18,t.z+Math.cos(t.yaw)*18)+.4);tunnelsOff=false;
    }
    const c=Math.cos(t.yaw),s=Math.sin(t.yaw),lx=dx*c-dz*s,lz=dx*s+dz*c,ax=Math.abs(lx);
    // Model-local +z looks down the road into the valley; -z runs into the hill.
    // Level across the mouth and through the bore, so the portal, its wings and the roadway all stand on one floor.
    // The floor widens once it is clear of the wing walls, so the barrier across the road stands level too.
    const narrow=smooth(lz,9,14),inBore=1-smooth(lz,-3.5,-1.5);
    const floor=(1-smooth(ax,mix(mix(10.6,7.8,narrow),4.2,inBore),mix(mix(14.5,13,narrow),9.5,inBore)))*smooth(lz,-12,-10)*(1-smooth(lz,15,27));
    h=mix(h,t.level,floor);
    const front=-2.4+.012*lx*lx+.09*Math.max(ax-6.6,0)**2,back=front-lz;
    if(back<=0)continue;
    const reach=1-smooth(Math.hypot(lx,lz+16),30,62);
    if(reach<=0)continue;
    const bore=(1-smooth(ax,3.3,4.1))*smooth(lz,-11.6,-9.8);
    const want=t.level+(10*(1-smooth(ax,8.5,14))*smooth(back,0,1.6)+8*smooth(back,1,30))*reach;
    h=mix(Math.max(h,mix(h,want,reach)),h,bore);
  }
  return h;
}

// Only nearby lattice blocks are retained. Collision and rendered terrain use
// exactly the same float32 vertices and triangle diagonal, including negative
// coordinates and chunk seams. No million-vertex world grid is allocated.
const heightBlocks=new Map<string,Float32Array>();
const HEIGHT_CACHE_LIMIT=196;
let lastHeightBlock:Float32Array|undefined,lastHeightBlockX=Infinity,lastHeightBlockZ=Infinity;
function rememberHeightBlock(ix:number,iz:number,key:string,block:Float32Array) {
  heightBlocks.set(key,block);
  if(heightBlocks.size>HEIGHT_CACHE_LIMIT)heightBlocks.delete(heightBlocks.keys().next().value!);
  lastHeightBlock=block;lastHeightBlockX=ix;lastHeightBlockZ=iz;
}
export function cacheTerrainBlock(ix:number,iz:number,block:Float32Array) {
  const key=`${ix},${iz}`;
  if(!heightBlocks.has(key))rememberHeightBlock(ix,iz,key,block);
}
export function terrainBlock(ix:number,iz:number) {
  // Consecutive slope samples, vertices and plant roots usually share a tile.
  if(ix===lastHeightBlockX&&iz===lastHeightBlockZ&&lastHeightBlock)return lastHeightBlock;
  const key=`${ix},${iz}`;let block=heightBlocks.get(key);
  if(block)heightBlocks.delete(key);
  else{
    block=new Float32Array((TERRAIN_SEGMENTS+1)**2);
    for(let z=0;z<=TERRAIN_SEGMENTS;z++)for(let x=0;x<=TERRAIN_SEGMENTS;x++)
      block[z*(TERRAIN_SEGMENTS+1)+x]=rawHeight(ix*TERRAIN_CHUNK+x*TERRAIN_STEP,iz*TERRAIN_CHUNK+z*TERRAIN_STEP);
  }
  rememberHeightBlock(ix,iz,key,block);
  return block;
}
export function heightAt(x:number,z:number) {
  const bx=Math.floor(x/TERRAIN_CHUNK),bz=Math.floor(z/TERRAIN_CHUNK),data=terrainBlock(bx,bz);
  const u=(x-bx*TERRAIN_CHUNK)/TERRAIN_STEP,v=(z-bz*TERRAIN_CHUNK)/TERRAIN_STEP;
  const ix=Math.min(TERRAIN_SEGMENTS-1,Math.floor(u)),iz=Math.min(TERRAIN_SEGMENTS-1,Math.floor(v)),fx=u-ix,fz=v-iz,k=iz*(TERRAIN_SEGMENTS+1)+ix;
  const a=data[k],b=data[k+1],c=data[k+TERRAIN_SEGMENTS+1],d=data[k+TERRAIN_SEGMENTS+2];
  return fx+fz<=1?a+(b-a)*fx+(c-a)*fz:d+(b-d)*(1-fz)+(c-d)*(1-fx);
}
/** Only the rendered wet channel supports the creature; water is not a player collider. */
export function riverSurfaceAt(x:number,z:number):number|undefined {
  if(riverPresence(z)<=0||(WORLD_V2?channelOffset(x,z):Math.abs(x-riverX(z)))>=8)return undefined;
  const level=waterHeightAt(z);
  return heightAt(x,z)<level?level:undefined;
}
/** The distant 4m mesh uses this same diagonal; near LOD edges blend to it. */
const horizonSamples=new Map<string,number>();
function horizonSample(x:number,z:number){
  const key=`${x},${z}`;let y=horizonSamples.get(key);
  if(y===undefined){y=Math.fround(rawHeight(x,z));horizonSamples.set(key,y);if(horizonSamples.size>8192)horizonSamples.delete(horizonSamples.keys().next().value!);}
  return y;
}
export function horizonHeightAt(x:number,z:number){
  const step=4,x0=Math.floor(x/step)*step,z0=Math.floor(z/step)*step,fx=(x-x0)/step,fz=(z-z0)/step;
  const a=horizonSample(x0,z0),b=horizonSample(x0+step,z0),c=horizonSample(x0,z0+step),d=horizonSample(x0+step,z0+step);
  return fx+fz<=1?a+(b-a)*fx+(c-a)*fz:d+(b-d)*(1-fz)+(c-d)*(1-fx);
}
export const terrainHeightStats=()=>({blocks:heightBlocks.size,limit:HEIGHT_CACHE_LIMIT,bytes:heightBlocks.size*(TERRAIN_SEGMENTS+1)**2*4});

export const WORLD_DESTINATIONS = [
  {name:'Forest trail',x:0,z:7},
  {name:'Stream footbridge',x:riverX(-35)-9,z:-35},
  {name:'Birch hollow',x:-175,z:160},
  {name:'Windblown heath',x:265,z:200},
  {name:'Southern clearing',x:-265,z:-255},
  {name:'Ruined enclosure',x:176,z:-214},
  {name:'Old boundary fence',x:-224,z:170},
  {name:'Mountain foothills',x:-465,z:65},
] as const;

/** Shader geography matches CPU vegetation, physics and river placement. */
export const riverCourseGLSL = WORLD_V2?`${courseGLSL}
  float streamCentre(float z){return streamXGen(z);}`:`float streamCentre(float z){return ${RIVER_BASE.toFixed(5)}+sin(z*.027+(${COURSE[3].toFixed(5)}))*10.+sin(z*.071+(${COURSE[4].toFixed(5)}))*2.+sin(z*.008+(${COURSE[5].toFixed(5)}))*18.;}`;
export const worldGeographyGLSL = `
  ${riverProfileGLSL}
  float worldHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float worldNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(worldHash(i),worldHash(i+vec2(1.,0.)),f.x),mix(worldHash(i+vec2(0.,1.)),worldHash(i+vec2(1.)),f.x),f.y);}
  ${WORLD_V2?courseGLSL:''}
  float trailX(float z){${WORLD_V2?'return trailXGen(z);':`return sin(z*.31+(${COURSE[1].toFixed(5)}))*.65+sin(z*.117+(${COURSE[2].toFixed(5)}))*1.4+sin(z*.021+(${COURSE[0].toFixed(5)}))*18.+sin(z*.069+(${COURSE[1].toFixed(5)}))*6.+sin(z*.15+(${COURSE[2].toFixed(5)}))*1.8;`}}
  float trailWidth(float z){return .34+worldNoise(vec2(z*.055,43.))*.55+worldNoise(vec2(z*.23,81.))*.14;}
  float trailDistance(vec2 p){float d=trailX(p.y+.5)-trailX(p.y-.5);return abs(p.x-trailX(p.y))/sqrt(1.+d*d);}
  float streamX(float z){${WORLD_V2?'return streamXGen(z);':`return ${RIVER_BASE.toFixed(5)}+sin(z*.027+(${COURSE[3].toFixed(5)}))*10.+sin(z*.071+(${COURSE[4].toFixed(5)}))*2.+sin(z*.008+(${COURSE[5].toFixed(5)}))*18.;`}}
  ${WORLD_V2?'':'float streamOffset(vec2 p){return abs(p.x-streamX(p.y));}'}
  float streamPresence(float z){return 1.-smoothstep(${RIVER_EXTENT-52}.,${RIVER_EXTENT-8}.,abs(z));}
  float roadCenter(float x){${WORLD_V2?'return roadZGen(x);':`return ${ROAD_BASE.toFixed(5)}+sin(x*.013+(${COURSE[6].toFixed(5)}))*29.+sin(x*.041+(${COURSE[7].toFixed(5)}))*6.2+sin(x*.087+(${COURSE[8].toFixed(5)}))*1.3;`}}
  float trailPresence(vec2 p){return 1.-smoothstep(428.,446.,length(p));}
  float roadPresence(vec2 p){${WORLD_V2?`return (1.-smoothstep(${(ROAD_EAST-.5).toFixed(2)},${(ROAD_EAST+2.5).toFixed(2)},p.x))*(1.-smoothstep(${(-ROAD_WEST-.5).toFixed(2)},${(-ROAD_WEST+2.5).toFixed(2)},-p.x));`:'return trailPresence(p);'}}
`;
