import * as THREE from 'three';
import {createTreeCrawl} from './tree-crawl';
import type { ForestAudio } from './audio';
import {WORLD_RADIUS} from './world';
import type {SolidCollider,createCollisionWorld} from './collision';
import {createCreatureNavigation} from './creature-navigation';
import {createListener} from './listener';
import {SPIDER_SCALE} from './spider-rig';
import {creatureInView,createOffscreenLatch,CREATURE_VIEW_RADIUS,type EncounterView} from './encounter-visibility';
import {inDirectView,sightlineClear,createEncounterAwareness} from './creature-sighting';
import {createCreatureBrain,createRandom,type BrainEvent,type Intent,type NoiseEvent,type PlayerPercept,type Point,type Vec2} from './creature-brain';
import {createOpeningDirector,type DirectorEvent,type OpeningPhase} from './creature-director';

/** What the engine knows about the player each frame, beyond where they stand and look. */
export type CreatureSenses=Omit<PlayerPercept,'x'|'y'|'z'>&{
  /** The screen is black (the player is being taken): nothing can pop in or out of view. */
  blackout?:boolean;
};
export type CreatureMode='natural'|'hunt'|'idle'|'walk'|'run'|'tree';
/** One thing the creature did, for logs and the playtest bot: placements and removals, sounds' reasons, stun phases... */
export type CreatureTrace={t:number;type:string;[key:string]:unknown};
/** The roofed building a player is inside: its door, and which way is out. */
export type DoorQuery=(x:number,z:number)=>{x:number;z:number;outX:number;outZ:number}|undefined;

/**
 * The Listener, always somewhere. Far from the player it is a point travelling through the world with no body;
 * near, the Listener's body walks it. For the first minutes game/creature-director.ts runs a scripted, harmless
 * opening (a glimpse, then the tree); after that game/creature-brain.ts decides what it does: it hears, sees,
 * shadows, hunts and grabs. It is never placed or removed on screen (protectedNow, the off-screen latch).
 */
export function createEncounters(
  scene: THREE.Scene,
  heightAt: (x: number, z: number) => number,
  audio: ForestAudio,
  collisionWorld?: Pick<ReturnType<typeof createCollisionWorld>,'nearby'>,
  getView?:()=>EncounterView,
  waterSurfaceAt?:(x:number,z:number)=>number|undefined,
  options:{places?:readonly Vec2[];seed?:number;doorAt?:DoorQuery;trace?:(event:CreatureTrace)=>void;opening?:boolean}={},
) {
  const root = new THREE.Group();
  root.name = 'something-between-the-trees';
  root.visible = false;
  scene.add(root);
  const body = new THREE.Group();
  root.add(body);
  const navigation=createCreatureNavigation(heightAt,collisionWorld,waterSurfaceAt,SPIDER_SCALE/1.15);
  // The visible eight-legged rig supplies locomotion, visibility bounds and collision.
  const listener=createListener(scene,heightAt,navigation,collisionWorld);
  const sculpt={get ready(){return listener.ready;},inspect(){const box=new THREE.Box3();listener.root.updateMatrixWorld(true);listener.root.traverse(o=>{if((o as THREE.Bone).isBone)box.expandByPoint(o.getWorldPosition(new THREE.Vector3()));});return {ready:listener.ready,model:'listener',visible:listener.root.visible,parentVisible:listener.root.parent?.visible,root:listener.root.position.toArray(),bones:[box.min.toArray(),box.max.toArray()]};},dispose(){listener.dispose();}};
  let currentDarkness=0,treeCollider:(SolidCollider&{kind:'capsule'})|undefined,perchTime=0,stareBoost=0;
  // The crawl controller uses six guide contacts to steer its trunk path. The visible
  // eight-legged rig owns all ground locomotion, contacts, and limb collision.
  const crawlRest=[-1,1].flatMap(side=>Array.from({length:3},(_,i)=>new THREE.Vector3(side*(2.22+i*.16),.035,i===0?2.02:i===1?.05:-1.90)));
  const movementDirection=new THREE.Vector3(),previewDirection=new THREE.Vector3(),attentionTarget=new THREE.Vector3();
  let lastMoveSpeed=0,plannedMoveSpeed=0,visualTest=false;
  function resetFeet(){
    navigation.refresh(root.position.x,root.position.z,0,true);
    lastMoveSpeed=plannedMoveSpeed=0;
    listener.reset();
  }
  function animateCreature(dt:number,time:number){
    listener.walk(dt,time,root.position,root.rotation.y,attentionTarget,currentDarkness,plannedMoveSpeed);
  }
  function moveCreature(dt:number,speed:number,direction:THREE.Vector3,brake?:number){
    const moved=navigation.move(root.position,direction.x,direction.z,speed,dt,brake);
    plannedMoveSpeed=moved.speed;
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
    const fraction=listener.movementAllowance(nx-root.position.x,ny-root.position.y,nz-root.position.z,turn);
    const oldX=root.position.x,oldZ=root.position.z;
    root.position.x=THREE.MathUtils.lerp(root.position.x,nx,fraction);root.position.y=THREE.MathUtils.lerp(root.position.y,ny,fraction);root.position.z=THREE.MathUtils.lerp(root.position.z,nz,fraction);root.rotation.y=oldYaw+turn*fraction;
    lastMoveSpeed=Math.hypot(root.position.x-oldX,root.position.z-oldZ)/Math.max(dt,.001);
  }

  // --- Persistence. Within NEAR it gets a body (placed out of view); beyond FAR, once off screen, it loses it again.
  // Unseen it may not close inside FAR_HOLD: the body has to be placed out of view first.
  const NEAR=80,FAR=105,FAR_HOLD=50,SIGHT_LIMIT=90,LOOK_EVERY=.2,BEAM_RANGE=26,BEAM_ANGLE=15*Math.PI/180,REVEAL_GAP=300;
  // From the middle of its body, how far it can bend and reach down, for a player it has run over.
  // DEAD_AIR: seconds of free roam with neither a sighting nor a sound before it is steered in and makes one.
  // Every sound has to mean something. HISS_QUIET: it hisses when the beam first pins it in an engagement and not again until
  // the beam has been off it this long (or a new hunt begins). ROAR_GAP, HUNT_GAP: one roar per hunt, at its start; a hunt
  // that begins within ROAR_GAP of the last roar, or within HUNT_GAP of the last hunt ending, is the same hunt taken up again.
  // LOUD_QUIET, SIGHT_QUIET: an ambient sound (clicks, knock, branch, call) is no use straight after it has been loud or seen.
  const BRANCH_FAR=70,BODY_REACH=1.2,CALL_GAP=180,PRESENCE_GAP=30,STUN_BRAKE=20,STOP_BRAKE=22,DEAD_AIR=150,DEAD_AIR_CALL=30,HISS_QUIET=45,ROAR_GAP=75,HUNT_GAP=45,LOUD_QUIET=25,SIGHT_QUIET=30;
  const seed=options.seed??7741,brain=createCreatureBrain({random:createRandom(seed),places:options.places}),hostRandom=createRandom(seed*31+7);
  const director=createOpeningDirector({random:createRandom(seed*17+3)});
  if(options.opening===false)director.jump('free');else brain.holdHunting();
  const trace=(elapsed:number,event:{type:string;[key:string]:unknown})=>{options.trace?.({t:elapsed,...event});};
  let frozen=0;
  const FROZEN_AFTER=2,FROZEN_IN_VIEW=6;
  let placed=false,materializeIn=0,lookIn=0,lineOfSight=false,beamOnIt=false,reach=Infinity,strikePending=false,grabbing=false,strikePose=0,blackout=false;
  let lastReveal=-Infinity,lastCall=-Infinity,nextBranch=150,nextClicks=40,nextKnock=240,lastPresence=-Infinity,nearSince=-1,stillFor=0,lastSpot={x:0,z:0},stuck=0,detourUntil=0,detourSide=1;
  // What the player has had of it: the last time it was seen or heard (for the no-dead-air rule) and the last sighting.
  let lastEvidence=0,lastSighted=-Infinity,deadAirAt=0,lastRoar=-Infinity,lastHuntEnd=-Infinity,lastLoud=-Infinity,lastBeam=-Infinity,hissArmed=true;
  /** A creature sound was played: it counts as evidence, and an ambient one opens the PRESENCE_GAP; a loud one (reveal, hiss, roar, grab) quietens the ambient ones for a while. */
  const voiced=(elapsed:number,kind:string,at:THREE.Vector3,presence:boolean)=>{lastEvidence=elapsed;if(presence)lastPresence=elapsed;else lastLoud=elapsed;trace(elapsed,{type:'sound',kind,presence,x:at.x,y:at.y,z:at.z,seen:directSight});};
  /** Free roam: whether an ambient sound would still mean something (the PRESENCE_GAP is kept separately). Not just after it was loud, nor just after it was seen. */
  const ambientOk=(elapsed:number,afterSight=true)=>elapsed-lastPresence>PRESENCE_GAP&&elapsed-lastLoud>LOUD_QUIET&&(!afterSight||elapsed-lastSighted>SIGHT_QUIET);
  const percept:PlayerPercept={x:0,y:0,z:0,vx:0,vz:0,sprinting:false,crouching:false,flashlightOn:false,inWater:false,onLadder:false,indoors:false,untouchable:false};
  const eye=new THREE.Vector3(),chest=new THREE.Vector3();
  let treeCrawl:ReturnType<typeof createTreeCrawl>|undefined;
  let adminMode:CreatureMode='natural',dismissRequested=false,outsideReady=false,retryIn=0;
  type TreeSearch={origin:{x:number;z:number};cursor:number;min?:number;max?:number;along?:number;cone?:number;trees?:(SolidCollider&{kind:'capsule'})[];counted?:number;qualified?:number;passes?:number};
  type SpawnRequest=TreeSearch&{mode:CreatureMode;origin:THREE.Vector3;heading:number;side?:number};
  let pendingSpawn:SpawnRequest|undefined;
  const retreatDirection=new THREE.Vector3(),boundsCenter=new THREE.Vector3();
  const offscreen=createOffscreenLatch();
  const fallbackView={position:new THREE.Vector3(),forward:new THREE.Vector3(0,0,-1),right:new THREE.Vector3(1,0,0),up:new THREE.Vector3(0,1,0),verticalFov:69,aspect:16/9};
  const transitions:{kind:string;inView:boolean;position:number[];elapsed:number}[]=[];
  const awareness=createEncounterAwareness(hostRandom),sightPoints=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()];
  const cuePosition=new THREE.Vector3();
  let headBone:THREE.Object3D|undefined,directSight=false,sightProbeIn=0;
  function directlyVisible(force=false){
    const view=getView?.()??fallbackView;
    headBone??=listener.head();
    if(headBone)headBone.getWorldPosition(sightPoints[0]);else body.localToWorld(sightPoints[0].set(0,1.45,.8));
    body.localToWorld(sightPoints[1].set(0,1.95,-.25));
    listener.shoulders(sightPoints[2],sightPoints[3]);
    // Check the actual camera every frame; cached occlusion never extends the
    // field of view, and the final recognition/reveal always rechecks LOS.
    // A scripted encounter stands further off than a stalking creature comes: it counts as seen out to 48 m.
    const reachOfSight=treeCrawl||script?48:30;
    if(!sightPoints.some(p=>inDirectView(view,p,reachOfSight))){directSight=false;return false;}
    if(!force&&sightProbeIn>0)return directSight;
    sightProbeIn=.08;
    const x=(view.position.x+root.position.x)*.5,z=(view.position.z+root.position.z)*.5;
    const solids=collisionWorld?.nearby(x,z,Math.hypot(view.position.x-root.position.x,view.position.z-root.position.z)*.5+4)??[];
    let shoulders=0;directSight=false;
    for(let i=0;i<sightPoints.length;i++)if(inDirectView(view,sightPoints[i],reachOfSight)&&sightlineClear(view.position,sightPoints[i],heightAt,solids)){
      if(i<2||++shoulders>=2){directSight=true;break;}
    }
    return directSight;
  }
  function notice(dt:number){
    sightProbeIn-=dt;
    awareness.update(dt,directlyVisible(!awareness.witnessed&&awareness.inspect().directExposure>=.14));
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
    // Under the black of being taken nothing on screen can be seen to pop.
    if(blackout)return false;
    boundsCenter.copy(root.position);boundsCenter.y+=2;
    let radius=CREATURE_VIEW_RADIUS;
    radius=Math.max(radius,listener.reach(boundsCenter));
    return creatureInView(getView?.()??fallbackView,boundsCenter,radius);
  }
  const inViewAt=(x:number,y:number,z:number,radius:number)=>!blackout&&creatureInView(getView?.()??fallbackView,{x,y,z},radius);
  function recordTransition(kind:string,elapsed:number,inView:boolean,action:'place'|'remove'|'strike'){
    transitions.push({kind,inView,position:root.position.toArray(),elapsed});if(transitions.length>24)transitions.shift();
    trace(elapsed,{type:'transition',action,kind,inView,x:root.position.x,y:root.position.y,z:root.position.z});
  }
  /** Give it a body at a point, posed, only if neither where it was nor where it goes is on screen. */
  function placeBody(point:{x:number;y:number;z:number},yaw:number,elapsed:number,kind:string){
    if(!sculpt.ready||(root.visible&&(!outsideReady||protectedNow())))return false;
    // Extra room for the first pose and its lifted knees. Pose while hidden and
    // validate again before activation; no first-frame travel across the edge.
    if(inViewAt(point.x,point.y+2,point.z,CREATURE_VIEW_RADIUS+1.5))return false;
    const oldPosition=root.position.clone(),oldYaw=root.rotation.y,wasVisible=root.visible;
    root.visible=false;root.position.set(point.x,point.y,point.z);root.rotation.set(0,yaw,0);
    navigation.reset();resetFeet();animateCreature(0,elapsed);
    if(protectedNow()){
      root.position.copy(oldPosition);root.rotation.set(0,oldYaw,0);navigation.reset();resetFeet();animateCreature(0,elapsed);root.visible=wasVisible;
      return false;
    }
    root.visible=true;visualTest=false;treeCrawl=undefined;directSight=false;sightProbeIn=0;outsideReady=false;offscreen.reset();
    stuck=0;detourUntil=0;lookIn=0;awareness.reset();
    recordTransition(kind,elapsed,protectedNow(),'place');return true;
  }
  /** Take its body away (only off screen, unless forced under black); the creature stays where it is, unseen. */
  function hideBody(elapsed:number,kind:string,force=false){
    if(!force&&root.visible&&(!outsideReady||protectedNow()))return false;
    if(root.visible)recordTransition(kind,elapsed,false,'remove');
    root.visible=false;visualTest=false;treeCrawl=undefined;root.rotation.set(0,root.rotation.y,0);outsideReady=false;offscreen.reset();
    grabbing=false;strikePose=0;stunShown='none';listener.setStrike(0);listener.setRear(0);listener.setRecoil(0);
    return true;
  }
  /** Move the unseen creature to somewhere far from a point. Never while it has a body. */
  function placeFar(origin:{x:number;z:number},min:number,max:number){
    if(root.visible)return false;
    for(let attempt=0;attempt<24;attempt++){
      const angle=hostRandom()*Math.PI*2,distance=min+hostRandom()*(max-min),x=origin.x+Math.sin(angle)*distance,z=origin.z+Math.cos(angle)*distance;
      if(Math.hypot(x,z)>WORLD_RADIUS-90||heightAt(x,z)>45)continue;
      root.position.set(x,heightAt(x,z),z);root.rotation.set(0,angle+Math.PI,0);return true;
    }
    // Hemmed in by the edge of the world: toward the middle instead.
    const angle=Math.atan2(-origin.x,-origin.z),x=origin.x+Math.sin(angle)*min,z=origin.z+Math.cos(angle)*min;
    root.position.set(x,heightAt(x,z),z);root.rotation.set(0,angle+Math.PI,0);return true;
  }
  function commitSpawn(request:SpawnRequest,point:{x:number;y:number;z:number},elapsed:number){
    const toward=Math.atan2(request.origin.x-point.x,request.origin.z-point.z),oldDirection=retreatDirection.clone();
    retreatDirection.set(point.x-request.origin.x,0,point.z-request.origin.z).normalize();
    const yaw=request.mode==='walk'||request.mode==='run'?Math.atan2(retreatDirection.x,retreatDirection.z):toward;
    if(!placeBody(point,yaw,elapsed,root.visible?'replace':'spawn')){retreatDirection.copy(oldDirection);return false;}
    grabbing=false;strikePending=false;dismissRequested=false;retryIn=0;
    adminMode=request.mode==='natural'||request.mode==='hunt'?'natural':request.mode;
    brain.relocated();
    if(request.mode==='hunt')brain.provoke(percept);else if(request.mode==='natural')brain.alert(request.origin,6);
    if(audio.creatureReveal(root.position)){awareness.revealed();lastReveal=elapsed;voiced(elapsed,'reveal',root.position,false);}
    return true;
  }
  function animateTree(dt:number,time:number){
    if(!treeCrawl)return;
    treeCrawl.update(dt);
    root.position.copy(treeCrawl.position);root.quaternion.copy(treeCrawl.rotation);
    const blend=treeCrawl.landingBlend;
    root.updateMatrixWorld(true);
    perchTime=treeCrawl.descending?perchTime:perchTime+dt;
    if(treeCollider)listener.onTree(dt,time,treeCollider,treeCrawl.position,treeCrawl.rotation,.85,blend,Math.max(perchTime,stareBoost),attentionTarget,currentDarkness);
  }
  /** It comes down fast and straight, on the side facing the player, instead of the slow spiral. */
  const TREE_DROP={speed:4,turn:0};
  type Trunk=SolidCollider&{kind:'capsule'};
  /**
   * How high on the trunk it perches: 7-9 m, on the bare bole under its own crown and the canopy round it, where a
   * player who looks up sees it (higher up the needles hide it, and the sighting test, which knows only trunks, would
   * call it seen). Under the lowest bough with room for its legs; a trunk whose crown starts lower will not do.
   */
  const perchOf=(c:Trunk)=>{const ground=heightAt(c.ax,c.az);return c.crownBase===undefined?9:Math.min(9,c.crownBase-ground-3);};
  /** A trunk it can perch on, facing `origin`, with room to come down and get away: tall, thick, a bare bole, a clear landing. */
  function climbable(c:Trunk,origin:{x:number;z:number}){
    if(c.maxY-c.minY<22||c.radius<.44||perchOf(c)<7)return false;
    const angle=Math.atan2(origin.z-c.az,origin.x-c.ax),exitAngle=angle+TREE_DROP.turn,exitX=c.ax+Math.cos(exitAngle)*(c.radius+4),exitZ=c.az+Math.sin(exitAngle)*(c.radius+4);
    if((collisionWorld?.nearby(exitX,exitZ,4)??[]).some(o=>o.kind==='capsule'&&o.tag==='tree'&&Math.hypot(o.ax-exitX,o.az-exitZ)<o.radius+2.7))return false;
    return navigation.canEscape(exitX,exitZ,Math.cos(exitAngle),Math.sin(exitAngle));
  }
  /** Head-down on the trunk, facing `origin`, only if neither the perch nor any limb is in view. */
  function mountTree(c:Trunk,origin:{x:number;z:number},elapsed:number){
    if(root.visible)return false;
    const base=heightAt(c.ax,c.az),angle=Math.atan2(origin.z-c.az,origin.x-c.ax);
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
    const candidate=createTreeCrawl({x:c.ax,z:c.az,ground:base,radius:c.radius,height:c.maxY-base},angle,crawlRest,contact,(x,z)=>navigation.supportAt(x,z),{...TREE_DROP,perch:perchOf(c)});
    if(inViewAt(candidate.position.x,candidate.position.y,candidate.position.z,6))return false;
    // The unseen creature keeps its place in the world if this tree does not work out.
    const held=root.position.clone(),heldYaw=root.rotation.y;
    treeCrawl=candidate;treeCollider=c;perchTime=0;stareBoost=0;listener.reset();animateTree(0,elapsed);
    if(protectedNow()){treeCrawl=undefined;root.position.copy(held);root.rotation.set(0,heldYaw,0);return false;}
    directSight=false;sightProbeIn=0;dismissRequested=false;outsideReady=false;offscreen.reset();navigation.reset();
    lastMoveSpeed=0;grabbing=false;strikePending=false;
    // The reveal waits for the moment it is seen.
    root.visible=true;adminMode='natural';awareness.reset();recordTransition('tree-spawn',elapsed,false,'place');return true;
  }
  /**
   * Head-down on a tall trunk near `origin`, out of view. One escape route is checked per call; a later call picks up
   * at the next candidate. With `along` (a heading) only trunks within `cone` of it count, nearest the line first.
   * After each full pass `qualified` says how many trunks were worth trying at all.
   */
  function spawnTree(request:TreeSearch,elapsed:number){
    if(root.visible)return false;
    const min=request.min??12,max=request.max??26,along=request.along;
    const off=(c:Trunk)=>{if(along===undefined)return 0;const a=Math.atan2(c.ax-request.origin.x,c.az-request.origin.z)-along;return Math.abs(Math.atan2(Math.sin(a),Math.cos(a)));};
    if(!request.trees||request.cursor===0){
      request.trees=(collisionWorld?.nearby(request.origin.x,request.origin.z,max+2)??[]).filter((c):c is Trunk=>c.kind==='capsule'&&c.tag==='tree').sort((a,b)=>off(a)-off(b));
      request.counted=0;
    }
    const trees=request.trees;
    // Check at most one escape route per update. The next retry picks up at
    // the next candidate if this tree is blocked or visible to the player.
    while(request.cursor<trees.length){
      const c=trees[request.cursor++];
      if(c.maxY-c.minY<22||c.radius<.44)continue;
      const distance=Math.hypot(c.ax-request.origin.x,c.az-request.origin.z);if(distance<min||distance>max)continue;
      if(along!==undefined&&off(c)>(request.cone??Math.PI))continue;
      request.counted=(request.counted??0)+1;
      if(!climbable(c,request.origin))return false;
      return mountTree(c,request.origin,elapsed);
    }
    request.cursor=0;request.passes=(request.passes??0)+1;request.qualified=request.counted??0;
    return false;
  }
  function attemptSpawn(request:SpawnRequest,elapsed:number){
    if(!sculpt.ready||(root.visible&&(!outsideReady||protectedNow())))return false;
    if(request.mode==='tree'){
      if(root.visible&&!hideBody(elapsed,'replace'))return false;
      // The developer's tree ambush plays the scripted tree's ending, then hands the creature to its mind.
      if(!spawnTree(request,elapsed))return false;
      script=newScript('tree',elapsed,true);script.stage='perched';script.placedAt=elapsed;trace(elapsed,{type:'script',kind:'tree',variant:'tree',stage:'perched',dev:true});return true;
    }
    const natural=request.mode==='natural'||request.mode==='hunt',side=request.side??=(hostRandom()<.5?-1:1);
    const angles=natural?[side*1.7,-side*1.7,side*2.15,-side*2.15,Math.PI]:[Math.PI,2.55,-2.55,2.1,-2.1];
    const start=request.cursor,end=Math.min(angles.length,start+2);
    for(let i=start;i<end;i++){
      request.cursor=i+1;
      const distance=natural?20+i*1.2:12+i*1.3,angle=request.heading+angles[i];
      const x=request.origin.x+Math.sin(angle)*distance,z=request.origin.z+Math.cos(angle)*distance;
      if(Math.hypot(x,z)>WORLD_RADIUS-85||heightAt(x,z)>45)continue;
      const point=navigation.safeSpawn(x,z);if(!point)continue;
      const finalDistance=Math.hypot(point.x-request.origin.x,point.z-request.origin.z);
      if(natural&&(finalDistance<12||finalDistance>28))continue;
      // safeSpawn can shift up to ten metres: gate its final answer, not just
      // the candidate request. Failed requests leave a live creature intact.
      if(commitSpawn(request,point,elapsed))return true;
    }
    if(request.cursor>=angles.length){request.cursor=0;request.side=undefined;}
    return false;
  }
  // --- Senses the host measures for the brain.
  const solidsAlong=(ax:number,az:number,bx:number,bz:number)=>{
    const found=new Set<SolidCollider>(),steps=Math.max(1,Math.ceil(Math.hypot(bx-ax,bz-az)/7));
    for(let i=0;i<=steps;i++)for(const c of collisionWorld?.nearby(ax+(bx-ax)*i/steps,az+(bz-az)*i/steps,4.5)??[])found.add(c);
    return [...found];
  };
  function eyes(out:THREE.Vector3){
    headBone??=listener.head();
    if(root.visible&&headBone)return headBone.getWorldPosition(out);
    return out.set(root.position.x+Math.sin(root.rotation.y)*1.1,root.position.y+1.7,root.position.z+Math.cos(root.rotation.y)*1.1);
  }
  /** Its eyes to the player's body, and whether the torch has its face (a few times a second). */
  function look(player:THREE.Vector3){
    eyes(eye);chest.set(player.x,player.y+(percept.crouching?.75:1.25),player.z);
    const distance=Math.hypot(chest.x-eye.x,chest.z-eye.z);
    lineOfSight=!percept.untouchable&&distance<SIGHT_LIMIT&&sightlineClear(eye,chest,heightAt,solidsAlong(eye.x,eye.z,chest.x,chest.z));
    const view=getView?.()??fallbackView;
    if(root.visible&&percept.flashlightOn&&lineOfSight){
      const dx=eye.x-view.position.x,dy=eye.y-view.position.y,dz=eye.z-view.position.z,d=Math.hypot(dx,dy,dz);
      beamOnIt=d<BEAM_RANGE&&(dx*view.forward.x+dy*view.forward.y+dz*view.forward.z)/Math.max(d,.001)>Math.cos(BEAM_ANGLE);
    }else beamOnIt=false;
  }
  /**
   * Head and hands to the player's chest, every frame (a charge covers a metre between looks). A player under its
   * body counts as within reach too: an overshooting charge can leave the head past them, never out of reach.
   */
  function measureReach(player:THREE.Vector3){
    if(!root.visible){reach=Infinity;return;}
    eyes(eye);chest.set(player.x,player.y+(percept.crouching?.75:1.25),player.z);
    reach=Math.min(eye.distanceTo(chest),Math.max(0,Math.hypot(player.x-root.position.x,player.z-root.position.z)-BODY_REACH));
  }
  function react(e:BrainEvent,elapsed:number){
    if(e.type==='strike'){
      if(!root.visible||grabbing)return;
      grabbing=strikePending=true;eyes(cuePosition);audio.screech(cuePosition,1);voiced(elapsed,'grab',cuePosition,false);recordTransition('strike',elapsed,protectedNow(),'strike');
    }else if(e.type==='hunt-started'){
      trace(elapsed,{type:'hunt'});
      // One roar per hunt, at its start. A hunt taken up again straight after a stun or a lost chase is the same hunt: silent.
      if(elapsed-lastRoar>ROAR_GAP&&elapsed-lastHuntEnd>HUNT_GAP){lastRoar=elapsed;hissArmed=true;eyes(cuePosition);audio.screech(cuePosition,.5);voiced(elapsed,'roar',cuePosition,false);}
    }
    // The call is ambient, like the clicks: it is for a chase it has lost (not a shadowing that fizzled out), unseen, once the presence gap and the quiet after a loud sound have passed.
    else if(e.type==='lost-player'&&e.from==='hunt'&&!directSight&&elapsed-lastCall>CALL_GAP&&ambientOk(elapsed,false)){lastCall=elapsed;cuePosition.copy(root.position);cuePosition.y+=2;audio.cue('call',cuePosition);voiced(elapsed,'call',cuePosition,true);}
    // The hiss belongs to the start of a stun sequence: the first time the beam pins it in an engagement. Pinned again, it only recoils, until the beam has been off it a good while or a new hunt begins.
    else if(e.type==='flinch'){trace(elapsed,{type:'stun',phase:'slowing',seconds:e.seconds});if(root.visible&&hissArmed){hissArmed=false;eyes(cuePosition);audio.hiss(cuePosition);voiced(elapsed,'hiss',cuePosition,false);}}
    else if(e.type==='stun')trace(elapsed,{type:'stun',phase:e.phase,seconds:e.seconds});
    if(e.type==='behaviour'){trace(elapsed,{type:'behaviour',from:e.from,to:e.to});if(e.from==='hunt')lastHuntEnd=elapsed;}
  }
  function aim(g?:Point){
    if(g)attentionTarget.set(g.x,g.y??heightAt(g.x,g.z)+1.3,g.z);
    else attentionTarget.set(root.position.x+Math.sin(root.rotation.y)*10,root.position.y+1.4,root.position.z+Math.cos(root.rotation.y)*10);
  }
  /** Walk the body where it is wanted, through navigation.move. `brake` (m/s²) lets an eased stop be followed closely. */
  function drive(dt:number,elapsed:number,intent:Intent,brake?:number){
    let speed=intent.speed;const target=intent.target;
    movementDirection.set(Math.sin(root.rotation.y),0,Math.cos(root.rotation.y));
    if(target){
      const dx=target.x-root.position.x,dz=target.z-root.position.z,d=Math.hypot(dx,dz);
      if(d<(intent.arrive??1.2))speed=0;
      if(d>1e-3)movementDirection.set(dx/d,0,dz/d);
    }else speed=0;
    // A dead end or a foot with nowhere to go: try the other way round for a moment. Never teleport.
    if(speed>.6&&lastMoveSpeed<Math.min(.3,speed*.2)){stuck+=dt;if(stuck>1.4){stuck=0;detourUntil=elapsed+2.2;detourSide=-detourSide;navigation.replan();}}
    else stuck=Math.max(0,stuck-dt*.5);
    // Frozen: it wants to go and has not moved at all for a while. A foot left out of reach with no hold to be found (it was
    // seen to hang there for minutes, each frame searching again) pins the body; its feet are set down under it again. Unseen
    // that is at once, in view only after a long wait.
    if(speed>.6&&lastMoveSpeed<.05){frozen+=dt;if(frozen>(outsideReady?FROZEN_AFTER:FROZEN_IN_VIEW)){frozen=0;trace(elapsed,{type:'restance',x:root.position.x,z:root.position.z});navigation.replan();}}
    else frozen=Math.max(0,frozen-dt*2);
    if(elapsed<detourUntil){const a=detourSide*1.1,c=Math.cos(a),s=Math.sin(a),x=movementDirection.x;movementDirection.x=x*c+movementDirection.z*s;movementDirection.z=movementDirection.z*c-x*s;}
    moveCreature(dt,speed,movementDirection,brake);
    animateCreature(dt,elapsed);
  }
  /** Recoiling from the torch: a short step straight back, facing the light, where there is room. */
  function backstep(dt:number,speed:number){
    const yaw=root.rotation.y,x=root.position.x-Math.sin(yaw)*speed*dt,z=root.position.z-Math.cos(yaw)*speed*dt;
    if(navigation.footClearance(x,z)<1.1)return;
    root.position.set(x,THREE.MathUtils.damp(root.position.y,Math.max(heightAt(x,z),navigation.supportAt(x,z)-.48),9,dt),z);
  }
  /** Unseen and far: a point moving straight at the brain's target. No gait, no model. */
  function travel(dt:number,player:THREE.Vector3,intent:Intent){
    const target=intent.target;if(!target||intent.speed<=0)return;
    const dx=target.x-root.position.x,dz=target.z-root.position.z,d=Math.hypot(dx,dz);if(d<(intent.arrive??1.2))return;
    const step=Math.min(d,intent.speed*dt),x=root.position.x+dx/d*step,z=root.position.z+dz/d*step;
    const after=Math.hypot(x-player.x,z-player.z);
    if(after<FAR_HOLD&&after<Math.hypot(root.position.x-player.x,root.position.z-player.z))return;
    if(Math.hypot(x,z)>WORLD_RADIUS-90)return;
    root.position.set(x,heightAt(x,z),z);root.rotation.y=Math.atan2(dx,dz);
  }
  /** The grab: it holds still, turns to the player, reaches, and opens its jaw. The engine does the rest. */
  function hold(dt:number,elapsed:number,player:THREE.Vector3){
    stunShown='none';strikePose=Math.min(1,strikePose+dt/.25);listener.setStrike(strikePose);
    const want=Math.atan2(player.x-root.position.x,player.z-root.position.z),turn=Math.atan2(Math.sin(want-root.rotation.y),Math.cos(want-root.rotation.y));
    root.rotation.y+=THREE.MathUtils.clamp(turn,-dt*1.6,dt*1.6);
    moveCreature(dt,0,movementDirection.set(Math.sin(root.rotation.y),0,Math.cos(root.rotation.y)));
    animateCreature(dt,elapsed);
  }
  // --- The opening (game/creature-director.ts): a glimpse, then the tree, both harmless, before it may hunt.
  // The director keeps the time; what follows does the placing and the walking. One body throughout: while a script
  // runs, the brain does not steer anything.
  type ScriptStage='placing'|'waiting'|'stepping'|'holding'|'leaving'|'perched'|'staring'|'descending'|'rearing'|'charging'|'stopped'|'crossing'|'pausing'|'gone';
  type Script={kind:'glimpse'|'tree';variant:'ground'|'treeline'|'tree'|'cross';stage:ScriptStage;since:number;dev:boolean;step:number;side:number;
    placedAt:number;lookedAt:number;prompted:boolean;seen:boolean;gone:boolean;escalate:boolean;force:boolean;hold:number;fast:boolean;crossed:boolean;
    exit:{x:number;z:number};goal?:{x:number;z:number};mid?:{x:number;z:number};end?:{x:number;z:number};
    trees?:Trunk[];ready:Trunk[];cursor:number;tryIn:number};
  let script:Script|undefined,pendingCall=false,stunShown='none',lastElapsed=0;
  const lastPlayer=new THREE.Vector3(),smoothVelocity={x:0,z:0},course={x:0,z:-1},facing={x:0,z:-1};let courseSpeed=0;
  const scratchA=new THREE.Vector3(),scratchB=new THREE.Vector3();
  /**
   * Where the player is going: their smoothed ground velocity, or where they face when they stand still. The facing
   * is the settled one (a few seconds' average), not the instant view: a glance aside is not a new "ahead".
   */
  function trackTravel(dt:number){
    const k=1-Math.exp(-dt/1.5);smoothVelocity.x+=(percept.vx-smoothVelocity.x)*k;smoothVelocity.z+=(percept.vz-smoothVelocity.z)*k;
    courseSpeed=Math.hypot(smoothVelocity.x,smoothVelocity.z);
    const f=(getView?.()??fallbackView).forward,l=Math.hypot(f.x,f.z),j=1-Math.exp(-dt/4);
    if(l>.1){facing.x+=(f.x/l-facing.x)*j;facing.z+=(f.z/l-facing.z)*j;const m=Math.hypot(facing.x,facing.z)||1;facing.x/=m;facing.z/=m;}
    if(courseSpeed>.4){course.x=smoothVelocity.x/courseSpeed;course.z=smoothVelocity.z/courseSpeed;}else{course.x=facing.x;course.z=facing.z;}
  }
  function newScript(kind:'glimpse'|'tree',elapsed:number,dev=false):Script{
    return {kind,variant:kind==='glimpse'?'ground':'tree',stage:'placing',since:elapsed,dev,step:0,side:hostRandom()<.5?-1:1,placedAt:-Infinity,lookedAt:elapsed,
      prompted:false,seen:false,gone:false,escalate:false,force:false,hold:0,fast:false,crossed:false,exit:{x:0,z:1},ready:[],cursor:0,tryIn:0};
  }
  function enterStage(t:Script,stage:ScriptStage,elapsed:number){t.stage=stage;t.since=elapsed;trace(elapsed,{type:'script',kind:t.kind,variant:t.variant,stage,dev:t.dev});}
  function onDirector(e:DirectorEvent,elapsed:number,player:THREE.Vector3){
    trace(elapsed,{...e,type:e.type==='phase'?'phase':'director',event:e.type});
    if(e.type==='phase'){
      if(e.to==='glimpse'||e.to==='tree')script=newScript(e.to,elapsed);
      // One still walking off into the fog finishes doing so, until free roam: then the brain has the body.
      else if(e.to==='free'?!script?.dev:!(script?.dev||(script?.stage==='leaving'&&root.visible)))script=undefined;
      if(e.to==='free')freeRoam(elapsed,player);
    }else if(e.type==='escalate'&&script&&!script.seen){script.step=e.step;script.escalate=true;}
    else if(e.type==='force'&&script&&!script.seen)script.force=true;
    else if(e.type==='call')pendingCall=true;
  }
  /** The opening is over: it starts its own life 80-120 m off, forgetting nothing but the script. */
  function freeRoam(elapsed:number,player:THREE.Vector3){
    pendingCall=false;placed=true;
    if(!root.visible)placeFar(player,80,120);
    brain.relocated();brain.forget();brain.permitHunting();lastEvidence=elapsed;deadAirAt=0;
  }
  /**
   * End the opening now (a developer spawn or jump, a death): it never replays. Only ever from a developer's hand or
   * under black, so a creature still on its trunk is simply taken away.
   */
  function endOpening(elapsed:number,player:THREE.Vector3){
    if(!director.scripted)return;
    if(treeCrawl&&!script?.dev)hideBody(elapsed,'jump',true);
    for(const e of director.jump('free'))onDirector(e,elapsed,player);
  }
  const exitFrom=(player:THREE.Vector3,side:number)=>{const dx=root.position.x-player.x,dz=root.position.z-player.z,l=Math.hypot(dx,dz)||1,a=Math.atan2(dx/l,dz/l)+side*.5;return{x:Math.sin(a),z:Math.cos(a)};};
  /** Unseen between encounters: it keeps going the way it went, out to about 110 m. */
  function drift(dt:number,player:THREE.Vector3){
    if(root.visible)return;
    const dx=root.position.x-player.x,dz=root.position.z-player.z,d=Math.hypot(dx,dz)||1;if(d>110)return;
    const x=root.position.x+dx/d*2*dt,z=root.position.z+dz/d*2*dt;if(Math.hypot(x,z)>WORLD_RADIUS-90)return;
    root.position.set(x,heightAt(x,z),z);
  }
  const nearestTrunk=(x:number,z:number,radius:number)=>{let best:Trunk|undefined,d=Infinity;for(const c of collisionWorld?.nearby(x,z,radius)??[]){if(c.kind!=='capsule'||c.tag!=='tree'||c.radius<.3)continue;const e=Math.hypot(c.ax-x,c.az-z);if(e<d&&e<radius){d=e;best=c;}}return best;};
  /**
   * Encounter 1: out of view, 25-35 m off, ahead of the player and to one side of where they are going, half behind a
   * trunk, facing them. Each escalation step brings it closer and more directly ahead, as far as the view allows.
   */
  function placeGround(player:THREE.Vector3,elapsed:number,t:Script){
    const u=Math.min(1,t.step/3),distance=THREE.MathUtils.lerp(35,25,u)-hostRandom()*3,want=THREE.MathUtils.lerp(.9,.2,u),base=Math.atan2(course.x,course.z);
    let tries=0;
    // From the wanted bearing outward on its side until it is out of view, then the other side.
    for(let k=0;k<11&&tries<2;k++){
      const side=k<7?t.side:-t.side,bearing=side*(want+(k<7?k:k-7)*.3),x=player.x+Math.sin(base+bearing)*distance,z=player.z+Math.cos(base+bearing)*distance;
      if(Math.hypot(x,z)>WORLD_RADIUS-90||inViewAt(x,heightAt(x,z)+2,z,CREATURE_VIEW_RADIUS+4))continue;
      let px=x,pz=z;const trunk=nearestTrunk(x,z,7);
      if(trunk){
        // Beside the trunk and a little behind it, as the player sees it.
        const ux=trunk.ax-player.x,uz=trunk.az-player.z,l=Math.hypot(ux,uz)||1;
        px=trunk.ax+ux/l*1.2+uz/l*side*(trunk.radius+2.9);pz=trunk.az+uz/l*1.2-ux/l*side*(trunk.radius+2.9);
      }
      tries++;
      const point=navigation.safeSpawn(px,pz);if(!point)continue;
      const d=Math.hypot(point.x-player.x,point.z-player.z);if(d<distance-7||d>distance+7)continue;
      if(placeBody(point,Math.atan2(player.x-point.x,player.z-point.z),elapsed,t.kind==='glimpse'?'glimpse':'tree-ground'))return true;
    }
    return false;
  }
  /** The player has shut themselves in: it waits at the treeline in view of the door, facing it. */
  function placeTreeline(player:THREE.Vector3,elapsed:number,t:Script){
    const door=options.doorAt?.(player.x,player.z);if(!door)return false;
    const base=Math.atan2(door.outX,door.outZ);scratchA.set(door.x,heightAt(door.x,door.z)+1.6,door.z);
    for(let i=0;i<2;i++){
      const k=t.cursor++%15,d=[26,32,21][k%3],a=[0,.3,-.3,.55,-.55][Math.floor(k/3)],x=door.x+Math.sin(base+a)*d,z=door.z+Math.cos(base+a)*d;
      if(inViewAt(x,heightAt(x,z)+2,z,CREATURE_VIEW_RADIUS+4))continue;
      const point=navigation.safeSpawn(x,z);if(!point)continue;
      scratchB.set(point.x,point.y+1.8,point.z);
      if(!sightlineClear(scratchA,scratchB,heightAt,solidsAlong(scratchA.x,scratchA.z,point.x,point.z)))continue;
      if(placeBody(point,Math.atan2(door.x-point.x,door.z-point.z),elapsed,'treeline'))return true;
    }
    return false;
  }
  /**
   * Encounter 2: head-down on a trunk 15-22 m ahead near the player's line of travel. Trunks are vetted a few at a
   * time while the player looks ahead (the escape route is the costly part); the moment one is out of view it is
   * mounted. Each escalation narrows the cone round the line of travel.
   */
  function placeTree(player:THREE.Vector3,elapsed:number,t:Script){
    const along=Math.atan2(course.x,course.z),cone=Math.max(.45,.85-.13*t.step);
    const fits=(c:Trunk)=>{const d=Math.hypot(c.ax-player.x,c.az-player.z),a=Math.atan2(c.ax-player.x,c.az-player.z)-along;return d>=14&&d<=23&&Math.abs(Math.atan2(Math.sin(a),Math.cos(a)))<=cone;};
    if(!t.trees||t.cursor>=t.trees.length){
      t.trees=(collisionWorld?.nearby(player.x,player.z,25)??[]).filter((c):c is Trunk=>c.kind==='capsule'&&c.tag==='tree'&&c.maxY-c.minY>=22&&c.radius>=.44&&perchOf(c as Trunk)>=7&&!t.ready.includes(c as Trunk));t.cursor=0;
    }
    for(let vetted=0;vetted<2&&t.cursor<t.trees.length;){const c=t.trees[t.cursor++];if(!fits(c))continue;vetted++;if(climbable(c,player))t.ready.push(c);}
    t.ready=t.ready.filter(fits);
    for(const c of t.ready){
      const top=heightAt(c.ax,c.az)+perchOf(c);
      if(inViewAt(c.ax,top,c.az,CREATURE_VIEW_RADIUS+2))continue;
      if(mountTree(c,player,elapsed)){t.ready.splice(t.ready.indexOf(c),1);return true;}
    }
    return false;
  }
  /** No tree will do: it crosses the player's path about 30 m ahead, from out of view on one side to the other. */
  function placeCrossing(player:THREE.Vector3,elapsed:number,t:Script){
    const ahead=28+Math.min(10,courseSpeed*5),mid={x:player.x+course.x*ahead,z:player.z+course.z*ahead};
    let tries=0;
    for(const side of [t.side,-t.side])for(const off of [24,32,40]){
      if(tries>=2)return false;
      const sx=mid.x+course.z*side*off-course.x*6,sz=mid.z-course.x*side*off-course.z*6;
      if(Math.hypot(sx,sz)>WORLD_RADIUS-90||inViewAt(sx,heightAt(sx,sz)+2,sz,CREATURE_VIEW_RADIUS+4))continue;
      tries++;
      const point=navigation.safeSpawn(sx,sz);if(!point)continue;
      if(placeBody(point,Math.atan2(mid.x-point.x,mid.z-point.z),elapsed,'cross')){t.mid=mid;t.end={x:mid.x-(point.x-mid.x)*.9,z:mid.z-(point.z-mid.z)*.9};t.crossed=false;return true;}
    }
    return false;
  }
  /** Somewhere a few metres off with nothing between it and the camera: where it steps to when it is hidden. */
  function clearSpot(player:THREE.Vector3){
    const view=getView?.()??fallbackView;
    for(let ring=1;ring<=2;ring++)for(let i=0;i<8;i++){
      const a=i*Math.PI/4,x=root.position.x+Math.sin(a)*ring*3.5,z=root.position.z+Math.cos(a)*ring*3.5,d=Math.hypot(x-player.x,z-player.z);
      if(d<18||d>40||navigation.footClearance(x,z)<2)continue;
      scratchB.set(x,heightAt(x,z)+1.9,z);
      if(sightlineClear(view.position,scratchB,heightAt,solidsAlong(view.position.x,view.position.z,x,z)))return{x,z};
    }
    return undefined;
  }
  /**
   * Walking into view: a spot in the middle of the view, 14-22 m out, with nothing between it and the camera (a forest
   * hides most places at that range); failing that, straight ahead.
   */
  function intoView(player:THREE.Vector3,distance:number){
    const view=getView?.()??fallbackView,f=view.forward,l=Math.hypot(f.x,f.z)||1,fx=f.x/l,fz=f.z/l;
    for(const d of [18,14,22])for(const off of [0,3,-3,6,-6]){
      const x=player.x+fx*d-fz*off,z=player.z+fz*d+fx*off;
      scratchB.set(x,heightAt(x,z)+1.9,z);
      if(sightlineClear(view.position,scratchB,heightAt,solidsAlong(view.position.x,view.position.z,x,z)))return{x,z};
    }
    const d=THREE.MathUtils.clamp(distance,14,22);
    return{x:player.x+fx*d,z:player.z+fz*d};
  }
  /** The eye-drawing cue: not looked at for about 8 s, one run of clicks (close) or a branch crack, from where it is. */
  function prompt(t:Script,elapsed:number,distance:number){
    if(t.prompted||t.seen||directSight||elapsed-t.placedAt<8||elapsed-t.lookedAt<8||elapsed-lastPresence<=PRESENCE_GAP)return;
    cuePosition.copy(root.position);cuePosition.y+=1.2;
    if(distance<22){if(!audio.stalkCue(cuePosition))return;voiced(elapsed,'clicks',cuePosition,true);}
    else{audio.cue('branch',cuePosition);voiced(elapsed,'branch',cuePosition,true);}
    t.prompted=true;
  }
  /** Keep the visible rig's planted contacts while handing the crawl back to ground navigation. */
  function landFromTree(){
    treeCrawl=undefined;const facing=new THREE.Vector3(0,0,1).applyQuaternion(root.quaternion);
    root.rotation.set(0,Math.atan2(facing.x,facing.z),0);navigation.reset();lastMoveSpeed=0;
    retreatDirection.copy(facing).setY(0).normalize();
  }
  /** Turn the body toward the player, slowly, as it stands. Not toward a player under it: that would spin it on the spot. */
  function turnToward(dt:number,player:THREE.Vector3,rate:number){
    if(Math.hypot(player.x-root.position.x,player.z-root.position.z)<5)return;
    const want=Math.atan2(player.x-root.position.x,player.z-root.position.z),turn=Math.atan2(Math.sin(want-root.rotation.y),Math.cos(want-root.rotation.y));
    root.rotation.y+=THREE.MathUtils.clamp(turn,-dt*rate,dt*rate);
  }
  /** It has been recognised: the reveal recording plays now, and the encounter moves on to its ending. */
  function recognised(t:Script,elapsed:number,distance:number){
    t.seen=true;eyes(cuePosition);
    if(audio.creatureReveal(cuePosition)){awareness.revealed();lastReveal=elapsed;voiced(elapsed,'reveal',cuePosition,false);}
    trace(elapsed,{type:'seen',kind:t.kind,variant:t.variant,stage:t.stage,distance});
    if(t.stage==='perched'){t.hold=2+hostRandom();enterStage(t,'staring',elapsed);}
    else if(t.variant==='cross'||t.stage==='descending')return;
    else if(t.kind==='tree'&&(t.stage==='waiting'||t.stage==='stepping'))startRear(t,elapsed);
    else if(t.stage==='waiting'||t.stage==='stepping'){t.hold=2+hostRandom()*2;enterStage(t,'holding',elapsed);}
  }
  function startRear(t:Script,elapsed:number){enterStage(t,'rearing',elapsed);eyes(cuePosition);audio.screech(cuePosition,.5);voiced(elapsed,'roar',cuePosition,false);}
  /** Run the current script one frame. */
  function perform(dt:number,elapsed:number,player:THREE.Vector3){
    const t=script!,inStage=elapsed-t.since;
    let distance=Math.hypot(player.x-root.position.x,player.z-root.position.z);
    if(t.stage==='placing'||t.stage==='gone'){
      // Still on its feet from before (walking off into the fog): it keeps going until it can be moved out of view.
      if(root.visible&&!treeCrawl){drive(dt,elapsed,departure(player,t.side,inStage),undefined);aim(undefined);notice(dt);}
      else{directSight=false;drift(dt,player);}
      if(t.stage==='gone')return;
      if((t.tryIn-=dt)>0)return;t.tryIn=.25;
      let ok=false;
      if(percept.indoors&&options.doorAt){t.variant='treeline';ok=placeTreeline(player,elapsed,t);}
      else if(t.kind==='glimpse'){t.variant='ground';ok=placeGround(player,elapsed,t);}
      else if(t.variant!=='cross'){
        t.variant='tree';ok=placeTree(player,elapsed,t);
        // No trunk will do (none near the line of travel, or every one stays in view): cross the path instead.
        if(!ok&&inStage>8&&(!t.ready.length||inStage>14)){t.variant='cross';trace(elapsed,{type:'script',kind:t.kind,variant:'cross',stage:'placing',fallback:true});}
      }else ok=placeCrossing(player,elapsed,t);
      if(ok){t.placedAt=t.lookedAt=elapsed;t.prompted=false;t.goal=undefined;enterStage(t,t.variant==='tree'?'perched':t.variant==='cross'?'crossing':t.force&&!t.seen?'stepping':'waiting',elapsed);}
      return;
    }
    if(protectedNow())t.lookedAt=elapsed;
    if(treeCrawl&&(t.stage==='perched'||t.stage==='staring'||t.stage==='descending')){
      // On the trunk. The stare winds the head roll and the jaw up within its two or three seconds.
      stareBoost=t.stage==='staring'?4.4+inStage*1.8:0;
      animateTree(dt,elapsed);notice(dt);
      if(t.stage==='perched'){
        // Clicks from above before it is noticed, never two presence sounds within the gap.
        if(!t.seen&&!directSight&&awareness.promptDue()&&elapsed-lastPresence>PRESENCE_GAP){eyes(cuePosition);if(audio.stalkCue(cuePosition)){awareness.prompted();voiced(elapsed,'clicks',cuePosition,true);}}
        if(t.force&&!t.seen){treeCrawl.start(true);enterStage(t,'descending',elapsed);}
        else if(t.escalate){t.escalate=false;if(outsideReady&&!protectedNow()&&hideBody(elapsed,'re-place'))enterStage(t,'placing',elapsed);}
      }else if(t.stage==='staring'){
        // Coming down onto a player standing under it would land on them: it stares on a while longer.
        const landing=Math.hypot(player.x-root.position.x,player.z-root.position.z);
        if(inStage>=t.hold&&(landing>8||inStage>6)){treeCrawl.start(true);enterStage(t,'descending',elapsed);}
      }else if(treeCrawl.done){landFromTree();startRear(t,elapsed);}
      if(!t.seen&&awareness.witnessed)recognised(t,elapsed,distance);
      return;
    }
    // On the ground.
    const head:Point={x:player.x,y:player.y+1.6,z:player.z};
    let intent:Intent={speed:0},gaze:Point|undefined=head,brake:number|undefined,rear=0;
    // Unseen and approached, it keeps its distance: never lets the player inside about 12 m.
    const crowded=!t.seen&&distance<16&&(t.stage==='waiting'||t.stage==='stepping');
    switch(t.stage){
      case 'waiting':
        if(t.force&&!t.seen){t.goal=intoView(player,distance);enterStage(t,'stepping',elapsed);break;}
        if(t.escalate){
          t.escalate=false;
          if(outsideReady&&!protectedNow()&&hideBody(elapsed,'re-place')){enterStage(t,'placing',elapsed);return;}
          // In view but hidden behind something: it steps out where there is a clear line.
          const spot=clearSpot(player);if(spot){t.goal=spot;enterStage(t,'stepping',elapsed);break;}
        }
        turnToward(dt,player,.8);prompt(t,elapsed,distance);
        break;
      case 'stepping':
        if(t.force){
          // The deadline is near: it lopes into the middle of the view, the target kept where the camera points. Left
          // far behind, it is placed again (out of view, as near ahead as the view allows) and comes in from there.
          if(distance>38&&outsideReady&&!protectedNow()&&hideBody(elapsed,'re-place')){t.step=Math.max(t.step,3);enterStage(t,'placing',elapsed);return;}
          if(!t.goal||inStage%1<dt)t.goal=intoView(player,Math.min(distance,26));
          intent={target:t.goal,speed:Math.max(2.6,courseSpeed+1),arrive:1.4};
          break;
        }
        intent={target:t.goal,speed:1.2,arrive:1.4};
        if(t.goal&&Math.hypot(t.goal.x-root.position.x,t.goal.z-root.position.z)<1.6)enterStage(t,'waiting',elapsed);
        break;
      case 'holding':
        // It holds the gaze, head tracking, then turns and walks into the fog.
        turnToward(dt,player,.8);
        if(inStage>=t.hold||distance<14){t.fast=distance<14;t.exit=exitFrom(player,t.side);enterStage(t,'leaving',elapsed);}
        break;
      case 'leaving':{
        if(distance<14)t.fast=true;
        // Making no headway (a ravine, a wall of trunks): it turns aside and tries another way, each side in turn.
        if(inStage%3<dt){if(t.goal&&Math.hypot(root.position.x-t.goal.x,root.position.z-t.goal.z)<1.5){t.side=-t.side;const a=Math.atan2(t.exit.x,t.exit.z)+t.side*1.3;t.exit={x:Math.sin(a),z:Math.cos(a)};}t.goal={x:root.position.x,z:root.position.z};}
        intent={target:{x:player.x+t.exit.x*60,z:player.z+t.exit.z*60},speed:THREE.MathUtils.lerp(t.fast?3.2:1.6,t.fast?7.6:3.2,1-THREE.MathUtils.smoothstep(distance,8,32)),arrive:3};gaze=undefined;
        // It walks off into the fog for a few seconds at least before it is taken away (out of view, as always).
        if(inStage>3&&outsideReady&&!protectedNow()&&distance>28&&hideBody(elapsed,`${t.kind}-gone`)){
          if(t.dev){script=undefined;brain.relocated();return;}
          // Gone without being seen (a crossing nobody looked at): it tries again.
          if(t.seen){t.gone=true;enterStage(t,'gone',elapsed);if(director.phase!==t.kind)script=undefined;}else enterStage(t,'placing',elapsed);
          return;
        }
        // Watched all the way into the fog, or kept in view however it goes: after a while the opening moves on
        // without waiting, and it is taken away whenever it is next out of view.
        if(t.seen&&inStage>25&&(distance>45||inStage>35))t.gone=true;
        break;}
      case 'rearing':
        // Down from the tree: it rears and roars, then bluff-charges.
        rear=1;turnToward(dt,player,1.6);
        if(inStage>=.9)enterStage(t,!percept.indoors&&distance>=10?'charging':'stopped',elapsed);
        break;
      case 'charging':
        // About a second and a half at full tilt, cut short so that the dead stop lands it no nearer than 7.5 m.
        rear=.25;intent={target:{x:player.x,z:player.z},speed:13,arrive:.5};
        {
          const stoppingSpeed=Math.max(lastMoveSpeed,plannedMoveSpeed);
          if(inStage>=1.5||distance-stoppingSpeed**2/(2*STOP_BRAKE)-stoppingSpeed*dt<=8){
            enterStage(t,'stopped',elapsed);intent.speed=0;brake=STOP_BRAKE;
          }
        }
        break;
      case 'stopped':
        // Dead stop, a moment, then it withdraws.
        brake=STOP_BRAKE;rear=Math.max(0,.6-inStage);
        if(inStage>=.8){
          if(t.dev){script=undefined;listener.setRear(0);brain.relocated();brain.force('withdraw');trace(elapsed,{type:'script',kind:'tree',stage:'handed-over',dev:true});return;}
          t.fast=true;t.exit=exitFrom(player,t.side);enterStage(t,'leaving',elapsed);
        }
        break;
      case 'crossing':{
        const goal=t.crossed?t.end!:t.mid!;intent={target:goal,speed:2.6,arrive:1.5};gaze=undefined;
        // Across, or seen and walked at, or simply too long about it (blocked): it goes.
        const done=Math.hypot(goal.x-root.position.x,goal.z-root.position.z)<2.2;
        if(done&&!t.crossed)enterStage(t,'pausing',elapsed);
        else if(done||(t.seen&&distance<14)||inStage>20){t.fast=distance<14;t.exit=exitFrom(player,t.side);enterStage(t,'leaving',elapsed);}
        break;}
      case 'pausing':
        // Midway it stops and turns its head to look, then carries on.
        if(inStage>=1.8){t.crossed=true;enterStage(t,'crossing',elapsed);}
        break;
    }
    if(crowded&&t.stage!=='leaving'){
      const away=exitFrom(player,0);intent={target:{x:player.x+away.x*22,z:player.z+away.z*22},speed:distance<12?4.5:3.2,arrive:1.5};
    }
    listener.setRear(rear);listener.setRecoil(0);
    aim(gaze);drive(dt,elapsed,intent,brake);
    notice(dt);
    distance=Math.hypot(player.x-root.position.x,player.z-root.position.z);
    if(!t.seen&&awareness.witnessed)recognised(t,elapsed,distance);
  }
  let departSide=1,departCheck=0,departFrom={x:0,z:0},departSince=0;
  /** Away from the player and on, turning aside each few seconds it makes no headway. */
  function departure(player:THREE.Vector3,side:number,seconds:number):Intent{
    if(seconds-departCheck>3||seconds<departCheck){if(Math.hypot(root.position.x-departFrom.x,root.position.z-departFrom.z)<1.5)departSide=-departSide;departCheck=seconds;departFrom={x:root.position.x,z:root.position.z};}
    const away=exitFrom(player,side*departSide),d=Math.hypot(player.x-root.position.x,player.z-root.position.z);listener.setRear(0);listener.setRecoil(0);
    return{target:{x:player.x+away.x*60,z:player.z+away.z*60},speed:THREE.MathUtils.lerp(1.8,7.6,1-THREE.MathUtils.smoothstep(d,7,32)),arrive:3};
  }
  /** A body left over from an encounter with no script (it was watched all the way): it walks off and is taken away. */
  function depart(dt:number,elapsed:number,player:THREE.Vector3){
    departSince+=dt;aim(undefined);drive(dt,elapsed,departure(player,1,departSince),undefined);notice(dt);
    if(outsideReady&&!protectedNow()&&Math.hypot(player.x-root.position.x,player.z-root.position.z)>20&&hideBody(elapsed,'departed'))departSince=0;
  }
  /** One frame of the opening: the director's clock, then the script. */
  function opening(dt:number,elapsed:number,player:THREE.Vector3){
    if(director.scripted){
      const d=director.tick({dt,indoors:percept.indoors,seen:!!script?.seen,gone:!!script?.gone});
      for(const e of d.events)onDirector(e,elapsed,player);
      if(script&&!script.seen&&d.forced)script.force=true;
      if(!director.scripted&&!script)return;
    }
    if(script)perform(dt,elapsed,player);
    else if(root.visible)depart(dt,elapsed,player);
    else{directSight=false;drift(dt,player);}
    if(directSight)lastSighted=lastEvidence=elapsed;
    // The interlude's one distant call, from where it went.
    if(pendingCall&&!root.visible&&elapsed-lastPresence>PRESENCE_GAP){cuePosition.copy(root.position);cuePosition.y+=2;audio.cue('call',cuePosition);voiced(elapsed,'call',cuePosition,true);lastCall=elapsed;pendingCall=false;}
    if(root.visible)audio.hush(1-(Math.hypot(player.x-root.position.x,player.z-root.position.z)-12)/28);
  }
  function think(dt:number,elapsed:number,player:THREE.Vector3,hours:number){
    const near=root.visible;
    if(near)notice(dt);else directSight=false;
    lookIn-=dt;if(lookIn<=0){lookIn=LOOK_EVERY;look(player);}
    // The beam on it keeps the engagement going; off it long enough, the next stun hisses again.
    if(beamOnIt)lastBeam=elapsed;else if(!hissArmed&&elapsed-lastBeam>HISS_QUIET)hissArmed=true;
    measureReach(player);
    const out=brain.tick({dt,hours,darkness:currentDarkness,creature:{x:root.position.x,z:root.position.z,yaw:root.rotation.y,speed:near?lastMoveSpeed:undefined},player:percept,lineOfSight,playerLooking:near&&directSight,beamOnIt,reach});
    for(const e of out.events)react(e,elapsed);
    stunShown=out.stun.phase;
    if(grabbing)return;
    const distance=Math.hypot(player.x-root.position.x,player.z-root.position.z);
    // The reveal recording marks the first sighting in a while, at the moment it is seen.
    if(near&&directSight){
      if(elapsed-lastSighted>20&&elapsed-lastReveal>REVEAL_GAP&&elapsed-lastLoud>LOUD_QUIET&&distance<45){eyes(cuePosition);if(audio.creatureReveal(cuePosition)){lastReveal=elapsed;awareness.revealed();voiced(elapsed,'reveal',cuePosition,false);}}
      lastSighted=lastEvidence=elapsed;
    }
    if(near){
      strikePose=Math.max(0,strikePose-dt*2);listener.setStrike(strikePose);
      // The torch: it shrinks from the light and steps back while it is held, then gets going again.
      listener.setRecoil(out.stun.recoil);if(out.stun.backstep>0)backstep(dt,out.stun.backstep);
      // A hunt begins with it rearing and roaring on the spot (the brain holds it still for huntWindup), then it runs.
      listener.setRear(out.behaviour==='hunt'&&out.intent.speed===0&&out.stun.phase==='none'?1:0);
      aim(out.gaze);drive(dt,elapsed,out.intent,out.stun.phase==='none'?undefined:STUN_BRAKE);
      if(protectedNow()){outsideReady=false;offscreen.reset();}
      if(dismissRequested){if(outsideReady&&hideBody(elapsed,'dismiss')){placeFar(player,150,220);dismissRequested=false;brain.forget();}}
      else if(distance>FAR&&out.behaviour!=='hunt'&&outsideReady)hideBody(elapsed,'recede');
      // The birds stop when it is close, whether or not the player has noticed it.
      if(root.visible)audio.hush(1-(distance-12)/28);
      // Letting itself be heard. Sparingly, and each for a reason; never while the player is looking at it (a noise
      // from something in plain view is just an animal making a noise), and never two within half a minute.
      stillFor=Math.hypot(percept.vx,percept.vz)<.4?stillFor+dt:0;
      const closeBy=distance<(percept.indoors?45:28);
      nearSince=closeBy?(nearSince<0?elapsed:nearSince):-1;
      if(root.visible&&!directSight&&!grabbing&&out.behaviour!=='hunt'&&out.behaviour!=='strike'&&ambientOk(elapsed)){
        if(closeBy&&elapsed-nearSince>8&&elapsed>nextClicks){
          // Clicks: it has been close for a while and the player has not found it. From where its head is. A player
          // shut indoors hears it a little more often: it is outside, and wants them to know.
          cuePosition.copy(root.position);cuePosition.y+=1.2;
          if(audio.stalkCue(cuePosition)){voiced(elapsed,'clicks',cuePosition,true);nextClicks=elapsed+(percept.indoors?70:100)+hostRandom()*(percept.indoors?60:100);}
        }else if(elapsed>nextKnock&&stillFor>5&&distance>10&&distance<38&&!percept.indoors){
          // A knock on the trunk beside it: the answer to a player who has stopped to listen. Rare.
          cuePosition.copy(root.position);cuePosition.y+=1.6;
          if(audio.knock(cuePosition)){voiced(elapsed,'knock',cuePosition,true);nextKnock=elapsed+300+hostRandom()*300;}
        }
      }
    }else{
      if(dismissRequested){placeFar(player,150,220);dismissRequested=false;brain.forget();}
      travel(dt,player,out.intent);
      materializeIn-=dt;
      if(distance<NEAR&&materializeIn<=0){
        materializeIn=.3;
        // safeSpawn may shift the stance ten metres; skip the search while even that ring is on screen.
        if(!inViewAt(root.position.x,root.position.y+2,root.position.z,CREATURE_VIEW_RADIUS+11.5)){
          const point=navigation.safeSpawn(root.position.x,root.position.z);
          if(point)placeBody(point,root.rotation.y,elapsed,'arrive');
        }else if(distance<FAR_HOLD+15)arriveFromSide(player,distance,elapsed);
      }
    }
    // A branch breaks where it really is, but only when it has actually covered ground out of sight since the last one.
    if(!directSight&&elapsed>nextBranch&&distance>28&&distance<BRANCH_FAR&&ambientOk(elapsed)&&Math.hypot(root.position.x-lastSpot.x,root.position.z-lastSpot.z)>18){
      nextBranch=elapsed+180+hostRandom()*180;lastSpot.x=root.position.x;lastSpot.z=root.position.z;cuePosition.copy(root.position);cuePosition.y+=1;audio.cue('branch',cuePosition);voiced(elapsed,'branch',cuePosition,true);
    }
    deadAir(elapsed,player,distance);
  }
  /**
   * Close, and somewhere the player is looking, it would be a presence with no body: it cannot be placed in view.
   * Instead it comes in from the side, at the same distance, just out of view, the smallest turn round the player
   * that will do; from there it walks (or runs) into view.
   */
  function arriveFromSide(player:THREE.Vector3,distance:number,elapsed:number){
    const bearing=Math.atan2(root.position.x-player.x,root.position.z-player.z);let tries=0;
    for(const turn of [.6,-.6,1,-1,1.4,-1.4,1.9,-1.9]){
      const a=bearing+turn,x=player.x+Math.sin(a)*distance,z=player.z+Math.cos(a)*distance;
      if(Math.hypot(x,z)>WORLD_RADIUS-90||inViewAt(x,heightAt(x,z)+2,z,CREATURE_VIEW_RADIUS+4))continue;
      if(++tries>2)return;
      const point=navigation.safeSpawn(x,z);
      if(point&&placeBody(point,Math.atan2(player.x-point.x,player.z-point.z),elapsed,'arrive-side')){brain.relocated();return;}
    }
  }
  /**
   * No long dead air: neither seen nor heard for DEAD_AIR seconds, it is steered toward where the player roughly is
   * and makes one sound from where it really is. Close and unseen that is the clicks; within earshot a branch; still
   * far after DEAD_AIR_CALL seconds of coming, its call. The presence gap holds throughout.
   */
  function deadAir(elapsed:number,player:THREE.Vector3,distance:number){
    if(grabbing||percept.untouchable)return;
    if(deadAirAt&&lastEvidence>deadAirAt){deadAirAt=0;return;}
    if(!deadAirAt){
      if(elapsed-lastEvidence<=DEAD_AIR)return;
      deadAirAt=elapsed;brain.alert({x:player.x+(hostRandom()-.5)*16,z:player.z+(hostRandom()-.5)*16},10);trace(elapsed,{type:'dead-air',distance});
    }
    if(elapsed-lastPresence<=PRESENCE_GAP)return;
    let kind:'clicks'|'branch'|'call'|undefined;
    if(root.visible&&!directSight&&distance<26)kind='clicks';
    else if(!directSight&&distance>18&&distance<70)kind='branch';
    else if(!directSight&&elapsed-deadAirAt>DEAD_AIR_CALL)kind='call';
    if(!kind)return;
    cuePosition.copy(root.position);cuePosition.y+=kind==='clicks'?1.2:kind==='call'?2:1;
    if(kind==='clicks'){if(!audio.stalkCue(cuePosition))return;}else audio.cue(kind,cuePosition);
    if(kind==='branch'){lastSpot.x=root.position.x;lastSpot.z=root.position.z;}
    voiced(elapsed,kind,cuePosition,true);deadAirAt=0;
  }
  return {
    spawn(player:THREE.Vector3,forward:THREE.Vector3,mode:CreatureMode='natural'){
      observe(player,forward);
      // A developer spawn ends the opening: the creature is theirs now.
      endOpening(lastElapsed,player);if(!script?.dev)script=undefined;
      pendingSpawn={mode,origin:player.clone(),heading:Math.atan2(forward.x,forward.z),cursor:0};dismissRequested=false;retryIn=0;
    },
    /** Developer dismiss: it breaks off, and once off screen it is far away. */
    dismiss(_elapsed:number){endOpening(lastElapsed,lastPlayer);pendingSpawn=undefined;dismissRequested=true;brain.dismiss();},
    /** A sound in the world: from the objectives' noise stream (footsteps, the torch, ladders, the generator...). */
    hear(noise:NoiseEvent){brain.hear(noise);},
    /** True once when it has reached the player: the engine plays out the grab. */
    takeStrike(){if(!strikePending)return false;strikePending=false;return true;},
    get grabbing(){return grabbing;},
    /** Its face, for the camera to be wrenched toward. */
    headPosition(out:THREE.Vector3){return eyes(out);},
    /** After the player was taken, under black: move it far from where they wake, unseen, and let it calm down. */
    relocate(origin:THREE.Vector3,elapsed:number){
      if(root.visible&&!blackout&&protectedNow())return false;
      // A death ends the opening for good (only a developer can die during it).
      endOpening(elapsed,origin);script=undefined;
      pendingSpawn=undefined;dismissRequested=false;strikePending=false;adminMode='natural';
      hideBody(elapsed,'relocate',true);placeFar(origin,150,220);placed=true;brain.struck();awareness.reset();lastEvidence=elapsed;deadAirAt=0;
      return true;
    },
    /** Game over: a new night. The opening is not played again; hunting is rare again at first. */
    restart(origin:THREE.Vector3,elapsed:number){const moved=this.relocate(origin,elapsed);brain.reset();brain.permitHunting();lastReveal=-Infinity;nextBranch=elapsed+150;nextClicks=elapsed+40;nextKnock=elapsed+240;return moved;},
    /** The opening: its phase and clock, and the scripted encounter if one is running. */
    openingStatus(){return{...director.inspect(),script:script&&{kind:script.kind,variant:script.variant,stage:script.stage,step:script.step,seen:script.seen,force:script.force,dev:script.dev,trunks:{vetted:script.cursor,candidates:script.trees?.length??0,ready:script.ready.length}}};},
    /** Developer: jump the opening to a phase ('glimpse', 'tree', 'free'...) now. */
    jumpOpening(phase:OpeningPhase){if(phase===director.phase)return;if(root.visible&&script)hideBody(lastElapsed,'jump',true);for(const e of director.jump(phase))onDirector(e,lastElapsed,lastPlayer);},
    /** A few numbers, cheaply, every frame if need be (the playtest bot). */
    probe(){return{visible:root.visible,directSight,x:root.position.x,y:root.position.y,z:root.position.z,phase:director.phase,script:script?script.stage:undefined,variant:script?.variant,behaviour:brain.behaviour,stun:stunShown,grabbing,speed:lastMoveSpeed,blocked:navigation.blocked};},
    visibilityStatus(){return{presence:root.visible?'body':'unseen',visible:root.visible,mode:adminMode,treePhase:treeCrawl?(treeCrawl.landing>0?'landing':treeCrawl.descending?'descending':'perched'):null,modelReady:sculpt.ready,inView:root.visible&&protectedNow(),offscreenSeconds:offscreen.outsideSeconds,pendingSpawn:!!pendingSpawn,pendingDismiss:dismissRequested,directSight,grabbing,position:root.position.toArray(),senses:{lineOfSight,beamOnIt,reach},awareness:awareness.inspect(),brain:brain.inspect(),opening:this.openingStatus(),transitions:transitions.map(t=>({...t,position:[...t.position]}))};},
    solidColliders():SolidCollider[]{
      // Mid-grab the limbs stop shoving the player about; the camera belongs to the grab.
      if(!root.visible||grabbing)return [];
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
      listener.limbs(addCapsule);
      return c;
    },
    modelStatus(){return sculpt.inspect();},
    navigationStatus(){return{...navigation.inspect(),position:root.position.toArray(),yaw:root.rotation.y,speed:lastMoveSpeed,feet:listener.feet().map(foot=>({...foot,support:navigation.supportAt(foot.position[0],foot.position[2]),clearance:navigation.footClearance(foot.position[0],foot.position[2])}))};},
    preview(x:number,z:number,yaw=0){pendingSpawn=undefined;dismissRequested=false;outsideReady=false;offscreen.reset();const spawn=navigation.safeSpawn(x,z);if(!spawn)return;root.position.set(spawn.x,spawn.y,spawn.z);root.rotation.y=yaw;previewDirection.set(Math.sin(yaw),0,Math.cos(yaw));root.visible=true;listener.root.visible=true;visualTest=true;grabbing=false;strikePending=false;navigation.reset();resetFeet();},
    previewStep(dt:number,time:number,speed:number){moveCreature(dt,speed,previewDirection);animateCreature(dt,time);return listener.feet();},
    update(dt:number,elapsed:number,player:THREE.Vector3,forward:THREE.Vector3,darkness:number,hours=16,senses?:CreatureSenses){
      currentDarkness=darkness;blackout=!!senses?.blackout;
      percept.x=player.x;percept.y=player.y;percept.z=player.z;
      if(senses){percept.vx=senses.vx;percept.vz=senses.vz;percept.sprinting=senses.sprinting;percept.crouching=senses.crouching;percept.flashlightOn=senses.flashlightOn;percept.inWater=senses.inWater;percept.onLadder=senses.onLadder;percept.indoors=senses.indoors;percept.untouchable=!!senses.untouchable;}
      tick(dt,elapsed,player,forward,hours);listener.root.visible=root.visible;
    },
    dispose(){scene.remove(root);sculpt.dispose();},
  };
  function tick(dt:number,elapsed:number,player:THREE.Vector3,forward:THREE.Vector3,hours:number){
      observe(player,forward);retryIn-=dt;trackTravel(dt);lastElapsed=elapsed;lastPlayer.copy(player);
      if(!placed){placed=true;if(!root.visible)placeFar(player,170,230);}
      outsideReady=root.visible?offscreen.update(protectedNow(),dt):false;
      if(pendingSpawn&&retryIn<=0){
        retryIn=.3;
        // A developer request keeps its bounded candidate cursor across frames until something works.
        if(attemptSpawn(pendingSpawn,elapsed)){pendingSpawn=undefined;return;}
      }
      // Developer modes, the tree and the preview: a dismiss waits until it is off screen, then it is far away.
      if(dismissRequested&&(treeCrawl||visualTest||adminMode!=='natural'||script)){
        if(!root.visible||hideBody(elapsed,'dismiss')){adminMode='natural';script=undefined;placeFar(player,150,220);dismissRequested=false;brain.relocated();brain.forget();return;}
      }
      if(visualTest){animateCreature(dt,elapsed);return;}
      if(adminMode!=='natural'){
        moveCreature(dt,adminMode==='run'?11.2:adminMode==='walk'?.95:0,retreatDirection);
        animateCreature(dt,elapsed);notice(dt);
        if(protectedNow()){outsideReady=false;offscreen.reset();}
        return;
      }
      if(grabbing){hold(dt,elapsed,player);return;}
      // The opening owns the creature until it is over; a developer's tree ambush runs the same script.
      if(director.scripted||script){opening(dt,elapsed,player);return;}
      think(dt,elapsed,player,hours);
  }
}
