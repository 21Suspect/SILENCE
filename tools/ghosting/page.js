// In-page half of the ghosting diagnostic (the other halves: metrics.mjs, the maths, and measure.mjs, which writes the report).
// Run it in the game tab of the dev server (npm run dev, any port), with the receiver running (node tools/ghosting/receiver.mjs <dir>):
//
//   H = await import('/tools/ghosting/page.js?' + Date.now());
//   await H.run({ tag: 'before' });        // every pose x variant: stills, numbers, crops, all posted to the receiver
//
// What it does: walks to each fixed pose (the same stations as work/gfx/shots.js), and for each variant (a set of switches on
// the ground shader, the sharpening pass, and so on: VARIANTS below) renders the still and four read-back frames in which the
// ground shader writes a number as a grey instead of a colour (terrain.ts, uReliefB.z): how many scan copies are layered in the
// pixel, how far the texture lookup jumps between neighbouring pixels, and how far one march step moves it. A ramp of known greys
// drawn in the same frame state turns the bytes back into those numbers (metrics.mjs decodeLevel). The still's own number is its
// neighbour coherence (metrics.mjs). Results go to <tag>.json; tools/ghosting/measure.mjs turns them into the readable table.
import { luminance, groundTiles, coherence, ghostIndex, summary, decodeLevel, modeOf } from './metrics.mjs';

const S = () => window.__SILENCE__, P = () => window.__SILENCE__.perf;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const RECEIVER = 'http://127.0.0.1:5198';

/** Fixed poses. yMin is the first row of the near ground the parallax acts on (about the first 6 m), for the tiles; trunk, where given,
 *  is a box [x0, y0, x1, y1] on a pine's bark, for the bark relief's own number. */
export const POSES = {
  'path-down':  { x: -18.87, z: 12, yaw: 2.4, pitch: -.42, hour: 13, yMin: 300, trunk: [130, 90, 290, 290] },
  'path-graze': { x: -18.87, z: 12, yaw: 2.4, pitch: -.15, hour: 13, yMin: 440 },
  'path-close': { x: -18.87, z: 12, yaw: 2.4, pitch: -.85, hour: 13, yMin: 240 },
  'floor-down': { x: -18.87, z: 12, yaw: 1.9, pitch: -.5, hour: 13, yMin: 300 },
  // Stills only (the haze at this hour tints the read-back greys, so the shader's numbers cannot be decoded): to see the relief catch a low sun.
  'path-low-sun': { x: -18.87, z: 12, yaw: 2.4, pitch: -.3, hour: 17.2, yMin: 360, stillsOnly: true },
};

/** What the game ships; variants override on top. */
export const SHIPPED = { legacy: false, parallax: 1, minSteps: 6, maxSteps: 24, refine: 3, px: 1.5, shadow: 1, band: .16, depth: 2, scanBand: 1, legacyDepth: 0, bark: true, sharpen: true };
const OLD_MARCH = { minSteps: 10, maxSteps: 10, refine: 0, scanBand: 0, legacyDepth: 1, band: 0 };
/** `base` names the variant whose coherence is the reference of the ghost index (the same render without the parallax). */
export const VARIANTS = {
  // The suspects, one at a time, on the first version of the ground shader.
  'first-version':      { ...SHIPPED, legacy: true, base: 'first-pom-off' },
  'first-pom-off':      { ...SHIPPED, legacy: true, parallax: 0, base: 'first-pom-off' },
  'first-no-shadow':    { ...SHIPPED, legacy: true, shadow: 0, base: 'first-pom-off' },
  'first-sharpen-off':  { ...SHIPPED, legacy: true, sharpen: false, base: 'first-sharpen-off-pom-off' },
  'first-sharpen-off-pom-off': { ...SHIPPED, legacy: true, parallax: 0, sharpen: false, base: 'first-sharpen-off-pom-off' },
  // The first version taken apart: the new shader's code with the first version's march numbers, then one change at a time.
  'step-1-old-march':   { ...SHIPPED, ...OLD_MARCH, base: 'fixed-pom-off' },
  'step-2-height-blend': { ...SHIPPED, ...OLD_MARCH, band: .16, base: 'fixed-pom-off' },
  'step-3-scan-band':   { ...SHIPPED, ...OLD_MARCH, band: .16, scanBand: 1, base: 'fixed-pom-off' },
  'step-4-adaptive-steps': { ...SHIPPED, ...OLD_MARCH, band: .16, scanBand: 1, minSteps: 6, maxSteps: 24, base: 'fixed-pom-off' },
  'step-5-bisection':   { ...SHIPPED, ...OLD_MARCH, band: .16, scanBand: 1, minSteps: 6, maxSteps: 24, refine: 3, base: 'fixed-pom-off' },
  // The game as it now ships, and its own switches.
  fixed:                { ...SHIPPED, base: 'fixed-pom-off' },
  'fixed-pom-off':      { ...SHIPPED, parallax: 0, base: 'fixed-pom-off' },
  'fixed-no-height-blend': { ...SHIPPED, band: 0, base: 'fixed-pom-off' },
  'fixed-no-bisection': { ...SHIPPED, refine: 0, base: 'fixed-pom-off' },
  'fixed-10-steps':     { ...SHIPPED, minSteps: 10, maxSteps: 10, base: 'fixed-pom-off' },
  'fixed-full-band':    { ...SHIPPED, scanBand: 0, base: 'fixed-pom-off' },
  'fixed-old-depth':    { ...SHIPPED, legacyDepth: 1, base: 'fixed-pom-off' },
  'fixed-no-shadow':    { ...SHIPPED, shadow: 0, base: 'fixed-pom-off' },
  'fixed-depth-x1':     { ...SHIPPED, depth: 1, base: 'fixed-pom-off' },
  'fixed-depth-x3':     { ...SHIPPED, depth: 3, base: 'fixed-pom-off' },
  'fixed-bark-off':     { ...SHIPPED, bark: false, base: 'fixed-bark-off' },
  'fixed-sharpen-off':  { ...SHIPPED, sharpen: false, base: 'fixed-sharpen-off-pom-off' },
  'fixed-sharpen-off-pom-off': { ...SHIPPED, parallax: 0, sharpen: false, base: 'fixed-sharpen-off-pom-off' },
  reference:            { ...SHIPPED, minSteps: 96, maxSteps: 96, refine: 4, px: 1, base: 'fixed-pom-off' },
};

export function terrainMaterial() {
  let m = null;
  P().scene().traverse(o => { if (!m && o.name === 'Streamed forest terrain') m = o.material; });
  return m;
}

let rebuilt = false;
/** A perfOn switch (game/core/perf-flags.ts) on or off. */
function flip(name, on) { if (on) P().switches.enable(name); else P().switches.disable(name); }
/** Flip the live switches. Anything not given keeps its value. `legacy` rebuilds the ground program (the next grab waits for it). */
export function set(o = {}) {
  const m = terrainMaterial(), r = m.userData.relief;
  if ('legacy' in o) {
    const want = !o.legacy, have = P().on('groundRelief');
    if (want !== have) { flip('groundRelief', want); m.needsUpdate = true; rebuilt = true; }
  }
  if ('parallax' in o) m.userData.parallax.value = o.parallax;
  if ('minSteps' in o) r.a.value.x = o.minSteps;
  if ('maxSteps' in o) r.a.value.y = o.maxSteps;
  if ('refine' in o) r.a.value.z = o.refine;
  if ('px' in o) r.a.value.w = o.px;
  if ('shadow' in o) r.b.value.x = o.shadow;
  if ('band' in o) r.b.value.y = o.band;
  if ('debug' in o) r.b.value.z = o.debug;
  if ('level' in o) r.b.value.w = o.level;
  if ('depth' in o) r.c.value.x = o.depth;
  if ('scanBand' in o) r.c.value.y = o.scanBand;
  if ('legacyDepth' in o) r.c.value.z = o.legacyDepth;
  if ('bark' in o) flip('barkRelief', o.bark);
  if ('sharpen' in o && P().on('sharpen') !== o.sharpen) { flip('sharpen', o.sharpen); S().setRatio(1); }
}

/** Walk to the pose and let everything stream and settle, as work/gfx/shots.js does. */
export async function settle(st) {
  const s = S(), p = P();
  const pose = () => { s.teleport(st.x, st.z); s.look(st.yaw, st.pitch); };
  p.drive(true, false); p.hold(); s.setHours(st.hour); pose(); p.torch(false);
  const wait = async () => { const t0 = performance.now(); while (performance.now() - t0 < 60000) { if (p.settled()) return; s.snap(); await sleep(10); } };
  await wait(); for (let i = 0; i < 90; i++) { pose(); s.setHours(st.hour); s.snap(); if (i % 24 === 23) await sleep(0); }
  await wait(); await sleep(3000);
  for (let i = 0; i < 60; i++) { pose(); s.setHours(st.hour); s.snap(); if (i % 20 === 19) await sleep(0); }
  p.drive(false); s.setTime(500); s.setHours(st.hour); pose();
  for (let i = 0; i < 12; i++) s.snap();
  await exposureSettle(st);
}

/**
 * One frame at the settled pose with the current switches: the canvas pixels, and a PNG to the receiver when `file` is given.
 * A still starts from a fresh eye: resizing the render target (setRatio) restarts the exposure measurement from the frame itself, so
 * every still is exposed by its own content and none by how far the eye had got when the one before it was taken (the eye opens
 * over seconds, and the stills of one pose would otherwise differ in brightness by up to a third).
 */
export async function grab(st, file, { fresh = !!file } = {}) {
  const s = S();
  const pose = () => { s.teleport(st.x, st.z); s.look(st.yaw, st.pitch); s.setTime(500); s.setHours(st.hour); };
  pose();
  if (rebuilt) {   // a new program: let it compile and the warm-up queue drain before the frame that counts
    rebuilt = false;
    for (let i = 0; i < 20; i++) { s.snap(); await sleep(30); }
    const t0 = performance.now(); while (performance.now() - t0 < 30000 && !P().settled()) { s.snap(); await sleep(20); }
    for (let i = 0; i < 20; i++) { s.snap(); await sleep(10); }
    pose();
  }
  if (fresh) s.setRatio(1);
  for (let i = 0; i < 6; i++) s.snap();
  const canvas = document.querySelector('canvas');
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
  const c = copy.getContext('2d', { willReadFrequently: true }); c.drawImage(canvas, 0, 0);
  if (file) await post(`${file}.png`, copy.toDataURL('image/png'));
  return c.getImageData(0, 0, copy.width, copy.height);
}

export const post = (name, body) => fetch(`${RECEIVER}/?file=${encodeURIComponent(name)}`, { method: 'POST', body }).then(r => r.text());

// ---- Reading numbers back through the post chain.
const NEUTRAL = { minExposure: 1, maxExposure: 1, bias: 0, temperature: 0, tint: 0, saturation: 1, contrast: 1, scotopic: 0, vignette: 0, grain: 0, bloom: 0 };
let saved = null;
/** Exposure, grade, fog and ambient occlusion fixed and neutral, so a grey the shader writes comes out as the same byte everywhere. */
function freeze() {
  const g = P().scene().userData.grade;
  saved = { g: Object.fromEntries(Object.keys(NEUTRAL).map(k => [k, g[k]])), sh: g.shadows.clone(), hi: g.highlights.clone() };
  Object.assign(g, NEUTRAL); g.shadows.setRGB(1, 1, 1); g.highlights.setRGB(1, 1, 1);
  P().ablate({ fog: false }); P().switches.disable('ambientOcclusion');
}
function unfreeze() {
  const g = P().scene().userData.grade;
  Object.assign(g, saved.g); g.shadows.copy(saved.sh); g.highlights.copy(saved.hi);
  P().ablate({ fog: true }); P().switches.enable('ambientOcclusion'); saved = null;
}

const LEVELS = [0, .02, .04, .06, .08, .1, .15, .2, .3, .4, .5, .6, .7];
const MASK_LEVEL = .7;

/** The byte each grey level comes out as, by the most common neutral byte in the lower part of the frame (the ground). */
async function calibrate(st) {
  const table = [];
  for (const level of LEVELS) {
    set({ debug: 2, level });
    const img = await grab(st), bytes = [];
    for (let y = Math.floor(img.height * .55); y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] === img.data[i + 1] && img.data[i + 1] === img.data[i + 2]) bytes.push(img.data[i + 1]);
    }
    table.push({ level, byte: modeOf(bytes) });
  }
  return table;
}

/** The pixels that are ground: the constant-grey frame's own grey, to within a byte or two. */
function groundMask(img, table) {
  const target = table.find(t => t.level === MASK_LEVEL).byte, mask = new Uint8Array(img.width * img.height);
  for (let i = 0; i < mask.length; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    mask[i] = Math.abs(g - target) <= 2 && Math.abs(r - g) <= 1 && Math.abs(b - g) <= 1 ? 1 : 0;
  }
  return mask;
}

/** A debug frame decoded to numbers (level / scale) for the pixels of the mask. */
function decoded(img, table, mask, scale, yMin) {
  const out = [];
  for (let i = yMin * img.width; i < mask.length; i++) if (mask[i]) out.push(decodeLevel(table, img.data[i * 4 + 1]) / scale);
  return out;
}

/** Every pose x variant. Writes `<tag>.json` and the stills (`<tag>-<pose>-<variant>.png`) through the receiver. */
export async function run({ tag = 'run', poses = Object.keys(POSES), variants = Object.keys(VARIANTS), crops = true } = {}) {
  S().setRatio(1);
  const results = { tag, when: new Date().toISOString(), size: [innerWidth, innerHeight], rows: [] };
  for (const poseName of poses) {
    const st = POSES[poseName];
    set(SHIPPED); await settle(st);
    // Pass one: the stills, all at the exposure the eye has settled on.
    const lums = {}, kept = {}, rows = {};
    for (const name of variants) {
      set(VARIANTS[name]);
      const img = await grab(st, `${tag}-${poseName}-${name}`);
      lums[name] = luminance(img.data, img.width, img.height);
      if (crops) kept[name] = img;
    }
    if (st.stillsOnly) { set(SHIPPED); continue; }
    // Pass two, with the grade, fog and occlusion fixed: the numbers the shader writes as greys. (The eye adapts to those dark
    // frames, so the stills are never taken between the two passes, and the exposure gets time to come back after them.)
    freeze(); let table, mask;
    try {
      table = await calibrate(st); set({ debug: 2, level: MASK_LEVEL }); mask = groundMask(await grab(st), table);
      for (const name of variants) {
        set(VARIANTS[name]);
        const row = rows[name] = { pose: poseName, variant: name };
        set({ debug: 1 }); row.layers = summary(decoded(await grab(st), table, mask, .06, st.yMin), [1.5, 2.5]);
        set({ debug: 5 }); row.jump = summary(decoded(await grab(st), table, mask, .04, st.yMin), [1, 2, 4]);
        set({ debug: 6 }); row.stepPx = summary(decoded(await grab(st), table, mask, .04, st.yMin), [1.5, 3]);
        set({ debug: 0 });
      }
    } finally { set({ debug: 0 }); unfreeze(); }
    const tiles = groundTiles(mask, innerWidth, innerHeight, { yMin: st.yMin });
    // Bark has no mask: a box on a trunk stands in (every pixel of it counts as bark).
    let trunkTiles = null;
    if (st.trunk) {
      const [x0, y0, x1, y1] = st.trunk, box = new Uint8Array(innerWidth * innerHeight);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) box[y * innerWidth + x] = 1;
      trunkTiles = groundTiles(box, innerWidth, innerHeight, { cover: 1 });
    }
    for (const name of variants) {
      const row = rows[name], c = coherence(lums[name], innerWidth, innerHeight, tiles);
      row.tiles = tiles.length; row.coherenceMean = c.mean;
      if (trunkTiles) row.trunkCoherence = coherence(lums[name], innerWidth, innerHeight, trunkTiles).mean;
    }
    for (const name of variants) {
      const row = rows[name], base = rows[VARIANTS[name].base];
      row.ghostIndex = base ? ghostIndex(row.coherenceMean, base.coherenceMean) : null;
      if (trunkTiles && rows['fixed-bark-off']) row.trunkGhostIndex = ghostIndex(row.trunkCoherence, rows['fixed-bark-off'].trunkCoherence);
      results.rows.push(row);
    }
    if (crops) await cropSheets(tag, poseName, tiles, lums, kept, variants);
    set(SHIPPED);
    await exposureSettle(st);
  }
  await post(`${tag}.json`, JSON.stringify(results, null, 1));
  return results.rows.map(r => `${r.pose} ${r.variant} G=${r.ghostIndex?.toFixed(3)} C=${r.coherenceMean.toFixed(3)}`);
}

/** The eye needs a few seconds of game time to come back after the dark debug frames (it eases with a time constant of 0.7 to 2.2 s). */
async function exposureSettle(st) {
  const s = S();
  for (let i = 0; i < 360; i++) { s.teleport(st.x, st.z); s.look(st.yaw, st.pitch); s.setTime(500); s.setHours(st.hour); s.snap(); if (i % 30 === 29) await sleep(0); }
}

/** Contact sheets: the tiles the first version's parallax hurt most, and least, shown in the first version, with the parallax off, and as fixed (each tile's coherence on its label). */
async function cropSheets(tag, poseName, tiles, lums, kept, variants) {
  const names = ['first-version', 'first-pom-off', 'fixed'];
  if (!names.every(v => variants.includes(v))) return;
  const w = innerWidth, h = innerHeight, size = 32, zoom = 4, bar = 14;
  // Ranked by how much coherence each tile lost to the first version's parallax: the most lost first.
  const first = coherence(lums[names[0]], w, h, tiles).scores, off = coherence(lums[names[1]], w, h, tiles).scores;
  const order = first.map((v, i) => [off[i] - v, i]).sort((a, b) => b[0] - a[0]);
  for (const [label, pick] of [['worst', order.slice(0, 6)], ['best', order.slice(-6).reverse()]]) {
    const sheet = document.createElement('canvas'); sheet.width = pick.length * size * zoom; sheet.height = names.length * (size * zoom + bar);
    const c = sheet.getContext('2d'); c.imageSmoothingEnabled = false; c.font = '11px monospace';
    const tileCanvas = document.createElement('canvas'); tileCanvas.width = tileCanvas.height = size;
    for (let col = 0; col < pick.length; col++) {
      const t = tiles[pick[col][1]];
      for (const [row, name] of names.entries()) {
        const tile = new ImageData(size, size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let k = 0; k < 4; k++) tile.data[(y * size + x) * 4 + k] = kept[name].data[((t.y + y) * w + t.x + x) * 4 + k];
        tileCanvas.getContext('2d').putImageData(tile, 0, 0);
        const x0 = col * size * zoom, y0 = row * (size * zoom + bar);
        c.fillStyle = '#000'; c.fillRect(x0, y0, size * zoom, bar);
        c.drawImage(tileCanvas, x0, y0 + bar, size * zoom, size * zoom);
        c.fillStyle = '#ff0'; c.fillText(`${name.slice(0, 13)} ${coherence(lums[name], w, h, [t]).mean.toFixed(2)}`, x0 + 2, y0 + 11);
      }
    }
    await post(`${tag}-${poseName}-crops-${label}.png`, sheet.toDataURL('image/png'));
  }
}

// ---- Cost: interleaved A/B of the whole frame (CPU + GPU) at a pose, as the performance pass measures (AGENTS.md, "Measuring").
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2; };
const drain = () => { const gl = document.querySelector('canvas').getContext('webgl2'); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); };
/**
 * Median wall milliseconds per frame of each arm (a VARIANTS name or { name, ...switches }) at each pose, the arms run in turn in
 * `rounds` rounds (order reversed every other round, so drift hits all alike), `n` frames driven synchronously then the GPU drained.
 * `ratio` 1.5 draws 1920 x 1080 into the 1280 x 720 pane.
 */
export async function cost({ poses = ['path-down', 'path-graze'], arms = ['first-version', 'fixed', 'first-pom-off'], rounds = 8, n = 30, ratio = 1.5, tag = 'cost' } = {}) {
  S().setRatio(ratio);
  const out = [];
  for (const poseName of poses) {
    const st = POSES[poseName];
    set(SHIPPED); await settle(st);
    const list = arms.map(a => typeof a === 'string' ? { ...VARIANTS[a], name: a } : { ...SHIPPED, ...a }), acc = list.map(() => []);
    const pose = () => { S().teleport(st.x, st.z); S().look(st.yaw, st.pitch); S().setTime(500); S().setHours(st.hour); };
    for (let r = 0; r < rounds; r++) for (let a = 0; a < list.length; a++) {
      const i = r % 2 ? list.length - 1 - a : a;
      set(list[i]);
      for (let k = 0; k < 10; k++) { pose(); S().snap(); }
      drain(); await sleep(30);
      const t0 = performance.now();
      for (let k = 0; k < n; k++) { pose(); S().snap(); }
      drain(); acc[i].push((performance.now() - t0) / n);
    }
    set(SHIPPED);
    for (const [i, arm] of list.entries()) out.push({ pose: poseName, arm: arm.name, ms: +median(acc[i]).toFixed(2), best: +Math.min(...acc[i]).toFixed(2), blocks: acc[i].map(v => +v.toFixed(2)) });
  }
  S().setRatio(1);
  await post(`${tag}.json`, JSON.stringify({ tag, when: new Date().toISOString(), ratio, rows: out }, null, 1));
  return out;
}
