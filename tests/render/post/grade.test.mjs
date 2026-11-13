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

test('the eye rests at the hour\'s anchor: a lamp overhead or the sky above barely moves it', async () => {
  const { eyeExposure } = await import('../../../game/render/post/final-image.ts');
  const stops = (a, b) => Math.abs(Math.log2(a / b));
  const night = gradeFor(-.5), noon = gradeFor(.9);
  // Measured meter readings (work/gfx/light-probe.js, 2026-11-13): a moonlit wood wants far more than the cap; under a lamp it
  // wanted exposure 24, nearly two stops below the cap; at noon the floor wanted 7.1 and the sky 5.2.
  assert.equal(eyeExposure(790, night), night.maxExposure, 'a moonlit wood rests at the cap');
  assert.ok(stops(eyeExposure(24, night), night.maxExposure) <= 1.25 + 1e-9, 'whatever fills the view, the eye closes by at most a stop and a quarter');
  assert.equal(eyeExposure(237, night), night.maxExposure, 'a lamp overhead (the meter reading after the lamps were dimmed) leaves it at rest');
  assert.ok(stops(eyeExposure(7.06, noon), eyeExposure(5.23, noon)) < .2, 'looking from the floor to the sky swings well under a fifth of a stop');
  for (const e of [.9, .2, .05, -.05, -.5]) {
    const g = gradeFor(e);
    assert.ok(g.anchor >= g.minExposure && g.anchor <= g.maxExposure && g.response > 0 && g.response < 1, `grade at ${e}`);
  }
});
