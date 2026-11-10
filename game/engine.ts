import * as THREE from 'three';
import { WORLD_V2, WORLD_SEED } from './world-flags';
import { createWorldV2, doorAt } from './world-v2';
import { channelOffset } from './world-noise';
import {readSettings,type Action} from './settings';
import { createTerrain, heightAt, exclusion, riverX, roadZ, pathX } from './terrain';
import { createForest } from './forest';
import { createAtmosphere } from './atmosphere';
import { ForestAudio } from './audio';
import { createEncounters } from './encounters';
import { createStory } from './story';
import { createStableSunShadow } from './shadows';
import { createRenderBudget } from './quality';
import { createCollisionWorld, moveCharacter, characterSupportAt } from './collision';
import { createAdmin } from './admin';
import { createSky } from './sky';
import { biomeAt, riverSurfaceAt, WORLD_DESTINATIONS } from './world';
import { createFlashlight } from './flashlight';
import { createTapTracker } from './tap';
import type { EncounterView } from './encounter-visibility';
import { footstepLoudness, FLASHLIGHT_CLICK_LOUDNESS, type FootSurface, type NoiseEvent as CreatureNoise } from './creature-brain';
import type { CreatureSenses, CreatureMode } from './encounters';
import type { ObjectiveEvent } from './objectives';
import { POI_PLACEMENTS } from './world-layout';
import { initialLives, loseLife, respawnHours, deathCard, grabTimeline, NIGHT_START_HOURS, type DeathOutcome } from './lives';

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
  const renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance',alpha:false});
  const renderBudget=createRenderBudget(window.devicePixelRatio);
  let pixelRatio=renderBudget.resize(window.innerWidth,window.innerHeight);
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
  const sunShadow=createStableSunShadow(sun,renderer.capabilities.maxTextureSize);
  scene.add(sun,sun.target);
  const sky=createSky(renderer,scene,sun,hemi);
  const player=new THREE.Vector3(pathX(12),heightAt(pathX(12),12),12);
  const terrain=createTerrain(scene,player);
  const forest=createForest(scene,heightAt,exclusion,player);
  const story=createStory(scene,heightAt);
  const collisions=createCollisionWorld();
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
  const world2=WORLD_V2?createWorldV2({scene,camera,container,heightAt,collisions,flashlight,water:terrain.water,viewHeight:()=>renderer.domElement.height,riverX,exclusion}):undefined;
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
    wokeAt=now;shadowDirty=true;
  }
  /** What the creature is told about the player each frame, beyond where they are. */
  const senses=(dt:number,crouch:boolean,hurry:boolean,inWater:boolean,climbing:boolean):CreatureSenses=>({
    // A teleport is not a velocity.
    ...(Math.hypot(player.x-lastFoot.x,player.z-lastFoot.z)>dt*12?{vx:0,vz:0}:{vx:(player.x-lastFoot.x)/Math.max(dt,.001),vz:(player.z-lastFoot.z)/Math.max(dt,.001)}),
    sprinting:hurry&&!crouch,crouching:crouch,flashlightOn:flashlight.active,inWater,onLadder:climbing,
    indoors:world2?.indoors(player)??false,untouchable:flying||!!grab,blackout:!!grab&&grabTimeline(grab.t).black>=1,
  });
  let hours=16,cycleSpeed=1,flying=false;
  let started=false,disposed=false,raf=0,last=performance.now(),frameAverage=16.67;
  let drag=false,mouseX=0,mouseY=0;
  let fixedQuality=settings.quality!=='auto',profileUntil=0,benchmarking=false;
  let diagnosticRatio:number|undefined;
  let shadowDirty=true,sunDirty=true,lastSunDraw=-Infinity;
  let warmupDraws=0,warmupFence:WebGLSync|null=null;
  const gl=renderer.getContext() as WebGL2RenderingContext;
  const profileRows:{frame:number,update:number,forest:number,terrain:number,encounter:number,submit:number,calls:number,triangles:number,sunShadow:boolean,creature:boolean}[]=[];
  const coarse=matchMedia('(pointer: coarse)').matches;
  const touches=new Map<number,{x:number,y:number,startX:number,startY:number,side:'move'|'look'}>();
  const touchMove=new THREE.Vector2();
  const temp=new THREE.Vector3();
  const isActive=()=>!loading && started && !document.hidden && document.hasFocus() && !admin.open;

  const held=(action:Action)=>keys.has(settings.bindings[action])||(settings.bindings[action]==='ShiftLeft'&&keys.has('ShiftRight'))||(settings.bindings[action]==='ControlLeft'&&keys.has('ControlRight'));
  const start=(touch=false)=>{
    if(admin.open)return;
    started=true;
    void audio.start();
    void audio.resume();
    renderer.domElement.focus({preventScroll:true});
    if(!touch && !coarse && document.pointerLockElement!==renderer.domElement){
      try { const result=renderer.domElement.requestPointerLock(); if(result instanceof Promise) result.catch(()=>{}); } catch { /* Drag controls remain available inside embedded browsers. */ }
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
    if(e.code===settings.bindings.rise&&!e.repeat&&isActive()&&!grab)world2?.letGo();
    if(e.code===settings.bindings.drop&&!e.repeat&&isActive()&&!grab&&world2?.drop())shadowDirty=true;
    if(e.code===settings.bindings.fullscreen && started && !e.repeat){
      if(!document.fullscreenElement)void container.requestFullscreen?.().catch(()=>{});
      else void document.exitFullscreen();
    }
    if(!started && [settings.bindings.forward,settings.bindings.back,settings.bindings.left,settings.bindings.right].includes(e.code))start();
  };
  const keyUp=(e:KeyboardEvent)=>keys.delete(e.code);
  const blur=()=>{mouseTap.cancel();touchTap.cancel();touchTapId=undefined;renderBudget.pause();started=false;keys.clear();velocity.set(0,0,0);drag=false;touchMove.set(0,0);touches.clear();void audio.suspend();};
  const lockChange=()=>{if(document.pointerLockElement!==renderer.domElement){if(started&&!admin.open)admin.show();started=false;keys.clear();velocity.set(0,0,0);void audio.suspend();}else void audio.resume();};
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
      touches.set(t.identifier,{x:t.clientX,y:t.clientY,startX:t.clientX,startY:t.clientY,side});
    }
  };
  const touchUpdate=(e:TouchEvent)=>{
    e.preventDefault();
    for(const t of Array.from(e.changedTouches)){
      const old=touches.get(t.identifier);if(!old)continue;
      if(t.identifier===touchTapId)touchTap.move(Math.hypot(t.clientX-old.x,t.clientY-old.y));
      if(old.side==='look'){const sensitivity=2.2*settings.sensitivity/Math.min(container.clientWidth,container.clientHeight);yaw-=(t.clientX-old.x)*sensitivity;pitch=THREE.MathUtils.clamp(pitch-(t.clientY-old.y)*sensitivity,-1.28,1.32);}
      else{touchMove.set(t.clientX-old.startX,t.clientY-old.startY);if(touchMove.length()<7)touchMove.set(0,0);else touchMove.normalize();}
      old.x=t.clientX;old.y=t.clientY;
    }
  };
  const touchEnd=(e:TouchEvent)=>{lastTouch=performance.now();for(const t of Array.from(e.changedTouches)){if(t.identifier===touchTapId){if(e.type==='touchend'&&isActive()&&touchTap.end(performance.now())&&interact())shadowDirty=true;touchTap.cancel();touchTapId=undefined;}if(touches.get(t.identifier)?.side==='move')touchMove.set(0,0);touches.delete(t.identifier);}};
  const rendererSize=new THREE.Vector2();
  const resize=()=>{
    const w=Math.max(1,container.clientWidth),h=Math.max(1,container.clientHeight),adaptive=settings.quality==='auto'?renderBudget.inspect().scale:1;
    const scale=settings.renderScale/100*adaptive;
    const base=Math.min(window.devicePixelRatio,1.4,Math.sqrt(2_000_000/Math.max(1,w*h)));
    if(diagnosticRatio!==undefined)pixelRatio=diagnosticRatio;else if(!fixedQuality)pixelRatio=renderBudget.resize(w,h,window.devicePixelRatio)*settings.renderScale/100;else pixelRatio=base*scale;
    scene.userData.graphicsAnisotropy=settings.anisotropy;scene.userData.graphicsWaterDetail=settings.waterDetail;scene.userData.graphicsAA=settings.aa;scene.userData.graphicsFog=settings.fog*adaptive;
    renderer.getSize(rendererSize);if(rendererSize.x!==w||rendererSize.y!==h||renderer.getPixelRatio()!==pixelRatio)renderer.setDrawingBufferSize(w,h,pixelRatio);camera.aspect=w/h;camera.updateProjectionMatrix();
    atmosphere.resize(w,h,pixelRatio,adaptive);terrain.water.setQuality(adaptive,settings.reflections,settings.waterDetail);
    shadowDirty=sunShadow.setQuality(adaptive,settings.shadows)||shadowDirty;
  };
  renderer.domElement.addEventListener('mousedown',mouseDown);
  window.addEventListener('mouseup',mouseUp);window.addEventListener('mousemove',mouseMove);
  window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);
  window.addEventListener('blur',blur);window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);window.addEventListener('orientationchange',blur);
  document.addEventListener('pointerlockchange',lockChange);document.addEventListener('visibilitychange',blur);
  renderer.domElement.addEventListener('touchstart',touchStart,{passive:false});
  renderer.domElement.addEventListener('touchmove',touchUpdate,{passive:false});
  renderer.domElement.addEventListener('touchend',touchEnd);renderer.domElement.addEventListener('touchcancel',touchEnd);
  const teleport=(x:number,z:number)=>{player.set(x,heightAt(x,z)+(flying?5:0),z);velocity.set(0,0,0);};
  const admin=createAdmin(container,{
    settings,volumeChanged:()=>audio.setVolumes(settings),listening:(on)=>audio.listen(on),settingsChanged:()=>{try{localStorage.setItem('silence-settings',JSON.stringify(settings));}catch{}diagnosticRatio=undefined;fixedQuality=settings.quality!=='auto';renderBudget.pause();resize();filterTextures();},
    getState:()=>({hours,cycleSpeed,flying,position:player.toArray(),fps:Math.round(1000/frameAverage),solids:collisions.stats().solids}),
    setHours:(h)=>{hours=((h%24)+24)%24;},setSpeed:(speed)=>{cycleSpeed=speed;},
    setFlying:(value)=>{flying=value;velocity.set(0,0,0);if(!flying)player.y=characterSupportAt(player.x,player.z,player.y,heightAt,collisions);},
    spawn:(mode)=>{camera.getWorldDirection(forward);encounters.spawn(player,forward,mode);},dismiss:()=>{encounters.dismiss(elapsed);shadowDirty=true;},teleport,
    visibility:(open)=>{keys.clear();velocity.set(0,0,0);drag=false;touches.clear();touchMove.set(0,0);mouseTap.cancel();touchTap.cancel();renderBudget.pause();if(open){started=false;document.exitPointerLock();void audio.suspend();}else start();},
  });
  resize();
  let frame=0;
  const filtered=new WeakMap<THREE.Texture,number>(),anisotropy=renderer.capabilities.getMaxAnisotropy();
  function filterTextures(){scene.traverse(o=>{if(!(o instanceof THREE.Mesh))return;for(const material of Array.isArray(o.material)?o.material:[o.material])for(const value of Object.values(material))if(value instanceof THREE.Texture&&!value.isRenderTargetTexture&&value.image?.width>0&&value.image?.complete!==false&&filtered.get(value)!==Math.min(anisotropy,settings.anisotropy)){const af=Math.min(anisotropy,settings.anisotropy);filtered.set(value,af);value.anisotropy=af;value.needsUpdate=true;}});}
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
    setRatio(r:number){diagnosticRatio=r;fixedQuality=true;pixelRatio=r;renderer.setPixelRatio(r);resize();},
    adaptiveQuality(){return renderBudget.inspect();},
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
    /** Run one whole engine frame now (sky, forest and colliders, drawing): a hidden tab may not run frames at all. */
    snap(){last=performance.now()-16;animate(performance.now());return camera.position.toArray();},
  };
  if(import.meta.env.DEV)(window as unknown as {__SILENCE__:typeof diagnostic}).__SILENCE__=diagnostic;

  if(import.meta.env.DEV&&world2)(window as unknown as {__WORLD__:typeof world2.debug}).__WORLD__=world2.debug;
  // Dev-only creature review stage: open the game with ?spider-lab.
  let spiderLab:Awaited<ReturnType<typeof import('./spider-lab')['createSpiderLab']>>|undefined;
  if(import.meta.env.DEV&&new URLSearchParams(location.search).has('spider-lab'))void import('./spider-lab').then(m=>{
    spiderLab=m.createSpiderLab({scene,camera,heightAt,world:collisions,setHours:h=>{hours=h;},teleport,equip:()=>{flashlight.devEquip();},markShadows:()=>{shadowDirty=true;},darkness:()=>diagnostic.darkness});
    (window as unknown as {__SPIDER__:typeof spiderLab}).__SPIDER__=spiderLab;
  });

  function warmupRender(darkness:number){
    // Draw the rig and its depth material with both light configurations while
    // the loading veil still covers the canvas. A compile alone would leave
    // skin buffers, bone textures, and texture uploads to the first encounter.
    if(warmupDraws===0)forest.warmupTextures(renderer);
    const light=flashlight.light,wasVisible=creature.visible,beamWasVisible=light.visible;
    creature.visible=true;light.visible=warmupDraws===1;
    renderer.shadowMap.needsUpdate=true;sun.shadow.needsUpdate=true;light.shadow.needsUpdate=light.visible;
    try{atmosphere.render(elapsed,darkness);}finally{
      creature.visible=wasVisible;light.visible=beamWasVisible;shadowDirty=true;
    }
    if(++warmupDraws===2){warmupFence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);gl.flush();}
  }

  function animate(now:number){
    if(disposed)return;
    raf=requestAnimationFrame(animate);
    const frameDuration=now-last,startCPU=performance.now();
    const rawDelta=Math.min(frameDuration/1000,.1);last=now;
    if(benchmarking)return;
    if(document.hidden)return;
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
    diagnostic.darkness=darkness;diagnostic.elapsed=elapsed;
    // Taken: no walking away.
    const directionZ=grab?0:(held('forward')?1:0)-(held('back')?1:0)-touchMove.y;
    const directionX=grab?0:(held('right')?1:0)-(held('left')?1:0)+touchMove.x;
    const crouch=!grab&&!flying&&!world2?.climbing&&held('crouch');
    const hurry=!grab&&(touchMove.lengthSq()>0||held('sprint'));
    const waterDistance=WORLD_V2?channelOffset(player.x,player.z):Math.abs(player.x-riverX(player.z));
    let moveSpeed=crouch?.95:hurry?3.35:1.8;
    const waterY=riverSurfaceAt(player.x,player.z);
    const inWater=waterY!==undefined&&player.y<waterY+.10;
    if(inWater)moveSpeed*=.55;
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
    if(climb){player.set(climb.x,climb.y,climb.z);velocity.set(0,0,0);}
    else if(flying)player.addScaledVector(velocity,dt);
    else{
      const next=moveCharacter(player,velocity.x*dt,velocity.z*dt,crouch?1.05:1.69,heightAt,collisions);
      player.x=next.x;player.z=next.z;player.y=THREE.MathUtils.damp(player.y,next.y,18,dt);
    }
    const speed=climb?0:Math.hypot(player.x-oldX,player.z-oldZ)/Math.max(dt,.001);
    // Every footfall goes into the creature's noise stream, as loud as the gait and the ground make it. Wading
    // is left to the rebuilt world's splashes, which are already in the stream.
    if(simulate&&!flying&&!climb&&!grab&&speed>.25&&!(world2&&inWater)){
      stride+=speed*dt;
      if(stride>.82){
        stride%=.82;
        const surface:FootSurface=inWater?'water':Math.abs(player.z-roadZ(player.x))<2.7?'road':offTrail<.25?'forest':'dirt';
        const loudness=footstepLoudness({speed,sprinting:hurry&&!crouch,crouching:crouch,surface})*(world2?.indoors(player)?.5:1);
        if(loudness>0)noise.emit({type:'noise',loudness,source:'footstep',x:player.x,z:player.z});
      }
    }
    walkingPhase+=speed*dt*(crouch?2.7:3.7);
    cameraHeight=THREE.MathUtils.damp(cameraHeight,crouch?1.05:1.69,7,dt);
    const motion=flying?0:THREE.MathUtils.clamp(speed/1.8,0,1);
    const bob=Math.sin(walkingPhase*2)*.017*motion;
    const breath=Math.sin(now*.0013)*.0028;
    camera.position.set(player.x,player.y+cameraHeight+bob+breath+(climb?.bob??0),player.z);
    // Being taken: the head is wrenched round to its face, and shaken.
    let jolt=0;
    if(grab&&!grab.respawned){
      encounters.headPosition(head);
      const dx=head.x-camera.position.x,dy=head.y-camera.position.y,dz=head.z-camera.position.z,toward=Math.atan2(-dx,-dz),k=1-Math.exp(-dt*(grab.t<.35?16:9));
      yaw+=Math.atan2(Math.sin(toward-yaw),Math.cos(toward-yaw))*k;
      pitch+=(THREE.MathUtils.clamp(Math.atan2(dy,Math.hypot(dx,dz)),-1.28,1.32)-pitch)*k;
      jolt=Math.sin(grab.t*47)*.035*(1-THREE.MathUtils.smoothstep(grab.t,.2,1));
    }
    // Eyes open slowly, after loading and after waking at the cabin.
    const awakening=loading?0:Math.min(THREE.MathUtils.smoothstep((now-loadCompleteAt)/1000,0,3.2),THREE.MathUtils.smoothstep((now-wokeAt)/1000,0,3.2));
    camera.rotation.set(THREE.MathUtils.lerp(-1.18,pitch,awakening)+Math.sin(walkingPhase)*.0018*motion+jolt*.5,yaw,Math.cos(walkingPhase)*.003*motion+jolt,'YXZ');
    const targetFov=settings.fov+(hurry&&speed>2?2:0);
    if(camera.fov!==targetFov){
      const fov=THREE.MathUtils.damp(camera.fov,targetFov,2,dt);
      camera.fov=Math.abs(fov-targetFov)<.001?targetFov:fov;camera.updateProjectionMatrix();
    }
    camera.getWorldDirection(forward);
    const startTerrain=performance.now(),terrainChanged=terrain.update(elapsed,player,darkness),startForest=performance.now(),forestChanged=forest.update(elapsed,player),endForest=performance.now();
    const storyChanged=story.update(player);
    const worldChanged=world2?world2.update({dt,time:elapsed,player,darkness,active:active&&!grab,simulate}):false;
    const creatureWasVisible=creature.visible;
    if(forest.collisionVersion!==forestCollisionVersion){forestCollisionVersion=forest.collisionVersion;collisions.replace('forest',forest.solidColliders);}
    if(terrain.collisionVersion!==terrainCollisionVersion){terrainCollisionVersion=terrain.collisionVersion;collisions.replace('terrain',terrain.solidColliders);}
    const profile=import.meta.env.DEV&&now<profileUntil;
    const startEncounter=profile?performance.now():0;
    if(import.meta.env.DEV&&spiderLab&&!loading)spiderLab.update(rawDelta);
    if(simulate){
      encounters.update(dt,elapsed,player,forward,darkness,hours,senses(dt,crouch,hurry,inWater,!!climb));lastFoot.copy(player);
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
    flashlight.update(elapsed,speed);
    const shadowMoved=sunShadow.update(player,skyState.sunDirection);
    const castersChanged=shadowDirty||terrainChanged||forestChanged||storyChanged||worldChanged||creatureWasVisible!==creature.visible;
    const animatedCaster=simulate&&creature.visible;
    sunDirty||=castersChanged||shadowMoved||animatedCaster;
    // At normal cycle speed a 30 Hz depth refresh moves the shadows less than
    // a texel for most of the day. Keep fast admin scrubbing and low sun smooth.
    const drawSun=darkness<.975&&sunDirty&&(castersChanged||!sun.shadow.map||cycleSpeed>1||skyState.sunElevation<.18||settings.shadowRate===0||now-lastSunDraw>=1000/settings.shadowRate);
    sun.shadow.needsUpdate=drawSun;
    if(drawSun){lastSunDraw=now;sunDirty=false;}
    flashlight.updateShadow(castersChanged||animatedCaster);
    renderer.shadowMap.needsUpdate=drawSun||flashlight.light.shadow.needsUpdate;
    shadowDirty=false;
    audio.update(dt,{position:camera.position,direction:forward,speed:active?speed:0,sprinting:active&&hurry&&!flying&&!crouch,darkness,surface:inWater?'water':Math.abs(player.z-roadZ(player.x))<2.7?'road':'dirt',riverDistance:waterDistance});
    renderer.info.reset();
    if(texturesDirty){filterTextures();texturesDirty=false;}
    const startRender=performance.now(),loadingQuiet=loading&&pendingAssets===0&&now-lastAsset>900&&frame>8;
    if(loadingQuiet&&warmupDraws<2)warmupRender(darkness);
    else{
      atmosphere.render(elapsed,darkness);
      if(loadingQuiet&&(!warmupFence||gl.clientWaitSync(warmupFence,0,0)!==gl.TIMEOUT_EXPIRED)){
        if(warmupFence){gl.deleteSync(warmupFence);warmupFence=null;}
        loading=false;loadCompleteAt=now;renderBudget.pause();
      }
    }
    if(!loading&&veil.isConnected){veil.style.opacity=String(1-THREE.MathUtils.smoothstep((now-loadCompleteAt)/1000,0,2.8));if(now-loadCompleteAt>3300)veil.remove();}
    if(profile)profileRows.push({frame:frameDuration,update:startRender-startCPU,forest:endForest-startForest,terrain:startForest-startTerrain,encounter:encounterCost,submit:performance.now()-startRender,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,sunShadow:drawSun,creature:creature.visible});
    frame++;admin.update(now);
    if(active&&!fixedQuality){const ratio=renderBudget.update(frameDuration,now);if(ratio!==undefined){pixelRatio=ratio;resize();}}
    if(frame%120===0){
      diagnostic.elapsed=elapsed;diagnostic.darkness=darkness;diagnostic.fps=Math.round(1000/frameAverage);diagnostic.active=active;
      diagnostic.drawCalls=renderer.info.render.calls;diagnostic.triangles=renderer.info.render.triangles;
    }
  }
  raf=requestAnimationFrame(animate);
  return ()=>{
    disposed=true;veil.remove();if(warmupFence)gl.deleteSync(warmupFence);manager.onStart=oldStart;manager.onLoad=oldLoad;manager.onProgress=oldProgress;cancelAnimationFrame(raf);if(document.pointerLockElement===renderer.domElement)document.exitPointerLock();
    window.removeEventListener('mouseup',mouseUp);window.removeEventListener('mousemove',mouseMove);window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);window.removeEventListener('orientationchange',blur);
    document.removeEventListener('pointerlockchange',lockChange);document.removeEventListener('visibilitychange',blur);
    renderer.domElement.removeEventListener('mousedown',mouseDown);renderer.domElement.removeEventListener('touchstart',touchStart);renderer.domElement.removeEventListener('touchmove',touchUpdate);renderer.domElement.removeEventListener('touchend',touchEnd);renderer.domElement.removeEventListener('touchcancel',touchEnd);
    unsubscribeNoise();blackout.remove();world2?.dispose();admin.dispose();flashlight.dispose();sun.shadow.dispose();sky.dispose();audio.dispose();encounters.dispose();forest.dispose();story.dispose();terrain.dispose();atmosphere.dispose();
    scene.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.dispose();const mats=Array.isArray(object.material)?object.material:[object.material];for(const mat of mats){for(const v of Object.values(mat))if(v instanceof THREE.Texture)v.dispose();mat.dispose();}}});
    renderer.dispose();renderer.domElement.remove();
  };
}
