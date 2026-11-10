import * as THREE from 'three';

export type FootState={position:THREE.Vector3,from:THREE.Vector3,target:THREE.Vector3,progress:number,swinging:boolean,group:number;lift:number;duration:number;delay:number;bowX:number;bowZ:number;smoothArc?:boolean;};
/** Feet are stored in world space. Only an explicit swing can move a contact. */
export function createFoot(rest:THREE.Vector3,group:number):FootState{return{position:rest.clone(),from:rest.clone(),target:rest.clone(),progress:1,swinging:false,group,lift:0,duration:0,delay:0,bowX:0,bowZ:0};}
export function swingFoot(foot:FootState,target:THREE.Vector3,lift=0,duration=0,delay=0,bowX=0,bowZ=0){foot.smoothArc=false;foot.from.copy(foot.position);foot.target.copy(target);foot.progress=0;foot.swinging=true;foot.lift=lift;foot.duration=duration;foot.delay=delay;foot.bowX=bowX;foot.bowZ=bowZ;}
export function advanceFoot(foot:FootState,dt:number,duration:number,lift:number,heightAt:(x:number,z:number)=>number){
  if(!foot.swinging)return;
  if(foot.delay>0){foot.delay=Math.max(0,foot.delay-dt);return;}
  duration=foot.duration||duration;lift=Math.max(lift,foot.lift);
  foot.progress=Math.min(1,foot.progress+dt/duration);
  const t=foot.progress,s=t*t*t*(t*(t*6-15)+10);
  foot.position.lerpVectors(foot.from,foot.target,s);
  const hook=Math.sin(Math.PI*t)**2;foot.position.x+=foot.bowX*hook;foot.position.z+=foot.bowZ*hook;
  foot.position.y=Math.max(foot.position.y+Math.pow(Math.sin(Math.PI*t),foot.smoothArc?2:.82)*lift,heightAt(foot.position.x,foot.position.z)+.035);
  if(t===1){foot.position.copy(foot.target);foot.swinging=false;}
}
/** A fixed-length two-bone solve with a preferred outward joint bend. */
export function solveLeg(start:THREE.Vector3,end:THREE.Vector3,pole:THREE.Vector3,upper:number,lower:number,out:THREE.Vector3){
  const axis=end.clone().sub(start),distance=Math.max(.0001,axis.length());axis.divideScalar(distance);
  const bend=pole.clone().sub(start);bend.addScaledVector(axis,-bend.dot(axis));
  if(bend.lengthSq()<1e-6)bend.set(1,0,0).addScaledVector(axis,-axis.x);
  bend.normalize();
  const d=THREE.MathUtils.clamp(distance,Math.abs(upper-lower)+.0001,upper+lower-.0001);
  const along=(upper*upper-lower*lower+d*d)/(2*d),height=Math.sqrt(Math.max(0,upper*upper-along*along));
  return out.copy(start).addScaledVector(axis,along).addScaledVector(bend,height);
}
