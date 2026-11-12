/** The natural shape of the land before anyone built on it. Depends only on noise, so site selection can read it. */
import { WORLD_V2 } from './world-flags';
import { coastalTerrain } from './coastal-geography';
import { fbm, noise, pathX, smooth, warped, rockMask } from './world-noise';

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Rolling forest country: broad hills and low spurs, rock shelves where the soil thins, dry ravines between. */
export function landform(x: number, z: number, radius = Math.hypot(x, z)) {
  const [u, v] = warped(x, z);
  const calm = .55 + .45 * smooth(Math.hypot(x + 10, z + 30), 35, 150);
  const hills = fbm(u * .0072, v * .0072, 3) * 9 * calm;
  const spurs = Math.pow(1 - Math.abs(noise(u * .013 + 9, v * .013 + 4) * 2 - 1), 2.2) * 3.4 * smooth(radius, 60, 200);
  let h = 4.5 + hills + spurs;
  const rock = rockMask(u, v), step = 3.4, q = h / step, k = Math.floor(q);
  h = mix(h, (k + smooth(q - k, .62, .9)) * step, rock * .7 * smooth(Math.abs(x - pathX(z)), 3, 14));
  // Only some of the land drains in ravines; elsewhere it just rolls.
  const drains = smooth(fbm(u * .0034 + 21, v * .0034 - 40, 2), -.02, .3);
  const gully = 1 - smooth(Math.abs(fbm(u * .0075 + 70, v * .0075 + 11, 2)), 0, .05);
  h -= gully * 2.8 * smooth(radius, 45, 130) * drains;
  const forest = Math.max(-.55, h + (noise(x * .15 + 3, z * .15 - 8) - .5) * 1.1 + (noise(x * .41, z * .41 + 5) - .5) * .4);
  return WORLD_V2 ? coastalTerrain(x, z, forest) : forest;
}

/** Rise over run measured across a few metres, ignoring the lumpy forest floor. */
export function landSlope(x: number, z: number, span = 5) {
  return Math.hypot(landform(x + span, z) - landform(x - span, z), landform(x, z + span) - landform(x, z - span)) / (2 * span);
}
