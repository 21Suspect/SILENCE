import test from 'node:test';
import assert from 'node:assert/strict';
import { NOISE, GRADE, noiseGrade, heardWithin, hears, footstepNoise, WEATHER_COVER } from '../../../game/sim/noise/noise-scale.ts';

test("the scale is the design's table: each row heard within its range", () => {
  const within = (name, lo, hi) => { const m = heardWithin(NOISE[name]); assert.ok(m >= lo && m <= hi, `${name}: ${m} m, wanted ${lo}-${hi}`); };
  for (const n of ['crouchStep', 'whisper', 'bicyclePath']) within(n, 5, 8);
  for (const n of ['walkStep', 'door', 'loadedBicyclePath']) within(n, 20, 25);
  for (const n of ['talk', 'sprintStep', 'bicycleRough']) within(n, 40, 50);
  for (const n of ['bell', 'alarm', 'crateBreak']) within(n, 60, 80);
  for (const n of ['generator', 'pump', 'hammering']) within(n, 150, 150);
  assert.ok(heardWithin(NOISE.island) >= 1500, 'the whole island');
  within('breath', 3, 3);
});

test('grades follow how far a sound carries, and anything kept up is very loud', () => {
  assert.equal(noiseGrade(NOISE.door), 'faint');
  assert.equal(noiseGrade(NOISE.walkStep), 'faint');
  assert.equal(noiseGrade(NOISE.sprintStep), 'loud');
  assert.equal(noiseGrade(NOISE.bell), 'loud');
  assert.equal(noiseGrade(NOISE.generator), 'veryLoud');
  assert.equal(noiseGrade(NOISE.island), 'veryLoud');
  assert.equal(noiseGrade(NOISE.walkStep, true), 'veryLoud', 'kept up');
  assert.equal(noiseGrade(GRADE.faintBelow), 'loud');
  assert.equal(noiseGrade(GRADE.loudBelow), 'veryLoud');
});

test('heard inside its distance, not outside, with no falloff; weather is cover', () => {
  assert.equal(hears(NOISE.walkStep, 21.9), true);
  assert.equal(hears(NOISE.walkStep, 22.1), false);
  assert.equal(hears(NOISE.bell, 69), true);
  assert.equal(hears(NOISE.bell, 69, 'rain'), false, 'rain halves it to 35 m');
  assert.ok(Math.abs(heardWithin(NOISE.generator, 'wind') - 100) < 1e-9, 'wind cuts a third');
  assert.ok(Math.abs(heardWithin(NOISE.generator, 'storm') - 50) < 1e-9, 'a storm cuts two thirds');
  assert.equal(WEATHER_COVER.still, 1);
});

test('footsteps: the gait picks the row, the ground only nudges it, and standing still is silent', () => {
  const step = (o) => footstepNoise({ speed: 1.8, sprinting: false, crouching: false, surface: 'dirt', ...o });
  assert.equal(step({ speed: 0 }), 0);
  assert.equal(noiseGrade(step({ crouching: true, speed: .9, surface: 'road' })), 'faint');
  assert.equal(noiseGrade(step({ surface: 'road' })), 'faint');
  assert.equal(noiseGrade(step({ sprinting: true, speed: 5.6, surface: 'forest' })), 'loud');
  assert.ok(step({ surface: 'forest' }) < step({ surface: 'dirt' }) && step({ surface: 'dirt' }) < step({ surface: 'road' }));
  assert.equal(noiseGrade(step({ surface: 'water' })), 'loud', 'wading is loud whatever you do');
});
