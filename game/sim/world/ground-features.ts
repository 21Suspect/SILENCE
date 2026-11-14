/**
 * What a near-ground tile can possibly show, so its shader need not work out what is not there.
 *
 * The near ground's fragment shader (game/render/world/terrain.ts) works the road, the river bank and the mountain out of the
 * world position at every pixel, and all of it is in the one program whether a tile has any of them or not. Measured at
 * 2560 x 1440 (M5 Pro, work/fable): the code for what is not there cost 3.3 ms of a 28 ms frame in the deep forest; behind a
 * uniform it still cost 1.9 of those, compiled out it cost nothing. So a tile is told here, once, which of them it can contain,
 * and terrain.ts draws it with a program built without the rest. (The shore's sand and the snow stay in every program: their
 * code measured within noise of free, and a class for them would be one more program to build.)
 *
 * Every test errs towards "it is there": a tile wrongly given a feature only pays for it, a tile wrongly denied one would
 * lose the road or the bank from its pixels. Each threshold is where the shader's own mask reaches zero, plus the slack the
 * sampling needs (points 2 m apart: any point of the tile is within 1.42 m of one) and a metre or more on top.
 */
import { TERRAIN_CHUNK, roadDistance } from './world';
import { channelOffset } from './world-noise';
import { lakeDistance } from './coastal-geography';
import { ROAD } from './road-profile';
import { WORLD_V2 } from './world-flags';

/** The road: its asphalt, shoulders and verge. */
export const GROUND_ROAD = 1;
/** The gravel of a river's or the lake's bank. */
export const GROUND_BANK = 2;
/** The mountain's rock, scree and turf. */
export const GROUND_MOUNTAIN = 4;
export const GROUND_ALL = GROUND_ROAD | GROUND_BANK | GROUND_MOUNTAIN;

/** Where each mask of the ground shader is zero for certain (metres, as the shader has them). */
export const GROUND_REACH = {
  /** roadFrame() gives up beyond ROAD.reach from the centre line; nothing of the road is drawn past it. */
  road: ROAD.reach,
  /** bedWeight(): the gravel ends 8 m from the channel's middle, and the river mouths' rounding only acts under 15 m. */
  stream: 15,
  /** bedWeight() by the lake ends 6 m from its edge. */
  lake: 6,
} as const;

/** The mountain's foot line, as mountainZone() in terrain.ts has it: rock can show north of it (less 10 m) and beyond x = +-440. */
export const mountainFoot = (x: number) => 342 + Math.sin(x * .009 + .2) * 29 + Math.sin(x * .027 + 1) * 11;
/** Whether mountainZone() can be above zero here (its height term is left out: that only takes rock away). */
export const mountainPossible = (x: number, z: number, slack = 0) => z > mountainFoot(x) - 10 - slack || Math.abs(x) > 440 - slack;

const STEP = 2, REACH = STEP * Math.SQRT1_2;

/** The features of tile (tx, tz): a bit set of GROUND_ROAD, GROUND_BANK and GROUND_MOUNTAIN. */
export function groundTileFeatures(tx: number, tz: number): number {
  // The original world's ground is another shader: everything stays in.
  if (!WORLD_V2) return GROUND_ALL;
  let features = 0;
  const x0 = tx * TERRAIN_CHUNK, z0 = tz * TERRAIN_CHUNK;
  // The channel's offset can change by two metres over one (a branch tapering in), the lake's by about one and a half.
  const road = GROUND_REACH.road + REACH + 1.5, stream = GROUND_REACH.stream + REACH * 2 + 2, lake = GROUND_REACH.lake + REACH * 1.5 + 2;
  for (let j = -1; j <= TERRAIN_CHUNK / STEP + 1; j++) for (let i = -1; i <= TERRAIN_CHUNK / STEP + 1; i++) {
    const x = x0 + i * STEP, z = z0 + j * STEP;
    if (!(features & GROUND_ROAD) && roadDistance(x, z) < road) features |= GROUND_ROAD;
    if (!(features & GROUND_BANK) && (channelOffset(x, z) < stream || lakeDistance(x, z) < lake)) features |= GROUND_BANK;
    if (!(features & GROUND_MOUNTAIN) && mountainPossible(x, z, 3)) features |= GROUND_MOUNTAIN;
    if (features === GROUND_ALL) return features;
  }
  return features;
}
