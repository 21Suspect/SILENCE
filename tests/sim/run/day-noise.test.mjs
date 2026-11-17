import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createDayNoise, DAY_NOISE } = await import('../../../game/sim/run/day-noise.ts');
const { NOISE } = await import('../../../game/sim/noise/noise-scale.ts');

const n = (x, z, loudness, hours, sustained) => ({ x, z, loudness, hours, sustained });

test('an empty day has no loudest place, no places and nothing loud near', () => {
  const d = createDayNoise();
  assert.equal(d.loudest(), null); assert.deepEqual(d.places(5), []); assert.equal(d.loudNear(0, 0, 1000), false);
});

test('the loudest noise of the day is where the night begins; ties go to the latest', () => {
  const d = createDayNoise();
  d.record(n(10, 10, NOISE.walkStep, 8));
  d.record(n(200, 50, NOISE.crateBreak, 9));
  d.record(n(-300, 0, NOISE.sprintStep, 10));
  let l = d.loudest();
  assert.equal(l.x, 200); assert.equal(l.z, 50); assert.equal(l.loudness, NOISE.crateBreak);
  d.record(n(-500, 80, NOISE.crateBreak, 12));
  l = d.loudest();
  assert.equal(l.x, -500, 'a tie goes to the later noise');
});

test('a kept-up noise outranks a louder one-off, as the grades do', () => {
  const d = createDayNoise();
  d.record(n(0, 0, .9, 9));
  d.record(n(500, 0, .3, 10, true));
  assert.equal(d.loudest().x, 500);
  assert.equal(d.places(2)[0].sustained, true);
});

test('silent and broken records are ignored', () => {
  const d = createDayNoise();
  d.record(n(0, 0, 0, 1)); d.record(n(NaN, 0, 1, 1)); d.record(n(0, 0, -1, 1));
  assert.equal(d.loudest(), null); assert.equal(d.places().length, 0);
});

test('places merge noises within 30 m, keep the loudest member\'s spot, and come loudest first', () => {
  const d = createDayNoise();
  d.record(n(0, 0, NOISE.walkStep, 8));
  d.record(n(20, 0, NOISE.sprintStep, 8.1));      // same place (20 m)
  d.record(n(25, 0, NOISE.door, 8.2));            // still the same spot
  d.record(n(400, 400, NOISE.generator, 9));
  d.record(n(-200, 0, NOISE.crateBreak, 10));
  const p = d.places(10);
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((q) => [q.x, q.z]), [[400, 400], [-200, 0], [20, 0]]);
  assert.equal(p[2].count, 3); assert.equal(p[2].loudness, NOISE.sprintStep);
  assert.equal(d.places(1).length, 1);
  assert.equal(d.places(0).length, 0);
});

test('places returns copies: changing them does not change the log', () => {
  const d = createDayNoise();
  d.record(n(5, 5, 1, 1));
  d.places()[0].x = 999; d.loudest().x = 999;
  assert.equal(d.places()[0].x, 5); assert.equal(d.loudest().x, 5);
});

test('loudNear: only grade loud or above counts, within the radius', () => {
  const d = createDayNoise();
  for (let i = 0; i < 200; i++) d.record(n(i * .5, 0, NOISE.walkStep, 8 + i / 100));   // a day of footsteps
  assert.equal(d.loudNear(0, 0, 500), false, 'faint noises are not loud');
  d.record(n(100, 100, NOISE.sprintStep, 9));
  assert.equal(d.loudNear(100, 100, 1), true);
  assert.equal(d.loudNear(100, 130, 31), true);
  assert.equal(d.loudNear(100, 130, 29), false);
  assert.equal(d.loudNear(0, 0, 50), false);
  d.record(n(-40, -40, NOISE.generator, 9, true));
  assert.equal(d.loudNear(-40, -41, 5), true);
  d.record(n(300, 0, NOISE.island, 9));
  assert.equal(d.loudNear(310, 0, 15), true);
});

test('a noise just under the faint line is not loud; one exactly at it is', () => {
  const d = createDayNoise();
  d.record(n(0, 0, .29, 1));
  assert.equal(d.loudNear(0, 0, 10), false);
  d.record(n(0, 0, .3, 1));
  assert.equal(d.loudNear(0, 0, 10), true);
});

test('the log stays bounded however many noises there are', () => {
  const d = createDayNoise();
  for (let i = 0; i < 20000; i++) d.record(n((i * 37) % 2000, (i * 91) % 2000, i % 7 ? NOISE.walkStep : NOISE.crateBreak, 8 + i / 1000));
  assert.ok(d.places().length <= DAY_NOISE.maxPlaces);
  assert.ok(d.state().today.loud.length <= DAY_NOISE.maxLoud);
  assert.equal(d.loudest().loudness, NOISE.crateBreak);
});

test('when the spots are full the faintest and oldest give way to a louder newcomer', () => {
  const d = createDayNoise();
  for (let i = 0; i < DAY_NOISE.maxPlaces; i++) d.record(n(i * 100, 0, NOISE.crouchStep, i));
  d.record(n(0, 5000, NOISE.generator, 99));
  const p = d.places();
  assert.equal(p.length, DAY_NOISE.maxPlaces);
  assert.equal(p[0].z, 5000);
  assert.ok(!p.some((q) => q.x === 0 && q.z === 0), 'the oldest faint spot was dropped');
  d.record(n(0, 6000, NOISE.crouchStep, 100));
  assert.equal(d.places().length, DAY_NOISE.maxPlaces);
});

test('the night after a day still uses that day\'s log; dawn rolls it', () => {
  const d = createDayNoise();
  d.record(n(100, 100, NOISE.crateBreak, 14));
  d.record(n(-50, 20, NOISE.generator, 15, true));
  assert.equal(d.loudest().x, -50, 'at dusk and all through the night, the day\'s log is what the Listener reads');
  d.record(n(5, 5, NOISE.walkStep, 23));          // night noises join the day that is ending
  assert.equal(d.loudest().x, -50); assert.equal(d.places().length, 3);
  d.dawn();
  assert.equal(d.loudest(), null); assert.equal(d.places().length, 0); assert.equal(d.loudNear(100, 100, 5), false);
  assert.equal(d.yesterday.loudest().x, -50, 'yesterday\'s log is kept');
  d.record(n(7, 7, NOISE.bell, 8));
  assert.equal(d.loudest().x, 7);
  d.dawn();
  assert.equal(d.yesterday.loudest().x, 7);
});

test('state and restore round trip, including yesterday', () => {
  const a = createDayNoise();
  a.record(n(1, 2, NOISE.bell, 8)); a.dawn(); a.record(n(30, 40, NOISE.generator, 9, true)); a.record(n(500, 1, NOISE.walkStep, 10));
  const saved = JSON.parse(JSON.stringify(a.state()));
  const b = createDayNoise(saved);
  assert.deepEqual(b.state(), a.state());
  assert.deepEqual(b.places(), a.places());
  assert.equal(b.loudNear(30, 40, 1), true);
  assert.equal(b.yesterday.loudest().x, 1);
  const c = createDayNoise(); c.restore(saved);
  assert.deepEqual(c.state(), saved);
});
