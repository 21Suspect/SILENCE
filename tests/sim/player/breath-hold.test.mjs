import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createBreathHold, BREATH_HOLD } = await import('../../../game/sim/player/breath-hold.ts');
const { NOISE, hears, noiseGrade } = await import('../../../game/sim/noise/noise-scale.ts');

// Step `seconds` of game time with the key and winded flag held constant; returns the last state and whether a gasp happened.
const run = (b, seconds, key, winded = false, dt = 1 / 60) => {
  let r = b.state, gasped = false, t = 0;
  for (; t < seconds - 1e-9; t += dt) { r = b.update(dt, key, winded); gasped ||= r.gasp; }
  return { r, gasped };
};
// Seconds from the key going down until the forced release.
const holdTime = (dt, winded = false) => {
  const b = createBreathHold(); let t = 0, r;
  do { r = b.update(dt, true, winded); t += dt; } while (!r.gasp && t < 20);
  return t;
};

test('the tuning is what the design asks for', () => {
  assert.equal(BREATH_HOLD.holdSeconds, 8); assert.equal(BREATH_HOLD.windedSeconds, 3);
  assert.equal(BREATH_HOLD.breathNoise, NOISE.breath); assert.equal(BREATH_HOLD.gaspNoise, NOISE.walkStep);
});

test('at rest it breathes, heard within 3 m, and nothing is held', () => {
  const b = createBreathHold();
  const { r } = run(b, 2, false);
  assert.equal(r.held, false); assert.equal(r.noise, NOISE.breath); assert.equal(b.loudness, NOISE.breath);
  assert.ok(hears(NOISE.breath, 2.9) && !hears(NOISE.breath, 3.1));
});

test('held while the key is down: silent, with the breath running down', () => {
  const b = createBreathHold();
  const { r } = run(b, 3, true);
  assert.equal(r.held, true); assert.equal(r.noise, 0); assert.equal(b.loudness, 0);
  assert.ok(Math.abs(r.left - 5) < .05, `left ${r.left}`);
});

test('eight seconds is the limit, then a forced release with a gasp', () => {
  const b = createBreathHold();
  assert.equal(run(b, 7.9, true).r.held, true);
  const { r, gasped } = run(b, .2, true);
  assert.ok(gasped, 'gasp'); assert.equal(r.held, false);
  assert.ok(Math.abs(holdTime(1 / 60) - 8) < .03);
});

test('the gasp is one frame, louder than breathing, faint by the scale but heard well past 3 m', () => {
  const b = createBreathHold(); let gasps = 0, loud = 0;
  for (let i = 0; i < 60 * 9; i++) { const r = b.update(1 / 60, true); if (r.gasp) { gasps++; loud = r.noise; } }
  assert.equal(gasps, 1); assert.equal(loud, BREATH_HOLD.gaspNoise);
  assert.ok(loud > NOISE.breath * 5 && noiseGrade(loud) === 'faint' && hears(loud, 20));
});

test('winded, it can only be held for three seconds', () => {
  const b = createBreathHold();
  assert.equal(run(b, 2.9, true, true).r.held, true);
  assert.equal(run(b, .2, true, true).gasped, true);
  assert.ok(Math.abs(holdTime(1 / 60, true) - 3) < .03);
});

test('getting winded mid-hold cuts it short', () => {
  const b = createBreathHold(); run(b, 4, true);
  assert.equal(b.update(1 / 60, true, true).gasp, true, 'already past three seconds');
});

test('after a normal release it cannot be held for 2 s; after a gasp, 4 s and a fresh press', () => {
  const b = createBreathHold(); run(b, 1, true); run(b, .01, false);
  assert.equal(run(b, 1.9, true).r.held, false, 'still recovering (key down is ignored)');
  assert.equal(run(b, .2, true).r.held, true, 'recovered');
  const g = createBreathHold(); assert.ok(run(g, 8.5, true).gasped);
  assert.equal(run(g, 6, true).r.held, false, 'key still down: no re-hold after a gasp');
  run(g, .1, false);
  assert.equal(run(g, .1, true).r.held, true, 'released and pressed again, the recovery long over');
  const h = createBreathHold(); run(h, 8.5, true); run(h, .1, false);
  assert.equal(run(h, 3.2, true).r.held, false, 'inside the 4 s recovery');
  run(h, .1, false);
  assert.equal(run(h, .1, true).r.held, false, 'recovery counts down while the key is up or down');
});

test('timing is the same at 30, 60 and 144 steps a second', () => {
  for (const hz of [30, 60, 144]) {
    assert.ok(Math.abs(holdTime(1 / hz) - 8) < 1 / hz + 1e-6, `${hz} Hz held ${holdTime(1 / hz)}`);
    assert.ok(Math.abs(holdTime(1 / hz, true) - 3) < 1 / hz + 1e-6);
    const b = createBreathHold(); run(b, 1, true, false, 1 / hz); run(b, 1 / hz, false, false, 1 / hz);
    let t = 0; while (!b.update(1 / hz, true).held && t < 5) t += 1 / hz;
    assert.ok(Math.abs(t - 2) < 2 / hz + 1e-6, `${hz} Hz recovery ${t}`);
  }
});

test('a zero or negative step changes nothing, and reset breathes freely', () => {
  const b = createBreathHold(); run(b, 2, true);
  const left = b.update(0, true).left; assert.ok(Math.abs(left - 6) < .05);
  b.reset(); assert.equal(b.state.held, false); assert.equal(b.state.recovering, 0);
});
