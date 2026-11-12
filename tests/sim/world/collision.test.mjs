import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionWorld,moveCharacter,solidContact} from '../game/collision.ts';
const flat=()=>0;
const rock={kind:'capsule',ax:0,az:0,bx:0,bz:0,radius:1,minY:-.3,maxY:1.4};
test('large rocks and thin fallen logs block without tunnelling at high speeds',()=>{
  const world=createCollisionWorld();world.replace('solids',[rock,{kind:'capsule',ax:2,az:-3,bx:2,bz:3,radius:.16,minY:0,maxY:.7}]);
  let p=moveCharacter({x:-3,y:0,z:0},6,0,1.69,flat,world);assert.ok(p.x<=-1.239);
  p=moveCharacter({x:1.3,y:0,z:2},3,0,1.69,flat,world);assert.ok(p.x<=1.601);
});
test('low debris is stepable, elevated roof permits clearance, and rotated boxes resolve',()=>{
  const world=createCollisionWorld();world.replace('solids',[{...rock,radius:.5,maxY:.12},{kind:'box',x:0,z:3,halfX:1,halfZ:.2,yaw:.7,minY:2,maxY:2.2}]);
  const p=moveCharacter({x:-1,y:0,z:0},1,0,1.69,flat,world);assert.equal(p.y,.12);assert.ok(Math.abs(p.x)<.01);
  const roof=moveCharacter({x:0,y:0,z:2},0,2,1.69,flat,world);assert.ok(roof.z>3.99);
  const box={kind:'box',x:0,z:0,halfX:2,halfZ:.2,yaw:Math.PI/4,minY:0,maxY:2};
  assert.ok(solidContact(box,1,-1,.24).depth>0);assert.ok(solidContact(box,1,1,.24).depth<0);
});
test('mountain slope limit is independent of frame rate, permits contour walking',()=>{
  const world=createCollisionWorld(),terrain=(x)=>Math.max(0,x)*1.4;
  for(const hz of [30,60,144]){let p={x:1,y:1.4,z:0};for(let i=0;i<hz;i++)p=moveCharacter(p,2/hz,1/hz,1.69,terrain,world);assert.ok(p.x<1.001);assert.ok(p.z>.99);}
});
test('streamed collision groups discard old cells and preserve independent groups',()=>{
  const world=createCollisionWorld();world.replace('forest',[rock]);world.replace('story',[{...rock,ax:20,bx:20}]);world.replace('forest',[{...rock,ax:100,bx:100}]);
  assert.equal(world.nearby(0,0).length,0);assert.equal(world.nearby(20,0).length,1);assert.equal(world.stats().solids,2);
});
test('plank colliders below a bridge support surface cannot become invisible side walls',()=>{
  const world=createCollisionWorld();world.replace('bridge',[{kind:'capsule',ax:0,az:-1,bx:0,bz:1,radius:.15,minY:.45,maxY:.60}]);
  const p=moveCharacter({x:-1,y:.61,z:0},2,0,1.69,()=>.61,world);assert.ok(p.x>.99);assert.equal(p.y,.61);
});

test('player walks under an elevated bridge without snapping onto its deck',()=>{
  const world=createCollisionWorld(),deck={kind:'box',x:0,z:0,halfX:6,halfZ:.9,yaw:0,minY:3.7,maxY:4,tag:'bridge deck',surfaceHeight:(x,z)=>Math.abs(x)<=6&&Math.abs(z)<=.9?4:undefined};
  world.replace('bridge',[deck]);let p={x:0,y:-.6,z:-5};
  for(let i=0;i<100;i++){p=moveCharacter(p,0,.1,1.69,()=>-.6,world);assert.equal(p.y,-.6);}
  assert.ok(p.z>4.99);
});
test('player follows a graded bridge layer from its ramp and remains above the channel',()=>{
  const world=createCollisionWorld(),planks=[];
  for(let i=0;i<40;i++){const x=-4+i*.2+.1,top=(x+4)*.12;planks.push({kind:'box',x,z:0,halfX:.11,halfZ:.9,yaw:0,minY:top-.1,maxY:top,tag:'bridge deck',surfaceHeight:(px,pz)=>Math.abs(px-x)<=.11&&Math.abs(pz)<.9?(px+4)*.12:undefined});}
  world.replace('bridge',planks);let p={x:-3.9,y:.012,z:0};
  for(let i=0;i<75;i++){p=moveCharacter(p,.1,0,1.69,()=>-1,world);assert.ok(p.y>=(p.x+4)*.12-1e-6&&p.y<(p.x+4)*.12+.03);}
  assert.ok(p.x>3.59);
});

test('a player sole straddles a missing bridge board using adjacent real surfaces',()=>{
  const world=createCollisionWorld();world.replace('bridge',[-1,1].map(side=>({kind:'box',x:side*1.09,z:0,halfX:.91,halfZ:1,yaw:0,minY:.9,maxY:1,tag:'bridge deck',surfaceHeight:(x,z)=>Math.abs(x-side*1.09)<=.91&&Math.abs(z)<=1?1:undefined})));
  let p={x:-1,y:1,z:0};for(let i=0;i<80;i++){p=moveCharacter(p,.025,0,1.69,()=>-2,world);assert.equal(p.y,1);}assert.ok(p.x>.99);
});

test('pose-driven diagonal capsules only block where their centerline reaches the player height',()=>{
  const world=createCollisionWorld();
  world.replace('creature',[{kind:'capsule',ax:0,az:0,bx:2,bz:0,radius:.18,minY:0,maxY:3,heightAt:x=>x*1.5,tag:'creature lower limb'}]);
  const low=moveCharacter({x:.2,y:0,z:-1},0,2,1.69,()=>0,world);
  assert.ok(low.z<.01,'a low foot segment still collides');
  const high=moveCharacter({x:1.8,y:0,z:-1},0,2,1.69,()=>0,world);
  assert.ok(high.z>0.99,'the raised knee does not become a vertical wall');
});
