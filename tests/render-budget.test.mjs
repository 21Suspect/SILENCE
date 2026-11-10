import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderBudget } from '../game/quality.ts';

test('high-DPI displays remain within the two-million-pixel render budget',()=>{
  for(const [width,height] of [[1440,900],[2560,1440],[3840,2160]]){
    const budget=createRenderBudget(2),ratio=budget.resize(width,height);
    assert.ok(width*height*ratio*ratio<=2_000_001);
    assert.ok(ratio<=1.4);
  }
});

test('one streaming hitch does not lower quality; sustained overload does',()=>{
  const budget=createRenderBudget(2),initial=budget.resize(1440,900);
  let now=0,last=initial;
  for(let i=0;i<180;i++){now+=16.67;assert.equal(budget.update(16.67,now),undefined);}
  now+=70;assert.equal(budget.update(70,now),undefined);
  for(let i=0;i<190;i++){now+=32;last=budget.update(32,now)??last;}
  assert.ok(last<initial);
  assert.ok(last>=initial*.45);
  const lowered=last;
  for(let i=0;i<1600;i++){now+=16.67;last=budget.update(16.67,now)??last;}
  assert.ok(last>lowered,'quality should recover after prolonged frame headroom');
  assert.ok(last<=initial);
});


test('severe sustained lag still reduces quality, while focus pauses do not',()=>{
 const b=createRenderBudget(2);b.resize(390,844);let now=0;
 for(let i=0;i<160;i++){now+=100;b.update(100,now);}
 assert.ok(b.inspect().scale<.65);
 const before=b.inspect().scale;b.update(5000,now+5000);assert.equal(b.inspect().scale,before);
});
test('returning from 120 Hz to a steady 60 Hz keeps full render quality',()=>{
 const b=createRenderBudget(1);b.resize(1920,1080);let now=0;
 for(let i=0;i<600;i++){now+=1000/120;b.update(1000/120,now);}
 assert.equal(b.inspect().targetFps,60);assert.equal(b.inspect().scale,1);
 for(let i=0;i<1800;i++){now+=1000/60;assert.equal(b.update(1000/60,now),undefined);}
 assert.equal(b.inspect().scale,1);
});

test('resizing on another display uses its current pixel ratio',()=>{
 const b=createRenderBudget(1);
 assert.equal(b.resize(800,600),1);
 assert.equal(b.resize(800,600,2),1.4);
 assert.equal(b.resize(800,600,.9),.9);
});
