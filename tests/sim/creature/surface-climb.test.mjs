import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceClimb} from '../../../game/sim/creature/surface-climb.ts';
const {createCreatureNavigation}=await import('../../../game/sim/creature/creature-navigation.ts');
import {createCollisionWorld,moveCharacter,characterSupportAt} from '../../../game/sim/world/collision.ts';
const ground=()=>0;
const roof={kind:'box',x:0,z:8,halfX:3,halfZ:3,yaw:0,minY:3,maxY:5,tag:'climb roof',surfaceHeight:(x,z)=>Math.abs(x)<=3.01&&Math.abs(z-8)<=3.01?5-Math.abs(x)*.6:undefined};

test('climb ascends an exterior wall, crosses the roof and descends continuously at 30/60/120Hz',()=>{
  for(const fps of [30,60,120]){
    let p={x:0,y:0,z:2},high=0,wallFrames=0;
    const climb=createSurfaceClimb(roof,p,0,1,ground);assert.ok(climb);
    for(let i=0;i<fps*20&&!climb.done;i++){
      const q=climb.advance(p,3,1/fps),d=Math.hypot(q.x-p.x,q.y-p.y,q.z-p.z);
      assert.ok(d<=3/fps+.00001,'no vertical snap');
      if(q.y>.4&&q.y<2.9){assert.ok(q.z<5.05||q.z>10.95,'must remain outside the walls');wallFrames++;}
      high=Math.max(high,q.y);p=q;
      const f=climb.frame();assert.ok(Math.abs(f.up.x*f.forward.x+f.up.y*f.forward.y+f.up.z*f.forward.z)<.00001);
    }
    assert.ok(climb.done);assert.ok(high>4.9);assert.ok(wallFrames>fps);assert.ok(p.z>=13&&p.y===0);
    assert.ok(climb.contact({x:0,y:1.8,z:4.5}).point.z===5,'foot planted against front wall');
    assert.equal(climb.contact({x:0,y:5.3,z:8}).point.y,5);
  }
});
test('navigation chooses a building climb and resumes travel on the far side',()=>{
  const world=createCollisionWorld();world.replace('house',[roof,{kind:'box',x:0,z:8,halfX:3,halfZ:3,yaw:0,minY:0,maxY:3,tag:'cabin wall'}]);
  const nav=createCreatureNavigation(ground,world);let p={x:0,y:0,z:1},high=0,climbed=false;
  for(let i=0;i<1200;i++){p=nav.move(p,0,1,3,1/60);high=Math.max(high,p.y);climbed ||=!!nav.climbing;}
  assert.ok(climbed&&high>4.9);assert.ok(p.z>20);assert.ok(p.y<.05);
});
test('visible rock shoulders are walkable and empty space inside their proxy does not block',()=>{
  const world=createCollisionWorld();world.replace('rock',[{kind:'capsule',ax:0,az:0,bx:0,bz:0,radius:3,minY:0,maxY:1,tag:'rock',surfaceHeight:(x,z)=>Math.hypot(x,z)<2?Math.max(0,1-Math.hypot(x,z)*.5):undefined}]);
  let p={x:0,y:0,z:-3.5};let high=0;
  for(let i=0;i<120;i++){p=moveCharacter(p,0,.05,1.69,ground,world);high=Math.max(high,p.y);}
  assert.ok(high>.95,'walk onto curved mesh');assert.ok(p.z>2.4,'walk back down');
  assert.equal(characterSupportAt(0,0,1,ground,world),1);
});

test('articulated support feet allow the body to complete a wall/roof climb without freezing',async()=>{
  const THREE=await import('three');
  const {createSpiderGait}=await import('../../../game/render/creature/spider-gait.ts');
  const {SPIDER_SCALE:S}=await import('../../../game/render/creature/spider-rig.ts');
  const root=new THREE.Group(),body=new THREE.Group();root.scale.setScalar(S);root.add(body);
  const gait=createSpiderGait(root,body,{setLeg(){}});
  const p=new THREE.Vector3(0,0,2),climb=createSurfaceClimb(roof,p,0,1,ground);
  const cmd={anchor:p.clone(),up:new THREE.Vector3(0,1,0),forward:new THREE.Vector3(0,0,1),ride:1.9*S,width:.8,length:1,pace:2.5,reachSpeed:5,
    surface(target,out){const c=climb.contact(target);out.point.set(c.point.x,c.point.y,c.point.z);out.normal.set(c.normal.x,c.normal.y,c.normal.z);}};
  let high=0;
  for(let i=0;i<3600&&!climb.done;i++){
    const q=climb.advance(p,2.5,1/60),ny=p.y+(q.y-p.y)*(1-Math.exp(-9/60)),fraction=gait.movementAllowance(q.x-p.x,ny-p.y,q.z-p.z,0);
    p.set(p.x+(q.x-p.x)*fraction,p.y+(ny-p.y)*fraction,p.z+(q.z-p.z)*fraction);
    const f=climb.frame();cmd.anchor.copy(p);cmd.up.set(f.up.x,f.up.y,f.up.z);cmd.forward.set(f.forward.x,f.forward.y,f.forward.z);cmd.hug=1-cmd.up.y;cmd.ride=(1.05+(1.9-1.05)*cmd.up.y)*S;
    gait.update(1/60,i/60,cmd);high=Math.max(high,p.y);
    for(const leg of gait.legs)assert.ok(Number.isFinite(leg.foot.length()));
  }
  assert.ok(climb.done,`climb stalled at ${p.toArray()}`);assert.ok(high>4.6);assert.ok(p.z>12.5);
});
test('a dismount between porch posts can leave with its real body clearance',()=>{
  const world=createCollisionWorld();world.replace('porch',[{kind:'capsule',ax:.98,az:0,bx:.98,bz:0,radius:.2,minY:0,maxY:3,tag:'porch post'}]);
  const nav=createCreatureNavigation(ground,world,undefined,.8);let p={x:0,y:0,z:0};
  for(let i=0;i<480;i++)p=nav.move(p,0,1,3,1/60);
  assert.ok(p.z>15,`dismount trapped inside planning margin: ${p.z}`);
});
