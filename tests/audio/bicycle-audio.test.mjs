import '../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const a = await import('../../game/audio/bicycle-audio.ts');

test('the rolling is silent standing, grows with speed, and gravel is louder than tarmac', () => {
  for (const surface of ['road', 'path', 'dirt', 'forest']) assert.equal(a.rollLevel(0, surface), 0);
  assert.ok(a.rollLevel(5.4, 'road') > a.rollLevel(2.7, 'road'));
  assert.ok(a.rollLevel(5.4, 'path') > a.rollLevel(5.4, 'road'));
  assert.ok(a.rollLevel(5.4, 'dirt') > a.rollLevel(5.4, 'road'));
  assert.equal(a.rollLevel(5.4, 'water'), 0);
  assert.ok(a.rollBrightness(5.4, 'road') > a.rollBrightness(1, 'road'), 'brighter the faster it goes');
  assert.ok(Math.abs(a.wheelHz(2 * Math.PI * .355) - 1) < 1e-9);
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
