import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';

const { islandRoutes } = await import('../../../game/sim/world/island-routes.ts');
const { POI_PLACEMENTS, LAIR_ID } = await import('../../../game/sim/world/world-layout.ts');

test('the Listener\'s round of paths: deterministic, at most 40 points at least 60 m apart, starting nearest the lair', () => {
  const lair = POI_PLACEMENTS.find(p => p.id === LAIR_ID), a = islandRoutes(lair), b = islandRoutes(lair);
  assert.deepEqual(a, b);
  assert.ok(a.length > 5 && a.length <= 40, `${a.length} points`);
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) assert.ok(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) >= 60 - 1e-9);
  assert.equal(islandRoutes(lair, 5).length, 5);
  assert.ok(Math.hypot(a[0].x - lair.x, a[0].z - lair.z) < 400, 'it starts from home');
});
