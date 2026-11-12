import test from 'node:test';
import assert from 'node:assert/strict';
import { createBreathing, makeBreath, breathNeed, BREATH } from '../game/breathing.ts';

// A seeded random source, so every run of these tests hears the same breaths.
const seeded = (seed = 12345) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const DT = 1 / 60;
// Step the breathing for `seconds` with a fixed stamina; returns the breaths that began (with the time they began) and the last level.
const hold = (b, seconds, stamina, winded = false, dt = DT, start = 0) => {
  const breaths = []; let level = b.level;
  for (let t = 0; t < seconds - 1e-9; t += dt) { const r = b.update(dt, { stamina, winded }); level = r.level; if (r.breath) breaths.push({ at: start + t, breath: r.breath }); }
  return { breaths, level };
};
const centroid = seg => seg.bands.reduce((a, band) => a + band.frequency * band.gain, 0) / seg.bands.reduce((a, band) => a + band.gain, 0);
const peak = seg => Math.max(...seg.curve);
const peakAt = seg => seg.curve.indexOf(peak(seg)) / (seg.curve.length - 1);

test('with plenty of stamina there is no breathing at all, at any frame rate', () => {
  for (const hz of [30, 60, 120]) {
    const b = createBreathing(seeded());
    const r = hold(b, 120, 1, false, 1 / hz);
    assert.equal(r.breaths.length, 0); assert.equal(r.level, 0);
    assert.equal(hold(createBreathing(seeded()), 60, BREATH.begin + .01).breaths.length, 0, 'just above the threshold is still silent');
  }
});

test('the need for breath: none above the threshold, rising as stamina falls, full at empty, and never below a lockout floor while winded', () => {
  assert.equal(breathNeed(1, false), 0); assert.equal(breathNeed(BREATH.begin, false), 0);
  let last = 0;
  for (let s = BREATH.begin; s >= 0; s -= .01) { const n = breathNeed(s, false); assert.ok(n >= last - 1e-9); last = n; }
  assert.equal(breathNeed(0, false), 1);
  assert.ok(breathNeed(.3, false) < .35, 'a first, quiet stage');
  assert.ok(breathNeed(.25, true) >= BREATH.windedFloor, 'locked out: heavy even though some stamina is back');
  assert.equal(breathNeed(NaN, false), 0, 'a broken value is read as full');
});

test('it starts as stamina gets low, builds up, and is heaviest and fastest at empty', () => {
  const b = createBreathing(seeded());
  const early = hold(b, 6, .38), low = hold(b, 10, .15), empty = hold(b, 12, 0, true);
  assert.ok(early.breaths.length >= 1, 'a quiet breath once stamina is below the line');
  assert.ok(early.level < .3 && low.level > early.level && empty.level > low.level, `${early.level} ${low.level} ${empty.level}`);
  assert.ok(empty.level > .9);
  const gaps = list => list.slice(1).map((x, i) => x.at - list[i].at);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(gaps(empty.breaths.slice(-5))) < 1.7, `at empty a breath about every 1.3-1.6 s, got ${mean(gaps(empty.breaths.slice(-5))).toFixed(2)}`);
  assert.ok(mean(gaps(early.breaths.length > 1 ? early.breaths : [early.breaths[0], { at: early.breaths[0].at + 3.2 }])) > 2.4, 'and a slow one at first');
  const effortOf = list => mean(list.map(x => x.breath.effort));
  assert.ok(effortOf(empty.breaths.slice(-5)) > effortOf(early.breaths) + .4);
});

test('it eases off as stamina recovers, lingers a few seconds, then stops; the breath in progress is never cut short', () => {
  const b = createBreathing(seeded());
  hold(b, 8, 0, true);
  const full = b.level; assert.ok(full > .9);
  const levels = []; const after = [];
  for (let i = 0; i < 60 * 30; i++) { const r = b.update(DT, { stamina: 1, winded: false }); levels.push(r.level); if (r.breath) after.push(i * DT); }
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1e-12, 'only ever easing down');
  assert.ok(after.length >= 2, 'it carries on breathing after stamina is full');
  assert.ok(after[after.length - 1] > 3, 'and for a few seconds more');
  assert.ok(after[after.length - 1] < 15, `but stops within fifteen seconds (last breath at ${after[after.length - 1]?.toFixed(1)} s)`);
  assert.ok(levels.at(-1) < BREATH.min);
  const quiet = hold(b, 20, 1); assert.equal(quiet.breaths.length, 0, 'and then it is silent');
});

test('easing off is slower than building up', () => {
  const up = createBreathing(seeded()), down = createBreathing(seeded());
  hold(down, 10, 0, true);
  const rise = hold(up, 1.5, 0, true).level, fall = hold(down, 1.5, 1).level;
  assert.ok(rise > .75 && 1 - fall < rise, `after 1.5 s: up to ${rise.toFixed(2)}, down only to ${fall.toFixed(2)}`);
  assert.ok(fall > .35, `still breathing hard 1.5 s after the stamina is back (${fall.toFixed(2)})`);
});

test('breaths never overlap: the inhale ends before the exhale begins, the whole breath fits its length, and the next starts after it', () => {
  const b = createBreathing(seeded(7)); const r = hold(b, 60, 0, true);
  assert.ok(r.breaths.length > 20);
  for (let i = 0; i < r.breaths.length; i++) {
    const { inhale, exhale, length } = r.breaths[i].breath;
    assert.ok(inhale.delay + inhale.duration <= exhale.delay + 1e-9, 'the inhale is over before the exhale');
    assert.ok(exhale.delay + exhale.duration <= length + 1e-9, 'the exhale is over before the next breath is due');
    if (i) assert.ok(r.breaths[i].at - r.breaths[i - 1].at >= r.breaths[i - 1].breath.length - DT - 1e-9);
  }
});

test('breath timing does not depend on the frame rate', () => {
  const counts = [30, 60, 120].map(hz => hold(createBreathing(seeded(3)), 40, 0, true, 1 / hz).breaths.length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 3, `breaths in 40 s at 30/60/120 Hz: ${counts}`);
  const b = createBreathing(seeded()); const r = b.update(5, { stamina: 0, winded: true });
  assert.ok(r.level < .15, 'one huge frame is capped at a tenth of a second, not a jump to full breathing');
});

test('inhale and exhale are different sounds: the inhale brighter and thinner, the exhale lower with a quick onset and a long tail', () => {
  for (const effort of [.2, .6, 1]) {
    const { inhale, exhale } = makeBreath(effort, seeded(9));
    assert.ok(centroid(inhale) > centroid(exhale) * 1.4, `effort ${effort}: inhale ${centroid(inhale).toFixed(0)} Hz vs exhale ${centroid(exhale).toFixed(0)} Hz`);
    assert.ok(inhale.highpass > exhale.highpass, 'the inhale has less low end');
    assert.ok(inhale.sweep > 1 && exhale.sweep < 1, 'the inhale brightens as it goes, the exhale sinks');
    assert.ok(peakAt(inhale) > .45, `the inhale builds (peak at ${peakAt(inhale).toFixed(2)})`);
    assert.ok(peakAt(exhale) < .3, `the exhale starts quickly (peak at ${peakAt(exhale).toFixed(2)})`);
    assert.ok(exhale.duration > inhale.duration, 'and goes on longer');
  }
});

test('it is air, not a note: broad bands only, no oscillator-like peaking, several bands per sound, envelope starts and ends at zero', () => {
  for (const effort of [.05, .5, 1]) for (let i = 0; i < 20; i++) {
    const breath = makeBreath(effort, seeded(i + 1));
    for (const seg of [breath.inhale, breath.exhale]) {
      assert.ok(seg.bands.length >= 2, 'several bands, so there is no single resonant peak');
      for (const band of seg.bands) { assert.ok(band.q <= 1.05, `Q ${band.q}`); assert.ok(band.frequency > 150 && band.frequency < 6000); assert.ok(band.gain > 0); }
      assert.equal(seg.curve[0], 0); assert.equal(seg.curve.at(-1), 0);
      for (const v of seg.curve) assert.ok(Number.isFinite(v) && v >= 0);
    }
  }
});

test('every breath is a little different: length, loudness, colour and the shape of the envelope', () => {
  const b = createBreathing(seeded(21)); const list = hold(b, 120, 0, true).breaths.map(x => x.breath);
  const spread = f => { const v = list.map(f); return (Math.max(...v) - Math.min(...v)) / (v.reduce((a, c) => a + c, 0) / v.length); };
  assert.ok(spread(x => x.length) > .12, 'lengths vary');
  assert.ok(spread(x => peak(x.inhale)) > .1, 'loudness varies');
  assert.ok(spread(x => x.exhale.bands[0].frequency) > .05, 'colour varies');
  assert.ok(spread(x => x.exhale.duration) > .1);
  const a = makeBreath(1, seeded(1)).exhale.curve, c = makeBreath(1, seeded(2)).exhale.curve;
  assert.notDeepEqual(Array.from(a), Array.from(c));
  // ...but within bounds once it has built up: it is still one person breathing.
  for (const x of list.slice(6)) assert.ok(x.length > BREATH.fastPeriod * .8 && x.length < BREATH.fastPeriod * 1.6, `length ${x.length}`);
});

test('the envelope wobbles and is not a plain sine swell', () => {
  const { exhale } = makeBreath(1, seeded(5));
  const smooth = Array.from(exhale.curve, (_, i) => peak(exhale) * Math.pow(Math.sin(Math.PI * i / (exhale.curve.length - 1)), 1));
  assert.ok(Array.from(exhale.curve).some((v, i) => Math.abs(v - smooth[i]) > peak(exhale) * .1));
});

test('it stays quiet enough to hear the creature over it, and quieter still when it has only just begun', () => {
  const CAP = .14;
  let loudest = 0;
  for (let i = 0; i < 200; i++) { const x = makeBreath(1, seeded(i + 50)); loudest = Math.max(loudest, peak(x.inhale), peak(x.exhale)); }
  assert.ok(loudest <= CAP, `loudest envelope ${loudest.toFixed(3)} against a cap of ${CAP}`);
  assert.ok(loudest > .06, 'but it is there');
  const first = makeBreath(.05, seeded(2)), gasp = makeBreath(1, seeded(2));
  assert.ok(peak(first.exhale) < peak(gasp.exhale) * .6, 'the first breath is much softer than a gasp');
  assert.ok(first.length > 3 && gasp.length < 1.6, 'and slow, where the gasp is quick');
});

test('a breath is made only from the effort it is given, even when that is out of range', () => {
  for (const e of [-1, 0, 2, NaN]) { const x = makeBreath(e, seeded()); assert.ok(Number.isFinite(x.length) || Number.isNaN(e)); assert.ok(x.effort >= 0 && x.effort <= 1 || Number.isNaN(x.effort)); }
});
