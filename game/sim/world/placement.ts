import { WORLD_V2 } from './world-flags';
import { coastDistance, lakeDistance, beachWidth, SEA_LEVEL } from './coastal-geography';
import { noise, treeDensity } from './world-noise';
import { roadMarkerSpot } from './road-geometry';
import { structureClearance } from './world';
export type LayoutTree={x:number;z:number;y:number;height:number;width:number;yaw:number;kind:number;seed:number};
export type LayoutScatter={x:number;z:number;y:number;size:number;yaw:number;variant:number};
export type Footprint={ax:number;az:number;bx:number;bz:number;radius:number;priority:number;id:string;kind:string};
export type LayoutCell={trees:LayoutTree[];scatter:LayoutScatter[];rubble:LayoutScatter[];deadfall:LayoutScatter[];sticks:LayoutScatter[];stumps:LayoutScatter[];river:LayoutScatter[];footprints:Footprint[]};
type Biome={forest:number;grove:number;heath:number;alpine:number};
type Geography={heightAt:(x:number,z:number)=>number;exclusion:(x:number,z:number)=>number;biomeAt:(x:number,z:number)=>Biome;riverX:(z:number)=>number;riverPresence:(z:number)=>number;roadZ:(x:number)=>number;radius:number};
type Candidate={item:LayoutTree|LayoutScatter;list:keyof Omit<LayoutCell,'footprints'>;footprint:Footprint};
const random=(seed:number)=>{let s=seed>>>0;return()=>{s+=0x6d2b79f5;let t=Math.imul(s^(s>>>15),1|s);t^=t+Math.imul(t^(t>>>7),61|t);return((t^(t>>>14))>>>0)/4294967296;};};
const segmentDistance=(x:number,z:number,a:Footprint)=>{const dx=a.bx-a.ax,dz=a.bz-a.az,l=dx*dx+dz*dz,t=l?Math.max(0,Math.min(1,((x-a.ax)*dx+(z-a.az)*dz)/l)):0;return Math.hypot(x-a.ax-dx*t,z-a.az-dz*t);};
export function footprintDistance(a:Footprint,b:Footprint){
  const ax=a.bx-a.ax,az=a.bz-a.az,bx=b.bx-b.ax,bz=b.bz-b.az,den=ax*bz-az*bx;
  if(Math.abs(den)>1e-10){const dx=b.ax-a.ax,dz=b.az-a.az,t=(dx*bz-dz*bx)/den,u=(dx*az-dz*ax)/den;if(t>=0&&t<=1&&u>=0&&u<=1)return 0;}
  return Math.min(segmentDistance(a.ax,a.az,b),segmentDistance(a.bx,a.bz,b),segmentDistance(b.ax,b.az,a),segmentDistance(b.bx,b.bz,a));
}
export function footprintsOverlap(a:Footprint,b:Footprint,margin=.12){
  const reachA=Math.hypot(a.bx-a.ax,a.bz-a.az)*.5+a.radius,reachB=Math.hypot(b.bx-b.ax,b.bz-b.az)*.5+b.radius;
  if(Math.hypot((a.ax+a.bx-b.ax-b.bx)*.5,(a.az+a.bz-b.az-b.bz)*.5)>reachA+reachB+margin)return false;
  return footprintDistance(a,b)<a.radius+b.radius+margin;
}

/** A deterministic priority disk process. All nine neighbour cells are considered
 * before accepting an object, so streaming order cannot create intersections. */
export function createNaturalLayout(g:Geography){
  const CELL=32,raw=new Map<string,{candidates:Candidate[];scatter:LayoutScatter[]}>(),accepted=new Map<string,LayoutCell>();
  const slope=(x:number,z:number)=>Math.hypot(g.heightAt(x+.6,z)-g.heightAt(x-.6,z),g.heightAt(x,z+.6)-g.heightAt(x,z-.6))/1.2;
  const reserved=(x:number,z:number,reach:number)=>{
    // Nothing natural inside or against a building: the exclusion is tested at an item's centre, and a log or boulder centred
    // outside a hut could still reach in through its wall or floor.
    if(WORLD_V2&&structureClearance(x,z)<reach+.3)return true;
    if(Math.hypot(x+18,z+46)<3.7+reach||Math.hypot(x-176,z+214)<6+reach||Math.hypot(x+224,z-170)<13+reach||Math.hypot(x+4,z+18)<.4+reach||Math.abs(z+35)<1.3+reach&&Math.abs(x-g.riverX(-35))<10+reach)return true;
    for(let i=0;i<8;i++)if(Math.hypot(x+10.8+i*.57,z+22+i*2.6)<.65+reach)return true;
    for(let i=0;i<13;i++){const {x:px,z:pz}=roadMarkerSpot(i);if(Math.abs(px-g.riverX(pz))>=9&&Math.hypot(x-px,z-pz)<.4+reach)return true;}
    return false;
  };
  function rawCell(cx:number,cz:number){
    const key=`${cx},${cz}`,cached=raw.get(key);if(cached)return cached;
    const r=random(Math.imul(cx,73856093)^Math.imul(cz,19349663)^410948),candidates:Candidate[]=[],scatter:LayoutScatter[]=[];
    let serial=0;
    const add=(item:LayoutTree|LayoutScatter,list:Candidate['list'],radius:number,length:number,rank:number)=>{
      const yaw=item.yaw,dx=Math.sin(yaw)*length*.5,dz=Math.cos(yaw)*length*.5;
      if(reserved(item.x,item.z,radius+length*.5))return;
      candidates.push({item,list,footprint:{ax:item.x-dx,az:item.z-dz,bx:item.x+dx,bz:item.z+dz,radius,priority:rank+r()*.9,id:`${key}:${serial++}`,kind:list}});
    };
    const valid=(x:number,z:number,e:number)=>Math.hypot(x,z)<g.radius-55&&g.exclusion(x,z)<e;
    for(let ix=0;ix<6;ix++)for(let iz=0;iz<6;iz++){
      const x=cx*CELL+(ix+.15+r()*.7)*CELL/6,z=cz*CELL+(iz+.15+r()*.7)*CELL/6;
      if(!valid(x,z,.42))continue;const b=g.biomeAt(x,z);
      if(slope(x,z)>(b.alpine>.2?.95:.68)||r()>(.88-b.heath*.65-b.alpine*.72)*(WORLD_V2?treeDensity(x,z):1))continue;
      const roll=r(),birch=.09+b.grove*.57+b.heath*.17,oak=.08+b.grove*.17;
      let kind=roll<birch?4+Math.floor(r()*2):roll<birch+oak?6+Math.floor(r()*2):Math.floor(r()*4);if(b.alpine>.55)kind=2+Math.floor(r()*2);
      const species=Math.floor(kind/2),height=(species===0?.77+r()*.42:species===1?.68+r()*.35:species===2?.52+r()*.29:.50+r()*.33)*(1-b.alpine*.45-b.heath*.16);
      const width=species===0?.69+r()*.69:species===1?.66+r()*.52:species===2?.42+r()*.38:1.12+r()*.75;
      // A flat centre at a cliff lip is not sufficient support for a root plate.
      // Keep the whole base on soil so the tree and its shadow meet the bank.
      const baseY=g.heightAt(x,z),rootRadius=1.4*width;
      let supported=true;
      for(let a=0;a<8;a++)if(Math.abs(g.heightAt(x+Math.cos(a*Math.PI/4)*rootRadius,z+Math.sin(a*Math.PI/4)*rootRadius)-baseY)>rootRadius*(b.alpine>.2?.98:.72)){supported=false;break;}
      if(!supported)continue;
      add({x,z,y:g.heightAt(x,z),height,width,yaw:r()*Math.PI*2,kind,seed:Math.floor(r()*900000)},'trees',1.4*width+.08,0,0);
    }
    const item=(size:number,variant:number):LayoutScatter=>{const x=(cx+r())*CELL,z=(cz+r())*CELL;return{x,z,y:g.heightAt(x,z),size,yaw:r()*Math.PI*2,variant};};
    for(let i=0;i<190;i++){const a=item(.5+r()*1.3,r());if(valid(a.x,a.z,.84)&&r()<.68&&slope(a.x,a.z)<.65)scatter.push(a);}
    // Fewer candidates, then minimum separation: rocks read as occasional
    // grounded outcrops instead of a uniformly sprinkled boulder field.
    for(let i=0;i<8;i++){
      const a=item(.12+Math.pow(r(),2.5)*1.25,r());if(!valid(a.x,a.z,.58)||slope(a.x,a.z)>.58)continue;
      const b=g.biomeAt(a.x,a.z);a.variant=b.alpine>.4||b.heath>.4?1+r()*2:r()<.76?r():1+r()*2;
      add(a,'rubble',a.size*(Math.floor(a.variant)===2?1.72:1.45),0,1);
    }
    // Shore outcrops are sparse clusters, not a uniform border of boulders.
    // They share footprint rejection and grounded mesh seating with forest rocks.
    if(WORLD_V2)for(let i=0;i<12;i++){
      const a=item(.22+Math.pow(r(),2)*2.3,1+r()),d=coastDistance(a.x,a.z),lake=lakeDistance(a.x,a.z);
      const coastal=d>-3&&d<beachWidth(a.x,a.z)+5,lakeside=lake>-2&&lake<8;
      if(!(coastal||lakeside)||slope(a.x,a.z)>.72||a.y<SEA_LEVEL-.5)continue;
      if(noise(a.x*.025+12,a.z*.025) < .56)continue;
      add(a,'rubble',a.size*1.55,0,1);
    }
    for(let i=0;i<3;i++){
      const a=item(2.6+r()*5.3,.16+r()*.24),dx=Math.sin(a.yaw)*a.size*.5,dz=Math.cos(a.yaw)*a.size*.5;
      if(valid(a.x,a.z,.30)&&r()<.68&&slope(a.x,a.z)<.45&&slope(a.x-dx,a.z-dz)<.55&&slope(a.x+dx,a.z+dz)<.55)add(a,'deadfall',a.variant*1.2,a.size,3);
    }
    for(let i=0;i<18;i++){const a=item(.35+r()*1.2,.45+r()*.6);if(valid(a.x,a.z,.7)&&slope(a.x,a.z)<.6)add(a,'sticks',a.variant*.04,a.size,4);}
    for(let i=0;i<3;i++){const a=item(.28+r()*.5,r());if(valid(a.x,a.z,.5)&&r()<.65&&slope(a.x,a.z)<.5)add(a,'stumps',a.size*1.12,0,2);}
    // River gravel participates in the SAME placement test as trees and logs.
    // The photographic bed texture supplies fine pebbles; meshes are sparse.
    for(let i=0;i<82;i++){
      const x=(cx+r())*CELL,z=(cz+r())*CELL;
      if(g.riverPresence(z)<.8||Math.abs(x-g.riverX(z))>4.7||slope(x,z)>1.0)continue;
      const a={x,z,y:g.heightAt(x,z),size:.045+Math.pow(r(),2.2)*(WORLD_V2&&z>290?1.15:.30),yaw:r()*6.283,variant:r()};add(a,'river',a.size*1.4,0,1);
    }
    const result={candidates,scatter};raw.set(key,result);return result;
  }
  function rememberCell(key:string,cell:LayoutCell){
    accepted.set(key,cell);
    if(accepted.size>180)accepted.delete(accepted.keys().next().value!);
  }
  return {
    cacheCell(cx:number,cz:number,cell:LayoutCell){
      const key=`${cx},${cz}`;
      if(!accepted.has(key))rememberCell(key,cell);
    },
    cell(cx:number,cz:number):LayoutCell{
      const key=`${cx},${cz}`,cached=accepted.get(key);if(cached)return cached;
      const source=rawCell(cx,cz),neighbors:Candidate[]=[];
      for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)neighbors.push(...rawCell(cx+dx,cz+dz).candidates);
      const cell:LayoutCell={trees:[],scatter:source.scatter,rubble:[],deadfall:[],sticks:[],stumps:[],river:[],footprints:[]};
      for(const c of source.candidates){
        if(neighbors.some(other=>other!==c&&(other.footprint.priority<c.footprint.priority||other.footprint.priority===c.footprint.priority&&other.footprint.id<c.footprint.id)&&footprintsOverlap(c.footprint,other.footprint)))continue;
        (cell[c.list] as (LayoutTree|LayoutScatter)[]).push(c.item);cell.footprints.push(c.footprint);
      }
      rememberCell(key,cell);
      if(raw.size>324)for(const k of raw.keys()){const [x,z]=k.split(',').map(Number);if(Math.abs(x-cx)>8||Math.abs(z-cz)>8)raw.delete(k);}
      return cell;
    },
    stats(){return {rawCells:raw.size,acceptedCells:accepted.size};},
  };
}

const sharedLayouts=new WeakMap<Geography['heightAt'],ReturnType<typeof createNaturalLayout>>();
export function naturalLayout(g:Geography){let layout=sharedLayouts.get(g.heightAt);if(!layout){layout=createNaturalLayout(g);sharedLayouts.set(g.heightAt,layout);}return layout;}

/** Lowest transformed underside samples are embedded across their footprint,
 * not merely placed relative to terrain at the object's centre. */
export function groundedOrigin(samples:{x:number;y:number;z:number}[],x:number,z:number,heightAt:(x:number,z:number)=>number,embed=.025){
  let y=Infinity;for(const p of samples)y=Math.min(y,heightAt(x+p.x,z+p.z)-p.y-embed);return y;
}
