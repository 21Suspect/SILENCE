/**
 * The island's map as a survey sheet, drawn at run time from this run's layout (the seed changes every island): the paper map (island-map.ts),
 * the notice boards' prints (render/props/board-map.ts) and the board panel all use it. Nothing here is a baked picture.
 *
 * Two stages, both in slices (`runSliced`) so no frame pays more than a few ms: `loadMapData` samples the ground once (coast, lake, height,
 * forest) and `renderMap` paints a canvas from it (paper, terrain tone, contours, forest, water-lining, roads, names, decoration).
 * `paintPencil` is the part that changes while you play: the graphite rings and the cross, drawn over a copy of the finished sheet.
 */
import { coastDistance, lakeDistance, beachWidth } from '../sim/world/coastal-geography';
import { landform } from '../sim/world/world-landform';
import { riverX, roadZ, treeDensity, waterHeightAt, noise } from '../sim/world/world-noise';
import { biomeAt } from '../sim/world/world';
import { WORLD_SEED } from '../sim/world/world-flags';
import { ROAD_ENDS, TRAIL_LINES, ROAD_CROSSING } from '../sim/world/world-layout';
import { PLACES } from '../sim/world/places';
import { MAP_BOUNDS, SHORT_NAMES, contourSegments, makeProjection, placeLabels, type Box, type LabelSpot, type MapBounds } from '../sim/world/map-shapes';

/** Metres per cell of the coast and lake grids (the coast is drawn from them, so they stay fine) and of the height grid. */
const CELL = 5, HCELL = 10;
const PATH = '#3d2614', roadFill = '#eadfb8';
const INK = '#2b2118', WATER = '#3d6073', CONTOUR = '#9b6a3a', SERIF = "Georgia,'Palatino Linotype','Book Antiqua','Times New Roman',serif";
const ISLAND_NAMES = ['Hollowmere', 'Ashgrave', 'Kettle Holm', 'Marrow Sound', 'Greywater', 'Stillfold', 'Wren Skerry', 'Cairn Isle'];
export const islandName = () => ISLAND_NAMES[Math.abs(Math.floor(WORLD_SEED || 7741)) % ISLAND_NAMES.length];

// ---------------------------------------------------------------- slicing

export type Slicer = { over(): boolean };
/** Runs a generator a few milliseconds at a time between timers, so a long drawing never holds up a frame. `budget` 0 runs it to the end now. */
export function runSliced<T>(make: (s: Slicer) => Generator<void, T>, budget = 4): Promise<T> {
  return new Promise((resolve, reject) => {
    let deadline = Infinity;
    const gen = make({ over: () => performance.now() > deadline });
    const step = () => {
      try {
        deadline = budget > 0 ? performance.now() + budget : Infinity;
        const r = gen.next();
        if (r.done) resolve(r.value); else setTimeout(step, 0);
      } catch (e) { reject(e); }
    };
    step();
  });
}

/** Runs a generator to its end at once (a map opened before its slices are done, and tests). */
export function runNow<T>(make: (s: Slicer) => Generator<void, T>): T {
  const gen = make({ over: () => false });
  let r = gen.next(); while (!r.done) r = gen.next();
  return r.value;
}

// ---------------------------------------------------------------- data

export type MapData = {
  nx: number; nz: number; coast: Float32Array; lake: Float32Array;
  hx: number; hz: number; height: Float32Array; shade: Float32Array; /** 0..1 where trees stand thick, on the height grid. */ forest: Float32Array;
  /** x, z pairs: trees, heath and sand stipple. */
  trees: Float32Array; heath: Float32Array; sand: Float32Array;
  river: [number, number][]; road: [number, number][];
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function bil(f: Float32Array, nx: number, nz: number, fx: number, fz: number) {
  const i = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
  const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fz - j)), q = j * nx + i;
  return (f[q] * (1 - u) + f[q + 1] * u) * (1 - v) + (f[q + nx] * (1 - u) + f[q + nx + 1] * u) * v;
}

function* sampleData(s: Slicer): Generator<void, MapData> {
  const B = MAP_BOUNDS, nx = Math.ceil((B.x1 - B.x0) / CELL) + 2, nz = Math.ceil((B.z1 - B.z0) / CELL) + 2;
  const coast = new Float32Array(nx * nz), lake = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = B.x0 + i * CELL, z = B.z0 + j * CELL;
      // The real coast is smooth; a little rough noise on it gives the shoreline coves and points a surveyor would have drawn.
      const rough = (noise(x * .052 + 3, z * .052 - 9) - .5) * 9 + (noise(x * .17 - 5, z * .17 + 2) - .5) * 2.6;
      coast[j * nx + i] = coastDistance(x, z) + rough; lake[j * nx + i] = lakeDistance(x, z) + rough * .35;
    }
    if (s.over()) yield;
  }
  const hx = Math.ceil((B.x1 - B.x0) / HCELL) + 2, hz = Math.ceil((B.z1 - B.z0) / HCELL) + 2;
  let height = new Float32Array(hx * hz);
  for (let j = 0; j < hz; j++) {
    for (let i = 0; i < hx; i++) height[j * hx + i] = landform(B.x0 + i * HCELL, B.z0 + j * HCELL);
    if (s.over()) yield;
  }
  // Two passes of a 3 x 3 blur: the ground's metre-scale lumps would turn every contour into scribble.
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(height.length);
    for (let j = 0; j < hz; j++) for (let i = 0; i < hx; i++) {
      let sum = 0, w = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= hx || jj >= hz) continue;
        const k = di === 0 && dj === 0 ? 4 : di === 0 || dj === 0 ? 2 : 1; sum += height[jj * hx + ii] * k; w += k;
      }
      out[j * hx + i] = sum / w;
    }
    height = out;
    if (s.over()) yield;
  }
  // Light from the north west, the relief stretched so a low island still has hills.
  const shade = new Float32Array(hx * hz);
  for (let j = 1; j < hz - 1; j++) for (let i = 1; i < hx - 1; i++) {
    const dx = (height[j * hx + i + 1] - height[j * hx + i - 1]) / (2 * HCELL), dz = (height[(j + 1) * hx + i] - height[(j - 1) * hx + i]) / (2 * HCELL);
    shade[j * hx + i] = Math.max(-1, Math.min(1, (dx + dz) * 5 / (1 + 3.5 * Math.hypot(dx, dz))));
  }
  // Forest, heath and sand marks on a jittered grid, kept off the road, river, lake, paths and the places' own clearings.
  const trees: number[] = [], heath: number[] = [], sand: number[] = [], STEP = 7;
  const trailCells = new Set<number>();
  for (const t of TRAIL_LINES) for (const [x, z] of t) trailCells.add(Math.floor(x / 6) * 100003 + Math.floor(z / 6));
  for (let z = B.z0; z < B.z1; z += STEP) {
    for (let x = B.x0; x < B.x1; x += STEP) {
      const jx = x + (noise(x * 1.7, z * 1.3) - .5) * STEP * 1.6, jz = z + (noise(x * 1.1 + 7, z * 2.1) - .5) * STEP * 1.6;
      const c = bil(coast, nx, nz, (jx - B.x0) / CELL, (jz - B.z0) / CELL);
      if (c <= 0) continue;
      const bw = beachWidth(jx, jz), lk = bil(lake, nx, nz, (jx - B.x0) / CELL, (jz - B.z0) / CELL);
      if (lk < 3) continue;
      if (c < bw) { if (noise(jx * 2.3, jz * 2.9) < .55) sand.push(jx, jz); continue; }
      if (c < bw + 5 || Math.abs(jz - roadZ(jx)) < 9 || Math.abs(jx - riverX(jz)) < 9 || trailCells.has(Math.floor(jx / 6) * 100003 + Math.floor(jz / 6))) continue;
      let clear = false;
      for (const p of PLACES) if (Math.hypot(p.x - jx, p.z - jz) < p.radius * .85) { clear = true; break; }
      if (clear) continue;
      // The cheap density first: the biome (dearer) only where a tree or a heath dot could go.
      const td = treeDensity(jx, jz), r = noise(jx * 3.3 + 1, jz * 3.7);
      if (td < .5 && r >= .5) continue;
      const b = biomeAt(jx, jz), d = td * (b.forest + b.grove);
      if (d > .5 && r < d * .95 - .15) trees.push(jx, jz); else if (b.heath > .4 && r < .5) heath.push(jx, jz);
    }
    if (s.over()) yield;
  }
  // The river, wherever it runs on land, and the road end to end.
  // Where the forest stands: the trees counted into the height grid and blurred, for a soft tint under the marks.
  let forest = new Float32Array(hx * hz);
  for (let i = 0; i < trees.length; i += 2) { const ci = Math.round((trees[i] - B.x0) / HCELL), cj = Math.round((trees[i + 1] - B.z0) / HCELL); if (ci >= 0 && cj >= 0 && ci < hx && cj < hz) forest[cj * hx + ci] += 1; }
  for (let pass = 0; pass < 3; pass++) {
    const out = new Float32Array(forest.length);
    for (let j = 1; j < hz - 1; j++) for (let i = 1; i < hx - 1; i++) { let sum = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += forest[(j + dj) * hx + i + di]; out[j * hx + i] = sum / 9; }
    forest = out;
  }
  for (let i = 0; i < forest.length; i++) forest[i] = Math.min(1, forest[i] / .45);
  const river: [number, number][] = [];
  for (let z = B.z0; z <= B.z1; z += 8) if (coastDistance(riverX(z), z) > 0) river.push([riverX(z), z]);
  const e0 = Math.min(...ROAD_ENDS.map(e => e.x)), e1 = Math.max(...ROAD_ENDS.map(e => e.x)), road: [number, number][] = [];
  for (let x = e0; x <= e1; x += 8) road.push([x, roadZ(x)]);
  return { nx, nz, coast, lake, hx, hz, height, shade, forest, trees: new Float32Array(trees), heath: new Float32Array(heath), sand: new Float32Array(sand), river, road };
}

let dataPromise: Promise<MapData> | undefined, dataReady: MapData | undefined;
/** The sampled ground, built once for every map of the run (the first caller starts it, in slices). */
export function loadMapData(): Promise<MapData> { return dataPromise ??= runSliced(sampleData).then(d => (dataReady = d)); }
export const mapDataReady = () => dataReady;
/** The same, now and in one go (for a map opened before the slices have finished). */
export function loadMapDataNow(): MapData {
  if (dataReady) return dataReady;
  const gen = sampleData({ over: () => false });
  let r = gen.next(); while (!r.done) r = gen.next();
  return dataReady = r.value;
}

// ---------------------------------------------------------------- paper

const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
let tile: HTMLCanvasElement | undefined;
/** A tile of paper: grain and short fibres. Made once, used by multiply. */
function grainTile() {
  if (tile) return tile;
  const N = 384, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d')!, img = g.createImageData(N, N), r = rng(99);
  for (let i = 0; i < N * N; i++) { const v = 236 + (r() - .5) * 34; img.data[i * 4] = v; img.data[i * 4 + 1] = v * .975; img.data[i * 4 + 2] = v * .92; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  g.lineCap = 'round';
  for (let i = 0; i < 520; i++) {
    const x = r() * N, y = r() * N, a = r() * Math.PI * 2, l = 5 + r() * 18, bend = (r() - .5) * 6;
    g.strokeStyle = r() < .6 ? `rgba(120,88,48,${.06 + r() * .1})` : `rgba(255,252,238,${.12 + r() * .2})`; g.lineWidth = .5 + r() * .6;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l / 2 + bend, y + Math.sin(a) * l / 2 + bend, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  return tile = c;
}

// ---------------------------------------------------------------- the sheet

export type MapStyle = 'sheet' | 'board';
export type MapSheet = { canvas: HTMLCanvasElement; proj: ReturnType<typeof makeProjection>; k: number; u: number; view: MapBounds;
  /** The names as placed (see placeLabels), with `extra` to find one for a ringed place whose name was dropped, and `draw`. */
  labels: { spots: Map<string, LabelSpot>; items: { id: string; cx: number; cy: number; r: number; w: number; h: number; must: boolean }[]; extra(id: string): LabelSpot | undefined; drawById(id: string, sp: LabelSpot, g: CanvasRenderingContext2D): void; area: Box; blocked: Box[] } };

/** The view a style shows: the island's rectangle for the sheet, the square round it for a board. */
export function viewFor(style: MapStyle): MapBounds {
  const B = MAP_BOUNDS;
  if (style === 'sheet') return B;
  const cx = (B.x0 + B.x1) / 2, cz = (B.z0 + B.z1) / 2, half = Math.max(B.x1 - B.x0, B.z1 - B.z0) / 2;
  return { x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half };
}

export type RenderOptions = { w: number; h: number; dpr: number; style: MapStyle };

/** Paints the whole sheet but the pencil. Returns its canvas, device pixels `w * dpr` by `h * dpr`. */
export function* renderMap(data: MapData, o: RenderOptions, s: Slicer): Generator<void, MapSheet> {
  const board = o.style === 'board', k = o.dpr, W = Math.round(o.w * k), H = Math.round(o.h * k);
  const u = 1, fu = board ? 1.15 : 1;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!, view = viewFor(o.style), margin = (board ? 40 : 22) * k;
  // On the sheet the right-hand strip (title, legend) is not map: the island is fitted to what is left.
  const AW = board ? W : W - Math.round(236 * k);
  const p = makeProjection(view, AW, H, margin), R = rng(board ? 4242 : 1717);
  const B = MAP_BOUNDS;
  const paper = board ? [224, 220, 204] : [236, 224, 190];
  const ink = board ? '#241f19' : INK;

  // --- terrain tone, at a third of the resolution and stretched: hill shading, elevation tint, sea, lake.
  const TS = 3, TW = Math.ceil(W / TS), TH = Math.ceil(H / TS), tc = document.createElement('canvas'); tc.width = TW; tc.height = TH;
  const tg = tc.getContext('2d')!, img = tg.createImageData(TW, TH), px = img.data, [ox, oz] = p.toWorld(0, 0), inv = TS / p.scale;
  for (let ty = 0; ty < TH; ty++) {
    const wz = oz + (ty + .5) * inv, fzc = (wz - B.z0) / CELL, fzh = (wz - B.z0) / HCELL;
    for (let tx = 0; tx < TW; tx++) {
      const wx = ox + (tx + .5) * inv, fxc = (wx - B.x0) / CELL, fxh = (wx - B.x0) / HCELL;
      const cd = bil(data.coast, data.nx, data.nz, fxc, fzc), o4 = (ty * TW + tx) * 4;
      let r: number, gg: number, b: number;
      if (cd <= 0 || wx < B.x0 || wx > B.x1 || wz < B.z0 || wz > B.z1) {
        const t = Math.min(1, Math.max(0, -cd) / 110), near = Math.max(0, 1 - Math.max(0, -cd) / 16);
        r = lerp(176, 140, t) + near * 18; gg = lerp(194, 164, t) + near * 14; b = lerp(194, 168, t) + near * 8;
      } else if (bil(data.lake, data.nx, data.nz, fxc, fzc) < 0) { r = 168; gg = 192; b = 198; }
      else {
        const h = bil(data.height, data.hx, data.hz, fxh, fzh), sh = bil(data.shade, data.hx, data.hz, fxh, fzh), e = Math.max(0, Math.min(1, h / 13)), m = Math.max(0, Math.min(1, (h - 14) / 100)), f = 1 + sh * .16;
        r = paper[0] * f * (1 - .02 * e - .3 * m); gg = paper[1] * f * (1 - .07 * e - .32 * m); b = paper[2] * f * (1 - .16 * e - .3 * m);
        // Forest: a soft green-grey wash.
        const fo = bil(data.forest, data.hx, data.hz, fxh, fzh); r *= 1 - .09 * fo; gg *= 1 - .03 * fo; b *= 1 - .08 * fo;
        // Low sand at the shore is paler.
        const beach = Math.max(0, 1 - cd / 14) * .5; r += beach * 10; gg += beach * 8; b += beach * 2;
      }
      px[o4] = r; px[o4 + 1] = gg; px[o4 + 2] = b; px[o4 + 3] = 255;
    }
    if (ty % 24 === 0 && s.over()) yield;
  }
  tg.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(tc, 0, 0, W, H);
  yield;

  // --- the paper over it: grain and fibres, uneven tone, tea stains, foxing.
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = g.createPattern(grainTile(), 'repeat')!; g.globalAlpha = board ? .42 : .4; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
  for (let i = 0; i < 16; i++) {
    const x = R() * W, y = R() * H, rad = (.12 + R() * .3) * W, gr = g.createRadialGradient(x, y, 0, x, y, rad), a = .05 + R() * .08;
    gr.addColorStop(0, `rgba(${150 + R() * 40},${105 + R() * 30},50,${a})`); gr.addColorStop(1, 'rgba(150,110,50,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  // Stains: irregular blotches with a darker tide line along one side, put out on the sea where they can (faint if they land on the island).
  for (let i = 0; i < (board ? 2 : 3); i++) {
    let x = 0, y = 0, onLand = true;
    for (let tries = 0; tries < 40 && onLand; tries++) {
      x = R() * AW; y = R() * H; const [wx, wz] = p.toWorld(x, y);
      onLand = wx > B.x0 && wx < B.x1 && wz > B.z0 && wz < B.z1 && bil(data.coast, data.nx, data.nz, (wx - B.x0) / CELL, (wz - B.z0) / CELL) > -30;
    }
    const rad = (34 + R() * 56) * k, f = onLand ? .35 : 1, s1 = R() * 6, s2 = R() * 6, s3 = R() * 6, tide = R() * Math.PI * 2, shape = (t: number) => rad * (1 + .26 * Math.sin(t * 2 + s1) + .18 * Math.sin(t * 3 + s2) + .1 * Math.sin(t * 5 + s3));
    g.beginPath(); for (let n = 0; n <= 48; n++) { const t = n / 48 * Math.PI * 2; if (n) g.lineTo(x + Math.cos(t) * shape(t), y + Math.sin(t) * shape(t) * .85); else g.moveTo(x + shape(0), y); }
    g.closePath(); g.fillStyle = `rgba(140,100,50,${.055 * f})`; g.fill();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const [grow, w, al] of [[1, 2.4, .17], [.93, 1.2, .08]]) {
      g.beginPath(); for (let n = 0; n <= 30; n++) { const t = tide + n / 30 * Math.PI * 1.15, qx = x + Math.cos(t) * shape(t) * grow, qy = y + Math.sin(t) * shape(t) * .85 * grow; if (n) g.lineTo(qx, qy); else g.moveTo(qx, qy); }
      g.strokeStyle = `rgba(115,78,35,${al * f})`; g.lineWidth = w * k; g.stroke();
    }
  }
  for (let i = 0; i < 70; i++) {
    // Foxing: small brown spots, thicker towards the edges.
    const edge = R() < .6, x = edge ? (R() < .5 ? R() * .12 : 1 - R() * .12) * W : R() * W, y = edge ? R() * H : R() * H, rad = (1.5 + R() * 6) * k * u, gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(135,85,35,${.12 + R() * .2})`); gr.addColorStop(1, 'rgba(135,85,35,0)'); g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.globalCompositeOperation = 'source-over';
  yield;

  g.lineCap = 'round'; g.lineJoin = 'round';
  const wob = (n: number) => { const t = Math.sin(n * 127.1 + 311.7) * 43758.5453; return t - Math.floor(t) - .5; };
  const strokeSegs = (segs: number[][], width: number, color: string, shake: number, alpha = 1) => {
    g.strokeStyle = color; g.lineWidth = width * k * u; g.globalAlpha = alpha; g.beginPath();
    for (const q of segs) {
      const [ax, ay] = p.toCanvas(q[0], q[1]), [bx, by] = p.toCanvas(q[2], q[3]);
      g.moveTo(ax + wob(q[0] * .13 + q[1]) * shake * k, ay + wob(q[1] * .13 - q[0]) * shake * k);
      g.lineTo(bx + wob(q[2] * .13 + q[3]) * shake * k, by + wob(q[3] * .13 - q[2]) * shake * k);
    }
    g.stroke(); g.globalAlpha = 1;
  };

  // --- contours, wobbled a little like pen on paper: every 2 m in the low valley (faint), every 10 m above, a heavier index line each 50.
  const heights = [2, 4, 6, 8]; for (let h = 10; h <= 130; h += 10) heights.push(h);
  for (const level of heights) {
    const segs = contourSegments(data.height, data.hx, data.hz, B.x0, B.z0, HCELL, level), index = level % 50 === 0, aux = level < 10;
    strokeSegs(segs, index ? 1 : .5, CONTOUR, .5, index ? .5 : aux ? .2 : .32);
    if (s.over()) yield;
  }

  const ls = g as unknown as { letterSpacing: string };
  const spaced = (px: number) => { if ('letterSpacing' in g) ls.letterSpacing = `${px}px`; };
  // --- the names first (the forest marks keep out of their boxes): where each goes, from the symbols and what else stands on the sheet. A key
  // place's name may come out a size or two smaller before it is set far off; none goes further than 60 px (90 on a poster) from its symbol.
  const stripBlock: Box[] = board ? (() => {
    const cw = 188 * u * k, ch = 58 * u * k, cx0 = 30 * k, cy0 = 30 * k, cr = 34 * u * k, ccx = W - cr - 40 * k, ccy = H - cr - 42 * k, len = 200 * p.scale;
    return [[cx0 - 4 * k, cy0 - 4 * k, cx0 + cw + 4 * k, cy0 + ch + 4 * k], [ccx - cr - 12 * k, ccy - cr - 22 * k, ccx + cr + 12 * k, ccy + cr + 14 * k], [32 * k, H - 45 * k, 40 * k + len + 40 * k, H - 18 * u * k]] as Box[];
  })() : [[AW - 2 * k, 0, W, H]];
  const maxOff = (board ? 90 : 60) * k, KEY_SIZES = [14.5, 13.5, 12.5];
  const labelSize = (key: boolean, v: number) => (key ? KEY_SIZES[v] : 12) * fu * k;
  const labelFont = (key: boolean, v = 0) => `${key ? 'bold' : 'italic'} ${labelSize(key, v)}px ${SERIF}`;
  g.textBaseline = 'alphabetic';
  const items = [...PLACES].sort((a, b) => Number(!!b.key) - Number(!!a.key)).map(place => {
    const key = !!place.key, [cx, cy] = p.toCanvas(place.x, place.z);
    const text = key ? place.title.replace(/^The /, '').toUpperCase() : place.name.replace(/^the /, '').replace(/^./, m => m.toUpperCase());
    const short = SHORT_NAMES[place.id], texts = key ? [text, text, text] : short && short !== text ? [text, short] : [text];
    const variants = texts.map((t, v) => { g.font = labelFont(key, key ? v : 0); spaced(key ? 1.6 * fu * k : 0); const w = g.measureText(t).width; spaced(0); return { w, h: labelSize(key, key ? v : 0), text: t }; });
    return { place, text, key, id: place.id, cx, cy, r: (key ? 20 : 16) * u * k, w: variants[0].w, h: variants[0].h, must: key, variants };
  });
  const area: Box = [8 * k, 8 * k, AW - 8 * k, H - 8 * k];
  const spots = placeLabels(items, stripBlock, area, 3 * k, undefined, maxOff);
  // --- forest, heath and sand: small ring marks, dots and grains.
  // Sparse small crowns (a third of the trees), none under a name or a symbol: the tint does the forest, the marks only say it is trees.
  const keepOut: Box[] = [...[...spots.values()].map(sp => sp.box), ...items.map((i): Box => [i.cx - 8 * k, i.cy - 8 * k, i.cx + 8 * k, i.cy + 8 * k])];
  const free = (x: number, y: number) => { for (const b of keepOut) if (x > b[0] - 3 * k && x < b[2] + 3 * k && y > b[1] - 3 * k && y < b[3] + 3 * k) return false; return true; };
  g.fillStyle = 'rgba(62,88,50,.55)'; g.beginPath();
  const tr = 1.35 * k * u;
  for (let i = 0; i < data.trees.length; i += 2) {
    if (((i * 2654435761) >>> 0) % 3 !== 0) continue;
    const [x, y] = p.toCanvas(data.trees[i], data.trees[i + 1]); if (!free(x, y)) continue;
    g.moveTo(x + tr, y); g.arc(x, y, tr, 0, Math.PI * 2);
  }
  g.fill();
  yield;
  g.fillStyle = 'rgba(110,100,60,.5)';
  for (let i = 0; i < data.heath.length; i += 2) { const [x, y] = p.toCanvas(data.heath[i], data.heath[i + 1]); if (free(x, y)) g.fillRect(x, y, 1.1 * k, 1.1 * k); }
  g.fillStyle = 'rgba(130,100,50,.45)';
  for (let i = 0; i < data.sand.length; i += 2) { const [x, y] = p.toCanvas(data.sand[i], data.sand[i + 1]); if (free(x, y)) g.fillRect(x, y, 1 * k, 1 * k); }
  yield;

  // --- water: lines parallel to the shore, four or five of them, fading out to sea; the lake's own; then the coast in ink.
  const levels = [-9, -19, -31, -45, -62];
  levels.forEach((lv, i) => strokeSegs(contourSegments(data.coast, data.nx, data.nz, B.x0, B.z0, CELL, lv), .95 - i * .1, WATER, 1.4 + i * .3, .6 - i * .1));
  yield;
  strokeSegs(contourSegments(data.lake, data.nx, data.nz, B.x0, B.z0, CELL, -6), .7, WATER, .8, .45);
  strokeSegs(contourSegments(data.lake, data.nx, data.nz, B.x0, B.z0, CELL, -13), .6, WATER, .8, .28);
  strokeSegs(contourSegments(data.lake, data.nx, data.nz, B.x0, B.z0, CELL, 0), 1.5, WATER, .6);
  strokeSegs(contourSegments(data.coast, data.nx, data.nz, B.x0, B.z0, CELL, 0), 2.1, ink, .6);
  yield;

  // The river, thin at its source and broader towards the sea (the way the water falls), drawn in short strokes of growing width.
  const rv = data.river;
  if (rv.length > 1) {
    const down = waterHeightAt(rv[rv.length - 1][1]) < waterHeightAt(rv[0][1]) ? 1 : -1;
    g.strokeStyle = WATER;
    for (let i = 1; i < rv.length; i++) {
      const t = down > 0 ? i / rv.length : 1 - i / rv.length, [ax, ay] = p.toCanvas(rv[i - 1][0], rv[i - 1][1]), [bx, by] = p.toCanvas(rv[i][0], rv[i][1]);
      g.lineWidth = (.9 + 2.6 * t * t) * k * u; g.beginPath(); g.moveTo(ax + wob(i * 1.7) * .5 * k, ay); g.lineTo(bx + wob(i * 1.7 + 1.7) * .5 * k, by); g.stroke();
    }
  }
  // The road: two lines, a bar at each tunnel mouth and the bridge's rails; then the paths, dotted.
  const line = (pts: [number, number][], width: number, color: string, dash: number[] = [], dy = 0) => {
    g.strokeStyle = color; g.lineWidth = width * k * u; g.setLineDash(dash.map(d => d * k * u)); g.beginPath();
    pts.forEach(([x, z], n) => { const [cx, cy] = p.toCanvas(x, z); if (n) g.lineTo(cx, cy + dy * k * u); else g.moveTo(cx, cy + dy * k * u); });
    g.stroke(); g.setLineDash([]);
  };
  // The road is bold: a ruled double line with a pale fill, over everything but the names.
  line(data.road, 4.2, ink); line(data.road, 2, roadFill);
  for (const e of ROAD_ENDS) { const [x, y] = p.toCanvas(e.x, e.z); g.lineWidth = 2.2 * k * u; g.strokeStyle = ink; g.beginPath(); g.moveTo(x, y - 6 * k * u); g.lineTo(x, y + 6 * k * u); g.stroke(); }
  { const [x, y] = p.toCanvas(ROAD_CROSSING.x, ROAD_CROSSING.z); g.lineWidth = 1.3 * k * u; g.strokeStyle = ink; g.beginPath(); for (const d of [-4, 0, 4]) { g.moveTo(x + d * k * u, y - 6 * k * u); g.lineTo(x + d * k * u, y + 6 * k * u); } g.stroke(); }
  for (const t of TRAIL_LINES) line(t.filter((_, n) => n % 2 === 0 || n === t.length - 1), 1.5, PATH, [4, 3.5]);
  yield;

  // --- furniture: on the sheet a ruled strip down the right holds the title, the legend, the compass and the scale, so none of it covers land;
  // on a board's square print the title, compass and scale sit in the sea at the corners. Names keep clear of all of it.
  const rule = 'rgba(43,33,24,.7)';
  const paperFill = (a: number) => `rgba(${Math.min(255, paper[0] + 6)},${Math.min(255, paper[1] + 6)},${Math.min(255, paper[2] + 8)},${a})`;
  const cartouche = (x: number, y: number, w: number, h: number, big: boolean) => {
    g.fillStyle = paperFill(.95); g.fillRect(x, y, w, h);
    g.strokeStyle = ink; g.lineWidth = 1.6 * k; g.strokeRect(x, y, w, h); g.lineWidth = .7 * k; g.strokeRect(x + 4 * k, y + 4 * k, w - 8 * k, h - 8 * k);
    g.fillStyle = ink; g.textAlign = 'center';
    let px = (big ? 22 : 17) * u * k; const name = islandName().toUpperCase();
    g.font = `bold ${px}px ${SERIF}`; spaced(px * .14);
    while (g.measureText(name).width > w - 22 * k && px > 10 * k) { px -= k; g.font = `bold ${px}px ${SERIF}`; spaced(px * .14); }
    g.fillText(name, x + w / 2 + px * .07, y + h * .5);
    spaced(1.2 * k); g.font = `italic ${(big ? 13 : 11.5) * u * k}px ${SERIF}`;
    g.fillText(board ? 'Trail map' : `Survey sheet  ·  No. ${1 + (Math.floor(WORLD_SEED || 7741) % 9)}`, x + w / 2, y + h * .8);
    spaced(0); g.textAlign = 'left';
  };
  const compass = (cx: number, cy: number, r: number) => {
    g.save(); g.translate(cx, cy); g.strokeStyle = ink; g.lineWidth = 1 * k;
    g.beginPath(); g.arc(0, 0, r * .62, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(0, 0, r * .68, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 4, len = i % 2 ? r * .62 : r, wd = i % 2 ? r * .1 : r * .16, tx = Math.cos(a) * len, ty = Math.sin(a) * len;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a - Math.PI / 2) * wd, Math.sin(a - Math.PI / 2) * wd); g.lineTo(tx, ty); g.closePath(); g.fillStyle = ink; g.fill();
      g.beginPath(); g.moveTo(0, 0); g.lineTo(-Math.cos(a - Math.PI / 2) * wd, -Math.sin(a - Math.PI / 2) * wd); g.lineTo(tx, ty); g.closePath(); g.stroke();
    }
    g.fillStyle = ink; g.textAlign = 'center'; g.font = `bold ${14 * u * k}px ${SERIF}`; g.fillText('N', 0, -r - 5 * k);
    g.restore(); g.textAlign = 'left';
  };
  const scaleBar = (x: number, y: number) => {
    // 0 to 200 m in two blocks.
    const len = 200 * p.scale, bh = 5 * k; g.strokeStyle = ink; g.lineWidth = 1.1 * k;
    for (let i = 0; i < 2; i++) { g.fillStyle = i ? paperFill(.9) : ink; g.fillRect(x + i * len / 2, y - bh, len / 2, bh); g.strokeRect(x + i * len / 2, y - bh, len / 2, bh); }
    g.fillStyle = ink; g.font = `italic ${11 * u * k}px ${SERIF}`; g.textAlign = 'center';
    g.fillText('0', x, y + 13 * u * k); g.fillText('100', x + len / 2, y + 13 * u * k); g.fillText('200 m', x + len + 6 * k, y + 13 * u * k); g.textAlign = 'left';
    return [x - 8 * k, y - bh - 4 * k, x + len + 40 * k, y + 18 * u * k] as Box;
  };
  const legendFont = `${11.5 * k}px ${SERIF}`;
  if (!board) {
    const sx = AW, sw = W - AW, pad = 14 * k;
    g.fillStyle = paperFill(1); g.fillRect(sx, 0, sw, H);
    g.globalCompositeOperation = 'multiply'; g.fillStyle = g.createPattern(grainTile(), 'repeat')!; g.globalAlpha = .5; g.fillRect(sx, 0, sw, H); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.strokeStyle = rule; g.lineWidth = 1.4 * k; g.beginPath(); g.moveTo(sx, 0); g.lineTo(sx, H); g.stroke(); g.lineWidth = .7 * k; g.beginPath(); g.moveTo(sx + 4 * k, 0); g.lineTo(sx + 4 * k, H); g.stroke();
    cartouche(sx + pad, 22 * k, sw - pad * 2, 68 * k, false);
    // The legend: what each mark on the sheet means, in the sheet's own ink.
    type Row = { lines: string[]; sample: (x: number, y: number, w: number) => void };
    const ringSeed = 5.5;
    const rows: Row[] = [
      { lines: ['Road'], sample: (x, y, w) => { g.strokeStyle = ink; g.lineWidth = 4.2 * k; g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.stroke(); g.strokeStyle = roadFill; g.lineWidth = 2 * k; g.stroke(); } },
      { lines: ['Path'], sample: (x, y, w) => { g.strokeStyle = PATH; g.lineWidth = 1.5 * k; g.setLineDash([4 * k, 3.5 * k]); g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.stroke(); g.setLineDash([]); } },
      { lines: ['River, stream'], sample: (x, y, w) => { g.strokeStyle = WATER; for (let i = 0; i < 8; i++) { g.lineWidth = (.8 + i * .3) * k; g.beginPath(); g.moveTo(x + i * w / 8, y + Math.sin(i) * k); g.lineTo(x + (i + 1) * w / 8, y + Math.sin(i + 1) * k); g.stroke(); } } },
      { lines: ['Lake, sea'], sample: (x, y, w) => { g.fillStyle = 'rgb(168,192,198)'; g.fillRect(x, y - 5 * k, w, 10 * k); g.strokeStyle = WATER; g.lineWidth = 1.3 * k; g.strokeRect(x, y - 5 * k, w, 10 * k); } },
      { lines: ['Contours,', '10 m (50 m bold)'], sample: (x, y, w) => { g.strokeStyle = CONTOUR; g.lineWidth = .7 * k; g.beginPath(); g.moveTo(x, y - 4 * k); g.lineTo(x + w, y - 4 * k); g.stroke(); g.lineWidth = 1.3 * k; g.beginPath(); g.moveTo(x, y + 4 * k); g.lineTo(x + w, y + 4 * k); g.stroke(); } },
      // As the forest is drawn now: the green-grey wash with a few small filled crowns on it (no longer open circles).
      { lines: ['Forest'], sample: (x, y, w) => { g.fillStyle = 'rgba(96,112,84,.16)'; g.fillRect(x, y - 5 * k, w, 10 * k); g.fillStyle = 'rgba(62,88,50,.55)'; g.beginPath(); for (const [dx, dy] of [[.15, -2], [.45, 2.5], [.75, -1.5], [.92, 2]]) { g.moveTo(x + w * dx + 1.6 * k, y + dy * k); g.arc(x + w * dx, y + dy * k, 1.6 * k, 0, Math.PI * 2); } g.fill(); } },
      { lines: ['Key place'], sample: (x, y, w) => { const cx = x + w / 2, rr = 5.2 * k; g.fillStyle = ink; g.fillRect(cx - rr, y - rr + 2 * k, rr * 2, rr * 2); g.beginPath(); g.moveTo(cx, y - rr + 2 * k); g.lineTo(cx, y - rr * 2.4 + 2 * k); g.lineTo(cx + rr * 1.6, y - rr * 1.9 + 2 * k); g.lineTo(cx, y - rr * 1.4 + 2 * k); g.fill(); } },
      { lines: ['Named place'], sample: (x, y, w) => { const cx = x + w / 2; g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1.3 * k; g.beginPath(); g.arc(cx, y, 3.6 * k, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(cx, y, 1.3 * k, 0, Math.PI * 2); g.fill(); } },
      { lines: ['A part the board', 'says is here'], sample: (x, y, w) => { g.lineCap = 'round'; pencilLoop(g, x + w / 2, y, 11 * k, ringSeed, k); } },
      { lines: ['You are here', '(named places only)'], sample: (x, y, w) => { drawCross(g, x + w / 2, y, 6 * k, k, 3); } },
    ];
    const titleH = 26 * k, rowH = (r: Row) => (r.lines.length > 1 ? 30 : 19) * k;
    const top = 22 * k + 68 * k + 12 * k, bottom = H - 96 * k, need = titleH + rows.reduce((a, r) => a + rowH(r), 0) + 10 * k, f = Math.min(1, (bottom - top) / need);
    const lx = sx + pad, lw = sw - pad * 2, lh = need * f;
    g.fillStyle = paperFill(.6); g.fillRect(lx, top, lw, lh); g.strokeStyle = rule; g.lineWidth = 1.2 * k; g.strokeRect(lx, top, lw, lh);
    g.fillStyle = ink; g.textAlign = 'center'; g.font = `bold ${10.5 * k}px ${SERIF}`; spaced(2.4 * k); g.fillText('LEGEND', lx + lw / 2, top + 17 * k); spaced(0); g.textAlign = 'left';
    let y = top + titleH * f;
    for (const r of rows) {
      const h = rowH(r) * f, cy = y + h / 2;
      g.save(); g.lineCap = 'round'; r.sample(lx + 10 * k, cy, 38 * k); g.restore();
      g.fillStyle = ink; g.font = legendFont; g.textBaseline = 'middle';
      r.lines.forEach((t, i) => g.fillText(t, lx + 56 * k, cy + (i - (r.lines.length - 1) / 2) * 12.5 * k));
      g.textBaseline = 'alphabetic'; y += h;
    }
    compass(sx + sw - 44 * k, H - 54 * k, 30 * k);
    scaleBar(sx + pad, H - 30 * k);
  } else {
    const cw = 188 * u * k, ch = 58 * u * k, cx0 = 30 * k, cy0 = 30 * k, cr = 34 * u * k, ccx = W - cr - 40 * k, ccy = H - cr - 42 * k;
    cartouche(cx0, cy0, cw, ch, false);
    compass(ccx, ccy, cr);
    scaleBar(40 * k, H - 36 * k);
  }
  yield;

  const drawLabel = (it: (typeof items)[number], sp: LabelSpot, gg: CanvasRenderingContext2D) => {
    const rr = (it.key ? 5.2 : 3.4) * u * k;
    if (sp.leader) {
      const tx = Math.max(sp.box[0], Math.min(sp.box[2], it.cx)), ty = Math.max(sp.box[1], Math.min(sp.box[3] - 3 * k, it.cy)), dx = tx - it.cx, dy = ty - it.cy, d = Math.hypot(dx, dy) || 1;
      gg.strokeStyle = ink; gg.lineWidth = 1 * k * u; gg.globalAlpha = .9; gg.beginPath(); gg.moveTo(it.cx + dx / d * (rr + 2 * k), it.cy + dy / d * (rr + 2 * k)); gg.lineTo(tx, ty); gg.stroke(); gg.globalAlpha = 1;
    }
    const shown = it.key ? it.text : it.variants[sp.v]?.text ?? it.text;
    gg.font = labelFont(it.key, it.key ? sp.v : 0); gg.textBaseline = 'alphabetic';
    if ('letterSpacing' in gg) (gg as unknown as { letterSpacing: string }).letterSpacing = it.key ? `${1.6 * fu * k}px` : '0px';
    gg.lineJoin = 'round'; gg.lineWidth = 3.4 * k * u; gg.strokeStyle = `rgba(${paper[0]},${paper[1]},${paper[2]},.82)`; gg.strokeText(shown, sp.x, sp.y);
    gg.fillStyle = ink; gg.fillText(shown, sp.x, sp.y);
    if ('letterSpacing' in gg) (gg as unknown as { letterSpacing: string }).letterSpacing = '0px';
  };
  for (const it of items) {
    const { cx, cy } = it, rr = (it.key ? 5.2 : 3.4) * u * k;
    g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = (it.key ? 1.8 : 1.3) * k * u;
    if (it.key) { g.fillRect(cx - rr, cy - rr, rr * 2, rr * 2); g.beginPath(); g.moveTo(cx, cy - rr); g.lineTo(cx, cy - rr * 2.6); g.lineTo(cx + rr * 1.6, cy - rr * 2); g.lineTo(cx, cy - rr * 1.5); g.fill(); }
    else { g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(cx, cy, rr * .35, 0, Math.PI * 2); g.fill(); }
    const sp = spots.get(it.id); if (sp) drawLabel(it, sp, g);
  }
  // A ringed place whose name was dropped gets it now, further off if it has to (the ring is drawn later, over a copy of this sheet).
  const extras = new Map<string, LabelSpot>(), allSpots = new Map(spots);
  const labels = {
    spots, items, area, blocked: stripBlock,
    extra(id: string): LabelSpot | undefined {
      if (allSpots.has(id)) return extras.get(id);
      const it = items.find(i => i.id === id); if (!it) return undefined;
      const got = placeLabels([{ ...it, must: true }, ...items.filter(i => i.id !== id)], stripBlock, area, 3 * k, allSpots, maxOff).get(id);
      if (got) { extras.set(id, got); allSpots.set(id, got); }
      return got;
    },
    drawById: (id: string, sp: LabelSpot, gg: CanvasRenderingContext2D) => { const it = items.find(i => i.id === id); if (it) drawLabel(it, sp, gg); },
  };
  yield;

  // --- the border, and the age of it: edges darkened, fold creases with a light and a shade side, a worn outline.
  g.strokeStyle = 'rgba(43,33,24,.65)'; g.lineWidth = 1.5 * k * u; g.strokeRect(13 * k * u + (board ? 4 * k : 0), 13 * k * u + (board ? 4 * k : 0), W - 26 * k * u - (board ? 8 * k : 0), H - 26 * k * u - (board ? 8 * k : 0));
  g.lineWidth = .8 * k * u; g.strokeRect(18 * k * u + (board ? 4 * k : 0), 18 * k * u + (board ? 4 * k : 0), W - 36 * k * u - (board ? 8 * k : 0), H - 36 * k * u - (board ? 8 * k : 0));
  const edge = (x0: number, y0: number, x1: number, y1: number, a: number) => { const gr = g.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, `rgba(95,62,25,${a})`); gr.addColorStop(1, 'rgba(95,62,25,0)'); g.fillStyle = gr; };
  const band = 56 * u * k;
  edge(0, 0, band, 0, board ? .3 : .42); g.fillRect(0, 0, band, H); edge(W, 0, W - band, 0, board ? .3 : .42); g.fillRect(W - band, 0, band, H);
  edge(0, 0, 0, band, board ? .3 : .42); g.fillRect(0, 0, W, band); edge(0, H, 0, H - band, board ? .3 : .42); g.fillRect(0, H - band, W, band);
  const creaseX = [W * .5], creaseY = [H * .5, ...(board ? [] : [])];
  for (const cx of creaseX) {
    const gr = g.createLinearGradient(cx - 28 * k, 0, cx + 28 * k, 0); gr.addColorStop(0, 'rgba(255,248,225,.0)'); gr.addColorStop(.46, 'rgba(255,248,225,.1)'); gr.addColorStop(.5, 'rgba(60,40,15,.22)'); gr.addColorStop(.54, 'rgba(60,40,15,.07)'); gr.addColorStop(1, 'rgba(60,40,15,0)');
    g.fillStyle = gr; g.fillRect(cx - 28 * k, 0, 56 * k, H);
    g.strokeStyle = 'rgba(255,250,235,.42)'; g.lineWidth = 1 * k; g.beginPath(); g.moveTo(cx + 1 * k, 0); g.lineTo(cx + 1 * k, H); g.stroke();
    g.strokeStyle = 'rgba(70,48,20,.3)'; g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke();
  }
  for (const cy of creaseY) {
    const gr = g.createLinearGradient(0, cy - 28 * k, 0, cy + 28 * k); gr.addColorStop(0, 'rgba(255,248,225,0)'); gr.addColorStop(.46, 'rgba(255,248,225,.1)'); gr.addColorStop(.5, 'rgba(60,40,15,.2)'); gr.addColorStop(.54, 'rgba(60,40,15,.06)'); gr.addColorStop(1, 'rgba(60,40,15,0)');
    g.fillStyle = gr; g.fillRect(0, cy - 28 * k, W, 56 * k);
    g.strokeStyle = 'rgba(255,250,235,.4)'; g.lineWidth = 1 * k; g.beginPath(); g.moveTo(0, cy + k); g.lineTo(W, cy + k); g.stroke();
    g.strokeStyle = 'rgba(70,48,20,.28)'; g.beginPath(); g.moveTo(0, cy); g.lineTo(W, cy); g.stroke();
  }
  if (board) {
    // Pinned out of doors: sun-bleached from the top, streaked by rain, a pin at each upper corner.
    const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, 'rgba(250,246,232,.28)'); gr.addColorStop(.6, 'rgba(250,246,232,.06)'); gr.addColorStop(1, 'rgba(60,70,50,.1)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 26; i++) { const x = R() * W, y0 = R() * H * .6, l = (40 + R() * 220) * k, sg = g.createLinearGradient(0, y0, 0, y0 + l); sg.addColorStop(0, 'rgba(90,70,40,0)'); sg.addColorStop(.3, `rgba(90,70,40,${.04 + R() * .05})`); sg.addColorStop(1, 'rgba(90,70,40,0)'); g.fillStyle = sg; g.fillRect(x, y0, (1 + R() * 2.5) * k, l); }
    for (const [x, y] of [[26, 26], [W / k - 26, 26], [26, H / k - 26], [W / k - 26, H / k - 26]]) {
      const r = 6 * k, cx = x * k, cy = y * k, ps = g.createRadialGradient(cx - 2 * k, cy - 2 * k, 0, cx, cy, r);
      g.fillStyle = 'rgba(0,0,0,.3)'; g.beginPath(); g.arc(cx + 2 * k, cy + 3 * k, r, 0, Math.PI * 2); g.fill();
      ps.addColorStop(0, '#d9c9a0'); ps.addColorStop(1, '#5a4a30'); g.fillStyle = ps; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    }
  } else {
    // A worn outline: the sheet's edge nibbled away (transparent), with bigger bites at the corners.
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.beginPath(); g.rect(-2, -2, W + 4, H + 4);
    const inset = (t: number) => (1.2 + R() * 1.6 + Math.max(0, Math.sin(t * 40)) * .8) * k;
    const steps = 160; g.moveTo(inset(0), inset(0));
    for (let i = 1; i <= steps; i++) g.lineTo((W * i) / steps, inset(i));
    for (let i = 1; i <= steps; i++) g.lineTo(W - inset(i), (H * i) / steps);
    for (let i = 1; i <= steps; i++) g.lineTo(W - (W * i) / steps, H - inset(i));
    for (let i = 1; i <= steps; i++) g.lineTo(inset(i), H - (H * i) / steps);
    g.closePath(); g.fill('evenodd');
    for (const [x, y, sx, sy] of [[0, 0, 1, 1], [W, 0, -1, 1], [0, H, 1, -1], [W, H, -1, -1]]) {
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + sx * (9 + R() * 10) * k, y); g.lineTo(x + sx * (3 + R() * 4) * k, y + sy * (4 + R() * 6) * k); g.lineTo(x, y + sy * (9 + R() * 10) * k); g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }
  return { canvas: c, proj: p, k, u, view, labels };
}

// ---------------------------------------------------------------- pencil

/** One loose graphite loop round a place, as a hand would draw it: a slightly elliptical stroke that overshoots its start, pressing harder mid-way. */
function pencilLoop(g: CanvasRenderingContext2D, cx: number, cy: number, r0: number, seed: number, k: number) {
  const R = rng(Math.floor(seed * 1000)), tilt = R() * Math.PI, ratio = .82 + R() * .14, passes = R() < .5 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const start = R() * Math.PI * 2, turns = 1.12 + R() * .1, drift = (R() - .5) * .22, grow = .1 + pass * .04, n = 54;
    const dr = pass * (.04 + R() * .05) * r0, dx = (R() - .5) * 2 * k, dy = (R() - .5) * 2 * k;
    let px = 0, py = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = start + t * Math.PI * 2 * turns, rad = (r0 + dr) * (1 + drift * Math.sin(t * 5 + seed) * .4 + grow * (t - .5) * 2 + (R() - .5) * .03);
      const ex = Math.cos(a) * rad, ey = Math.sin(a) * rad * ratio, x = cx + dx + ex * Math.cos(tilt) - ey * Math.sin(tilt), y = cy + dy + ex * Math.sin(tilt) + ey * Math.cos(tilt);
      if (i) {
        const press = .55 + .45 * Math.sin(Math.PI * Math.min(1, t * .95 + .03));
        g.lineWidth = (1.1 + 1.1 * press * (pass ? .75 : 1)) * k; g.strokeStyle = `rgba(62,57,52,${.5 + press * .3 - pass * .12})`;
        g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
      }
      px = x; py = y;
    }
  }
}

/** The little cross read off a place's sign: two quick strokes, each gone over twice, never quite straight. */
function drawCross(g: CanvasRenderingContext2D, cx: number, cy: number, s: number, k: number, seedIn: number) {
  const R = rng(Math.floor(seedIn * 777)); g.lineCap = 'round';
  for (const [ax, ay, bx, by] of [[-1, -.9, 1, 1.1], [.9, -1, -1.1, 1]]) {
    const j = () => (R() - .5) * .5 * k;
    for (let pass = 0; pass < 2; pass++) {
      g.lineWidth = (2.2 - pass * .8) * k * Math.max(.8, 1); g.strokeStyle = `rgba(62,57,52,${.85 - pass * .25})`;
      g.beginPath(); g.moveTo(cx + ax * s + j(), cy + ay * s + j()); g.quadraticCurveTo(cx + j() * 2, cy + j() * 2, cx + bx * s + j(), cy + by * s + j()); g.stroke();
    }
  }
}

/** The pencil marks over a finished sheet: loops round the ringed places (with their names, if the sheet had to leave them out) and, at hereId, the cross. */
export function paintPencil(g: CanvasRenderingContext2D, sheet: MapSheet, ringIds: ReadonlySet<string>, hereId: string | undefined) {
  const { proj, k, u } = sheet;
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const place of PLACES) {
    const [cx, cy] = proj.toCanvas(place.x, place.z), seed = place.x * .37 + place.z * .91;
    if (ringIds.has(place.id)) {
      pencilLoop(g, cx, cy, (place.key ? 16 : 12.5) * u * k, seed, k * Math.max(.8, u));
      if (!sheet.labels.spots.has(place.id)) { const sp = sheet.labels.extra(place.id); if (sp) sheet.labels.drawById(place.id, sp, g); }
    }
    if (hereId === place.id) drawCross(g, cx, cy, 6.5 * u * k, k * Math.max(.8, u), seed);
  }
}
