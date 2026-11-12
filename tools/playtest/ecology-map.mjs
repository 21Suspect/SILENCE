// A top-down map of the forest-floor plants game/sim/world/ecology.ts grows over a square of the world, to judge their
// distribution without the GPU. Ground: light (bright = open) tinted by moisture (blue = damp); trees dark rings, rocks grey,
// logs brown; plants as dots sized by their crown: fern green, shrub olive, tussock yellow-green, herb cyan, celandine
// magenta. Prints counts per plant and the time per cell.
//   node --experimental-strip-types --no-warnings tools/playtest/ecology-map.mjs [x z size out.png]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
await import(root + '/tests/helpers/register-ts-hooks.mjs');
globalThis.location = { search: '' };   // the rebuilt world, as the game opens
const W = await import(root + '/game/sim/world/world.ts');
const P = await import(root + '/game/sim/world/placement.ts');
const E = await import(root + '/game/sim/world/ecology.ts');
const [cx = -30, cz = 25, size = 120] = process.argv.slice(2, 5).map(Number);
const out = path.resolve(process.argv[5] ?? 'work/gfx/eco/ecology.png');
const geography = { heightAt: W.heightAt, exclusion: W.vegetationExclusion, biomeAt: W.biomeAt, riverX: W.riverX, riverPresence: W.riverPresence, roadZ: W.roadZ, radius: W.WORLD_RADIUS };
const layout = P.naturalLayout(geography);
const eco = E.createEcology({ heightAt: W.heightAt, exclusion: W.vegetationExclusion, biomeAt: W.biomeAt, layoutCell: (x, z) => layout.cell(x, z), radius: W.WORLD_RADIUS });
const PX = 8, S = Math.round(size * PX), x0 = cx - size / 2, z0 = cz - size / 2;
const img = new Uint8Array(S * S * 3);
const put = (px, py, r, g, b) => { if (px < 0 || py < 0 || px >= S || py >= S) return; const i = (py * S + px) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b; };
const dot = (x, z, rad, rgb) => { const px = (x - x0) * PX, py = (z0 + size - z) * PX, rp = Math.max(1, rad * PX); for (let j = -rp; j <= rp; j++) for (let i = -rp; i <= rp; i++) if (i * i + j * j <= rp * rp) put(Math.round(px + i), Math.round(py + j), ...rgb); };
// Ground: the fine-grass niche and the exclusion, sampled every 0.5 m.
for (let z = z0; z < z0 + size; z += .5) for (let x = x0; x < x0 + size; x += .5) {
  const g = eco.grass(x, z), e = eco.exclusionAt(x, z), base = 52 + 50 * g;
  for (let j = 0; j < PX / 2; j++) for (let i = 0; i < PX / 2; i++) put(Math.round((x - x0) * PX) + i, Math.round((z0 + size - z) * PX) - j, base + 80 * e, base + 60 * e, base * .8 + 40 * e);
}
const colours = { fern: [40, 170, 60], shrub: [130, 140, 40], tussock: [190, 220, 90], herb: [60, 200, 200], celandine: [220, 80, 200] };
const counts = Object.fromEntries(E.FLORA.map(f => [f, 0]));
const t0 = performance.now(); let cells = 0;
for (let gz = Math.floor(z0 / 6.4); gz <= Math.floor((z0 + size) / 6.4); gz++) for (let gx = Math.floor(x0 / 6.4); gx <= Math.floor((x0 + size) / 6.4); gx++) {
  cells++;
  for (const p of eco.grow(gx, gz)) { counts[p.flora]++; dot(p.x, p.z, E.TRAITS[p.flora].reach * p.size, colours[p.flora]); }
}
const ms = (performance.now() - t0) / cells;
// Mean niche of each plant over the square, and the share of ground where it is above one half.
const niches = {};
for (const f of E.FLORA) { let sum = 0, high = 0, n = 0; for (let z = z0; z < z0 + size; z += 2) for (let x = x0; x < x0 + size; x += 2) { const v = eco.niche(x, z, f); sum += v; if (v > .5) high++; n++; } niches[f] = { mean: +(sum / n).toFixed(2), over50: +(high / n).toFixed(2) }; }
for (let lx = Math.floor((x0 - 32) / 32); lx <= Math.floor((x0 + size) / 32); lx++) for (let lz = Math.floor((z0 - 32) / 32); lz <= Math.floor((z0 + size) / 32); lz++) {
  const c = layout.cell(lx, lz);
  for (const t of c.trees) dot(t.x, t.z, 1.4 * t.width + .08, [20, 14, 10]);
  for (const r of c.rubble) dot(r.x, r.z, r.size * 1.1, [150, 150, 150]);
  for (const d of c.deadfall) for (let s = -.5; s <= .5; s += .05) dot(d.x + Math.sin(d.yaw) * d.size * s, d.z + Math.cos(d.yaw) * d.size * s, d.variant, [110, 70, 40]);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
const ppm = out.replace(/\.png$/, '.ppm');
fs.writeFileSync(ppm, Buffer.concat([Buffer.from(`P6 ${S} ${S} 255\n`), Buffer.from(img)]));
execFileSync('magick', [ppm, out]); fs.unlinkSync(ppm);
console.log(JSON.stringify({ out, area: `${size} m square at ${cx},${cz}`, counts, perHectare: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round(v / (size * size) * 1e4)])), msPerCell: +ms.toFixed(2), niches }));
