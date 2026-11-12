import { noise, smooth, type BiomeWeights } from './world';
import type { LayoutCell } from './placement';
import { communityAt } from './plant-communities';

/**
 * Where the forest-floor plants grow. Pure (no three.js): undergrowth.ts draws what this returns.
 *
 * Plants read as a forest floor rather than a sprinkle when they follow what drives a real one (after Guerrilla's placement
 * in Horizon Zero Dawn, GDC 2017, and the plant-ecosystem literature; work/gfx/research/foliage-research.md):
 *   - a light field from the crowns overhead (the same crown discs as the fog's canopy map in atmosphere.ts) and a moisture
 *     field (broad noise, hollows in the ground, and the ground shader's own damp mask, so plants grow where the moss is);
 *   - a niche per plant over those fields, scaled by the large-scale community (plant-communities.ts);
 *   - one shared roll per spot within a layer, so plants compete for ground instead of piling up, in the ratio of their
 *     niches;
 *   - colonies (a cellular field a few metres across, big plants at the centre, young ones at the rim) and bare gaps;
 *   - three layers placed tallest first; a lower plant does not grow under a taller one's crown;
 *   - anchors: nothing grows inside a trunk, rock, stump or fallen log, ferns and seedlings crowd along logs and in rock
 *     skirts, and the ground right round a trunk is thin (roots and litter).
 * The fields are worked out on a 9 x 9 raster per 6.4 m cell (the expensive part) and every candidate reads them bilinearly.
 */
export const FLORA = ['fern', 'shrub', 'tussock', 'herb', 'celandine'] as const;
export type Flora = typeof FLORA[number];
export type GrownPlant = { flora: Flora; x: number; z: number; size: number; yaw: number; variant: number; tint: number; leaf: number; dry: number };

/** reach: crown radius in metres per unit of size (from the scans' bounds); size: render scale range; maxExclusion: how far
 * into paths, clearings and yards it goes (vegetationExclusion: 0 open ground, 1 path core or wall). */
export const TRAITS: Record<Flora, { reach: number; size: readonly [number, number]; maxExclusion: number; shade: boolean }> = {
  fern: { reach: .38, size: [1, 1.9], maxExclusion: .48, shade: false },
  shrub: { reach: .07, size: [2.6, 4.4], maxExclusion: .5, shade: false },
  tussock: { reach: .1, size: [.9, 2], maxExclusion: .7, shade: false },
  herb: { reach: .16, size: [1, 1.7], maxExclusion: .66, shade: false },
  celandine: { reach: .13, size: [1.3, 2.4], maxExclusion: .55, shade: true },
};
/** Tallest first. Young ferns join the middle layer at a fraction of their size. */
const TIERS: { flora: readonly Flora[]; spacing: number; scale: Partial<Record<Flora, number>> }[] = [
  { flora: ['fern', 'shrub'], spacing: 1.3, scale: {} },
  { flora: ['tussock', 'herb', 'fern'], spacing: 1.07, scale: { fern: .55 } },
  { flora: ['celandine'], spacing: .4, scale: {} },
];

export type EcologyWorld = {
  heightAt: (x: number, z: number) => number;
  exclusion: (x: number, z: number) => number;
  biomeAt: (x: number, z: number) => BiomeWeights;
  /** The forest layout (placement.ts): trees, rubble, deadfall and stumps, in 32 m cells. */
  layoutCell: (cx: number, cz: number) => LayoutCell;
  radius: number;
};

const f32 = Math.fround, fract = (v: number) => f32(v - Math.floor(v));
/** A twin of the ground shader's patchHash/surfaceNoise (texture-variation.ts), in single precision like the GPU. */
function patchHash(px: number, py: number) {
  let qx = fract(f32(px * f32(.1031))), qy = fract(f32(py * f32(.103))), qz = fract(f32(px * f32(.0973)));
  const d = f32(f32(qx * f32(qy + f32(33.33))) + f32(qy * f32(qz + f32(33.33))) + f32(qz * f32(qx + f32(33.33))));
  qx = f32(qx + d); qy = f32(qy + d); qz = f32(qz + d);
  return fract(f32(f32(qx + qy) * qz));
}
export function surfaceNoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = patchHash(ix, iy), b = patchHash(ix + 1, iy), c = patchHash(ix, iy + 1), d = patchHash(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
/** The ground shader's damp mask (terrain.ts: `damp`), where it lays the moss carpet. */
export const groundDamp = (x: number, z: number) =>
  smooth(surfaceNoise(f32(f32(x * f32(.043)) + 40), f32(f32(z * f32(.043)) + 40)) * .65 + surfaceNoise(f32(f32(x * f32(.19)) + 3), f32(f32(z * f32(.19)) + 3)) * .35, .5, .82);

/** Integer hash in 0..1, independent of streaming order. */
function roll(a: number, b: number, salt: number) {
  let n = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(salt, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

type Anchors = {
  trees: { x: number; z: number; r: number; crown: number; dense: number }[];
  logs: { ax: number; az: number; bx: number; bz: number; r: number }[];
  rocks: { x: number; z: number; r: number }[];
  stumps: { x: number; z: number; r: number }[];
};
const N = 9;   // raster points per side of a cell
// Raster channels: one niche density per flora, then fine grass, exclusion, broadleaf share, dryness, leafy carpet, light.
const CH = FLORA.length + 6, GRASS = FLORA.length, EXCL = GRASS + 1, LEAF = GRASS + 2, DRY = GRASS + 3, CARPET = GRASS + 4, LIGHT = GRASS + 5;

export function createEcology(world: EcologyWorld, cellSize = 6.4) {
  const LAYOUT = 32;
  const rasters = new Map<string, Float32Array>();

  function anchorsAround(x0: number, z0: number, x1: number, z1: number, margin: number): Anchors {
    const out: Anchors = { trees: [], logs: [], rocks: [], stumps: [] };
    const inside = (x: number, z: number, m: number) => x > x0 - m && x < x1 + m && z > z0 - m && z < z1 + m;
    for (let cx = Math.floor((x0 - margin) / LAYOUT); cx <= Math.floor((x1 + margin) / LAYOUT); cx++)
      for (let cz = Math.floor((z0 - margin) / LAYOUT); cz <= Math.floor((z1 + margin) / LAYOUT); cz++) {
        const cell = world.layoutCell(cx, cz);
        for (const t of cell.trees) {
          if (!inside(t.x, t.z, margin)) continue;
          // As atmosphere.ts's canopy map: a crown of radius 15% of the tree's height (2 to 5.5 m); some crowns let more through.
          const tall = 31 * t.height;
          // Blocked: the trunk and its root flare (the trunk collider is .44 x width + .08), not the whole reserved footprint.
          out.trees.push({ x: t.x, z: t.z, r: .62 * t.width + .15, crown: Math.min(5.5, Math.max(2, tall * .15)), dense: .72 + .28 * Math.abs(Math.sin(t.x * 12.9898 + t.z * 78.233) * 43758.5453 % 1) });
        }
        for (const r of cell.rubble) if (inside(r.x, r.z, margin)) out.rocks.push({ x: r.x, z: r.z, r: r.size * 1.15 });
        for (const s of cell.stumps) if (inside(s.x, s.z, margin)) out.stumps.push({ x: s.x, z: s.z, r: s.size * 1.05 });
        for (const d of cell.deadfall) {
          if (!inside(d.x, d.z, margin + d.size * .5)) continue;
          const dx = Math.sin(d.yaw) * d.size * .5, dz = Math.cos(d.yaw) * d.size * .5;
          out.logs.push({ ax: d.x - dx, az: d.z - dz, bx: d.x + dx, bz: d.z + dz, r: d.variant + .08 });
        }
      }
    return out;
  }
  function canopy(x: number, z: number, trees: Anchors['trees']) {
    let cover = 0;
    for (const t of trees) {
      const d = Math.hypot(x - t.x, z - t.z) / t.crown;
      if (d >= 1) continue;
      const k = Math.min(1, (1 - d) / .65);
      cover = Math.max(cover, t.dense * k * k * (3 - 2 * k));
    }
    return cover;
  }
  /** Light and moisture, then the niche of every plant, at one point. */
  function sample(x: number, z: number, anchors: Anchors, out: Float32Array, at: number) {
    const b = world.biomeAt(x, z), e = world.exclusion(x, z), c = communityAt(x, z, b), h = world.heightAt;
    const edge = smooth(e, .04, .2) * (1 - smooth(e, .4, .62));   // a path's margin: more light, trampled now and then
    const light = Math.min(1, 1 - canopy(x, z, anchors.trees) + .35 * edge + .3 * b.heath);
    const y = h(x, z), xp = h(x + 2, z), xm = h(x - 2, z), zp = h(x, z + 2), zm = h(x, z - 2);
    const hollow = smooth((xp + xm + zp + zm) * .25 - y, -.04, .12), slope = Math.hypot(xp - xm, zp - zm) / 4;
    const moisture = Math.min(1, Math.max(0, .4 * noise(x * .018 + 5, z * .018 - 11) + .3 * hollow + .3 * groundDamp(x, z) - .4 * smooth(slope, .15, .5) + .1 * b.grove - .3 * b.heath));
    const wild = 1 - b.alpine;
    const keep = (f: Flora) => 1 - smooth(e, TRAITS[f].maxExclusion - .12, TRAITS[f].maxExclusion);
    // A temperate rainforest: ferns, celandine and the low shrubs (huckleberry and salal in kind) are shade plants that
    // follow moisture and grow under a closed canopy; grass and the tall herbs need the light of gaps and path margins.
    const niche: Record<Flora, number> = {
      fern: (.45 + .55 * smooth(moisture, .1, .5)) * (1 - .4 * smooth(light, .8, 1)) * (1 - b.heath * .8) * (.55 + 1.6 * c.fern),
      shrub: (.3 + .7 * smooth(light, .1, .5)) * (.6 + .6 * b.grove) * (1 - .3 * moisture) * (.35 + 1.3 * c.shrub),
      tussock: (smooth(light, .25, .65) * (.4 + .6 * (1 - moisture)) * (.3 + 1.4 * c.grass) * (1 + 1.2 * edge) + .4 * b.heath),
      herb: smooth(light, .1, .45) * smooth(moisture, .15, .5) * (.4 + 1.5 * c.herb) * (1 + 1.5 * edge),
      celandine: smooth(moisture, .12, .45) * (1 - .5 * smooth(light, .8, 1)) * (.5 + 1.6 * c.herb),
    };
    for (let i = 0; i < FLORA.length; i++) out[at + i] = Math.min(1, niche[FLORA[i]] * wild * keep(FLORA[i]));
    out[at + GRASS] = smooth(light, .3, .75) * (.35 + .65 * (1 - moisture)) * (.25 + 1.4 * c.grass) * (1 + edge) * wild;
    out[at + EXCL] = e;
    // The leafy carpet (ivy and low rosettes, undergrowth.ts): a shade plant of damp ground, the floor's lowest green layer.
    out[at + CARPET] = smooth(moisture, .15, .55) * (1 - .6 * smooth(light, .75, 1)) * (.4 + 1.4 * c.herb + .6 * c.moss + .3 * c.fern) * wild * keep('celandine');
    out[at + LIGHT] = light;
    out[at + LEAF] = b.grove + b.heath * .55;
    out[at + DRY] = b.heath * .83 + b.alpine * .45;
  }
  function rasterFor(cx: number, cz: number, anchors?: Anchors) {
    const key = `${cx},${cz}`;
    let raster = rasters.get(key);
    if (raster) return raster;
    const x0 = cx * cellSize, z0 = cz * cellSize;
    anchors ??= anchorsAround(x0, z0, x0 + cellSize, z0 + cellSize, 6);
    raster = new Float32Array(N * N * CH);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) sample(x0 + i * cellSize / (N - 1), z0 + j * cellSize / (N - 1), anchors, raster, (j * N + i) * CH);
    rasters.set(key, raster);
    if (rasters.size > 900) rasters.delete(rasters.keys().next().value!);
    return raster;
  }
  /** One raster channel at a point, bilinearly. */
  function field(x: number, z: number, channel: number) {
    const cx = Math.floor(x / cellSize), cz = Math.floor(z / cellSize), raster = rasterFor(cx, cz);
    const u = (x / cellSize - cx) * (N - 1), v = (z / cellSize - cz) * (N - 1);
    const i = Math.min(N - 2, Math.floor(u)), j = Math.min(N - 2, Math.floor(v)), fu = u - i, fv = v - j;
    const at = (a: number, b: number) => raster[((j + b) * N + i + a) * CH + channel];
    return (at(0, 0) * (1 - fu) + at(1, 0) * fu) * (1 - fv) + (at(0, 1) * (1 - fu) + at(1, 1) * fu) * fv;
  }
  /** Bare patches 2 to 5 m across where nothing vascular grows: moss and litter only, about a fifth of the floor. */
  const gap = (x: number, z: number) => 1 - .85 * smooth(noise(x * .35 + 71, z * .35 - 13), .62, .72);

  /**
   * Colonies: a cellular field with 3.2 m cells. A cell may hold a colony (more often where more would grow); it stands
   * at a jittered centre, has a radius of 0.8 to 2.3 m and belongs to one plant, picked by a roll weighted by the niches.
   */
  const COLONY = 3.2;
  const colonies = new Map<string, { x: number; z: number; r: number; flora: Flora | undefined; tint: number }>();
  function colony(ix: number, iz: number) {
    const key = `${ix},${iz}`;
    let c = colonies.get(key);
    if (c) return c;
    const x = (ix + .15 + .7 * roll(ix, iz, 601)) * COLONY, z = (iz + .15 + .7 * roll(ix, iz, 602)) * COLONY;
    let total = 0;
    const weights = FLORA.map((_, k) => { const w = field(x, z, k); total += w; return w; });
    let flora: Flora | undefined;
    // Not every cell holds a colony: fewer where little would grow, so colonies stand apart with plain floor between.
    if (roll(ix, iz, 606) < .8 * smooth(total, .15, 1.2)) {
      let u = roll(ix, iz, 603) * total;
      for (let k = 0; k < FLORA.length; k++) { u -= weights[k]; if (u <= 0) { flora = FLORA[k]; break; } }
    }
    c = { x, z, r: .8 + 1.5 * roll(ix, iz, 604), flora, tint: .88 + .2 * roll(ix, iz, 605) };
    colonies.set(key, c);
    if (colonies.size > 6000) colonies.delete(colonies.keys().next().value!);
    return c;
  }
  function nearestColony(x: number, z: number) {
    const ix = Math.floor(x / COLONY), iz = Math.floor(z / COLONY);
    let best: ReturnType<typeof colony> | undefined, inner = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const c = colony(ix + a, iz + b);
      if (!c.flora) continue;
      // Distance in units of the colony's radius, so a large colony can reach past a small neighbour.
      const d = Math.hypot(x - c.x, z - c.z) / c.r;
      if (d < inner) { inner = d; best = c; }
    }
    return { colony: best, depth: best && inner < 1 ? 1 - inner : 0 };
  }

  /** Every plant of one cell, tallest layer first. Deterministic: the same cell always grows the same plants. */
  function grow(cx: number, cz: number): GrownPlant[] {
    const x0 = cx * cellSize, z0 = cz * cellSize;
    const anchors = anchorsAround(x0, z0, x0 + cellSize, z0 + cellSize, 6);
    rasterFor(cx, cz, anchors);
    const plants: GrownPlant[] = [], crowns: { x: number; z: number; r: number }[] = [];
    const segment = (x: number, z: number, l: Anchors['logs'][number]) => {
      const dx = l.bx - l.ax, dz = l.bz - l.az, t = Math.max(0, Math.min(1, ((x - l.ax) * dx + (z - l.az) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(x - l.ax - dx * t, z - l.az - dz * t);
    };
    TIERS.forEach((tier, t) => {
      const n = Math.round(cellSize / tier.spacing), step = cellSize / n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const gx = cx * n + i, gz = cz * n + j, salt = 700 + t * 31;
        const x = x0 + (i + .5 + (roll(gx, gz, salt) - .5) * .9) * step, z = z0 + (j + .5 + (roll(gx, gz, salt + 1) - .5) * .9) * step;
        if (Math.hypot(x, z) > world.radius - 55) continue;
        // Anchors: nothing inside trunks, rocks, stumps and logs; logs and rock skirts are good ground; a trunk's root zone is thin.
        let blocked = false, nurse = 1, shadeRing = 1;
        for (const tr of anchors.trees) { const d = Math.hypot(x - tr.x, z - tr.z); if (d < tr.r) { blocked = true; break; } if (d < tr.r + 1) shadeRing = Math.min(shadeRing, .55 + .45 * (d - tr.r)); }
        if (blocked) continue;
        for (const r of anchors.rocks) { const d = Math.hypot(x - r.x, z - r.z); if (d < r.r) { blocked = true; break; } if (d < r.r + 1.2) nurse = Math.max(nurse, 2); }
        if (blocked) continue;
        for (const s of anchors.stumps) { const d = Math.hypot(x - s.x, z - s.z); if (d < s.r) { blocked = true; break; } if (d < s.r + 1) nurse = Math.max(nurse, 1.5); }
        if (blocked) continue;
        for (const l of anchors.logs) { const d = segment(x, z, l); if (d < l.r) { blocked = true; break; } if (d < l.r + .7) nurse = Math.max(nurse, 2.5); }
        if (blocked) continue;
        // Under the crown of a taller plant already placed: only shade plants, and those do better in the ring just outside it.
        let under = false, ring = false;
        for (const c of crowns) { const d = Math.hypot(x - c.x, z - c.z); if (d < c.r * .7) { under = true; break; } if (d < c.r * 1.5) ring = true; }
        const { colony: col, depth } = nearestColony(x, z), open = gap(x, z);
        let total = 0;
        const density = tier.flora.map(f => {
          if (under && !TRAITS[f].shade) return 0;
          let d = field(x, z, FLORA.indexOf(f)) * open * (TRAITS[f].shade ? (ring ? 1.5 : 1) : shadeRing);
          if (f !== 'tussock' && f !== 'shrub') d *= nurse;
          // In a colony of its own kind a plant is many times as likely as a scattered single: contrast, not count.
          d *= col?.flora === f ? .08 + 6 * depth ** 1.2 : .08;
          total += d;
          return d;
        });
        if (total <= 0) continue;
        let u = roll(gx, gz, salt + 2) * Math.max(1, total), chosen = -1;
        for (let k = 0; k < density.length; k++) { u -= density[k]; if (u < 0) { chosen = k; break; } }
        if (chosen < 0) continue;
        const flora = tier.flora[chosen], trait = TRAITS[flora], member = col?.flora === flora && depth > 0;
        // Big plants in a colony's middle, young ones at its rim; a colony shares a tint, plants vary a little about it.
        const r0 = roll(gx, gz, salt + 3), grown = member ? .65 + .35 * depth : .55 + .45 * r0;
        const size = (trait.size[0] + (trait.size[1] - trait.size[0]) * (member ? .4 + .6 * r0 : r0)) * grown * (tier.scale[flora] ?? 1);
        plants.push({ flora, x, z, size, yaw: roll(gx, gz, salt + 4) * Math.PI * 2, variant: Math.floor(roll(gx, gz, salt + 5) * 64),
          tint: (member ? col!.tint : .88 + .2 * roll(gx, gz, salt + 6)) * (.95 + .1 * roll(gx, gz, salt + 7)), leaf: field(x, z, LEAF), dry: field(x, z, DRY) });
        if (t < TIERS.length - 1) crowns.push({ x, z, r: trait.reach * size });
      }
    });
    return plants;
  }
  return {
    grow,
    /** How strongly the short-grass layer (undergrowth's blades) belongs at a point, 0 to 1, bare gaps included. */
    grass: (x: number, z: number) => field(x, z, GRASS) * gap(x, z),
    /** How strongly the leafy carpet belongs at a point, 0 to 1. */
    carpet: (x: number, z: number) => Math.min(1, field(x, z, CARPET)),
    /** Light reaching the floor through the crowns, 0 to 1 (gaps and path margins brighter). */
    light: (x: number, z: number) => field(x, z, LIGHT),
    /** The niche of one plant at a point, for maps and tests. */
    niche: (x: number, z: number, flora: Flora) => field(x, z, FLORA.indexOf(flora)),
    exclusionAt: (x: number, z: number) => field(x, z, EXCL),
    /** Drops the cached rasters and colonies far from a point (cells beyond `keep` cells). */
    forget(x: number, z: number, keep = 14) {
      const cx = Math.floor(x / cellSize), cz = Math.floor(z / cellSize);
      for (const key of rasters.keys()) { const [a, b] = key.split(',').map(Number); if (Math.abs(a - cx) > keep || Math.abs(b - cz) > keep) rasters.delete(key); }
      const kx = Math.floor(x / COLONY), kz = Math.floor(z / COLONY), keepColonies = keep * cellSize / COLONY;
      for (const key of colonies.keys()) { const [a, b] = key.split(',').map(Number); if (Math.abs(a - kx) > keepColonies || Math.abs(b - kz) > keepColonies) colonies.delete(key); }
    },
  };
}
export type Ecology = ReturnType<typeof createEcology>;
