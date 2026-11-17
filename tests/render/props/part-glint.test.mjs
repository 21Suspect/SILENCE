import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';

const { glintBrightness, glintTint, GLINT_TORCH_RANGE, GLINT_DAY_RANGE } = await import('../../../game/render/props/part-glint.ts');

test('the torch catches a part near its axis, and not off to the side', () => {
  const on = glintBrightness(10, 1, true, 1), off = glintBrightness(10, Math.cos(.4), true, 1);
  assert.ok(on > .9); assert.ok(off < on * .5); assert.equal(glintBrightness(10, Math.cos(.7), true, 1), 0);
});
test('nothing beyond the torch range, nothing at night without the torch', () => {
  assert.equal(glintBrightness(GLINT_TORCH_RANGE + 1, 1, true, 1), 0);
  assert.equal(glintBrightness(3, 1, false, 1), 0);
});
test('daylight glints close up without a beam, and not beyond its range', () => {
  assert.ok(glintBrightness(3, -1, false, 0) > 0);
  assert.equal(glintBrightness(GLINT_DAY_RANGE + .5, -1, false, 0), 0);
  assert.ok(glintBrightness(3, -1, false, 0) < glintBrightness(3, 1, true, 1));
});
test('fades with distance along the beam', () => {
  assert.ok(glintBrightness(24, 1, true, 1) < glintBrightness(10, 1, true, 1));
});
test('glass is whiter and brighter than metal', () => {
  const g = glintTint('bulbs'), m = glintTint('fuse');
  assert.ok(g[3] > m[3]); assert.ok(g[2] > m[2]);
});
