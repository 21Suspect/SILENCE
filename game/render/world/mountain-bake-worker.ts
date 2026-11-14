// The mountains' load-time bakes off the main thread (mountain-bake.ts): one message in, one answer out, then the worker is closed.
import { islandBake } from './mountain-bake';
import { farForestBake } from './far-forest-bake';

type Request = { kind: 'island' | 'forest'; heights: Float32Array; n: number; step: number; x0: number };
self.addEventListener('message', (event: MessageEvent<Request>) => {
  const q = event.data;
  if (q.kind === 'forest') {
    const data = farForestBake(q.heights, q.n, q.step, q.x0);
    self.postMessage(data, { transfer: [data.trees.buffer, data.horizons.buffer, data.groundA.buffer, data.groundB.buffer, data.rubble.buffer, data.deadfall.buffer, data.stumps.buffer, data.sticks.buffer] as ArrayBuffer[] });
  } else {
    const data = islandBake(q.heights, q.n, q.step, q.x0);
    self.postMessage(data, { transfer: [data.masks.buffer, data.trees.buffer, data.treeHorizons.buffer] as ArrayBuffer[] });
  }
});
