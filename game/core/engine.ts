import { guardUnlitLights } from '../render/gpu/light-guards';
import * as THREE from 'three';
import { WORLD_V2, WORLD_SEED } from '../sim/world/world-flags';
import { ROAD } from '../sim/world/road-profile';
import { createWorldV2, doorAt } from '../render/props/world-v2';
import { channelOffset } from '../sim/world/world-noise';
import {readSettings,keyLabel,type Action} from './settings';
import { createTerrain, heightAt, exclusion, riverX, roadZ, roadDistance, pathX } from '../render/world/terrain';
import { createForest } from '../render/world/forest';
import { createAtmosphere } from '../render/world/atmosphere';
import { ForestAudio } from '../audio/audio';
import { createEncounters } from '../render/creature/encounters';
import { createStory } from '../render/props/story';
import { createStableSunShadow } from '../render/world/shadows';
import { renderRatio } from './quality';
import { createCollisionWorld, moveCharacter, characterSupportAt, solidContact } from '../sim/world/collision';
import { createAdmin } from '../ui/admin';
import { createSky } from '../render/world/sky';
import { biomeAt, riverSurfaceAt, WORLD_DESTINATIONS } from '../sim/world/world';
import { createFlashlight } from '../render/props/flashlight';
import { createTapTracker } from './tap';
import type { EncounterView } from '../sim/creature/encounter-visibility';
import { footstepLoudness, FLASHLIGHT_CLICK_LOUDNESS, type FootSurface, type NoiseEvent as CreatureNoise } from '../sim/creature/creature-brain';
import type { CreatureSenses, CreatureMode } from '../render/creature/encounters';
import { heldKind, type ObjectiveEvent } from '../sim/objectives/objectives';
import { createObjectiveHud, OBJECTIVE_KEY } from '../ui/objective-hud';
import { createPerfOverlay, PERF_OVERLAY_KEY } from '../ui/perf-overlay';
import { objectiveText } from '../sim/objectives/objective-text';
import { POI_PLACEMENTS } from '../sim/world/world-layout';
import { initialLives, loseLife, respawnHours, deathCard, grabTimeline, GRAB, NIGHT_START_HOURS, type DeathOutcome } from '../sim/player/lives';
import { createPerfProbe, drawList, shadowInstanceCulling, textureReport } from '../dev/perf-probe';
import { perfOn, perfSwitches } from './perf-flags';
import { createGpuWarmup } from '../render/gpu/gpu-warmup';
import { createTextureSlicer } from '../render/gpu/texture-slicer';
import { createShadowProgramWarmer } from '../render/gpu/shadow-programs';
import { createStamina, gaitSpeed, sprintFov } from '../sim/player/stamina';
import { createStaminaHud } from '../ui/stamina-hud';
import { waterDepthAt, wadeSpeedFactor, limitWading } from '../sim/world/water-depth';

// Deep lakes and open sea support a swimming body, rather than a player
// walking across the bottom with the camera below the water surface.
const movementGround=(x:number,z:number)=>{
  const bed=heightAt(x,z),water=riverSurfaceAt(x,z);
  return water!==undefined?Math.max(bed,water-.95):bed;
};

export function createGame(container:HTMLElement) {
  let saved:string|null=null;try{saved=localStorage.getItem('silence-settings');}catch{}
  const settings=readSettings(saved);
  const veil=document.createElement('div');veil.style.cssText='position:absolute;inset:0;background:#000;z-index:100;pointer-events:none;opacity:1';container.appendChild(veil);
  let loading=true,loadCompleteAt=Infinity,pendingAssets=0,lastAsset=performance.now(),texturesDirty=true;
  const manager=THREE.DefaultLoadingManager,oldStart=manager.onStart,oldLoad=manager.onLoad,oldProgress=manager.onProgress;
  manager.onStart=()=>{pendingAssets++;lastAsset=performance.now();};manager.onLoad=()=>{pendingAssets=0;lastAsset=performance.now();};manager.onProgress=()=>{lastAsset=performance.now();texturesDirty=true;};
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(69,window.innerWidth/window.innerHeight,.075,1800);
  camera.rotation.order='YXZ';camera.layers.enable(2);
  // The field of view the settings ask for, eased towards; the sprint widening is added on top of it each frame.
  let baseFov=camera.fov;
  if(perfOn('lightGuards'))guardUnlitLights();
  const renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance',alpha:false});
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
  const sunShadow=createStableSunShadow(sun,renderer.capabilities.maxTextureSize,()=>perfOn('sunShadowThrottle'));
  scene.add(sun,sun.target);
  const sky=createSky(renderer,scene,sun,hemi);
  const player=new THREE.Vector3(pathX(12),heightAt(pathX(12),12),12);
  const terrain=createTerrain(scene,player,renderer);
  const forest=createForest(scene,heightAt,exclusion,player);
  const story=createStory(scene,heightAt);
  const collisions=createCollisionWorld();scene.userData.treesNear=(x:number,z:number,r:number)=>collisions.nearby(x,z,r);   // the fog shades itself under the crowns (atmosphere.ts)
  collisions.replace('story',story.solidColliders);
  let forestCollisionVersion=-1,terrainCollisionVersion=-1;
  const atmosphere=createAtmosphere(renderer,scene,camera,terrain.water,sun);
  const audio=new ForestAudio();audio.setVolumes(settings);
  // One stream of sounds for the creature. The rebuilt world owns it (the objectives' noises go there); the
  // classic world has only what the engine adds: footsteps and the torch switch.
  type Noise=Extract<ObjectiveEvent,{type:'noise'}>;
  const classicNoise=new Set<(e:Noise)=>void>();
  const noise={
    emit:(e:Noise)=>{if(world2)world2.noise.emit(e);else for(const listener of classicNoise)listener(e);},
    subscribe:(listener:(e:Noise)=>void)=>{if(world2)return world2.noise.subscribe(listener);classicNoise.add(listener);return()=>{classicNoise.delete(listener);};},
  };
  const flashlight=createFlashlight(scene,camera,heightAt,collisions,()=>{audio.flashlightClick();noise.emit({type:'noise',loudness:FLASHLIGHT_CLICK_LOUDNESS,source:'flashlight',x:player.x,z:player.z});});
  const world2=WORLD_V2?createWorldV2({scene,camera,container,heightAt,collisions,flashlight,water:terrain.water,viewHeight:()=>renderer.domElement.height,riverX,exclusion,interactKey:()=>keyLabel(settings.bindings.interact)}):undefined;
  // The objective in the top-left corner (rebuilt world only): always shown. O hides or shows it, and so does the Settings checkbox;
  // both are the one saved setting, so the choice is still there after a reload.
  const saveSettings=()=>{try{localStorage.setItem('silence-settings',JSON.stringify(settings));}catch{}};
  const objectiveHud=world2?createObjectiveHud(container,{enabled:()=>settings.objectiveHints,setEnabled:on=>{settings.objectiveHints=on;saveSettings();}}):undefined;
  // Sprint stamina (game/sim/player/stamina.ts) and its bar, which only shows while stamina is below full (game/ui/stamina-hud.ts).
  const stamina=createStamina(),staminaHud=createStaminaHud(container);
  const interact=(pickupOnly=false)=>grab?false:world2?world2.activate(pickupOnly)||(!pickupOnly&&flashlight.toggle()):flashlight.interact(pickupOnly);
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
  // It patrols the places the player needs: the rebuilt world's landmarks, or the classic destinations.
  const creaturePlaces=WORLD_V2?POI_PLACEMENTS.filter(p=>['cabin','hut','generator','mast','lookout','logstack','camp','chapel','mine'].includes(p.asset)).map(p=>({x:p.x,z:p.z})):WORLD_DESTINATIONS.map(d=>({x:d.x,z:d.z}));
  const encounters=createEncounters(scene,heightAt,audio,collisions,readEncounterView,riverSurfaceAt,{places:creaturePlaces,seed:WORLD_SEED||7741,doorAt:world2?doorAt:undefined});
  const unsubscribeNoise=noise.subscribe(e=>{if(e.x!==undefined&&e.z!==undefined)encounters.hear({loudness:e.loudness,source:e.source,x:e.x,z:e.z} satisfies CreatureNoise);});
  const creature=scene.getObjectByName('something-between-the-trees')!;
  const velocity=new THREE.Vector3();
  let jumpVelocity=0, airborne=false, jumpRequested=false;
  // Last frame's measured ground speed and ladder state: the stamina model decides about sprinting before this frame's movement is known.
  let lastSpeed=0,wasClimbing=false;
  const forward=new THREE.Vector3(0,0,-1);
  const keys=new Set<string>();
  let yaw=Math.atan2(player.x-pathX(player.z-8),8),pitch=-.045,elapsed=0,walkingPhase=0,cameraHeight=1.69;
  const startPoint={x:player.x,z:player.z,yaw};
  // Three lives. Being taken: the camera is wrenched to its face, it screeches, black, a line of text, and the
  // player wakes at the cabin later in the night (or, the third time, the night starts again).
  let lives=initialLives(),grab:{t:number;outcome:DeathOutcome;respawned:boolean}|undefined,wokeAt=-Infinity,stride=0;
  const head=new THREE.Vector3(),lastFoot=new THREE.Vector3(player.x,player.y,player.z);
  const blackout=document.createElement('div');blackout.style.cssText='position:absolute;inset:0;background:#000;z-index:4;pointer-events:none;opacity:0;display:flex;align-items:center;justify-content:center';
  const card=document.createElement('div');card.style.cssText='opacity:0;text-align:center;color:#c9ccc2;font:300 15px/1.6 system-ui,sans-serif;letter-spacing:.34em;text-transform:uppercase';
  const cardTitle=document.createElement('div'),cardLine=document.createElement('div');cardLine.style.cssText='margin-top:12px;font-size:11px;letter-spacing:.42em;color:#868d82';
  card.appendChild(cardTitle);card.appendChild(cardLine);blackout.appendChild(card);container.appendChild(blackout);
  const grabFacing=new THREE.Vector3(),grabFrom=new THREE.Vector3(),grabEnd=new THREE.Vector3();
  function beginGrab(){
    if(grab)return;
    // Whatever was in hand falls where they were taken, and stays there.
    world2?.drop();
    const r=loseLife(lives);lives=r.state;grab={t:0,outcome:r.outcome,respawned:false};
    const words=deathCard(lives,r.outcome);cardTitle.textContent=words.title;cardLine.textContent=words.line;
    keys.clear();velocity.set(0,0,0);drag=false;touchMove.set(0,0);
  }
  /** Under black: wake at the cabin later in the night, or start the night again. The creature goes far away. */
  function wake(now:number){
    const over=grab?.outcome==='game-over';
    world2?.letGo();
    if(over){lives=initialLives();hours=NIGHT_START_HOURS;world2?.restart();flashlight.reset();}
    else hours=respawnHours(hours);
    const at=over?startPoint:world2?.wakePoint()??startPoint;
    teleport(at.x,at.z);if(!flying)player.y=characterSupportAt(player.x,player.z,player.y+.5,heightAt,collisions);
    yaw=at.yaw;pitch=-.08;lastFoot.copy(player);stride=0;
    if(over)encounters.restart(player,elapsed);else encounters.relocate(player,elapsed);
    wokeAt=now;shadowDirty=true;stamina.reset();
  }
  /** What the creature is told about the player each frame, beyond where they are. */
  const senses=(dt:number,crouch:boolean,hurry:boolean,inWater:boolean,climbing:boolean):CreatureSenses=>({
    // A teleport is not a velocity.
    ...(Math.hypot(player.x-lastFoot.x,player.z-lastFoot.z)>dt*12?{vx:0,vz:0}:{vx:(player.x-lastFoot.x)/Math.max(dt,.001),vz:(player.z-lastFoot.z)/Math.max(dt,.001)}),
    sprinting:hurry&&!crouch,crouching:crouch,flashlightOn:flashlight.active,inWater,onLadder:climbing,
    indoors:world2?.indoors(player)??false,untouchable:flying||!!grab,blackout:!!grab&&grabTimeline(grab.t).black>=1,
  });
  let hours=16,cycleSpeed=1,flying=false;
  let disposed=false,raf=0,last=performance.now(),frameAverage=16.67;
  let pointerWasLocked=false,pointerLockPending=false;
  let drag=false,mouseX=0,mouseY=0;
  let profileUntil=0,benchmarking=false;
  let diagnosticRatio:number|undefined;
  let shadowDirty=true,sunDirty=true,lastSunDraw=-Infinity;
  let warmupDraws=0,warmupFence:WebGLSync|null=null;
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
  const mouseDown=(e:MouseEvent)=>{if(e.button!==0||admin.open||performance.now()-lastTouch<700)return;if(isActive())mouseTap.begin(performance.now());else mouseTap.cancel();drag=true;mouseX=e.clientX;mouseY=e.clientY;start();};
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
    if(e.code==='Escape'&&!e.repeat){e.preventDefault();admin.show();return;}
    if(Object.values(settings.bindings).includes(e.code))e.preventDefault();
    keys.add(e.code);
    if(e.code===settings.bindings.interact&&!e.repeat){start();if(isActive()&&interact(true))shadowDirty=true;}
    if(e.code===settings.bindings.rise&&!e.repeat&&isActive()&&!grab){if(world2?.climbing)world2.letGo();else if(!flying&&!airborne)jumpRequested=true;}
    if(e.code===settings.bindings.drop&&!e.repeat&&isActive()&&!grab&&world2?.drop())shadowDirty=true;
    if(e.code===OBJECTIVE_KEY&&!e.repeat&&isActive()&&!grab&&!Object.values(settings.bindings).includes(e.code))objectiveHud?.toggle();
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
    getState:()=>({hours,cycleSpeed,flying,position:player.toArray(),fps:Math.round(1000/frameAverage),solids:collisions.stats().solids}),
    setHours:(h)=>{hours=((h%24)+24)%24;},setSpeed:(speed)=>{cycleSpeed=speed;},
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
  // nothing from it, so they get 2x; bark, props and the creature get 4x.
  const filterFor=(material:THREE.Material)=>{
    const wanted=Math.min(anisotropy,settings.anisotropy);
    if(!perfOn('filterPolicy'))return wanted;
    const card=material.alphaTest>0||material.alphaHash||material.alphaToCoverage||material.transparent;
    return Math.min(wanted,card?2:4);
  };
  function filterTextures(){
    // A texture shared by two kinds of material keeps the higher of the two; a change of the setting starts over.
    if(filteredAt!==settings.anisotropy){filtered=new WeakMap();filteredAt=settings.anisotropy;}
    scene.traverse(o=>{if(!(o instanceof THREE.Mesh))return;for(const material of Array.isArray(o.material)?o.material:[o.material]){const af=filterFor(material);for(const value of Object.values(material))if(value instanceof THREE.Texture&&!value.isRenderTargetTexture&&value.image?.width>0&&value.image?.complete!==false&&(filtered.get(value)??-1)<af){filtered.set(value,af);value.anisotropy=af;value.needsUpdate=true;}}});}
  // Props stream in with textures of up to 4096 px and their own shader programs. pois.ts hands each model to this queue as it arrives; one
  // texture or one light state's programs is built per step, with a pause that grows with the cost of the last step (game/render/gpu/gpu-warmup.ts).
  const lampStates=()=>world2?.debug.streetLights.count?4:2,slicer=createTextureSlicer(renderer),shadowPrograms=createShadowProgramWarmer(renderer),lightSync=new THREE.Object3D();
  const gpuWarmup=createGpuWarmup({
    states:lampStates(),
    upload:(t,urgent)=>{
      if(!(t.image?.width>0)||t.image?.complete===false)return 'wait';
      // A streamed prop's texture: the filtering pass above settles its final quality once the model is in the scene.
      const af=Math.min(anisotropy,settings.anisotropy,perfOn('filterPolicy')?4:16);
      if(!filtered.has(t)){filtered.set(t,af);t.anisotropy=af;t.needsUpdate=true;}
      if(!perfOn('slicedUpload')){renderer.initTexture(t);return 'done';}
      return slicer.upload(t,urgent);
    },
    compile:(object,state)=>{
      const light=flashlight.light,was=light.visible;light.visible=state%2===1;
      const unlit=state>=2?world2?.debug.streetLights.warm():undefined;
      try{renderer.compile(object,camera,scene);if(perfOn('shadowWarmup'))shadowPrograms.compile(object,camera,scene);}finally{
        unlit?.();light.visible=was;
        // compile() leaves the scene's light setup as it was for this light state, and three.js (r180) draws the next frame's shadow
        // maps before that frame sets its lights up again: without this the shadow pass would build depth programs for street lamps
        // and a torch that are off, the very stall this warm-up is for. An empty object only gathers the lights.
        if(perfOn('shadowWarmup'))renderer.compile(lightSync,camera,scene);
      }
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
    lives(){return{...lives,grab:grab?{...grab}:undefined};},
    /** Raise the torch without fetching it from the bench. */
    equipTorch(){flashlight.devEquip();},
    /** Where its face is, for aiming the torch at it. */
    creatureHead(){return encounters.headPosition(new THREE.Vector3()).toArray();},
    /** Be taken now, as if it had reached you. */
    die(){beginGrab();},
    creatureStep(dt:number,time:number,speed:number){return encounters.previewStep(dt,time,speed);},
    setRatio(r:number){diagnosticRatio=r;pixelRatio=r;renderer.setPixelRatio(r);resize();},
    graphics(){const gl=renderer.getContext();return{timer:!!gl.getExtension('EXT_disjoint_timer_query_webgl2'),version:gl.getParameter(gl.VERSION),size:renderer.getDrawingBufferSize(new THREE.Vector2()).toArray(),memory:renderer.info.memory,anisotropy:Math.min(anisotropy,settings.anisotropy),settings:{...settings,bindings:undefined},shadowSize:sunShadow.size,antialias:settings.aa,pacing:'requestAnimationFrame'};},
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
    setTime(t:number){elapsed=Math.max(0,t);hours=(16+t/60)%24;},
    setHours(h:number){hours=((h%24)+24)%24;},
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
      handles(){return{renderer,scene,sun,camera,THREE};},
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
      /** What the sun's shadow pass would draw right now: casters inside the shadow camera's frustum. */
      shadowList(){sun.shadow.updateMatrices(sun);return drawList(scene,camera,sun.shadow.camera);},
      /** Of the instances the sun's shadow pass submits, how many reach the shadow frustum. */
      shadowCulling(){sun.shadow.updateMatrices(sun);return shadowInstanceCulling(scene,camera,sun.shadow.camera);},
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
  const warmupTotal=()=>perfOn('lampWarmup')&&world2?.debug.streetLights.count?4:2;
  function warmupRender(darkness:number){
    // Draw the rig and its depth material with every light configuration while
    // the loading veil still covers the canvas. A compile alone would leave
    // skin buffers, bone textures, and texture uploads to the first encounter.
    if(warmupDraws===0){forest.warmupTextures(renderer);if(perfOn('streamWarmup'))uploadSceneTextures();if(perfOn('slicedUpload'))slicer.prime();}
    const light=flashlight.light,wasVisible=creature.visible,beamWasVisible=light.visible;
    const listener=scene.getObjectByName('The Listener'),listenerWasVisible=listener?.visible;
    if(listener)listener.visible=true;
    creature.visible=true;light.visible=warmupDraws%2===1;
    const unlit=warmupDraws>=2?world2?.debug.streetLights.warm():undefined;
    renderer.shadowMap.needsUpdate=true;sun.shadow.needsUpdate=true;light.shadow.needsUpdate=light.visible;
    try{atmosphere.render(elapsed,darkness);}finally{
      unlit?.();creature.visible=wasVisible;if(listener)listener.visible=!!listenerWasVisible;light.visible=beamWasVisible;shadowDirty=true;
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
    const rawDelta=Math.min(frameDuration/1000,.1);last=now;
    if(benchmarking)return;
    if(document.hidden)return;
    if(!loading&&admin.open){admin.update(now);return;}
    const dt=Math.min(rawDelta,.04);
    frameAverage=frameAverage*.98+rawDelta*1000*.02;
    // One complete, continuous day every 24 active minutes; test tools can accelerate it.
    const active=isActive(),simulate=active;
    if(simulate){elapsed+=dt;hours=(hours+dt*cycleSpeed/60)%24;}
    if(grab){
      if(simulate)grab.t+=dt;
      const g=grabTimeline(grab.t);
      if(g.respawn&&!grab.respawned){grab.respawned=true;wake(now);}
      blackout.style.opacity=String(g.black);card.style.opacity=String(g.card);
      if(g.done){grab=undefined;blackout.style.opacity=card.style.opacity='0';}
    }
    const skyState=sky.update(hours,player,elapsed),darkness=skyState.darkness;
    // For shaders that work out light themselves (the ground's relief shadows, terrain.ts).
    scene.userData.sunDirection=skyState.sunDirection;
    diagnostic.darkness=darkness;diagnostic.elapsed=elapsed;
    if(probe)probe.marks.sky=performance.now();
    // Taken: no walking away.
    const directionZ=grab?0:(held('forward')?1:0)-(held('back')?1:0)-touchMove.y;
    const directionX=grab?0:(held('right')?1:0)-(held('left')?1:0)+touchMove.x;
    const crouch=!grab&&!flying&&!world2?.climbing&&held('crouch');
    // Asked to sprint: the key, or on touch a firm push on the stick. Whether the player really sprints is up to the stamina model
    // (game/sim/player/stamina.ts): it needs breath, movement and no crouching, flying or ladder, and it drives speed, field of view, noise and breathing.
    const hurry=!grab&&((touchMove.lengthSq()>0&&touchPushed)||held('sprint'));
    const run=stamina.update(active?dt:0,hurry&&!crouch&&!flying&&!wasClimbing,lastSpeed);
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
    if(simulate&&!swimming&&!airborne&&!flying&&!climb&&!grab&&speed>.25&&!(world2&&inWater)){
      stride+=speed*dt;
      if(stride>.82){
        stride%=.82;
        const surface:FootSurface=inWater?'water':(WORLD_V2?roadDistance(player.x,player.z)<ROAD.footstep:Math.abs(player.z-roadZ(player.x))<2.7)?'road':offTrail<.25?'forest':'dirt';
        const loudness=footstepLoudness({speed,sprinting:run.sprinting,crouching:crouch,surface})*(world2?.indoors(player)?.5:1);
        if(loudness>0)noise.emit({type:'noise',loudness,source:'footstep',x:player.x,z:player.z});
      }
    }
    // Past a jog the stride rate grows slowly: at a full sprint the head bobs a few times a second, not seven.
    walkingPhase+=(Math.min(speed,3.4)+Math.max(0,speed-3.4)*.25)*dt*(crouch?2.7:3.7);
    cameraHeight=THREE.MathUtils.damp(cameraHeight,crouch&&!swimming?1.05:1.69,7,dt);
    const motion=flying||swimming||airborne?0:THREE.MathUtils.clamp(speed/1.8,0,1);
    const bob=Math.sin(walkingPhase*2)*.017*motion;
    const breath=Math.sin(now*.0013)*.0028;
    camera.position.set(player.x,player.y+cameraHeight+bob+breath+(climb?.bob??0),player.z);
    // Being taken: the head is wrenched round to its face, and shaken.
    let jolt=0;
    if(grab&&!grab.respawned){
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
    camera.rotation.set(THREE.MathUtils.lerp(-1.18,pitch,awakening)+Math.sin(walkingPhase)*.0018*motion+jolt*.5,yaw,Math.cos(walkingPhase)*.003*motion+jolt,'YXZ');
    // The settings' field of view eases in as before; sprinting adds a few degrees on top, eased by the stamina model's own blend.
    // The projection matrix is rebuilt only on a frame where the value really changed.
    baseFov=Math.abs(baseFov-settings.fov)<.001?settings.fov:THREE.MathUtils.damp(baseFov,settings.fov,2,dt);
    const targetFov=baseFov+sprintFov(run.blend);
    if(camera.fov!==targetFov){camera.fov=targetFov;camera.updateProjectionMatrix();}
    staminaHud.update({allowed:active&&!grab&&!flying,value:run.value,exhausted:run.exhausted});
    camera.getWorldDirection(forward);
    const startTerrain=performance.now(),terrainChanged=terrain.update(elapsed,player,darkness),startForest=performance.now(),forestChanged=forest.update(elapsed,player),endForest=performance.now();
    if(probe){const m=probe.marks;m.terrain0=startTerrain;m.forest0=startForest;m.forest1=endForest;}
    const storyChanged=story.update(player);
    const worldChanged=world2?world2.update({dt,time:elapsed,player,darkness,active:active&&!grab,simulate}):false;
    if(objectiveHud&&world2)objectiveHud.update({now,allowed:active&&!grab,text:objectiveText(world2.objectiveState,heldKind(world2.objectiveState,world2.localPlayer),{dropKey:coarse?undefined:keyLabel(settings.bindings.drop)})});
    if(probe)probe.marks.world1=performance.now();
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
    const shadowMoved=sunShadow.update(player,skyState.sunDirection);
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
    const drawSun=darkness<.975&&sunDirty&&(castersChanged||!sun.shadow.map||cycleSpeed>1||(now-lastSunDraw>=sunGap&&(settings.shadowRate===0||now-lastSunDraw>=1000/settings.shadowRate)));
    sun.shadow.needsUpdate=drawSun;
    if(drawSun){lastSunDraw=now;sunDirty=false;}
    flashlight.updateShadow(castersChanged||animatedCaster);
    renderer.shadowMap.needsUpdate=drawSun||flashlight.light.shadow.needsUpdate;
    shadowDirty=false;
    if(probe)probe.marks.shadow1=performance.now();
    audio.update(dt,{position:camera.position,direction:forward,speed:active&&!airborne&&!flying&&!climb&&!swimming?speed:0,sprinting:active&&run.sprinting,stamina:run.value,winded:run.exhausted,darkness,surface:inWater?'water':world2?.indoors(player)?'wood':(WORLD_V2?roadDistance(player.x,player.z)<ROAD.footstep:Math.abs(player.z-roadZ(player.x))<2.7)?'road':'dirt',riverDistance:waterDistance});
    if(probe)probe.marks.audio1=performance.now();
    renderer.info.reset();
    if(texturesDirty){filterTextures();texturesDirty=false;}
    // While the veil is up the queue is emptied without pauses, so nothing near the start is half built when it lifts.
    const warming=loading&&perfOn('streamWarmup')?gpuWarmup.drain(24):0;
    const startRender=performance.now(),loadingQuiet=loading&&pendingAssets===0&&now-lastAsset>900&&frame>8&&warming===0;
    if(probe){probe.marks.render0=startRender;probe.beginRender();}
    perfOverlay.setVisible(settings.perfOverlay);perfOverlay.beginGpu();
    if(loadingQuiet&&warmupDraws<warmupTotal())warmupRender(darkness);
    else{
      atmosphere.render(elapsed,darkness);
      if(loadingQuiet&&(!warmupFence||gl.clientWaitSync(warmupFence,0,0)!==gl.TIMEOUT_EXPIRED)){
        if(warmupFence){gl.deleteSync(warmupFence);warmupFence=null;}
        loading=false;loadCompleteAt=now;
      }
    }
    perfOverlay.endGpu();
    if(probe)probe.marks.render1=performance.now();
    if(!loading&&veil.isConnected){veil.style.opacity=String(1-THREE.MathUtils.smoothstep((now-loadCompleteAt)/1000,0,2.8));if(now-loadCompleteAt>3300)veil.remove();}
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
  raf=requestAnimationFrame(animate);
  return ()=>{
    disposed=true;veil.remove();if(warmupFence)gl.deleteSync(warmupFence);manager.onStart=oldStart;manager.onLoad=oldLoad;manager.onProgress=oldProgress;cancelAnimationFrame(raf);if(document.pointerLockElement===renderer.domElement)document.exitPointerLock();
    window.removeEventListener('mouseup',mouseUp);window.removeEventListener('mousemove',mouseMove);window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);densityQuery?.removeEventListener('change',densityChanged);window.removeEventListener('orientationchange',clearInput);
    document.removeEventListener('pointerlockchange',lockChange);document.removeEventListener('pointerlockerror',lockError);document.removeEventListener('visibilitychange',visibilityChange);
    renderer.domElement.removeEventListener('mousedown',mouseDown);renderer.domElement.removeEventListener('touchstart',touchStart);renderer.domElement.removeEventListener('touchmove',touchUpdate);renderer.domElement.removeEventListener('touchend',touchEnd);renderer.domElement.removeEventListener('touchcancel',touchEnd);
    unsubscribeNoise();blackout.remove();objectiveHud?.dispose();staminaHud.dispose();world2?.dispose();admin.dispose();slicer.dispose();perfOverlay.dispose();flashlight.dispose();sun.shadow.dispose();sky.dispose();audio.dispose();encounters.dispose();forest.dispose();story.dispose();terrain.dispose();atmosphere.dispose();
    scene.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();const mats=Array.isArray(object.material)?object.material:[object.material];for(const mat of mats){for(const v of Object.values(mat))if(v instanceof THREE.Texture)v.dispose();mat.dispose();}}});
    renderer.dispose();renderer.domElement.remove();
  };
}
