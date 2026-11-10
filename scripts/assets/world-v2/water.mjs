// Bakes the two tileable river textures the water shader samples.
//   node scripts/assets/world-v2/water.mjs
//
//   water-normal.png  512x512 RGB. R,G are the surface slope along each texture axis (127.5 = flat; the shader decodes t*2-1),
//                     B is the height, so the shader can bend the bed without a second read.
//                     Spectral synthesis: white noise filtered in the Fourier domain, so it tiles exactly and carries
//                     everything from 40 cm swell to 2 mm capillary wrinkles. Three bands each get their own calm and
//                     rough patches, and a Gerstner-style crest sharpening so crests are narrow and troughs are broad.
//   water-foam.png    512x512 RGB. R: bubbles (soft discs with a bright rim, three sizes), G: lace (thin filaments between
//                     bubble cells), B: a smooth clumping mask that gathers both into patches.
//
// Dependency free and deterministic: the same files come out every run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname, '../../../public/world/water');
fs.mkdirSync(OUT, { recursive: true });
const N = 512;
/** Slope that maps to a full-scale byte. Slopes beyond it clip. */
export const SLOPE_RANGE = 1;

let seed = 20240917;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(6.283185307 * rnd());

// ---- 2D FFT (radix 2, in place) -------------------------------------------------------------------------------
function fft1(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function fft2(re, im, inverse) {
  const rr = new Float64Array(N), ri = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) { rr[x] = re[y * N + x]; ri[x] = im[y * N + x]; }
    fft1(rr, ri, inverse);
    for (let x = 0; x < N; x++) { re[y * N + x] = rr[x]; im[y * N + x] = ri[x]; }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]; ri[y] = im[y * N + x]; }
    fft1(rr, ri, inverse);
    for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]; im[y * N + x] = ri[y]; }
  }
}
const freq = i => (i < N / 2 ? i : i - N);
/** Real field of Gaussian noise filtered by `filter(kx, ky)` (cycles per tile). Tiles exactly. */
function filtered(filter, noise) {
  const re = Float64Array.from(noise), im = new Float64Array(N * N);
  fft2(re, im, false);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const f = filter(freq(x), freq(y)); re[y * N + x] *= f; im[y * N + x] *= f; }
  fft2(re, im, true);
  return re;
}
const whiteNoise = () => { const a = new Float64Array(N * N); for (let i = 0; i < a.length; i++) a[i] = gauss(); return a; };
const normalise = a => { let s = 0; for (const v of a) s += v * v; const k = 1 / Math.sqrt(s / a.length); for (let i = 0; i < a.length; i++) a[i] *= k; return a; };
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- surface -------------------------------------------------------------------------------------------------
// Bands in cycles per tile. Each has its own spectral slope and its own patchiness, so rough and calm water sit
// side by side instead of the same wrinkle repeating everywhere. `weight` is the band's share of the slope energy,
// not of the height, so the fine band does not drown the swell. Nothing above k=105 (under five texels a wave):
// that is only aliasing once the texture is minified.
const BANDS = [
  { lo: 2.5, hi: 10, power: 1.2, patch: [.45, 1.3], crest: .5, weight: 1.0 },
  { lo: 9, hi: 34, power: 1.2, patch: [.2, 1.5], crest: .9, weight: .9 },
  { lo: 30, hi: 105, power: 1.2, patch: [.1, 1.7], crest: .6, weight: .62 },
];
function slopeRms(height) { const [a, b] = slopes(height); let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i] + b[i] * b[i]; return Math.sqrt(s / (2 * a.length)); }
function surface() {
  const height = new Float64Array(N * N);
  for (const b of BANDS) {
    const band = normalise(filtered((kx, ky) => {
      const k = Math.hypot(kx, ky);
      if (k < 1e-6) return 0;
      // A touch of anisotropy: the current pulls crests across the flow, so slightly more power at ky=0.
      const aniso = 1 + .35 * Math.abs(kx) / (k + 1e-6);
      return aniso * Math.pow(k, -b.power) * smoothstep(b.lo * .6, b.lo * 1.2, k) * (1 - smoothstep(b.hi * .85, b.hi, k));
    }, whiteNoise()));
    const patch = normalise(filtered((kx, ky) => { const k = Math.hypot(kx, ky); return k < 1e-6 || k > 7 ? 0 : 1 / (1 + k * k * .08); }, whiteNoise()));
    const shaped = new Float64Array(N * N);
    for (let i = 0; i < shaped.length; i++) {
      const m = b.patch[0] + (b.patch[1] - b.patch[0]) * smoothstep(-1.1, 1.1, patch[i]);
      let h = band[i];
      // Narrow crests, broad troughs.
      h = h > 0 ? h * (1 + b.crest * h * .35) : h * (1 - b.crest * .2);
      shaped[i] = h * m;
    }
    const k = b.weight / slopeRms(shaped);
    for (let i = 0; i < height.length; i++) height[i] += shaped[i] * k;
  }
  return height;
}
/** Spectral derivative: exact on a periodic field. Slope per texel step times N, so bands compare directly. */
function slopes(height) {
  const re = Float64Array.from(height), im = new Float64Array(N * N);
  fft2(re, im, false);
  const sx = [new Float64Array(N * N), new Float64Array(N * N)], sy = [new Float64Array(N * N), new Float64Array(N * N)];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, kx = freq(x), ky = freq(y);
    // d/dx (i k): (a + ib) * (i k) = -b k + i a k
    sx[0][i] = -im[i] * kx; sx[1][i] = re[i] * kx;
    sy[0][i] = -im[i] * ky; sy[1][i] = re[i] * ky;
  }
  fft2(sx[0], sx[1], true); fft2(sy[0], sy[1], true);
  return [sx[0], sy[0]];
}

const heightField = surface();
const [gx, gy] = slopes(heightField);
// Scale so the RMS slope sits at .28 of full scale (the shader multiplies it back up per layer).
let rms = 0; for (let i = 0; i < gx.length; i++) rms += gx[i] * gx[i] + gy[i] * gy[i];
rms = Math.sqrt(rms / (2 * gx.length));
const slopeScale = .28 / rms;
let hmin = Infinity, hmax = -Infinity; for (const v of heightField) { hmin = Math.min(hmin, v); hmax = Math.max(hmax, v); }
const normalRGB = new Uint8Array(N * N * 3);
let clipped = 0;
for (let i = 0; i < N * N; i++) {
  const sxv = gx[i] * slopeScale, syv = gy[i] * slopeScale;
  if (Math.abs(sxv) > SLOPE_RANGE || Math.abs(syv) > SLOPE_RANGE) clipped++;
  normalRGB[i * 3] = Math.max(0, Math.min(255, Math.round(127.5 + sxv / SLOPE_RANGE * 127.5)));
  normalRGB[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(127.5 + syv / SLOPE_RANGE * 127.5)));
  normalRGB[i * 3 + 2] = Math.round((heightField[i] - hmin) / (hmax - hmin) * 255);
}

// ---- foam ----------------------------------------------------------------------------------------------------
/** Periodic Worley: returns [F1, F2] distance for every texel, cell count `c` per tile. */
function worley(c) {
  const pts = []; for (let i = 0; i < c * c; i++) pts.push([rnd(), rnd(), rnd()]);
  const f1 = new Float32Array(N * N), f2 = new Float32Array(N * N), id = new Float32Array(N * N), cell = N / c;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let d1 = 1e9, d2 = 1e9, who = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx2 = cx + ox, gy2 = cy + oy, wx = ((gx2 % c) + c) % c, wy = ((gy2 % c) + c) % c, p = pts[wy * c + wx];
      const dx = (gx2 + p[0]) * cell - x, dy = (gy2 + p[1]) * cell - y, d = Math.hypot(dx, dy) / cell;
      if (d < d1) { d2 = d1; d1 = d; who = p[2]; } else if (d < d2) d2 = d;
    }
    f1[y * N + x] = d1; f2[y * N + x] = d2; id[y * N + x] = who;
  }
  return { f1, f2, id };
}
const lowpass = (kmin, kmax, power) => normalise(filtered((kx, ky) => { const k = Math.hypot(kx, ky); return k < 1e-6 ? 0 : Math.pow(k, -power) * smoothstep(kmin * .6, kmin, k) * (1 - smoothstep(kmax * .8, kmax, k)); }, whiteNoise()));
const clump = lowpass(1, 10, 1.2);
// Froth: bubbles a few texels across, packed edge to edge, each a soft disc brightest at its rim. The larger bubbles
// sit only in the cores of the patches and the smallest scatter far out, so a patch thins into stray bubbles
// at its edges the way real foam does. Each size has its own patch mask.
const bubbles = new Float32Array(N * N);
for (const [cells, radius, gain, from] of [[84, .62, 1, .15], [150, .6, .9, -.15], [250, .58, .8, -.5]]) {
  const w = worley(cells), patch = lowpass(1.5, 14, 1.1);
  for (let i = 0; i < N * N; i++) {
    const r = radius * (.55 + .45 * w.id[i]), d = w.f1[i] / r;
    const disc = 1 - smoothstep(.78, 1, d), rim = smoothstep(.3, .8, d);
    bubbles[i] = Math.max(bubbles[i], disc * (.6 + .4 * rim) * gain * smoothstep(from, from + .55, patch[i]));
  }
}
// Lace: the zero contours of two band-limited noise fields, drawn at constant width (the field divided by its own
// gradient), so the filaments wander and loop instead of meeting at the fixed angles of a Voronoi network.
const lace = new Float32Array(N * N);
for (const [kmin, kmax, widthTexels, gain] of [[5, 15, 1.7, 1], [14, 40, 1.3, .65]]) {
  const f = lowpass(kmin, kmax, .9), [fx, fy] = slopes(f), patch = lowpass(1.2, 9, 1.1);
  // slopes() is per N-th of the tile; convert to per texel.
  for (let i = 0; i < N * N; i++) {
    const g = Math.hypot(fx[i], fy[i]) * (2 * Math.PI / N) + 1e-6, dist = Math.abs(f[i]) / g;
    lace[i] = Math.max(lace[i], (1 - smoothstep(widthTexels * .35, widthTexels, dist)) * gain * smoothstep(-.5, .35, patch[i]));
  }
}
// Warp the lace a little so the contours are not perfectly smooth.
const warpX = lowpass(2, 12, 1.4), warpY = lowpass(2, 12, 1.4);
const lacew = new Float32Array(N * N);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const sx = Math.round(x + warpX[y * N + x] * 3 + N * 4) % N, sy = Math.round(y + warpY[y * N + x] * 3 + N * 4) % N;
  lacew[y * N + x] = lace[sy * N + sx];
}
const foamRGB = new Uint8Array(N * N * 3);
for (let i = 0; i < N * N; i++) {
  foamRGB[i * 3] = Math.round(Math.min(1, bubbles[i]) * 255);
  foamRGB[i * 3 + 1] = Math.round(Math.min(1, lacew[i]) * 255);
  foamRGB[i * 3 + 2] = Math.round(smoothstep(-1.4, 1.4, clump[i]) * 255);
}

// ---- PNG -----------------------------------------------------------------------------------------------------
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
function png(rgb, file) {
  const stride = N * 3, raw = Buffer.alloc((stride + 1) * N);
  // Paeth filter on every row: smooth fields compress much better than with filter 0.
  for (let y = 0; y < N; y++) {
    raw[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0, b = y ? rgb[(y - 1) * stride + x] : 0, c = x >= 3 && y ? rgb[(y - 1) * stride + x - 3] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[y * (stride + 1) + 1 + x] = (rgb[y * stride + x] - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}
png(normalRGB, path.join(OUT, 'water-normal.png'));
png(foamRGB, path.join(OUT, 'water-foam.png'));
for (const f of fs.readdirSync(OUT)) console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB');
console.log('slope scale', slopeScale.toFixed(4), 'clipped texels', clipped, 'SLOPE_RANGE', SLOPE_RANGE);
