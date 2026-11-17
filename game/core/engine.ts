import { guardUnlitLights } from '../render/gpu/light-guards';
import * as THREE from 'three';
import { WORLD_V2, WORLD_SEED } from '../sim/world/world-flags';
import { ROAD } from '../sim/world/road-profile';
import { createWorldV2, doorAt, bedPlan, bedWakePoint } from '../render/props/world-v2';
import { channelOffset } from '../sim/world/world-noise';
import {readSettings,keyLabel,type Action} from './settings';
import { createTerrain, heightAt, exclusion, riverX, roadZ, roadDistance, pathX } from '../render/world/terrain';
import { createForest } from '../render/world/forest';
import { createAtmosphere } from '../render/world/atmosphere';
import { ForestAudio } from '../audio/audio';
import { createEncounters } from '../render/creature/encounters';
import { creatureBuildings } from '../sim/creature/buildings';
import worldAssets from '../data/world-assets.json';
import { createStory } from '../render/props/story';
import { createStableSunShadow, installSunBlend } from '../render/world/shadows';
import { renderRatio, configureAuto } from './quality';
import { detectDevice, describeDevice } from './device';
import { createCollisionWorld, moveCharacter, characterSupportAt, solidContact } from '../sim/world/collision';
import { createAdmin } from '../ui/admin';
import { createSky } from '../render/world/sky';
import { createFarForest } from '../render/world/far-forest';
import { createFarScatter } from '../render/world/far-scatter';
import { createFarPlants } from '../render/world/far-plants';
import { createFarShadow } from '../render/world/far-shadow';
import { bakeFarForest } from '../render/world/mountain-bake-run';
import { biomeAt, riverSurfaceAt, WORLD_DESTINATIONS, terrainHeightStats } from '../sim/world/world';
import { createFlashlight } from '../render/props/flashlight';
import { createTapTracker } from './tap';
import type { EncounterView } from '../sim/creature/encounter-visibility';
import type { NoiseEvent as CreatureNoise } from '../sim/creature/creature-brain';
import { NOISE, footstepNoise } from '../sim/noise/noise-scale';
import { createRun, RUN, type RunEvent, type SleepResult } from '../sim/run/run';
import { createDayNoise } from '../sim/run/day-noise';
import { createBreathHold } from '../sim/player/breath-hold';
import { surfaceAt, stepSurfaceOf } from '../sim/world/surface';
import type { CreatureSenses, CreatureMode } from '../render/creature/encounters';
import { guideKind, hasRoom, canSprint, heldItem, heldKind, isHeavy, type ObjectiveEvent } from '../sim/objectives/objectives';
import { createObjectiveHud, OBJECTIVE_KEY } from '../ui/objective-hud';
import { createInventory, INVENTORY_KEY } from '../ui/inventory';
import { createIslandMap } from '../ui/island-map';
import { createPlaceBanner, createBannerTracker } from '../ui/place-banner';
import { placeAt } from '../sim/world/places';
import { createPerfOverlay, PERF_OVERLAY_KEY } from '../ui/perf-overlay';
import { objectiveText } from '../sim/objectives/objective-text';
import { POI_PLACEMENTS, LAIR_ID, placeLocal } from '../sim/world/world-layout';
import { createBicycle, BICYCLE } from '../sim/player/bicycle';
import { createBicycleView } from '../render/props/bicycle';
import { createBicycleAudio } from '../audio/bicycle-audio';
import { angleDelta } from '../render/props/bicycle-math';
import { islandRoutes as islandRoutesFrom } from '../sim/world/island-routes';
// Lives are retired (the run keeps everything and only loses time, game/sim/run/run.ts); lives.ts stays for the timing of being taken.
import { grabTimeline, GRAB } from '../sim/player/lives';
import { createPerfProbe, drawList, shadowInstanceCulling, textureReport } from '../dev/perf-probe';
import { perfOn, perfSwitches } from './perf-flags';
import { createGpuWarmup } from '../render/gpu/gpu-warmup';
import { createTextureSlicer } from '../render/gpu/texture-slicer';
import { createShadowProgramWarmer } from '../render/gpu/shadow-programs';
import { createStamina, gaitSpeed, sprintFov } from '../sim/player/stamina';
import { createStaminaHud } from '../ui/stamina-hud';
import { createLoadingHud, type LoadingHud } from '../ui/loading-hud';
import { createLoadingProgress } from '../ui/loading-progress';
import { waterDepthAt, wadeSpeedFactor, limitWading } from '../sim/world/water-depth';
import { eyeExposure, type Grade } from '../render/post/final-image';
import { indoorEye } from '../render/post/grade';

// Deep lakes and open sea support a swimming body, rather than a player
// walking across the bottom with the camera below the water surface.
const movementGround=(x:number,z:number)=>{
  const bed=heightAt(x,z),water=riverSurfaceAt(x,z);
  return water!==undefined?Math.max(bed,water-.95):bed;
};

/** `hud` is the loading corner main.ts made before this chunk arrived; without one (tools, tests) the game makes its own. */
export async function createGame(container:HTMLElement,hud?:LoadingHud):Promise<()=>void> {
  let saved:string|null=null;try{saved=localStorage.getItem('silence-settings');}catch{}
  const settings=readSettings(saved);
  const veil=document.createElement('div');veil.style.cssText='position:absolute;inset:0;background:#000;z-index:100;pointer-events:none;opacity:1';container.appendChild(veil);
  let loading=true,loadCompleteAt=Infinity,pendingAssets=0,lastAsset=performance.now(),texturesDirty=true;
  // Where the start-up's synchronous building goes, stage by stage, in ms since createGame began (dev: __SILENCE__.perf.startup()).
  const startupAt=performance.now(),startupMarks:[string,number][]=[],startupMark=(stage:string)=>{startupMarks.push([stage,Math.round(performance.now()-startupAt)]);};
  // The corner on the veil that says what is loading and how far along it is (ui/loading-hud.ts); it is fed from the counts below.
  const loadingHud=hud??createLoadingHud(container),loadingProgress=createLoadingProgress();
  // The world is built in stages with a painted frame between them, so the tab is never frozen for the whole build at once and the
  // corner says what is being built. Each stage is still one long task (the terrain, the forest and the props were 1.6 to 2.7 s each,
  // the whole build 6.6 s, on the Windows PC this was measured on). A hidden tab gets no frames: the timeout keeps it building.
  const buildStage=async(label:string,fraction:number)=>{
    loadingHud.update(loadingProgress.stage(label,fraction),performance.now());
    await new Promise<void>(resolve=>{let done=false;const go=()=>{if(!done){done=true;resolve();}};requestAnimationFrame(()=>setTimeout(go,0));setTimeout(go,100);});
  };
  const manager=THREE.DefaultLoadingManager,oldStart=manager.onStart,oldLoad=manager.onLoad,oldProgress=manager.onProgress;
  manager.onStart=()=>{pendingAssets++;lastAsset=performance.now();};manager.onLoad=()=>{pendingAssets=0;lastAsset=performance.now();};manager.onProgress=(url,loaded,total)=>{lastAsset=performance.now();texturesDirty=true;loadingProgress.asset(url,loaded,total);};
  const scene = new THREE.Scene();
  // The far plane reaches the sea's horizon: the island stands alone in open water, the sea drawn out to 16 km (river.ts). Depth
  // precision near the eye is set by the near plane alone (1/z), so this costs the near ground nothing.
  const camera = new THREE.PerspectiveCamera(69,window.innerWidth/window.innerHeight,.075,20000);
  camera.rotation.order='YXZ';camera.layers.enable(2);
  // The field of view the settings ask for, eased towards; the sprint widening is added on top of it each frame.
  let baseFov=camera.fov;
  if(perfOn('lightGuards'))guardUnlitLights();
  // The sun's second shadow map (shadows.ts): carried to the lighting chunk in a light probe that lights nothing. Must run after the guard.
  installSunBlend();
  const renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance',alpha:false});
  // What this is running on (device.ts): the per-device policies are read from here, and the line in the console says which apply.
  const device=detectDevice(renderer.getContext());configureAuto(device.policy.nativeRows);scene.userData.device=device;
  console.info(`SILENCE: ${describeDevice(device)} (${device.discrete?'discrete':'shared-memory'} GPU, ${device.highDensity?'high':'standard'}-density screen).`);
  let pixelRatio=renderRatio(settings.resolution,window.innerWidth,window.innerHeight,window.devicePixelRatio);
  renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
  renderer.toneMapping=THREE.NoToneMapping;
  renderer.info.autoReset=false;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate=false;
  scene.userData.maxAnisotropy=renderer.capabilities.getMaxAnisotropy();
  renderer.domElement.setAttribute('aria-label','First-person view of a misty forest');
  renderer.domElement.tabIndex=0;
  container.appendChild(renderer.domElement);
  const hemi=new THREE.HemisphereLight(0xc5d7d4,0x383e29,1.0);scene.add(hemi);
  const sun=new THREE.DirectionalLight(0xffefd0,.95);
  sun.position.set(25,37,-68);sun.castShadow=true;sun.shadow.autoUpdate=false;
  // three lights only what shares a layer with the camera: the water's far reflection pass draws layer 3 (river.ts), and
  // without them the reflected mountains were lit by the environment alone, nearly black. The torch and the lamps join too.
  sun.layers.enable(3);hemi.layers.enable(3);
  const sunProbe=new THREE.LightProbe();
  const sunShadow=createStableSunShadow(sun,renderer.capabilities.maxTextureSize,()=>perfOn('sunShadowThrottle'),sunProbe,renderer);
  scene.add(sun,sun.target,sunProbe);
  startupMark('renderer');const sky=createSky(renderer,scene,sun,hemi);startupMark('sky');
  // A new game starts at 07:00 on day 1, waking beside the cabin's bed (the trail spawn only if the model has none).
  const home=WORLD_V2?bedWakePoint():undefined;
  const player=home?new THREE.Vector3(home.x,heightAt(home.x,home.z),home.z):new THREE.Vector3(pathX(12),heightAt(pathX(12),12),12);
  // The sun's shadows over the whole island (far-shadow.ts): the distant ground and the forest cast into it and sample it.
  const farShadow=WORLD_V2?createFarShadow(renderer):undefined;
  startupMark('far shadow');await buildStage('Shaping the land',.01);const terrain=createTerrain(scene,player,renderer,farShadow);startupMark('terrain');
  await buildStage('Planting the forest',.02);const forest=createForest(scene,heightAt,exclusion,player,farShadow);startupMark('forest');
  // The forest past the streamed trees, to the island's edge and up the range (far-forest.ts): the same trees, as impostors.
  const farForest=WORLD_V2?createFarForest(scene,renderer,forest.impostorSource,player,farShadow):undefined;
  // The forest floor's boulders, stumps, fallen trunks and branches past the streamed ones (far-scatter.ts): the same pieces, as impostors.
  const farScatter=WORLD_V2?createFarScatter(scene,renderer,forest.impostorSource,player,farShadow):undefined;
  // The undergrowth past its streamed ring (far-plants.ts): the same plants from the same ecology, as impostors, grown in a worker.
  const farPlants=WORLD_V2?createFarPlants(scene,renderer,forest.impostorSource,player,farShadow):undefined;startupMark('far forest, scatter and plants');
  if(farForest){
    void terrain.mountainTrees.then(d=>farForest.setRange(d.trees,d.horizons));
    const grid=terrain.heightGrid;if(grid)void bakeFarForest(grid.heights,grid.n,grid.step,grid.x0).then(d=>{farForest.setIsland(d);farScatter?.setData(d);terrain.setFarGround(d.groundA,d.groundB);farPlants?.start(grid,player);});
  }
  const story=createStory(scene,heightAt);startupMark('story');
  const collisions=createCollisionWorld();scene.userData.treesNear=(x:number,z:number,r:number)=>collisions.nearby(x,z,r);   // the fog shades itself under the crowns (atmosphere.ts)
  collisions.replace('story',story.solidColliders);
  let forestCollisionVersion=-1,terrainCollisionVersion=-1;
  startupMark('collisions');const atmosphere=createAtmosphere(renderer,scene,camera,terrain.water,sun);startupMark('atmosphere');
  const audio=new ForestAudio();audio.setVolumes(settings);
  // The run (game/sim/run/run.ts): five days, dawn 06:00, a start at 07:00 on day 1. Being taken or sleeping moves the run's own time
  // (caught(), sleep()) and the clock is set to where it says: advance() is never called across such a jump, or it would count it twice.
  const gameRun=createRun(),dayNoise=createDayNoise(),breathHold=createBreathHold();
  let hours:number=RUN.startHour;
  /** The objectives' clock: absolute game hours that never go back (a night past midnight belongs to the day it began in, so it adds 24). */
  const absHours=()=>(gameRun.day-1+(hours<RUN.dawnHour?1:0))*24+hours;
  // One stream of sounds for the creature. The rebuilt world owns it (the objectives' noises go there); the
  // classic world has only what the engine adds: footsteps and the torch switch.
  type Noise=Extract<ObjectiveEvent,{type:'noise'}>;
  const classicNoise=new Set<(e:Noise)=>void>();
  const noise={
    emit:(e:Noise)=>{if(world2)world2.noise.emit(e);else for(const listener of classicNoise)listener(e);},
    subscribe:(listener:(e:Noise)=>void)=>{if(world2)return world2.noise.subscribe(listener);classicNoise.add(listener);return()=>{classicNoise.delete(listener);};},
  };
  const flashlight=createFlashlight(scene,camera,heightAt,collisions,()=>{audio.flashlightClick();noise.emit({type:'noise',loudness:NOISE.torchClick,source:'flashlight',x:player.x,z:player.z});});
  // The run's machines as world-v2 reports them (the relay's and the pad's generators, the helicopter while its rotors turn): synced
  // each frame into the creature's running sources and, for a generator, the game's own engine voice (syncMachines).
  const machines=new Map<string,{x:number;y:number;z:number;kind:'generator'|'helicopter'}>();
  await buildStage('Putting up the buildings',.04);const world2=WORLD_V2?createWorldV2({scene,camera,container,heightAt,farShadow,collisions,flashlight,water:terrain.water,viewHeight:()=>renderer.domElement.height,riverX,exclusion,interactKey:()=>keyLabel(settings.bindings.interact),onSleep:()=>trySleep(),
    onMachine:(id,at,kind)=>{if(at)machines.set(id,{x:at.x,y:at.y,z:at.z,kind});else machines.delete(id);return kind==='generator';},
    onEscaped:()=>{gameRun.won();console.info(`SILENCE: escaped on day ${gameRun.day}.`);}}):undefined;startupMark('world props');
  // Standing on the cabin's floor, not under it: the colliders are registered by now.
  if(home)player.y=characterSupportAt(player.x,player.z,player.y+.5,heightAt,collisions);
  // The objective in the top-left corner (rebuilt world only): always shown. O hides or shows it, and so does the Settings checkbox;
  // both are the one saved setting, so the choice is still there after a reload.
  const saveSettings=()=>{try{localStorage.setItem('silence-settings',JSON.stringify(settings));}catch{}};
  const objectiveHud=world2?createObjectiveHud(container,{enabled:()=>settings.objectiveHints,setEnabled:on=>{settings.objectiveHints=on;saveSettings();}}):undefined;
  // I: the backpack. Opening it frees the mouse to drag things about (the view stops turning, walking goes on); losing the pointer lock
  // for it is not a pause. Closing it takes the mouse back.
  let inventoryOpen=false;
  const inventory=world2?createInventory(container,{
    read:()=>world2.inventory(),
    move:(from,to)=>{world2.moveItem(from,to);},
    drop:slot=>{if(world2.drop(slot))shadowDirty=true;},
    onOpenChange:open=>{
      inventoryOpen=open;
      if(open){if(document.pointerLockElement===renderer.domElement)document.exitPointerLock();}
      else start();
    },
  }):undefined;
  // M: the paper map (game/ui/island-map.ts), freeing the mouse like the backpack; the game goes on behind it. A place's name shows on walking in.
  let mapOpen=false,mapAt=-1e9;
  const islandMap=world2?createIslandMap(container,{onOpenChange:open=>{mapOpen=open;if(open){if(document.pointerLockElement===renderer.domElement)document.exitPointerLock();}else if(!inventoryOpen)start();}}):undefined;
  const placeBanner=world2?createPlaceBanner(container):undefined,bannerTracker=createBannerTracker();
  // Sprint stamina (game/sim/player/stamina.ts) and its bar, which only shows while stamina is below full (game/ui/stamina-hud.ts).
  const stamina=createStamina(),staminaHud=createStaminaHud(container);
  const interact=(pickupOnly=false)=>grab?false:bike.mounted?(!pickupOnly&&flashlight.toggle()):world2?world2.activate(pickupOnly)||(!pickupOnly&&flashlight.toggle()):flashlight.interact(pickupOnly);
  const mouseTap=createTapTracker(),touchTap=createTapTracker();
  let touchTapId:number|undefined,lastTouch=-Infinity;
  const reflectionView={position:new THREE.Vector3(),forward:new THREE.Vector3(),right:new THREE.Vector3(),up:new THREE.Vector3(),verticalFov:camera.fov,aspect:camera.aspect};
  const encounterView={position:new THREE.Vector3(),forward:new THREE.Vector3(),right:new THREE.Vector3(),up:new THREE.Vector3(),verticalFov:camera.fov,aspect:camera.aspect,reflected:reflectionView};
  const readEncounterView=():EncounterView=>{
    camera.updateMatrixWorld(true);encounterView.position.copy(camera.position);camera.getWorldDirection(encounterView.forward);
    encounterView.right.setFromMatrixColumn(camera.matrixWorld,0);encounterView.up.setFromMatrixColumn(camera.matrixWorld,1);
    encounterView.verticalFov=reflectionView.verticalFov=camera.fov;encounterView.aspect=reflectionView.aspect=camera.aspect;
    const plane=terrain.water.reflectionPlane,n=plane.normal;
    reflectionView.position.copy(camera.position).addScaledVector(n,-2*plane.distanceToPoint(camera.position));
    for(const axis of ['forward','right','up'] as const){reflectionView[axis].copy(encounterView[axis]);reflectionView[axis].addScaledVector(n,-2*reflectionView[axis].dot(n));}
    return encounterView;
  };
  // The places the old patrol walked, kept as the brain's fallback round: the rebuilt world's landmarks, or the classic destinations.
  const creaturePlaces=WORLD_V2?POI_PLACEMENTS.filter(p=>['cabin','hut','generator','mast','lookout','logstack','camp','chapel','mine'].includes(p.asset)).map(p=>({x:p.x,z:p.z})):WORLD_DESTINATIONS.map(d=>({x:d.x,z:d.z}));
  // Where it sleeps by day: the place this island's seed picked (world-layout LAIR_ID).
  const lairPoi=WORLD_V2?POI_PLACEMENTS.find(p=>p.id===LAIR_ID):undefined,lair=lairPoi&&{x:lairPoi.x,z:lairPoi.z};
  // Its night's round: the day's noisy places (the player's own doing, loudest first) and then the island's paths and roads from the lair
  // outward (game/sim/world/island-routes.ts), built on the first dusk.
  let routePoints:{x:number;z:number}[]|undefined;
  const islandRoutes=()=>routePoints??=WORLD_V2?islandRoutesFrom(lair):[];
  const creatureRound=()=>[...dayNoise.places(6).map(p=>({x:p.x,z:p.z})),...islandRoutes()];
  // The scripted opening (a glimpse, then the tree) was built for a 16:00 start on the trail; the run starts at 07:00 in the cabin with the
  // Listener asleep in its lair, so the opening is off (opening:false). Its code stays in creature-director.ts and encounters.ts.
  startupMark('player and HUD');const encounters=createEncounters(scene,heightAt,audio,collisions,readEncounterView,riverSurfaceAt,{places:creaturePlaces,seed:WORLD_SEED||7741,doorAt:world2?doorAt:undefined,opening:false,lair,round:creatureRound,
    buildings:WORLD_V2?creatureBuildings(POI_PLACEMENTS,worldAssets as unknown as Parameters<typeof creatureBuildings>[1]):undefined,doors:world2?.debug.doors});startupMark('creature');
  // What syncMachines last told the creature and the speakers was running, and when each was last written into the day's noise.
  const machinesOn=new Map<string,{x:number;y:number;z:number;recordIn:number}>();
  /**
   * The machines into the creature's hearing and the speakers. A generator is heard to 150 m for as long as it runs; the helicopter,
   * as the design has it, by the whole island ("the helicopter is the noise, and it brings the Listener running"). Each also goes in
   * the day's noise every few seconds while it runs, so the loudest place of the day can be a machine left running.
   */
  function syncMachines(dt:number){
    for(const [id,m] of machines){
      const loudness=m.kind==='helicopter'?NOISE.island:NOISE.generator;
      encounters.source(id,{x:m.x,z:m.z,loudness});
      if(m.kind==='generator')audio.engine(id,m,true,'generator');
      let on=machinesOn.get(id);if(!on){on={x:m.x,y:m.y,z:m.z,recordIn:0};machinesOn.set(id,on);}
      on.x=m.x;on.y=m.y;on.z=m.z;
      if((on.recordIn-=dt)<=0){on.recordIn=7;dayNoise.record({x:m.x,z:m.z,loudness,sustained:true,hours:absHours()});}
    }
    for(const [id,on] of machinesOn)if(!machines.has(id)){encounters.source(id,null);audio.engine(id,on,false);machinesOn.delete(id);}
  }
  // Every noise reaches the Listener and goes into the day's log (game/sim/run/day-noise.ts), which picks its first stop at dusk.
  const unsubscribeNoise=noise.subscribe(e=>{if(e.x!==undefined&&e.z!==undefined){encounters.hear({loudness:e.loudness,source:e.source,x:e.x,z:e.z,sustained:e.sustained} satisfies CreatureNoise);dayNoise.record({x:e.x,z:e.z,loudness:e.loudness,sustained:e.sustained,hours:absHours()});}});
  const creature=scene.getObjectByName('something-between-the-trees')!;
  const velocity=new THREE.Vector3();
  let jumpVelocity=0, airborne=false, jumpRequested=false;
  // Last frame's measured ground speed and ladder state: the stamina model decides about sprinting before this frame's movement is known.
  let lastSpeed=0,wasClimbing=false;
  const forward=new THREE.Vector3(0,0,-1);
  const keys=new Set<string>();
  let yaw=home?home.yaw:Math.atan2(player.x-pathX(player.z-8),8),pitch=home?-.08:-.045,elapsed=0,walkingPhase=0,cameraHeight=1.69;
  const startPoint={x:player.x,z:player.z,yaw};
  // The bicycle (game/sim/player/bicycle.ts rules, game/render/props/bicycle.ts parts, game/audio/bicycle-audio.ts sounds): one, parked by the
  // cabin's door facing out, back there each dawn. E on it rides, E again gets off; W pedals, S brakes, A and D steer, Z rings the bell.
  // While ridden the bicycle owns the heading and the speed, the engine owns the position (the same collision, a wider body), and the camera
  // sits at the rider's eye on the saddle, rolled by a share of the lean. A heavy part in hand can be strapped to the rack.
  const cabinSeat=WORLD_V2?POI_PLACEMENTS.find(p=>p.id==='cabin'):undefined;
  const bikeSpot=cabinSeat?(([x,z])=>({x,z,yaw:cabinSeat.yaw}))(placeLocal(cabinSeat,-3.7,8.2)):undefined;
  const bike=createBicycle(bikeSpot??{x:player.x,z:player.z}),bikeAudio=createBicycleAudio();
  const bikeSurface=()=>surfaceAt(player.x,player.z);
  const bikeView=world2&&bikeSpot?createBicycleView({scene,ground:(x,z)=>characterSupportAt(x,z,(bike.mounted?player.y:heightAt(x,z))+.3,heightAt,collisions,.05)}):undefined;
  const BIKE_BODY=.45,LOOK_LIMIT=100*Math.PI/180;
  let rideHeading=0,rideSpeed=0,rideInput={throttle:0,brake:0,steer:0},strappedId:string|undefined,wasRolling=false;
  const resetBike=()=>{
    if(!bikeView||!bikeSpot)return;
    bike.home();strappedId=undefined;rideSpeed=0;bikeView.park(bikeSpot.x,bikeSpot.z,bikeSpot.yaw);
  };
  if(bikeView&&bikeSpot)resetBike();
  const ringBell=()=>{
    const loudness=bike.ring();if(loudness<=0)return;
    bikeAudio.bell();noise.emit({type:'noise',loudness,source:'bell',x:player.x,z:player.z});
  };
  function mountBike(){
    if(!bikeView||bike.mounted||grab||flying||world2?.climbing||airborne)return false;
    const stand={x:bike.position.x,z:bike.position.z};
    // Getting on takes the bicycle's own place, facing where the player looks.
    if(!bike.mount({x:player.x,z:player.z},bikeSurface(),yaw))return false;
    bike.place(stand.x,stand.z);player.x=stand.x;player.z=stand.z;player.y=characterSupportAt(stand.x,stand.z,player.y+.3,movementGround,collisions);
    velocity.set(0,0,0);rideHeading=yaw;rideSpeed=0;rideInput={throttle:0,brake:0,steer:0};
    return true;
  }
  function dismountBike(){
    if(!bikeView||!bike.dismount())return;
    const at=bikeView.yaw,right=new THREE.Vector3(-Math.cos(at),0,Math.sin(at)),back=new THREE.Vector3(-Math.sin(at),0,-Math.cos(at));
    // Beside it on a free spot: the right, the left, behind, ahead; the bicycle itself stays where it stands.
    const free=(x:number,z:number)=>surfaceAt(x,z)!=='water'&&!collisions.nearby(x,z,.5).some(c=>!(c.minY>player.y+1.69+.025||c.maxY<player.y-.12)&&solidContact(c,x,z,.3).depth>0);
    const spots=[[right,.95],[right,-.95],[back,1.25],[back,-1.25]] as const;
    for(const[direction,distance]of spots){
      const x=player.x+direction.x*distance,z=player.z+direction.z*distance;
      if(free(x,z)){player.x=x;player.z=z;player.y=characterSupportAt(x,z,player.y+.3,movementGround,collisions);break;}
    }
    bikeView.park(bike.position.x,bike.position.z,at);rideSpeed=0;velocity.set(0,0,0);
  }
  // Heavy parts in hand go on the rack (the part stays "carried" in the objectives' state, so the rules for a heavy load stay the same,
  // and is drawn on the rack hook for as long as it is strapped); letting go of it any other way (dropping it) frees the rack.
  let aimBike:()=>void=()=>{};
  if(world2&&bikeView){
    const itemName=(kind:string|undefined)=>kind==='jerry'?'jerry can':kind??'part';
    const ride=new THREE.Vector3(),rack=new THREE.Vector3(),me=()=>world2.localPlayer,state=()=>world2.objectiveState;
    const aim=()=>{bikeView.promptPoint(ride);bikeView.rackPoint(rack);};
    aimBike=aim;
    const ui=world2.debug.interaction;
    ui.register({id:'bicycle:ride',position:ride,range:2.6,keyOnly:true,label:'Left click to ride the bicycle',
      enabled:()=>!grab&&!bike.mounted&&bike.canMount({x:player.x,z:player.z},bikeSurface()),activate:()=>{mountBike();}});
    ui.register({id:'bicycle:strap',position:rack,range:2.6,keyOnly:true,label:()=>`Left click to strap the ${itemName(heldKind(state(),me()))} to the rack`,
      enabled:()=>!grab&&!bike.mounted&&!bike.loadKind&&isHeavy(heldKind(state(),me()))&&Math.hypot(player.x-bike.position.x,player.z-bike.position.z)<=BICYCLE.reach,
      activate:()=>{const kind=heldKind(state(),me());if(kind&&bike.strap(kind))strappedId=heldItem(state(),me());}});
    ui.register({id:'bicycle:unstrap',position:rack,range:2.6,keyOnly:true,label:()=>`Left click to take the ${itemName(bike.loadKind??undefined)} off the rack`,
      enabled:()=>!grab&&!bike.mounted&&!!bike.loadKind&&Math.hypot(player.x-bike.position.x,player.z-bike.position.z)<=BICYCLE.reach,
      activate:()=>{bike.unstrap();strappedId=undefined;}});
  }
  const strapQuaternion=new THREE.Quaternion(),strapPosition=new THREE.Vector3();
  /** After the world's frame (which puts a carried part at the hand): a strapped part goes to the rack instead. */
  function placeStrapped(){
    if(!world2||!bikeView||!bike.loadKind)return;
    if(heldItem(world2.objectiveState,world2.localPlayer)!==strappedId){bike.unstrap();strappedId=undefined;return;}
    const group=scene.getObjectByName(`Pickup ${strappedId}`);if(!group)return;
    bikeView.rack(strapPosition,strapQuaternion);group.position.copy(strapPosition);group.quaternion.copy(strapQuaternion);
  }
  // Being taken: the camera is wrenched to its face, it screeches, black, a line of text, and the player wakes by the cabin's bed at the
  // next dawn with everything they carried (no lives, nothing dropped). Sleeping is the same black without the face, and the lost
  // run is the black that stays. `grab` is whichever of the three is playing.
  type Scene={t:number;kind:'caught'|'sleep'|'lost';respawned:boolean;sleep?:Extract<SleepResult,{ok:true}>};
  let grab:Scene|undefined,wokeAt=-Infinity,stride=0,breathHeldNow=false,reloading=false;
  const head=new THREE.Vector3(),lastFoot=new THREE.Vector3(player.x,player.y,player.z);
  const blackout=document.createElement('div');blackout.style.cssText='position:absolute;inset:0;background:#000;z-index:4;pointer-events:none;opacity:0;display:flex;align-items:center;justify-content:center';
  const card=document.createElement('div');card.style.cssText='opacity:0;text-align:center;color:#c9ccc2;font:300 15px/1.6 system-ui,sans-serif;letter-spacing:.34em;text-transform:uppercase';
  const cardTitle=document.createElement('div'),cardLine=document.createElement('div');cardLine.style.cssText='margin-top:12px;font-size:11px;letter-spacing:.42em;color:#868d82';
  card.appendChild(cardTitle);card.appendChild(cardLine);blackout.appendChild(card);container.appendChild(blackout);
  // A short line over the view (why the bed refused you) and the day's name at a dawn the player is awake for: both fade by themselves.
  const noticeStyle='position:absolute;left:50%;transform:translateX(-50%);max-width:84%;text-align:center;pointer-events:none;z-index:20;opacity:0;transition:opacity 500ms ease;color:#dcd8c9;text-shadow:0 1px 3px #000,0 0 14px rgba(0,0,0,.75)';
  const notice=document.createElement('div'),banner=document.createElement('div');notice.setAttribute('role','status');
  notice.style.cssText=noticeStyle+';bottom:24%;font:400 15px/1.35 system-ui,sans-serif;letter-spacing:.05em';
  banner.style.cssText=noticeStyle+';top:36%;font:300 20px/1.6 system-ui,sans-serif;letter-spacing:.4em;text-transform:uppercase;transition-duration:900ms';
  container.appendChild(notice);container.appendChild(banner);
  let noticeUntil=0,bannerUntil=0;
  const say=(text:string,seconds=3.2)=>{notice.textContent=text;notice.style.opacity='1';noticeUntil=performance.now()+seconds*1000;};
  const showDay=(day:number,seconds=4)=>{banner.textContent=`Day ${day}`;banner.style.opacity='1';bannerUntil=performance.now()+seconds*1000;};
  const ramp=(v:number,a:number,b:number)=>Math.max(0,Math.min(1,(v-a)/(b-a)));
  /** The black and the card of a scene: the grab's own timeline, with a sleep fading out over the same first second instead of cutting. */
  const screenOf=(g:Scene)=>{const t=grabTimeline(g.t);return g.kind==='sleep'&&g.t<GRAB.wake?{...t,black:Math.max(t.black,ramp(g.t,0,GRAB.black))}:t;};
  const grabFacing=new THREE.Vector3(),grabFrom=new THREE.Vector3(),grabEnd=new THREE.Vector3();
  function startScene(kind:Scene['kind'],t=0,sleep?:Scene['sleep']){
    grab={t,kind,respawned:kind==='lost',sleep};
    keys.clear();velocity.set(0,0,0);drag=false;touchMove.set(0,0);
  }
  function beginGrab(){
    if(grab)return;
    cardTitle.textContent='It found you.';cardLine.textContent='';
    startScene('caught');
  }
  /** The run is over: the black stays, a line, and the island is laid out again (a page reload with a new seed in the address). */
  function beginLost(){
    if(grab?.kind==='lost')return;
    cardTitle.textContent='The sixth dawn.';cardLine.textContent='The island keeps you.';
    // From a scene already under black the black does not restart; from play it fades in first.
    startScene('lost',grab&&screenOf(grab).black>=1?1.8:0);
  }
  function newIsland(){
    if(reloading)return;reloading=true;
    const params=new URLSearchParams(location.search);params.set('seed',String(1+Math.floor(Math.random()*999998)));
    location.search=params.toString();
  }
  /** What the run says happened: each dawn rolls the day's noise log and (awake) names the day; each dusk sends the Listener out. */
  function onRunEvents(events:RunEvent[],atWake=false){
    for(const e of events){
      if(e.type==='dawn'){dayNoise.dawn();if(!atWake)showDay(e.day);}
      else if(e.type==='dusk'){const l=dayNoise.loudest();encounters.dusk(l?{x:l.x,z:l.z}:null);}
      else beginLost();
    }
  }
  /** The clock to an hour of a day (developer hooks, the menu's time slider): the run is put to that moment without events. */
  function setClock(h:number,day=gameRun.day){
    const d=Math.min(RUN.days,Math.max(1,Math.round(day))),first=((RUN.dawnHour-RUN.startHour)%24+24)%24||24;
    hours=((h%24)+24)%24;
    gameRun.restore({day:d,elapsed:(d<=1?0:first+24*(d-2))+((hours-(d<=1?RUN.startHour:RUN.dawnHour))%24+24)%24,duskSeen:false,status:'running'});
    if(gameRun.phase==='night'){const l=dayNoise.loudest();encounters.dusk(l?{x:l.x,z:l.z}:null);}
    world2?.time(absHours(),true);
  }
  /** Under black: wake by the bed with the clock where the run says, or (the sixth dawn) lose. The creature goes back to its lair and round. */
  function wake(now:number){
    const g=grab!;let door=false;
    world2?.letGo();
    if(g.kind==='caught'){
      const r=gameRun.caught();onRunEvents(r.events,true);
      if(r.outcome==='lost')return;
      hours=r.wakeHour;cardTitle.textContent='It found you.';cardLine.textContent=`Day ${gameRun.day}`;
    }else{
      const r=g.sleep!;onRunEvents(r.events,true);
      if(r.outcome==='lost')return;
      if(r.outcome==='dawn'){hours=r.wakeHour;cardTitle.textContent=`Day ${gameRun.day}`;cardLine.textContent='You slept.';}
      else{hours=r.interruptedAt;cardTitle.textContent='Something is at the door.';cardLine.textContent='';door=true;}
    }
    const at=world2?.wakePoint()??startPoint;
    teleport(at.x,at.z);if(!flying)player.y=characterSupportAt(player.x,player.z,player.y+.5,heightAt,collisions);
    yaw=at.yaw;pitch=-.08;lastFoot.copy(player);stride=0;
    encounters.relocate(player,elapsed);
    // The Listener at the door: it is a very loud knock to it (250 m), so it runs to the door from wherever it was put and searches there.
    const doorPoint=door?world2?.doorPoint():undefined;
    if(doorPoint)encounters.hear({loudness:2.5,source:'door',x:doorPoint.x,z:doorPoint.z});
    wokeAt=now;shadowDirty=true;stamina.reset();breathHold.reset();resetBike();
    world2?.time(absHours(),true);
  }
  /** The bed: sleep till dawn if the night allows it, else a line saying why not. */
  function trySleep(){
    if(!world2||grab||!isActive())return;
    const bed=bedPlan();if(!bed)return;
    const c=encounters.probe(),near=Math.hypot(c.x-bed.x,c.z-bed.z)<=60,restless=['run','trot','prowl','search','strike'].includes(String(c.behaviour));
    const r=gameRun.sleep({doorBarred:world2.cabinDoorBarred(),quiet:!(near||restless),loudHereToday:dayNoise.loudNear(bed.x,bed.z,40)});
    if(!r.ok){say(r.reason==='daytime'?'Too early to sleep':r.reason==='door-open'?'Bar the door first':r.reason==='not-quiet'?'Not now: it is close':'');return;}
    cardTitle.textContent='';cardLine.textContent='';
    startScene('sleep',0,r);
  }
  /** What the creature is told about the player each frame, beyond where they are. */
  const senses=(dt:number,crouch:boolean,hurry:boolean,inWater:boolean,climbing:boolean):CreatureSenses=>({
    // A teleport is not a velocity.
    ...(Math.hypot(player.x-lastFoot.x,player.z-lastFoot.z)>dt*12?{vx:0,vz:0}:{vx:(player.x-lastFoot.x)/Math.max(dt,.001),vz:(player.z-lastFoot.z)/Math.max(dt,.001)}),
    sprinting:hurry&&!crouch,crouching:crouch,flashlightOn:flashlight.active,inWater,onLadder:climbing,
    indoors:world2?.indoors(player)??false,untouchable:flying||!!grab,blackout:!!grab&&(grab.kind==='lost'||screenOf(grab).black>=1),
    day:gameRun.day,breathHeld:breathHeldNow,
  });
  let cycleSpeed=1,flying=false;
  let disposed=false,raf=0,last=performance.now(),frameAverage=16.67;
  let pointerWasLocked=false,pointerLockPending=false;
  let drag=false,mouseX=0,mouseY=0;
  let profileUntil=0,benchmarking=false;
  let diagnosticRatio:number|undefined;
  let shadowDirty=true,sunDirty=true,lastSunDraw=-Infinity;
  let warmupDraws=0,warmupFence:WebGLSync|null=null,indoorLight=0;
  const gl=renderer.getContext() as WebGL2RenderingContext;
  const probe=import.meta.env.DEV?createPerfProbe(renderer):undefined;
  // FPS, lows, CPU and GPU time in the top-right corner; P or the Graphics setting. Costs nothing while hidden.
  const perfOverlay=createPerfOverlay(container,renderer,{frameCap:()=>settings.frameCap,busy:()=>!!probe?.recording});
  const profileRows:{frame:number,update:number,forest:number,terrain:number,encounter:number,submit:number,calls:number,triangles:number,sunShadow:boolean,creature:boolean}[]=[];
  const coarse=matchMedia('(pointer: coarse)').matches;
  const touches=new Map<number,{x:number,y:number,startX:number,startY:number,side:'move'|'look'}>();
  const touchMove=new THREE.Vector2();
  // On touch there is no sprint key: a push on the stick of at least this many pixels asks to sprint (stamina permitting), a lighter one walks.
  // Once sprinting, the push may ease back to 80% of it before it counts as a walk again, so a thumb resting on the line does not flicker.
  const TOUCH_SPRINT_PUSH=44;let touchPushed=false;
  const temp=new THREE.Vector3();
  // Dev measurement only (window.__SILENCE__.perf): run the simulation as if the player were playing, with scripted keys and, optionally, the creature.
  let benchActive=false,benchCreature=false;const benchHeld=new Set<Action>(),perfHidden:THREE.Object3D[]=[];
  const isActive=()=>!loading && (benchActive||!document.hidden) && !admin.open;

  const held=(action:Action)=>(import.meta.env.DEV&&benchHeld.has(action))||keys.has(settings.bindings[action])||(settings.bindings[action]==='ShiftLeft'&&keys.has('ShiftRight'))||(settings.bindings[action]==='ControlLeft'&&keys.has('ControlRight'));
  const start=(touch=false)=>{
    if(admin.open)return;
    void audio.start();
    void audio.resume();
    renderer.domElement.focus({preventScroll:true});
    if(!touch && !coarse && !pointerLockPending && document.pointerLockElement!==renderer.domElement){
      pointerLockPending=true;
      try {
        const result=renderer.domElement.requestPointerLock();
        if(result instanceof Promise)void result.catch(()=>{}).finally(()=>{pointerLockPending=false;});
      } catch { pointerLockPending=false; /* Drag controls remain available inside embedded browsers. */ }
    }
  };
  const mouseDown=(e:MouseEvent)=>{if(e.button!==0||admin.open||inventoryOpen||performance.now()-lastTouch<700)return;if(isActive())mouseTap.begin(performance.now());else mouseTap.cancel();drag=true;mouseX=e.clientX;mouseY=e.clientY;start();};
  const mouseUp=(e:MouseEvent)=>{if(e.button===0&&drag&&isActive()&&mouseTap.end(performance.now())&&interact())shadowDirty=true;drag=false;};
  const mouseMove=(e:MouseEvent)=>{
    if(admin.open||grab)return;
    if(drag)mouseTap.move(document.pointerLockElement===renderer.domElement?Math.hypot(e.movementX,e.movementY):Math.hypot(e.clientX-mouseX,e.clientY-mouseY));
    if(document.pointerLockElement===renderer.domElement){yaw-=e.movementX*.00165*settings.sensitivity;pitch-=e.movementY*.00165*settings.sensitivity;}
    else if(drag){yaw-=(e.clientX-mouseX)*.003*settings.sensitivity;pitch-=(e.clientY-mouseY)*.003*settings.sensitivity;}
    mouseX=e.clientX;mouseY=e.clientY;pitch=THREE.MathUtils.clamp(pitch,-1.28,1.32);
  };
  const keyDown=(e:KeyboardEvent)=>{
    if(e.code==='Escape'&&e.repeat)return;
    if((e.code==='F2'||e.code==='Backquote')&&!e.repeat){e.preventDefault();admin.show('developer');return;}
    if(admin.open){if(e.code==='Escape'){e.preventDefault();admin.close();}return;}
    if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight','ControlLeft','ControlRight','KeyF','Space'].includes(e.code))e.preventDefault();
    if(e.code==='Escape'&&!e.repeat&&(inventoryOpen||mapOpen)){e.preventDefault();inventory?.close();islandMap?.close();return;}
    if(e.code==='Escape'&&!e.repeat){e.preventDefault();admin.show();return;}
    if(Object.values(settings.bindings).includes(e.code))e.preventDefault();
    keys.add(e.code);
    if(e.code===settings.bindings.interact&&!e.repeat){start();if(bike.mounted){if(isActive()&&!grab)dismountBike();}else if(isActive()&&interact(true))shadowDirty=true;}
    if(e.code===settings.bindings.bell&&!e.repeat&&isActive()&&!grab&&bike.mounted)ringBell();
    if(e.code===settings.bindings.rise&&!e.repeat&&isActive()&&!grab&&bike.allows('jump')){if(world2?.climbing)world2.letGo();else if(!flying&&!airborne)jumpRequested=true;}
    if(e.code===settings.bindings.drop&&!e.repeat&&isActive()&&!grab&&world2?.drop())shadowDirty=true;
    if(e.code===settings.bindings.map&&!e.repeat&&isActive()&&!grab){e.preventDefault();islandMap?.toggle();}
    if(e.code===OBJECTIVE_KEY&&!e.repeat&&isActive()&&!grab&&!Object.values(settings.bindings).includes(e.code))objectiveHud?.toggle();
    if(e.code===INVENTORY_KEY&&!e.repeat&&isActive()&&!grab&&!Object.values(settings.bindings).includes(e.code)){e.preventDefault();inventory?.toggle();}
    if(e.code===PERF_OVERLAY_KEY&&!e.repeat&&!Object.values(settings.bindings).includes(e.code)){settings.perfOverlay=!settings.perfOverlay;saveSettings();}
    if(e.code===settings.bindings.fullscreen && !loading && !e.repeat){
      if(!document.fullscreenElement)void container.requestFullscreen?.().catch(()=>{});
      else void document.exitFullscreen();
    }
    if(!e.repeat && [settings.bindings.forward,settings.bindings.back,settings.bindings.left,settings.bindings.right].includes(e.code))start();
  };
  const keyUp=(e:KeyboardEvent)=>keys.delete(e.code);
  const clearInput=()=>{jumpRequested=false;keys.clear();velocity.set(0,0,0);drag=false;touchMove.set(0,0);touches.clear();mouseTap.cancel();touchTap.cancel();touchTapId=undefined;};
  const blur=()=>{clearInput();void audio.suspend();};
  const focus=()=>{if(!admin.open&&!document.hidden)void audio.resume();};
  const visibilityChange=()=>{if(document.hidden)blur();else{clearInput();focus();}};
  const lockError=()=>{pointerLockPending=false;};
  const lockChange=()=>{
    pointerLockPending=false;
    if(document.pointerLockElement===renderer.domElement){
      if(admin.open){document.exitPointerLock();return;}
      pointerWasLocked=true;
      void audio.resume();
    }else if(pointerWasLocked){
      pointerWasLocked=false;
      // Let go of on purpose, for the backpack: not a pause.
      if(inventoryOpen||mapOpen)return;
      // Chrome can consume Escape while releasing the mouse, without a keydown.
      admin.show();
    }
  };
  const touchStart=(e:TouchEvent)=>{
    if(admin.open)return;
    const canInteract=isActive();e.preventDefault();lastTouch=performance.now();start(true);
    if(canInteract&&touches.size===0&&e.changedTouches.length===1){touchTap.begin(performance.now());touchTapId=e.changedTouches[0].identifier;}else{touchTap.cancel();touchTapId=undefined;}
    // Portrait is preferred where the browser supports orientation locking.
    const orientation=screen.orientation as ScreenOrientation & {lock?:(mode:string)=>Promise<void>};
    void orientation?.lock?.('portrait').catch(()=>{});
    const rect=renderer.domElement.getBoundingClientRect();
    for(const t of Array.from(e.changedTouches)){
      const side=t.clientX-rect.left<rect.width*.42&&!Array.from(touches.values()).some(t=>t.side==='move')?'move':'look';
      if(side==='move')touchPushed=false;
      touches.set(t.identifier,{x:t.clientX,y:t.clientY,startX:t.clientX,startY:t.clientY,side});
    }
  };
  const touchUpdate=(e:TouchEvent)=>{
    e.preventDefault();
    for(const t of Array.from(e.changedTouches)){
      const old=touches.get(t.identifier);if(!old)continue;
      if(t.identifier===touchTapId)touchTap.move(Math.hypot(t.clientX-old.x,t.clientY-old.y));
      if(old.side==='look'){const sensitivity=2.2*settings.sensitivity/Math.min(container.clientWidth,container.clientHeight);yaw-=(t.clientX-old.x)*sensitivity;pitch=THREE.MathUtils.clamp(pitch-(t.clientY-old.y)*sensitivity,-1.28,1.32);}
      else{touchMove.set(t.clientX-old.startX,t.clientY-old.startY);const push=touchMove.length();touchPushed=push>=TOUCH_SPRINT_PUSH*(touchPushed?.8:1);if(push<7)touchMove.set(0,0);else touchMove.normalize();}
      old.x=t.clientX;old.y=t.clientY;
    }
  };
  const touchEnd=(e:TouchEvent)=>{lastTouch=performance.now();for(const t of Array.from(e.changedTouches)){if(t.identifier===touchTapId){if(e.type==='touchend'&&isActive()&&touchTap.end(performance.now())&&interact())shadowDirty=true;touchTap.cancel();touchTapId=undefined;}if(touches.get(t.identifier)?.side==='move')touchMove.set(0,0);touches.delete(t.identifier);}};
  const rendererSize=new THREE.Vector2();
  // The render resolution is the player's choice and nothing else changes it (game/core/quality.ts): a fixed number of rows with the
  // window's shape, or Native, which follows the window and the screen it is on. The post chain sizes its targets from it.
  const resize=()=>{
    const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight);
    pixelRatio=diagnosticRatio??renderRatio(settings.resolution,w,h,window.devicePixelRatio);
    scene.userData.graphicsAnisotropy=settings.anisotropy;scene.userData.graphicsWaterDetail=settings.waterDetail;scene.userData.graphicsAA=settings.aa;scene.userData.graphicsFog=settings.fog;scene.userData.graphicsAO=settings.ambientOcclusion;
    renderer.getSize(rendererSize);if(rendererSize.x!==w||rendererSize.y!==h||renderer.getPixelRatio()!==pixelRatio)renderer.setDrawingBufferSize(w,h,pixelRatio);camera.aspect=w/h;camera.updateProjectionMatrix();
    atmosphere.resize(w,h,pixelRatio);terrain.water.setQuality(settings.reflections,settings.waterDetail);
    shadowDirty=sunShadow.setQuality(settings.shadows)||shadowDirty;
  };
  // Moving the window to a screen with another pixel density changes devicePixelRatio without always firing a resize.
  let densityQuery:MediaQueryList|undefined;
  const densityChanged=()=>{densityQuery?.removeEventListener('change',densityChanged);densityQuery=window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);densityQuery?.addEventListener('change',densityChanged);resize();};
  renderer.domElement.addEventListener('mousedown',mouseDown);
  window.addEventListener('mouseup',mouseUp);window.addEventListener('mousemove',mouseMove);
  window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);
  window.addEventListener('blur',blur);window.addEventListener('focus',focus);window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);window.addEventListener('orientationchange',clearInput);
  document.addEventListener('pointerlockchange',lockChange);document.addEventListener('pointerlockerror',lockError);document.addEventListener('visibilitychange',visibilityChange);
  renderer.domElement.addEventListener('touchstart',touchStart,{passive:false});
  renderer.domElement.addEventListener('touchmove',touchUpdate,{passive:false});
  renderer.domElement.addEventListener('touchend',touchEnd);renderer.domElement.addEventListener('touchcancel',touchEnd);
  const teleport=(x:number,z:number)=>{player.set(x,heightAt(x,z)+(flying?5:0),z);velocity.set(0,0,0);jumpVelocity=0;airborne=false;jumpRequested=false;};
  const admin=createAdmin(container,{
    settings,volumeChanged:()=>audio.setVolumes(settings),listening:(on)=>audio.listen(on),settingsChanged:()=>{try{localStorage.setItem('silence-settings',JSON.stringify(settings));}catch{}diagnosticRatio=undefined;resize();filterTextures();},
    getState:()=>({hours,day:gameRun.day,cycleSpeed,flying,position:player.toArray(),fps:Math.round(1000/frameAverage),solids:collisions.stats().solids}),
    setHours:(h)=>{setClock(h);},setSpeed:(speed)=>{cycleSpeed=speed;},
    setFlying:(value)=>{flying=value;jumpVelocity=0;airborne=false;jumpRequested=false;velocity.set(0,0,0);if(!flying)player.y=characterSupportAt(player.x,player.z,player.y,heightAt,collisions);},
    spawn:(mode)=>{camera.getWorldDirection(forward);encounters.spawn(player,forward,mode);},dismiss:()=>{encounters.dismiss(elapsed);shadowDirty=true;},teleport,
    visibility:(open)=>{
      clearInput();
      if(open){
        // Consume our own unlock before its asynchronous event can reopen the menu.
        pointerWasLocked=false;
        if(document.pointerLockElement===renderer.domElement)document.exitPointerLock();
        void audio.suspend();
      }else start(coarse);
    },
  });
  densityChanged();
  let frame=0;
  let filtered=new WeakMap<THREE.Texture,number>(),filteredAt=-1;const anisotropy=renderer.capabilities.getMaxAnisotropy();
  // Anisotropic filtering is paid on every texture read. The ground and the road, seen at a grazing angle to the horizon,
  // need all of it and set their own (game/render/world/terrain.ts). Everything else was given the same 16x and it was the largest
  // per-pixel cost found (1.3 ms of a 12 ms frame on the road): leaf, needle and grass cards face the camera and gain
  // nothing from it, so they get 2x. Bark, rocks, logs, props and the creature get 8x (16x on a discrete card): trunks and boulders are seen edge-on at a
  // few metres, where 4x smeared their bark and lichen. alphaHash is not a card: the forest's instanced bark, rocks and logs carry
  // it for their distance dissolve (forest.ts fadeInstances), and counting it put all of them on the cards' 2x.
  const filterFor=(material:THREE.Material)=>{
    const wanted=Math.min(anisotropy,settings.anisotropy);
    if(!perfOn('filterPolicy'))return wanted;
    const card=material.alphaTest>0||material.alphaToCoverage||material.transparent;
    // Solid materials: 8x where it was measured to cost (Apple, shared-memory GPUs), the full setting on a discrete card (device.ts).
    return Math.min(wanted,card?2:device.policy.solidAnisotropy);
  };
  function filterTextures(){
    // A texture shared by two kinds of material keeps the higher of the two; a change of the setting starts over.
    if(filteredAt!==settings.anisotropy){filtered=new WeakMap();filteredAt=settings.anisotropy;}
    scene.traverse(o=>{if(!(o instanceof THREE.Mesh))return;for(const material of Array.isArray(o.material)?o.material:[o.material]){const af=filterFor(material);for(const value of Object.values(material))if(value instanceof THREE.Texture&&!value.isRenderTargetTexture&&value.image?.width>0&&value.image?.complete!==false&&(filtered.get(value)??-1)<af){filtered.set(value,af);value.anisotropy=af;value.needsUpdate=true;}}});}
  // Props stream in with textures of up to 4096 px and their own shader programs. pois.ts hands each model to this queue as it arrives; one
  // texture or one light state's programs is built per step, with a pause that grows with the cost of the last step (game/render/gpu/gpu-warmup.ts).
  // The light states the warm-ups cover: whatever changes the scene's light count, torch on or off and the street lamps lit or not.
  // With a steady torch (flashlight.ts) only the lamps do: half the programs to compile, and switching the torch on swaps none.
  const steadyTorch=perfOn('steadyTorchLight'),torchStates=steadyTorch?1:2;
  const torchOnIn=(state:number)=>steadyTorch||state%2===1,lampsLitIn=(state:number)=>state>=torchStates;
  const lampStates=()=>torchStates*(world2?.debug.streetLights.count?2:1),slicer=createTextureSlicer(renderer),shadowPrograms=createShadowProgramWarmer(renderer),lightSync=new THREE.Object3D();
  // Shader programs where the GPU compiles them off the page's thread (KHR_parallel_shader_compile: ANGLE offers it on Direct3D 11 and
  // on Metal). three.js links a program when a draw first needs it and that draw then waits for the compiler. On Direct3D 11 that is
  // 0.85 s a program on average and up to 13 s for the largest, one after another, with the page and Chrome's whole GPU process stalled
  // meanwhile (Windows, RTX 5070 Ti: 434 programs, 141 s of a 264 s first load waiting in getProgramInfoLog; Metal compiles fast enough
  // that it never showed). Linked ahead and left to finish on their own they compile side by side, and nothing waits on them.
  const parallelCompile=renderer.extensions.has('KHR_parallel_shader_compile');
  type Program={isReady():boolean};
  const programOf=(material:THREE.Material)=>(renderer.properties.get(material) as {currentProgram?:Program}).currentProgram;
  const programsReady=(list:Iterable<Program|undefined>)=>{for(const p of list)if(p&&!p.isReady())return false;return true;};
  const allProgramsReady=()=>programsReady((renderer.info.programs??[]) as unknown as Program[]);
  /** Links every program `object` needs in light state `state` (torchOnIn, lampsLitIn), waiting for none. */
  function linkPrograms(object:THREE.Object3D,state:number){
    const light=flashlight.light,was=light.visible;light.visible=torchOnIn(state);
    const unlit=lampsLitIn(state)?world2?.debug.streetLights.warm():undefined;
    try{const materials=renderer.compile(object,camera,scene);if(perfOn('shadowWarmup'))shadowPrograms.compile(object,camera,scene);return [...materials].map(programOf);}finally{
      unlit?.();light.visible=was;
      // compile() leaves the scene's light setup as it was for this light state, and three.js (r180) draws the next frame's shadow
      // maps before that frame sets its lights up again: without this the shadow pass would build depth programs for street lamps
      // and a torch that are off, the very stall this warm-up is for. An empty object only gathers the lights.
      if(perfOn('shadowWarmup'))renderer.compile(lightSync,camera,scene);
    }
  }
  const linking=new WeakMap<THREE.Object3D,{state:number;programs:(Program|undefined)[]}>();
  let programScan=-Infinity,linkedFor=-2;
  const gpuWarmup=createGpuWarmup({
    states:lampStates(),
    upload:(t,urgent)=>{
      if(!(t.image?.width>0)||t.image?.complete===false)return 'wait';
      // A streamed prop's texture: the filtering pass above settles its final quality once the model is in the scene.
      const af=Math.min(anisotropy,settings.anisotropy,perfOn('filterPolicy')?device.policy.solidAnisotropy:16);
      if(!filtered.has(t)){filtered.set(t,af);t.anisotropy=af;t.needsUpdate=true;}
      if(!perfOn('slicedUpload')){renderer.initTexture(t);return 'done';}
      return slicer.upload(t,urgent);
    },
    compile:(object,state)=>{
      // In play a streamed prop waits, hidden, until its programs have compiled, so its first draw does not stall on the compiler.
      // Behind the veil nothing waits here: every prop links at once and they compile side by side (the loading frames hold the draw).
      const waits=!loading&&parallelCompile&&perfOn('asyncPrograms'),pending=linking.get(object);
      if(waits&&pending?.state===state){if(!programsReady(pending.programs))return 'wait';linking.delete(object);return 'done';}
      const programs=linkPrograms(object,state);
      if(waits&&!programsReady(programs)){linking.set(object,{state,programs});return 'wait';}
      return 'done';
    },
  });
  scene.userData.gpuWarmup=gpuWarmup;
  const diagnostic={ready:true,position:player,elapsed:0,darkness:0,fps:60,drawCalls:0,triangles:0,active:false,
    flashlightStatus(){return flashlight.inspect();},
    /** Dev: play one creature sound 4 m in front of the player. Names: screech, grab, hiss, stalk (clicks), knock, branch, breath, call, reveal. */
    hear(name:string){
      void audio.start();void audio.resume();
      camera.getWorldDirection(forward);const at=player.clone().addScaledVector(forward,4);at.y+=1.5;
      if(name==='screech')audio.screech(at,.6);else if(name==='grab')audio.screech(at,1);else if(name==='hiss')audio.hiss(at);
      else if(name==='stalk')audio.stalkCue(at);else if(name==='reveal')audio.creatureReveal(at);
      else if(name==='knock')audio.knock(at);
      else if(name==='branch'||name==='breath'||name==='call')audio.cue(name,at);
      else return 'unknown: screech, grab, hiss, stalk, knock, branch, breath, call, reveal';
      return 'playing '+name;
    },
    creatureModelStatus(){return encounters.modelStatus();},
    creatureVisibility(){return encounters.visibilityStatus();},
    creatureNavigation(){return encounters.navigationStatus();},
    creaturePreview(x:number,z:number,yaw=0){encounters.preview(x,z,yaw);},
    /** The creature's mind: behaviour, scores, boldness, what it sees and remembers. */
    creatureBrain(){return encounters.visibilityStatus().brain;},
    /** Run the creature's AI for a number of seconds without rendering (a hidden tab pauses the game). */
    creatureThink(seconds=1,step=1/30,crouch=false,sprint=false){
      camera.getWorldDirection(forward);
      for(let t=0;t<seconds;t+=step){elapsed+=step;encounters.update(step,elapsed,player,forward,diagnostic.darkness,hours,senses(step,crouch,sprint,false,false));lastFoot.copy(player);if(encounters.takeStrike())beginGrab();}
      collisions.replace('creature',encounters.solidColliders());
      return {brain:encounters.visibilityStatus().brain,presence:encounters.visibilityStatus().presence,position:creature.position.toArray(),grab:grab?{...grab}:undefined};
    },
    /** The scripted opening: phase ('quiet', 'glimpse', 'interlude', 'tree', 'breathing', 'free'), clock, the encounter running. */
    opening(){return encounters.openingStatus();},
    /** Jump the opening to a phase now, e.g. 'glimpse' or 'tree' to see an encounter without waiting for it. */
    openingJump(phase:'quiet'|'glimpse'|'interlude'|'tree'|'breathing'|'free'){encounters.jumpOpening(phase);return encounters.openingStatus();},
    /** The pause menu's creature spawns: 'natural', 'hunt', 'tree', 'idle', 'walk' or 'run'. */
    creatureSpawn(mode:CreatureMode='natural'){camera.getWorldDirection(forward);encounters.spawn(player,forward,mode);},
    creatureHunt(){this.creatureSpawn('hunt');},
    /** The run: day, clock, status, the day's noise (its loudest place and noisiest ones), the breath, and the scene playing (caught, sleep or lost). */
    run(){return{...gameRun.state(),hours,absHours:absHours(),noise:{loudest:dayNoise.loudest(),places:dayNoise.places(6)},breath:breathHold.state,scene:grab?{...grab,sleep:undefined}:undefined,doorBarred:world2?.cabinDoorBarred()??false};},
    /** Put the run on day `n` (1 to 5) at clock hour `hour`, no events (a night: `setDay(2, 19.5)`). It changes where the run is, not the noise log. */
    setDay(n:number,hour=RUN.startHour){setClock(hour,n);return this.run();},
    /** Press the bed as the player would: sleeps (or says why not). */
    sleepNow(){trySleep();return this.run();},
    /** Show the line that appears over the view, and the day's name. */
    sayDay(){showDay(gameRun.day);},
    /** Raise the torch without fetching it from the bench. */
    equipTorch(){flashlight.devEquip();},
    /** The bicycle: its state, the view's parts, and where it stands. Dev only. */
    bike(){return{mounted:bike.mounted,speed:bike.speed,heading:bike.heading,position:{...bike.position},load:bike.loadKind,lean:bikeView?.lean,steer:bikeView?.steer,wheel:bikeView?.wheelAngle,crank:bikeView?.crankAngle,roll:bikeView?.roll,loaded:bikeView?.loaded,surface:bikeSurface()};},
    /** Stand at the bicycle and get on it (facing the way you look). Returns whether it worked. */
    rideNow(){if(!bikeView||bike.mounted)return bike.mounted;teleport(bike.position.x,bike.position.z);player.y=characterSupportAt(player.x,player.z,player.y+.5,movementGround,collisions);return mountBike();},
    dismountNow(){dismountBike();return !bike.mounted;},
    ringBell(){ringBell();},
    /** Where its face is, for aiming the torch at it. */
    creatureHead(){return encounters.headPosition(new THREE.Vector3()).toArray();},
    /** Be taken now, as if it had reached you. */
    die(){beginGrab();},
    creatureStep(dt:number,time:number,speed:number){return encounters.previewStep(dt,time,speed);},
    setRatio(r:number){diagnosticRatio=r;pixelRatio=r;renderer.setPixelRatio(r);resize();},
    graphics(){const gl=renderer.getContext();return{device:describeDevice(device),policy:device.policy,timer:!!gl.getExtension('EXT_disjoint_timer_query_webgl2'),version:gl.getParameter(gl.VERSION),size:renderer.getDrawingBufferSize(new THREE.Vector2()).toArray(),memory:renderer.info.memory,anisotropy:Math.min(anisotropy,settings.anisotropy),settings:{...settings,bindings:undefined},shadowSize:sunShadow.size,antialias:settings.aa,pacing:'requestAnimationFrame'};},
    /** Open, close or (no argument) toggle the paper map; returns whether it is open. */
    map(open?:boolean){if(open===undefined)islandMap?.toggle();else if(open)islandMap?.open();else islandMap?.close();return islandMap?.isOpen;},
    inventory(){const rows:{name:string,triangles:number,instances:number}[]=[];scene.traverse(o=>{if(o instanceof THREE.Mesh){const count=o instanceof THREE.InstancedMesh?o.count:1;rows.push({name:o.name||o.parent?.name||o.type,triangles:((o.geometry.index?.count??o.geometry.attributes.position.count)/3)*count,instances:count});}});return rows.sort((a,b)=>b.triangles-a.triangles).slice(0,25);},
    async record(seconds=6){profileRows.length=0;profileUntil=performance.now()+seconds*1000;await new Promise(r=>setTimeout(r,seconds*1000+50));return profileRows.slice();},
    async benchmark(excluded:string[]=[],frames=10){
      benchmarking=true;
      const hidden:THREE.Object3D[]=[];
      scene.traverse(o=>{if(o.visible&&((excluded.includes('undergrowth')&&o.name==='Photographic forest understory')||(excluded.includes('canopy')&&o.name.startsWith('Canopy')))){hidden.push(o);o.visible=false;}});
      scene.userData.profileForceReflection=true;scene.userData.profileSkipReflection=excluded.includes('reflection');scene.userData.profileSkipFog=excluded.includes('fog');
      const results:Record<string,number>[]=[];
      try{for(let i=0;i<frames+3;i++){renderer.info.reset();const row=await atmosphere.measure(elapsed,diagnostic.darkness);if(i>=3)results.push({...row,triangles:renderer.info.render.triangles,calls:renderer.info.render.calls});}}
      finally{hidden.forEach(o=>o.visible=true);scene.userData.profileForceReflection=false;scene.userData.profileSkipReflection=false;scene.userData.profileSkipFog=false;benchmarking=false;}
      return results;
    },
    shadowProbe(x:number,y:number,z:number){const uv=new THREE.Vector3(x,y,z).applyMatrix4(sun.shadow.matrix);return {size:sunShadow.size,texel:sunShadow.texel,uv:uv.toArray(),matrix:sun.shadow.matrix.toArray()};},
    inspect(){return {position:player.toArray(),elapsed,hours,flying,collision:collisions.stats(),biome:biomeAt(player.x,player.z),darkness:this.darkness,fps:this.fps,drawCalls:this.drawCalls,triangles:this.triangles,active:isActive(),terrain:terrain.streamingStats,trees:forest.colliders.length,encounterVisible:scene.getObjectByName('something-between-the-trees')?.visible};},
    groundingAudit(){
      let maxGap=-Infinity,minGap=Infinity,vertices=0,trunks=0;
      const matrix=new THREE.Matrix4(),v=new THREE.Vector3(),scale=new THREE.Vector3();
      scene.traverse(object=>{
        if(!(object instanceof THREE.InstancedMesh)||!object.geometry.getAttribute('rootHeightsA'))return;
        const p=object.geometry.attributes.position,names=['rootHeightsA','rootHeightsB','rootHeightsC','rootHeightsD'];
        for(let i=0;i<object.count;i++){
          object.getMatrixAt(i,matrix);scale.setFromMatrixScale(matrix);trunks++;
          for(let j=0;j<16;j++){
            const a=object.geometry.getAttribute(names[Math.floor(j/4)]);const shift=a.array[i*4+j%4];
            v.set(p.getX(j),p.getY(j)+shift,p.getZ(j)).applyMatrix4(matrix);
            const gap=v.y-heightAt(v.x,v.z);maxGap=Math.max(maxGap,gap);minGap=Math.min(minGap,gap);vertices++;
          }
        }
      });return{maxGap,minGap,vertices,trunks};
    },
    sceneStats(){const rocks:{x:number,y:number,z:number,d:number}[]=[];const m=new THREE.Matrix4(),v=new THREE.Vector3();scene.traverse(o=>{if(o instanceof THREE.InstancedMesh&&!Array.isArray(o.material)&&o.material.name==='Scanned mossy stone'){for(let i=0;i<o.count;i++){o.getMatrixAt(i,m);v.setFromMatrixPosition(m);rocks.push({x:v.x,y:v.y,z:v.z,d:v.distanceTo(player)});}}});return {rocks:rocks.sort((a,b)=>a.d-b.d).slice(0,5),plants:scene.getObjectByName('Photographic forest understory')?.userData,treeSample:forest.colliders.filter(t=>Math.hypot(t.x-player.x,t.z-player.z)<12).slice(0,6)};},
    setTime(t:number){elapsed=Math.max(0,t);setClock(RUN.startHour+t/60,1);},
    setHours(h:number){setClock(h);},
    setFlying(value:boolean){flying=value;},
    collisionProbe(x:number,z:number){return collisions.nearby(x,z,5);},
    move(dx:number,dz:number){const p=moveCharacter(player,dx,dz,1.69,heightAt,collisions);player.set(p.x,p.y,p.z);return player.toArray();},
    teleport,
    look(y:number,p:number){yaw=y;pitch=p;},
    /** Every door of the rebuilt world: id ("<placement>#<n>"), placement, open (0 shut .. 1 wide), target, closed, hinge position and yaw. */
    doors(){return world2?world2.debug.doors.list():[];},
    /** Put a door at `open` (0..1 or true/false) at once, or pass animate=true to swing it; `id` may be just the placement id. */
    setDoor(id:string,open:number|boolean,animate=false){return world2?world2.debug.doors.set(id,open,animate):false;},
    /** Run one whole engine frame now (sky, forest and colliders, drawing): a hidden tab may not run frames at all. */
    snap(){cancelAnimationFrame(raf);last=performance.now()-16;animate(performance.now());return camera.position.toArray();},
    /** Dev measurement (game/dev/perf-probe.ts, game/core/perf-flags.ts). drive() runs the real simulation without a focused tab; hold() presses scripted keys; start()/stop() record one row per frame. */
    perf:{
      gpuTimer:!!probe?.gpuTimer,
      /** Changes whenever the game is rebuilt (a hot update remounts it without reloading the page); a measurement is only valid if it did not change. */
      instance:Math.round(performance.now()*1000),
      drive(on:boolean,creature=false){benchActive=on;benchCreature=creature;if(!on)benchHeld.clear();},
      hold(...actions:Action[]){benchHeld.clear();for(const a of actions)benchHeld.add(a);},
      start(){probe?.start();},stop(){return probe?.stop()??[];},
      switches:perfSwitches,on:perfOn,
      setSpeed(speed:number){cycleSpeed=speed;},
      /** True once nothing is still streaming in: loading done, no asset in flight, terrain chunks cut, props loaded. */
      settled(){return !loading&&pendingAssets===0&&terrain.streamingStats.pendingChunks===0&&(world2?world2.debug.pois.ready():true)&&!!scene.getObjectByName('Photographic forest understory')?.userData.ready&&gpuWarmup.pending===0;},
      /** Ablation for measurement: hide every named object matching the regex (a vegetation rebuild may bring sectors back), and put them back. */
      hide(pattern:string){const re=new RegExp(pattern,'i'),found:THREE.Object3D[]=[];scene.traverse(o=>{if(o.visible&&o.name&&re.test(o.name)&&!(o as THREE.Light).isLight)found.push(o);});for(const o of found){o.visible=false;perfHidden.push(o);}return found.length;},
      unhide(){for(const o of perfHidden)o.visible=true;perfHidden.length=0;},
      /** Ablation: switch the sun's shadow pass off or on, skip the fog passes or the water reflection. */
      ablate(o:{sunShadow?:boolean;fog?:boolean;reflection?:boolean}){if(o.sunShadow!==undefined){sun.castShadow=o.sunShadow;shadowDirty=true;}scene.userData.profileSkipFog=o.fog===false;scene.userData.profileSkipReflection=o.reflection===false;},
      /** Time the collision query the sun-ray canopy map is built from: `runs` calls of nearby(player, radius). Dev measurement only. */
      nearbyCost(radius=54,runs=40){const times:number[]=[];let n=0;for(let i=0;i<runs;i++){const t=performance.now();n=collisions.nearby(player.x+i*.37,player.z,radius).length;times.push(performance.now()-t);}times.sort((a,b)=>a-b);return{count:n,medianMs:times[Math.floor(runs/2)],maxMs:times[runs-1]};},
      /** The live renderer, scene and sun, for one-off measurements from the console. Dev only. */
      handles(){return{renderer,scene,sun,camera,THREE,farShadow,atmosphere};},
      /** Switch the torch on or off (it eases up or down over half a second of game time). Dev measurement only. */
      torch(on:boolean){const s=flashlight.inspect();if(s.owned&&s.on!==on)flashlight.toggle();},
      /** GPU texture memory estimate by source file, with duplicate uploads called out. */
      textures(){return textureReport(scene);},
      /** What the GPU warm-up queue has done so far and what is left. */
      warmup(){return{pending:gpuWarmup.pending,log:gpuWarmup.log()};},
      /** What the camera would submit, grouped by mesh name (frustum and layer tests only). */
      drawList(){return drawList(scene,camera);},
      /** The scene itself, for one-off inspection from the console (instance positions, materials). */
      scene(){return scene;},
      /** The player's camera, for picking from the console (what is under this pixel). */
      camera(){return camera;},
      /** The forest's crown band (metres, near crown to light crown), live: set x and y to measure another band. */
      crownBand(){return forest.crownBand;},
      /** The eye's state: the metered scene luminance (log2) it has adapted to and the exposure the final image applies (dev). */
      exposure(){const t=atmosphere.adaptedTarget(),h=new Uint16Array(4);renderer.readRenderTargetPixels(t,0,0,1,1,h);const b=Array.from(h,THREE.DataUtils.fromHalfFloat);const g=scene.userData.grade as Grade|undefined;
        const metered=g?g.key/Math.max(2**b[0],1e-6):0,overall=g?g.key/Math.max(2**b[1],1e-6):0;return{log2:+b[0].toFixed(3),plain:+b[1].toFixed(3),metered:+metered.toFixed(3),exposure:g?+(perfOn('eyeAnchor')?eyeExposure(metered,g,overall):Math.min(g.maxExposure,Math.max(g.minExposure,metered))).toFixed(3):null,anchor:g?.anchor};},
      /** What the sun's shadow pass would draw right now: casters inside the shadow camera's frustum. */
      shadowList(){sun.shadow.updateMatrices(sun);return drawList(scene,camera,sun.shadow.camera);},
      /** Of the instances the sun's shadow pass submits, how many reach the shadow frustum. */
      shadowCulling(){sun.shadow.updateMatrices(sun);return shadowInstanceCulling(scene,camera,sun.shadow.camera);},
      /** The start-up's synchronous building, stage by stage: [stage, ms since createGame began when it ended]. */
      startup(){return startupMarks.slice();},
      /** The terrain height cache on this thread: blocks held, and how many were built from scratch and how long that took. */
      heights(){return terrainHeightStats();},
      /** Names of the compiled shader programs, to see which ones appeared between two moments. */
      programNames(){return (renderer.info.programs??[]).map(p=>`${p.name}#${(p as unknown as {id:number}).id}`);},
      renderInfo(){const i=renderer.info;return{programs:i.programs?.length??0,textures:i.memory.textures,geometries:i.memory.geometries,lights:(()=>{let n=0;scene.traverse(o=>{if((o as THREE.Light).isLight&&o.visible)n++;});return n;})(),buffer:renderer.getDrawingBufferSize(new THREE.Vector2()).toArray()};},
      /** GPU milliseconds per stage of one frame (opaque, water, terrainSun, fog, resolve, antialias); shadows=true redraws the sun and torch maps inside 'opaque'. */
      async gpuStages(shadows=false){benchmarking=true;try{renderer.info.reset();renderer.shadowMap.needsUpdate=shadows;sun.shadow.needsUpdate=shadows;return await atmosphere.measure(elapsed,diagnostic.darkness);}finally{benchmarking=false;}},
    },
  };
  if(import.meta.env.DEV)(window as unknown as {__SILENCE__:typeof diagnostic}).__SILENCE__=diagnostic;

  if(import.meta.env.DEV&&world2)(window as unknown as {__WORLD__:typeof world2.debug}).__WORLD__=world2.debug;
  // Dev-only creature review stage: open the game with ?spider-lab.
  let spiderLab:Awaited<ReturnType<typeof import('../dev/spider-lab')['createSpiderLab']>>|undefined;
  if(import.meta.env.DEV&&new URLSearchParams(location.search).has('spider-lab'))void import('../dev/spider-lab').then(m=>{
    spiderLab=m.createSpiderLab({scene,camera,heightAt,world:collisions,setHours:h=>{hours=h;},teleport,equip:()=>{flashlight.devEquip();},markShadows:()=>{shadowDirty=true;},darkness:()=>diagnostic.darkness});
    (window as unknown as {__SPIDER__:typeof spiderLab}).__SPIDER__=spiderLab;
  });

  // The torch and the street lamps are the only lights that come and go, and each combination is a different shader program for every lit
  // material: torch off/on, then (when there are lamps) the same with the lamp pool lit. Every one is drawn here, behind the loading veil,
  // so neither picking the torch up nor the first dusk ever compiles anything mid-game.
  // Every texture a material in the scene (or a shader uniform) holds goes to the GPU now, behind the veil: the river's normal and foam
  // maps, the understory atlases, the creature's skin. Each is 50-100 ms in the frame it would otherwise be first drawn.
  function uploadSceneTextures(){
    const seen=new Set<THREE.Texture>();
    const add=(value:unknown)=>{
      const t=value as THREE.Texture|undefined;
      if(!t?.isTexture||seen.has(t))return;seen.add(t);
      const d=t as unknown as {isRenderTargetTexture?:boolean;isDepthTexture?:boolean;isCubeTexture?:boolean;isData3DTexture?:boolean;isCompressedTexture?:boolean};
      if(d.isRenderTargetTexture||d.isDepthTexture||d.isCubeTexture||d.isData3DTexture||d.isCompressedTexture)return;
      if(!(t.image?.width>0)||t.image?.complete===false)return;
      if((renderer.properties.get(t) as {__webglTexture?:unknown}).__webglTexture)return;
      renderer.initTexture(t);
    };
    scene.traverse(o=>{
      const m=(o as THREE.Mesh).material as THREE.Material|THREE.Material[]|undefined;if(!m)return;
      for(const material of Array.isArray(m)?m:[m]){
        for(const v of Object.values(material))add(v);
        const uniforms=(material as THREE.ShaderMaterial).uniforms;if(uniforms)for(const key of Object.keys(uniforms))add(uniforms[key]?.value);
      }
    });
  }
  const warmupTotal=()=>torchStates*(perfOn('lampWarmup')&&world2?.debug.streetLights.count?2:1);
  function warmupRender(darkness:number){
    // Draw the rig and its depth material with every light configuration while
    // the loading veil still covers the canvas. A compile alone would leave
    // skin buffers, bone textures, and texture uploads to the first encounter.
    if(warmupDraws===0){forest.warmupTextures(renderer);farForest?.update();farScatter?.update();farPlants?.update();if(perfOn('streamWarmup'))uploadSceneTextures();if(perfOn('slicedUpload'))slicer.prime();}
    const light=flashlight.light,wasVisible=creature.visible,beamWasVisible=light.visible,intensityWas=light.intensity,flashWas=scene.userData.flashlight;
    const listener=scene.getObjectByName('The Listener'),listenerWasVisible=listener?.visible;
    if(listener)listener.visible=true;
    creature.visible=true;light.visible=torchOnIn(warmupDraws);
    // The torch as it is when switched on: lit, and handed to the fog's beam (atmosphere.ts), so the beam's shadow-map and cookie reads
    // are first bound here and not on the night the player switches it on.
    if(light.visible){light.intensity=14;scene.userData.flashlight=light;}
    const unlit=lampsLitIn(warmupDraws)?world2?.debug.streetLights.warm():undefined;
    // Direct3D 11 (ANGLE) builds part of each program only at its first real draw, for the vertex layout and the render target it
    // meets there; a compile alone leaves that to whichever frame first shows the thing. So the warm-up draws draw the whole world,
    // not just the view from the start: the cabin, the far props, everything in every light state, behind the veil.
    const culled:THREE.Object3D[]=[];
    if(perfOn('warmupUnculled'))scene.traverse(o=>{if(o.frustumCulled){o.frustumCulled=false;culled.push(o);}});
    renderer.shadowMap.needsUpdate=true;sun.shadow.needsUpdate=true;light.shadow.needsUpdate=light.visible;
    try{atmosphere.render(elapsed,darkness);}finally{
      for(const o of culled)o.frustumCulled=true;
      unlit?.();creature.visible=wasVisible;if(listener)listener.visible=!!listenerWasVisible;light.visible=beamWasVisible;light.intensity=intensityWas;scene.userData.flashlight=flashWas;shadowDirty=true;
    }
    if(++warmupDraws===warmupTotal()){
      warmupFence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();
      // Everything already in the scene, in every light state it can meet, shadow passes included: materials that were out of view
      // during the warm-up draws too. Queued now, it is worked off behind the veil (the drain below keeps loading on until it is),
      // instead of in 15 to 30 ms steps while the veil fades.
      if(perfOn('streamWarmup'))gpuWarmup.add({label:'scene',textures:[],object:scene});
    }
  }

  function animate(now:number){
    if(disposed)return;
    raf=requestAnimationFrame(animate);
    // The frame rate limit. A 120 or 144 Hz screen asks for a frame every 7 to 8 ms; drawing every one keeps the GPU
    // flat out (heat, fans, a laptop slowing itself down) and the time between frames swings with how busy the scene is.
    // Skipping a refresh when the last frame is younger than the limit allows gives an even 60 (or 120) instead. The
    // margin lets a frame that arrives a little early still be drawn. Measurements (perf.drive) are never held back.
    if(settings.frameCap>0&&!benchActive&&now-last<1000/settings.frameCap*.85)return;
    const frameDuration=now-last,startCPU=performance.now();
    if(probe)probe.marks.start=startCPU;
    // Never negative: after snap() (dev) or a long block the browser can hand the next frame a timestamp older than `last`, and a negative
    // step ran the clock, the fades and the camera's easing backwards (the camera left the world, measurements and stills went wrong).
    const rawDelta=Math.max(0,Math.min(frameDuration/1000,.1));last=now;
    if(benchmarking)return;
    if(document.hidden)return;
    if(!loading&&admin.open){admin.update(now);return;}
    const dt=Math.min(rawDelta,.04);
    frameAverage=frameAverage*.98+rawDelta*1000*.02;
    // One complete, continuous day every 24 active minutes; test tools can accelerate it.
    const active=isActive(),simulate=active;
    // The clock runs on through a catch (the run counts it) but stands still while a sleep fades out: the run has already moved to dawn.
    if(simulate){
      elapsed+=dt;
      if(!grab||grab.kind==='caught'){hours=(hours+dt*cycleSpeed/60)%24;onRunEvents(gameRun.advance(hours));}
      world2?.time(absHours());
    }
    if(noticeUntil&&now>noticeUntil){notice.style.opacity='0';noticeUntil=0;}
    if(bannerUntil&&now>bannerUntil){banner.style.opacity='0';bannerUntil=0;}
    if(grab){
      if(simulate)grab.t+=dt;
      if(grab.kind==='lost'){
        // The run is over: black, the line, and then the island laid out again. The black never lifts.
        blackout.style.opacity=String(ramp(grab.t,0,1.8));card.style.opacity=String(ramp(grab.t,2.2,3.2));
        if(grab.t>8)newIsland();
      }else{
        const g=screenOf(grab);
        if(g.respawn&&!grab.respawned){grab.respawned=true;wake(now);}
        // A wake that was the lost run starts that scene at once; leave the screen to it.
        const after=grab as Scene|undefined;if(after&&after.kind!=='lost'){blackout.style.opacity=String(g.black);card.style.opacity=String(g.card);if(g.done){grab=undefined;blackout.style.opacity=card.style.opacity='0';}}
      }
    }
    const skyState=sky.update(hours,player,elapsed),darkness=skyState.darkness;
    // Indoors the eye opens further and barely closes (grade.ts indoorEye); eased over about a second each way so the step at the
    // door rides on the eye's own adaptation.
    indoorLight+=((world2?.indoors(player)?1:0)-indoorLight)*Math.min(1,dt*1.6);
    if(scene.userData.grade)indoorEye(scene.userData.grade as Grade,THREE.MathUtils.smoothstep(indoorLight,0,1));
    // For shaders that work out light themselves (the ground's relief shadows, terrain.ts).
    scene.userData.sunDirection=skyState.sunDirection;
    diagnostic.darkness=darkness;diagnostic.elapsed=elapsed;
    if(probe)probe.marks.sky=performance.now();
    // Taken: no walking away.
    if(bike.mounted&&(grab||flying))dismountBike();
    const directionZ=grab?0:(held('forward')?1:0)-(held('back')?1:0)-touchMove.y;
    const directionX=grab?0:(held('right')?1:0)-(held('left')?1:0)+touchMove.x;
    const crouch=!grab&&!flying&&!world2?.climbing&&bike.allows('crouch')&&held('crouch');
    // Asked to sprint: the key, or on touch a firm push on the stick. Whether the player really sprints is up to the stamina model
    // (game/sim/player/stamina.ts): it needs breath, movement and no crouching, flying or ladder, and it drives speed, field of view, noise and breathing.
    // A full jerry can is carried at a walk (objectives.ts canSprint).
    const heavy=world2?!canSprint(world2.objectiveState,world2.localPlayer):false;
    const hurry=!grab&&!heavy&&bike.allows('sprint')&&((touchMove.lengthSq()>0&&touchPushed)||held('sprint'));
    const run=stamina.update(active?dt:0,hurry&&!crouch&&!flying&&!wasClimbing,lastSpeed);
    // The breath (B): held, the Listener cannot hear it at 3 m; let go by force it is a gasp, which is a noise of its own.
    const bh=breathHold.update(active&&!grab&&!flying?dt:0,!grab&&!flying&&held('breath'),run.exhausted);
    breathHeldNow=bh.held;
    if(bh.gasp){audio.gasp();noise.emit({type:'noise',loudness:bh.noise,source:'gasp',x:player.x,z:player.z});}
    const waterDistance=WORLD_V2?channelOffset(player.x,player.z):Math.abs(player.x-riverX(player.z));
    let moveSpeed=crouch?.95:gaitSpeed(run.blend);
    const waterY=riverSurfaceAt(player.x,player.z);
    const inWater=waterY!==undefined&&player.y<waterY+.10;
    const swimming=!flying&&waterY!==undefined&&waterY-heightAt(player.x,player.z)>1.2&&player.y<waterY+.1;
    if(inWater)moveSpeed*=wadeSpeedFactor(waterDepthAt(player.x,player.z));
    // Walking through dense living ground cover gives soft resistance; its thin stems
    // bend rather than behaving like rigid posts. Leaf litter and twigs remain stepable.
    const offTrail=exclusion(player.x,player.z);
    if(!flying&&offTrail<.25)moveSpeed*=.88;
    if(flying)moveSpeed=hurry?36:10;
    temp.set(directionX,0,-directionZ);if(temp.length()>1)temp.normalize();
    if(flying)temp.applyEuler(new THREE.Euler(pitch,yaw,0,'YXZ'));
    else temp.applyAxisAngle(THREE.Object3D.DEFAULT_UP,yaw);
    if(flying)temp.y+=(held('rise')?1:0)-(held('crouch')?1:0);
    temp.multiplyScalar(active?moveSpeed:0);
    const ease=1-Math.exp(-dt*(temp.lengthSq()>0?6:10));velocity.lerp(temp,ease);
    const oldX=player.x,oldZ=player.z;
    // WORLD_V2 ladders: while attached the climber holds the player on the line (no gravity, strafing or collision) and normal movement is skipped.
    const climb=world2?.climb({dt:active?dt:0,forward:active?THREE.MathUtils.clamp(directionZ,-1,1):0,player,enabled:!flying});
    if(climb){jumpVelocity=0;airborne=false;jumpRequested=false;player.set(climb.x,climb.y,climb.z);velocity.set(0,0,0);}
    else if(flying)player.addScaledVector(velocity,dt);
    else if(bike.mounted){
      // On the bicycle: W pedals, S brakes, A and D steer (positive is left, as the heading is); the bicycle decides speed and heading.
      rideInput={throttle:Math.max(0,directionZ),brake:Math.max(0,-directionZ),steer:-directionX};
      const ride=bike.update(active?dt:0,rideInput,bikeSurface());
      if(ride.events.includes('dismounted-water'))say('The bicycle will not ride through water.');
      else{
        rideSpeed=ride.speed;
        const next=moveCharacter(player,-Math.sin(ride.heading)*ride.speed*dt,-Math.cos(ride.heading)*ride.speed*dt,1.69,movementGround,collisions,BIKE_BODY);
        const moved=Math.hypot(next.x-player.x,next.z-player.z);
        player.x=next.x;player.z=next.z;player.y=THREE.MathUtils.damp(player.y,next.y,18,dt);
        // A wall or a trunk takes the speed it stopped; the bicycle cannot go on at 5 m/s with its nose against it.
        if(dt>0&&moved<ride.speed*dt*.9)bike.limitSpeed(moved/dt);
        bike.place(player.x,player.z);
        if(simulate&&ride.noise>0)noise.emit({type:'noise',loudness:ride.noise,source:'bicycle',x:player.x,z:player.z});
        // The view turns with the bicycle, and the head may turn about 100 degrees either way from straight ahead.
        yaw+=angleDelta(ride.heading,rideHeading);rideHeading=ride.heading;
        const look=angleDelta(yaw,ride.heading);if(Math.abs(look)>LOOK_LIMIT)yaw=ride.heading+Math.sign(look)*LOOK_LIMIT;
      }
      velocity.set(0,0,0);
    }
    else{
      const next=moveCharacter(player,velocity.x*dt,velocity.z*dt,crouch?1.05:1.69,movementGround,collisions);
      if(inWater||waterY!==undefined){const wade=limitWading(oldX,oldZ,next.x,next.z);next.x=wade.x;next.z=wade.z;}
      player.x=next.x;player.z=next.z;
      if(jumpRequested&&active&&!airborne&&!crouch&&!swimming){jumpVelocity=4.3;airborne=true;}jumpRequested=false;
      if(airborne||player.y-next.y>.32){
        airborne=true;jumpVelocity-=12*dt;let y=player.y+jumpVelocity*dt;
        if(jumpVelocity>0)for(const c of collisions.nearby(player.x,player.z,.24)){
          if(c.minY>=player.y+1.69-.02&&c.minY<y+1.69&&solidContact(c,player.x,player.z,.24).depth>0){y=c.minY-1.69-.01;jumpVelocity=0;}
        }
        if(jumpVelocity<=0&&y<=next.y){y=next.y;jumpVelocity=0;airborne=false;}player.y=y;
      }else player.y=THREE.MathUtils.damp(player.y,next.y,18,dt);
    }
    const speed=climb?0:Math.hypot(player.x-oldX,player.z-oldZ)/Math.max(dt,.001);
    lastSpeed=speed;wasClimbing=!!climb;
    // Every footfall goes into the creature's noise stream, as loud as the gait and the ground make it. Wading
    // is left to the rebuilt world's splashes, which are already in the stream.
    if(simulate&&!bike.mounted&&!swimming&&!airborne&&!flying&&!climb&&!grab&&speed>.25&&!(world2&&inWater)){
      stride+=speed*dt;
      if(stride>.82){
        stride%=.82;
        // The ground is one query (sim/world/surface.ts); indoors it is a wooden floor, and the walls do not stop the sound.
        const surface=inWater?'water':world2?.indoors(player)?'wood':WORLD_V2?stepSurfaceOf(surfaceAt(player.x,player.z)):Math.abs(player.z-roadZ(player.x))<2.7?'road':offTrail<.25?'forest':'dirt';
        const loudness=footstepNoise({speed,sprinting:run.sprinting,crouching:crouch,surface});
        if(loudness>0)noise.emit({type:'noise',loudness,source:'footstep',x:player.x,z:player.z});
      }
    }
    // Past a jog the stride rate grows slowly: at a full sprint the head bobs a few times a second, not seven.
    walkingPhase+=(Math.min(speed,3.4)+Math.max(0,speed-3.4)*.25)*dt*(crouch?2.7:3.7);
    cameraHeight=THREE.MathUtils.damp(cameraHeight,crouch&&!swimming?1.05:1.69,7,dt);
    const motion=flying||swimming||airborne||bike.mounted?0:THREE.MathUtils.clamp(speed/1.8,0,1);
    const bob=Math.sin(walkingPhase*2)*.017*motion;
    const breath=Math.sin(now*.0013)*.0028;
    if(bikeView){
      if(!bike.mounted){rideInput={throttle:0,brake:0,steer:0};rideSpeed=0;}
      bikeView.update(active?dt:0,{mounted:bike.mounted,x:bike.position.x,z:bike.position.z,heading:bike.heading,speed:rideSpeed,steer:rideInput.steer,throttle:rideInput.throttle,brake:rideInput.brake});
      aimBike();
    }
    camera.position.set(player.x,player.y+cameraHeight+bob+breath+(climb?.bob??0),player.z);
    if(bike.mounted&&bikeView)bikeView.eye(camera.position);
    // Being taken: the head is wrenched round to its face, and shaken.
    let jolt=0;
    if(grab&&grab.kind==='caught'&&!grab.respawned){
      encounters.headPosition(head);
      // It drags the camera to its face. The camera ends a fixed distance in front of the face, on the side the face is on
      // (never behind the head or inside the body, wherever the player was standing when caught), and the view is turned
      // onto the face as it goes. The pull starts gently and is fastest at the end; then the cut to black.
      encounters.facing(grabFacing);
      grabFrom.subVectors(camera.position,head).setY(0);
      if(grabFrom.lengthSq()>1e-6)grabFrom.normalize();
      // In front of the face, leaning toward where the player's eyes were so the pull is as short and straight as it can be.
      grabEnd.copy(grabFacing).multiplyScalar(1.3).add(grabFrom).setY(0);
      if(grabEnd.lengthSq()<1e-6)grabEnd.copy(grabFacing);
      grabEnd.normalize().multiplyScalar(GRAB.standOff).add(head);grabEnd.y=head.y-.06;
      const pulled=THREE.MathUtils.clamp((grab.t-GRAB.pullFrom)/(GRAB.black-GRAB.pullFrom),0,1);
      camera.position.lerp(grabEnd,pulled*pulled*(3-2*pulled)*pulled);
      // Caught right against it (or under it), the camera starts nearer than that: it is eased out to the same distance
      // in the first moments, so the view is never from inside its head.
      grabFrom.subVectors(camera.position,head);
      const gap=grabFrom.length(),least=GRAB.standOff*THREE.MathUtils.smoothstep(grab.t,0,.18);
      if(gap<least){if(gap<1e-4)grabFrom.copy(grabFacing);else grabFrom.multiplyScalar(1/gap);camera.position.copy(head).addScaledVector(grabFrom,least);}
      // The view settles on the middle of the face, a little below the eyes.
      const dx=head.x-camera.position.x,dy=head.y-.1-camera.position.y,dz=head.z-camera.position.z,toward=Math.atan2(-dx,-dz),k=1-Math.exp(-dt*THREE.MathUtils.lerp(7,20,THREE.MathUtils.clamp(grab.t/GRAB.wrench,0,1)));
      yaw+=Math.atan2(Math.sin(toward-yaw),Math.cos(toward-yaw))*k;
      pitch+=(THREE.MathUtils.clamp(Math.atan2(dy,Math.hypot(dx,dz)),-1.28,1.32)-pitch)*k;
      jolt=Math.sin(grab.t*47)*.03*(1-THREE.MathUtils.smoothstep(grab.t,.15,.8));
    }
    // Eyes open slowly, after loading and after waking at the cabin.
    const awakening=loading?0:Math.min(THREE.MathUtils.smoothstep((now-loadCompleteAt)/1000,0,3.2),THREE.MathUtils.smoothstep((now-wokeAt)/1000,0,3.2));
    camera.rotation.set(THREE.MathUtils.lerp(-1.18,pitch,awakening)+Math.sin(walkingPhase)*.0018*motion+jolt*.5,yaw,Math.cos(walkingPhase)*.003*motion+jolt+(bikeView?.roll??0),'YXZ');
    // The settings' field of view eases in as before; sprinting adds a few degrees on top, eased by the stamina model's own blend.
    // The projection matrix is rebuilt only on a frame where the value really changed.
    baseFov=Math.abs(baseFov-settings.fov)<.001?settings.fov:THREE.MathUtils.damp(baseFov,settings.fov,2,dt);
    const targetFov=baseFov+sprintFov(run.blend);
    if(camera.fov!==targetFov){camera.fov=targetFov;camera.updateProjectionMatrix();}
    staminaHud.update({allowed:active&&!grab&&!flying,value:run.value,exhausted:run.exhausted});
    camera.getWorldDirection(forward);
    const startTerrain=performance.now(),terrainChanged=terrain.update(elapsed,player,darkness),startForest=performance.now(),forestChanged=forest.update(elapsed,player),endForest=performance.now();farForest?.update();farScatter?.update();farPlants?.update();
    if(probe){const m=probe.marks;m.terrain0=startTerrain;m.forest0=startForest;m.forest1=endForest;}
    const storyChanged=story.update(player);
    const worldChanged=world2?world2.update({dt,time:elapsed,player,darkness,active:active&&!grab,simulate}):false;
    syncMachines(simulate?dt:0);
    if(objectiveHud&&world2)objectiveHud.update({now,allowed:active&&!grab,text:objectiveText(world2.objectiveState,guideKind(world2.objectiveState,world2.localPlayer),{dropKey:coarse?undefined:keyLabel(settings.bindings.drop),room:hasRoom(world2.objectiveState,world2.localPlayer)}),day:`Day ${gameRun.day} of ${RUN.days}`});
    // The backpack panel follows what is carried (a pickup or a drop with it open), and goes away with play (a menu, being taken).
    if(inventoryOpen){if(!active||grab)inventory?.close();else inventory?.refresh();}
    // The map and the place's name, four times a second: the pencil rings follow the parts still lying out; the name fires on entering a place.
    if(islandMap&&world2){
      if(mapOpen&&(!active||grab))islandMap.close();
      if(now-mapAt>250){mapAt=now;const here=placeAt(player.x,player.z);islandMap.update(player.x,player.z,world2.objectiveState.items);if(active&&!grab&&bannerTracker.update(here?.id,now/1000)&&here)placeBanner?.show(here.title);}
    }
    placeStrapped();if(probe)probe.marks.world1=performance.now();
    const creatureWasVisible=creature.visible;
    if(forest.collisionVersion!==forestCollisionVersion){forestCollisionVersion=forest.collisionVersion;collisions.replace('forest',forest.solidColliders);}
    if(terrain.collisionVersion!==terrainCollisionVersion){terrainCollisionVersion=terrain.collisionVersion;collisions.replace('terrain',terrain.solidColliders);}
    const profile=import.meta.env.DEV&&now<profileUntil;
    const startEncounter=profile?performance.now():0;
    if(import.meta.env.DEV&&spiderLab&&!loading)spiderLab.update(rawDelta);
    if(simulate&&(!benchActive||benchCreature)){
      encounters.update(dt,elapsed,player,forward,darkness,hours,senses(dt,crouch,run.sprinting,inWater,!!climb));lastFoot.copy(player);
      if(encounters.takeStrike())beginGrab();
      if(creatureWasVisible||creature.visible)collisions.replace('creature',encounters.solidColliders());
      // Resolve limbs that entered the player during this tick against the new
      // pose, before drawing. The movement sweep above uses the previous pose.
      if(active&&!flying&&!climb&&!grab&&creature.visible&&player.distanceToSquared(creature.position)<36){
        const separated=moveCharacter(player,0,0,crouch?1.05:1.69,heightAt,collisions);
        camera.position.x+=separated.x-player.x;camera.position.z+=separated.z-player.z;
        player.x=separated.x;player.z=separated.z;
      }
    }
    const encounterCost=profile?performance.now()-startEncounter:0;
    if(probe)probe.marks.encounter1=performance.now();
    flashlight.update(elapsed,speed);
    // The sun's shadow in two maps blended by the sun's progress between them (shadows.ts), or one map redrawn on a cadence (the dev switch off).
    const blend=perfOn('sunBlend');
    const shadowMoved=blend?false:sunShadow.update(player,skyState.sunDirection);
    farShadow?.update(skyState.sunDirection);
    const castersChanged=shadowDirty||terrainChanged||forestChanged||storyChanged||worldChanged||creatureWasVisible!==creature.visible;
    const animatedCaster=simulate&&creature.visible;
    sunDirty||=castersChanged||shadowMoved||animatedCaster;
    // At normal cycle speed a 30 Hz depth refresh moves the shadows less than
    // a texel for most of the day. Keep fast admin scrubbing and low sun smooth.
    // Redrawing the sun's shadow map sends about a million triangles through again. It was redrawn about 20 times a
    // second all day just to follow the sun, and on every single frame at low sun and whenever the creature was in
    // view, which is where dusk went from a 10 ms frame to 17. The sun turns a quarter of a degree a second: followed 8
    // times a second (15 at low sun, where shadows are long) the tip of the longest shadow steps by a few centimetres,
    // under the softness of its own edge. A moving caster (the creature) gets 30 a second. Anything that changes what
    // casts (a door, a streamed-in tree, a dropped item) still redraws at once.
    const sunGap=!perfOn('sunCadence')?0:animatedCaster?1000/30:skyState.sunElevation<.18?1000/15:1000/8;
    const drawSun=blend?sunShadow.frame({position:player,direction:skyState.sunDirection,casters:castersChanged,animated:animatedCaster,active:darkness<.975||skyState.moonLight>0,now,minGap:settings.shadowRate?1000/settings.shadowRate:0,spread:perfOn('sunSpread')?3:1})
      :(darkness<.975||skyState.moonLight>0)&&sunDirty&&(castersChanged||!sun.shadow.map||cycleSpeed>1||(now-lastSunDraw>=sunGap&&(settings.shadowRate===0||now-lastSunDraw>=1000/settings.shadowRate)));
    if(!blend)sun.shadow.needsUpdate=drawSun;
    if(drawSun){lastSunDraw=now;sunDirty=false;}
    flashlight.updateShadow(castersChanged||animatedCaster);
    renderer.shadowMap.needsUpdate=drawSun||flashlight.light.shadow.needsUpdate;
    shadowDirty=false;
    if(probe)probe.marks.shadow1=performance.now();
    audio.update(dt,{position:camera.position,direction:forward,speed:active&&!bike.mounted&&!airborne&&!flying&&!climb&&!swimming?speed:0,sprinting:active&&run.sprinting,stamina:run.value,winded:run.exhausted,breathHeld:bh.held,darkness,surface:inWater?'water':world2?.indoors(player)?'wood':(WORLD_V2?roadDistance(player.x,player.z)<ROAD.footstep:Math.abs(player.z-roadZ(player.x))<2.7)?'road':'dirt',riverDistance:waterDistance});
    if(bikeView){bikeAudio.attach(audio['context'],audio['master']);const rolling=bike.mounted&&active&&!grab;if(rolling||wasRolling)bikeAudio.roll(rolling?rideSpeed:0,bikeSurface());wasRolling=rolling;}
    if(probe)probe.marks.audio1=performance.now();
    renderer.info.reset();
    if(texturesDirty){filterTextures();texturesDirty=false;}
    // While the veil is up the queue is emptied without pauses, so nothing near the start is half built when it lifts.
    const warming=loading&&perfOn('streamWarmup')?gpuWarmup.drain(24):0;
    // Said before the draw below: the whole-scene warm-up draws each block this frame for seconds on a first load, and the page only paints
    // once they return, so the words for a draw have to be on screen from the frames before it (the 900 ms the files must stay quiet).
    if(loading)loadingHud.update(loadingProgress.update({assetsPending:pendingAssets>0,queuePending:gpuWarmup.pending,queueLast:gpuWarmup.last,warmupDraws,warmupTotal:warmupTotal(),groundPending:terrain.streamingStats.pendingNear,quiet:pendingAssets===0&&warming===0&&frame>8&&now-lastAsset>300&&terrain.streamingStats.pendingNear===0}),now);
    // The ground round the spawn comes from the terrain worker (terrain.ts): the veil also waits for the last of it.
    const groundPending=loading?terrain.streamingStats.pendingNear:0;
    const startRender=performance.now(),loadingQuiet=loading&&pendingAssets===0&&now-lastAsset>900&&frame>8&&warming===0&&groundPending===0;
    // Behind the veil with a parallel compiler (see linkPrograms): every half second whatever has streamed in is linked, in the light
    // state of the next whole-scene warm-up draw once the files are in, and nothing is drawn while any program is still compiling. A
    // draw then would wait for the compiler on this thread, one program at a time, and freeze the page and the browser with it.
    let programsBusy=false;
    if(loading&&parallelCompile&&perfOn('asyncPrograms')){
      // Once the files are in, every light state still to be drawn is linked at once, so they compile side by side instead of a
      // state at a time (four passes took 90 s one after another); never left to the draw itself.
      const next=loadingQuiet&&warmupDraws<warmupTotal()?warmupDraws:-1;
      if(next!==linkedFor||now-programScan>500){
        programScan=now;linkedFor=next;
        if(next>=0)for(let state=next;state<warmupTotal();state++)linkPrograms(scene,state);
        else linkPrograms(scene,!steadyTorch&&flashlight.light.visible?1:0);
      }
      programsBusy=!allProgramsReady();
    }
    if(probe){probe.marks.render0=startRender;probe.beginRender();}
    perfOverlay.setVisible(settings.perfOverlay);perfOverlay.beginGpu();
    if(programsBusy){/* the veil is up: nothing to see, and a draw would wait on the compiler */}
    else if(loadingQuiet&&warmupDraws<warmupTotal())warmupRender(darkness);
    else{
      atmosphere.render(elapsed,darkness);
      if(loadingQuiet&&(!warmupFence||gl.clientWaitSync(warmupFence,0,0)!==gl.TIMEOUT_EXPIRED)){
        if(warmupFence){gl.deleteSync(warmupFence);warmupFence=null;}
        loading=false;loadCompleteAt=now;loadingHud.update(loadingProgress.finish(),now);loadingHud.finish();
      }
    }
    perfOverlay.endGpu();
    if(probe)probe.marks.render1=performance.now();
    if(!loading&&veil.isConnected){veil.style.opacity=String(1-THREE.MathUtils.smoothstep((now-loadCompleteAt)/1000,0,2.8));if(now-loadCompleteAt>3300){veil.remove();loadingHud.dispose();}}
    if(profile)profileRows.push({frame:frameDuration,update:startRender-startCPU,forest:endForest-startForest,terrain:startForest-startTerrain,encounter:encounterCost,submit:performance.now()-startRender,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,sunShadow:drawSun,creature:creature.visible});
    if(!loading&&perfOn('streamWarmup'))gpuWarmup.update();
    if(probe)probe.endFrame(frameDuration,drawSun);
    perfOverlay.frame(now,frameDuration,performance.now()-startCPU);
    frame++;admin.update(now);
    if(frame%120===0){
      diagnostic.elapsed=elapsed;diagnostic.darkness=darkness;diagnostic.fps=Math.round(1000/frameAverage);diagnostic.active=active;
      diagnostic.drawCalls=renderer.info.render.calls;diagnostic.triangles=renderer.info.render.triangles;
    }
  }
  startupMark('controls, warm-up and the rest');
  raf=requestAnimationFrame(animate);
  return ()=>{
    disposed=true;veil.remove();loadingHud.dispose();if(warmupFence)gl.deleteSync(warmupFence);manager.onStart=oldStart;manager.onLoad=oldLoad;manager.onProgress=oldProgress;cancelAnimationFrame(raf);if(document.pointerLockElement===renderer.domElement)document.exitPointerLock();
    window.removeEventListener('mouseup',mouseUp);window.removeEventListener('mousemove',mouseMove);window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);densityQuery?.removeEventListener('change',densityChanged);window.removeEventListener('orientationchange',clearInput);
    document.removeEventListener('pointerlockchange',lockChange);document.removeEventListener('pointerlockerror',lockError);document.removeEventListener('visibilitychange',visibilityChange);
    renderer.domElement.removeEventListener('mousedown',mouseDown);renderer.domElement.removeEventListener('touchstart',touchStart);renderer.domElement.removeEventListener('touchmove',touchUpdate);renderer.domElement.removeEventListener('touchend',touchEnd);renderer.domElement.removeEventListener('touchcancel',touchEnd);
    unsubscribeNoise();blackout.remove();notice.remove();banner.remove();objectiveHud?.dispose();inventory?.dispose();islandMap?.dispose();placeBanner?.dispose();staminaHud.dispose();world2?.dispose();bikeView?.dispose();bikeAudio.dispose();admin.dispose();slicer.dispose();perfOverlay.dispose();flashlight.dispose();sunShadow.dispose();sky.dispose();audio.dispose();encounters.dispose();forest.dispose();farForest?.dispose();farScatter?.dispose();farPlants?.dispose();farShadow?.dispose();story.dispose();terrain.dispose();atmosphere.dispose();
    scene.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();const mats=Array.isArray(object.material)?object.material:[object.material];for(const mat of mats){for(const v of Object.values(mat))if(v instanceof THREE.Texture)v.dispose();mat.dispose();}}});
    renderer.dispose();renderer.domElement.remove();
  };
}
