import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The playtest report's rules, on small made-up nights: each reactive sound means something once (one hiss per stun
 * engagement, one roar per hunt), an ambient sound is never right after a loud one or a sighting, and the stun's
 * braking is judged by the body's own speed. The whole-night checks against the real creature are scripts/playtest/run.mjs.
 */
const { judgeRun, summarize, stunCurve, RULES } = await import('../scripts/playtest/report.mjs');

/** A quiet night that keeps every rule: the opening on time, free roam from 5:20, `extra` merged in. */
function night(extra = {}) {
  return {
    style: 'trail', seed: 1, duration: 500, ended: 'dawn', indoorsSeconds: 0,
    opening: [{ type: 'seen', kind: 'glimpse', variant: 'ground', t: 100 }, { event: 'seen', phase: 'glimpse', at: 100, t: 100 }, { type: 'seen', kind: 'tree', variant: 'tree', t: 250 }, { event: 'seen', phase: 'tree', at: 250, t: 250 }, { type: 'phase', to: 'free', t: 320 }],
    timeline: [], grabs: [], visibilityPops: [], sightings: [], deaths: [], stuns: [], hunts: [], sounds: [],
    ...extra,
  };
}
const sound = (t, kind, presence = false, seen = false) => ({ t, kind, presence, seen, distance: 20 });
const rules = log => judgeRun(log).violations.map(v => v.rule);

test('a quiet night breaks nothing', () => {
  const log = night({ sounds: [sound(100, 'reveal'), sound(250, 'reveal'), sound(400, 'clicks', true), sound(560, 'branch', true)] });
  assert.deepEqual(rules(log), []);
});

test('one hiss per stun engagement: two within the quiet are a violation, unless a new hunt (a roar) came between', () => {
  const again = night({ sounds: [sound(400, 'hiss'), sound(412, 'hiss')] });
  assert.deepEqual(rules(again), ['hiss-repeat']);
  assert.deepEqual(rules(night({ sounds: [sound(400, 'hiss'), sound(406, 'roar'), sound(412, 'hiss')] })), [], 'a new hunt hisses again');
  assert.deepEqual(rules(night({ sounds: [sound(400, 'hiss'), sound(400 + RULES.hissQuiet + 1, 'hiss')] })), [], 'and so does a stun a good while after');
});

test('one roar per hunt: a second within the gap in free roam is a violation; the scripted roar of the opening is not counted', () => {
  assert.deepEqual(rules(night({ sounds: [sound(200, 'roar'), sound(330, 'roar')] })), [], 'the tree encounter roars in the opening');
  assert.deepEqual(rules(night({ sounds: [sound(400, 'roar'), sound(400 + RULES.roarGap - 5, 'roar')] })), ['roar-repeat']);
  assert.deepEqual(rules(night({ sounds: [sound(400, 'roar'), sound(400 + RULES.roarGap + 5, 'roar')] })), []);
});

test('an ambient sound is never right after a loud one or after it was seen; in the opening these do not apply', () => {
  assert.deepEqual(rules(night({ sounds: [sound(400, 'hiss'), sound(410, 'clicks', true)] })), ['ambient-after-loud']);
  assert.deepEqual(rules(night({ sounds: [sound(400, 'hiss'), sound(400 + RULES.loudQuiet + 5, 'clicks', true)] })), []);
  assert.deepEqual(rules(night({ sightings: [{ t: 380, end: 395, seconds: 15, minDistance: 20 }], sounds: [sound(410, 'branch', true)] })), ['ambient-after-sighting']);
  // The lost-chase call may follow a sighting: it is the creature's own cry, not a lure.
  assert.deepEqual(rules(night({ sightings: [{ t: 380, end: 395, seconds: 15, minDistance: 20 }], sounds: [sound(410, 'call', true)] })), []);
  // Before free roam (the opening's own cues) the rules are the opening's.
  assert.deepEqual(rules(night({ sounds: [sound(300, 'reveal'), sound(310, 'clicks', true)] })), []);
});

test('ambient sounds are never made while the creature is looked at', () => {
  for (const kind of ['clicks', 'knock', 'branch', 'call']) assert.deepEqual(rules(night({ sounds: [sound(500, kind, true, true)] })), ['sound-while-seen'], kind);
});

/** The body's speed through a stun, one sample each .1 s: [seconds since the pin, phase, m/s, touching a trunk]. */
const stun = speeds => ({ t: 400, phases: { slowing: .6, held: 1, starting: 1.5 }, speeds: speeds.map((v, i) => [i / 10, 'slowing', v, 0]), startDistance: 20, endDistance: 22 });

test('the stun: an eased stop passes, a hard brake (6 m/s gone in .1 s) is flagged, a trunk in the way is not the stun\'s doing', () => {
  const eased = stun([6.5, 6.4, 5.7, 4.3, 2.6, 1.1, .3, 0]);
  assert.deepEqual(rules(night({ stuns: [eased] })), []);
  const hard = stun([6.5, 6.4, 6.2, 0, 0, 0, 0, 0]);
  assert.deepEqual(rules(night({ stuns: [hard] })), ['stun-hard-brake']);
  const trunk = stun([6.5, 6.4, 6.2, 0, 0, 0, 0, 0]); trunk.speeds[3][3] = 1;
  assert.deepEqual(rules(night({ stuns: [trunk] })), []);
});

test('the stun curve of a report: the median speed every .1 s from the pin, over charges only', () => {
  const log = night({ stuns: [stun([6.5, 6.4, 5.7, 4.3, 2.6, 1.1, .3, 0]), stun([6.5, 6.3, 5.5, 4.1, 2.4, 1, .2, 0]), stun([1.2, 1, .8, .5, .2, 0, 0, 0])] });
  const curve = stunCurve([log]);
  assert.equal(curve.n, 2, 'the walk (1.2 m/s) is not a charge');
  assert.ok(Math.abs(curve.median[0] - 6.5) < .01 && curve.median[7] < .2, curve.median.slice(0, 8).join(' '));
  for (let i = 1; i < 8; i++) assert.ok(curve.median[i] <= curve.median[i - 1] + 1e-9, 'never speeds up');
});

test('the report asks for the sound and lethality bands per style', () => {
  const quiet = night({ sounds: [sound(100, 'reveal'), sound(250, 'reveal'), sound(400, 'clicks', true)] });
  const { expectations } = summarize([quiet]);
  const texts = expectations.map(e => e.text);
  assert.ok(texts.some(t => t.startsWith('p90 of sounds per ten minutes under 16')), texts.join('\n'));
  assert.ok(texts.some(t => t.startsWith(`deaths per night in ${RULES.deaths.trail[0]}-${RULES.deaths.trail[1]}`)));
  assert.deepEqual(RULES.soundsPer10, [4, 12]);
  assert.deepEqual(RULES.presencePer10, [3, 7]);
});
