import * as THREE from 'three';
import {createEncounterSchedule} from './encounter-schedule';
import {createTreeCrawl,TREE_SPIRAL_TURN,TREE_CRAWL_SPEED} from './tree-crawl';
import type { ForestAudio } from './audio';
import {createFoot,swingFoot,advanceFoot,solveLeg,type FootState} from './creature-gait';
import {WORLD_RADIUS} from './world';
import type {SolidCollider,createCollisionWorld} from './collision';
import {createCreatureNavigation} from './creature-navigation';
import {createCreatureModel} from './creature-model';
import {creatureInView,createOffscreenLatch,CREATURE_VIEW_RADIUS,type EncounterView} from './encounter-visibility';
import {inDirectView,sightlineClear,createEncounterAwareness} from './creature-sighting';

/** Rare, peripheral encounters. There is no timer, combat, or visible objective. */
export function createEncounters(
  scene: THREE.Scene,
  heightAt: (x: number, z: number) => number,
  audio: ForestAudio,
  collisionWorld?: Pick<ReturnType<typeof createCollisionWorld>,'nearby'>,
  getView?:()=>EncounterView,
  waterSurfaceAt?:(x:number,z:number)=>number|undefined,
) {
  const root = new THREE.Group();
  root.name = 'something-between-the-trees';
  root.visible = false;
  scene.add(root);
  const body = new THREE.Group();
  root.add(body);
  const navigation=createCreatureNavigation(heightAt,collisionWorld,waterSurfaceAt);
  const sculpt=createCreatureModel(body);
  type Limb={base:THREE.Vector3;shoulder:THREE.Vector3;rest:THREE.Vector3;side:number;index:number;label:string;foot:FootState;reachError:number;reachDistance:number;legClearance:number;shoulderWorld:THREE.Vector3;jointWorld:THREE.Vector3};
  const limbs:Limb[]=[];
  for(const side of [-1,1])for(let i=0;i<3;i++){
    const base=new THREE.Vector3(side*.25,1.88,.38-i*.52);
    const shoulder=new THREE.Vector3(side*(.85+i*.1),2.43+(i===1?.38:0),.8-i*.85);
    const rest=new THREE.Vector3(side*(2.22+i*.16),.035,(i===0?2.02:i===1?.05:-1.90));
    limbs.push({base,shoulder,rest,side,index:i,label:(side<0?'L':'R')+i,foot:createFoot(rest,(i+(side>0?1:0))%2),reachError:0,reachDistance:0,legClearance:Infinity,shoulderWorld:new THREE.Vector3(),jointWorld:new THREE.Vector3()});
  }
  const velocity=new THREE.Vector3(),previousPosition=new THREE.Vector3(),desired=new THREE.Vector3(),localFoot=new THREE.Vector3(),joint=new THREE.Vector3(),shoulderPoint=new THREE.Vector3();
  const toe=new THREE.Vector3(),pole=new THREE.Vector3(),candidateJoint=new THREE.Vector3(),candidateWorld=new THREE.Vector3(),movementDirection=new THREE.Vector3(),previewDirection=new THREE.Vector3();
  const attentionTarget=new THREE.Vector3(),localAttention=new THREE.Vector3();
  const colliderA=new THREE.Vector3(),colliderB=new THREE.Vector3();
  const stepErrors=new Float32Array(6),LIFT_SWEEP_SAMPLES=10;
  const motion={speed:0,turnRate:0,lookTarget:localAttention};
  let gaitGroup=0,gaitReady=false,visualTest=false,nextLift=0,lastMoveSpeed=0,bodyLift=0,bodyCrouch=0,shoulderWidth=1;
  const waveOrder=[2,4,0,5,1,3];let waveIndex=0;
  function resetFeet(){
    navigation.refresh(root.position.x,root.position.z,0,true);
    body.position.set(0,0,0);body.rotation.set(0,0,0);bodyLift=bodyCrouch=0;
    root.updateMatrixWorld(true);
    for(const limb of limbs){
      desired.copy(limb.rest);root.localToWorld(desired);
      const target=navigation.findFoot(desired.x,desired.z,root.position.x,root.position.z);
      desired.set(target.x,target.y,target.z);limb.foot=createFoot(desired,limb.foot.group);
    }
    previousPosition.copy(root.position);velocity.set(0,0,0);motion.speed=motion.turnRate=0;gaitReady=true;gaitGroup=waveIndex=0;nextLift=0;
  }
  function futureRest(limb:Limb,seconds:number,out:THREE.Vector3){
    const omega=motion.turnRate,theta=omega*seconds,yaw=root.rotation.y+theta,co=Math.cos(yaw),si=Math.sin(yaw);
    let dx=velocity.x*seconds,dz=velocity.z*seconds;
    if(Math.abs(omega)>.015){const along=Math.sin(theta)/omega,across=(1-Math.cos(theta))/omega;dx=velocity.x*along+velocity.z*across;dz=velocity.z*along-velocity.x*across;}
    const width=limb.rest.x*navigation.stanceWidth;
    out.set(root.position.x+dx+width*co+limb.rest.z*si,0,root.position.z+dz-width*si+limb.rest.z*co);
    return out;
  }
  function lift(limb:Limb,speed:number,running:number,delay=0){
    const duration=(limb.index===0?.34:limb.index===1?.29:.27)-running*.14;
    // Aim at the stance after landing, including angular motion. Inner feet
    // shorten their steps while outer feet trace a longer arc through a turn.
    futureRest(limb,duration*.65+.09,desired);
    const target=navigation.findFoot(desired.x,desired.z,root.position.x,root.position.z,limb.foot.position.x,limb.foot.position.z);
    desired.set(target.x,target.y,target.z);
    let clearance=(limb.index===0?.23:.16)+running*.25;
    const bow=(limb.index===0?.18:.10)+running*.055;
    let bowX=Math.cos(root.rotation.y)*limb.side*bow,bowZ=-Math.sin(root.rotation.y)*limb.side*bow;
    // The lifted tarsus hooks outward like a spider's foot, only if the full
    // curved sweep has room. Near trunks it takes the narrow safe trajectory.
    for(let i=1;i<LIFT_SWEEP_SAMPLES;i++){const t=i/LIFT_SWEEP_SAMPLES,s=t*t*t*(t*(t*6-15)+10),hook=Math.sin(Math.PI*t)**2,x=THREE.MathUtils.lerp(limb.foot.position.x,desired.x,s)+bowX*hook,z=THREE.MathUtils.lerp(limb.foot.position.z,desired.z,s)+bowZ*hook;if(navigation.footClearance(x,z)<.24){bowX=bowZ=0;break;}}
    // Precompute a smooth arc above the complete swept footprint, including
    // narrow logs between the start/end contact (not just the landing height).
    for(let i=1;i<LIFT_SWEEP_SAMPLES;i++){
      const t=i/LIFT_SWEEP_SAMPLES,s=t*t*t*(t*(t*6-15)+10),hook=Math.sin(Math.PI*t)**2,x=THREE.MathUtils.lerp(limb.foot.position.x,desired.x,s)+bowX*hook,z=THREE.MathUtils.lerp(limb.foot.position.z,desired.z,s)+bowZ*hook;
      const linearY=THREE.MathUtils.lerp(limb.foot.position.y,desired.y,s);
      clearance=Math.max(clearance,(navigation.supportAt(x,z)+.07-linearY)/Math.pow(Math.sin(Math.PI*t),.82));
    }
    swingFoot(limb.foot,desired,Math.min(clearance,2.3),duration,delay,bowX,bowZ);
  }
  function animateCreature(dt:number,time:number){
    if(!gaitReady)resetFeet();
    navigation.refresh(root.position.x,root.position.z,dt);
    shoulderWidth=THREE.MathUtils.damp(shoulderWidth,navigation.shoulderWidth,8,dt);
    velocity.subVectors(root.position,previousPosition).divideScalar(Math.max(dt,.001));previousPosition.copy(root.position);
    const speed=Math.hypot(velocity.x,velocity.z),running=THREE.MathUtils.smoothstep(speed,1.4,5.5);
    let supportCount=0,swingCount=0;for(const limb of limbs){if(limb.foot.swinging)swingCount++;else supportCount++;}
    const count=Math.max(1,supportCount);
    let loadX=0,front=0,back=0,left=0,right=0;
    for(const limb of limbs){localFoot.copy(limb.foot.position);root.worldToLocal(localFoot);if(!limb.foot.swinging)loadX+=localFoot.x/count;if(limb.index===0)front+=localFoot.y*.5;if(limb.index===2)back+=localFoot.y*.5;if(limb.side<0)left+=localFoot.y/3;else right+=localFoot.y/3;}
    body.position.x=THREE.MathUtils.damp(body.position.x,THREE.MathUtils.clamp(loadX*.055,-.07,.07),5,dt);
    let neededLift=0;
    const rootCos=Math.cos(root.rotation.y),rootSin=Math.sin(root.rotation.y);
    for(const limb of limbs){
      const sx=root.position.x+limb.shoulder.x*shoulderWidth*rootCos+limb.shoulder.z*rootSin,sz=root.position.z-limb.shoulder.x*shoulderWidth*rootSin+limb.shoulder.z*rootCos;
      for(const contact of limb.foot.swinging?[limb.foot.position,limb.foot.target]:[limb.foot.position]){
        const horizontal=(contact.x-sx)**2+(contact.z-sz)**2;
        if(horizontal<1.77**2)neededLift=Math.max(neededLift,contact.y+Math.sqrt(1.77**2-horizontal)-root.position.y-limb.shoulder.y+.035);
      }
    }
    neededLift=THREE.MathUtils.clamp(neededLift,0,1.1);
    bodyLift=Math.max(neededLift-.06,THREE.MathUtils.damp(bodyLift,neededLift,neededLift>bodyLift?14:6,dt));
    const overhead=navigation.ceilingAt(root.position.x,root.position.z,3.1);
    const crouchTarget=Number.isFinite(overhead)?THREE.MathUtils.clamp(root.position.y+4.35-overhead+.22,0,.58):0;
    bodyCrouch=THREE.MathUtils.damp(bodyCrouch,crouchTarget,7,dt);
    // The abdomen remains low and almost motionless while the long legs probe.
    body.position.y=bodyLift-bodyCrouch-.055+Math.sin(time*1.45)*.010;
    body.rotation.z=THREE.MathUtils.damp(body.rotation.z,THREE.MathUtils.clamp((right-left)*.1,-.12,.12)-loadX*.017,5,dt);
    body.rotation.x=THREE.MathUtils.damp(body.rotation.x,THREE.MathUtils.clamp((back-front)*.1,-.14,.14)-.035-running*.045,5,dt);
    root.updateMatrixWorld(true);localAttention.copy(attentionTarget);body.worldToLocal(localAttention);
    motion.speed=speed;sculpt.secondary(time,running,dt,motion);root.updateMatrixWorld(true);nextLift-=dt;
    for(let i=0;i<limbs.length;i++){const limb=limbs[i];futureRest(limb,.14+running*.06,desired);stepErrors[i]=Math.hypot(desired.x-limb.foot.position.x,desired.z-limb.foot.position.z);}
    for(let i=0;i<limbs.length;i++){
      const limb=limbs[i];if(limb.foot.swinging)continue;
      desired.copy(limb.shoulder);desired.x*=shoulderWidth;body.localToWorld(desired);
      if((desired.distanceTo(limb.foot.position)>3.95||limb.legClearance<.19)&&swingCount<4){lift(limb,speed,running);swingCount++;}
    }
    if(running>.45){
      let largestError=0;for(let i=0;i<stepErrors.length;i++)largestError=Math.max(largestError,stepErrors[i]);
      if(swingCount===0&&largestError>.28+running*.20){
        let order=0;for(const limb of limbs)if(limb.foot.group===gaitGroup)lift(limb,speed,running,order++*.012);
        gaitGroup=1-gaitGroup;
      }
    }else if(nextLift<=0&&swingCount<2){
      let chosen=-1,largest=.22;
      // A six-beat crawl retains four or five contacts; overextended feet take
      // priority during turns, so the body never drags a leg behind it.
      for(let i=0;i<6;i++){const index=waveOrder[(waveIndex+i)%6];if(!limbs[index].foot.swinging&&stepErrors[index]>largest){largest=stepErrors[index];chosen=index;}}
      if(chosen>=0){lift(limbs[chosen],speed,running);waveIndex=(waveOrder.indexOf(chosen)+1)%6;nextLift=.10-running*.025;}
    }
    for(const limb of limbs){
      advanceFoot(limb.foot,dt,.34-running*.19,.17+running*.28,navigation.supportAt);
      if(limb.foot.swinging){
        limb.shoulderWorld.copy(limb.shoulder);limb.shoulderWorld.x*=shoulderWidth;body.localToWorld(limb.shoulderWorld);
        const horizontal=(limb.foot.position.x-limb.shoulderWorld.x)**2+(limb.foot.position.z-limb.shoulderWorld.z)**2;
        if(horizontal<1.66**2){
          const ceiling=limb.shoulderWorld.y-Math.sqrt(1.66**2-horizontal),floor=navigation.supportAt(limb.foot.position.x,limb.foot.position.z)+.035;
          // The unequal leg bones cannot fold closer than 1.6 m. Flatten only
          // the airborne arc when a high boulder brings the toe near the hip.
          if(ceiling>=floor)limb.foot.position.y=Math.min(limb.foot.position.y,ceiling);
        }
      }
      localFoot.copy(limb.foot.position);body.worldToLocal(localFoot);
      shoulderPoint.copy(limb.shoulder);shoulderPoint.x*=shoulderWidth;shoulderPoint.y+=Math.sin(time*1.45+limb.index)*.012;
      const folded=limb.foot.swinging?Math.sin(limb.foot.progress*Math.PI):0;
      pole.set(limb.side*(navigation.squeezing?.8:3.12-folded*.18),4.55-bodyCrouch*1.8+folded*.30+(navigation.squeezing?.4:0),limb.rest.z*.52);
      solveLeg(shoulderPoint,localFoot,pole,1.5,3.1,joint);
      limb.shoulderWorld.copy(shoulderPoint);body.localToWorld(limb.shoulderWorld);
      limb.jointWorld.copy(joint);body.localToWorld(limb.jointWorld);
      let limbClearance=Math.min(navigation.limbClearance(limb.shoulderWorld,limb.jointWorld),navigation.limbClearance(limb.jointWorld,limb.foot.position));
      // Rotate the knee's IK pole around its reachable arc if the broad elbow
      // would scrape a trunk. Bone lengths and grounded tips stay unchanged.
      if(limbClearance<.13){
        for(let option=0;option<12;option++){
          const angle=option*Math.PI/6;pole.set(limb.side*(.5+Math.cos(angle)*3.2),3.5+Math.sin(angle)*3,limb.rest.z*.7+Math.sin(angle+.8)*1.1);
          solveLeg(shoulderPoint,localFoot,pole,1.5,3.1,candidateJoint);candidateWorld.copy(candidateJoint);body.localToWorld(candidateWorld);
          const candidateClearance=Math.min(navigation.limbClearance(limb.shoulderWorld,candidateWorld),navigation.limbClearance(candidateWorld,limb.foot.position));
          if(candidateClearance>limbClearance){limbClearance=candidateClearance;joint.copy(candidateJoint);limb.jointWorld.copy(candidateWorld);}
          if(limbClearance>.18)break;
        }
      }
      limb.legClearance=limbClearance;
      // Toe orientation remains fixed in world space for the entire stance.
      toe.copy(limb.foot.position);toe.x+=limb.side*.10;toe.y-=.018;toe.z+=.13;body.worldToLocal(toe);
      sculpt.setLeg(limb.label,limb.base,shoulderPoint,joint,localFoot,toe);
      limb.shoulderWorld.copy(shoulderPoint);body.localToWorld(limb.shoulderWorld);limb.jointWorld.copy(joint);body.localToWorld(limb.jointWorld);
      limb.reachError=Math.abs(joint.distanceTo(localFoot)-3.1);limb.reachDistance=shoulderPoint.distanceTo(localFoot);
    }
  }
  function moveCreature(dt:number,speed:number,direction:THREE.Vector3){
    const moved=navigation.move(root.position,direction.x,direction.z,speed,dt);
    const oldYaw=root.rotation.y,difference=Math.atan2(Math.sin(moved.yaw-oldYaw),Math.cos(moved.yaw-oldYaw));
    const turn=moved.speed>.001?THREE.MathUtils.clamp(difference*(1-Math.exp(-dt*9)),-dt*2.4,dt*2.4):0;
    // Translation and heading progress together through the rounded route. Only
    // a near-reversed initial direction eases the pace; ordinary corners do not
    // trigger the previous walk / stop / pivot / walk pattern.
    // Keep ordinary corners moving at the requested pace.  A large constant
    // alignment tax made the admin slow-walk mode look like repeated braking;
    // only a near-reversed heading now receives a meaningful ease-in.
    const alignment=.90+.10*Math.max(0,Math.cos(difference));
    const nx=THREE.MathUtils.lerp(root.position.x,moved.x,alignment),nz=THREE.MathUtils.lerp(root.position.z,moved.z,alignment),ny=THREE.MathUtils.damp(root.position.y,moved.y,9,dt);
    let worstReach=0,minClearance=Infinity;
    for(const limb of limbs){worstReach=Math.max(worstReach,limb.reachDistance);minClearance=Math.min(minClearance,limb.legClearance);}
    let fraction=Math.min(1,THREE.MathUtils.clamp((4.48-worstReach)/.38,.2,1),THREE.MathUtils.clamp((minClearance-.075)/.085,.35,1));
    for(let iteration=0;iteration<7;iteration++){
      const yaw=oldYaw+turn*fraction,co=Math.cos(yaw),si=Math.sin(yaw);let safe=true;
      for(const limb of limbs){const sx=THREE.MathUtils.lerp(root.position.x,nx,fraction)+limb.shoulder.x*shoulderWidth*co+limb.shoulder.z*si,sz=THREE.MathUtils.lerp(root.position.z,nz,fraction)-limb.shoulder.x*shoulderWidth*si+limb.shoulder.z*co,sy=THREE.MathUtils.lerp(root.position.y,ny,fraction)+limb.shoulder.y+body.position.y;const reach=Math.hypot(sx-limb.foot.position.x,sy-limb.foot.position.y,sz-limb.foot.position.z);if(reach>4.40)safe=false;}
      if(safe)break;fraction*=.4;
    }
    root.position.set(THREE.MathUtils.lerp(root.position.x,nx,fraction),THREE.MathUtils.lerp(root.position.y,ny,fraction),THREE.MathUtils.lerp(root.position.z,nz,fraction));
    root.rotation.y=oldYaw+turn*fraction;
    const rate=(root.rotation.y-oldYaw)/Math.max(dt,.001);motion.turnRate=THREE.MathUtils.damp(motion.turnRate,rate,10,dt);
    lastMoveSpeed=moved.speed*alignment*fraction;motion.speed=lastMoveSpeed;
  }
  const schedule=createEncounterSchedule();
  let nextEncounter=0,active=false,activeTime=0,watched=0,retreating=false,retreatTime=0,lifetime=5;
  let nextDistantSound=35+Math.random()*45;
  type CreatureMode='natural'|'idle'|'walk'|'run'|'tree';
  let naturalCount=0,treeCrawl:ReturnType<typeof createTreeCrawl>|undefined;
  let adminMode:CreatureMode='natural',dismissRequested=false,outsideReady=false,retryIn=0;
  type SpawnRequest={mode:CreatureMode;origin:THREE.Vector3;heading:number;cursor:number;side?:number;reposition?:boolean;scheduled?:boolean};
  let pendingSpawn:SpawnRequest|undefined;
  const retreatDirection=new THREE.Vector3(),toCreature=new THREE.Vector3(),boundsCenter=new THREE.Vector3();
  const offscreen=createOffscreenLatch();
  const fallbackView={position:new THREE.Vector3(),forward:new THREE.Vector3(0,0,-1),right:new THREE.Vector3(1,0,0),up:new THREE.Vector3(0,1,0),verticalFov:69,aspect:16/9};
  const transitions:{kind:string;inView:boolean;position:number[];elapsed:number}[]=[];
  const awareness=createEncounterAwareness(),sightPoints=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()];
  const stalkTarget=new THREE.Vector3(),cuePosition=new THREE.Vector3();
  let headBone:THREE.Object3D|undefined,directSight=false,sightProbeIn=0,nextReposition=18,stalkSide=1,repositions=0,stuckTime=0,nextFlankShift=10;
  function directlyVisible(force=false){
    const view=getView?.()??fallbackView;
    headBone??=root.getObjectByName('head');
    if(headBone)headBone.getWorldPosition(sightPoints[0]);else body.localToWorld(sightPoints[0].set(0,1.45,.8));
    body.localToWorld(sightPoints[1].set(0,1.95,-.25));
    sightPoints[2].copy(limbs[0].shoulderWorld);sightPoints[3].copy(limbs[3].shoulderWorld);
    // Check the actual camera every frame; cached occlusion never extends the
    // field of view, and the final recognition/reveal always rechecks LOS.
    if(!sightPoints.some(p=>inDirectView(view,p,treeCrawl?48:30))){directSight=false;return false;}
    if(!force&&sightProbeIn>0)return directSight;
    sightProbeIn=.08;
    const x=(view.position.x+root.position.x)*.5,z=(view.position.z+root.position.z)*.5;
    const solids=collisionWorld?.nearby(x,z,Math.hypot(view.position.x-root.position.x,view.position.z-root.position.z)*.5+4)??[];
    let shoulders=0;directSight=false;
    for(let i=0;i<sightPoints.length;i++)if(inDirectView(view,sightPoints[i],treeCrawl?48:30)&&sightlineClear(view.position,sightPoints[i],heightAt,solids)){
      if(i<2||++shoulders>=2){directSight=true;break;}
    }
    return directSight;
  }
  function notice(dt:number){
    sightProbeIn-=dt;
    awareness.update(dt,directlyVisible(!awareness.witnessed&&awareness.inspect().directExposure>=.14));
    if(!awareness.inspect().revealPlayed){
      cuePosition.copy(sightPoints[0]);
      if(audio.creatureReveal(root.position))awareness.revealed();
    }
  }
  function observe(player:THREE.Vector3,forward:THREE.Vector3){
    attentionTarget.copy(player);attentionTarget.y+=1.6;
    fallbackView.position.copy(player);fallbackView.position.y+=1.6;
    fallbackView.forward.copy(forward).normalize();
    fallbackView.right.crossVectors(fallbackView.forward,THREE.Object3D.DEFAULT_UP);
    if(fallbackView.right.lengthSq()<.001)fallbackView.right.set(1,0,0);else fallbackView.right.normalize();
    fallbackView.up.crossVectors(fallbackView.right,fallbackView.forward).normalize();
  }
  function protectedNow(){
    boundsCenter.copy(root.position);boundsCenter.y+=2;
    let radius=CREATURE_VIEW_RADIUS;
    for(const limb of limbs){radius=Math.max(radius,boundsCenter.distanceTo(limb.foot.position)+.5,boundsCenter.distanceTo(limb.jointWorld)+.4);}
    return creatureInView(getView?.()??fallbackView,boundsCenter,radius);
  }
  function recordTransition(kind:string,elapsed:number,inView:boolean){
    transitions.push({kind,inView,position:root.position.toArray(),elapsed});if(transitions.length>24)transitions.shift();
  }
  function endEncounter(elapsed:number){
    // The final check is at the actual post-movement position. Neither lifetime,
    // fog, distance, admin actions nor a far clipping plane can override it.
    if(root.visible&&(!outsideReady||protectedNow()))return false;
    recordTransition('despawn',elapsed,false);root.visible=false;active=false;visualTest=false;treeCrawl=undefined;root.rotation.set(0,root.rotation.y,0);
    dismissRequested=false;outsideReady=false;offscreen.reset();nextEncounter=naturalCount<2?elapsed:elapsed+110+Math.random()*60;
    return true;
  }
  function commitSpawn(request:SpawnRequest,point:{x:number;y:number;z:number},elapsed:number){
    if(!sculpt.ready||(root.visible&&(!outsideReady||protectedNow())))return false;
    const view=getView?.()??fallbackView,center={x:point.x,y:point.y+2,z:point.z};
    // Extra room for the first pose and its lifted knees. Pose while hidden and
    // validate again before activation; no first-frame travel across the edge.
    if(creatureInView(view,center,CREATURE_VIEW_RADIUS+1.5))return false;
    const oldPosition=root.position.clone(),oldYaw=root.rotation.y,oldDirection=retreatDirection.clone(),wasVisible=root.visible;
    root.visible=false;root.position.set(point.x,point.y,point.z);
    const toward=Math.atan2(request.origin.x-point.x,request.origin.z-point.z);
    retreatDirection.set(point.x-request.origin.x,0,point.z-request.origin.z).normalize();
    root.rotation.y=request.mode==='walk'||request.mode==='run'?Math.atan2(retreatDirection.x,retreatDirection.z):toward;
    navigation.reset();resetFeet();animateCreature(0,elapsed);
    if(protectedNow()){
      root.position.copy(oldPosition);root.rotation.y=oldYaw;retreatDirection.copy(oldDirection);navigation.reset();resetFeet();animateCreature(0,elapsed);root.visible=wasVisible;
      return false;
    }
    root.visible=true;active=true;visualTest=false;adminMode=request.mode;
    if(!request.reposition){
      if(request.mode==='natural')naturalCount++;
      activeTime=watched=retreatTime=0;retreating=false;lifetime=4.5+Math.random()*2.5;
      awareness.reset();if(audio.creatureReveal(root.position))awareness.revealed();stalkSide=Math.random()<.5?-1:1;repositions=0;nextReposition=18+Math.random()*6;
    }else {repositions++;nextReposition=activeTime+18+Math.random()*6;stalkSide*=-1;}
    stuckTime=0;nextFlankShift=activeTime+10;directSight=false;sightProbeIn=0;
    dismissRequested=false;outsideReady=false;offscreen.reset();retryIn=0;
    recordTransition(request.reposition?'reposition':wasVisible?'replace':'spawn',elapsed,protectedNow());return true;
  }
  function animateTree(dt:number,time:number){
    if(!treeCrawl)return;
    treeCrawl.update(dt);
    root.position.copy(treeCrawl.position);root.quaternion.copy(treeCrawl.rotation);
    const blend=treeCrawl.landingBlend;
    body.position.set(0,(-.055+Math.sin(time*1.45)*.010)*blend,0);body.rotation.set(-.035*blend,0,0);
    root.updateMatrixWorld(true);
    localAttention.copy(attentionTarget);body.worldToLocal(localAttention);
    motion.speed=treeCrawl.descending?.7*(1-blend):0;sculpt.secondary(time,0,dt,motion);
    for(let i=0;i<limbs.length;i++){
      const l=limbs[i],f=treeCrawl.feet[i];l.foot.position.copy(f.position);l.foot.swinging=f.swing<1;
      localFoot.copy(f.position);body.worldToLocal(localFoot);
      shoulderPoint.copy(l.shoulder);shoulderPoint.y+=Math.sin(time*1.45+l.index)*.012*blend;
      pole.set(l.side*THREE.MathUtils.lerp(3.1,3.12,blend),THREE.MathUtils.lerp(4.8,4.55,blend),l.rest.z*THREE.MathUtils.lerp(.6,.52,blend));
      solveLeg(shoulderPoint,localFoot,pole,1.5,3.1,joint);
      toe.copy(localFoot);toe.y-=.035;toe.z+=.10;
      desired.copy(f.position);desired.x+=l.side*.10;desired.y-=.018;desired.z+=.13;body.worldToLocal(desired);toe.lerp(desired,blend);
      sculpt.setLeg(l.label,l.base,shoulderPoint,joint,localFoot,toe);
      l.shoulderWorld.copy(shoulderPoint);body.localToWorld(l.shoulderWorld);l.jointWorld.copy(joint);body.localToWorld(l.jointWorld);
      l.reachError=Math.abs(joint.distanceTo(localFoot)-3.1);l.reachDistance=shoulderPoint.distanceTo(localFoot);
    }
  }
  function spawnTree(request:SpawnRequest,elapsed:number){
    if(root.visible)return false;
    const trees=(collisionWorld?.nearby(request.origin.x,request.origin.z,28)??[]).filter(c=>c.tag==='tree');
    // Check at most one escape route per update. The next retry picks up at
    // the next candidate if this tree is blocked or visible to the player.
    while(request.cursor<trees.length){
      const c=trees[request.cursor++];
      if(c.kind!=='capsule'||c.tag!=='tree'||c.maxY-c.minY<22||c.radius<.44)continue;
      const distance=Math.hypot(c.ax-request.origin.x,c.az-request.origin.z);if(distance<12||distance>26)continue;
      const base=heightAt(c.ax,c.az),angle=Math.atan2(request.origin.z-c.az,request.origin.x-c.ax);
      const exitAngle=angle+TREE_SPIRAL_TURN,exitX=c.ax+Math.cos(exitAngle)*(c.radius+4),exitZ=c.az+Math.sin(exitAngle)*(c.radius+4);
      if((collisionWorld?.nearby(exitX,exitZ,4)??[]).some(o=>o.kind==='capsule'&&o.tag==='tree'&&Math.hypot(o.ax-exitX,o.az-exitZ)<o.radius+2.7))continue;
      if(!navigation.canEscape(exitX,exitZ,Math.cos(exitAngle),Math.sin(exitAngle)))return false;
      const contact=(a:number,y:number)=>{
        const exact=c.barkContact?.(a,y);if(exact)return new THREE.Vector3(exact.x,exact.y,exact.z);
        // Forest trunk geometry tapers from roughly .44*width at the roots to
        // the narrow upper bole.  The collider is intentionally a full-height
        // envelope for navigation, so using it unchanged here would float the
        // feet several decimetres away from the visible bark at a perch.
        const width=Math.max(.16,(c.radius-.08)/.44),modelHeight=Math.max(1,(c.maxY-base)/31);
        const modelY=THREE.MathUtils.clamp((y-base)/modelHeight,0,33),taper=Math.pow(Math.max(0,1-modelY/33),.72);
        const trunkRadius=width*(.44*taper+.48*Math.exp(-modelY*2.9));
        const rootFlare=width*.22*Math.exp(-modelY*1.8);
        const barkRadius=Math.max(.075,trunkRadius+rootFlare+.025);
        return new THREE.Vector3(c.ax+Math.cos(a)*barkRadius,y,c.az+Math.sin(a)*barkRadius);
      };
      const candidate=createTreeCrawl({x:c.ax,z:c.az,ground:base,radius:c.radius,height:c.maxY-base},angle,limbs.map(l=>l.rest),contact,(x,z)=>navigation.supportAt(x,z));
      if(creatureInView(getView?.()??fallbackView,candidate.position,6))return false;
      treeCrawl=candidate;animateTree(0,elapsed);if(protectedNow()){treeCrawl=undefined;root.rotation.set(0,0,0);return false;}
      directSight=false;sightProbeIn=0;dismissRequested=false;outsideReady=false;offscreen.reset();navigation.reset();
      bodyLift=bodyCrouch=lastMoveSpeed=0;shoulderWidth=1;motion.turnRate=0;
      root.visible=active=true;adminMode='natural';activeTime=watched=retreatTime=0;retreating=false;awareness.reset();if(request.mode==='natural')naturalCount++;if(audio.creatureReveal(root.position))awareness.revealed();recordTransition('tree-spawn',elapsed,false);return true;
    }
    request.cursor=0;
    return false;
  }
  function attemptSpawn(request:SpawnRequest,elapsed:number){
    if(!sculpt.ready||(root.visible&&(!outsideReady||protectedNow())))return false;
    if(!request.reposition&&(request.mode==='tree'||request.mode==='natural'&&naturalCount===1))return spawnTree(request,elapsed);
    const side=request.reposition?stalkSide:(request.side??=(Math.random()<.5?-1:1));
    const angles=request.mode==='natural'?[side*1.7,-side*1.7,side*2.15,-side*2.15,Math.PI]:[Math.PI,2.55,-2.55,2.1,-2.1];
    const start=request.cursor,end=request.reposition?angles.length:Math.min(angles.length,start+2);
    for(let i=start;i<end;i++){
      request.cursor=i+1;
      const distance=request.mode==='natural'?(request.reposition?17:20)+i*1.2:12+i*1.3,angle=request.heading+angles[i];
      const x=request.origin.x+Math.sin(angle)*distance,z=request.origin.z+Math.cos(angle)*distance;
      if(Math.hypot(x,z)>WORLD_RADIUS-85||heightAt(x,z)>45)continue;
      const point=navigation.safeSpawn(x,z);if(!point)continue;
      const finalDistance=Math.hypot(point.x-request.origin.x,point.z-request.origin.z);
      if(request.mode==='natural'&&(finalDistance<12||finalDistance>28))continue;
      // safeSpawn can shift up to ten metres: gate its final answer, not just
      // the candidate request. Failed requests leave a live creature intact.
      if(commitSpawn(request,point,elapsed))return true;
    }
    if(request.cursor>=angles.length){request.cursor=0;request.side=undefined;}
    return false;
  }
  return {
    spawn(player:THREE.Vector3,forward:THREE.Vector3,mode:CreatureMode='natural'){
      observe(player,forward);
      pendingSpawn={mode,origin:player.clone(),heading:Math.atan2(forward.x,forward.z),cursor:0};dismissRequested=false;retryIn=0;
    },
    dismiss(_elapsed:number){pendingSpawn=undefined;dismissRequested=true;},
    visibilityStatus(){return{naturalCount,scheduledHours:schedule.times,treePhase:treeCrawl?(treeCrawl.landing>0?'landing':treeCrawl.descending?'descending':'perched'):null,active,visible:root.visible,mode:adminMode,modelReady:sculpt.ready,inView:root.visible&&protectedNow(),offscreenSeconds:offscreen.outsideSeconds,pendingSpawn:!!pendingSpawn,pendingDismiss:dismissRequested,directSight,awareness:awareness.inspect(),nextEncounter,repositions,retreating,activeTime,transitions:transitions.map(t=>({...t,position:[...t.position]}))};},
    solidColliders():SolidCollider[]{
      if(!root.visible)return [];
      const c:SolidCollider[]=[];
      const addCapsule=(a:THREE.Vector3,b:THREE.Vector3,radius:number,tag:string)=>{
        // Keep the broadphase envelope just outside the posed segment.  The
        // previous vertical leg columns hid terrain/LOS and could make the
        // player collide with a limb that was actually folded away.
        // Snapshot every scalar: the pose vectors are reused by the next
        // animation tick, while collision queries may outlive this call.
        const ax=a.x,az=a.z,ay=a.y,bx=b.x,bz=b.z,by=b.y,horizontalLength=(ax-bx)**2+(az-bz)**2;
        const heightAt=horizontalLength>.002?((x:number,z:number)=>{const dx=bx-ax,dz=bz-az,t=Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/horizontalLength));return ay+(by-ay)*t;}):undefined;
        c.push({kind:'capsule',ax,az,bx,bz,radius,minY:Math.min(ay,by)-radius,maxY:Math.max(ay,by)+radius,tag,heightAt});
      };
      body.localToWorld(colliderA.set(0,1.45,.65));body.localToWorld(colliderB.set(0,1.9,-.65));
      addCapsule(colliderA,colliderB,.55,'creature');
      for(const limb of limbs){addCapsule(limb.shoulderWorld,limb.jointWorld,.17,'creature upper limb');addCapsule(limb.jointWorld,limb.foot.position,.12,'creature lower limb');}
      return c;
    },
    modelStatus(){return sculpt.inspect();},
    navigationStatus(){return{...navigation.inspect(),position:root.position.toArray(),yaw:root.rotation.y,speed:lastMoveSpeed,feet:limbs.map(l=>({label:l.label,swinging:l.foot.swinging,position:l.foot.position.toArray(),target:l.foot.target.toArray(),support:navigation.supportAt(l.foot.position.x,l.foot.position.z),clearance:navigation.footClearance(l.foot.position.x,l.foot.position.z),reachError:l.reachError,reachDistance:l.reachDistance,legClearance:l.legClearance,shoulder:l.shoulderWorld.toArray(),knee:l.jointWorld.toArray()}))};},
    preview(x:number,z:number,yaw=0){pendingSpawn=undefined;dismissRequested=false;outsideReady=false;offscreen.reset();const spawn=navigation.safeSpawn(x,z);if(!spawn)return;root.position.set(spawn.x,spawn.y,spawn.z);root.rotation.y=yaw;previewDirection.set(Math.sin(yaw),0,Math.cos(yaw));root.visible=true;visualTest=true;navigation.reset();resetFeet();},
    previewStep(dt:number,time:number,speed:number){moveCreature(dt,speed,previewDirection);animateCreature(dt,time);return limbs.map(l=>({swinging:l.foot.swinging,position:l.foot.position.toArray(),reachError:l.reachError,reachDistance:l.reachDistance,legClearance:l.legClearance,shoulder:l.shoulderWorld.toArray(),knee:l.jointWorld.toArray()}));},
    update(dt:number,elapsed:number,player:THREE.Vector3,forward:THREE.Vector3,darkness:number,hours=16){
      tick(dt,elapsed,player,forward,hours);
    },
    dispose(){scene.remove(root);sculpt.dispose();},
  };
  function tick(dt:number,elapsed:number,player:THREE.Vector3,forward:THREE.Vector3,hours:number){
      observe(player,forward);retryIn-=dt;
      outsideReady=root.visible?offscreen.update(protectedNow(),dt):false;
      if(pendingSpawn&&retryIn<=0){
        retryIn=.3;
        const request=pendingSpawn;
        if(request.scheduled&&!schedule.due(naturalCount,hours)){
          pendingSpawn=undefined;nextEncounter=elapsed+3+Math.random()*4;
          return;
        }
        if(attemptSpawn(request,elapsed)){pendingSpawn=undefined;return;}
        // Automatic natural placement owns a finite candidate pass.  Keep the
        // request across frames while its bounded tree/angle cursor advances,
        // then resume the ordinary multi-second retry window once exhausted.
        if(request.scheduled&&request.cursor===0){
          pendingSpawn=undefined;nextEncounter=elapsed+3+Math.random()*4;
        }
      }
      if(dismissRequested){
        if(!root.visible){dismissRequested=false;return;}
        if(endEncounter(elapsed))return;
      }
      if(treeCrawl&&active){
        activeTime+=dt;animateTree(dt,elapsed);notice(dt);
        if(!treeCrawl.descending)treeCrawl.start(awareness.witnessed&&directlyVisible(true));
        if(awareness.promptDue()&&audio.stalkCue(root.position))awareness.prompted();
        if(treeCrawl.done){
          // Preserve all six world contacts and the matched landing pose. Clear
          // old gait/obstacle state before smoothly accelerating out of the tree.
          const departing=treeCrawl;treeCrawl=undefined;const facing=new THREE.Vector3(0,0,1).applyQuaternion(root.quaternion);
          root.rotation.set(0,Math.atan2(facing.x,facing.z),0);navigation.reset(TREE_CRAWL_SPEED);
          previousPosition.copy(root.position);velocity.set(0,0,0);bodyLift=bodyCrouch=lastMoveSpeed=0;
          motion.speed=motion.turnRate=0;nextLift=0;gaitGroup=waveIndex=0;gaitReady=true;
          for(let i=0;i<limbs.length;i++){
            const l=limbs[i],f=departing.feet[i];l.foot=createFoot(f.position,l.foot.group);
            if(f.swing<1){l.foot.from.copy(f.from);l.foot.target.copy(f.target);l.foot.progress=f.swing;l.foot.duration=f.duration;l.foot.lift=.30;l.foot.swinging=true;l.foot.smoothArc=true;}
            l.legClearance=Infinity;
          }
          retreating=true;retreatTime=.001;retreatDirection.copy(facing).setY(0).normalize();
        }
        return;
      }
      if(visualTest){animateCreature(dt,elapsed);return;}
      if(active&&adminMode!=='natural'){
        moveCreature(dt,adminMode==='run'?5.5:adminMode==='walk'?.95:0,retreatDirection);
        animateCreature(dt,elapsed);notice(dt);
        if(protectedNow()){outsideReady=false;offscreen.reset();}
        if(dismissRequested)endEncounter(elapsed);
        return;
      }
      if(!active&&elapsed>nextDistantSound){
        nextDistantSound=elapsed+85+Math.random()*135;
        const angle=Math.random()*Math.PI*2,distance=25+Math.random()*35;
        audio.cue(Math.random()<.6?'branch':'call',new THREE.Vector3(player.x+Math.sin(angle)*distance,player.y+1,player.z+Math.cos(angle)*distance));
      }
      if(!active&&!root.visible&&!pendingSpawn&&elapsed>nextEncounter&&schedule.due(naturalCount,hours)){
        const request:SpawnRequest={mode:'natural',origin:player.clone(),heading:Math.atan2(forward.x,forward.z),cursor:0,scheduled:true};
        pendingSpawn=request;retryIn=0;
      }
      if(!active)return;
      activeTime+=dt;notice(dt);
      toCreature.copy(root.position);toCreature.y+=1.5;toCreature.sub(player);
      const distance=toCreature.length();toCreature.normalize();
      watched=directSight?watched+dt:Math.max(0,watched-dt*.6);
      // Time unseen is not a lifetime. It stays in the woods and works toward
      // a flank until actually recognized, rather than retreating behind us.
      if(distance<10)retreating=true;
      if(awareness.witnessed&&(awareness.seenFor>lifetime||(awareness.seenFor>1.4&&watched>1.1)))retreating=true;
      if(retreating){
        if(retreatTime===0)retreatDirection.copy(root.position).sub(player).setY(0).normalize();
        retreatTime+=dt;
        // Keep the established curved route, but recover if a dead end or foot
        // placement stalled it. Pick a new escape heading, never teleport.
        stuckTime=lastMoveSpeed<.3?stuckTime+dt:0;
        if(stuckTime>1.1){
          const away=Math.atan2(root.position.x-player.x,root.position.z-player.z);
          const offset=stalkSide*(.55+(repositions%3)*.55);stalkSide*=-1;repositions++;
          retreatDirection.set(Math.sin(away+offset),0,Math.cos(away+offset));navigation.replan();stuckTime=0;
        }
        moveCreature(dt,Math.min(6,TREE_CRAWL_SPEED+retreatTime*3),retreatDirection);
      }else if(!awareness.witnessed){
        if(awareness.promptDue()){
          cuePosition.copy(root.position);cuePosition.y+=1.2;
          if(audio.stalkCue(cuePosition))awareness.prompted();
        }
        if(activeTime>=nextReposition&&outsideReady){
          nextReposition=activeTime+4;
          const request:SpawnRequest={mode:'natural',origin:player.clone(),heading:Math.atan2(forward.x,forward.z),cursor:0,reposition:true};
          if(attemptSpawn(request,elapsed))return;
        }
        if(activeTime>1.8){
          const horizontalForward=stalkTarget.copy(forward).setY(0);if(horizontalForward.lengthSq()<.01)horizontalForward.set(0,0,-1);horizontalForward.normalize();
          const fx=horizontalForward.x,fz=horizontalForward.z;
          // A point forward of one shoulder draws a continuous path into the
          // peripheral image. Every metre still goes through safe navigation.
          stalkTarget.set(player.x+fx*14+fz*stalkSide*7,player.y,player.z+fz*14-fx*stalkSide*7);
          movementDirection.copy(stalkTarget).sub(root.position).setY(0);
          if(distance<9)movementDirection.copy(root.position).sub(player).setY(0);
          if(activeTime>nextFlankShift&&(stuckTime>5||movementDirection.length()<1.5)){
            // A trunk can hide the final flank target while its broad safety
            // sphere is on screen. Walk to the other flank; never teleport it.
            stalkSide*=-1;nextFlankShift=activeTime+12;
          }
          const speed=movementDirection.length()>1?THREE.MathUtils.lerp(.95,1.3,THREE.MathUtils.smoothstep(activeTime,18,30)):0;
          movementDirection.normalize();moveCreature(dt,speed,movementDirection);
          stuckTime=lastMoveSpeed<.08&&speed>0?stuckTime+dt:0;
          if(stuckTime>7)nextReposition=Math.min(nextReposition,activeTime);
        }
      }else moveCreature(dt,0,retreatDirection);
      animateCreature(dt,elapsed);
      if(protectedNow()){outsideReady=false;offscreen.reset();}
      if((dismissRequested||(retreating&&retreatTime>1.4&&root.position.distanceTo(player)>12))&&outsideReady)endEncounter(elapsed);
  }
}
