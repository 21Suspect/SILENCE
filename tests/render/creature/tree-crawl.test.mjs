import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createTreeCrawl} from '../../../game/render/creature/tree-crawl.ts';
const rests=[];
for(const side of [-1,1])for(let i=0;i<3;i++)rests.push(new THREE.Vector3(side*(2.22+i*.16),.035,i===0?2.02:i===1?.05:-1.90));
const make=(radius=.7,height=30,ground=()=>0)=>createTreeCrawl({x:0,z:0,ground:0,radius,height},0,rests,(a,y)=>new THREE.Vector3(Math.cos(a)*radius,y,Math.sin(a)*radius),ground);
test('high perch waits indefinitely for actual visibility, with torso close to bark',()=>{
 for(const height of [22,30,45]){
  const c=make(.7,height),p=c.position.clone();
  assert.ok(p.y>=14&&p.y<=20);
  const torso=new THREE.Vector3(0,1.88,0).applyQuaternion(c.rotation).add(p);
  assert.ok(Math.hypot(torso.x,torso.z)-.7<1.1);
  for(let i=0;i<1000;i++){c.start(false);c.update(.1);}
  assert.equal(c.descending,false);assert.ok(c.position.equals(p));
  c.start(true);for(let i=0;i<60;i++)c.update(1/60);
  assert.equal(c.descending,true);assert.ok(c.position.y<p.y);
 }
});
test('crawl and landing retain stable support contacts, respect reach, and finish upright on the ground',()=>{
 for(const radius of [.44,.7,1.2])for(const hz of [30,60,120]){
  const c=make(radius),ground=()=>0;c.start(true);let maxReach=0,minReach=Infinity,maxFootStep=0,maxRootStep=0;
  for(let frame=0;frame<hz*65;frame++){
   const old=c.feet.map(f=>({p:f.position.clone(),s:f.swing})),oldRoot=c.position.clone();c.update(1/hz);
   assert.ok(c.feet.filter(f=>f.swing<1).length<=(c.landing>0?3:2));
   maxRootStep=Math.max(maxRootStep,c.position.distanceTo(oldRoot)*hz);
   for(let i=0;i<6;i++){
    const f=c.feet[i];if(old[i].s===1&&f.swing===1)assert.ok(f.position.equals(old[i].p));
    maxFootStep=Math.max(maxFootStep,f.position.distanceTo(old[i].p)*hz);
    assert.ok(f.position.toArray().every(Number.isFinite));
    const side=i<3?-1:1,j=i%3,shoulder=new THREE.Vector3(side*(.85+j*.1),2.43+(j===1?.38:0),.8-j*.85).applyQuaternion(c.rotation).add(c.position);
    const reach=shoulder.distanceTo(f.position);maxReach=Math.max(maxReach,reach);minReach=Math.min(minReach,reach);
   }
  }
  assert.ok(c.done);assert.ok(Math.abs(c.position.y)<1e-8);
  assert.ok(maxReach<4.6,`maximum leg reach ${maxReach}`);
  assert.ok(minReach>1.6,`minimum leg reach ${minReach}`);
  assert.ok(maxRootStep<2.5,`body speed ${maxRootStep}`);
  assert.ok(maxFootStep<25,`foot speed ${maxFootStep}`);
  const up=new THREE.Vector3(0,1,0).applyQuaternion(c.rotation);assert.ok(up.distanceTo(new THREE.Vector3(0,1,0))<1e-8);
  for(const f of c.feet)assert.ok(Math.abs(f.position.y-ground(f.position.x,f.position.z)-.035)<.01);
 }
});

test('descent flows through a constant-speed dismount with a bounded completion time',()=>{
 for(const hz of [30,60,120]){
  const c=make();c.start(true);let time=0,landingAt=0,minLandingSpeed=Infinity,maxLandingSpeed=0;
  while(!c.done&&time<30){const previous=c.position.clone(),wasLanding=c.landing>0;c.update(1/hz);time+=1/hz;if(c.landing>0&&!landingAt)landingAt=time;
   if(wasLanding&&!c.done){const speed=c.position.distanceTo(previous)*hz;minLandingSpeed=Math.min(minLandingSpeed,speed);maxLandingSpeed=Math.max(maxLandingSpeed,speed);}
  }
  assert.ok(c.done&&time<17,`encounter must not stall on the trunk: ${time}`);
  assert.ok(time-landingAt<5,'landing must not wait on planted feet');
  assert.ok(minLandingSpeed>1.37&&maxLandingSpeed<1.43,`constant landing speed ${minLandingSpeed}–${maxLandingSpeed}`);
 }
});
