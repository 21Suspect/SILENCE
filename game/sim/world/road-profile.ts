/**
 * The valley road's cross-section, in metres measured across the road from its centre line. One place for every number
 * that says how wide the road is, so the ground, the plants, the footsteps and the shader cannot disagree.
 *
 * The carriageway is two 3 m lanes, 6 m in all, which meets the 6.2 m bore of the tunnels cleanly. Out to `level` the ground is
 * flat across the road (the carriageway and a shoulder); from there it eases into the terrain by `ease`.
 * It imports only the plan's grid: the terrain worker, the tests and the shader all read this.
 */
import { PLAN_X0, PLAN_DX, PLAN_N } from './road-plan';
export const ROAD = {
  half: 3,
  level: 3.9,
  ease: 13,
  /** Plants stay off the road, then thin out between these. */
  clearFrom: 3.2, clearTo: 5.2,
  /** Walking on asphalt rather than gravel and leaf litter. */
  footstep: 3.1,
  /** Nothing of the road (not even its verge) lies further out than this. */
  reach: 5.6,
  /** Banks beyond the shoulder: no steeper than this (rise over run) in a cutting (35 degrees) and in an embankment (about 27). */
  cutSlope: .7, fillSlope: .5,
  /** Ground further than this from the centre line is untouched by the road's cuttings and embankments. */
  bank: 70,
  /** Arc length of the centre line is tabulated at every node of the road's plan (every `arcStep` m of x from `arcFrom`), for the paint. */
  arcFrom: PLAN_X0, arcStep: PLAN_DX, arcCount: PLAN_N,
} as const;

/**
 * Cumulative arc length of the centre line at each node of the plan (x = arcFrom + i * arcStep); the dashes are laid out along
 * this. The nodes are uniform in x, so on the steep stretches they are far apart along the road (up to 18 m): the shader and
 * `roadArcAt` therefore do not interpolate linearly but with a cubic through the length and the exact rate of growth,
 * sqrt(1 + slope^2), at each end of the cell. Between nodes that is accurate to a millimetre.
 */
export function roadArcTable(roadZ: (x: number) => number, slope: (x: number) => number = x => (roadZ(x + .25) - roadZ(x - .25)) / .5): number[] {
  const out: number[] = [0], sub = 16, h = ROAD.arcStep / sub;
  for (let i = 1; i < ROAD.arcCount; i++) {
    let length = 0;
    for (let k = 0; k < sub; k++) { const x = ROAD.arcFrom + (i - 1) * ROAD.arcStep + (k + .5) * h; length += Math.hypot(1, slope(x)) * h; }
    out.push(out[i - 1] + length);
  }
  return out;
}
/** The arc length at x from a table made by {@link roadArcTable}: the very function the shader's `roadArc` evaluates. */
export function roadArcAt(table: ArrayLike<number>, slope: (x: number) => number, x: number): number {
  const u = Math.max(0, Math.min(ROAD.arcCount - 1.001, (x - ROAD.arcFrom) / ROAD.arcStep)), i = Math.floor(u), t = u - i, h = ROAD.arcStep;
  const d0 = Math.hypot(1, slope(ROAD.arcFrom + i * h)), d1 = Math.hypot(1, slope(ROAD.arcFrom + (i + 1) * h));
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * table[i] + (t3 - 2 * t2 + t) * h * d0 + (3 * t2 - 2 * t3) * table[i + 1] + (t3 - t2) * h * d1;
}
