import test from 'node:test';
import assert from 'node:assert/strict';
import {creatureInView,createOffscreenLatch,OFFSCREEN_GRACE} from '../../../game/sim/creature/encounter-visibility.ts';
const view={position:{x:0,y:1.7,z:0},forward:{x:0,y:0,z:-1},right:{x:1,y:0,z:0},up:{x:0,y:1,z:0},verticalFov:69,aspect:16/9};
test('view protection has no distance or fog exemption and includes the limbs at screen edges',()=>{
  for(const distance of [10,32,100,2000,100000])assert.ok(creatureInView(view,{x:0,y:2,z:-distance}));
  const edge=Math.tan(69*Math.PI/360)*16/9*25;
  assert.ok(creatureInView(view,{x:edge+5,y:2,z:-25}),'a center outside the image still has visible legs');
  assert.equal(creatureInView(view,{x:0,y:2,z:20}),false);
  assert.ok(creatureInView(view,{x:0,y:2,z:2}),'nearby bounds enveloping the camera must be protected');
});
test('aspect ratio and pitched cameras protect wide-screen and vertical visibility',()=>{
  const point={x:37,y:2,z:-25};assert.equal(creatureInView({...view,aspect:.6},point),false);assert.ok(creatureInView({...view,aspect:3.6},point));
  const upward={...view,forward:{x:0,y:1,z:0},up:{x:0,y:0,z:1}};
  assert.ok(creatureInView(upward,{x:0,y:35,z:0}));assert.equal(creatureInView(upward,{x:0,y:-35,z:0}),false);
});
test('offscreen removal requires sustained exclusion and resets on every glance',()=>{
  const latch=createOffscreenLatch();for(let i=0;i<600;i++)assert.equal(latch.update(true,1/60),false);
  for(let i=0;i<20;i++)assert.equal(latch.update(false,1/60),false);
  assert.equal(latch.update(true,1/60),false);assert.equal(latch.outsideSeconds,0);
  for(let i=0;i<Math.ceil(OFFSCREEN_GRACE*60)-1;i++)assert.equal(latch.update(false,1/60),false);
  assert.equal(latch.update(false,1/60),true);
  latch.reset();assert.equal(latch.update(false,30),false,'tab suspension cannot skip the grace period');
});

test('a creature visible only in the water reflection is still protected',()=>{
  const down={...view,forward:{x:0,y:-.8,z:-.6},up:{x:0,y:.6,z:-.8},verticalFov:40};
  const reflected={...down,position:{x:0,y:-4,z:0},forward:{x:0,y:.8,z:-.6},up:{x:0,y:-.6,z:-.8}};
  const point={x:0,y:15,z:-18};assert.equal(creatureInView(down,point),false);
  assert.ok(creatureInView({...down,reflected},point));
});
