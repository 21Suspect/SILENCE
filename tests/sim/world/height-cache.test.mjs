import './helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { cacheTerrainBlock, releaseTerrainBlock, terrainBlock, terrainHeightStats } = await import('../game/world.ts');

// Height blocks are 2,401 samples each and cost 11-28 ms to compute in the browser. The blocks of the terrain tiles built round
// the player are held outside the small LRU, so that sampling heights all over the island (POI placement) cannot push them out.
test('a built tile keeps its height block however many other blocks are sampled, and gives it back when released', () => {
  const held = terrainBlock(-3, 4);
  cacheTerrainBlock(-3, 4);
  const before = terrainHeightStats();
  assert.ok(before.retained >= 1);
  // More distinct blocks than the LRU holds.
  for (let i = 0; i <= before.limit + 4; i++) terrainBlock(-20 + (i % 40), 10 + Math.floor(i / 40));
  const computed = terrainHeightStats().computed;
  assert.equal(terrainBlock(-3, 4), held, 'the retained block was not recomputed');
  assert.equal(terrainHeightStats().computed, computed);
  assert.ok(terrainHeightStats().blocks <= terrainHeightStats().limit);
  releaseTerrainBlock(-3, 4);
  assert.equal(terrainHeightStats().retained, before.retained - 1);
  assert.equal(terrainBlock(-3, 4), held, 'released into the LRU, not dropped');
});
