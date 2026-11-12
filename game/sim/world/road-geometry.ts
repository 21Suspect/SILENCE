/**
 * Where things stand relative to the valley road, measured the way a road is: along it and across it. A road that runs nearly
 * north-south on its mountain legs makes an offset in z almost an offset along the road, so nothing that has to keep to one side
 * of it may be placed by adding to z. Everything here works from the road's own curve (world-noise's roadZ and its slope) and
 * has no three.js in it, because the layout, the ground and the tests all use it.
 */
import { roadZ, roadSlope, roadFoot, ROAD_NORM, type RoadFoot } from './world-noise';
import { ROAD, roadArcTable, roadArcAt } from './road-profile';
import { PLAN_X0 } from './road-plan';

let arcTable: number[] | undefined;
/** Metres of road from the western end of the plan (x = -520) to abscissa x. Increases eastward. */
export function roadArc(x: number) { arcTable ??= roadArcTable(roadZ, roadSlope); return roadArcAt(arcTable, roadSlope, x); }
/** The abscissa at which the road has covered s metres from the western end of the plan. */
export function roadXAtArc(s: number) {
  let lo = PLAN_X0, hi = -PLAN_X0;
  for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (roadArc(mid) < s) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export interface RoadFrame { x: number; z: number; m: number; tx: number; tz: number; nx: number; nz: number }
/** The centre line at abscissa x: its point, direction of travel (towards +x) and the normal to it that points to the +z side. */
export function roadFrameAt(x: number): RoadFrame {
  const z = roadZ(x), m = roadSlope(x), k = 1 / Math.hypot(1, m);
  return { x, z, m, tx: k, tz: m * k, nx: -m * k, nz: k };
}
/** The point `across` metres from the centre line at abscissa x, along the normal (positive towards +z). */
export function roadBeside(x: number, across: number): { x: number; z: number; frame: RoadFrame } {
  const f = roadFrameAt(x);
  return { x: x + f.nx * across, z: f.z + f.nz * across, frame: f };
}
const scratch: RoadFoot = { x: 0, z: 0, m: 0, across: 0 };
/**
 * Metres from the centre line, measured across it: the true distance to the road, however steep and curved it is there. With a
 * `reach` the far field is one cheap evaluation (it returns something at least `reach` for any point further than that); without
 * one the answer is exact everywhere, which is what siting a building 60 m from the road needs.
 */
export function roadGap(x: number, z: number, reach = Infinity) {
  if (reach < Infinity) { const dz = Math.abs(z - roadZ(x)); if (dz > reach * ROAD_NORM) return dz / ROAD_NORM; }
  return Math.abs(roadFoot(x, z, scratch).across);
}
/** The nearest point of the centre line to a ground point, and the signed distance across (positive on the +z side). */
export function roadNearest(x: number, z: number, out: RoadFoot = { x: 0, z: 0, m: 0, across: 0 }) { return roadFoot(x, z, out); }
/** Yaw of a model whose local +z should face the road from the +z side (sign = 1) or the -z side (sign = -1) at abscissa x. */
export function faceRoadYaw(x: number, sign: number) {
  const f = roadFrameAt(x);
  return Math.atan2(-sign * f.nx, -sign * f.nz);
}
/** The thirteen old stone markers along the verge of the southern road, alternating sides, 4.4 m from the centre line (beyond the shoulder). */
export function roadMarkerSpot(i: number) { const at = roadBeside(-99 + i * 16.5, i % 2 ? 4.4 : -4.4); return { x: at.x, z: at.z }; }
export { ROAD };
