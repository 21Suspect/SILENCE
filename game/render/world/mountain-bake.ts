/**
 * The mountains' load-time bakes, in plain maths (no three.js) so they run in a worker (mountain-bake-worker.ts) and in Node:
 *   islandBake     the island range's geology masks (mountain-masks.ts) on the distant terrain's 4 m grid, for the shading.
 */
import { horizonAngles, gridHeights } from './terrain-horizon';
import { mountainMasks, gridSlopes } from '../../sim/world/mountain-masks';
import { gradientNoise } from '../../sim/world/mountain-noise';
import { mountainRidge, mountainFoot } from '../../sim/world/coastal-geography';

/** The island's tree line, metres (terrain.ts ISLAND_LINES.x): forest up the lower slopes, higher in the gullies, lower on the spurs. */
export const ISLAND_TREE_LINE = 88;
const clamp01 = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t;
const smooth = (x: number, a: number, b: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const noise01 = (x: number, z: number) => clamp01(.5 + .5 * gradientNoise(x, z));
const treeHash = (i: number, j: number, s: number) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2246822519); h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

export type IslandBake = {
  /** RGBA bytes per grid cell: ridge, drainage, debris (mountain-masks.ts), and in A the forest's cover, 0..1. */
  masks: Uint8Array;
  /** The trees mountain-impostors.ts stands on the forest: x, y (the ground), z, height (metres), four per tree. */
  trees: Float32Array;
  /** Their horizons (terrain-horizon.ts), eight bytes per tree. */
  treeHorizons: Uint8Array;
};

/**
 * The island range's masks on the distant terrain's grid: n x n heights `step` apart from (x0, x0), as that mesh has them (so
 * the masks fit the land drawn). The ridge map is the erosion filter's own, north of the range's foot and on the headlands.
 * The forest is decided here, once, from the masks (the rule mountain-surface.ts uses for the far range: below a tree line that
 * climbs the gullies and drops on the spurs, on slopes under about 50 degrees, not on cliffs, fresh talus or avalanche chutes),
 * so the ground's dark forest floor and the trees stood on it (mountain-impostors.ts) are the same forest.
 */
export function islandBake(heights: Float32Array, n: number, step: number, x0: number): IslandBake {
  const ridge = new Float32Array(n * n), zone = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = x0 + i * step, z = x0 + j * step;
    // The range's own ground (terrain.ts mountainZone): north of the foot and on the headlands, above the shore.
    // The range's own slopes: north of the foot and on the headlands, off the flats and shores before them (the forest there
    // is the streamed forest's, or none: the lake's north shore is open).
    zone[j * n + i] = Math.max(smooth(z, mountainFoot(x) + 20, mountainFoot(x) + 60), smooth(Math.abs(x), 450, 510)) * smooth(heights[j * n + i], 12, 22);
    if (z > mountainFoot(x) - 40 || Math.abs(x) > 420) ridge[j * n + i] = mountainRidge(x, z);
  }
  const masks = mountainMasks(heights, ridge, n, step, k => heights[k] > 1), slopes = gridSlopes(heights, n, step);
  const cover = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, x = x0 + i * step, z = x0 + j * step;
    if (zone[k] <= 0) continue;
    const r = masks[k * 4] / 127.5 - 1, flow = masks[k * 4 + 1] / 255, debris = masks[k * 4 + 2] / 255, relief = masks[k * 4 + 3] / 127.5 - 1;
    const ny = 1 / Math.hypot(1, slopes[k]), n1 = noise01(x / 260, z / 260), n2 = noise01(x / 60 + 7, z / 60), n3 = noise01(x / 17 - 3, z / 17);
    const cliff = 1 - smooth(ny + (n3 - .5) * .07 - Math.max(r, 0) * .05, .6, .7);
    const scree = smooth(debris + (n3 - .5) * .12, .12, .45) * (1 - cliff);
    const line = ISLAND_TREE_LINE - r * 16 - relief * 22 + flow * 30 + (n1 - .5) * 44 + (n2 - .5) * 18;
    let f = (1 - smooth(heights[k], line - 6, line + 6)) * smooth(ny + (n3 - .5) * .06, .58, .66);
    const clumps = smooth(noise01(x / 14 + 3.1, z / 14) * .6 + n3 * .4 - Math.max(r, 0) * .3, .6, .7) * smooth(ny, .7, .8) * (1 - smooth(heights[k], line, line + 50));
    f = Math.max(f, clumps);
    const chute = smooth(flow + (n2 - .5) * .1, .5, .66) * smooth(ny, .68, .76) * (1 - smooth(ny, .89, .93));
    f *= (1 - smooth(scree, .4, .8)) * (1 - smooth(cliff, .3, .8)) * (1 - chute * .92);
    cover[k] = f * zone[k];
  }
  for (let k = 0; k < n * n; k++) masks[k * 4 + 3] = Math.round(clamp01(cover[k]) * 255);
  // Trees on a jittered grid 4.6 m apart (the forest's own spacing near the eye is about 6 m, but these are smaller), kept
  // where the cover says.
  const at = gridHeights(heights, n, step, x0, x0), coverAt = (x: number, z: number) => {
    const fx = Math.min(n - 1.001, Math.max(0, (x - x0) / step)), fz = Math.min(n - 1.001, Math.max(0, (z - x0) / step));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * n + i;
    return cover[k] * (1 - u) * (1 - v) + cover[k + 1] * u * (1 - v) + cover[k + n] * (1 - u) * v + cover[k + n + 1] * u * v;
  };
  const spacing = 4.6, list: number[] = [], extent = -x0;
  for (let j = 0; j * spacing < extent * 2; j++) for (let i = 0; i * spacing < extent * 2; i++) {
    const x = x0 + (i + .15 + .7 * treeHash(i, j, 1)) * spacing, z = x0 + (j + .15 + .7 * treeHash(i, j, 2)) * spacing;
    const c = coverAt(x, z);
    if (c < .05 || treeHash(i, j, 3) > c * 1.15 - .1) continue;
    // Full size (20 to 28 m, as the streamed forest's) low on the slopes, where the road passes close under them, down to 9 to
    // 15 m higher up and in the krummholz above the tree line. All at full size, the trees stood a fifth of these 150 to 210 m
    // massifs' height, the scale cue that says "hill"; all small, the ones over the tunnels' mouths were toys beside the real
    // trees 100 m away.
    const y = at(x, z), tall = 1 - smooth(y, 25, 70);
    list.push(x, y, z, (11 + 6 * treeHash(i, j, 4) + tall * 11) * (.6 + .4 * smooth(c, .2, .9)));
  }
  const trees = new Float32Array(list), count = trees.length / 4, base = new Float32Array(count * 3);
  // Their horizons are taken from a point a few metres up the trunk, so a tree's own slope does not shade it.
  for (let t = 0; t < count; t++) { base[t * 3] = trees[t * 4]; base[t * 3 + 1] = trees[t * 4 + 1] + 6; base[t * 3 + 2] = trees[t * 4 + 2]; }
  const treeHorizons = horizonAngles(base, count, at, step, 480);
  return { masks, trees, treeHorizons };
}
