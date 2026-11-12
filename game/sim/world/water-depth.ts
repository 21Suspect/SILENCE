/**
 * How deep the water is under a walker, and what that does to walking. Pure (no three.js), so the creature can ask the same
 * questions. Swimming is out of scope: a player wades, and the water is a wall once it is deeper than a person can stand in.
 *
 * River, lake and sea are one rule: wherever `riverSurfaceAt` says there is water, the depth is its level minus the ground.
 */
import { heightAt, riverSurfaceAt } from './world';

/** Metres of water over the ground at a point: the river (and its side channels), the lake and the sea. 0 on dry land; never negative. */
export function waterDepthAt(x: number, z: number): number {
  const surface = riverSurfaceAt(x, z);
  if (surface === undefined) return 0;
  const depth = surface - heightAt(x, z);
  return depth > 0 && Number.isFinite(depth) ? depth : 0;
}
/** The deepest water a walker will enter: about the chest. Anything deeper is as good as a wall (there is no swimming). */
export const WADE_LIMIT = 1.3;
/**
 * Fraction of walking speed in water of this depth. Ankle deep (0.2 m) barely slows; knee deep (0.5 m) clearly does; waist deep
 * (1.0 m) is about a third. Smooth and decreasing, with a floor, so a wader is never stopped, only slowed.
 */
export function wadeSpeedFactor(depth: number): number {
  if (!(depth > 0)) return 1;
  return Math.max(.25, 1 / (1 + Math.pow(depth / .7, 2.2)));
}
/** Whether a step from water this deep to water that deep is allowed: always out of deep water, never further into it. */
export function canWadeTo(depthHere: number, depthThere: number, limit = WADE_LIMIT): boolean {
  return depthThere <= limit || depthThere <= depthHere;
}
/** Where a step from (x0, z0) to (x1, z1) ends up: as asked, or slid along the edge of the deep water, or not at all. */
export function limitWading(x0: number, z0: number, x1: number, z1: number, depthAt: (x: number, z: number) => number = waterDepthAt): { x: number; z: number } {
  const here = depthAt(x0, z0);
  if (canWadeTo(here, depthAt(x1, z1))) return { x: x1, z: z1 };
  if (canWadeTo(here, depthAt(x1, z0))) return { x: x1, z: z0 };
  if (canWadeTo(here, depthAt(x0, z1))) return { x: x0, z: z1 };
  return { x: x0, z: z0 };
}
