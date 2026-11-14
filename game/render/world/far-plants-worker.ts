// The far plants' growing (far-plants.ts) off the main thread: the undergrowth's own ecology (sim/world/ecology.ts) over the whole
// island, nearest cells first, each plant made as undergrowth.ts toPlant makes it, posted back in batches as they come.
import { createNaturalLayout } from '../../sim/world/placement';
import { createEcology, FLORA } from '../../sim/world/ecology';
import { WORLD_RADIUS, biomeAt, noise, riverPresence, riverX, roadZ, structureClearance, vegetationExclusion } from '../../sim/world/world';
import { coastDistance, beachWidth } from '../../sim/world/coastal-geography';
import { WORLD_V2 } from '../../sim/world/world-flags';
import { gridHeights } from './terrain-horizon';

// Per plant, as far-plants.ts reads them: x, y, z, yaw, size, stretch, flora (index in FLORA), variant, tint r, g, b.
type Request = { heights: Float32Array; n: number; step: number; x0: number; cx: number; cz: number };
/** The short grass (undergrowth.ts groundCoverRow) comes out as these two kinds: fine tufts and meadow swards. */
export const FINE = 100, MEADOW = 101;
/** Every fourth candidate of its 32 cm lattice each way: one in sixteen, each drawn four times as wide (far-plants.ts GRASS_WIDEN). */
const GRASS_STEP = 4;
// undergrowth.ts's own hash, smooth01 and patch, unchanged, so the same candidates make the same decisions.
function hash(x: number, z: number, salt = 0) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(salt, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
const smooth01 = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const patch = (x: number, z: number) => .5 + Math.sin(x * .17 + Math.sin(z * .11) * 1.9) * .23 + Math.cos(z * .21 - x * .073) * .19;

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { heights, n, step, x0, cx, cz } = event.data;
  const at = gridHeights(heights, n, step, x0, x0);
  const layout = createNaturalLayout({ heightAt: at, exclusion: vegetationExclusion, biomeAt, riverX, riverPresence, roadZ, radius: WORLD_RADIUS });
  const CELL = 6.4, ecology = createEcology({ heightAt: at, exclusion: vegetationExclusion, biomeAt, layoutCell: (a, b) => layout.cell(a, b), radius: WORLD_RADIUS }, CELL);
  const reach = Math.ceil(WORLD_RADIUS / CELL), cells: [number, number, number][] = [];
  for (let i = -reach; i < reach; i++) for (let j = -reach; j < reach; j++) {
    const x = (i + .5) * CELL, z = (j + .5) * CELL;
    if (Math.hypot(x, z) > WORLD_RADIUS - 55 + CELL) continue;
    cells.push([i, j, (x - cx) ** 2 + (z - cz) ** 2]);
  }
  cells.sort((a, b) => a[2] - b[2]);
  const celandine = FLORA.indexOf('celandine');
  let out: number[] = [];
  const flush = (done: boolean) => {
    const data = new Float32Array(out); out = [];
    (self as unknown as Worker).postMessage({ data, done }, [data.buffer]);
  };
  for (let c = 0; c < cells.length; c++) {
    const [i, j] = cells[c];
    for (const g of ecology.grow(i, j)) {
      const flora = FLORA.indexOf(g.flora);
      if (flora === celandine) continue;
      // undergrowth.ts toPlant and growFlora: not by the campfire, not on ground steeper than .6, not against a building.
      if (Math.hypot(g.x + 18, g.z + 46) < 2.1) continue;
      const sx = (at(g.x + .18, g.z) - at(g.x - .18, g.z)) / .36, sz = (at(g.x, g.z + .18) - at(g.x, g.z - .18)) / .36;
      if (Math.hypot(sx, sz) > .6 || (WORLD_V2 && structureClearance(g.x, g.z) < .3)) continue;
      const stretch = .85 + .3 * (g.variant * 37 % 64) / 64;
      out.push(g.x, at(g.x, g.z) - .012, g.z, g.yaw, g.size, stretch, flora, g.variant, g.tint * (.94 + g.dry * .2), g.tint * (1 - g.dry * .08), g.tint * (.86 - g.dry * .18));
    }
    // The short grass of the cell, as undergrowth.ts groundCoverRow decides it, on the sparser lattice.
    for (let ax = 0; ax < 20; ax += GRASS_STEP) for (let az = 0; az < 20; az += GRASS_STEP) {
      const ix = i * 20 + ax, iz = j * 20 + az, x = (ix + hash(ix, iz, 1)) * .32, z = (iz + hash(ix, iz, 2)) * .32;
      if (Math.hypot(x, z) > WORLD_RADIUS - 55 || (WORLD_V2 && structureClearance(x, z) < .08)) continue;
      const dune = WORLD_V2 && coastDistance(x, z) > beachWidth(x, z) * .82 && coastDistance(x, z) < beachWidth(x, z) + 18;
      const e = dune ? Math.min(.2, vegetationExclusion(x, z)) : vegetationExclusion(x, z);
      if (e > .91) continue;
      const cover = patch(x, z), biome = biomeAt(x, z);
      const probability = (.30 + cover * .40) * (1 - Math.pow(e, 1.3) * .93) * (1 - biome.alpine * .93) * (dune ? 1 : 1.2 * smooth01(ecology.grass(x, z), .22, .6));
      const carpet = dune ? 0 : 1.6 * ecology.carpet(x, z) * smooth01(noise(x * .19 + 3, z * .19 - 9) * .7 + noise(x * .9 - 5, z * .9) * .3, .26, .52) * (1 - Math.pow(e, 1.3) * .95) * (1 - biome.alpine);
      const sward = dune ? 0 : 1.5 * smooth01(ecology.grass(x, z), .06, .4) * smooth01(noise(x * .13 - 21, z * .13 + 6) * .75 + noise(x * .7 + 9, z * .7) * .25, .32, .55) * (1 - Math.pow(e, 1.3) * .95) * (1 - biome.alpine);
      const roll = hash(ix, iz, 5) * Math.max(1, probability + carpet + sward), camp = Math.abs(x + 18) < 1.55 && Math.abs(z + 46) < 1.05;
      let kind = -1, salt = 0, variant = 0, size = 0, dry = biome.heath * .83 + biome.alpine * .45;
      if (roll >= probability + carpet && roll < probability + carpet + sward && !camp) { kind = MEADOW; salt = 60; variant = Math.floor(hash(ix, iz, 61) * 4); size = .8 + hash(ix, iz, 62) * .5; }
      else if (roll < probability && !(camp && hash(ix, iz, 93) > .12)) {
        if (dune && patch(x * .7 + 17, z * .7) < .42) continue;
        kind = FINE; salt = 20; variant = Math.floor(hash(ix, iz, 14) * 4);
        size = Math.min(3, (1.8 + hash(ix, iz, 8) * 1.8) * (.72 + cover * .48) * (1 - e * .42)) * (dune ? 1.2 : 1);
        if (dune) dry = .85;
      }
      if (kind < 0) continue;
      const slopeX = (at(x + .18, z) - at(x - .18, z)) / .36, slopeZ = (at(x, z + .18) - at(x, z - .18)) / .36;
      if (Math.hypot(slopeX, slopeZ) >= .75) continue;
      const tint = .77 + hash(ix, iz, salt + 11) * .32, stretch = .75 + hash(ix, iz, salt + 7) * .58;
      out.push(x, at(x, z) - .012, z, hash(ix, iz, salt + 3) * Math.PI * 2, size, Math.min(1.1, stretch), kind, variant, tint * (.94 + dry * .2), tint * (1 - dry * .08), tint * (.86 - dry * .18));
    }
    if (c % 400 === 399) flush(false);
  }
  flush(true);
});
