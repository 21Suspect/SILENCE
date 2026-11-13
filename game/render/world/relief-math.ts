/**
 * The maths of the ground's relief, in plain TypeScript: the parallax march and the patch height blend of the ground shader
 * (terrain.ts, texture-variation.ts). The game runs the GLSL; this is its line-for-line mirror so the maths can be tested on
 * height fields whose answer is known (tests/render/world/relief-math.test.mjs), and so the choices below keep their reasons
 * written next to numbers. Change one, change the other.
 *
 * Why the march looks like this. The first version of the ground's parallax stepped ten times through the whole 0..1 of a scan's
 * height map, in cubed-up depths of 14 to 22 cm: one step moved the texture lookup 2 to 5 cm, which is 4 to 8 pixels at the
 * distance a path is seen from, so neighbouring pixels read unrelated places of the scan and every stone came out as speckled,
 * repeated fragments ("layers of the texture on top of one another", work/gfx/research/ghosting). Three things fix it:
 * march only the band of heights the scan uses, take as many steps as it takes to keep one step near a pixel of shift, and find
 * the crossing inside the last step by bisection, not by one straight line between two samples that may lie on different stones.
 */

/**
 * How many steps cover a ray whose whole depth shifts the lookup by `shift` metres, on ground one pixel of which is `footprint`
 * metres wide, when one step may move the lookup `pixelsPerStep` pixels: between `minSteps` (looking straight down, where the
 * shift is tiny) and `maxSteps` (the cost bound, reached at grazing views of deep relief close to the eye).
 */
export function reliefSteps(shift: number, footprint: number, pixelsPerStep: number, minSteps: number, maxSteps: number) {
  return Math.min(maxSteps, Math.max(minSteps, Math.ceil(shift / (footprint * pixelsPerStep))));
}

/**
 * Where a view ray meets a relief, as a fraction (0..1) of the depth of the band `top` down to `bottom`. `height(t)` is the
 * relief's height (the scan's own 0..1 values) under the point of the ray at fraction t of its way down; a ray that is inside the
 * relief at t = 0 hits at 0, one that never meets it runs on to the floor (1). The ray is stepped `steps` times, and the last
 * step, the one that crosses, is bisected `refine` times; the answer is the straight line through what is left of it.
 */
export function reliefHit(height: (t: number) => number, top: number, bottom: number, steps: number, refine: number, maxSteps = 128) {
  const inv = 1 / (top - bottom), above = (t: number) => (top - height(t)) * inv - t;
  const dz = 1 / steps;
  let g = above(0), d = 0, dLo = 0, gLo = g;
  for (let i = 0; i < maxSteps; i++) {
    if (g <= 0 || i >= steps) break;
    gLo = g; dLo = d; d += dz;
    g = above(d);
  }
  let lo = dLo, hi = d, gl = gLo, gh = g;
  if (g <= 0 && d > 0) for (let i = 0; i < refine; i++) {
    const mid = .5 * (lo + hi), gm = above(mid);
    if (gm > 0) { lo = mid; gl = gm; } else { hi = mid; gh = gm; }
  }
  if (g > 0) return d;
  if (d <= 0) return 0;
  return lo + (hi - lo) * (gl / Math.max(gl - gh, 1e-4));
}

/**
 * The patch taps' height blend: each tap stands at its height (the scan's alpha) plus how much the plain blend wants it
 * (`weights`), and within `band` of the highest the taps share, so one crop of the scan shows and the edge between two follows the
 * relief. Returns weights that sum to 1. The band must be above 0 (the shader's band of 0 means the plain blend and skips this).
 * A plain weight over .93 always takes the whole pixel with a band of .16, which is what lets the shader read one tap there.
 */
export function patchHeightBlend(weights: readonly [number, number, number], heights: readonly [number, number, number], band: number): [number, number, number] {
  const score = weights.map((w, i) => w + heights[i] * .7), top = Math.max(...score) - band;
  const b = score.map(s => Math.max(s - top, 0)), sum = Math.max(b[0] + b[1] + b[2], 1e-5);
  return [b[0] / sum, b[1] / sum, b[2] / sum];
}

/** How many scan copies show in a pixel: 1 / the sum of the squared weights (1 for one tap, 3 for three equal ones). */
export function layerCount(weights: readonly number[]) {
  return 1 / Math.max(weights.reduce((s, w) => s + w * w, 0), 1e-4);
}
