import test from 'node:test';
import assert from 'node:assert/strict';
import {createArticulationPose,updateArticulationPose,createSpiderGaze,advanceSpiderGaze} from '../game/creature-articulation.ts';
test('joint targets remain anatomically bounded through long idle and running sequences',()=>{
  const p=createArticulationPose();let asymmetry=0;
  for(let i=0;i<2400;i++){
    updateArticulationPose(p,i/10,(i%100)/100,{turnRate:Math.sin(i)*3});
    for(const [name,a] of Object.entries(p)){assert.ok(Object.values(a).every(Number.isFinite));assert.ok(Math.abs(a.x)<1.1&&Math.abs(a.y)<.5&&Math.abs(a.z)<.25,`${name} outside articulation limits`);}
    asymmetry=Math.max(asymmetry,Math.abs(p.finger_L0.x-p.finger_R0.x));
  }
  assert.ok(asymmetry>.25,'hands should not pulse in sync');
});
test('gaze follows a local attention target while clamping impossible backward turns',()=>{
  const p=createArticulationPose();updateArticulationPose(p,0,0,{lookTarget:{x:5,y:2,z:7}});assert.ok(p.head.y>.2);assert.ok(p.head.x<0);
  updateArticulationPose(p,0,0,{lookTarget:{x:-5,y:2,z:7}});assert.ok(p.head.y<-.2);
  updateArticulationPose(p,0,0,{lookTarget:{x:50,y:100,z:-8}});assert.ok(Math.abs(p.head.y+p.neck.y)<=.481);assert.ok(Math.abs(p.head.x+p.neck.x)<=.24);
});
test('independent held intentions remain continuous at schedule boundaries',()=>{
  const a=createArticulationPose(),b=createArticulationPose();let maximum=0;
  for(let t=0;t<80;t+=.031){updateArticulationPose(a,t,0);updateArticulationPose(b,t+.0001,0);for(const name of Object.keys(a))maximum=Math.max(maximum,...['x','y','z'].map(axis=>Math.abs(a[name][axis]-b[name][axis])));}
  assert.ok(maximum<.001,`target discontinuity ${maximum}`);
});

test('a watched target produces long still intervals rather than continuous idle dancing',()=>{
  const a=createArticulationPose(),b=createArticulationPose(),attention={lookTarget:{x:0,y:1.43,z:5}};let quiet=0,total=0;
  for(let i=1;i<7200;i++){updateArticulationPose(a,i/60,0,attention);updateArticulationPose(b,(i-1)/60,0,attention);
    const change=Math.max(...Object.keys(a).flatMap(n=>['x','y','z'].map(axis=>Math.abs(a[n][axis]-b[n][axis]))));if(change<.00001)quiet++;total++;}
  assert.ok(quiet/total>.5,`only ${quiet/total} of idle frames were held still`);
});
test('small gaze movements are held, then reacquired; large movements stay responsive',()=>{
  const s=createSpiderGaze(),origin={x:0,y:1.43,z:5};advanceSpiderGaze(s,origin,0,0,0,1/60);
  for(let i=1;i<=20;i++)advanceSpiderGaze(s,{x:.2,y:1.43,z:5},0,0,i/60,1/60);
  assert.equal(s.yaw,0,'small target movements should not cause continual head sway');
  for(let i=21;i<=50;i++)advanceSpiderGaze(s,{x:4,y:1.43,z:5},0,0,i/60,1/60);
  assert.ok(s.yaw>.46&&s.yaw<=.48,'an obvious change should reacquire within half a second');
});
test('held gaze compensates for body turns and resets safely after time discontinuities',()=>{
  const s=createSpiderGaze();advanceSpiderGaze(s,{x:0,y:1.43,z:5},0,0,1,1/60);
  advanceSpiderGaze(s,{x:-.02,y:1.43,z:5},.6,0,1+1/60,1/60);assert.ok(s.yaw<-.009,'head counter-rotates during a held stare');
  advanceSpiderGaze(s,{x:0,y:1.43,z:5},0,0,0,1/60);assert.equal(s.yaw,0);assert.ok(Number.isFinite(s.pitch));
});
