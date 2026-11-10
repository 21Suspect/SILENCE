import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SolidCollider } from './collision';
import * as layout from './world-layout';
import type { PoiFootprint, PoiPlacement } from './world-layout';
import { WORLD_V2 } from './world-flags';
import worldAssets from './world-assets.json';
import type { Ladder } from './ladders';
import type { DoorSpec } from './doors';
import type { GpuWarmup } from './gpu-warmup';
import { perfOn } from './perf-flags';

/** Model-local footprint (Y up, metres, Y=0 is the ground), as written by the Blender export. */
export type ModelCollider = ({ kind: 'box'; x: number; z: number; halfX: number; halfZ: number; yaw?: number } |
  { kind: 'capsule'; ax: number; az: number; bx: number; bz: number; radius: number }) & { minY: number; maxY: number; tag?: string };
/** A ladder in model-local metres: the line from `bottom` to `top`, and where to stand after topping out. */
export type ModelLadder = { bottom: readonly [number, number, number]; top: readonly [number, number, number]; exit: readonly [number, number, number]; width?: number };
export type PoiAsset = { url: string; radius: number; colliders?: ModelCollider[]; hooks?: Record<string, readonly [number, number, number]>; ladders?: ModelLadder[];
  /** Hinged door leaves (game/doors.ts): each names another asset, a GLB of just the leaf. */
  doors?: DoorSpec[] };
/** A ladder in world metres, ready for game/ladders.ts. `id` is `<placement id>#<index in the asset's ladders>`. */
export type WorldLadder = Ladder & { placement: string };
/** A scatter entry has the same shape as a POI; `scale` is optional and uniform. */
export type Placement = PoiPlacement & { scale?: number };
export type PoiOptions = {
  assets?: Record<string, PoiAsset>; placements?: Placement[]; scatter?: Placement[];
  /** Injected in tests; defaults to GLTFLoader. */
  load?: (url: string) => Promise<{ scene: THREE.Object3D }>;
  /** Seat every placement on the terrain under its whole footprint (see seatPlacement). Defaults to WORLD_V2; off, Y is the terrain at the origin. */
  seat?: boolean;
};

const DEFAULT_DRAW = 150, LOAD_MARGIN = 60, HIDE_MARGIN = 12, SCATTER_STEP = 1.5;

/**
 * A model-local (x, z) in world metres: exactly where a THREE.Object3D at (p.x, ·, p.z)
 * with rotation.y = p.yaw and uniform scale would put it. Rotating about +Y by yaw maps
 * local +X to (cos, -sin) and local +Z to (sin, cos), the same axes solidContact uses.
 */
export function placePoint(p: Placement, lx: number, lz: number, out = { x: 0, z: 0 }) {
  const s = p.scale ?? 1, c = Math.cos(p.yaw), n = Math.sin(p.yaw);
  out.x = p.x + s * (lx * c + lz * n); out.z = p.z + s * (lz * c - lx * n);
  return out;
}

const scratch = { x: 0, z: 0 }, origin = new THREE.Vector3();
/**
 * A model-local point in world metres. An upright placement turns about Y only, exactly as before; a seated
 * (tilted) one is moved by its full rotation `q` about the origin (p.x, ground, p.z), so hooks follow the tilt.
 */
function localToWorld(p: Placement, ground: number, q: THREE.Quaternion | undefined, lx: number, ly: number, lz: number, out = new THREE.Vector3()) {
  const s = p.scale ?? 1;
  if (!q) { placePoint(p, lx, lz, scratch); return out.set(scratch.x, ground + ly * s, scratch.z); }
  return out.set(lx * s, ly * s, lz * s).applyQuaternion(q).add(origin.set(p.x, ground, p.z));
}

/** Yaw composes by addition, since both rotate about the same axis in the same sense. `q` is a seated placement's rotation (see seatPlacement). */
export function worldColliders(asset: PoiAsset, p: Placement, ground: number, q?: THREE.Quaternion): SolidCollider[] {
  const s = p.scale ?? 1, a = new THREE.Vector3(), b = new THREE.Vector3(), result: SolidCollider[] = [];
  for (const c of asset.colliders ?? []) {
    const tag = c.tag ? { tag: c.tag } : {};
    if (c.kind === 'box') {
      localToWorld(p, ground, q, c.x, 0, c.z, a);
      result.push({ kind: 'box', x: a.x, z: a.z, halfX: c.halfX * s, halfZ: c.halfZ * s, yaw: p.yaw + (c.yaw ?? 0), minY: a.y + c.minY * s, maxY: a.y + c.maxY * s, ...tag });
    } else {
      localToWorld(p, ground, q, c.ax, 0, c.az, a); localToWorld(p, ground, q, c.bx, 0, c.bz, b);
      const y = (a.y + b.y) / 2;
      result.push({ kind: 'capsule', ax: a.x, az: a.z, bx: b.x, bz: b.z, radius: c.radius * s, minY: y + c.minY * s, maxY: y + c.maxY * s, ...tag });
    }
  }
  return result.filter(c => Object.values(c).every(v => typeof v !== 'number' || Number.isFinite(v)));
}

export function worldHook(asset: PoiAsset, p: Placement, ground: number, name: string, q?: THREE.Quaternion): THREE.Vector3 | undefined {
  const h = asset.hooks?.[name];
  if (!h || h.length < 3 || !h.every(Number.isFinite)) return undefined;
  return localToWorld(p, ground, q, h[0], h[1], h[2]);
}

/** Ladder points go through the same placement transform as hooks: position, yaw and scale about the model origin. */
export function worldLadder(asset: PoiAsset, p: Placement, ground: number, index: number, q?: THREE.Quaternion): WorldLadder | undefined {
  const l = asset.ladders?.[index], s = p.scale ?? 1;
  if (!l || ![l.bottom, l.top, l.exit].every(v => (v?.length ?? 0) >= 3 && v.every(Number.isFinite))) return undefined;
  const at = (v: readonly [number, number, number]) => { const w = localToWorld(p, ground, q, v[0], v[1], v[2]); return { x: w.x, y: w.y, z: w.z }; };
  return { id: `${p.id}#${index}`, placement: p.id, bottom: at(l.bottom), top: at(l.top), exit: at(l.exit), width: (l.width ?? .45) * s };
}

// --- seating: where an object's base meets the ground ------------------------------------------------

/**
 * The model-local rectangle (centre and half extents, unscaled metres) an object stands on: the footprint the layout
 * declares for it, else the bounds of its colliders, else a square of side `radius`.
 */
export function footprintOf(asset: PoiAsset, declared?: PoiFootprint): PoiFootprint {
  if (declared) return declared;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const take = (x: number, z: number, rx: number, rz: number) => { x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx); z0 = Math.min(z0, z - rz); z1 = Math.max(z1, z + rz); };
  for (const c of asset.colliders ?? []) {
    if (c.kind === 'box') { const co = Math.abs(Math.cos(c.yaw ?? 0)), si = Math.abs(Math.sin(c.yaw ?? 0)); take(c.x, c.z, co * c.halfX + si * c.halfZ, si * c.halfX + co * c.halfZ); }
    else { take((c.ax + c.bx) / 2, (c.az + c.bz) / 2, Math.abs(c.bx - c.ax) / 2 + c.radius, Math.abs(c.bz - c.az) / 2 + c.radius); }
  }
  if (!(x1 >= x0 && z1 >= z0)) { const h = (asset.radius ?? 1) * .5; return { cx: 0, cz: 0, hx: h, hz: h }; }
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
}

/** Rocks and the mine's rock face are modelled to reach below their origin: they are meant to be sunk into the slope, not sat on it. */
const isSunk = (asset: PoiAsset) => (asset.colliders ?? []).some(c => c.minY < -.2);

/** Where a placement really stands. `placement` is the input, with a tilted prop's extra yaw; `quaternion` exists only when it tilts. */
export type Seat = { ground: number; placement: Placement; quaternion?: THREE.Quaternion };

const TILT_LIMIT = 22 * Math.PI / 180, YAW_JITTER = .2, SAMPLE_SPACING = .4, EMBED_PER_METRE = .05, EMBED_MAX = .06;
/** A deterministic 0..1 from a placement id (FNV-1a with a finaliser), so repeats of one asset never match. */
function unit(id: string, salt: number) {
  let h = Math.imul(2166136261 ^ salt, 16777619);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Seats a placement on the terrain under its whole footprint instead of at one point.
 *  - 'tilt' (small things lying on the ground): a plane is fitted through the terrain under the footprint, the object lies
 *    along it (at most 22 degrees) with its base resting on the highest support sample. The id varies yaw.
 *  - otherwise it stays upright and its base is the lowest terrain sample under the footprint, less a small embed
 *    (proportional to its size, at most 6 cm), so nothing floats and posts look driven in.
 *  - sunk assets (rocks) keep the terrain at their origin.
 */
export function seatPlacement(asset: PoiAsset, p: Placement, heightAt: (x: number, z: number) => number): Seat {
  if (/^rock_[a-d]$/.test(p.asset)) {
    // Scanned rocks have a buried skirt, but their downhill rim must also
    // intersect the bank. A centre-only sample left shelves hanging in air.
    const r = footprintOf(asset, p.footprint), scale = p.scale ?? 1, w = {x: 0, z: 0};
    let ground = heightAt(p.x, p.z);
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const u = i / 4 - 1, v = j / 4 - 1;
      if (u * u + v * v > 1) continue;
      placePoint(p, r.cx + u * r.hx, r.cz + v * r.hz, w);
      ground = Math.min(ground, heightAt(w.x, w.z));
    }
    return {ground: ground - .035 * scale, placement: p};
  }
  if (isSunk(asset)) return { ground: heightAt(p.x, p.z), placement: p };
  const s = p.scale ?? 1, rect = p.asset === 'shovel' ? { cx: 0, cz: -.04, hx: .13, hz: .74 } : footprintOf(asset, p.footprint), tilt = p.fit === 'tilt';
  if (p.fit === 'run') {
    // A length of something continuous: it follows the ground from one end to the other, dead straight, so lengths meet.
    const half = (p.asset.startsWith('wall') ? 2 : 3.9) * s, c = Math.cos(p.yaw), n = Math.sin(p.yaw);   // a guard rail is 7.8 m long, a length of field wall 4 m
    const a = heightAt(p.x - c * half, p.z + n * half), b = heightAt(p.x + c * half, p.z - n * half);
    const q = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(b - a, half * 2)));
    return { ground: (a + b) / 2, placement: p, quaternion: q };
  }
  const placed: Placement = tilt ? { ...p, yaw: p.yaw + (unit(p.id, 1) - .5) * 2 * YAW_JITTER } : p;
  const nx = Math.min(9, Math.max(3, Math.ceil(2 * rect.hx * s / SAMPLE_SPACING) + 1)), nz = Math.min(9, Math.max(3, Math.ceil(2 * rect.hz * s / SAMPLE_SPACING) + 1));
  const lx: number[] = [], lz: number[] = [], h: number[] = [], w = { x: 0, z: 0 };
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    lx.push(rect.cx + (i / (nx - 1) * 2 - 1) * rect.hx); lz.push(rect.cz + (j / (nz - 1) * 2 - 1) * rect.hz);
    placePoint(placed, lx[lx.length - 1], lz[lz.length - 1], w); h.push(heightAt(w.x, w.z));
  }
  // Assemblies include cloth hems, ash and rail ties only millimetres above zero.
  const embed = Math.min(['camp', 'logstack', 'mine'].includes(p.asset) ? .005 : EMBED_MAX, EMBED_PER_METRE * 2 * Math.max(rect.hx, rect.hz) * s);
  if (!tilt) {
    let low = Infinity; for (const y of h) low = Math.min(low, y);
    return { ground: low - embed, placement: placed };
  }
  // The plane's slope along the object's own axes: the samples form a symmetric grid, so each axis is independent.
  let su = 0, sv = 0, uu = 0, vv = 0;
  for (let k = 0; k < h.length; k++) { const u = (lx[k] - rect.cx) * s, v = (lz[k] - rect.cz) * s; su += u * h[k]; sv += v * h[k]; uu += u * u; vv += v * v; }
  const gu = uu > 0 ? su / uu : 0, gv = vv > 0 ? sv / vv : 0, c = Math.cos(placed.yaw), n = Math.sin(placed.yaw);
  let gx = gu * c + gv * n, gz = -gu * n + gv * c; // local +X is (cos, -sin) and local +Z is (sin, cos) in world x, z
  const slope = Math.hypot(gx, gz), cap = Math.tan(TILT_LIMIT);
  if (slope > cap) { gx *= cap / slope; gz *= cap / slope; }
  const q = new THREE.Quaternion().setFromUnitVectors(THREE.Object3D.DEFAULT_UP, new THREE.Vector3(-gx, 1, -gz).normalize())
    .multiply(new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, placed.yaw));
  // Rest on the terrain support plane; sinking to its lowest sample buries thin tools.
  const restOnTop = !['canline', 'fence'].includes(p.asset) && slope <= cap;
  let ground = restOnTop ? -Infinity : Infinity; const at = new THREE.Vector3();
  for (let k = 0; k < h.length; k++) {
    at.set(lx[k] * s, 0, lz[k] * s).applyQuaternion(q);
    const support = heightAt(p.x + at.x, p.z + at.z) - at.y;
    ground = restOnTop ? Math.max(ground, support) : Math.min(ground, support);
  }
  return { ground: ground - (restOnTop ? Math.min(embed, .008) : embed), placement: placed, quaternion: q };
}

/** SCATTER_PLACEMENTS may or may not be exported yet; reading it off the namespace keeps both builds valid. */
const optionalList = (name: string): Placement[] => {
  const value = (layout as unknown as Record<string, unknown>)[name];
  return Array.isArray(value) ? value as Placement[] : [];
};

type Entry = {
  /** The placement as it stands (a tilted prop has its extra yaw), `ground` its origin height and `quaternion` its tilt, if any. */
  p: Placement; model: Model; ground: number; quaternion?: THREE.Quaternion; draw: number; shown: boolean; scatter: boolean;
  colliders: SolidCollider[]; enabled: boolean; matrix: THREE.Matrix4; hooks: Map<string, THREE.Vector3>; object?: THREE.Object3D;
};
type Model = {
  name: string; def: PoiAsset; entries: Entry[]; status: 'idle' | 'loading' | 'ready' | 'failed';
  scene?: THREE.Object3D; prims: { mesh: THREE.InstancedMesh; rel: THREE.Matrix4 }[]; scatterX: number; scatterZ: number; repack: boolean;
  /** True while the GPU warm-up (game/gpu-warmup.ts) is still bringing this model's textures in; nothing of it is drawn until then. */
  warming?: boolean;
  /** Settles once `warming` has ended (undefined without the warm-up). */
  ready?: Promise<void>;
  /** Settles once the GLB is in (the shared source scene) or has failed (undefined); set when loading begins. */
  done?: Promise<THREE.Object3D | undefined>;
};
/** A placement as it really stands, for gameplay that hangs things on it (doors). `loadRange` and `drawRange` apply the same distances as the model itself. */
export type PoiSeat = { id: string; asset: string; def: PoiAsset; placement: Placement; ground: number; quaternion?: THREE.Quaternion;
  loadRange: (x: number, z: number) => boolean; drawRange: (x: number, z: number, wasShown: boolean) => boolean };

/**
 * Hand-authored places in the rebuilt world. Collision and hooks come from metadata and
 * exist from the first frame; each GLB streams in once the player is near, is loaded once
 * per asset, and is cloned (shared geometry and materials) per placement. Scatter pieces
 * share one InstancedMesh per GLB primitive instead of cloning.
 */
export function createPois(scene: THREE.Scene, heightAt: (x: number, z: number) => number,
  collisions?: { replace: (name: string, colliders: SolidCollider[]) => void }, options: PoiOptions = {}) {
  const assets = options.assets ?? worldAssets as unknown as Record<string, PoiAsset>;
  const root = new THREE.Group(); root.name = 'World POIs'; scene.add(root);
  // Thin, double-sided cloth and plank faces need slope-aware shadow depth.
  // PolygonOffset alone does not change the RGBA-packed depth Three samples.
  // Apply this only to authored props, preserving tight tree/rock contact shadows.
  const propDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  propDepth.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('packDepthToRGBA( fragCoordZ )',
      'packDepthToRGBA( min( 1.0, fragCoordZ + min( 0.0003, 2.5 * max( abs( dFdx( fragCoordZ ) ), abs( dFdy( fragCoordZ ) ) ) + 0.00003 ) ) )');
  };
  propDepth.customProgramCacheKey = () => 'silence-prop-slope-depth-v1';

  const models = new Map<string, Model>(), entries = new Map<string, Entry>(), warned = new Set<string>();
  const solidColliders: SolidCollider[] = [], ladders: WorldLadder[] = [], unlisted = new Set<string>();
  let version = 1, dirty = false, updated = false, disposed = false, loader: GLTFLoader | undefined, lastX = Infinity, lastZ = Infinity;
  const warnOnce = (key: string, message: string) => { if (!warned.has(key)) { warned.add(key); console.warn(`SILENCE: ${message}`); } };

  const add = (p: Placement, scatter: boolean) => {
    const def = assets[p.asset];
    if (!def) { unlisted.add(p.asset); return; }
    if (entries.has(p.id)) { warnOnce(`id:${p.id}`, `placement id "${p.id}" is used twice; the later one is skipped.`); return; }
    let model = models.get(p.asset);
    if (!model) models.set(p.asset, model = { name: p.asset, def, entries: [], status: 'idle', prims: [], scatterX: Infinity, scatterZ: Infinity, repack: true });
    // One seat for everything: the model, its colliders, hooks, ladders and (scattered) instance matrix share this ground and tilt.
    const seat: Seat = p.y !== undefined ? { ground: p.y, placement: p } : (options.seat ?? WORLD_V2) ? seatPlacement(def, p, heightAt) : { ground: heightAt(p.x, p.z), placement: p };
    const { ground, quaternion } = seat, placed = seat.placement, s = p.scale ?? 1, hooks = new Map<string, THREE.Vector3>();
    for (const name of Object.keys(def.hooks ?? {})) { const v = worldHook(def, placed, ground, name, quaternion); if (v) hooks.set(name, v); }
    const entry: Entry = { p: placed, model, ground, quaternion, draw: p.draw ?? DEFAULT_DRAW, shown: false, scatter, enabled: true, hooks,
      colliders: worldColliders(def, placed, ground, quaternion), object: undefined,
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(p.x, ground, p.z), quaternion ?? new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.yaw), new THREE.Vector3(s, s, s)) };
    model.entries.push(entry); entries.set(p.id, entry);
    // Like hooks and colliders, ladders exist from the first frame, before any GLB has loaded.
    for (let i = 0; i < (def.ladders?.length ?? 0); i++) { const ladder = worldLadder(def, placed, ground, i, quaternion); if (ladder) ladders.push(ladder); }
  };
  for (const p of options.placements ?? layout.POI_PLACEMENTS) add(p, false);
  for (const p of options.scatter ?? optionalList('SCATTER_PLACEMENTS')) add(p, true);
  if (unlisted.size) warnOnce('unlisted', `world-assets.json has no entry for ${[...unlisted].join(', ')}; those placements are skipped.`);

  const collect = () => { solidColliders.length = 0; for (const e of entries.values()) if (e.enabled) solidColliders.push(...e.colliders); };
  const commit = () => { collect(); version++; collisions?.replace('pois', solidColliders); };
  collect(); collisions?.replace('pois', solidColliders);

  const radiusOf = (e: Entry) => e.model.def.radius ?? 6;
  // Distances are to the placement's centre; the asset radius turns that into distance to its nearest surface.
  const within = (e: Entry, x: number, z: number, margin: number) => { const r = e.draw + margin + radiusOf(e); return (e.p.x - x) ** 2 + (e.p.z - z) ** 2 < r * r; };

  function finish(model: Model, gltf: { scene: THREE.Object3D }) {
    const source = gltf.scene;
    if (disposed) { disposeTree(source); return; }
    // An exported lamp or camera would otherwise be cloned into every placement and cost a light each.
    const stray: THREE.Object3D[] = []; source.traverse(o => { if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) stray.push(o); });
    for (const o of stray) o.removeFromParent();
    // Window glass is see-through: it neither throws a shadow nor takes one.
    source.traverse(o => { if (o instanceof THREE.Mesh) { const clear = !Array.isArray(o.material) && o.material.transparent; o.castShadow = !clear; o.receiveShadow = !clear; } });
    source.updateMatrixWorld(true);
    model.scene = source; model.status = 'ready';
    const inverse = new THREE.Matrix4().copy(source.matrixWorld).invert();
    const meshes: THREE.Mesh[] = []; source.traverse(o => { if (o instanceof THREE.Mesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o); });
    const scattered = model.entries.filter(e => e.scatter);
    if (scattered.length) for (const mesh of meshes) {
      const instanced = new THREE.InstancedMesh(mesh.geometry, mesh.material, scattered.length);
      if (!model.name.startsWith('rock_') && model.name !== 'minerock') instanced.customDepthMaterial = propDepth;
      instanced.name = `Scatter ${model.name}`; instanced.castShadow = true; instanced.receiveShadow = true; instanced.count = 0;
      instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage); root.add(instanced);
      model.prims.push({ mesh: instanced, rel: new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld) });
    }
    for (const e of model.entries) {
      if (e.scatter) continue;
      const object = source.clone(true); object.name = `POI ${e.p.id}`;
      object.position.set(e.p.x, e.ground, e.p.z); object.scale.setScalar(e.p.scale ?? 1);
      if (e.quaternion) object.quaternion.copy(e.quaternion); else object.rotation.y = e.p.yaw;
      object.visible = e.shown; e.object = object; root.add(object);
      // Placed once and never moved: stop three re-deriving every node's matrix each frame.
      object.traverse(o => { if (o instanceof THREE.Mesh && !model.name.startsWith('rock_') && model.name !== 'minerock') o.customDepthMaterial = propDepth; o.updateMatrix(); o.matrixAutoUpdate = false; });
      object.updateMatrixWorld(true);
    }
    model.repack = true; dirty = true;
    // Ask for the textures and shader programs to be built a little at a time, now, instead of all in the frame the model is first drawn.
    const warm = perfOn('streamWarmup') ? scene.userData.gpuWarmup as GpuWarmup | undefined : undefined;
    let release: () => void = () => {};
    if (warm) {
      const textures: THREE.Texture[] = [];
      source.traverse(o => { if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.push(v); });
      const urgent = () => model.entries.some(e => within(e, lastX, lastZ, 0)), cancelled = () => disposed;
      // Until its textures are on the GPU (they arrive in tiles) the model stays hidden: a half-uploaded map would show as black patches.
      model.warming = true; model.ready = new Promise<void>(resolve => { release = resolve; });
      const done = () => { model.warming = false; model.repack = true; dirty = true; release(); };
      warm.add({ label: model.name, textures, object: source, urgent, cancelled, onDone: done });
      for (const prim of model.prims) warm.add({ label: `${model.name} (scatter)`, textures: [], object: prim.mesh, urgent, cancelled });
    }
  }

  function begin(model: Model) {
    model.status = 'loading';
    const fail = (error: unknown) => { model.status = 'failed'; warnOnce(`load:${model.name}`, `"${model.name}" could not load (${model.def.url}); its colliders stay.${error instanceof Error ? ` ${error.message}` : ''}`); };
    let request: Promise<{ scene: THREE.Object3D }>;
    try { request = options.load ? options.load(model.def.url) : (loader ??= new GLTFLoader()).loadAsync(model.def.url); } catch (error) { request = Promise.reject(error); }
    // `done` settles when the model can be shown: loaded, and (when the GPU warm-up is on) its textures built.
    model.done = request.then(async gltf => { finish(model, gltf); await model.ready; return model.scene; }).catch(error => { fail(error); return undefined; });
  }

  const tmp = new THREE.Matrix4();
  function repack(model: Model, x: number, z: number) {
    let n = 0, changed = false;
    for (const e of model.entries) {
      if (!e.scatter) continue;
      const shown = !model.warming && within(e, x, z, e.shown ? HIDE_MARGIN : 0);
      if (shown !== e.shown) { e.shown = shown; changed = true; }
      if (!shown) continue;
      for (const prim of model.prims) prim.mesh.setMatrixAt(n, tmp.multiplyMatrices(e.matrix, prim.rel));
      n++;
    }
    for (const prim of model.prims) { prim.mesh.count = n; prim.mesh.instanceMatrix.needsUpdate = true; if (n) prim.mesh.computeBoundingSphere(); prim.mesh.visible = n > 0; }
    model.scatterX = x; model.scatterZ = z; model.repack = false;
    return changed;
  }

  return {
    solidColliders,
    /** Every ladder of every placement, in world space. Fixed once the placements are. */
    ladders,
    /** Changes whenever the collider list does; the engine re-registers it then. */
    get collisionVersion() { return version; },
    /** Returns true when shadow casters changed (a model arrived, or something crossed its draw distance). */
    update(player: THREE.Vector3) {
      updated = true;
      let changed = dirty; dirty = false;
      const x = player.x, z = player.z; lastX = x; lastZ = z;
      for (const model of models.values()) {
        if (model.status === 'idle' && model.entries.some(e => within(e, x, z, LOAD_MARGIN))) begin(model);
        if (model.status !== 'ready') continue;
        for (const e of model.entries) {
          if (e.scatter || !e.object) continue;
          // Hysteresis, as with distantProps in terrain.ts: no flicker (and no shadow churn) on the boundary.
          const shown = !model.warming && within(e, x, z, e.shown ? HIDE_MARGIN : 0);
          if (shown !== e.shown) { e.shown = e.object.visible = shown; changed = true; }
        }
        if (model.prims.length && (model.repack || Math.hypot(x - model.scatterX, z - model.scatterZ) > SCATTER_STEP) && repack(model, x, z)) changed = true;
      }
      return changed;
    },
    /** World position of a model-local hook, or undefined if the placement or hook does not exist. Available before the GLB loads. */
    hook(placementId: string, hookName: string): THREE.Vector3 | undefined { return entries.get(placementId)?.hooks.get(hookName)?.clone(); },
    /** Every placement (hand-placed and scattered) as it stands: its seat, ground and tilt. Fixed once the placements are. */
    seats(): PoiSeat[] {
      return [...entries.values()].map(e => ({ id: e.p.id, asset: e.p.asset, def: e.model.def, placement: e.p, ground: e.ground, quaternion: e.quaternion,
        loadRange: (x, z) => within(e, x, z, LOAD_MARGIN), drawRange: (x, z, wasShown) => within(e, x, z, wasShown ? HIDE_MARGIN : 0) }));
    },
    /** Whether world-assets.json lists this asset at all. */
    known: (name: string) => !!assets[name],
    /**
     * A fresh, hidden copy of a listed asset's GLB inside the POI group (loaded once, geometry and materials shared), for a
     * piece that moves by itself, like a door leaf. Undefined when the asset is not listed or cannot load.
     */
    async spawn(name: string, label = name): Promise<THREE.Object3D | undefined> {
      const def = assets[name];
      if (disposed) return undefined;
      if (!def) { warnOnce(`spawn:${name}`, `world-assets.json has no entry for ${name}.`); return undefined; }
      let model = models.get(name);
      if (!model) models.set(name, model = { name, def, entries: [], status: 'idle', prims: [], scatterX: Infinity, scatterZ: Infinity, repack: true });
      if (model.status === 'idle') begin(model);
      const source = await model.done;
      if (!source || disposed) return undefined;
      const object = source.clone(true); object.name = label; object.visible = false; root.add(object);
      object.traverse(o => { if (o instanceof THREE.Mesh) o.customDepthMaterial = propDepth; });
      return object;
    },
    /** The placed model root once its GLB has loaded (a scatter piece has none). */
    object(placementId: string): THREE.Object3D | undefined { return entries.get(placementId)?.object; },
    /** Lets later gameplay (an opened door, a toppled shelf) remove or restore a placement's collision. */
    setCollidersEnabled(placementId: string, enabled: boolean) {
      const e = entries.get(placementId); if (!e || e.enabled === enabled) return;
      e.enabled = enabled; commit();
    },
    /** True once the first update has started every load that is in range and none is still in flight. */
    ready() { if (!updated) return false; for (const m of models.values()) if (m.status === 'loading') return false; return true; },
    stats() {
      const count = (status: Model['status']) => [...models.values()].filter(m => m.status === status).length;
      return { placements: entries.size, models: models.size, loading: count('loading'), loaded: count('ready'), failed: count('failed'),
        colliders: solidColliders.length, visible: [...entries.values()].filter(e => e.shown).length, instances: [...models.values()].reduce((n, m) => n + (m.prims[0]?.mesh.count ?? 0), 0) };
    },
    dispose() {
      disposed = true; scene.remove(root); collisions?.replace('pois', []);
      for (const m of models.values()) { for (const prim of m.prims) prim.mesh.dispose(); if (m.scene) disposeTree(m.scene); }
      propDepth.dispose(); models.clear(); entries.clear();
    },
  };
}

/** Geometry, materials and their textures are shared by every clone, so this runs once per asset. */
function disposeTree(object: THREE.Object3D) {
  const textures = new Set<THREE.Texture>(), materials = new Set<THREE.Material>();
  object.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) { materials.add(m); for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v); }
  });
  textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose());
}

export type Pois = ReturnType<typeof createPois>;
