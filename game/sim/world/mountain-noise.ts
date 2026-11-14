/**
 * Noise for mountains: gradient noise (value noise reads blocky along a crest) and Musgrave's ridged multifractal. Shared by the
 * island's range (coastal-geography.ts) and the far range (render/world/far-range-shape.ts). Pure maths, deterministic.
 */
import { erosionFilter, EROSION_DEFAULTS, type ErosionParams, type ErosionResult } from './erosion-filter';
// 2D gradient noise, about -1..1: value noise reads blocky at a ridge, and ridges are made from where this crosses zero.
const GRADIENTS = Array.from({ length: 256 }, (_, i) => { const a = (i * 2.399963229728653) % (Math.PI * 2); return [Math.cos(a), Math.sin(a)] as const; });
const PERM = (() => { const p = Array.from({ length: 256 }, (_, i) => i); let s = 1234567; for (let i = 255; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } return p; })();
const grad = (ix: number, iz: number, fx: number, fz: number) => { const g = GRADIENTS[PERM[(PERM[ix & 255] + iz) & 255]]; return g[0] * fx + g[1] * fz; };
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
export function gradientNoise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, u = fade(fx), v = fade(fz);
  const a = grad(ix, iz, fx, fz), b = grad(ix + 1, iz, fx - 1, fz), c = grad(ix, iz + 1, fx, fz - 1), d = grad(ix + 1, iz + 1, fx - 1, fz - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.41;
}
/**
 * Ridged multifractal, 0..1: sharp crests where the noise crosses zero, each octave weighted by the one before it so the fine
 * crags sit on the high ridges and the valleys stay smooth (Musgrave's construction).
 */
export function ridged(x: number, z: number, octaves: number) {
  let sum = 0, total = 0, amplitude = 1, frequency = 1, weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(gradientNoise(x * frequency + i * 19.1, z * frequency - i * 7.7));
    n *= n; n *= weight;
    weight = Math.min(1, Math.max(0, n * 1.7));
    sum += n * amplitude; total += amplitude;
    amplitude *= .5; frequency *= 2.07;
  }
  return sum / total;
}

// ---- Erosion: Rune Skovbo Johansen's Advanced Terrain Erosion Filter (erosion-filter.ts, MPL-2.0), in metres. It replaced a
// Clay John style filter (cosine stripes across the slope) whose soft gullies on both sides of every crest read as crumpled
// foil; this one keeps crests sharp and valley floors clean, joins its gullies downhill and gives a ridge map for the shading.
export type { ErosionResult };
export { EROSION_DEFAULTS };
/**
 * Erosion of land of height h (metres) and slope (sx, sz) at (x, z), the filter run in units of `unit` metres (so its gullies are
 * params.scale x unit apart at their widest). fadeTarget: -1 valley .. +1 peak (see erosion-filter.ts). Height and slopes
 * come back in metres and rise over run; ridge -1 (gully line) .. +1 (ridge line).
 */
export function erodeMetres(x: number, z: number, h: number, sx: number, sz: number, fadeTarget: number, unit: number, params: ErosionParams, out: ErosionResult) {
  erosionFilter(x / unit, z / unit, h / unit, sx, sz, fadeTarget, params, out);
  out.height *= unit; out.magnitude *= unit;
  return out;
}
