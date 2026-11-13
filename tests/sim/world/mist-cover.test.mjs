import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
globalThis.location ??= { search: '' };
const { mistCover, MIST_EXTENT, MIST_CELLS, MIST_OPEN, MIST_WATER } = await import('../../../game/sim/world/mist-cover.ts');
const { LAKE_CENTER } = await import('../../../game/sim/world/coastal-geography.ts');
const { SPAWN } = await import('../../../game/sim/world/world-layout.ts');

test('the mist lies in the wood, thins over open land and is nearly gone over water', () => {
  const cover = mistCover(), cell = MIST_EXTENT * 2 / MIST_CELLS;
  const at = (x, z) => cover[Math.floor((z + MIST_EXTENT) / cell) * MIST_CELLS + Math.floor((x + MIST_EXTENT) / cell)];
  for (const v of cover) assert.ok(v >= MIST_WATER - 1e-6 && v <= 1 + 1e-6);
  assert.ok(at(LAKE_CENTER.x, LAKE_CENTER.z) < MIST_OPEN, `lake ${at(LAKE_CENTER.x, LAKE_CENTER.z)}`);
  assert.ok(at(0, -700) <= MIST_WATER + .02, 'the open sea');
  // Somewhere in the wood round the spawn the mist is thick.
  let best = 0; for (let dx = -60; dx <= 60; dx += 8) for (let dz = -60; dz <= 60; dz += 8) best = Math.max(best, at(SPAWN.x + dx, SPAWN.z + dz));
  assert.ok(best > .8, `wood ${best}`);
});
