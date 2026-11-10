import * as THREE from 'three';
export type ClimbTree={x:number;z:number;ground:number;radius:number;height:number};
export const TREE_SPIRAL_TURN=6.24;
export const TREE_CRAWL_SPEED=1.4;
const smooth=(v:number)=>{const t=THREE.MathUtils.clamp(v,0,1);return t*t*t*(t*(t*6-15)+10);};
/** World-locked bark contacts. A six-beat wave keeps at least four legs attached.
 * `speed` (m/s, default TREE_CRAWL_SPEED) and `turn` (radians it spirals round the trunk on the way down, default
 * TREE_SPIRAL_TURN) let it drop fast and straight instead. */
export function createTreeCrawl(tree:ClimbTree,angle:number,rests:THREE.Vector3[],contact:(angle:number,y:number)=>THREE.Vector3,ground:(x:number,z:number)=>number,options:{speed?:number;turn?:number;perch?:number}={}){
 const SPEED=options.speed??TREE_CRAWL_SPEED,TURN=options.turn??TREE_SPIRAL_TURN,pace=Math.max(.35,Math.min(1,TREE_CRAWL_SPEED/SPEED));
 const position=new THREE.Vector3(),rotation=new THREE.Quaternion(),basis=new THREE.Matrix4(),normal=new THREE.Vector3(),right=new THREE.Vector3(),down=new THREE.Vector3(0,-1,0),upright=new THREE.Quaternion(),barkOrigin=new THREE.Vector3();
 const feet=rests.map(()=>({position:new THREE.Vector3(),from:new THREE.Vector3(),target:new THREE.Vector3(),swing:1,duration:.38,grounded:false}));
 // `perch` (metres above the ground) puts it lower, below a crown that would hide it.
 const perchHeight=options.perch??THREE.MathUtils.clamp(tree.height*.6,14,20),duration=(perchHeight-3.2)/SPEED;
 // The model's torso sits ~1.9 m along local Y from its root. Inset that
 // origin so the torso hugs the bark; foot contacts still use the bark frame.
 const inset=.85;
 // Arc-length parameterization keeps the landing moving at the same pace as
 // the descent, instead of easing to a stop or waiting for a six-foot pose.
 const exitNormal=new THREE.Vector3(Math.cos(angle+TURN),0,Math.sin(angle+TURN));
 const landingStart=contact(angle+TURN,tree.ground+3.2).addScaledVector(exitNormal,-inset);
 const landingPath=(t:number)=>{const p=landingStart.clone().addScaledVector(exitNormal,t*(4+inset));p.y=THREE.MathUtils.lerp(tree.ground+3.2,ground(p.x,p.z),1-(1-t)**2);return p;};
 const distances=[0];let last=landingPath(0);
 for(let i=1;i<=64;i++){const p=landingPath(i/64);distances.push(distances[i-1]+p.distanceTo(last));last=p;}
 const landingDuration=distances[64]/SPEED;
 function landingProgress(){const distance=Math.min(distances[64],landing*SPEED);let i=1;while(i<64&&distances[i]<distance)i++;return ((i-1)+(distance-distances[i-1])/Math.max(.0001,distances[i]-distances[i-1]))/64;}
 let age=0,descending=false,landing=0,next=0;
 const shoulders=rests.map((_,i)=>new THREE.Vector3((i<3?-1:1)*(.85+i%3*.1),2.43+(i%3===1?.38:0),.8-i%3*.85));
 const shoulderWorld=new THREE.Vector3();
 const reach=(i:number)=>shoulderWorld.copy(shoulders[i]).applyQuaternion(rotation).add(position).distanceTo(feet[i].position);
 const order=[0,4,2,3,1,5];let cursor=0;
 function pose(){
  const progress=Math.min(1,age/duration),turn=angle+progress*TURN,h=tree.ground+THREE.MathUtils.lerp(perchHeight,3.2,progress);
  normal.set(Math.cos(turn),0,Math.sin(turn));right.crossVectors(normal,down).normalize();
  basis.makeBasis(right,normal,down);rotation.setFromRotationMatrix(basis);
  barkOrigin.copy(contact(turn,h));position.copy(barkOrigin).addScaledVector(normal,-inset);
  if(landing>0){
   const t=landingProgress();
   position.addScaledVector(normal,t*(4+inset));
   position.y=THREE.MathUtils.lerp(h,ground(position.x,position.z),1-(1-t)**2);
   upright.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,Math.atan2(normal.x,normal.z));rotation.slerp(upright,smooth(t));
  }
 }
 function target(i:number){
  const rest=rests[i].clone();rest.z*=THREE.MathUtils.lerp(1.30,1,smooth(landingProgress()));
  const p=rest.applyQuaternion(rotation).add(position);
  // Transfer each pair in order as the body unfolds. Never teleport a planted
  // contact; it changes surfaces only through the ordinary lifted step.
  if(landingProgress()>.18+order.indexOf(i)*.055)return p.setY(ground(p.x,p.z)+.035);
  p.addScaledVector(normal,inset*(1-smooth(landingProgress())));
  return contact(Math.atan2(p.z-tree.z,p.x-tree.x),Math.max(tree.ground+.08,p.y));
 }
 pose();feet.forEach((f,i)=>f.position.copy(target(i)));
 return {position,rotation,feet,perchHeight,get descending(){return descending;},get landing(){return landing;},get landingBlend(){return smooth(landingProgress());},get done(){return landing>=landingDuration;},start(visible:boolean){if(visible)descending=true;},
 update(dt:number){
  dt=Math.max(0,Math.min(dt,.1));
  if(descending){
   if(age<duration)age=Math.min(duration,age+dt);else landing=Math.min(landingDuration,landing+dt);
  }
  pose();next-=dt;
  if(descending&&next<=0&&feet.filter(f=>f.swing<1).length<(landing>0?3:2)){
   const candidates=order.map((_,j)=>order[(cursor+j)%6]);
   candidates.sort((a,b)=>Math.max(0,reach(b)-3.8)-Math.max(0,reach(a)-3.8));
   for(const i of candidates){const f=feet[i],p=target(i),onGround=landingProgress()>.18+order.indexOf(i)*.055;
    if(f.swing===1&&(p.distanceTo(f.position)>.18||onGround&&!f.grounded)){
     f.duration=onGround?Math.min(.48,.22+p.distanceTo(f.position)*.04)*pace:.26*pace;f.from.copy(f.position);f.target.copy(p);f.swing=0;f.grounded=onGround;cursor=(order.indexOf(i)+1)%6;next=.055*pace;break;
    }
   }
  }
  for(const f of feet)if(f.swing<1){
   f.swing=Math.min(1,f.swing+dt/f.duration);const t=f.swing;
   f.position.lerpVectors(f.from,f.target,smooth(t));
   const arc=Math.sin(t*Math.PI)**2,out=new THREE.Vector3(f.position.x-tree.x,0,f.position.z-tree.z).normalize();
   f.position.addScaledVector(out,arc*.12*(1-smooth(landingProgress())));
   if(f.grounded)f.position.y+=arc*.30;
   if(t===1)f.position.copy(f.target);
  }
 }};
}
