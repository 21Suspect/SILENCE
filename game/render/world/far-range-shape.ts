/**
 * The far mountains' shape, in plain maths (no three.js) so it can be tested and built anywhere.
 *
 * The playable island's own range stands 450 to 650 m north of the middle and peaks at a few hundred metres; beyond it there was
 * only sea and sky, and mountains a few hundred metres away and that low read as hills. This range stands 1.5 to 9.5 km out, over
 * the north-west, north and north-east (the south stays open sea), and rises from the water to peaks of 1.4 to 2.5 km: big enough
 * that the haze layers it into near and far ridges and its summits stand above the haze.
 *
 * Heights are metres above the sea at world (x, z); +z is inland (north of the island). Azimuth is measured from +z toward +x.
 */

/** Inner and outer reach of the mesh (metres from the world's middle), and the half-angle of its arc (radians from +z). */
export const FAR_RANGE = { inner: 1300, outer: 9500, sweep: 2.45 } as const;
/** Below this the range is under the sea (the base of the mesh hides there). */
export const FAR_FLOOR = -40;

import { gradientNoise, ridged } from '../../sim/world/mountain-noise';

export { gradientNoise, ridged };
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Horns: the summits the eye goes to. [azimuth, distance, height, radius, turn]. Each is a pyramid of three main faces (a
 * horn carved by cirques on three sides), so its ridges run out as aretes rather than a cone's smooth flanks.
 */
const HORNS = [
  [-.2, 5600, 2500, 2700, .4], [.38, 7200, 2300, 3000, 1.7], [.95, 4500, 1850, 2100, 2.6], [-.85, 4300, 1950, 2200, .9],
  [-1.55, 3800, 1600, 1900, 3.1], [1.6, 4100, 1700, 2000, 1.2], [.12, 3500, 1300, 1600, 2.2], [-2.1, 4600, 1500, 2000, 1.9],
  [2.05, 5000, 1550, 2100, .3],
] as const;

/** Height of the far range at (x, z), metres. */
export function farRangeHeight(x: number, z: number) {
  const r = Math.hypot(x, z), phi = Math.atan2(x, z);
  const arc = 1 - smooth(Math.abs(phi), FAR_RANGE.sweep - .5, FAR_RANGE.sweep - .05);
  if (arc <= 0 || r < FAR_RANGE.inner - 200) return FAR_FLOOR;
  // Where it comes out of the sea: a shore that wanders by a few hundred metres along the arc.
  const shore = 1750 + 380 * gradientNoise(phi * 1.7, 3.1) + 160 * gradientNoise(phi * 5.3, 7.7);
  const rise = smooth(r, shore - 150, shore + 1500) * arc;
  if (rise <= 0) return FAR_FLOOR;
  // Domain warp: crests that bend and branch instead of running straight along the noise lattice.
  const wx = x + 750 * gradientNoise(x / 3300 + 5.2, z / 3300 - 2.4), wz = z + 750 * gradientNoise(x / 3300 - 8.1, z / 3300 + 4.6);
  const crests = ridged(wx / 2700, wz / 2700, 8);
  // Massifs and saddles along the arc, so the skyline has big and small mountains, not one even wall.
  const mass = .5 + .5 * gradientNoise(phi * 2.1 + 1.3, .7);
  let horn = 0;
  for (const [hp, hr, hh, hR, turn] of HORNS) {
    const dx = wx - hr * Math.sin(hp), dz = wz - hr * Math.cos(hp), d = Math.hypot(dx, dz);
    if (d >= hR * 1.4) continue;
    const a = Math.atan2(dx, dz), facets = 1 + .2 * Math.cos(3 * a + turn) + .07 * Math.cos(5 * a + turn * 2.3);
    const t = Math.max(0, 1 - d * facets / hR);
    horn = Math.max(horn, hh * t ** 1.3);
  }
  const range = 180 + (400 + 1300 * mass) * crests ** 1.45;
  // The horns carry the same crags as the ridges round them (a smooth pyramid would read as a cone).
  const carved = horn * (.74 + .26 * crests);
  const k = 260, top = Math.max(range, carved) + Math.log(1 + Math.exp(-Math.abs(range - carved) / k)) * k * .5;
  // It leaves the water in cliffs some 90 m high, not a long gentle shore: 2 to 3 km out a depth step is 5 to 10 m, so a shore
  // rising a few metres over hundreds met the sea at one depth and the two flickered as pale curved sheets.
  const cliff = smooth(r, shore - 60, shore + 60) * arc;
  return FAR_FLOOR + (90 - FAR_FLOOR) * cliff + Math.max(top - 90, 0) * rise;
}
