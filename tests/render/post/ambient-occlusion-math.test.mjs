import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import('../../../game/render/post/ambient-occlusion-math.ts');

test('quality levels: off does nothing, medium is cheaper than high, both run at half resolution', () => {
  assert.equal(m.aoQuality(0).on, false);
  assert.equal(m.aoQuality(-3).on, false);
  const mid = m.aoQuality(1), high = m.aoQuality(2);
  assert.ok(mid.on && high.on);
  assert.ok(mid.slices * mid.steps < high.slices * high.steps);
  assert.equal(high.scale, .5);
  assert.equal(m.aoQuality(7).slices, high.slices);
  // The shader loops are unrolled to at most 4 slices and 8 steps.
  assert.ok(high.slices <= 4 && high.steps <= 8);
});

test('the effect fades with distance and is gone where trunks turn into fog', () => {
  assert.equal(m.aoDistanceFade(1), 1);
  assert.equal(m.aoDistanceFade(m.AO_FADE_NEAR), 1);
  assert.equal(m.aoDistanceFade(m.AO_FADE_FAR), 0);
  assert.equal(m.aoDistanceFade(500), 0);
  let last = 2;
  for (let d = 0; d <= 80; d += 2) { const f = m.aoDistanceFade(d); assert.ok(f <= last); last = f; }
});

test('occlusion weakens as the pixel gets more direct sun, but never vanishes', () => {
  assert.equal(m.aoWeight(0), 1);
  assert.ok(Math.abs(m.aoWeight(1) - m.SUNLIT_KEEP) < 1e-12);
  assert.ok(m.aoWeight(1) > 0);
  assert.ok(m.aoWeight(.3) > m.aoWeight(.7));
});

test('sun fraction needs the sun up, the shadow map lit and the surface facing the sun', () => {
  assert.equal(m.sunFraction(0, 1, 1), 0);
  assert.equal(m.sunFraction(1, 0, 1), 0);
  assert.equal(m.sunFraction(1, 1, 0), 0);
  assert.equal(m.sunFraction(1, 1, 1), 1);
  assert.equal(m.sunFraction(2, 3, 4), 1);
  assert.equal(m.sunFraction(-1, 1, 1), 0);
});

test('the multiplier is 1 where nothing occludes or nothing is near, and never darkens beyond the strength', () => {
  assert.equal(m.aoMultiplier(1, 0, 1), 1);
  assert.equal(m.aoMultiplier(0, 0, 0), 1);
  assert.ok(Math.abs(m.aoMultiplier(0, 0, 1) - (1 - m.AO_STRENGTH)) < 1e-12);
  // Sunlit creases are darkened less than shaded ones, distant ones less than near ones.
  assert.ok(m.aoMultiplier(.2, 1, 1) > m.aoMultiplier(.2, 0, 1));
  assert.ok(m.aoMultiplier(.2, 0, .3) > m.aoMultiplier(.2, 0, 1));
  for (const v of [-1, 0, .5, 1, 2]) { const x = m.aoMultiplier(v, 0, 1); assert.ok(x >= 1 - m.AO_STRENGTH - 1e-12 && x <= 1); }
});
