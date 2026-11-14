/**
 * Geology masks for the mountains' shading, read from the final heightfield rather than painted with noise: real mountains are
 * forest, scree, rock and snow where the slope, the drainage and the cliffs put them, and a noise mask draws none of that (the
 * first surface's smooth olive ramp up every massif was the noise tree line). Pure maths over a square grid of heights; the
 * island's range bakes it once at load in a worker (render/world/mountain-bake-worker.ts), the far range per vertex.
 *
 * Four channels, 0..255:
 *   R ridge   the erosion filter's ridge map (erosion-filter.ts), 128 neutral: low on gully lines, high on ridge lines.
 *   G flow    drainage: how much of the slope above drains through here (multiple-flow routing, log scale). Gullies, couloirs
 *             and the chutes avalanches run down are the high values; ridges and summits are 0.
 *   B debris  rock fallen from the cliffs above: carried down the fall line from every face steeper than about 55 degrees and
 *             dropped where the slope eases (talus cones at the cliffs' feet, scree fans below the couloirs).
 *   A relief  where the point sits against the land round it (height less its 40 m Gaussian mean), 128 level: low in hollows
 *             and valleys, high on spurs and crests.
 */
const clamp01 = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t;
const smooth = (x: number, a: number, b: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const;

/** Slope (rise over run) of every cell, central differences. */
export function gridSlopes(h: Float32Array, n: number, step: number) {
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const l = h[j * n + Math.max(0, i - 1)], r = h[j * n + Math.min(n - 1, i + 1)], d = h[Math.max(0, j - 1) * n + i], u = h[Math.min(n - 1, j + 1) * n + i];
    out[j * n + i] = Math.hypot((r - l) / ((Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * step), (u - d) / ((Math.min(n - 1, j + 1) - Math.max(0, j - 1)) * step));
  }
  return out;
}

/** Cells in order of height, highest first: water and rock both go downhill, so one pass in this order routes everything. */
function downhillOrder(h: Float32Array) { return Array.from(h.keys()).sort((a, b) => h[b] - h[a]); }

/**
 * Drainage area of every cell, in cells, by multiple-flow routing (Freeman 1991: each cell shares its water among all its lower
 * neighbours in proportion to the drop over the distance, to the power 1.1), only where `active` (land the masks matter on).
 */
export function flowAccumulation(h: Float32Array, n: number, active: (k: number) => boolean, order = downhillOrder(h)) {
  const acc = new Float32Array(n * n), w = new Float32Array(8);
  for (const k of order) {
    if (!active(k)) continue;
    acc[k] += 1;
    const i = k % n, j = (k - i) / n;
    let total = 0;
    for (let q = 0; q < 8; q++) {
      const [di, dj] = NEIGHBOURS[q], ii = i + di, jj = j + dj;
      w[q] = 0;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const drop = (h[k] - h[jj * n + ii]) / (q < 4 ? 1 : Math.SQRT2);
      if (drop > 0) { w[q] = Math.pow(drop, 1.1); total += w[q]; }
    }
    if (total <= 0) continue;
    for (let q = 0; q < 8; q++) if (w[q] > 0) { const [di, dj] = NEIGHBOURS[q]; acc[(j + dj) * n + i + di] += acc[k] * w[q] / total; }
  }
  return acc;
}

/**
 * Rock fallen from the faces: every cell steeper than about 55 degrees sheds debris, which runs down the fall line, keeps going
 * while the slope stays steep and comes to rest as it eases below the angle of repose (about 35 degrees), so it gathers in cones
 * and fans at the foot of the cliffs and the couloirs. 1 where a lot has come to rest, 0 where none reaches.
 */
export function debrisFans(h: Float32Array, n: number, step: number, slopes: Float32Array, order = downhillOrder(h)) {
  const carried = new Float32Array(n * n), rest = new Float32Array(n * n);
  // Per cell length: on a steep run a block keeps 97% of its load per 4 m; on easy ground it stops within about 15 m.
  const keepSteep = Math.pow(.97, step / 4), keepEasy = Math.pow(.72, step / 4);
  for (const k of order) {
    const s = slopes[k];
    carried[k] = Math.max(carried[k], smooth(s, 1.3, 1.9));
    if (carried[k] <= .01) continue;
    // What comes to rest here: more where the slope eases below the angle of repose.
    rest[k] = Math.max(rest[k], carried[k] * (1 - smooth(s, .55, .95)) * smooth(s, .12, .35));
    const keep = keepEasy + (keepSteep - keepEasy) * smooth(s, .45, .9);
    const i = k % n, j = (k - i) / n;
    let best = -1, drop = 0;
    for (let q = 0; q < 8; q++) {
      const [di, dj] = NEIGHBOURS[q], ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const d = (h[k] - h[jj * n + ii]) / (q < 4 ? 1 : Math.SQRT2);
      if (d > drop) { drop = d; best = jj * n + ii; }
    }
    if (best < 0) continue;
    carried[best] = Math.max(carried[best], carried[k] * keep);
    // Fans spread: a little goes to the two cells beside the fall line too.
    const bi = best % n, bj = (best - bi) / n;
    for (const [oi, oj] of [[bj - j, -(bi - i)], [-(bj - j), bi - i]]) {
      const ii = bi + oi, jj = bj + oj;
      if (ii >= 0 && jj >= 0 && ii < n && jj < n && h[jj * n + ii] < h[k]) carried[jj * n + ii] = Math.max(carried[jj * n + ii], carried[k] * keep * .82);
    }
  }
  return rest;
}

/** A separable Gaussian blur of the grid (sigma in cells), edges clamped. */
export function gaussian(h: Float32Array, n: number, sigma: number) {
  const r = Math.ceil(sigma * 2.5), kernel = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = kernel.reduce((a, b) => a + b, 0), tmp = new Float32Array(n * n), out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0; for (let q = -r; q <= r; q++) s += h[j * n + Math.min(n - 1, Math.max(0, i + q))] * kernel[q + r]; tmp[j * n + i] = s / sum; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0; for (let q = -r; q <= r; q++) s += tmp[Math.min(n - 1, Math.max(0, j + q)) * n + i] * kernel[q + r]; out[j * n + i] = s / sum; }
  return out;
}

/**
 * The four masks for an n x n grid of heights `step` metres apart, with the erosion filter's ridge map alongside (-1..1, 0 where
 * there is none) and `active` saying which cells are mountain (drainage is only routed there). RGBA bytes, row by row.
 */
export function mountainMasks(h: Float32Array, ridge: Float32Array, n: number, step: number, active: (k: number) => boolean) {
  const order = downhillOrder(h), slopes = gridSlopes(h, n, step);
  const flow = flowAccumulation(h, n, active, order), debris = debrisFans(h, n, step, slopes, order);
  const mean = gaussian(h, n, 40 / step), out = new Uint8Array(n * n * 4);
  // Drainage as convergence: the log of the area drained against its mean over the land round it (Gaussian, 24 m). Taken alone,
  // multiple-flow area grows with the length of any slope, and every long face read as a gully; against its neighbours only the
  // lines the water gathers into stand out. Small catchments (under about 400 m2) are left out.
  const logArea = new Float32Array(n * n), area = step * step;
  for (let k = 0; k < n * n; k++) logArea[k] = Math.log(Math.max(1, flow[k] * area));
  const meanLog = gaussian(logArea, n, 24 / step);
  for (let k = 0; k < n * n; k++) {
    out[k * 4] = Math.round(clamp01(.5 + .5 * ridge[k]) * 255);
    out[k * 4 + 1] = active(k) ? Math.round(clamp01((logArea[k] - meanLog[k]) * .45) * smooth(logArea[k], 5, 7.5) * 255) : 0;
    out[k * 4 + 2] = Math.round(clamp01(debris[k] * 1.2) * 255);
    out[k * 4 + 3] = Math.round(clamp01(.5 + (h[k] - mean[k]) / 50) * 255);
  }
  return out;
}
