import type {SolidCollider} from './collision';

type Point={x:number;y:number;z:number};
type Box=Extract<SolidCollider,{kind:'box'}>;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const distance=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
/** A surface path is sampled once when approaching a building. Travel uses arc
 * length, so vertical walls never become a teleport or a stop-and-turn. */
export function createSurfaceClimb(hull:Box,start:Point,dx:number,dz:number,ground:(x:number,z:number)=>number){
  if(!hull.surfaceHeight)return undefined;
  const co=Math.cos(hull.yaw),si=Math.sin(hull.yaw);
  const local=(p:Point)=>({x:(p.x-hull.x)*co-(p.z-hull.z)*si,y:p.y,z:(p.x-hull.x)*si+(p.z-hull.z)*co});
  const world=(x:number,y:number,z:number):Point=>({x:hull.x+x*co+z*si,y,z:hull.z-x*si+z*co});
  const p=local(start),vx=dx*co-dz*si,vz=dx*si+dz*co;
  let enter=-Infinity,exit=Infinity;
  for(const [a,v,half] of [[p.x,vx,hull.halfX],[p.z,vz,hull.halfZ]]){
    if(Math.abs(v)<1e-6){if(Math.abs(a)>half)return undefined;continue;}
    const a0=(-half-a)/v,a1=(half-a)/v;enter=Math.max(enter,Math.min(a0,a1));exit=Math.min(exit,Math.max(a0,a1));
  }
  if(enter<0||enter>4.5||exit-enter<2||exit>35)return undefined;
  const at=(t:number)=>world(p.x+vx*t,0,p.z+vz*t);
  const roof=(q:Point)=>hull.surfaceHeight!(q.x,q.z);
  const near=at(enter+.06),far=at(exit-.06),nearTop=roof(near),farTop=roof(far);
  if(nearTop===undefined||farTop===undefined||nearTop-ground(near.x,near.z)<1)return undefined;
  const nodes:Point[]=[{...start}];
  const base=at(enter-.08);base.y=ground(base.x,base.z);nodes.push(base,{...base,y:nearTop+.04});
  for(let t=enter+.06;t<exit-.06;t+=.35){const q=at(t),y=roof(q);if(y===undefined)return undefined;q.y=y+.04;nodes.push(q);}
  const end=at(exit+.08);nodes.push({...end,y:farTop+.04});end.y=ground(end.x,end.z);nodes.push(end);
  const away=at(exit+2);away.y=ground(away.x,away.z);nodes.push(away);
  // Round the four transitions in space, staying on the outside of the hull.
  // Feet still project onto the actual wall/roof; the torso rolls over the edge.
  const points:Point[]=[nodes[0]];
  for(let i=1;i<nodes.length-1;i++){
    const a=nodes[i-1],b=nodes[i],c=nodes[i+1],ab=distance(a,b),bc=distance(b,c),cut=Math.min(.55,ab*.3,bc*.3);
    const u={x:mix(b.x,a.x,cut/ab),y:mix(b.y,a.y,cut/ab),z:mix(b.z,a.z,cut/ab)},v={x:mix(b.x,c.x,cut/bc),y:mix(b.y,c.y,cut/bc),z:mix(b.z,c.z,cut/bc)};
    points.push(u);
    for(let j=1;j<=5;j++){const t=j/5,s=1-t;points.push({x:s*s*u.x+2*s*t*b.x+t*t*v.x,y:s*s*u.y+2*s*t*b.y+t*t*v.y,z:s*s*u.z+2*s*t*b.z+t*t*v.z});}
  }
  points.push(nodes[nodes.length-1]);
  const lengths=[0];for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+distance(points[i-1],points[i]));
  const total=lengths[lengths.length-1];let progress=0;
  function sample(s:number){s=clamp(s,0,total);let i=1;while(i<lengths.length-1&&lengths[i]<s)i++;const t=(s-lengths[i-1])/Math.max(1e-7,lengths[i]-lengths[i-1]),a=points[i-1],b=points[i];return{x:mix(a.x,b.x,t),y:mix(a.y,b.y,t),z:mix(a.z,b.z,t)};}
  function frame(){const a=sample(progress-.32),b=sample(progress+.32),l=distance(a,b)||1;const forward={x:(b.x-a.x)/l,y:(b.y-a.y)/l,z:(b.z-a.z)/l};return{forward,up:{x:-dx*forward.y,y:Math.hypot(forward.x,forward.z),z:-dz*forward.y}};}
  /** Nearest contact among the roof, four walls and surrounding ground. This
   * lets front and rear feet occupy different faces during an edge transition. */
  function contact(target:Point){
    const q=local(target),cx=clamp(q.x,-hull.halfX,hull.halfX),cz=clamp(q.z,-hull.halfZ,hull.halfZ);
    const g={x:target.x,y:ground(target.x,target.z),z:target.z};let point=g,normal={x:0,y:1,z:0},best=distance(g,target);
    const offer=(p:Point,n:Point)=>{const d=distance(p,target);if(d<best){best=d;point=p;normal=n;}};
    const r=world(cx,0,cz),ry=roof(r);
    if(ry!==undefined){
      r.y=ry;const e=.15,hx0=roof({...r,x:r.x-e})??ry,hx1=roof({...r,x:r.x+e})??ry,hz0=roof({...r,z:r.z-e})??ry,hz1=roof({...r,z:r.z+e})??ry;
      const nx=hx0-hx1,nz=hz0-hz1,l=Math.hypot(nx,.3,nz);offer(r,{x:nx/l,y:.3/l,z:nz/l});
    }
    for(const [x,z,nx,nz] of [[-hull.halfX,cz,-1,0],[hull.halfX,cz,1,0],[cx,-hull.halfZ,0,-1],[cx,hull.halfZ,0,1]]){
      const w=world(x,0,z),inside=world(x-nx*.08,0,z-nz*.08),top=roof(inside);if(top===undefined)continue;
      w.y=clamp(target.y,ground(w.x,w.z),Math.min(top,hull.minY));offer(w,{x:nx*co+nz*si,y:0,z:-nx*si+nz*co});
    }
    return{point,normal};
  }
  return{hull,total,contact,frame,sample,get done(){return progress>=total-1e-5;},advance(position:Point,speed:number,dt:number){
    // Never run the path ahead of feet that are still supporting the last pose.
    if(distance(position,sample(progress))<.45)progress=Math.min(total,progress+Math.min(speed,4.5)*dt);
    return sample(progress);
  }};
}
