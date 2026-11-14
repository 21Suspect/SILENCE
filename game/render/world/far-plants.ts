import plantsWorkerUrl from './far-plants-worker.ts?worker&url';
import * as THREE from 'three';
import type { FarShadow } from './far-shadow';
import { createImpostorAtlas, impostorMaterial, buildImpostors, orderImpostor, mapsLoaded, type ImpostorInstance } from './impostors';
import { FLORA } from '../../sim/world/ecology';

/**
 * The undergrowth past where it is streamed (undergrowth.ts: tussocks to 20 m, herbs to 34, shrubs to 40, ferns to 48): the very
 * same plants, grown by the same ecology and made by the same rules (far-plants-worker.ts), each the impostor of its own model
 * (impostors.ts). Each kind takes over across the band where its streamed plants dissolve out (the last 7 m of its range) and
 * dissolves in turn once a few pixels tall. The island's 190,000 plants are grown in a worker nearest first and come in as they
 * are grown, a few chunks a frame.
 */
type PlantKind = { flora: string; range: number; models: { geometry: THREE.BufferGeometry; material: THREE.Material }[] };
export type PlantSource = { plants?: PlantKind[] };
/** Where each kind is gone in turn: a metre-high fern or shrub is two or three pixels at 150 m; a tussock half that. */
const OUT: Record<string, readonly [number, number]> = { fern: [130, 170], shrub: [130, 170], herb: [110, 150], tussock: [80, 110], fine: [70, 95], meadow: [75, 100] };
/** The short grass is grown on every fourth candidate of its lattice each way (far-plants-worker.ts): each tuft or sward is drawn
 *  this many times as wide, the way its own farther levels widen (undergrowth.ts midFine, farFine, meadow levels). */
const GRASS_WIDEN = 4;
/** Kind numbers past the ecology's flora: the short grass's fine tufts and swards (far-plants-worker.ts). */
const GRASS_KINDS: Record<string, number> = { fine: 100, meadow: 101 };
const CHUNK = 96;
/** Floats per plant as the worker posts them (far-plants-worker.ts): x, y, z, yaw, size, stretch, flora, variant, tint r, g, b. */
const PLANT_STRIDE = 11;

export function createFarPlants(scene: THREE.Scene, renderer: THREE.WebGLRenderer, source: PlantSource, eye: THREE.Vector3, farShadow?: FarShadow) {
  let atlas: ReturnType<typeof createImpostorAtlas> | undefined, material: THREE.Material | undefined, worker: Worker | undefined, disposed = false;
  const kinds = new Map<number, { row: number; count: number; range: number; name: string; widen: number; fade?: readonly [number, number, number, number] }>(), pending: Float32Array[] = [];
  const chunks = new Map<string, { items: ImpostorInstance[]; built?: { meshes: THREE.Mesh[]; dispose(): void }; dirty: boolean; x: number; z: number; reach: number }>();
  const eyeUniform = { value: eye }, since = performance.now();

  function prepare() {
    const plants = source.plants;
    if (!plants || atlas) return !!atlas;
    const maps = plants.flatMap(k => k.models.map(m => m.material as THREE.MeshStandardMaterial)).flatMap(m => [m.map, m.alphaMap]).filter((t): t is THREE.Texture => !!t);
    if (!mapsLoaded(maps, since)) return false;
    const models: { parts: { geometry: THREE.BufferGeometry; material: THREE.Material; foliage: boolean }[] }[] = [];
    for (const k of plants) {
      kinds.set(GRASS_KINDS[k.flora] ?? FLORA.indexOf(k.flora as typeof FLORA[number]), { row: models.length, count: k.models.length, range: k.range, name: k.flora, widen: GRASS_KINDS[k.flora] ? GRASS_WIDEN : 1 });
      for (const m of k.models) models.push({ parts: [{ geometry: m.geometry, material: m.material, foliage: true }] });
    }
    atlas = createImpostorAtlas(renderer, models, { frame: 128, clear: [.05, .07, .03] });
    atlas.bake();
    // Lit as the streamed plants are (undergrowth.ts: no light through the leaf, the whole sky), nothing added.
    material = impostorMaterial(atlas, scene, eyeUniform, { fadeIn: [0, 1], instanceFade: true }, farShadow, 'plants');
    return true;
  }
  function take(data: Float32Array) {
    for (let o = 0; o < data.length; o += PLANT_STRIDE) {
      const kind = kinds.get(data[o + 6]);
      if (!kind) continue;
      const out = OUT[kind.name] ?? [120, 160], size = data[o + 4];
      kind.fade ??= [kind.range - 7, kind.range, out[0], out[1]];
      const x = data[o], z = data[o + 2], key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
      let chunk = chunks.get(key);
      if (!chunk) chunks.set(key, chunk = { items: [], dirty: true, x: (Math.floor(x / CHUNK) + .5) * CHUNK, z: (Math.floor(z / CHUNK) + .5) * CHUNK, reach: 0 });
      chunk.reach = Math.max(chunk.reach, out[1]);
      chunk.items.push({ x, y: data[o + 1], z, yaw: data[o + 3], height: size * data[o + 5], width: size * kind.widen, model: kind.row + (data[o + 7] % kind.count),
        tint: [data[o + 8], data[o + 9], data[o + 10]], fade: kind.fade });
      chunk.dirty = true;
    }
  }
  return {
    /** Starts growing the island's plants (the distant terrain's height grid), nearest the player first. */
    start(grid: { heights: Float32Array; n: number; step: number; x0: number }, at: THREE.Vector3) {
      if (worker || disposed) return;
      try {
        const url = new URL(plantsWorkerUrl, import.meta.url);
        url.search = typeof location !== 'undefined' ? location.search : '';
        worker = new Worker(url, { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ data: Float32Array; done: boolean }>) => { pending.push(event.data.data); if (event.data.done) { worker?.terminate(); worker = undefined; } };
        const heights = grid.heights.slice();
        worker.postMessage({ heights, n: grid.n, step: grid.step, x0: grid.x0, cx: at.x, cz: at.z }, [heights.buffer]);
      } catch { worker = undefined; }
    },
    /** Takes what has been grown and rebuilds at most two chunks a frame, so a batch never stalls one. */
    update() {
      if (!prepare()) return;
      while (pending.length) take(pending.shift()!);
      let rebuilt = 0;
      // A chunk is drawn only while some of its plants can be in view: past every kind's fade-out it costs nothing.
      // And nearest chunk first, among the far trees and the far rocks (impostors.ts orderImpostor has why).
      for (const chunk of chunks.values()) if (chunk.built) { const d = Math.hypot(chunk.x - eye.x, chunk.z - eye.z), shown = d < chunk.reach + CHUNK * .71; for (const m of chunk.built.meshes) { m.visible = shown; orderImpostor(m, d); } }
      for (const chunk of chunks.values()) {
        if (!chunk.dirty) continue;
        chunk.built?.dispose();
        chunk.built = buildImpostors(scene, chunk.items, undefined, material!, 'Distant undergrowth', { chunk: 1e6, tall: 2 });
        chunk.dirty = false;
        if (++rebuilt >= 2) break;
      }
    },
    dispose() { disposed = true; worker?.terminate(); for (const c of chunks.values()) c.built?.dispose(); material?.dispose(); atlas?.dispose(); },
  };
}
