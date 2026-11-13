import test from 'node:test';
import assert from 'node:assert/strict';
import { luminance, boxBlur, highPass, tileCoherence, groundTiles, coherence, ghostIndex, summary, decodeLevel, modeOf } from '../../../tools/ghosting/metrics.mjs';

const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const N = 128;
/** A stand-in for a scan: noise blurred to a correlation length of a few pixels. */
function scan(seed) {
  const random = rng(seed), raw = new Float32Array(N * N);
  for (let i = 0; i < raw.length; i++) raw[i] = random();
  return boxBlur(boxBlur(raw, N, N, 1), N, N, 1);
}

test('luminance weights green most and keeps black and white', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
  const lum = luminance(rgba, 4, 1);
  assert.ok(Math.abs(lum[0] - 1) < 1e-6 && lum[1] === 0);
  assert.ok(lum[2] > lum[3] && Math.abs(lum[2] - .7152) < 1e-6);
});

test('a box blur keeps a constant image and spreads an impulse evenly', () => {
  const flat = new Float32Array(N * N).fill(.4), blurred = boxBlur(flat, N, N, 3);
  for (const v of blurred) assert.ok(Math.abs(v - .4) < 1e-6);
  const spike = new Float32Array(N * N); spike[64 * N + 64] = 49;
  const out = boxBlur(spike, N, N, 3);
  assert.ok(Math.abs(out[64 * N + 64] - 1) < 1e-5 && Math.abs(out[61 * N + 67] - 1) < 1e-5 && out[60 * N + 64] === 0);
  const hp = highPass(flat, N, N);
  for (const v of hp) assert.ok(Math.abs(v) < 1e-6);
});

test('coherence is high for a smooth texture and about zero for white noise', () => {
  const smooth = highPass(scan(1), N, N), random = rng(9), noise = new Float32Array(N * N);
  for (let i = 0; i < noise.length; i++) noise[i] = random();
  assert.ok(tileCoherence(smooth, N, 16, 16, 32) > .3);
  assert.ok(Math.abs(tileCoherence(noise, N, 16, 16, 32)) < .1);
  assert.ok(tileCoherence(new Float32Array(N * N), N, 0, 0, 32) === 1, 'an empty tile is not a ghost');
});

test('a texture read from jumping places scores far below the same texture read smoothly', () => {
  // What the first version's march did: each pixel reads the scan a few pixels away from where its neighbour reads.
  const source = scan(5), random = rng(21), clean = new Float32Array(N * N), shifted = new Float32Array(N * N), jumpy = new Float32Array(N * N);
  const at = (x, y) => source[((y + N) % N) * N + ((x + N) % N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    clean[y * N + x] = at(x, y);
    shifted[y * N + x] = at(x + 3, y + 2);                                              // a parallax shift: the same everywhere
    jumpy[y * N + x] = at(x + Math.floor(random() * 13) - 6, y + Math.floor(random() * 13) - 6);   // a different one at every pixel
  }
  const tiles = groundTiles(new Uint8Array(N * N).fill(1), N, N, { size: 32, stride: 16 });
  const c = coherence(clean, N, N, tiles).mean, s = coherence(shifted, N, N, tiles).mean, j = coherence(jumpy, N, N, tiles).mean;
  assert.ok(Math.abs(s - c) < .02, `a shift keeps the coherence (${c} -> ${s})`);
  assert.ok(ghostIndex(s, c) < .05);
  assert.ok(ghostIndex(j, c) > .5, `jumping reads lose it (${c} -> ${j})`);
  assert.equal(ghostIndex(c * 1.3, c), 0, 'a smoother picture is not ghosted');
});

test('ground tiles keep to the ground, to the rows asked for, and to the cover asked for', () => {
  const mask = new Uint8Array(N * N);
  for (let y = 64; y < N; y++) for (let x = 0; x < N; x++) mask[y * N + x] = 1;     // the lower half is ground
  const all = groundTiles(mask, N, N, { size: 32, stride: 16 });
  assert.ok(all.length > 0 && all.every(t => t.y >= 64));
  assert.ok(groundTiles(mask, N, N, { size: 32, stride: 16, yMin: 96 }).every(t => t.y >= 96));
  mask[100 * N + 40] = 0;   // one pixel of grass in a tile: still ground at 90% cover, not at 100%
  assert.ok(groundTiles(mask, N, N, { size: 32, stride: 16, cover: 1 }).length < all.length);
  assert.equal(groundTiles(mask, N, N, { size: 32, stride: 16, cover: .9 }).length, all.length);
});

test('a number read back through the post chain is decoded by the ramp drawn beside it', () => {
  // A curve like a tone mapper: the byte is not the level, but the ramp says what each level came out as.
  const table = [0, .02, .05, .1, .2, .4, .7].map(level => ({ level, byte: Math.round(255 * Math.pow(level, .6)) }));
  for (const level of [0, .03, .1, .25, .55, .7]) {
    const byte = 255 * Math.pow(level, .6);
    assert.ok(Math.abs(decodeLevel(table, byte) - level) < .02, `${level} -> ${byte} -> ${decodeLevel(table, byte)}`);
  }
  assert.equal(decodeLevel(table, 0), 0);
  assert.equal(decodeLevel(table, 255), .7);
  assert.equal(modeOf([3, 7, 7, 9, 7, 3]), 7);
});

test('a summary gives the mean, median, 90th percentile and the share over each threshold', () => {
  const s = summary(Array.from({ length: 100 }, (_, i) => i / 10), [5, 9.5]);
  assert.equal(s.n, 100);
  assert.ok(Math.abs(s.mean - 4.95) < 1e-9 && s.p50 === 5 && s.p90 === 9);
  assert.deepEqual(s.over.map(v => Math.round(v * 100)), [49, 4]);
  assert.equal(summary([], [1]).n, 0);
});
