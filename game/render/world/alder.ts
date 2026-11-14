import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The forest's trees: Black Alders (Quixel Megascans, Fab), packed by tools/assets/alder/build.py into public/world/alder.
 *
 * A tree has four distance slots, each a source level of detail picked to a triangle budget (the old procedural forest spent 15 to
 * 30 thousand triangles on a tree up close and 3 to 6 thousand far off, and these stay near that):
 *   slot 0  the finest (20 to 220 thousand triangles). Drawn only inside the first band, and only on the few trees nearest the
 *           player; loaded on demand once one is close.
 *   slot 1  5 to 60 thousand; out to the second band.      slot 2  1 to 16 thousand; out to the third.
 *   slot 3  the lightest (1 to 12 thousand); out to the edge of the fog.
 * Neighbouring slots that hold the same source level are one `level`. Levels overlap across the bands and dissolve into each other in
 * the shader (alder-materials.ts), so nothing switches.
 */
export const BANDS: readonly (readonly [number, number])[] = [[5, 8], [9, 12], [20, 26]];
/** A tree's slot 0 starts loading when one is this close. */
export const NEAR_PREFETCH = 30;
/** At most this many trees at a time get the finest level, the nearest ones. */
export const NEAR_TREES = 3;
const ROOT = '/world/alder/';

export type AlderPart = { name: string; start: number; count: number };
export type AlderMesh = { geometry: THREE.BufferGeometry; parts: AlderPart[] };
/** Slots `from` to `to` (inclusive) share one source level; `mesh` once loaded. */
export type AlderLevel = { lod: number; file: string; tris: number; from: number; to: number; mesh?: AlderMesh };
export type AlderModel = {
  name: string; height: number; reach: number; crownBase: number; boleRadius: number;
  profileStep: number; axis: [number, number][]; radius: number[];
  levels: AlderLevel[];
  /** The finest level when it covers slot 0 alone: loaded on demand. */
  near?: AlderLevel;
  nearState: 'none' | 'idle' | 'loading' | 'ready';
};
export type AlderSet = { models: AlderModel[]; textureBase: string };

type ManifestTree = {
  name: string; slots: number[]; height: number; reach: number; crownBase: number; boleRadius: number; profileStep: number; axis: [number, number][]; radius: number[];
  lods: Record<string, { file: string; tris: number }>;
};

/** One BufferGeometry from a loaded GLB: its primitives share the vertex buffers, so the indices are joined and each material is a range of them. */
function merge(root: THREE.Object3D): AlderMesh {
  const meshes: THREE.Mesh[] = [];
  root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  meshes.sort((a, b) => (a.material as THREE.Material).name.localeCompare((b.material as THREE.Material).name));
  const first = meshes[0].geometry, vertices = first.getAttribute('position').count;
  let total = 0;
  for (const m of meshes) total += m.geometry.index!.count;
  const index = vertices > 65535 ? new Uint32Array(total) : new Uint16Array(total);
  const geometry = new THREE.BufferGeometry(), parts: AlderPart[] = [];
  geometry.setAttribute('position', first.getAttribute('position'));
  geometry.setAttribute('normal', first.getAttribute('normal'));
  geometry.setAttribute('uv', first.getAttribute('uv'));
  let at = 0;
  meshes.forEach((m, i) => {
    const source = m.geometry.index!;
    index.set(source.array as ArrayLike<number>, at);
    geometry.addGroup(at, source.count, i);
    parts.push({ name: (m.material as THREE.Material).name, start: at, count: source.count });
    at += source.count;
    if (m.geometry !== first) m.geometry.dispose();
  });
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  for (const m of meshes) (m.material as THREE.Material).dispose();
  return { geometry, parts };
}

async function loadMesh(loader: GLTFLoader, file: string): Promise<AlderMesh> {
  return merge((await loader.loadAsync(`${ROOT}${file}`)).scene);
}

/**
 * The manifest and every level a tree needs at once (all but the finest). `names` limits which trees. The loader goes through
 * three's default loading manager, so the loading veil waits for the meshes.
 */
export async function loadAlders(names?: readonly string[]): Promise<AlderSet> {
  const manifest = await (await fetch(`${ROOT}manifest.json`)).json() as { textures: string; trees: ManifestTree[] };
  const loader = new GLTFLoader();
  const models = await Promise.all(manifest.trees.filter(t => !names || names.includes(t.name)).map(async t => {
    const levels: AlderLevel[] = [];
    t.slots.forEach((lod, slot) => {
      const last = levels[levels.length - 1];
      if (last && last.lod === lod) last.to = slot;
      else levels.push({ lod, file: t.lods[String(lod)].file, tris: t.lods[String(lod)].tris, from: slot, to: slot });
    });
    const near = levels[0].from === 0 && levels[0].to === 0 && levels.length > 1 ? levels[0] : undefined;
    await Promise.all(levels.filter(l => l !== near).map(async l => { l.mesh = await loadMesh(loader, l.file); }));
    return {
      name: t.name, height: t.height, reach: t.reach, crownBase: t.crownBase, boleRadius: t.boleRadius, profileStep: t.profileStep, axis: t.axis, radius: t.radius,
      levels, near, nearState: near ? 'idle' : 'none',
    } satisfies AlderModel;
  }));
  return { models, textureBase: `${ROOT}${manifest.textures}` };
}

const nearLoader = (() => { let loader: GLTFLoader | undefined; return () => loader ??= new GLTFLoader(new THREE.LoadingManager()); })();
/**
 * Starts loading a model's finest level (once). It uses its own loading manager, so the loading veil never waits for it and the
 * game's "settled" test is not disturbed. `done` runs when the mesh is there.
 */
export function loadNear(model: AlderModel, done: () => void) {
  const level = model.near;
  if (model.nearState !== 'idle' || !level) return;
  model.nearState = 'loading';
  loadMesh(nearLoader(), level.file).then(mesh => { level.mesh = mesh; model.nearState = 'ready'; done(); })
    .catch(error => { console.warn(`SILENCE: ${model.name} finest level did not load; the next one stays.`, error); model.nearState = 'none'; });
}

/**
 * The trunk's bark at a given angle and height, for the creature's climbing (render/creature): the point on the surface, from the
 * axis and radius the packer measured every half metre. World angle `angle` points from the axis outward; `scale` and `yaw` are
 * the instance's. Undefined below the foot or above the part of the trunk that was measured (the limbs start there).
 */
export function barkPoint(model: AlderModel, x: number, y: number, z: number, yaw: number, scale: number, angle: number, at: number) {
  const local = (at - y) / scale, step = model.profileStep, last = model.radius.length - 1;
  if (local < -.05 || local > last * step) return undefined;
  const f = Math.min(last, Math.max(0, local / step)), i = Math.min(last - 1, Math.floor(f)), t = f - i;
  const cx = model.axis[i][0] + (model.axis[i + 1][0] - model.axis[i][0]) * t, cz = model.axis[i][1] + (model.axis[i + 1][1] - model.axis[i][1]) * t;
  const r = (model.radius[i] + (model.radius[i + 1] - model.radius[i]) * t) * scale;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  return { x: x + (cx * cos + cz * sin) * scale + Math.cos(angle) * (r + .025), y: at, z: z + (cz * cos - cx * sin) * scale + Math.sin(angle) * (r + .025) };
}
