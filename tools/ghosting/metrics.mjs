// The numbers behind the ghosting diagnostic (tools/ghosting/page.js): pure functions on pixel arrays, so the page and the tests share them.
//
// What "ghosting" is here: on the forest floor a feature (a pebble, a needle, a leaf) is drawn more than once, as if layers of the
// scan were stacked. In the first version of the ground shader that was the parallax march: its steps shifted the texture lookup
// by several pixels, so neighbouring pixels read unrelated places of the scan and every stone came out as speckled fragments.
// Neighbouring pixels of a real surface read neighbouring places, so a texture's high-pass is strongly correlated from one pixel to
// the next; each pixel that is fed from somewhere else breaks that. The image-space number is that correlation (coherence), and
// the ghost index is how much of it a render loses against the same render with the parallax switched off.

/** Rec. 709 luminance (0..1) of 8-bit RGBA pixels. */
export function luminance(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * .2126 + rgba[j + 1] * .7152 + rgba[j + 2] * .0722) / 255;
  return out;
}

/** Box blur of half-width r (a (2r+1) square), edges clamped, in two passes. */
export function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / k;
      sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / k;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** What is left of the picture once its broad shading (a 7 x 7 box for r = 3) is taken away. */
export function highPass(a, w, h, r = 3) {
  const low = boxBlur(a, w, h, r), out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = a[i] - low[i];
  return out;
}

/** Correlation of a size x size tile of `a` with itself one pixel over, averaged over across and down (mean removed). */
export function tileCoherence(a, w, x0, y0, size) {
  let mean = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) mean += a[(y0 + y) * w + x0 + x];
  mean /= size * size;
  let energy = 0, across = 0, down = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = a[(y0 + y) * w + x0 + x] - mean;
    energy += v * v;
    if (x + 1 < size) across += v * (a[(y0 + y) * w + x0 + x + 1] - mean);
    if (y + 1 < size) down += v * (a[(y0 + y + 1) * w + x0 + x] - mean);
  }
  return energy < 1e-12 ? 1 : (across + down) / (2 * energy);
}

/**
 * Tiles (top-left corners) of `size` pixels, `stride` apart, whose pixels are at least `cover` ground in `mask` (1 = ground),
 * from row `yMin` down. Tiles over grass, trunks and the sky are left out, so the number is about the ground's own texture.
 */
export function groundTiles(mask, w, h, { size = 32, stride = 16, cover = .9, yMin = 0 } = {}) {
  const tiles = [];
  for (let y = Math.max(0, yMin); y + size <= h; y += stride) for (let x = 0; x + size <= w; x += stride) {
    let n = 0;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) n += mask[(y + j) * w + x + i];
    if (n >= cover * size * size) tiles.push({ x, y });
  }
  return tiles;
}

/** Coherence of each tile (and their mean) of the high-pass of a luminance image. */
export function coherence(lum, w, h, tiles, size = 32) {
  const hp = highPass(lum, w, h), scores = tiles.map(t => tileCoherence(hp, w, t.x, t.y, size));
  return { mean: scores.reduce((s, v) => s + v, 0) / Math.max(1, scores.length), scores };
}

/** How much of the reference's coherence a render lost: 0 none, 1 all. Never negative (a smoother picture is not ghosted). */
export function ghostIndex(coherenceValue, referenceCoherence) {
  return Math.max(0, 1 - coherenceValue / Math.max(referenceCoherence, 1e-6));
}

/** Mean, median, 90th percentile and the share above each threshold. */
export function summary(values, thresholds = []) {
  const v = Array.from(values).sort((a, b) => a - b), n = v.length;
  if (!n) return { n: 0, mean: 0, p50: 0, p90: 0, over: thresholds.map(() => 0) };
  const at = q => v[Math.min(n - 1, Math.floor(q * n))];
  return { n, mean: v.reduce((s, x) => s + x, 0) / n, p50: at(.5), p90: at(.9), over: thresholds.map(t => v.filter(x => x > t).length / n) };
}

/**
 * Read a value back through the post-processing chain. The page draws known levels (a ramp) in the same frame state as the
 * debug view; `table` is those levels with the byte each came out as, and a byte is turned back into a level by a straight line
 * between the two entries either side of it.
 */
export function decodeLevel(table, byte) {
  const t = table;
  if (byte <= t[0].byte) return t[0].level;
  for (let i = 1; i < t.length; i++) {
    if (byte <= t[i].byte) {
      const span = t[i].byte - t[i - 1].byte;
      return span <= 0 ? t[i].level : t[i - 1].level + (t[i].level - t[i - 1].level) * (byte - t[i - 1].byte) / span;
    }
  }
  return t[t.length - 1].level;
}

/** The most common value of an array of bytes (the ground's own grey in a debug frame). */
export function modeOf(bytes) {
  const counts = new Uint32Array(256);
  for (const b of bytes) counts[b]++;
  let best = 0;
  for (let i = 1; i < 256; i++) if (counts[i] > counts[best]) best = i;
  return best;
}
