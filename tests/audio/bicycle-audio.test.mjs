import '../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const a = await import('../../game/audio/bicycle-audio.ts');

test('the rolling is one sound that revs with speed: silent standing, louder and higher the faster, gravel louder than tarmac', () => {
  for (const surface of ['road', 'path', 'dirt', 'forest']) {
    const m = a.rollMix(0, surface, 1);
    assert.equal(m.tyre + m.grit + m.rumble + m.chain + m.ratchet, 0, `${surface} standing`);
  }
  const slow = a.rollMix(3, 'road', 1), fast = a.rollMix(8.4, 'road', 1);
  assert.ok(fast.tyre > slow.tyre && fast.chain > slow.chain && fast.chainHz > slow.chainHz && fast.hum > slow.hum, 'revs up with speed');
  const loud = m => m.tyre + m.grit + m.rumble;
  assert.ok(loud(a.rollMix(7, 'path', 1)) > loud(a.rollMix(7, 'road', 1)), 'gravel crunches louder than tarmac hums');
  assert.ok(a.rollMix(6, 'forest', 1).bumps > a.rollMix(6, 'road', 1).bumps, 'the rough rattles the rack');
  const w = a.rollMix(6, 'water', 1); assert.equal(w.tyre + w.grit + w.rumble, 0);
  assert.ok(Math.abs(a.wheelHz(2 * Math.PI * .355) - 1) < 1e-9);
});

test('the chain whirs at the rate its links meet the teeth while pedalling; coasting, the freewheel ticks instead', () => {
  // 46/18 gearing: the chain runs 18 links past for every wheel turn.
  assert.ok(Math.abs(a.chainHz(2 * Math.PI * .355) - 18) < 1e-9);
  const cruise = a.chainHz(8.4); assert.ok(cruise > 60 && cruise < 75, `a buzz at a cruise (${cruise.toFixed(0)} Hz)`);
  assert.ok(a.chainHz(1.6) < 15, 'a flutter at a walking pace');
  const pedal = a.rollMix(6, 'road', 1), coast = a.rollMix(6, 'road', 0);
  assert.ok(pedal.chain > 0 && pedal.ratchet === 0, 'pedalling: the chain');
  assert.ok(coast.chain === 0 && coast.ratchet > 0, 'coasting: the freewheel');
  assert.ok(coast.ratchetHz > coast.chainHz, 'its clicks come quicker than the links');
});

test('the bell has two inharmonic partials near 2.4 and 3.6 kHz that differ a little each ring', () => {
  const rings = Array.from({ length: 20 }, () => a.bellPartials());
  for (const [one, beat, second, third] of rings) {
    assert.ok(one.frequency > 2300 && one.frequency < 2500, String(one.frequency));
    const b = beat.frequency - one.frequency; assert.ok(b > 5 && b < 25, `the fundamental beats (${b.toFixed(1)} Hz)`);
    const r2 = second.frequency / one.frequency, r3 = third.frequency / one.frequency;
    assert.ok(r2 > 2.6 && r2 < 2.8 && r3 > 4 && r3 < 4.2, 'inharmonic, as a struck dome is');
    assert.ok(second.level < one.level && third.level < second.level);
  }
  assert.notDeepEqual(rings[0], rings[1], 'a little different every ring');
  assert.equal(a.BELL.strikes, 3);
  assert.ok(a.BELL.attack < .01 && a.BELL.decay > 1 && a.BELL.decay < 1.5);
});

test('with no audio context nothing rings and nothing throws', () => {
  const audio = a.createBicycleAudio();
  assert.equal(audio.bell(), false); audio.roll(5, 'road'); audio.dispose();
});
