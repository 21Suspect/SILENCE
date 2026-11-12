import type { Placement } from '../render/props/pois';
import { pathX } from '../sim/world/world-noise';

/**
 * DEV ONLY. Open the game with `?door-test` and one extra pump house stands about 12 m from where you spawn, its door toward you:
 * somewhere to try the doors before the real layout places a building that has one. Anywhere else (production, Node, no flag) this
 * returns nothing.
 *
 * To remove it: delete this file and the two lines in game/render/props/world-v2.ts that mention `doorTest`.
 */
export function doorTestPlacements(heightAt: (x: number, z: number) => number): Placement[] {
  if (!import.meta.env?.DEV || typeof location === 'undefined' || !new URLSearchParams(location.search).has('door-test')) return [];
  const sx = pathX(12), sz = 12;
  let best: Placement | undefined, bestRelief = Infinity;
  // The flattest ground 11 to 13 m out, facing the spawn: a pump house is 3.4 m by 2.8 m, with its apron on the door side.
  for (let k = 0; k < 24; k++) for (const r of [11, 12, 13]) {
    const a = k / 24 * Math.PI * 2, x = sx + Math.sin(a) * r, z = sz + Math.cos(a) * r, yaw = Math.atan2(sx - x, sz - z);
    let low = Infinity, high = -Infinity;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 3; j++) {
      const lx = i * .9, lz = j * 1.1, y = heightAt(x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z + lz * Math.cos(yaw) - lx * Math.sin(yaw));
      low = Math.min(low, y); high = Math.max(high, y);
    }
    if (high - low < bestRelief) { bestRelief = high - low; best = { id: 'door-test-pumphouse', asset: 'pumphouse', x, z, yaw }; }
  }
  return best ? [best] : [];
}
