import './helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createCollisionWorld} from '../game/collision.ts';
const {createCreatureNavigation,obstacleClearance}=await import('../game/creature-navigation.ts');
import {createFoot,swingFoot,advanceFoot} from '../game/creature-gait.ts';
const tree=(x,z,r=.5)=>({kind:'capsule',ax:x,az:z,bx:x,bz:z,radius:r,minY:0,maxY:25,tag:'tree'});
const flat=()=>0;
test('local route goes around a trunk and progresses beyond it without tunneling at running speed',()=>{
  const world=createCollisionWorld(),obstacles=[tree(0,7),tree(-4,12),tree(4,16)];world.replace('forest',obstacles);
  const nav=createCreatureNavigation(flat,world);let p={x:0,y:0,z:0},sideways=0;
  for(let i=0;i<360;i++){p=nav.move(p,0,1,5.5,1/60);sideways=Math.max(sideways,Math.abs(p.x));for(const c of obstacles)assert.ok(obstacleClearance(c,p.x,p.z)>1.14,'body clearance even at corners');}
  assert.ok(sideways>3,'route turns around the first trunk');assert.ok(p.z>22,`must continue into forest, z=${p.z}`);
  assert.ok(nav.inspect().replans<10,'route should not be rebuilt every frame');
});
test('spawn clearance accounts for the full limb envelope and enclosed routes stop safely',()=>{
  const world=createCollisionWorld();world.replace('forest',[tree(0,0)]);const nav=createCreatureNavigation(flat,world);
  const spawn=nav.safeSpawn(0,0);assert.ok(spawn);assert.ok(Math.hypot(spawn.x,spawn.z)>.5+2.6);
  const wall=[];for(let i=-8;i<=8;i++)wall.push(tree(i,5,.6));world.replace('forest',wall);nav.reset();let p={x:0,y:0,z:0};
  for(let i=0;i<40;i++){p=nav.move(p,0,1,8,.1);for(const c of wall)assert.ok(obstacleClearance(c,p.x,p.z)>1.14);}
});
test('rocks and deadfall use visible support surfaces while standing trees remain forbidden contacts',()=>{
  const world=createCollisionWorld();world.replace('objects',[
    {kind:'capsule',ax:0,az:0,bx:0,bz:0,radius:1.3,minY:0,maxY:1.1,tag:'rock',surfaceHeight:(x,z)=>Math.hypot(x,z)<=1?1.1*Math.sqrt(Math.max(0,1-x*x-z*z)):undefined},
    {kind:'capsule',ax:-3,az:4,bx:3,bz:4,radius:.35,minY:0,maxY:.7,tag:'fallen log',surfaceHeight:(x,z)=>Math.abs(z-4)<=.35?.35+Math.sqrt(.35**2-(z-4)**2):undefined},tree(4,0)
  ]);
  const nav=createCreatureNavigation(flat,world);nav.refresh(0,0,0,true);
  assert.equal(nav.supportAt(0,0),1.1);assert.ok(nav.supportAt(.8,0)<.7,'curved rock shoulder must not become a flat lid');assert.equal(nav.supportAt(1.2,0),0,'outside mesh but inside proxy returns ground');
  assert.ok(nav.supportAt(0,4)>.69);const foot=nav.findFoot(4,0,0,0);assert.ok(Math.hypot(foot.x-4,foot.z)>.7);
  let p={x:0,y:0,z:-3},maxY=0;for(let i=0;i<800;i++){p=nav.move(p,0,1,1,1/60);maxY=Math.max(maxY,p.y);}assert.ok(maxY>.5);assert.ok(p.z>8);
});
test('a lifted foot clears a narrow dead log and its landing contact stays locked',()=>{
  const ground=(x)=>Math.abs(x-.5)<.15?.55:0;
  const f=createFoot(new THREE.Vector3(0,.035,0),0),target=new THREE.Vector3(1,.035,0);swingFoot(f,target,.7,.4,.025);
  for(let i=0;i<40;i++){advanceFoot(f,1/60,.4,.2,ground);assert.ok(f.position.y>=ground(f.position.x)+.0349);}
  assert.ok(f.position.equals(target));for(let i=0;i<300;i++)advanceFoot(f,1/60,.4,.2,ground);assert.ok(f.position.equals(target));
});

test('a narrow trunk corridor uses a bounded narrower route instead of freezing',()=>{
  const world=createCollisionWorld(),trees=[];for(let z=0;z<=18;z+=1)for(const x of [-2.8,2.8])trees.push(tree(x,z));world.replace('forest',trees);
  const nav=createCreatureNavigation(flat,world);let p={x:0,y:0,z:-5},narrow=false;
  for(let i=0;i<1200;i++){p=nav.move(p,0,1,1,1/60);narrow||=nav.inspect().radius<2.6;for(const c of trees)assert.ok(obstacleClearance(c,p.x,p.z)>2.24);}
  assert.ok(narrow);assert.ok(p.z>10,`progress through corridor, z=${p.z}`);
});

test('rounded S-route keeps moving through turns with bounded heading rate',()=>{
  const world=createCollisionWorld(),trees=[tree(-.8,7,.75),tree(2.2,14,.75),tree(-1.8,22,.75),tree(1.7,31,.75)];world.replace('forest',trees);
  const nav=createCreatureNavigation(flat,world);let p={x:0,y:0,z:0},previousYaw=0,haveYaw=false,maxTurn=0,turningFrames=0,slowTurning=0,minSpeed=Infinity;
  for(let i=0;i<1050;i++){
    const moved=nav.move(p,0,1,2.5,1/60);p=moved;
    if(i>60&&haveYaw){const delta=Math.abs(Math.atan2(Math.sin(moved.yaw-previousYaw),Math.cos(moved.yaw-previousYaw)));maxTurn=Math.max(maxTurn,delta*60);if(delta>.003){turningFrames++;minSpeed=Math.min(minSpeed,moved.speed);if(moved.speed<1.5)slowTurning++;}}
    previousYaw=moved.yaw;haveYaw=true;for(const c of trees)assert.ok(obstacleClearance(c,p.x,p.z)>2.23,'arc must preserve tree corridor clearance');
  }
  assert.ok(turningFrames>80,'test must contain sustained turns');assert.equal(slowTurning,0,'ordinary corners must never introduce low-speed stop/pivot phases');assert.ok(minSpeed>1.65);assert.ok(maxTurn<2.5,'yaw must turn continuously rather than snap at a waypoint');assert.ok(p.z>30);
});

test('creature crosses graded river on its water surface without following the submerged bed',()=>{
  const terrain=(x,z)=>Math.abs(x)<4?-.65+z*.01:Math.min(.2,(Math.abs(x)-4)*.2)+z*.01;
  const water=(x,z)=>Math.abs(x)<4?z*.01:undefined;
  const nav=createCreatureNavigation(terrain,undefined,water);let p={x:-6,y:.2,z:0},wet=0;
  for(let i=0;i<900;i++){p=nav.move(p,1,0,1,1/60);if(Math.abs(p.x)<3.9){wet++;assert.ok(p.y>=water(p.x,p.z)-1e-8);assert.ok(Math.abs(nav.supportAt(p.x,p.z)-water(p.x,p.z))<1e-8);}}
  assert.ok(wet>300);assert.ok(p.x>7);
});
test('creature navigates a real underpass on water without selecting the overhead bridge deck',()=>{
  const world=createCollisionWorld(),deck={kind:'box',x:0,z:0,halfX:12,halfZ:.9,yaw:0,minY:4.05,maxY:4.3,tag:'bridge deck',surfaceHeight:(x,z)=>Math.abs(x)<12&&Math.abs(z)<.9?4.3:undefined};
  world.replace('bridge',[deck,{kind:'capsule',ax:5.1,az:0,bx:5.1,bz:0,radius:.15,minY:-1,maxY:4,tag:'bridge support'},{kind:'capsule',ax:-5.1,az:0,bx:-5.1,bz:0,radius:.15,minY:-1,maxY:4,tag:'bridge support'}]);
  const nav=createCreatureNavigation(()=>-.65,world,()=>0);let p={x:0,y:0,z:-6},overhead=0;
  for(let i=0;i<900;i++){p=nav.move(p,0,1,1,1/60);assert.ok(p.y<.01);if(Math.abs(p.z)<1){overhead++;assert.equal(nav.supportAt(p.x,p.z),0);assert.ok(nav.ceilingAt(p.x,p.z)<4.1);}}
  assert.ok(overhead>50);assert.ok(p.z>7);
});

test('an idle creature retains its heading instead of rotating toward an empty lookahead',()=>{
  const nav=createCreatureNavigation(flat);let p={x:0,y:0,z:0};for(let i=0;i<120;i++){const next=nav.move(p,0,-1,0,1/60);assert.ok(Math.abs(Math.abs(next.yaw)-Math.PI)<1e-8);assert.equal(next.speed,0);p=next;}
});

test('tight off-grid corridor folds the stance and follows the middle without crossing trunks',()=>{
 const world=createCollisionWorld(),trees=[],center=.23;
 for(let z=0;z<=18;z+=1)for(const side of [-1,1])trees.push(tree(center+side*1.55,z));
 world.replace('forest',trees);const nav=createCreatureNavigation(flat,world);let p={x:0,y:0,z:-4},squeezed=false,maxOffset=0;
 for(let i=0;i<900;i++){
  p=nav.move(p,0,1,2.5,1/60);squeezed||=nav.squeezing;
  for(const c of trees)assert.ok(obstacleClearance(c,p.x,p.z)>.849,'torso must not enter bark');
  if(p.z>1&&p.z<17){maxOffset=Math.max(maxOffset,Math.abs(p.x-center));assert.ok(nav.stanceWidth<.6);}
 }
 assert.ok(squeezed);assert.ok(p.z>22,`must leave the corridor: ${p.z}`);assert.ok(maxOffset<.12,`must use gap centre: ${maxOffset}`);
});
test('a tree dismount inside the broad limb radius can still plan an escape',()=>{
 const world=createCollisionWorld();world.replace('forest',[tree(0,0),tree(-2.1,4),tree(2.1,4)]);
 const nav=createCreatureNavigation(flat,world);assert.ok(nav.canEscape(0,2,0,1));
 let p={x:0,y:0,z:2};for(let i=0;i<600;i++)p=nav.move(p,0,1,3,1/60);
 assert.ok(p.z>18,`escape must not wait forever inside the wide radius: ${p.z}`);
});
test('a way ahead that is shut: it eases down to the end of the route the planner could offer, it does not arrive there at a run',()=>{
  // Up to a charge in the open; then a wall of trunks closes the way ahead, wider than the planner looks, so the planner can
  // offer only a route to just short of it. The body reaches the end of that route at a standstill: no pace lost in one step,
  // no collision with the wall (the hard stop of a collision).
  const wall=[],nav=createCreatureNavigation(flat,{nearby:()=>wall});let p={x:0,y:0,z:0};
  for(let i=0;i<120;i++)p=nav.move(p,0,1,6.5,1/60);
  assert.ok(nav.inspect().travelSpeed>6,'at a charge');
  const wallAt=p.z+14;for(let x=-45;x<=45;x+=1.8)wall.push(tree(x,wallAt,.9));
  let last=nav.inspect().travelSpeed,worst=0,hit=false;
  for(let i=0;i<300;i++){
    const before=p.z;p=nav.move(p,0,1,6.5,1/60);
    const speed=(p.z-before)*60;worst=Math.max(worst,last-speed);last=speed;
    if(nav.blocked)hit=true;
  }
  assert.ok(!hit,'it never ran into the wall');
  assert.ok(wallAt-.9-p.z>.9,`and stopped ${(wallAt-.9-p.z).toFixed(2)} m short of the bark`);
  assert.ok(worst<1.3,`the biggest drop in pace between two frames was ${worst.toFixed(2)} m/s`);
  assert.ok(Math.abs(last)<.3,'at rest');
});
test('with no route at all and trunks close ahead, a body still moving brakes to a stop short of them instead of running into them',()=>{
  // A ring of trunks closes round it while it is at pace: the planner has nowhere to offer (every foothold is too near bark).
  const ring=[],nav=createCreatureNavigation(flat,{nearby:()=>ring});let p={x:0,y:0,z:0};
  for(let i=0;i<120;i++)p=nav.move(p,0,1,5,1/60);
  assert.ok(nav.inspect().travelSpeed>4.5);
  for(let k=0;k<18;k++){const a=k*Math.PI/9;ring.push(tree(p.x+Math.sin(a)*2.6,p.z+Math.cos(a)*2.6,1));}
  nav.refresh(p.x,p.z,1,true);nav.replan();
  const start=p.z;let hit=false,last=5,worst=0;
  for(let i=0;i<90;i++){const before=p.z;p=nav.move(p,0,1,5,1/60);const speed=(p.z-before)*60;worst=Math.max(worst,last-speed);last=speed;if(nav.blocked)hit=true;}
  assert.ok(!hit,'it did not touch the ring');
  assert.ok(p.z-start<.8,`it ran on ${(p.z-start).toFixed(2)} m, then stopped`);
  assert.ok(Math.abs(last)<.3);
  assert.ok(worst<1,`braked as hard as the stopping distance needs, but not in one step (the biggest drop in a frame was ${worst.toFixed(2)} m/s)`);
});
