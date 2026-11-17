import { channelOffset, treeDensity } from '../../sim/world/world-noise';
import * as THREE from 'three';
import type { FarShadow } from '../world/far-shadow';
import type { createCollisionWorld } from '../../sim/world/collision';
import type { createFlashlight } from './flashlight';
import { createPois } from './pois';
import { createDoors } from './doors';
import { doorTestPlacements } from '../../dev/door-test';
import { createInteraction } from './interaction';
import { createObjectivesRuntime } from './objectives-runtime';
import { createPartGlint } from './part-glint';
import { createContainers } from './containers';
import { createLandingPad } from './landing-pad';
import { createHelicopter } from './helicopter';
import { runPlacements, chestSite, PAD_ID, PAD_CRATE_ID, RELAY_CRATE_ID, CABIN_BOARD_ID } from './run-sites';
import { createBoardPanel } from '../../ui/board-panel';
import { createBoardMaps } from './board-map';
import { createEndingCard } from '../../ui/ending-card';
import { createRunAudio } from '../../audio/helicopter-audio';
import { worldColliders, type PoiAsset } from './pois';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { placeParts, partsToItems } from '../../sim/run/parts';
import { WORLD_SEED } from '../../sim/world/world-flags';
import { boardLines } from '../../sim/objectives/objective-text';
import { setPropRoom, patchInterior, dressProp } from './prop-materials';
import { initialState } from '../../sim/objectives/objectives';
import { createAmbientLife, type Roost } from '../world/ambient-life';
import { createLadderClimber, ladderAim, ladderReachable } from '../../sim/player/ladders';
import { POI_PLACEMENTS, SCATTER_PLACEMENTS, LAIR_ID, placeLocal } from '../../sim/world/world-layout';
import type { ObjectiveEvent, Slot } from '../../sim/objectives/objectives';
import { createPowerLines } from '../world/power-lines';
import { createWaterSplash } from '../world/water-splash';
import { createStreetLights } from '../world/street-lights';
import { riverSurfaceAt, waterHeightAt } from '../../sim/world/world';
import { NOISE } from '../../sim/noise/noise-scale';
import worldAssets from '../../data/world-assets.json';

export type WorldV2Options = {
  /** The name of the interact key as the player has bound it, for prompts such as "E to open". */
  interactKey?: () => string;
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; container: HTMLElement;
  heightAt: (x: number, z: number) => number;
  /** The island-wide sun shadow (far-shadow.ts), for the props past the sun's own map. */
  farShadow?: FarShadow;
  collisions: ReturnType<typeof createCollisionWorld>;
  flashlight: ReturnType<typeof createFlashlight>;
  /** Drawing-buffer height in pixels, for sizing point sprites. */
  viewHeight: () => number;
  riverX: (z: number) => number;
  /** 1 on trails, the road and the stream bank; 0 in dense forest. */
  exclusion: (x: number, z: number) => number;
  water?: { splash: (x: number, z: number, strength: number) => void };
  /** The player used the bed ("Sleep till dawn", the interact key). The engine decides whether the night allows it and says why not. */
  onSleep?: () => void;
  /**
   * The helicopter was boarded and the ending card is up: the run is won (engine: `gameRun.won()` and whatever a win does). Called once,
   * about five seconds after the boarding, when the screen has gone to black.
   */
  onEscaped?: () => void;
  /**
   * A machine started, moved or stopped (`at` undefined): the relay's and the pad's generators by id, and the helicopter while its
   * rotors turn. The engine makes them running sources the creature hears. Return true for a generator whose sound the caller plays.
   */
  onMachine?: (id: string, at: { x: number; y: number; z: number } | undefined, kind: 'generator' | 'helicopter') => boolean | void;
};
export type WorldV2Frame = { dt: number; time: number; player: THREE.Vector3; darkness: number; active: boolean; simulate: boolean };

const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export type NoiseEvent = Extract<ObjectiveEvent, { type: 'noise' }>;

/** A running generator is a standing lure: 150 m (the noise scale's generator row), kept up, every few seconds, from where it stands. */
export const GENERATOR_HUM = { loudness: NOISE.generator, every: 7, sustained: true };
/** A step into water: a splash is about 45 m on the noise scale, from a gentle wade (26 m) to a plunge (55 m). */
export const splashLoudness = (strength: number) => .2 + strength * .35;
// Buildings a player can be inside. Footprints include steps and porches, so they are shrunk to the walls.
const ROOFED = new Set(['cabin', 'hut', 'chapel', 'mine']), INSIDE = .85;
const roofed = POI_PLACEMENTS.filter(p => ROOFED.has(p.asset) && p.footprint);
/** Inside one of the roofed buildings: the inverse of placeLocal against each footprint. */
export function indoorsAt(x: number, z: number) {
  for (const p of roofed) {
    const f = p.footprint!, c = Math.cos(p.yaw), s = Math.sin(p.yaw), dx = x - p.x, dz = z - p.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx - f.cx) < f.hx * INSIDE && Math.abs(lz - f.cz) < f.hz * INSIDE) return true;
  }
  return false;
}
/**
 * The way out of the roofed building around a point: where its door is and which way is out (a unit vector), or
 * undefined outside. The creature waits in view of it for a player who has shut themselves in.
 */
export function doorAt(x: number, z: number) {
  for (const p of roofed) {
    const f = p.footprint!, c = Math.cos(p.yaw), s = Math.sin(p.yaw), dx = x - p.x, dz = z - p.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    if (Math.abs(lx - f.cx) >= f.hx * INSIDE || Math.abs(lz - f.cz) >= f.hz * INSIDE) continue;
    const [ex, ez] = p.entrance ?? [f.cx, f.cz + f.hz + 1];
    const [doorX, doorZ] = placeLocal(p, ex, ez), [midX, midZ] = placeLocal(p, f.cx, f.cz);
    const out = Math.hypot(doorX - midX, doorZ - midZ) || 1;
    return { id: p.id, x: doorX, z: doorZ, outX: (doorX - midX) / out, outZ: (doorZ - midZ) / out };
  }
  return undefined;
}
/**
 * The cabin's bed, from the bed collider in world-assets.json (the cabin's own model frame): where it is in the world, and where a
 * player stands beside it, on its long side (.55 m clear of it, past the table), facing the middle of the room. The bed is the
 * run's home: the player wakes here, and sleeps here.
 */
export function bedPlan() {
  const cabin = POI_PLACEMENTS.find(p => p.id === 'cabin');
  type Box = { tag?: string; x: number; z: number; halfX: number; halfZ: number; maxY: number };
  const def = (worldAssets as unknown as Record<string, { colliders?: Box[]; rooms?: { min: number[]; max: number[] }[] }>).cabin;
  const bed = def?.colliders?.find(c => c.tag === 'bed'), room = def?.rooms?.[0];
  if (!cabin || !bed) return undefined;
  const mid = room ? [(room.min[0] + room.max[0]) / 2, (room.min[2] + room.max[2]) / 2] : [0, 0];
  const alongX = bed.halfX >= bed.halfZ;
  const side = (alongX ? Math.sign(mid[1] - bed.z) : Math.sign(mid[0] - bed.x)) || 1;
  const [standX, standZ] = placeLocal(cabin, alongX ? bed.x : bed.x + side * (bed.halfX + .55), alongX ? bed.z + side * (bed.halfZ + .55) : bed.z);
  const [bedX, bedZ] = placeLocal(cabin, bed.x, bed.z), [midX, midZ] = placeLocal(cabin, mid[0], mid[1]);
  return { x: bedX, z: bedZ, top: bed.maxY, stand: { x: standX, z: standZ, yaw: Math.atan2(-(midX - standX), -(midZ - standZ)) } };
}
/** Where the player wakes each dawn: standing by the bed, facing into the room (the cabin door if the model has no bed). */
export function bedWakePoint() { return bedPlan()?.stand ?? cabinWakePoint(); }
/** Where a caught player wakes: on the ground just out from the cabin door, facing it. */
export function cabinWakePoint() {
  const cabin = POI_PLACEMENTS.find(p => p.id === 'cabin');
  if (!cabin?.entrance) return undefined;
  const [x, z] = placeLocal(cabin, cabin.entrance[0], cabin.entrance[1] + 1.4);
  return { x, z, yaw: Math.atan2(-(cabin.x - x), -(cabin.z - z)) };
}

/**
 * Everything the rebuilt world adds, composed in one place so game/core/engine.ts only has to create it,
 * forward input, call update() and dispose(). The engine builds this only when WORLD_V2 is set.
 */
export function createWorldV2(o: WorldV2Options) {
  // The engine owns registration: colliders go in now, before any GLB has loaded, and again whenever the version moves.
  const doorTest = doorTestPlacements(o.heightAt); // dev only: `?door-test` adds a pump house to try the doors on
  const pois = createPois(o.scene, o.heightAt, undefined, { placements: [...POI_PLACEMENTS, ...runPlacements(), ...doorTest], farShadow: o.farShadow,
    pixelAngle: () => 2 * Math.tan(THREE.MathUtils.degToRad(o.camera.fov) / 2) / Math.max(1, o.viewHeight()) });
  // Buildings and props shade the land past the sun's own map too: a cabin's or the bridge's shadow does not stop where that map
  // does. Something crossing its draw distance redraws the island's map, at most once a second (a depth pass of the island).
  o.farShadow?.addCasterRoot(pois.root);
  let farStale = false, farDrawn = -Infinity;
  const powerLines = createPowerLines(o.scene, o.heightAt);
  // Lamps along the road come on at dusk (game/render/world/street-lights.ts); none of them exist until the layout places `streetlight-*`.
  const partGlint = createPartGlint({ scene: o.scene, camera: o.camera, collisions: o.collisions, heightAt: o.heightAt, // parts lying out twinkle in the torch's sweep
    locate: it => it.at ? { x: it.at.x, y: it.at.y ?? o.heightAt(it.at.x, it.at.z), z: it.at.z } : it.hook && it.poiId ? pois.hook(it.poiId, it.hook) : undefined });
  const streetLights = createStreetLights({ scene: o.scene, pois, placements: SCATTER_PLACEMENTS });
  const spray = createWaterSplash(o.scene, (x, z) => { const y = riverSurfaceAt(x, z); return y ?? waterHeightAt(z) - 9; });
  let wet = false, wetDistance = 0, lastX = 0, lastZ = 0, lastT = 0, humIn = GENERATOR_HUM.every;
  o.collisions.replace('pois', pois.solidColliders);
  let poisVersion = pois.collisionVersion;
  let player: THREE.Vector3 | undefined;
  const interaction = createInteraction(o.container, o.camera, o.collisions, { keyLabel: o.interactKey });
  const forward = new THREE.Vector3();

  // The torch rests on the cabin's bench, and picking it up is now an interaction like any other.
  const bench = pois.hook('cabin', 'bench');
  if (bench) o.flashlight.setSeat(bench); else console.warn('SILENCE: cabin has no "bench" hook; the flashlight stays at its old seat.');
  const unregisterTorch = interaction.register({
    id: 'flashlight', position: new THREE.Vector3().fromArray(o.flashlight.inspect().pickupPosition), label: 'Left click to pick up',
    enabled: () => o.flashlight.available && !o.flashlight.owned, activate: () => { o.flashlight.pickUp(); },
  });

  // The run's parts, laid by the seed (game/sim/run/parts.ts): each on its place's hook or on the ground beside the place.
  const layout = placeParts(POI_PLACEMENTS, { seed: WORLD_SEED, lairId: LAIR_ID });
  const audio = createRunAudio();
  audio.onMachine(o.onMachine);
  const objectives = createObjectivesRuntime({ scene: o.scene, camera: o.camera, heightAt: o.heightAt, pois, interaction, newState: () => initialState(partsToItems(layout)) });
  const seats = new Map(pois.seats().map(q => [q.id, q]));
  // The cabin's room: pickups and the door leaf inside it take its dim sky and its lantern's light (prop-materials.ts).
  {
    const seat = pois.seats().find(q => q.id === 'cabin'), room = seat?.def.rooms?.[0];
    if (seat && room) {
      const s = seat.placement.scale ?? 1, at = new THREE.Matrix4().compose(new THREE.Vector3(seat.placement.x, seat.ground, seat.placement.z),
        seat.quaternion ?? new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, seat.placement.yaw), new THREE.Vector3(s, s, s));
      setPropRoom(at.invert(), room.min, room.max, room.lamp ? pois.hook('cabin', room.lamp) : undefined);
    }
  }

  // Doors (game/render/props/doors.ts): every `doors` entry of a placed asset becomes a hinged leaf with its own collider and prompt. Opening or shutting one is a
  // small noise for the creature, from its handle. Without any `doors` in world-assets.json this is empty and does nothing.
  const doors = createDoors({ pois, collisions: o.collisions, interaction, barrable: placement => placement === 'cabin', indoors: (x, z) => indoorsAt(x, z),
    onNoise: e => objectives.emit({ type: 'noise', loudness: e.loudness, source: 'door', x: e.x, z: e.z }) });
  // The bed: look at it and the interact key sleeps till dawn, if the engine says the night allows it.
  const bed = bedPlan(), bedSeat = pois.seats().find(q => q.id === 'cabin');
  const unregisterBed = bed && o.onSleep ? interaction.register({
    id: 'bed', position: new THREE.Vector3(bed.x, (bedSeat?.ground ?? o.heightAt(bed.x, bed.z)) + bed.top + .1, bed.z), range: 2.6, label: 'Left click to sleep till dawn', keyOnly: true,
    enabled: () => true, activate: () => { o.onSleep?.(); },
  }) : undefined;


  // --- the run's places: chest, crates, the board, the landing pad and the helicopter ------------------------------------------
  // The cabin's chest: a crate on the cabin's floor (a chest model is still to come), in the room's light, with its collider.
  const chest = chestSite(o.heightAt), crateDef = (worldAssets as unknown as Record<string, PoiAsset>).crate;
  let chestObject: THREE.Object3D | undefined;
  if (chest && crateDef) {
    const placement = { id: 'cabin-chest', asset: 'crate', x: chest.x, z: chest.z, yaw: chest.yaw };
    o.collisions.replace('run-props', worldColliders(crateDef, placement, chest.y).map(c => ({ ...c, tag: 'chest' })));
    void new GLTFLoader().loadAsync(crateDef.url).then(async gltf => {
      if (disposedWorld) return;
      await dressProp(gltf.scene);
      gltf.scene.traverse(x => { if (x instanceof THREE.Mesh) { x.castShadow = true; x.receiveShadow = true; for (const m of Array.isArray(x.material) ? x.material : [x.material]) if (m instanceof THREE.MeshStandardMaterial) patchInterior(m); } });
      gltf.scene.name = 'Cabin chest'; gltf.scene.position.set(chest.x, chest.y, chest.z); gltf.scene.rotation.y = chest.yaw; o.scene.add(gltf.scene); chestObject = gltf.scene;
    }, () => { console.warn('SILENCE: the chest (crate.glb) could not load.'); });
  } else console.warn('SILENCE: no cabin or crate model: there is no chest.');
  const crateSite = (id: string, bank: 'relay' | 'pad') => { const s = seats.get(id); return s ? { bank, lid: new THREE.Vector3(s.placement.x, s.ground + .86, s.placement.z), front: new THREE.Vector3(s.placement.x, s.ground + .4, s.placement.z) } : undefined; };
  const sites: Parameters<typeof createContainers>[0]['sites'] = {};
  if (chest) sites.chest = { lid: new THREE.Vector3(chest.x, chest.y + .86, chest.z), front: new THREE.Vector3(chest.x, chest.y + .4, chest.z) };
  for (const c of [crateSite(RELAY_CRATE_ID, 'relay'), crateSite(PAD_CRATE_ID, 'pad')]) if (c) sites[c.bank] = c;
  const containers = createContainers({ interaction, state: () => objectives.state, dispatch: objectives.dispatch, me: objectives.localPlayer, sites });

  // The board at the cabin lists the helicopter's parts (objective-text.ts boardLines); read it with the interact key.
  const interactCode = () => { const k = o.interactKey?.() ?? 'E'; return /^[A-Za-z]$/.test(k) ? `Key${k.toUpperCase()}` : 'KeyE'; };
  // The map on both boards is this run's own layout, hung over the baked poster (board-map.ts), and the board panel shows it too.
  const boardMaps = createBoardMaps({ pois, boards: [CABIN_BOARD_ID, 'trailhead-board'], ringBoard: CABIN_BOARD_ID, items: () => objectives.state.items });
  const boardPanel = createBoardPanel(o.container, { map: () => boardMaps.canvas(), lines: () => boardLines(objectives.state), closeKeys: () => [interactCode(), 'KeyE', 'Escape'] });
  const boardSeat = seats.get(CABIN_BOARD_ID), boardAt = boardSeat ? new THREE.Vector3(boardSeat.placement.x, boardSeat.ground + 1.65, boardSeat.placement.z) : undefined;
  const unregisterBoard = boardAt ? interaction.register({ id: 'board', position: boardAt, range: 3, label: 'Left click to read the board', enabled: () => !boardPanel.isOpen, activate: () => { boardPanel.open(); } }) : undefined;

  // The landing pad (its slab is the layout's 'landing-pad'; its generator and crate are ours): bulbs, cable, fuel and lights, and the helicopter.
  const padSeat = seats.get(PAD_ID);
  const landingPad = padSeat ? createLandingPad({ scene: o.scene, heightAt: o.heightAt, pois, interaction, state: () => objectives.state, dispatch: objectives.dispatch, me: objectives.localPlayer, audio }) : undefined;
  const ending = createEndingCard(o.container);
  const helicopter = padSeat ? createHelicopter({
    scene: o.scene, pad: { x: padSeat.placement.x, z: padSeat.placement.z, yaw: padSeat.placement.yaw, top: padSeat.ground + .18 }, state: () => objectives.state, dispatch: objectives.dispatch, me: objectives.localPlayer,
    interaction, collisions: o.collisions, audio, onBoard: () => { boardPanel.close(); ending.play(() => o.onEscaped?.()); },
  }) : undefined;
  if (!padSeat) console.warn('SILENCE: the layout has no landing pad; there is no way off the island.');
  let disposedWorld = false;
  const relayGenerator = pois.hook('relay-generator', 'pullcord');

  // Ladders (game/sim/player/ladders.ts): the prompt appears within a metre of the line while looking at it; attached, the climber
  // replaces normal movement (see climb()) and nothing is collided with, so a ladder's own rails and plinth cannot stop it.
  const climber = createLadderClimber(), LADDER_NOISE = NOISE.ladderRung, LADDER_AIM_RANGE = 2;
  const aims = pois.ladders.map(l => new THREE.Vector3(l.top.x, l.top.y, l.top.z));
  const unregisterLadders = pois.ladders.map((ladder, i) => interaction.register({
    id: `ladder:${ladder.id}`, position: aims[i], label: 'Left click to climb', seeThrough: true,
    enabled: () => !climber.attached && !!player && ladderReachable(ladder, player),
    activate: () => { if (player) climber.attach(ladder, player); },
  }));

  const touchAction = o.container.ownerDocument.createElement('button');
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  touchAction.hidden = true;
  touchAction.style.cssText = 'position:absolute;right:18px;bottom:max(24px,env(safe-area-inset-bottom));z-index:21;border:1px solid #ffffff50;background:#101713b0;color:#dcd8c9;padding:12px 18px;font:13px system-ui;touch-action:manipulation';
  for (const type of ['pointerdown','pointerup','touchstart','touchend','mousedown','mouseup']) touchAction.addEventListener(type, e => e.stopPropagation());
  touchAction.onclick = e => {
    e.stopPropagation();
    if (climber.attached) climber.release();
    else if (player) { o.camera.getWorldDirection(forward); objectives.dropHeld(player, forward); }
  };
  o.container.appendChild(touchAction);

  // Crows (game/render/world/ambient-life.ts). The cabin's ridge is the one roost with something to sit on in view: twelve
  // places along its cap (4.63 m up in the model, tools/assets/world-v2/models_cabin.py), a bird astride it facing one slope
  // or the other. Every other landmark lends its name to the densest stand of trees within 60 m of it, where the flock rests
  // 18 m up in the crowns and is not drawn; landmarks nearer than 40 m to one already taken share it. An authored `roost`
  // hook would be a single perch.
  const roosts: Roost[] = [];
  const cabinSeat = pois.seats().find(q => q.id === 'cabin');
  if (cabinSeat) {
    const s = cabinSeat.placement.scale ?? 1, q = cabinSeat.quaternion ?? new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, cabinSeat.placement.yaw);
    const place = new THREE.Matrix4().compose(new THREE.Vector3(cabinSeat.placement.x, cabinSeat.ground, cabinSeat.placement.z), q, new THREE.Vector3(s, s, s));
    const across = new THREE.Vector3(0, 0, 1).applyQuaternion(q), yaw = Math.atan2(across.x, across.z), p = new THREE.Vector3();
    const perches = Array.from({ length: 12 }, (_, k) => { p.set(-2.9 + k * 5.9 / 11, 4.63, 0).applyMatrix4(place); return { x: p.x, y: p.y, z: p.z, yaw: yaw + (k % 3 === 1 ? Math.PI : 0) }; });
    p.set(0, 4.63, 0).applyMatrix4(place);
    roosts.push({ x: p.x, y: p.y, z: p.z, perches });
  }
  for (const pl of POI_PLACEMENTS) {
    if (pl.id === 'cabin') continue;
    const hook = pois.hook(pl.id, 'roost');
    if (hook) { roosts.push({ x: hook.x, y: hook.y, z: hook.z, perches: [{ x: hook.x, y: hook.y, z: hook.z, yaw: pl.yaw }] }); continue; }
    // Trees stand where exclusion is under .42 (sim/world/placement.ts), thicker where treeDensity is high.
    let bx = 0, bz = 0, best = .3;
    for (const r of [14, 24, 36, 48, 60]) for (let a = 0; a < 12; a++) {
      const x = pl.x + Math.cos(a * Math.PI / 6 + r) * r, z = pl.z + Math.sin(a * Math.PI / 6 + r) * r;
      const score = Math.max(0, 1 - o.exclusion(x, z) / .42) * treeDensity(x, z);
      if (score > best + .02) { best = score; bx = x; bz = z; }
    }
    if (best <= .3 || roosts.some(q => Math.hypot(q.x - bx, q.z - bz) < 40)) continue;
    roosts.push({ x: bx, y: o.heightAt(bx, bz) + 18, z: bz, hidden: true });
  }
  const ambient = createAmbientLife(o.scene, {
    roosts, chimney: pois.hook('cabin', 'chimney'), heightAt: o.heightAt,
    // A real crown to leave from or drop into, once the forest round there has been streamed in (within 94 m of the player).
    canopy: (x, z, radius, pick) => {
      const trees = o.collisions.nearby(x, z, radius).filter(c => c.tag === 'tree' && c.kind === 'capsule' && c.crownBase !== undefined && Math.hypot(c.ax - x, c.az - z) < radius);
      const t = trees[Math.floor(pick * trees.length)];
      return t?.kind === 'capsule' && t.crownBase !== undefined ? { x: t.ax, y: t.crownBase + (t.maxY - t.crownBase) * .3, z: t.az } : undefined;
    },
    // The flock goes up in silence: there are no birdcalls in this world.
    onBurst: () => {},
  });

  return {
    /**
     * Left click, tap or E: run whatever the player is looking at. False means nothing was there.
     * On a ladder only the key (`fromKey`) lets go; a click falls through to the torch as before.
     */
    activate(fromKey = false) {
      if (climber.attached) { if (fromKey) climber.release(); return fromKey; }
      return interaction.activate(fromKey);
    },
    /** True while on a ladder. */
    get climbing() { return climber.attached; },
    /** What the objective HUD reads: the objective state, and which player is "me" in it. */
    get objectiveState() { return objectives.state; },
    get localPlayer() { return objectives.localPlayer; },
    /** Space: let go of the ladder, dropping to whatever is beneath. False if not on one (or topping out). */
    letGo: () => climber.release() !== undefined,
    /**
     * Call each frame before moving the player. While on a ladder this is where the player is, held on the line with
     * no gravity or strafing, and the engine should skip its own movement; `bob` is added to the camera height.
     * Undefined means walk as usual. Each rung passed knocks and makes a `noise` event for the creature.
     */
    climb(f: { dt: number; forward: number; player: THREE.Vector3; enabled?: boolean }) {
      if (!climber.attached) return undefined;
      if (f.enabled === false) { climber.release(); return undefined; }
      const step = climber.update(f.dt, { forward: f.forward }, f.player);
      if (!step) return undefined;
      if (step.rungs > 0) {
        for (let i = 0; i < Math.min(step.rungs, 3); i++) objectives.emit({ type: 'noise', loudness: LADDER_NOISE, source: 'ladder', x: step.x, z: step.z });
      }
      return step;
    },
    /** Q: put down what is in hand; or, from the inventory, what is in a backpack slot. */
    drop(slot: Slot = 'hand') { if (!player) return false; o.camera.getWorldDirection(forward); return objectives.dropHeld(player, forward, slot); },
    /** The inventory panel's view of the hand and the backpack, and its rearranging. */
    inventory: () => objectives.inventory(),
    moveItem: (from: Slot, to: Slot) => objectives.move(from, to),
    /**
     * The one stream of sounds the creature hears: the objectives' own noises (pickups, the generator, the radio),
     * ladder rungs and splashes from here, and whatever the engine adds (footsteps, the torch switch).
     */
    noise: {
      emit(event: NoiseEvent) { objectives.emit(event); },
      subscribe(listener: (event: NoiseEvent) => void) { return objectives.subscribe(e => { if (e.type === 'noise') listener(e); }); },
    },
    /** Inside the cabin, the relay hut, the chapel or the mine. */
    indoors: (p: { x: number; z: number }) => indoorsAt(p.x, p.z),
    /** Where the player wakes each dawn: by the bed, facing into the cabin. */
    wakePoint: bedWakePoint,
    /** Just outside the cabin door, facing it: where the Listener stands when it comes to the door. */
    doorPoint: cabinWakePoint,
    /** The run's clock in absolute game hours, for the objectives' helicopter and pad lights (objectives-runtime time()). */
    time: (hours: number, now = false) => objectives.time(hours, now),
    /** Whether the bar lies across the cabin's door (the bed will not be slept in otherwise). */
    cabinDoorBarred: () => doors.isBarred('cabin'),
    /** A restarted night: every objective back where it began, nobody on a ladder. */
    restart() { climber.release(); objectives.reset(); humIn = GENERATOR_HUM.every; doors.reset(); helicopter?.reset(); ending.reset(); boardPanel.close(); },
    /** Returns true when shadow casters changed. */
    update(f: WorldV2Frame) {
      player = f.player;
      // Water breaks where a foot enters it, and in time with the stride from then on.
      const dx = f.player.x - lastX, dz = f.player.z - lastZ, moved = Math.hypot(dx, dz), elapsed = Math.max(f.time - lastT, 1e-3);
      lastX = f.player.x; lastZ = f.player.z; lastT = f.time;
      const level = riverSurfaceAt(f.player.x, f.player.z), inWater = level !== undefined && f.player.y < level + .08 && moved < 2;
      if (inWater && level !== undefined && moved > 0) {
        const speed = Math.min(moved / elapsed, 4), depth = Math.min(1, Math.max(0, (level - f.player.y) / .5));
        wetDistance += moved;
        if (!wet || wetDistance > (speed > 2.4 ? 1.25 : .95)) {
          const strength = Math.min(1, (wet ? .18 : .55) + speed * .16 + depth * .22);
          wetDistance = 0;
          o.water?.splash(f.player.x, f.player.z, strength);
          spray.burst(f.player.x, level, f.player.z, strength, dx / Math.max(moved, 1e-3), dz / Math.max(moved, 1e-3));
          objectives.emit({ type: 'noise', loudness: splashLoudness(strength), source: 'water', x: f.player.x, z: f.player.z });
        }
      } else wetDistance = 0;
      wet = inWater;
      // Without an engine to tell (a test, the playtest bot), the generator is heard as a kept-up noise every few seconds instead.
      if (!o.onMachine && objectives.state.generator.running && f.simulate && (humIn -= f.dt) <= 0) {
        humIn = GENERATOR_HUM.every;
        objectives.emit({ type: 'noise', loudness: GENERATOR_HUM.loudness, source: 'generator', poi: 'generator', sustained: GENERATOR_HUM.sustained });
      }
      spray.update(f.simulate ? f.dt : 0, f.darkness, o.viewHeight());
      let changed = pois.update(f.player);
      if (changed) farStale = true;
      if (farStale && o.farShadow && f.time - farDrawn > 1) { o.farShadow.invalidate(); farStale = false; farDrawn = f.time; }
      if (doors.update({ dt: f.simulate ? f.dt : 0, player: f.player })) changed = true;
      if (pois.collisionVersion !== poisVersion) { poisVersion = pois.collisionVersion; o.collisions.replace('pois', pois.solidColliders); }
      if (objectives.update(f.time)) changed = true;
      o.camera.getWorldDirection(forward);
      // The prompt aims at the part of the line the player is looking along, wherever on it that is.
      if (!climber.attached) for (let i = 0; i < aims.length; i++) {
        const ladder = pois.ladders[i];
        if (ladderReachable(ladder, f.player)) { const a = ladderAim(ladder, o.camera.position, forward, LADDER_AIM_RANGE); aims[i].set(a.x, a.y, a.z); }
      }
      interaction.update(f.active);
      // The run's machines: the pad's lamps and its generator, the helicopter, the relay's generator hum; the board closes if the player walks off.
      const dtSim = f.simulate ? f.dt : 0;
      landingPad?.update(dtSim, f.time, f.player); helicopter?.update(dtSim, f.time);
      audio.setHum('relay', objectives.state.generator.running ? relayGenerator : undefined, .5);
      audio.update(f.dt, { position: o.camera.position, forward }, f.active);
      boardMaps.update(f.time);
      if (boardAt) boardPanel.update(Math.hypot(boardAt.x - f.player.x, boardAt.z - f.player.z));
      const carried = objectives.state.carrying[objectives.localPlayer];
      touchAction.hidden = !coarse || !f.active || (!climber.attached && !carried);
      touchAction.textContent = climber.attached ? 'Leave ladder' : 'Drop';
      ambient.update({ time: f.time, dt: f.simulate ? f.dt : 0, player: f.player, darkness: f.darkness, viewScale: .5 * o.viewHeight() * o.camera.projectionMatrix.elements[5], view: forward });
      streetLights.update({ dt: f.simulate ? f.dt : 0, time: f.time, player: f.player, darkness: f.darkness });
      partGlint.update({ dt: f.dt, time: f.time, darkness: f.darkness, torchOn: o.flashlight.active, viewScale: .5 * o.viewHeight() * o.camera.projectionMatrix.elements[5], items: objectives.state.items });
      return changed;
    },
    /** Dev stage, exposed by the engine as window.__WORLD__ under import.meta.env.DEV. */
    debug: {
      get state() { return objectives.state; },
      dispatch: objectives.dispatch, reset: () => { objectives.reset(); helicopter?.reset(); ending.reset(); },
      /** Where the seed put each part this run (a part on a hook or on the ground beside its place) and what became of it. */
      parts: () => Object.entries(objectives.state.items).map(([id, item]) => {
        const at = item.status === 'world' ? (item.at ? { x: item.at.x, z: item.at.z } : item.hook && item.poiId ? pois.hook(item.poiId, item.hook) : undefined) : undefined;
        return { id, kind: item.kind, place: item.poiId ?? item.poi, hook: item.hook, status: item.status, bank: item.bank, x: at ? +at.x.toFixed(1) : undefined, z: at ? +at.z.toFixed(1) : undefined };
      }),
      /** Put the player beside a part (an id from parts()): uses window.__SILENCE__.teleport. Returns where, or undefined. */
      teleportToPart(id: string) {
        const p = this.parts().find(q => q.id === id);
        if (!p || p.x === undefined || p.z === undefined) return undefined;
        (globalThis as unknown as { __SILENCE__?: { teleport?: (x: number, z: number) => void } }).__SILENCE__?.teleport?.(p.x + 1.4, p.z + 1.4);
        return { x: p.x, z: p.z };
      },
      /** Put a part in the hand (or the pack) as if picked up, wherever it is. False when the hands are full or it is not lying about. */
      give(id: string) { return objectives.dispatch({ type: 'pickup', player: objectives.localPlayer, item: id }).some(e => e.type === 'picked-up'); },
      /** Everything the pad needs, fitted and lit: for looking at it. */
      lightPad() {
        const s = objectives.state; objectives.setState({ ...s, pad: { bulbs: true, cable: true, fuel: 1.5, lit: true }, items: Object.fromEntries(Object.entries(s.items).map(([k, v]) => [k, v.part === 'pad-bulbs' || v.part === 'pad-cable' || v.part === 'pad-fuel' ? { ...v, status: 'used' as const } : v])) });
      },
      /** The helicopter comes now: called, due in a moment; with `lit` the pad is lit first, so it lands. It circles a dark pad for a quarter of a game hour. */
      summonHelicopter(lit = false) {
        if (lit) this.lightPad();
        const s = objectives.state;
        objectives.setState({ ...s, signalBy: objectives.localPlayer, phase: 'signalSent', helicopter: { status: 'inbound', arrives: s.clock + .05, until: null, calls: s.helicopter.calls + 1 } });
        helicopter?.force('sea');
      },
      helicopter, landingPad, containers, boardPanel, runAudio: audio,
      /** Teleport spots for the run's places: the pad, the board, the chest, the crates. */
      sites: () => ({ pad: padSeat ? { x: padSeat.placement.x, z: padSeat.placement.z } : undefined, board: boardAt, chest, relayCrate: sites.relay?.lid, padCrate: sites.pad?.lid }),
      pois, objectives, interaction, ambient, hook: pois.hook, climber, ladders: pois.ladders, doors, streetLights,
      /** Frighten the flock as if the player had reached its roost. */
      startleCrows: () => ambient.startle(),
    },
    dispose() {
      disposedWorld = true; unregisterBoard?.(); boardPanel.dispose(); boardMaps.dispose(); containers.dispose(); landingPad?.dispose(); helicopter?.dispose(); ending.dispose(); audio.dispose(); if (chestObject) o.scene.remove(chestObject); o.collisions.replace('run-props', []);
      touchAction.remove(); spray.dispose(); powerLines.dispose(); streetLights.dispose(); partGlint.dispose(); unregisterTorch(); unregisterBed?.(); unregisterLadders.forEach(u => u()); doors.dispose(); objectives.dispose(); ambient.dispose(); interaction.dispose(); o.farShadow?.removeCasterRoot(pois.root); pois.dispose(); o.collisions.replace('pois', []);
    },
  };
}

export type WorldV2 = ReturnType<typeof createWorldV2>;
