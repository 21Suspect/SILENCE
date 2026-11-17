import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.location = { search: '?world-v2' };
const s = await import('../../../game/sim/world/surface.ts');
const w = await import('../../../game/sim/world/world.ts');
const wd = await import('../../../game/sim/world/water-depth.ts');
const n = await import('../../../game/sim/world/world-noise.ts');
const l = await import('../../../game/sim/world/world-layout.ts');
const g = await import('../../../game/sim/world/coastal-geography.ts');

test('the road centre line is road, and the verge past the footstep width is not', () => {
  for (const x of [-300, -100, 0, 150, 300]) {
    assert.equal(s.surfaceAt(x, n.roadZ(x)), 'road', `x ${x}`);
  }
  let found = false;
  for (let d = 3.2; d < 12 && !found; d += .5) found = s.surfaceAt(0, n.roadZ(0) + d) !== 'road';
  assert.ok(found, 'the road ends somewhere');
});

test('the trail lines are path (away from the road and water)', () => {
  let checked = 0;
  for (const line of l.TRAIL_LINES) for (const [x, z] of line) {
    if (w.roadDistance(x, z) < 5 || wd.waterDepthAt(x, z) > 0) continue;
    assert.equal(s.surfaceAt(x, z), 'path', `${x.toFixed(1)},${z.toFixed(1)}`); checked++;
  }
  assert.ok(checked > 10, `checked ${checked}`);
});

test('the lake and the sea are water; the sand just inland of the sea is beach', () => {
  assert.equal(s.surfaceAt(g.LAKE_CENTER.x, 100), 'water');
  assert.equal(s.surfaceAt(0, g.coastZ(0) - 30), 'water');
  let beaches = 0;
  for (let x = -400; x <= 400; x += 40) {
    const z = g.coastZ(x) + 2 + .3 * g.beachWidth(x, g.coastZ(x));
    if (s.surfaceAt(x, z) === 'beach') beaches++;
  }
  assert.ok(beaches >= 5, `beach points ${beaches}`);
});

test('in the woods the ground is forest, and the spawn is not water', () => {
  let forest = 0;
  for (let i = 0; i < 400; i++) {
    const x = -400 + (i * 97) % 800, z = -200 + (i * 53) % 450;
    if (s.surfaceAt(x, z) === 'forest') forest++;
  }
  assert.ok(forest > 100, `forest points ${forest}`);
  assert.notEqual(s.surfaceAt(l.SPAWN.x, l.SPAWN.z), 'water');
});

test('every answer is one of the surfaces, and it maps to a footstep surface', () => {
  const names = new Set(['road', 'path', 'forest', 'water', 'beach', 'dirt']);
  const steps = new Set(['road', 'path', 'dirt', 'forest', 'water', 'wood']);
  for (let i = 0; i < 300; i++) {
    const surface = s.surfaceAt((i * 131) % 900 - 450, (i * 71) % 900 - 450);
    assert.ok(names.has(surface)); assert.ok(steps.has(s.stepSurfaceOf(surface)));
  }
  assert.equal(s.stepSurfaceOf('beach'), 'dirt'); assert.equal(s.stepSurfaceOf('path'), 'dirt'); assert.equal(s.stepSurfaceOf('road'), 'road');
});

test('only roads and paths can be ridden', () => {
  assert.deepEqual(['road', 'path', 'forest', 'water', 'beach', 'dirt'].map(s.isRideable), [true, true, false, false, false, false]);
});

test('it is cheap enough to run every frame', () => {
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) s.surfaceAt((i * 37) % 600 - 300, (i * 29) % 400 - 100);
  assert.ok((performance.now() - t0) / 2000 < .5, 'under half a millisecond a call');
});
