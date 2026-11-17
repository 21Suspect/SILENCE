import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { world, dist } = await import('../../helpers/creature-world.mjs');
const { CREATURE_TUNING: T } = await import('../../../game/sim/creature/creature-brain.ts');
const { NOISE } = await import('../../../game/sim/noise/noise-scale.ts');

const GEN = { x: 100, z: 0, loudness: NOISE.generator };
const count = (events, type) => events.filter(e => e.type === type).length;

test('a running generator is heard inside its reach: the creature runs there, calls once, and prowls round it for as long as it runs', () => {
  const w = world();
  w.brain.source('generator', GEN);
  const first = w.run(30);
  assert.ok(first.behaviours.includes('run') && first.behaviours.includes('prowl'), `behaviours: ${first.behaviours}`);
  assert.equal(count(first.events, 'call'), 1);
  // Two minutes on it is still there, but never parked: it goes round the machine on rings that widen and close.
  const bearings = new Set(), ranges = [];
  let moved = 0, last = { ...w.self };
  for (let i = 0; i < 120; i++) {
    const r = w.run(1);
    assert.deepEqual(r.behaviours, ['prowl'], `second ${i}: ${r.behaviours}`);
    assert.equal(count(r.events, 'call'), 0, 'no further calls');
    const d = dist(w.self, GEN); ranges.push(d);
    bearings.add(Math.round(Math.atan2(w.self.x - GEN.x, w.self.z - GEN.z) / (Math.PI / 4)));
    moved += dist(w.self, last); last = { ...w.self };
  }
  assert.ok(Math.max(...ranges) < T.prowlRing[1] + 6, `stays round it (out to ${Math.max(...ranges).toFixed(1)} m)`);
  assert.ok(Math.max(...ranges) - Math.min(...ranges) > 15, 'the rings widen and close');
  assert.ok(bearings.size >= 6, `all the way round (${bearings.size} of 8 sectors)`);
  assert.ok(moved > 120 * T.prowlSpeed * .6, `it keeps moving (${moved.toFixed(0)} m in two minutes)`);
});

test('switched off, it searches where it is, and then moves on', () => {
  const w = world();
  w.brain.source('generator', GEN);
  w.run(40);
  w.brain.source('generator', null);
  const off = w.run(T.sourceStayQuiet + 1);
  assert.ok(off.behaviours.includes('search'), `searches once it stops: ${off.behaviours}`);
  assert.ok(T.sourceStayQuiet < T.stayQuiet, 'quicker than waiting out a repeated hum');
  assert.ok(dist(w.self, GEN) < T.prowlRing[1] + 6, 'near the machine');
  const after = w.run(T.searchSeconds + 5);
  assert.ok(after.behaviours.includes('round'), 'then it carries on with its night');
  assert.deepEqual(w.brain.sources(), []);
});

test('outside its reach it is not heard; moved into reach (or the creature coming near), it is', () => {
  const w = world();
  w.brain.source('generator', { ...GEN, x: 200 });
  assert.equal(w.run(10).behaviours.includes('run'), false, '200 m is past 150');
  w.brain.source('generator', { ...GEN, x: 140 });
  assert.ok(w.run(3).behaviours.includes('run'), 'a place 140 m off is inside it');
});

test('weather shortens the reach of a running source like any other noise', () => {
  const brain = world().brain;
  const w = world();
  w.brain.source('generator', { ...GEN, x: 100 });
  // Rain halves it: 75 m.
  const out = w.brain.tick({ dt: .05, hours: 23.5, weather: 'rain', creature: { ...w.self }, player: w.player, beamOnIt: false, reach: Infinity });
  assert.notEqual(out.behaviour, 'run', 'not heard at 100 m in rain');
  assert.ok(brain);
  const near = world(); near.brain.source('generator', { ...GEN, x: 60 });
  const heard = near.brain.tick({ dt: .05, hours: 23.5, weather: 'rain', creature: { ...near.self }, player: near.player, beamOnIt: false, reach: Infinity });
  assert.equal(heard.behaviour, 'run', 'heard at 60 m in rain');
});

test('asleep by day, a running generator within reach wakes it: it is very loud', () => {
  const w = world({ hours: 12, at: { x: 0, z: 0, yaw: 0 } });
  w.run(2);
  assert.equal(w.brain.behaviour, 'asleep');
  w.brain.source('generator', GEN);
  const r = w.run(5);
  assert.ok(r.events.some(e => e.type === 'wake'));
  assert.equal(w.brain.behaviour, 'run');
});

test('a creature led off by a one-off noise is called back by a source still in reach, every sourceRetake seconds; one out of reach is not', () => {
  const w = world();
  w.brain.source('generator', GEN);
  w.run(30);
  // A siren far away on the other side draws it (the same grade always takes over)...
  w.brain.hear({ loudness: NOISE.island, source: 'siren', x: -300, z: 0 });
  const led = w.run(1);
  assert.equal(w.brain.inspect().lead.source, 'siren');
  assert.ok(led.behaviours.includes('run'));
  // ...and the generator, still within reach of where it is, takes it back as its hum once did every seven seconds.
  w.run(T.sourceRetake + 1);
  assert.equal(w.brain.inspect().lead.source, 'generator');
  // Far out of reach it is not pulled back at all.
  const far = world({ at: { x: 400, z: 0, yaw: 0 } });
  far.brain.source('generator', GEN);
  far.brain.hear({ loudness: NOISE.island, source: 'siren', x: 800, z: 0 });
  far.run(20);
  assert.equal(far.brain.inspect().lead.source, 'siren');
});

test('the same source id replaces its place; a bad number is ignored; sustained events still work', () => {
  const w = world();
  w.brain.source('generator', GEN); w.brain.source('generator', { ...GEN, x: 90 });
  assert.deepEqual(w.brain.sources(), [{ id: 'generator', x: 90, z: 0, loudness: NOISE.generator }]);
  w.brain.source('pump', { x: NaN, z: 0, loudness: 1 });
  assert.equal(w.brain.sources().length, 1);
  const s = world(); s.brain.hear({ loudness: NOISE.generator, source: 'generator', x: 100, z: 0, sustained: true });
  assert.ok(s.run(30).behaviours.includes('run'), 'the old hum events are taken as before');
});

test('determinism: the same seed and the same sources replay exactly', () => {
  const play = () => { const w = world({ seed: 4 }); w.brain.source('generator', GEN); const log = []; for (let i = 0; i < 400; i++) { if (i === 200) w.brain.source('generator', null); log.push(JSON.stringify(w.step().events), w.self.x.toFixed(4)); } return log; };
  assert.deepEqual(play(), play());
});
