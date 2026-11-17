import * as THREE from 'three';
import { solidContact, type SolidCollider } from '../../sim/world/collision';
import type { Interactable } from './interaction';
import type { Pois, PoiSeat } from './pois';
import { doorLeafMaterial } from './prop-materials';
import { NOISE } from '../../sim/noise/noise-scale';

/**
 * A hinged door leaf, as an asset's `doors` entry in world-assets.json (written by the Blender pipeline).
 * `asset` names another entry: a GLB of just the leaf, its HINGE EDGE ON THE ORIGIN, running along local +x from 0 to `width`,
 * standing on y = 0, thickness centred on z = 0. Everything else is in the parent model's local frame, like `hooks`.
 */
export type DoorSpec = {
  asset: string;
  /** Where the hinge edge is, in the parent model's local frame. */
  hinge: readonly [number, number, number];
  /** The shut leaf's rotation.y in the parent's frame (three.js: local +x turns to (cos yaw, 0, -sin yaw)). */
  yaw: number;
  /** Radians added to `yaw` when fully open (signed). */
  swing: number;
  width: number; height: number; thickness?: number;
  /** How far open (0 shut .. 1 fully) at the start of a night. */
  start?: number;
};
/** The parts of a placement a door needs. A `Placement` is one. */
export type DoorBase = { x: number; z: number; yaw: number; scale?: number };
export type DoorBox = Extract<SolidCollider, { kind: 'box' }>;
export type DoorPose = {
  /** The hinge, in world metres. The leaf's object stands here. */
  position: THREE.Vector3;
  /** The leaf's rotation.y in the world. For a tilted parent this is the heading of its horizontal projection. */
  yaw: number;
  /** The leaf object's full world rotation: the parent's (yaw, or its tilt) then the leaf's own turn about its hinge. */
  quaternion: THREE.Quaternion;
  /** The leaf's uniform scale (the placement's). */
  scale: number;
  /** Unit vector along the leaf, hinge to free edge. */
  direction: THREE.Vector3;
  /** The free edge's foot, in world metres. */
  tip: THREE.Vector3;
  /** Where the prompt hangs: the handle side of the leaf, at hand height, on its midplane (so both faces reach it). */
  handle: THREE.Vector3;
  /** What stops the player: the leaf as a thin box. */
  collider: DoorBox;
};

/** Seconds a door takes to swing fully open or shut. */
export const DOOR_SECONDS = .7;
/** At most this open and a door counts as shut (see `closedAt`). */
export const DOOR_CLOSED = .03;
/** How far the Listener hears a door opened or shut, in hundreds of metres: 22 m either way (the noise scale's door row), faint at any range. */
export const DOOR_NOISE = { open: NOISE.door, close: NOISE.door, /** The Listener forcing a door or breaking its bar: a crash, 70 m. */ forced: NOISE.crateBreak };
/** A door forced swings open this much faster than a hand opens it. */
export const FORCED_SPEED = 4;
const THICKNESS = .05, COLLIDER_PAD = .03, HANDLE_HEIGHT = 1.05, HANDLE_FROM_EDGE = .12;
/**
 * The player's capsule as moveCharacter sees it (BODY_RADIUS), and a hand's breadth more (PLAYER_RADIUS): a leaf swinging shut stops
 * that far short of someone, because shoving them would sweep them through the doorway. A leaf swinging open may nudge them, by at
 * most SHOVE metres of capsule per step; moveCharacter pushes them clear along the leaf's normal on the next frame.
 */
const BODY_RADIUS = .24, PLAYER_RADIUS = .3, PLAYER_HEIGHT = 1.05, SHOVE = .1;
/** A door held up by someone standing in its way gives up after this long and stays where it got to. */
const PATIENCE = 1.2;
const UP = new THREE.Vector3(0, 1, 0);

/** The numbers a door needs, or why not. Anything the exporter could get wrong is checked, because the world must still load. */
export function doorProblem(spec: unknown): string | undefined {
  const s = spec as Partial<DoorSpec> | null | undefined;
  if (!s || typeof s !== 'object') return 'is not an object';
  if (typeof s.asset !== 'string' || !s.asset) return 'has no asset';
  if (!Array.isArray(s.hinge) || s.hinge.length < 3 || !s.hinge.every(Number.isFinite)) return 'has no hinge position';
  if (![s.yaw, s.swing].every(Number.isFinite)) return 'has no yaw or swing';
  if (!Number.isFinite(s.width) || !(s.width! > 0) || !Number.isFinite(s.height) || !(s.height! > 0)) return 'has no size';
  if (s.thickness !== undefined && !(Number.isFinite(s.thickness) && s.thickness > 0)) return 'has a bad thickness';
  if (s.start !== undefined && !Number.isFinite(s.start)) return 'has a bad start';
  return undefined;
}

/**
 * Where a door leaf is when it is `open` (0 shut .. 1 fully swung) on a placement: a pure function of the placement, its ground
 * height and tilt (a seated prop's quaternion, which already includes its yaw), the spec and `open`.
 * World rotation.y = placement yaw + spec.yaw + open * spec.swing, about the hinge.
 */
export function doorPose(p: DoorBase, ground: number, q: THREE.Quaternion | undefined, spec: DoorSpec, open: number): DoorPose {
  const s = p.scale ?? 1, turn = spec.yaw + open * spec.swing, base = q ?? new THREE.Quaternion().setFromAxisAngle(UP, p.yaw);
  const quaternion = base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, turn));
  const position = new THREE.Vector3(spec.hinge[0] * s, spec.hinge[1] * s, spec.hinge[2] * s).applyQuaternion(base).add(new THREE.Vector3(p.x, ground, p.z));
  const width = spec.width * s, direction = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const tip = position.clone().addScaledVector(direction, width);
  const along = Math.max(width * .5, Math.min(width - HANDLE_FROM_EDGE * s, width * .85));
  const handle = position.clone().addScaledVector(direction, along).addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion), HANDLE_HEIGHT * s);
  // A box turns about Y only. Upright, that is exactly the leaf's yaw; on a tilted parent it is the heading of the leaf's run.
  const yaw = q ? Math.atan2(-direction.z, direction.x) : p.yaw + turn;
  const low = Math.min(position.y, tip.y), high = Math.max(position.y, tip.y) + spec.height * s;
  const collider: DoorBox = { kind: 'box', x: (position.x + tip.x) / 2, z: (position.z + tip.z) / 2, halfX: width / 2, halfZ: (spec.thickness ?? THICKNESS) * s / 2 + COLLIDER_PAD,
    yaw, minY: low, maxY: high, tag: 'door' };
  return { position, yaw, quaternion, scale: s, direction, tip, handle, collider };
}

/** A door as the rest of the game sees it (diagnostics, and later the creature). Positions are world metres. */
export type DoorInfo = {
  id: string; placement: string; index: number; asset: string;
  /** 0 shut .. 1 fully open, right now; and where it is heading. */
  open: number; target: number; moving: boolean;
  /** Shut: the leaf stands in the doorway. */
  closed: boolean;
  /** A bar lies across it (cabin only). */
  barred: boolean;
  /** 'idle'/'loading': the leaf's model has not arrived (its collider and state exist all the same); 'failed': it never will, so the door is gone. */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  x: number; y: number; z: number; yaw: number; width: number;
  tip: { x: number; z: number }; handle: { x: number; y: number; z: number };
  /** The middle of the doorway (the shut leaf's middle), world metres: where it is, whatever the leaf is doing. */
  mid: { x: number; z: number };
};

export type DoorsOptions = {
  pois: Pick<Pois, 'seats' | 'spawn' | 'known'>;
  /** Colliders are registered here, as one group of their own, replaced whenever a leaf moves. */
  collisions?: { replace: (name: string, colliders: SolidCollider[]) => void };
  interaction?: { register: (item: Interactable) => () => void };
  /** The player opened or shut a door: a sound, at its handle. */
  onNoise?: (e: { id: string; x: number; z: number; loudness: number; opening: boolean; /** The Listener forced it (or broke its bar): a crash. */ forced?: boolean }) => void;
  /** Which placements' doors can be barred, from inside (the cabin's): the bar is the player's, silent, and holds the door shut. */
  barrable?: (placement: string) => boolean;
  /** Whether a point is inside the building (the bar is reached from inside only). */
  indoors?: (x: number, z: number) => boolean;
  group?: string;
};
export type DoorsFrame = { dt: number; player: { x: number; y: number; z: number } };

type Door = {
  id: string; placement: string; index: number; spec: DoorSpec; seat: PoiSeat;
  open: number; target: number;
  /** A bar lies across it: it cannot be opened until the bar is lifted. */
  barred: boolean; bar: THREE.Vector3; unregisterBar?: () => void;
  /** The current leg of the swing: from where it set off, and how far through (0..1) it is. */
  from: number; t: number; blocked: number;
  /** Swinging faster than a hand does (forced), until it arrives. */
  fast: boolean;
  /** The middle of the doorway, from the shut pose. */
  mid: { x: number; z: number };
  pose: DoorPose; handle: THREE.Vector3;
  status: 'idle' | 'loading' | 'ready' | 'failed'; shown: boolean; object?: THREE.Object3D; unregister?: () => void;
};

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** How deep (m) a capsule of this radius at the player's feet is inside this leaf's box; 0 if clear or on another level. */
function penetration(box: DoorBox, p: { x: number; y: number; z: number }, radius: number) {
  if (!(p.y < box.maxY - .05 && p.y + PLAYER_HEIGHT > box.minY)) return 0;
  return Math.max(0, solidContact(box, p.x, p.z, radius).depth);
}
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const sx = bx - ax, sz = bz - az, l = sx * sx + sz * sz, t = l > 0 ? clamp01(((px - ax) * sx + (pz - az) * sz) / l) : 0;
  return Math.hypot(px - ax - sx * t, pz - az - sz * t);
}

/**
 * Every door of every placement (hand-placed or scattered): one hinged leaf object, one box collider that follows it, one prompt.
 *  - State and colliders exist from the first frame, like the parent's own; only the leaf's GLB streams in, and is shown by the
 *    parent's draw distance. A leaf whose model cannot load is dropped altogether (collider and prompt too): the doorway stays clear.
 *  - Swinging: `open` eases over DOOR_SECONDS. Each frame it moves, the leaf's box is rebuilt and the group re-registered;
 *    the box is only ever the leaf's current pose.
 *  - Never trapping: a swing is checked in small arcs against the player's capsule. Shutting, the leaf stops a hand's breadth
 *    short of them (shoving would sweep them out through the doorway) and holds until they step clear, settling where it is if
 *    they stay. Opening, it may nudge them (at most SHOVE m of capsule per step) and moveCharacter, which resolves every collider
 *    each frame, pushes them out along the leaf's normal; if they cannot give way (against a wall) it holds the same way.
 *    Anyone the leaf already overlaps (a teleport, a creature's shove) is left to moveCharacter, and the door only refuses moves
 *    that dig deeper, so it is never frozen by someone it is already touching.
 */
export function createDoors(o: DoorsOptions) {
  const group = o.group ?? 'doors', doors: Door[] = [], byId = new Map<string, Door>(), warned = new Set<string>();
  let disposed = false, dirty = false, at = { x: 0, y: 0, z: 0 };
  const warnOnce = (key: string, message: string) => { if (!warned.has(key)) { warned.add(key); console.warn(`SILENCE: ${message}`); } };
  const poseOf = (d: Door, open: number) => doorPose(d.seat.placement, d.seat.ground, d.seat.quaternion, d.spec, open);
  const publish = () => o.collisions?.replace(group, doors.filter(d => d.status !== 'failed').map(d => d.pose.collider));
  const place = (d: Door) => {
    d.pose = poseOf(d, d.open); d.handle.copy(d.pose.handle);
    // The bar lies across the leaf above the handle (half a metre up, so a look at the handle and a look at the bar are two things).
    d.bar.copy(d.pose.handle).y += .55;
    if (d.object) { d.object.position.copy(d.pose.position); d.object.quaternion.copy(d.pose.quaternion); d.object.scale.setScalar(d.pose.scale); }
  };
  const heading = (d: Door) => d.open !== d.target ? d.target : d.open;
  const aim = (d: Door, target: number, fast = false) => { d.target = target; d.from = d.open; d.t = 0; d.blocked = 0; d.fast = fast; };

  for (const seat of o.pois.seats()) {
    const specs = seat.def.doors; if (!Array.isArray(specs)) continue;
    specs.forEach((spec, index) => {
      const id = `${seat.id}#${index}`, problem = doorProblem(spec);
      if (problem) { warnOnce(`spec:${id}`, `door ${id} ${problem}; it is skipped.`); return; }
      if (!o.pois.known(spec.asset)) { warnOnce(`asset:${spec.asset}`, `world-assets.json has no entry for the door ${spec.asset}; ${seat.id} gets no door.`); return; }
      const start = clamp01(spec.start ?? 0);
      const d: Door = { id, placement: seat.id, index, spec, seat, open: start, target: start, from: start, t: 0, blocked: 0, fast: false, mid: { x: 0, z: 0 }, barred: false, bar: new THREE.Vector3(),
        pose: undefined as unknown as DoorPose, handle: new THREE.Vector3(), status: 'idle', shown: false };
      place(d); doors.push(d); byId.set(id, d);
      { const shut = poseOf(d, 0); d.mid.x = shut.position.x + shut.direction.x * spec.width * shut.scale / 2; d.mid.z = shut.position.z + shut.direction.z * spec.width * shut.scale / 2; }
      d.unregister = o.interaction?.register({
        id: `door:${id}`, position: d.handle, range: 2.3, label: () => d.barred ? 'The door is barred' : heading(d) < .5 ? 'Left click to open' : 'Left click to close',
        enabled: () => d.status !== 'failed',
        keyOnly: true,   // the interact key (E) works a door; a click is the torch
        activate: () => toggle(d, true),
      });
      if (o.barrable?.(seat.id)) d.unregisterBar = o.interaction?.register({
        id: `bar:${id}`, position: d.bar, range: 2.3, label: () => d.barred ? 'Left click to lift the bar' : 'Left click to bar the door', keyOnly: true,
        // Only from inside, and only across a shut door: an open one has nothing to lie across.
        enabled: () => d.status !== 'failed' && o.indoors?.(at.x, at.z) === true && (d.barred || (d.target <= DOOR_CLOSED && d.open <= DOOR_CLOSED)),
        activate: () => { d.barred = !d.barred; },
      });
    });
  }
  publish();

  function toggle(d: Door, byPlayer: boolean) {
    if (d.barred) return;
    const opening = heading(d) < .5;
    aim(d, opening ? 1 : 0);
    if (byPlayer) o.onNoise?.({ id: d.id, x: d.handle.x, z: d.handle.z, loudness: opening ? DOOR_NOISE.open : DOOR_NOISE.close, opening });
  }

  function drop(d: Door) {
    d.status = 'failed'; d.unregister?.(); d.unregister = undefined; d.unregisterBar?.(); d.unregisterBar = undefined; d.barred = false; d.object?.removeFromParent(); d.object = undefined; d.shown = false; dirty = true; publish();
  }
  function load(d: Door) {
    d.status = 'loading';
    o.pois.spawn(d.spec.asset, `Door ${d.id}`).then(object => {
      if (disposed) { object?.removeFromParent(); return; }
      if (!object) { warnOnce(`load:${d.spec.asset}`, `the door ${d.spec.asset} could not load; ${d.placement} keeps an open doorway.`); drop(d); return; }
      // In a building with a baked room (the cabin: its walls are dim inside and lit by its lamp), the leaf's inner face takes
      // that room's light too (prop-materials.ts doorLeafMaterial). The leaf's local z is its normal; the inner face is the one
      // whose shut normal points toward the building's middle (the parent's origin). Buildings without one keep plain light on
      // both faces, as their walls do: dimmed alone, the hut's and chapel's doors went black against their bright inner walls.
      if (d.seat.def.rooms?.length) {
        const s = d.spec, midX = s.hinge[0] + Math.cos(s.yaw) * s.width / 2, midZ = s.hinge[2] - Math.sin(s.yaw) * s.width / 2;
        const side = Math.sin(s.yaw) * -midX + Math.cos(s.yaw) * -midZ >= 0 ? 1 : -1, lamp = d.seat.def.rooms.some(r => r.lamp);
        object.traverse(x => { if (x instanceof THREE.Mesh) x.material = Array.isArray(x.material) ? x.material.map(m => doorLeafMaterial(m, side, lamp)) : doorLeafMaterial(x.material, side, lamp); });
      }
      d.object = object; d.status = 'ready'; place(d); dirty = true;
    }, () => { if (!disposed) drop(d); });
  }

  /** Move one frame along the swing, stopping short of the player. True if the leaf moved. */
  function advance(d: Door, dt: number, player: { x: number; y: number; z: number }) {
    const span = d.target - d.from;
    d.t = Math.min(1, d.t + dt / (DOOR_SECONDS * Math.max(.3, Math.abs(span)) / (d.fast ? FORCED_SPEED : 1)));
    let next = d.t >= 1 ? d.target : d.from + span * ease(d.t), blocked = false;
    const reach = d.spec.width * d.pose.scale + PLAYER_RADIUS + .5;
    if (Math.hypot(player.x - d.pose.position.x, player.z - d.pose.position.z) < reach) {
      // Shutting: nobody may be touched, or they would be swept out through the doorway. Opening: a nudge of SHOVE is fine, moveCharacter does the rest.
      // Whoever is already overlapped (a teleport, a creature's shove) must not be dug into any deeper, but never freezes the leaf.
      const opening = d.target > d.open, radius = opening ? BODY_RADIUS : PLAYER_RADIUS, allowed = Math.max(opening ? SHOVE : 0, penetration(d.pose.collider, player, radius)) + 1e-6;
      // Sampled every few centimetres of the free edge's travel, so a quick frame cannot step a leaf through someone.
      const n = Math.min(24, Math.max(1, Math.ceil(Math.abs(next - d.open) * Math.abs(d.spec.swing) * d.spec.width * d.pose.scale / .04)));
      for (let i = 1; i <= n; i++) {
        if (penetration(poseOf(d, d.open + (next - d.open) * i / n).collider, player, radius) > allowed) { next = d.open + (next - d.open) * (i - 1) / n; blocked = true; break; }
      }
    }
    const moved = next !== d.open;
    d.open = next;
    if (blocked) { d.from = d.open; d.t = 0; if ((d.blocked += dt) >= PATIENCE) d.target = d.open; }
    else { d.blocked = 0; if (d.t >= 1) { d.open = d.target; d.from = d.target; } }
    return moved;
  }

  const info = (d: Door): DoorInfo => ({
    id: d.id, placement: d.placement, index: d.index, asset: d.spec.asset, open: d.open, target: d.target, moving: d.open !== d.target,
    closed: d.open <= DOOR_CLOSED, barred: d.barred, status: d.status, x: d.pose.position.x, y: d.pose.position.y, z: d.pose.position.z, yaw: d.pose.yaw, width: d.spec.width * d.pose.scale,
    tip: { x: d.pose.tip.x, z: d.pose.tip.z }, handle: { x: d.handle.x, y: d.handle.y, z: d.handle.z }, mid: { x: d.mid.x, z: d.mid.z },
  });
  const find = (id: string) => byId.get(id) ?? doors.find(d => d.placement === id);

  return {
    /** Call once a frame. dt is 0 while the game is paused. True when shadow casters changed (a leaf moved, arrived, or crossed its draw distance). */
    update(f: DoorsFrame) {
      let changed = dirty, moved = false; dirty = false;
      const dt = Math.min(Math.max(f.dt, 0), .1), p = f.player;
      at = p;
      for (const d of doors) {
        if (d.status === 'failed') continue;
        if (d.status === 'idle' && d.seat.loadRange(p.x, p.z)) load(d);
        const shown = d.status === 'ready' && d.seat.drawRange(p.x, p.z, d.shown);
        if (shown !== d.shown) { d.shown = shown; if (d.object) d.object.visible = shown; changed = true; }
        if (d.open !== d.target && dt > 0 && advance(d, dt, p)) { place(d); moved = true; if (d.shown) changed = true; }
      }
      if (moved) publish();
      return changed;
    },
    /** Every door, with its state. */
    list(): DoorInfo[] { return doors.filter(d => d.status !== 'failed').map(info); },
    get(id: string): DoorInfo | undefined { const d = find(id); return d && d.status !== 'failed' ? info(d) : undefined; },
    /**
     * The nearest shut door whose leaf is within `reach` metres of (x, z), measured to the leaf itself, or undefined.
     * For the creature, later: a shut door is a doorway it cannot walk through.
     */
    closedAt(x: number, z: number, reach = 1.2): DoorInfo | undefined {
      let best: Door | undefined, bestD = reach;
      for (const d of doors) {
        if (d.status === 'failed' || d.open > DOOR_CLOSED) continue;
        const dist = segmentDistance(x, z, d.pose.position.x, d.pose.position.z, d.pose.tip.x, d.pose.tip.z);
        if (dist <= bestD) { best = d; bestD = dist; }
      }
      return best && info(best);
    },
    /**
     * Put a door at `open` (0..1, or true/false) at once, or swing it there. `id` is "<placement id>#<n>", or just the
     * placement id for its first door. False if there is no such door.
     */
    set(id: string, open: number | boolean, animate = false) {
      const d = find(id), v = typeof open === 'boolean' ? (open ? 1 : 0) : open;
      if (!d || d.status === 'failed' || !Number.isFinite(v)) return false;
      const to = clamp01(v);
      if (animate) aim(d, to);
      else { d.open = d.target = d.from = to; d.t = 0; d.blocked = 0; d.fast = false; place(d); dirty = true; publish(); }
      return true;
    },
    /**
     * Doors whose doorway middle is within `radius` metres of (x, z), nearest first (the Listener, at a building: which ways in are close).
     * Includes open ones; each says `open`, `barred` and where it is.
     */
    doorsNear(x: number, z: number, radius = 12): DoorInfo[] {
      return doors.filter(d => d.status !== 'failed' && Math.hypot(d.mid.x - x, d.mid.z - z) <= radius)
        .sort((a, b) => Math.hypot(a.mid.x - x, a.mid.z - z) - Math.hypot(b.mid.x - x, b.mid.z - z)).map(info);
    },
    /** Whether the door is open enough to be a way in (more than `from`, default a third), counting one on its way open. */
    isOpen(id: string, from = .3) { const d = find(id); return !!d && d.status !== 'failed' && Math.max(d.open, d.target) >= from; },
    /**
     * The Listener forces a door: any bar breaks (it comes off, for good), and the leaf is flung open hard (several times the speed
     * of a hand), with a crash for the noise stream (DOOR_NOISE.forced, a loud noise at the doorway). A door already open is left
     * as it is. False if there is no such door, or nothing to force.
     */
    force(id: string) {
      const d = find(id); if (!d || d.status === 'failed') return false;
      const was = d.barred; d.barred = false;
      if (!was && heading(d) >= .5) return false;
      aim(d, 1, true);
      o.onNoise?.({ id: d.id, x: d.handle.x, z: d.handle.z, loudness: DOOR_NOISE.forced, opening: true, forced: true });
      return true;
    },
    /** Whether a bar lies across this door (`id` as for set()). */
    isBarred(id: string) { return !!find(id)?.barred; },
    /** Put the bar across a door or lift it, silently. A bar only goes on a shut door. False if there is no such door or it is open. */
    setBar(id: string, on: boolean) {
      const d = find(id); if (!d || d.status === 'failed') return false;
      if (on && (d.target > DOOR_CLOSED || d.open > DOOR_CLOSED)) return false;
      d.barred = on; return true;
    },
    /** What a click does: swing it the other way (from wherever it is, if it is moving). */
    toggle(id: string) { const d = find(id); if (!d || d.status === 'failed') return false; toggle(d, false); return true; },
    /** A restarted night: every leaf back to where it began, at once, silently. */
    reset() {
      for (const d of doors) { const start = clamp01(d.spec.start ?? 0); d.open = d.target = d.from = start; d.t = 0; d.blocked = 0; d.fast = false; d.barred = false; place(d); }
      dirty = true; publish();
    },
    /** The live colliders, one per door. Rebuilt (not mutated) whenever a leaf moves. */
    get colliders(): SolidCollider[] { return doors.filter(d => d.status !== 'failed').map(d => d.pose.collider); },
    get size() { return doors.filter(d => d.status !== 'failed').length; },
    dispose() {
      disposed = true;
      for (const d of doors) { d.unregister?.(); d.unregister = undefined; d.unregisterBar?.(); d.unregisterBar = undefined; d.object?.removeFromParent(); d.object = undefined; }
      doors.length = 0; byId.clear(); o.collisions?.replace(group, []);
    },
  };
}

export type Doors = ReturnType<typeof createDoors>;
