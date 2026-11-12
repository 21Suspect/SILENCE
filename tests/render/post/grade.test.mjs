import './../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { gradeFor, fogDensityFor, NOON, NIGHT } = await import('../../../game/render/post/grade.ts');

test('the night grade comes in only after sunset, and the eye may open further as it gets darker', () => {
  assert.equal(gradeFor(.8).scotopic, 0);
  assert.equal(gradeFor(-.3).scotopic, 1);
  let last = 0;
  for (let e = .9; e >= -.3; e -= .02) {
    const g = gradeFor(e);
    assert.ok(g.maxExposure >= last - 1e-9, `exposure cap falls at ${e.toFixed(2)}`);
    last = g.maxExposure;
    assert.ok(g.minExposure > 0 && g.minExposure < g.maxExposure);
    assert.ok(g.shadows.isColor && g.highlights.isColor);
  }
  assert.ok(Math.abs(gradeFor(.9).maxExposure - NOON.maxExposure) < 1e-9);
  assert.ok(Math.abs(gradeFor(-.5).maxExposure - NIGHT.maxExposure) < 1e-9);
});

test('no film grain by default, and a dusk grade warmer than noon and night', () => {
  for (const e of [.9, .05, -.4]) assert.equal(gradeFor(e).grain, 0);
  assert.ok(gradeFor(.05).temperature > gradeFor(.9).temperature);
  assert.ok(gradeFor(.05).temperature > gradeFor(-.4).temperature);
});

test('the mist is about half as thick under a high sun as at dusk and night', () => {
  assert.equal(fogDensityFor(-.2), 1);
  assert.equal(fogDensityFor(.05), 1);
  assert.ok(Math.abs(fogDensityFor(.9) - .5) < 1e-9);
});
