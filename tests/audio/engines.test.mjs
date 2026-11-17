import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register-ts-hooks.mjs';
const { ENGINES, firingHz, engineHearing, engineRate, engineFlutter, synthesizeEngine, ENGINE_LOOP_SECONDS, ENGINE_FADE_END } = await import('../../game/audio/engines.ts');
const { createRandom } = await import('../../game/sim/creature/creature-brain.ts');

/** Energy of a signal at one frequency (Goertzel). */
function power(data, sampleRate, hz) {
  const w = 2 * Math.PI * hz / sampleRate, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < data.length; i++) { const s = data[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / data.length;
}

test('firing rate: a four-stroke fires once per two turns per cylinder: 12.5 Hz for the generator, 25 Hz for the pump, at 1500 rpm', () => {
  assert.equal(ENGINES.generator.rpm, 1500);
  assert.equal(firingHz('generator'), 12.5);
  assert.equal(firingHz('pump'), 25);
  assert.equal(firingHz('generator', 1800), 15);
});

test('hearing: loudest near, still faintly there at 150 m, gone past the fade; the top goes first with distance', () => {
  let last = Infinity;
  for (const d of [0, 5, 20, 60, 100, 150, 200]) { const g = engineHearing('generator', d).gain; assert.ok(g <= last + 1e-12, `gain falls with distance (${d} m)`); last = g; }
  const at150 = engineHearing('generator', 150);
  assert.ok(at150.audible && at150.gain > .01 && at150.gain < .06, `faint at 150 m (${at150.gain.toFixed(3)})`);
  assert.ok(engineHearing('generator', 5).gain > at150.gain * 10, 'much louder close up');
  assert.equal(engineHearing('generator', ENGINE_FADE_END + 1).audible, false);
  assert.equal(engineHearing('pump', 1000).gain, 0);
  assert.ok(engineHearing('generator', 150).lowpass < engineHearing('generator', 10).lowpass, 'air takes the top first');
  assert.ok(engineHearing('generator', 150).lowpass >= 300);
  assert.equal(engineHearing('generator', 0).gain, engineHearing('generator', 3).gain, 'inside the reference distance it does not grow');
});

test('rpm wanders slowly and never settles: within +-6 per cent, different per engine, no repeat inside two minutes, smooth', () => {
  let lo = Infinity, hi = -Infinity, maxStep = 0, previous = engineRate('gen', 0);
  const seen = new Set();
  for (let t = 0; t < 120; t += .05) {
    const r = engineRate('gen', t); lo = Math.min(lo, r); hi = Math.max(hi, r); maxStep = Math.max(maxStep, Math.abs(r - previous)); previous = r; seen.add(r.toFixed(5));
  }
  assert.ok(lo > .94 && hi < 1.06, `${lo} .. ${hi}`);
  assert.ok(hi - lo > .03, 'it really moves');
  assert.ok(maxStep < .006, 'slowly');
  assert.ok(seen.size > 2000, 'not periodic over two minutes');
  assert.notEqual(engineRate('gen-a', 10), engineRate('gen-b', 10), 'two engines are not in step');
  assert.equal(engineRate('gen', 12.3), engineRate('gen', 12.3), 'deterministic');
  for (let t = 0; t < 30; t += .5) { const f = engineFlutter('gen', t); assert.ok(f > .93 && f < 1.07); }
});

for (const kind of ['generator', 'pump']) {
  test(`the ${kind} loop: a whole number of firings, finite, normalised, no step at the seam, and its firing rate is the strongest low line`, () => {
    const sr = 22050, data = synthesizeEngine(kind, sr, createRandom(5)), hz = firingHz(kind);
    assert.equal(data.length, Math.round(Math.round(ENGINE_LOOP_SECONDS * hz) / hz * sr));
    let peak = 0, sum = 0;
    for (const v of data) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); sum += v * v; }
    assert.ok(peak > .85 && peak <= .9 + 1e-6, `peak ${peak}`);
    const rms = Math.sqrt(sum / data.length);
    assert.ok(rms > .05, 'not silent');
    const step = Math.abs(data[0] - data[data.length - 1]);
    assert.ok(step < rms * 1.5 + .05, `seam step ${step.toFixed(3)} vs rms ${rms.toFixed(3)}`);
    // The thump repeats at the firing rate: that line beats a frequency half-way to the next.
    const line = power(data, sr, hz), between = power(data, sr, hz * 1.5);
    assert.ok(line > between * 2, `firing line ${line.toExponential(2)} vs ${between.toExponential(2)}`);
    // Mostly low: more energy under 200 Hz than between 2 and 4 kHz.
    let low = 0, high = 0;
    for (let f = 20; f < 200; f += 7) low += power(data, sr, f);
    for (let f = 2000; f < 4000; f += 70) high += power(data, sr, f);
    assert.ok(low > high * 5, 'a thump, not a hiss');
  });
}

test('the loop is not mechanical: two seeds differ (lope, jitter), the same seed is identical, firings differ in strength', () => {
  const a = synthesizeEngine('generator', 11025, createRandom(1)), b = synthesizeEngine('generator', 11025, createRandom(1)), c = synthesizeEngine('generator', 11025, createRandom(2));
  assert.deepEqual(a, b);
  let different = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - c[i]) > 1e-4) different++;
  assert.ok(different > a.length * .5);
  const hz = firingHz('generator'), per = Math.round(11025 / hz), peaks = [];
  for (let n = 0; n < 8; n++) { let m = 0; for (let i = 0; i < per; i++) m = Math.max(m, Math.abs(a[n * per + i])); peaks.push(m); }
  assert.ok(Math.max(...peaks) - Math.min(...peaks) > .03, `uneven firings ${peaks.map(v => v.toFixed(2))}`);
});
