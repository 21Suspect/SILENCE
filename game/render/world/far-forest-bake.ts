/**
 * The island forest's trees for the distant forest (far-forest.ts), worked out at load in plain maths so it runs in a worker
 * (mountain-bake-worker.ts) and in Node. They are the streamed forest's own trees: the same layout (sim/world/placement.ts, its
 * trees-only mode), so the tree that dissolves in at 90 m is the one that stands there when you walk up to it, of the same
 * species, model, size and turn. The only difference is the ground it is worked out on: the distant terrain's 4 m grid, as that
 * mesh draws it, instead of the exact heights (a tile cache that costs about 20 ms a 32 m cell to fill: 20 s for the island,
 * where the grid costs nothing more). Measured against the exact layout: 663 of 666 trees the same, feet within .43 m; the
 * whole island's 10,100 trees in 0.25 s.
 */
import { createNaturalLayout } from '../../sim/world/placement';
import { WORLD_RADIUS, biomeAt, groundMasks, riverPresence, riverX, roadDistance, roadZ, vegetationExclusion } from '../../sim/world/world';
import { horizonAngles, gridHeights } from './terrain-horizon';
import { treeGroundInfluence, treeGroundRadius } from '../../sim/world/tree-ground';

/** Per tree: x, y (its foot), z, yaw, height factor, width, kind, seed (placement.ts LayoutTree). */
export const FAR_TREE_STRIDE = 8;
/**
 * `groundA`/`groundB`: what the near ground's shader reads per vertex (terrain-geometry.ts biome and treeGround), on the same
 * n x n grid as RGBA bytes, so the distant ground (terrain.ts farGround) mixes the very layers by the very masks the near one
 * does. A: worn earth, leaf litter (groves, heath), stone (rock, alpine, steep), the trees' root ground (the trees laid out here,
 * a root mat of 1.4 widths round each trunk, as tree-ground.ts). B: asphalt.
 */
/**
 * The forest's other things, from the same layout and so exactly where the streamed forest has them (forest.ts), each with the
 * ground under it worked out as forest.ts does from the grid: boulders (x, y, z, size, yaw, variant), fallen logs (x, z, yaw, size,
 * variant, the ground under its two ends), stumps (x, z, size, yaw, variant, the lowest ground round its foot), fallen branches
 * (x, z, yaw, size, variant, the ground under its two ends).
 */
export const RUBBLE_STRIDE = 6, LOG_STRIDE = 7, STUMP_STRIDE = 6, STICK_STRIDE = 7;
export type FarForestData = { trees: Float32Array; horizons: Uint8Array; groundA: Uint8Array; groundB: Uint8Array; n: number; step: number; x0: number;
  rubble: Float32Array; deadfall: Float32Array; stumps: Float32Array; sticks: Float32Array };
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function farForestBake(heights: Float32Array, n: number, step: number, x0: number): FarForestData {
  const at = gridHeights(heights, n, step, x0, x0);
  // The full layout (its trees are the trees-only mode's; 1.2 s for the island on the grid, against 0.25 s for the trees alone).
  const layout = createNaturalLayout({ heightAt: at, exclusion: vegetationExclusion, biomeAt, riverX, riverPresence, roadZ, radius: WORLD_RADIUS });
  const CELL = 32, reach = Math.ceil(WORLD_RADIUS / CELL), list: number[] = [], rubble: number[] = [], deadfall: number[] = [], stumps: number[] = [], sticks: number[] = [];
  for (let cx = -reach; cx < reach; cx++) for (let cz = -reach; cz < reach; cz++) {
    // Nothing grows within 55 m of the world's edge (placement.ts valid): cells wholly outside it are skipped unread.
    if (Math.hypot((cx + .5) * CELL, (cz + .5) * CELL) > WORLD_RADIUS - 55 + CELL * .71) continue;
    const cell = layout.cell(cx, cz);
    for (const t of cell.trees) list.push(t.x, t.y, t.z, t.yaw, t.height, t.width, t.kind, t.seed);
    for (const r of cell.rubble) rubble.push(r.x, r.y, r.z, r.size, r.yaw, r.variant);
    for (const d of cell.deadfall) { const dx = Math.sin(d.yaw) * d.size * .5, dz = Math.cos(d.yaw) * d.size * .5; deadfall.push(d.x, d.z, d.yaw, d.size, d.variant, at(d.x - dx, d.z - dz), at(d.x + dx, d.z + dz)); }
    for (const st of cell.stumps) { let base = st.y; for (let j = 0; j < 8; j++) { const a = j * Math.PI * .25; base = Math.min(base, at(st.x + Math.cos(a) * st.size, st.z + Math.sin(a) * st.size)); } stumps.push(st.x, st.z, st.size, st.yaw, st.variant, base); }
    for (const b of cell.sticks) { const dx = Math.sin(b.yaw) * b.size * .5, dz = Math.cos(b.yaw) * b.size * .5; sticks.push(b.x, b.z, b.yaw, b.size, b.variant, at(b.x - dx, b.z - dz), at(b.x + dx, b.z + dz)); }
  }
  const trees = new Float32Array(list), count = trees.length / FAR_TREE_STRIDE, base = new Float32Array(count * 3);
  // Shadows of the land on each tree (terrain-horizon.ts), from a point 8 m up its trunk, so its own slope does not shade it.
  for (let t = 0; t < count; t++) { base[t * 3] = trees[t * FAR_TREE_STRIDE]; base[t * 3 + 1] = trees[t * FAR_TREE_STRIDE + 1] + 8; base[t * 3 + 2] = trees[t * FAR_TREE_STRIDE + 2]; }
  const horizons = horizonAngles(base, count, at, step, 480);
  // The trees' root ground (tree-ground.ts treeGroundInfluence, the near ground's vTreeGround), stamped at a metre and averaged to
  // the grid's 4 m cells: the pockets are 2 to 3 m across, so read only at the grid's points most of them would fall between.
  const fine = 4, nf = (n - 1) * fine + 1, sf = step / fine, rootsFine = new Float32Array(nf * nf);
  for (let t = 0; t < count; t++) {
    const o = t * FAR_TREE_STRIDE, tree = { x: trees[o], z: trees[o + 2], yaw: trees[o + 3], width: trees[o + 5], seed: trees[o + 7] }, reach = treeGroundRadius(tree) * 1.25;
    const i0 = Math.max(0, Math.ceil((tree.x - reach - x0) / sf)), i1 = Math.min(nf - 1, Math.floor((tree.x + reach - x0) / sf));
    const j0 = Math.max(0, Math.ceil((tree.z - reach - x0) / sf)), j1 = Math.min(nf - 1, Math.floor((tree.z + reach - x0) / sf));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const w = treeGroundInfluence(tree, x0 + i * sf, x0 + j * sf), m = j * nf + i;
      if (w > rootsFine[m]) rootsFine[m] = w;
    }
  }
  const roots = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
      const fi = i * fine + a, fj = j * fine + b;
      if (fi < 0 || fj < 0 || fi >= nf || fj >= nf) continue;
      sum += rootsFine[fj * nf + fi]; cnt++;
    }
    roots[j * n + i] = sum / cnt;
  }
  const groundA = new Uint8Array(n * n * 4), groundB = new Uint8Array(n * n * 4), byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, x = x0 + i * step, z = x0 + j * step;
    const xp = heights[j * n + Math.min(n - 1, i + 1)], xm = heights[j * n + Math.max(0, i - 1)], zp = heights[Math.min(n - 1, j + 1) * n + i], zm = heights[Math.max(0, j - 1) * n + i];
    const slope = Math.hypot(xp - xm, zp - zm) / (2 * step);
    const b = biomeAt(x, z), [worn, rock] = groundMasks(x, z);
    groundA[k * 4] = byte(worn); groundA[k * 4 + 1] = byte(b.grove + b.heath * .55);
    groundA[k * 4 + 2] = byte(Math.max(b.alpine, rock * .7, smooth(slope, .5, .92)) + b.heath * .24); groundA[k * 4 + 3] = byte(roots[k]);
    groundB[k * 4] = byte(1 - smooth(roadDistance(x, z), 2.4, 3.6));
  }
  return { trees, horizons, groundA, groundB, n, step, x0, rubble: new Float32Array(rubble), deadfall: new Float32Array(deadfall), stumps: new Float32Array(stumps), sticks: new Float32Array(sticks) };
}
