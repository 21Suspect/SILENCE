/**
 * The island's paths and roads as points for the Listener's night round (game/render/creature/encounters.ts, `round`): one point about every
 * 70 m of every trail and of the road, thinned so no two are within 60 m, then strung from `from` (its lair) outward by always going to the
 * nearest point not yet taken, at most 40. Deterministic: the same island gives the same round every night. The day's noisy places come
 * first in the round (game/sim/run/day-noise.ts); these are what it walks once they are done.
 */
import { TRAIL_LINES, ROAD_ENDS } from './world-layout';
import { roadZ } from './world';

export type RoutePoint = { x: number; z: number };

export function islandRoutes(from: RoutePoint = { x: 0, z: 0 }, limit = 40): RoutePoint[] {
  const all: RoutePoint[] = [];
  for (const line of TRAIL_LINES) {
    let along = 0;
    for (let i = 0; i < line.length; i++) {
      if (i > 0) along += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (i === 0 || along >= 70) { all.push({ x: line[i][0], z: line[i][1] }); along = 0; }
    }
  }
  // The valley road runs along x between its two ends (the rebuilt world's portals), 40 m in from each.
  if (ROAD_ENDS.length >= 2) {
    const xs = ROAD_ENDS.map(e => e.x);
    for (let x = Math.min(...xs) + 40; x < Math.max(...xs) - 40; x += 90) all.push({ x, z: roadZ(x) });
  }
  const spread: RoutePoint[] = [];
  for (const p of all) if (spread.every(q => Math.hypot(q.x - p.x, q.z - p.z) >= 60)) spread.push(p);
  const chain: RoutePoint[] = [];
  let at = from;
  while (spread.length && chain.length < limit) {
    let best = 0;
    for (let i = 1; i < spread.length; i++) if (Math.hypot(spread[i].x - at.x, spread[i].z - at.z) < Math.hypot(spread[best].x - at.x, spread[best].z - at.z)) best = i;
    at = spread.splice(best, 1)[0];
    chain.push(at);
  }
  return chain;
}
