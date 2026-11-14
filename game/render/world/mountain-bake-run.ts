import bakeWorkerUrl from './mountain-bake-worker.ts?worker&url';
import * as THREE from 'three';
import { islandBake, type IslandBake } from './mountain-bake';
import { farForestBake, type FarForestData } from './far-forest-bake';

/**
 * Runs one of the mountains' bakes (mountain-bake.ts) in its own worker, each in parallel with the rest of the load. The loading
 * veil waits for it (it counts as an item of three's default loading manager), so the mountains are never seen half made. If
 * the browser will not start a worker, the bake runs here instead.
 */
function run<T>(name: string, request: object, transfer: Transferable[], fallback: () => T): Promise<T> {
  const manager = THREE.DefaultLoadingManager;
  manager.itemStart(name);
  return new Promise<T>(resolve => {
    const done = (value: T) => { resolve(value); manager.itemEnd(name); };
    const local = () => done(fallback());
    try {
      const url = new URL(bakeWorkerUrl, import.meta.url);
      // The worker reads the world's choice (?classic-world, ?seed) from its own address, as the terrain's does.
      url.search = typeof location !== 'undefined' ? location.search : '?classic-world';
      const worker = new Worker(url, { type: 'module' });
      worker.onmessage = (event: MessageEvent<T>) => { worker.terminate(); done(event.data); };
      worker.onerror = () => { worker.terminate(); local(); };
      worker.postMessage(request, transfer);
    } catch { local(); }
  });
}

/** `heights` is copied: the caller keeps its own. */
export function bakeIslandMasks(heights: Float32Array, n: number, step: number, x0: number) {
  const copy = heights.slice();
  return run<IslandBake>('mountain-bake:island', { kind: 'island', heights: copy, n, step, x0 }, [copy.buffer], () => islandBake(heights, n, step, x0));
}
/** The island forest's trees (far-forest-bake.ts) on the same grid, in a worker of its own. `heights` is copied. */
export function bakeFarForest(heights: Float32Array, n: number, step: number, x0: number) {
  const copy = heights.slice();
  return run<FarForestData>('far-forest-bake', { kind: 'forest', heights: copy, n, step, x0 }, [copy.buffer], () => farForestBake(heights, n, step, x0));
}
