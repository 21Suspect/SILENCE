/**
 * The valley road's cross-section, in metres measured across the road from its centre line. One place for every number
 * that says how wide the road is, so the ground, the plants, the footsteps and the shader cannot disagree.
 *
 * The carriageway is two 3 m lanes, 6 m in all, which meets the 6.2 m bore of the tunnels cleanly. Out to `level` the ground is
 * flat across the road (the carriageway and a shoulder); from there it eases into the terrain by `ease`.
 * No imports: the terrain worker, the tests and the shader all read this.
 */
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
  /** Arc length of the centre line is tabulated every `arcStep` metres from `arcFrom`, for the paint. */
  arcFrom: -480, arcStep: 8, arcCount: 121,
} as const;

/** Cumulative arc length of the centre line at `arcFrom + i * arcStep`; the dashes are laid out along this. */
export function roadArcTable(roadZ: (x: number) => number): number[] {
  const out: number[] = [0], sub = 16, h = ROAD.arcStep / sub;
  for (let i = 1; i < ROAD.arcCount; i++) {
    let length = 0;
    for (let k = 0; k < sub; k++) {
      const x = ROAD.arcFrom + (i - 1) * ROAD.arcStep + (k + .5) * h, m = (roadZ(x + .25) - roadZ(x - .25)) / .5;
      length += Math.sqrt(1 + m * m) * h;
    }
    out.push(out[i - 1] + length);
  }
  return out;
}
