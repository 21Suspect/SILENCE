import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { legShift, gaitTiming, createRhythmWander, RHYTHM, LEGS } = await import('../../../game/render/creature/spider-rhythm.ts');

const fract = x => x - Math.floor(x);
/** Circular distance between two phases, in cycles (0 to .5). */
const apart = (a, b) => { const d = fract(a - b); return Math.min(d, 1 - d); };

test('opposite legs of a pair and neighbouring legs on a side step half a cycle apart: the alternating tetrapods', () => {
  for (const run of [0, .5, 1]) for (let index = 0; index < 4; index++) {
    assert.ok(apart(legShift(index, -1, run), legShift(index, 1, run)) > .44, `pair ${index + 1} at run ${run}`);
    if (index < 3) for (const side of [-1, 1]) assert.ok(apart(legShift(index, side, run), legShift(index + 1, side, run)) > .38, `legs ${index + 1}-${index + 2} side ${side}`);
  }
});

test('a tetrapod lands spread over about a third of a step, hind legs first, so the sets run into each other without a gap', () => {
  for (const run of [0, 1]) {
    const set = LEGS.filter(({ index, side }) => ((index + (side > 0 ? 1 : 0)) % 2) === 0).map(({ index, side }) => legShift(index, side, run));
    const spread = Math.max(...set) - Math.min(...set);
    assert.ok(spread > .18 && spread < .36, `spread ${spread.toFixed(3)} cycles at run ${run}`);
    assert.ok(legShift(3, 1, run) > legShift(0, -1, run), 'the hind leg is called before the front one');
  }
});

test('the wander scatters every leg and drifts the front pair against the hind, within the measured bounds', () => {
  const w = createRhythmWander(3), seen = Array.from({ length: 8 }, () => []);
  for (let i = 0; i < 4000; i++) { w.advance(.02); LEGS.forEach(({ index, side }, k) => seen[k].push(w.shift(index, side))); }
  LEGS.forEach(({ index }, k) => {
    const lo = Math.min(...seen[k]), hi = Math.max(...seen[k]), bound = index < 2 ? RHYTHM.frontDrift + RHYTHM.frontScatter : RHYTHM.hindScatter;
    assert.ok(hi <= bound + 1e-9 && lo >= -bound - 1e-9, `leg ${k} stays within ${bound}`);
    assert.ok(hi - lo > bound * .6, `leg ${k} really wanders (${(hi - lo).toFixed(3)})`);
  });
  // Smooth: it never moves more than a few tenths of a cycle per cycle, so the gait calls each leg once a cycle.
  for (const s of seen) for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i] - s[i - 1]) / .02 < .45);
});

test('the wander is seeded and stands still when the legs do', () => {
  const a = createRhythmWander(5), b = createRhythmWander(5);
  for (let i = 0; i < 50; i++) { a.advance(.1); b.advance(.1); }
  assert.equal(a.shift(0, -1), b.shift(0, -1));
  const before = a.shift(1, 1); a.advance(0); assert.equal(a.shift(1, 1), before);
});

test('faster by stepping faster: the step rate climbs to a drum roll at a charge while the duty falls to half', () => {
  const creep = gaitTiming(1.2), trot = gaitTiming(4), charge = gaitTiming(11.2);
  assert.ok(creep.frequency < trot.frequency && trot.frequency < charge.frequency);
  assert.ok(charge.frequency > 4 && charge.frequency < 5.5, `charge ${charge.frequency.toFixed(2)} Hz`);
  assert.ok(creep.duty > .7 && charge.duty < .56 && charge.duty >= .5);
  assert.ok(charge.swing < .12 && creep.swing > .15, `swings ${creep.swing.toFixed(3)} to ${charge.swing.toFixed(3)} s`);
});

test('every step is drawn afresh: a kick moves only that leg, within its bound, and no two steps of a leg are alike', () => {
  const w = createRhythmWander(11), seen = new Set();
  for (let i = 0; i < 40; i++) {
    const other = w.shift(3, 1); w.kick(0, -1);
    assert.equal(w.shift(3, 1), other, 'another leg is untouched');
    seen.add(w.shift(0, -1).toFixed(4));
    assert.ok(Math.abs(w.shift(0, -1)) <= RHYTHM.frontDrift + RHYTHM.frontScatter + RHYTHM.stepFront + 1e-9);
  }
  assert.ok(seen.size > 30, `${seen.size} different shifts in 40 steps`);
});
