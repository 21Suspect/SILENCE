import * as THREE from 'three';
import { RUBBLE_STRIDE, LOG_STRIDE, STUMP_STRIDE, STICK_STRIDE, type FarForestData } from './far-forest-bake';
import type { FarShadow } from './far-shadow';
import { createImpostorAtlas, impostorMaterial, impostorCasterMaterial, buildImpostors, mapsLoaded, type ImpostorInstance, type ImpostorModel } from './impostors';

/**
 * The forest floor's other things past where the streamed forest draws them (forest.ts: boulders to 58 m, fallen branches to 42,
 * stumps to 65, fallen trunks to 77): the very same pieces, from the same layout (far-forest-bake.ts), placed by the same rules
 * as forest.ts places them (the piece an item picks, its scale, how it sits on the ground), each the impostor of its own scanned
 * piece (impostors.ts). They take over across the band where the streamed ones dissolve out, and themselves dissolve once a
 * few pixels across.
 */
type Piece = { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; foot: number; size: THREE.Vector3 };
export type ScatterSource = { scatter?: { rocks: Piece[]; stones: Piece[]; stumps: Piece[]; trunk: Piece; branches: Piece[]; pick(count: number, variant: number, yaw: number): number } };

/** forest.ts ranges: [where the streamed ones start dissolving, gone]; and where these are gone in turn (a pixel or two). */
const BANDS = { rock: [[50, 58], [220, 300]], stump: [[57, 65], [200, 260]], log: [[69, 77], [260, 340]], branch: [[34, 42], [90, 120]] } as const;
/** The fallen trunk is one scan stretched to each log's length with its girth held to .75 to 1.35 of in proportion (forest.ts):
 *  two stretches of it cover that, the nearer one taken per log. */
const LOG_STRETCH = [.85, 1.25] as const;

export function createFarScatter(scene: THREE.Scene, renderer: THREE.WebGLRenderer, source: ScatterSource, eye: THREE.Vector3, farShadow?: FarShadow) {
  let atlas: ReturnType<typeof createImpostorAtlas> | undefined, data: FarForestData | undefined, built = false;
  const parts: { band: readonly [readonly [number, number], readonly [number, number]]; built: ReturnType<typeof buildImpostors> }[] = [], materials: THREE.Material[] = [], extra: THREE.BufferGeometry[] = [];
  const eyeUniform = { value: eye }, since = performance.now();

  function build(d: FarForestData) {
    const s = source.scatter!;
    // Atlas rows: the scanned boulders, the slate forms, the stumps, the two stretched trunks, the branches.
    const models: ImpostorModel[] = [], row = { rock: 0, stone: 0, stump: 0, log: 0, branch: 0 };
    const add = (p: Piece) => models.push({ parts: [{ geometry: p.geometry, material: p.material }] });
    row.rock = models.length; s.rocks.forEach(add);
    row.stone = models.length; s.stones.forEach(add);
    row.stump = models.length; s.stumps.forEach(add);
    row.log = models.length; for (const k of LOG_STRETCH) { const g = s.trunk.geometry.clone(); g.scale(k, 1, 1); extra.push(g); models.push({ parts: [{ geometry: g, material: s.trunk.material }] }); }
    row.branch = models.length; s.branches.forEach(add);
    atlas = createImpostorAtlas(renderer, models, { frame: 128, clear: [.06, .06, .05] });
    atlas.bake();
    const look = (band: readonly [readonly [number, number], readonly [number, number]]) => {
      const m = impostorMaterial(atlas!, scene, eyeUniform, { fadeIn: band[0], fadeOut: band[1] }, farShadow, 'scatter'); materials.push(m); return m;
    };
    const caster = farShadow ? impostorCasterMaterial(atlas, farShadow.sun) : undefined;
    if (caster) materials.push(caster);
    // Boulders (forest.ts rubble): a scan for the first two types, scaled 1.1 x 1.38 x 1.1 and seated on its foot; the slate forms
    // for the third, at their size.
    const rocks: ImpostorInstance[] = [];
    for (let o = 0; o < d.rubble.length; o += RUBBLE_STRIDE) {
      const x = d.rubble[o], y = d.rubble[o + 1], z = d.rubble[o + 2], size = d.rubble[o + 3], yaw = d.rubble[o + 4], variant = d.rubble[o + 5];
      const type = Math.min(2, Math.floor(variant));
      if (type < 2) { const k = s.pick(s.rocks.length, variant, yaw), p = s.rocks[k]; rocks.push({ x, y: y - p.foot * size * 1.38, z, yaw, height: size * 1.38, width: size * 1.1, model: row.rock + k }); }
      else { const form = Math.floor(yaw * 2) % 3; rocks.push({ x, y: y + .2 * size, z, yaw, height: size, width: size, model: row.stone + form }); }
    }
    parts.push({ band: BANDS.rock, built: buildImpostors(scene, rocks, undefined, look(BANDS.rock), 'Distant boulders', { tall: 2, caster, farShadow }) });
    // Stumps: the cut and the hollow stump are scans at 1.75 times the cut face, a little taller or shorter; the snag is drawn.
    const stumps: ImpostorInstance[] = [];
    for (let o = 0; o < d.stumps.length; o += STUMP_STRIDE) {
      const x = d.stumps[o], z = d.stumps[o + 1], size = d.stumps[o + 2], yaw = d.stumps[o + 3], variant = d.stumps[o + 4], base = d.stumps[o + 5];
      const type = Math.floor(variant * 3);
      if (type === 1) stumps.push({ x, y: base - .06, z, yaw, height: 1.2 + variant, width: size, model: row.stump + 1 });
      else { const sc = size * 1.75, tall = .85 + (yaw * 3.7 % 1) * .35; stumps.push({ x, y: base - .05, z, yaw, height: sc * tall, width: sc, model: row.stump + (type === 0 ? 0 : 2) }); }
    }
    parts.push({ band: BANDS.stump, built: buildImpostors(scene, stumps, undefined, look(BANDS.stump), 'Distant stumps', { tall: 2, caster, farShadow }) });
    // Fallen trunks: between their two ends, raised by .72 and .62 of the log's radius, girth held as forest.ts holds it.
    const half = Math.max(s.trunk.size.y, s.trunk.size.z) * .5, logs: ImpostorInstance[] = [];
    for (let o = 0; o < d.deadfall.length; o += LOG_STRIDE) {
      const x = d.deadfall[o], z = d.deadfall[o + 1], yaw = d.deadfall[o + 2], size = d.deadfall[o + 3], variant = d.deadfall[o + 4];
      const girth = THREE.MathUtils.clamp(variant / half, size * .75, size * 1.35), radius = half * girth;
      const ya = d.deadfall[o + 5] + radius * .72, yb = d.deadfall[o + 6] + radius * .62, length = Math.hypot(size, yb - ya);
      const stretch = Math.abs(length / girth - LOG_STRETCH[0]) < Math.abs(length / girth - LOG_STRETCH[1]) ? 0 : 1, scale = length / LOG_STRETCH[stretch];
      // The trunk lies along its model's x; forest.ts turns that to the log's own line, (sin yaw, cos yaw).
      logs.push({ x, y: (ya + yb) / 2, z, yaw: yaw - Math.PI / 2, height: scale, width: scale, model: row.log + stretch });
    }
    parts.push({ band: BANDS.log, built: buildImpostors(scene, logs, undefined, look(BANDS.log), 'Distant fallen trunks', { tall: 2, caster, farShadow }) });
    // Fallen branches: a scan along its z, at its length, between its two ends.
    const branches: ImpostorInstance[] = [];
    for (let o = 0; o < d.sticks.length; o += STICK_STRIDE) {
      const x = d.sticks[o], z = d.sticks[o + 1], yaw = d.sticks[o + 2], size = d.sticks[o + 3], variant = d.sticks[o + 4];
      const k = s.pick(s.branches.length, variant, yaw);
      branches.push({ x, y: (d.sticks[o + 5] + d.sticks[o + 6]) / 2 - .012, z, yaw, height: size, width: size, model: row.branch + k });
    }
    parts.push({ band: BANDS.branch, built: buildImpostors(scene, branches, undefined, look(BANDS.branch), 'Distant fallen branches', { tall: 1 }) });
  }

  return {
    setData(d: FarForestData) { data = d; },
    /** Builds once the layout and the scans are in and their maps loaded. */
    update() {
      // Only the chunks that can show this frame: inside the band where the streamed pieces still stand, or past where these are gone, none.
      for (const p of parts) p.built.cull(eye, p.band[0][0], p.band[1][1]);
      if (built || !data || !source.scatter) return;
      const s = source.scatter;
      const maps = [s.rocks, s.stones, s.stumps, [s.trunk], s.branches].flat().flatMap(p => (Array.isArray(p.material) ? p.material : [p.material]) as THREE.MeshStandardMaterial[]).flatMap(m => [m.map, m.alphaMap]).filter((t): t is THREE.Texture => !!t);
      if (!mapsLoaded(maps, since)) return;
      build(data); built = true;
    },
    dispose() { for (const p of parts) p.built.dispose(); for (const m of materials) m.dispose(); for (const g of extra) g.dispose(); atlas?.dispose(); },
  };
}
