import type {SolidCollider} from './collision';
import type {EncounterView,ViewVector} from './encounter-visibility';

/** Recognition uses the real image, not the generous bounds/reflection that
 * protect spawn/despawn. A glimpse of a toe at the edge is not a sighting. */
export function inDirectView(view:EncounterView,point:ViewVector,maxDistance=30){
  const x=point.x-view.position.x,y=point.y-view.position.y,z=point.z-view.position.z;
  const depth=x*view.forward.x+y*view.forward.y+z*view.forward.z;
  if(depth<=.05||x*x+y*y+z*z>maxDistance*maxDistance)return false;
  const tan=Math.tan(view.verticalFov*Math.PI/360);
  return Math.abs(x*view.right.x+y*view.right.y+z*view.right.z)<depth*tan*view.aspect
    &&Math.abs(x*view.up.x+y*view.up.y+z*view.up.z)<depth*tan;
}

type Interval=[number,number];
function slab(start:number,delta:number,low:number,high:number,range:Interval):boolean{
  if(Math.abs(delta)<1e-9)return start>=low&&start<=high;
  let a=(low-start)/delta,b=(high-start)/delta;if(a>b)[a,b]=[b,a];
  range[0]=Math.max(range[0],a);range[1]=Math.min(range[1],b);return range[0]<=range[1];
}
function horizontalInterval(c:SolidCollider,origin:ViewVector,dx:number,dz:number):Interval|undefined{
  if(c.kind==='box'){
    const co=Math.cos(c.yaw),si=Math.sin(c.yaw),x=origin.x-c.x,z=origin.z-c.z,range:Interval=[0,1];
    return slab(x*co-z*si,dx*co-dz*si,-c.halfX,c.halfX,range)&&slab(x*si+z*co,dx*si+dz*co,-c.halfZ,c.halfZ,range)?range:undefined;
  }
  const ranges:Interval[]=[],a=dx*dx+dz*dz;
  for(const [x,z] of [[c.ax,c.az],[c.bx,c.bz]]){
    const ox=origin.x-x,oz=origin.z-z,b=2*(ox*dx+oz*dz),cc=ox*ox+oz*oz-c.radius*c.radius,disc=b*b-4*a*cc;
    if(a<1e-9){if(cc<=0)ranges.push([0,1]);}
    else if(disc>=0){const root=Math.sqrt(disc);ranges.push([(-b-root)/(2*a),(-b+root)/(2*a)]);}
  }
  const sx=c.bx-c.ax,sz=c.bz-c.az,length=Math.hypot(sx,sz);
  if(length>1e-8){
    const ux=sx/length,uz=sz/length,ox=origin.x-c.ax,oz=origin.z-c.az,range:Interval=[0,1];
    if(slab(ox*ux+oz*uz,dx*ux+dz*uz,0,length,range)&&slab(-ox*uz+oz*ux,-dx*uz+dz*ux,-c.radius,c.radius,range))ranges.push(range);
  }
  if(!ranges.length)return undefined;
  const low=Math.max(0,Math.min(...ranges.map(r=>r[0]))),high=Math.min(1,Math.max(...ranges.map(r=>r[1])));
  return low<=high?[low,high]:undefined;
}

/** Height-aware LOS. The broadphase is shared for all silhouette probes;
 * only intersected mesh supports are sampled, so bridge underpasses stay open. */
export function sightlineClear(origin:ViewVector,target:ViewVector,heightAt:(x:number,z:number)=>number,solids:readonly SolidCollider[]){
  const dx=target.x-origin.x,dy=target.y-origin.y,dz=target.z-origin.z,length=Math.hypot(dx,dy,dz);
  const steps=Math.ceil(length/.55);
  for(let i=1;i<steps;i++){const t=i/steps;if(heightAt(origin.x+dx*t,origin.z+dz*t)>origin.y+dy*t-.035)return false;}
  for(const c of solids){
    if(c.tag?.startsWith('creature')||c.tag==='twig')continue;
    const range=horizontalInterval(c,origin,dx,dz);if(!range||!slab(origin.y,dy,c.minY,c.maxY,range))continue;
    range[0]=Math.max(range[0],.012);range[1]=Math.min(range[1],.985);if(range[0]>range[1])continue;
    if(!c.surfaceHeight)return false;
    const samples=Math.max(2,Math.ceil((range[1]-range[0])*length/.12));
    for(let i=0;i<=samples;i++){
      const t=range[0]+(range[1]-range[0])*i/samples,x=origin.x+dx*t,z=origin.z+dz*t;
      const surface=c.surfaceHeight(x,z);if(surface!==undefined&&origin.y+dy*t<surface-.015)return false;
    }
  }
  return true;
}

/** One sustained recognition and at most three quiet prompts per encounter.
 * Unseen encounters never time out; their repositioning is separately gated
 * by the conservative off-screen protection in encounters.ts. */
export function createEncounterAwareness(random= Math.random){
  let age=0,exposure=0,witnessedAt:number|undefined,prompts=0,nextPrompt=0,revealPlayed=false;
  function reset(){age=exposure=prompts=0;witnessedAt=undefined;nextPrompt=7+random()*4;revealPlayed=false;}
  reset();
  return {
    reset,
    update(dt:number,directlyVisible:boolean){
      const safeDt=Math.max(0,Math.min(dt,.1));age+=safeDt;
      exposure=directlyVisible?exposure+safeDt:0;
      if(witnessedAt===undefined&&exposure>=.18)witnessedAt=age;
    },
    promptDue(){return witnessedAt===undefined&&prompts<3&&age>=nextPrompt;},
    prompted(){prompts++;nextPrompt=age+18+random()*8;},
    revealDue(directlyVisible:boolean){return witnessedAt!==undefined&&!revealPlayed&&directlyVisible;},
    revealed(){revealPlayed=true;},
    get witnessed(){return witnessedAt!==undefined;},
    get seenFor(){return witnessedAt===undefined?0:age-witnessedAt;},
    get age(){return age;},
    inspect(){return{age,directExposure:exposure,witnessed:witnessedAt!==undefined,witnessedAt,seenFor:witnessedAt===undefined?0:age-witnessedAt,prompts,revealPlayed,nextPrompt};},
  };
}
