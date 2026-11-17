/**
 * What the ground is under a point: one query for the footsteps, the bicycle and anything else that cares (the creature's
 * tracking, the audio). Pure; it composes what the world already knows so the sound, the picture and the rules cannot disagree.
 *
 * The order matters for cost and for truth: water first (a wet point is wet whatever lies under it), then the road (a cheap
 * distance), then the worn footpaths, then the beach, then forest against open ground. About a dozen cheap lookups, fine every frame.
 */
import { roadDistance, trailDistanceV2, vegetationExclusion, branchPathWidth } from './world';
import { waterDepthAt } from './water-depth';
import { coastDistance, beachWidth } from './coastal-geography';
import { ROAD } from './road-profile';
import type { StepSurface } from '../noise/noise-scale';

export type Surface = 'road' | 'path' | 'forest' | 'water' | 'beach' | 'dirt';

/** Water this deep (m) counts as water: ankle deep, where wading starts to splash and a bicycle cannot be ridden. */
export const WATER_DEPTH = .12;
/** Metres past a trail's drawn width that still counts as the path: the worn edge, as the ground shader draws it. */
export const PATH_MARGIN = .4;
/** The off-trail value (vegetationExclusion) below which the ground is under trees, as the footstep rule has always read it. */
export const FOREST_BELOW = .25;

export function surfaceAt(x: number, z: number): Surface {
  if (waterDepthAt(x, z) > WATER_DEPTH) return 'water';
  if (roadDistance(x, z) < ROAD.footstep) return 'road';
  if (trailDistanceV2(x, z) < branchPathWidth(x, z) + PATH_MARGIN) return 'path';
  const shore = coastDistance(x, z);
  if (shore > 0 && shore < beachWidth(x, z)) return 'beach';
  return vegetationExclusion(x, z) < FOREST_BELOW ? 'forest' : 'dirt';
}

/** The footstep table's name for a ground: a path sounds like packed earth, a beach like loose dirt. */
export function stepSurfaceOf(surface: Surface): StepSurface {
  return surface === 'path' || surface === 'beach' ? 'dirt' : surface;
}

/** Whether a bicycle rides well here: roads and paths only. */
export const isRideable = (surface: Surface) => surface === 'road' || surface === 'path';
