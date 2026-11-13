/**
 * Noise for mountains: gradient noise (value noise reads blocky along a crest) and Musgrave's ridged multifractal. Shared by the
 * island's range (coastal-geography.ts) and the far range (render/world/far-range-shape.ts). Pure maths, deterministic.
 */
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

// ---- Erosion filter (after Clay John's "Eroded Terrain Noise", 2022). From cells on a jittered grid, cosine stripes run
// across the slope direction, so their troughs run down the fall line: gullies. Each octave turns its stripes by the slope the
// octaves before it carved, so the finer gullies run into the bigger ones and branch, as drainage does. Pure maths, no simulation:
// any point's height is known on its own, which the terrain worker, the colliders and the tests all need.
const cellHash = (ix: number, iz: number) => {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return [(h & 0xffff) / 65536, ((h >>> 16) & 0xffff) / 65536] as const;
};
/** One octave at p (in cells) for a cross-slope vector dir: [value -1..1, d/dx, d/dz] (in cells). */
function gullyOctave(px: number, pz: number, dx: number, dz: number, out: number[]) {
  const ix = Math.floor(px), iz = Math.floor(pz), fx = px - ix, fz = pz - iz;
  let v = 0, gx = 0, gz = 0, wt = 0;
  for (let i = -2; i <= 1; i++) for (let j = -2; j <= 1; j++) {
    const [hx, hz] = cellHash(ix - i, iz - j), ppx = fx + i - hx * .5, ppz = fz + j - hz * .5;
    const w = Math.exp(-(ppx * ppx + ppz * ppz) * 2), mag = (ppx * dx + ppz * dz) * Math.PI * 2, s = Math.sin(mag);
    v += Math.cos(mag) * w; gx -= s * dx * w; gz -= s * dz * w; wt += w;
  }
  out[0] = v / wt; out[1] = gx / wt; out[2] = gz / wt;
}
const octave = [0, 0, 0];
/**
 * Gullies carved into land of slope (sx, sz) (rise over run) at (x, z) metres: the height to add, in metres. `spacing` is the
 * widest gullies' spacing, `depth` their depth; each finer octave halves both. Level ground is left level (the stripes need a
 * slope to run down).
 */
export function erosionFilter(x: number, z: number, sx: number, sz: number, spacing: number, depth: number, octaves = 5) {
  let h = 0, hx = 0, hz = 0, a = 1, f = 1, total = 0;
  // Only the flanks are cut: near a summit, where the slope eases, the crest stays whole (cut there, it broke into a comb of spires).
  const slope = Math.hypot(sx, sz), t = Math.min(1, Math.max(0, (slope - .12) / .5)), fade = t * t * (3 - 2 * t);
  for (let k = 0; k < octaves; k++) {
    // The cross-slope direction, turned by the slope of the gullies carved so far (in cells of this octave): branching.
    // The slope's pull (3) over the carved gullies' (1.2): stronger branching curled them into whorls.
    const dx = (sz * 3 + hz * 1.2), dz = (-sx * 3 - hx * 1.2);
    gullyOctave(x * f / spacing, z * f / spacing, dx, dz, octave);
    h += octave[0] * a; hx += octave[1] * a * f; hz += octave[2] * a * f; total += a;
    a *= .5; f *= 2;
  }
  return (h / total - .45) * depth * fade;
}
