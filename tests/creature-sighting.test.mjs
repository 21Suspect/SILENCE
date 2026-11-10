import test from 'node:test';
import assert from 'node:assert/strict';
import {inDirectView,sightlineClear,createEncounterAwareness} from '../game/creature-sighting.ts';
const flat=()=>0;
const view={position:{x:0,y:1.7,z:0},forward:{x:0,y:0,z:-1},right:{x:1,y:0,z:0},up:{x:0,y:1,z:0},verticalFov:69,aspect:16/9};
const target={x:0,y:1.7,z:-20};
const tree=(x,z,radius=.3)=>({kind:'capsule',ax:x,az:z,bx:x,bz:z,radius,minY:0,maxY:25,tag:'tree'});
test('recognition uses actual image, distance and camera pitch; reflection alone never counts',()=>{
  assert.ok(inDirectView(view,target));assert.equal(inDirectView(view,{x:0,y:1.7,z:-32}),false);
  const edge=Math.tan(69*Math.PI/360)*view.aspect*20;
  assert.equal(inDirectView(view,{...target,x:edge+.01}),false);
  const away={...view,forward:{x:0,y:0,z:1},reflected:view};assert.equal(inDirectView(away,target),false);
  assert.equal(inDirectView(view,{x:0,y:40,z:-10}),false);
});
test('thin trunks and diagonal deadfall block lines without sampling gaps',()=>{
  assert.equal(sightlineClear(view.position,target,flat,[tree(0,-10,.015)]),false);
  assert.ok(sightlineClear(view.position,target,flat,[tree(.5,-10,.3)]));
  const deadfall={kind:'capsule',ax:-2,az:-9,bx:2,bz:-11,radius:.12,minY:1.5,maxY:1.9,tag:'fallen log'};
  assert.equal(sightlineClear(view.position,target,flat,[deadfall]),false);
  assert.ok(sightlineClear(view.position,target,flat,[{...deadfall,minY:0,maxY:.5}]));
});
test('mesh-height occlusion respects rounded rocks and open space under bridge deck',()=>{
  const rock={...tree(0,-10,2),maxY:3,tag:'rock',surfaceHeight:(x,z)=>Math.hypot(x,z+10)<1?3:undefined};
  assert.equal(sightlineClear(view.position,target,flat,[rock]),false);
  assert.ok(sightlineClear({x:1.5,y:1.7,z:0},{x:1.5,y:1.7,z:-20},flat,[rock]));
  const bridge={kind:'box',x:0,z:-10,halfX:12,halfZ:.9,yaw:.2,minY:4,maxY:4.3,tag:'bridge deck'};
  assert.ok(sightlineClear(view.position,target,flat,[bridge]));
  assert.equal(sightlineClear(view.position,{x:0,y:7,z:-20},flat,[bridge]),false);
  assert.equal(sightlineClear(view.position,target,(x,z)=>Math.abs(z+10)<1?2:0,[]),false);
});
test('self colliders do not hide the creature from its own recognition probe',()=>{
  assert.ok(sightlineClear(view.position,target,flat,[{...tree(0,-19),tag:'creature leg'}]));
});
test('a partial glance resets recognition; a sustained sighting yields exactly one reveal',()=>{
  const awareness=createEncounterAwareness(()=>.5);
  for(let i=0;i<8;i++)awareness.update(1/60,true);
  assert.equal(awareness.witnessed,false);awareness.update(1/60,false);
  for(let i=0;i<10;i++)awareness.update(1/60,true);
  assert.equal(awareness.witnessed,false);
  awareness.update(1/60,true);assert.ok(awareness.witnessed);
  assert.ok(awareness.revealDue(true));assert.equal(awareness.revealDue(false),false);
  awareness.revealed();for(let i=0;i<500;i++)awareness.update(1/60,i%2===0);
  assert.equal(awareness.revealDue(true),false);awareness.reset();assert.equal(awareness.witnessed,false);
});
test('unseen encounters persist for minutes with restrained, capped directional prompts',()=>{
  const awareness=createEncounterAwareness(()=>.5),prompts=[];
  for(let i=0;i<18000;i++){awareness.update(1/60,false);if(awareness.promptDue()){prompts.push(awareness.age);awareness.prompted();}}
  assert.equal(awareness.witnessed,false);assert.equal(awareness.age>299,true);
  assert.equal(prompts.length,3);assert.ok(Math.abs(prompts[0]-9)<.02);
  for(let i=1;i<prompts.length;i++)assert.ok(prompts[i]-prompts[i-1]>=22);
  for(let i=0;i<12;i++)awareness.update(1/60,true);
  assert.ok(awareness.witnessed);assert.equal(awareness.promptDue(),false);
});
