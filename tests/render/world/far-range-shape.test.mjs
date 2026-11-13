import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { farRangeHeight, ridged, gradientNoise, FAR_RANGE, FAR_FLOOR } = await import('../../../game/render/world/far-range-shape.ts');

test('the noise stays in range and the ridges in 0..1', () => {
  for (let i = 0; i < 2000; i++) {
    const x = i * 1.37 - 900, z = i * .71 + 40;
    const n = gradientNoise(x, z), r = ridged(x * .01, z * .01, 8);
    assert.ok(n >= -1.5 && n <= 1.5, `noise ${n}`);
    assert.ok(r >= 0 && r <= 1, `ridged ${r}`);
  }
});

test('the far range is grand to the north and open sea to the south', () => {
  // Highest point along each bearing from the lake, as an angle above the horizon.
  const skyline = deg => {
    const phi = deg * Math.PI / 180; let best = -90;
    for (let d = 1000; d < FAR_RANGE.outer; d += 50) best = Math.max(best, Math.atan2(farRangeHeight(d * Math.sin(phi), 100 + d * Math.cos(phi)), d) * 180 / Math.PI);
    return best;
  };
  for (const deg of [-90, -45, 0, 45, 90]) assert.ok(skyline(deg) > 9, `a mountain skyline at ${deg} degrees: ${skyline(deg).toFixed(1)}`);
  let top = 0;
  for (let x = -6000; x <= 6000; x += 100) for (let z = 1500; z <= 9000; z += 100) top = Math.max(top, farRangeHeight(x, z));
  assert.ok(top > 1800 && top < 3200, `summits ${top}`);
  for (let x = -3000; x <= 3000; x += 250) assert.equal(farRangeHeight(x, -4000), FAR_FLOOR, 'nothing to the south');
});

test('the range comes out of the sea beyond the island, not on it', () => {
  for (let a = -2.3; a <= 2.3; a += .1) assert.ok(farRangeHeight(1000 * Math.sin(a), 1000 * Math.cos(a)) <= FAR_FLOOR + 1, `under the sea at 1 km, ${a}`);
});
