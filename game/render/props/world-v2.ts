import { channelOffset, treeDensity } from '../../sim/world/world-noise';
import * as THREE from 'three';
import type { createCollisionWorld } from '../../sim/world/collision';
import type { createFlashlight } from './flashlight';
import { createPois } from './pois';
import { createDoors } from './doors';
import { doorTestPlacements } from '../../dev/door-test';
import { createInteraction } from './interaction';
import { createObjectivesRuntime } from './objectives-runtime';
import { setPropRoom } from './prop-materials';
import { initialState } from '../../sim/objectives/objectives';
import { createAmbientLife, type Roost } from '../world/ambient-life';
import { createLadderClimber, ladderAim, ladderReachable } from '../../sim/player/ladders';
import { POI_PLACEMENTS, SCATTER_PLACEMENTS, placeLocal } from '../../sim/world/world-layout';
import type { ObjectiveEvent, Slot } from '../../sim/objectives/objectives';
import { createPowerLines } from '../world/power-lines';
import { createWaterSplash } from '../world/water-splash';
import { createStreetLights } from '../world/street-lights';
import { riverSurfaceAt, waterHeightAt } from '../../sim/world/world';

export type WorldV2Options = {
  /** The name of the interact key as the player has bound it, for prompts such as "E to open". */
  interactKey?: () => string;
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; container: HTMLElement;
  heightAt: (x: number, z: number) => number;
  collisions: ReturnType<typeof createCollisionWorld>;
  flashlight: ReturnType<typeof createFlashlight>;
  /** Drawing-buffer height in pixels, for sizing point sprites. */
  viewHeight: () => number;
  riverX: (z: number) => number;
  /** 1 on trails, the road and the stream bank; 0 in dense forest. */
  exclusion: (x: number, z: number) => number;
  water?: { splash: (x: number, z: number, strength: number) => void };
};
export type WorldV2Frame = { dt: number; time: number; player: THREE.Vector3; darkness: number; active: boolean; simulate: boolean };

const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export type NoiseEvent = Extract<ObjectiveEvent, { type: 'noise' }>;

/** A running generator is a standing lure: this loud (about 50 m), every few seconds, from where it stands. */
export const GENERATOR_HUM = { loudness: .5, every: 7 };
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
  const pois = createPois(o.scene, o.heightAt, undefined, doorTest.length ? { placements: [...POI_PLACEMENTS, ...doorTest] } : {});
  const powerLines = createPowerLines(o.scene, o.heightAt);
  // Lamps along the road come on at dusk (game/render/world/street-lights.ts); none of them exist until the layout places `streetlight-*`.
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

  const objectives = createObjectivesRuntime({ scene: o.scene, camera: o.camera, heightAt: o.heightAt, pois, interaction });
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
  const doors = createDoors({ pois, collisions: o.collisions, interaction, onNoise: e => objectives.emit({ type: 'noise', loudness: e.loudness, source: 'door', x: e.x, z: e.z }) });

  // Ladders (game/sim/player/ladders.ts): the prompt appears within a metre of the line while looking at it; attached, the climber
  // replaces normal movement (see climb()) and nothing is collided with, so a ladder's own rails and plinth cannot stop it.
  const climber = createLadderClimber(), LADDER_NOISE = .07, LADDER_AIM_RANGE = 2;
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
    /** Where a caught player wakes. */
    wakePoint: cabinWakePoint,
    /** A restarted night: every objective back where it began, nobody on a ladder. */
    restart() { climber.release(); objectives.setState(initialState()); humIn = GENERATOR_HUM.every; doors.reset(); },
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
          objectives.emit({ type: 'noise', loudness: Math.min(1, .25 + strength * .6), source: 'water', x: f.player.x, z: f.player.z });
        }
      } else wetDistance = 0;
      wet = inWater;
      if (objectives.state.generator.running && f.simulate && (humIn -= f.dt) <= 0) {
        humIn = GENERATOR_HUM.every;
        objectives.emit({ type: 'noise', loudness: GENERATOR_HUM.loudness, source: 'generator', poi: 'generator' });
      }
      spray.update(f.simulate ? f.dt : 0, f.darkness, o.viewHeight());
      let changed = pois.update(f.player);
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
      const carried = objectives.state.carrying[objectives.localPlayer];
      touchAction.hidden = !coarse || !f.active || (!climber.attached && !carried);
      touchAction.textContent = climber.attached ? 'Leave ladder' : 'Drop';
      ambient.update({ time: f.time, dt: f.simulate ? f.dt : 0, player: f.player, darkness: f.darkness, viewScale: .5 * o.viewHeight() * o.camera.projectionMatrix.elements[5], view: forward });
      streetLights.update({ dt: f.simulate ? f.dt : 0, time: f.time, player: f.player, darkness: f.darkness });
      return changed;
    },
    /** Dev stage, exposed by the engine as window.__WORLD__ under import.meta.env.DEV. */
    debug: {
      get state() { return objectives.state; },
      dispatch: objectives.dispatch, reset: () => objectives.setState(initialState()),
      pois, objectives, interaction, ambient, hook: pois.hook, climber, ladders: pois.ladders, doors, streetLights,
      /** Frighten the flock as if the player had reached its roost. */
      startleCrows: () => ambient.startle(),
    },
    dispose() {
      touchAction.remove(); spray.dispose(); powerLines.dispose(); streetLights.dispose(); unregisterTorch(); unregisterLadders.forEach(u => u()); doors.dispose(); objectives.dispose(); ambient.dispose(); interaction.dispose(); pois.dispose(); o.collisions.replace('pois', []);
    },
  };
}

export type WorldV2 = ReturnType<typeof createWorldV2>;
