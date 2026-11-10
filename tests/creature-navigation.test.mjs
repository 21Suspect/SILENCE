import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createCollisionWorld} from '../game/collision.ts';
import {createCreatureNavigation,obstacleClearance} from '../game/creature-navigation.ts';
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
