import { channelOffset } from './world-noise';
import * as THREE from 'three';
import type { createCollisionWorld } from './collision';
import type { createFlashlight } from './flashlight';
import { createPois } from './pois';
import { createInteraction } from './interaction';
import { createObjectivesRuntime } from './objectives-runtime';
import { initialState } from './objectives';
import { createAmbientLife } from './ambient-life';
import { createLadderClimber, ladderAim, ladderReachable } from './ladders';
import { POI_PLACEMENTS, placeLocal } from './world-layout';
import type { ObjectiveEvent } from './objectives';
import { createPowerLines } from './power-lines';
import { createWaterSplash } from './water-splash';
import { riverSurfaceAt, waterHeightAt } from './world';

export type WorldV2Options = {
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
 * Everything the rebuilt world adds, composed in one place so game/engine.ts only has to create it,
 * forward input, call update() and dispose(). The engine builds this only when WORLD_V2 is set.
 */
export function createWorldV2(o: WorldV2Options) {
  // The engine owns registration: colliders go in now, before any GLB has loaded, and again whenever the version moves.
  const pois = createPois(o.scene, o.heightAt);
  const powerLines = createPowerLines(o.scene, o.heightAt);
  const spray = createWaterSplash(o.scene, (x, z) => { const y = riverSurfaceAt(x, z); return y ?? waterHeightAt(z) - 9; });
  let wet = false, wetDistance = 0, lastX = 0, lastZ = 0, lastT = 0, humIn = GENERATOR_HUM.every;
  o.collisions.replace('pois', pois.solidColliders);
  let poisVersion = pois.collisionVersion;
  let player: THREE.Vector3 | undefined;
  const interaction = createInteraction(o.container, o.camera, o.collisions);
  const forward = new THREE.Vector3();

  // The torch rests on the cabin's bench, and picking it up is now an interaction like any other.
  const bench = pois.hook('cabin', 'bench');
  if (bench) o.flashlight.setSeat(bench); else console.warn('SILENCE: cabin has no "bench" hook; the flashlight stays at its old seat.');
  const unregisterTorch = interaction.register({
    id: 'flashlight', position: new THREE.Vector3().fromArray(o.flashlight.inspect().pickupPosition), label: 'Left click to pick up',
    enabled: () => !o.flashlight.owned, activate: () => { o.flashlight.pickUp(); },
  });

  const objectives = createObjectivesRuntime({ scene: o.scene, camera: o.camera, heightAt: o.heightAt, pois, interaction });

  // Ladders (game/ladders.ts): the prompt appears within a metre of the line while looking at it; attached, the climber
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

  // A roost is an authored `roost` hook, else the chimney, else somewhere up in the canopy over the landmark.
  const roosts = POI_PLACEMENTS.map(p => {
    const hook = pois.hook(p.id, 'roost') ?? pois.hook(p.id, 'chimney');
    return hook ? { x: hook.x, y: hook.y, z: hook.z } : { x: p.x, y: o.heightAt(p.x, p.z) + 12, z: p.z, hidden: true };
  });
  const ambient = createAmbientLife(o.scene, {
    roosts, chimney: pois.hook('cabin', 'chimney'), heightAt: o.heightAt,
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
      return interaction.activate();
    },
    /** True while on a ladder. */
    get climbing() { return climber.attached; },
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
    /** Q: put down what is in hand. */
    drop() { if (!player) return false; o.camera.getWorldDirection(forward); return objectives.dropHeld(player, forward); },
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
    restart() { climber.release(); objectives.setState(initialState()); humIn = GENERATOR_HUM.every; },
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
      ambient.update({ time: f.time, dt: f.simulate ? f.dt : 0, player: f.player, darkness: f.darkness, viewScale: .5 * o.viewHeight() * o.camera.projectionMatrix.elements[5] });
      return changed;
    },
    /** Dev stage, exposed by the engine as window.__WORLD__ under import.meta.env.DEV. */
    debug: {
      get state() { return objectives.state; },
      dispatch: objectives.dispatch, reset: () => objectives.setState(initialState()),
      pois, objectives, interaction, ambient, hook: pois.hook, climber, ladders: pois.ladders,
      /** Frighten the flock as if the player had reached its roost. */
      startleCrows: (time = 0) => ambient.startle(time),
    },
    dispose() {
      touchAction.remove(); spray.dispose(); powerLines.dispose(); unregisterTorch(); unregisterLadders.forEach(u => u()); objectives.dispose(); ambient.dispose(); interaction.dispose(); pois.dispose(); o.collisions.replace('pois', []);
    },
  };
}

export type WorldV2 = ReturnType<typeof createWorldV2>;
