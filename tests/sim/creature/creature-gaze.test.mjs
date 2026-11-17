import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { world, dist, percept } = await import('../../helpers/creature-world.mjs');
const { CREATURE_TUNING: T } = await import('../../../game/sim/creature/creature-brain.ts');
const { NOISE } = await import('../../../game/sim/noise/noise-scale.ts');

// The brain's `gaze` is where the head looks (the host turns it into a look-at). It follows what the creature has HEARD, never a
// player it has not.

test('it looks at the last sound it took up: drifting to a faint one, trotting to a loud one, running to a very loud one', () => {
  for (const [loudness, behaviour, error] of [[NOISE.crouchStep + .1, 'drift', T.errorFaint], [NOISE.talk, 'trot', T.errorLoud], [NOISE.generator, 'run', T.errorVeryLoud]]) {
    const w = world();
    w.brain.hear({ loudness, source: 'test', x: 12, z: 0 });
    const seen = w.run(1.5, { move: false });
    assert.equal(seen.out.behaviour, behaviour);
    assert.ok(seen.out.gaze, `${behaviour}: it has somewhere to look`);
    assert.ok(Math.hypot(seen.out.gaze.x - 12, seen.out.gaze.z) <= error + 1e-9, `${behaviour}: at the sound (${seen.out.gaze.x.toFixed(1)}, ${seen.out.gaze.z.toFixed(1)})`);
  }
});

test('it keeps looking toward the sound as it goes there, and a second noise turns its face to that one', () => {
  const w = world();
  w.brain.hear({ loudness: NOISE.talk, source: 'a', x: 40, z: 0 });
  let out = w.run(2).out;
  assert.ok(Math.abs(out.gaze.x - 40) <= T.errorLoud + 1e-9);
  w.brain.hear({ loudness: NOISE.talk, source: 'b', x: w.self.x, z: 30 });
  out = w.run(.2).out;
  assert.ok(Math.abs(out.gaze.z - 30) <= T.errorLoud + 1e-9, 'it looks at the new place');
});

test('searching, its head sweeps either side of the way to the last sound', () => {
  const w = world();
  w.brain.hear({ loudness: NOISE.talk, source: 'a', x: 0, z: 20 });
  w.run(20);
  assert.equal(w.brain.behaviour, 'search');
  const toLead = Math.atan2(w.brain.inspect().lead.x - w.self.x, w.brain.inspect().lead.z - w.self.z);
  const bearings = [];
  for (let i = 0; i < 160; i++) { const g = w.step({ move: false }).gaze; bearings.push(Math.atan2(g.x - w.self.x, g.z - w.self.z) - toLead); }
  const wrapped = bearings.map(b => Math.atan2(Math.sin(b), Math.cos(b)));
  assert.ok(Math.min(...wrapped) < -.9 && Math.max(...wrapped) > .9, `sweeps both sides (${Math.min(...wrapped).toFixed(2)} .. ${Math.max(...wrapped).toFixed(2)})`);
  assert.ok(Math.max(...wrapped.map(Math.abs)) < 1.4, 'about the sound, not round the back');
});

test('within 3 m it hears the breath and its face finds it: the gaze is the player\'s own place', () => {
  const w = world();
  w.player = { x: 2, y: 0, z: 0 };
  // (Its head is not within reach of them here: this is about where it looks, and the catch has its own tests.)
  const out = w.run(.5, { move: false, reach: Infinity }).out;
  assert.equal(w.brain.inspect().breathing, true);
  assert.ok(Math.hypot(out.gaze.x - 2, out.gaze.z) < 1e-9, 'exactly at them');
  assert.ok(out.gaze.y > 1 && out.gaze.y < 2, 'at head height');
});

test('with the breath held, a player at 2 m is not looked at: it has heard nothing', () => {
  const w = world();
  w.player = { x: 2, y: 0, z: 0, breathHeld: true };
  let nearest = Infinity;
  for (let i = 0; i < 400; i++) { const g = w.step({ move: false }).gaze; if (g) nearest = Math.min(nearest, Math.hypot(g.x - 2, g.z)); }
  assert.equal(w.brain.inspect().breathing, false);
  assert.ok(nearest > 3, `never at the player (closest ${nearest.toFixed(1)} m)`);
});

test('it never looks at a silent player it has not heard: not while it wanders, drifts, trots, runs or searches somewhere else', () => {
  const w = world({ round: () => [{ x: -40, z: -40 }, { x: -60, z: 10 }] });
  w.player = { x: 12, y: 0, z: 0 };   // out of breath range (3 m), and silent
  let nearest = Infinity;
  const look = o => { const out = w.step(o), g = out.gaze; if (g) nearest = Math.min(nearest, Math.hypot(g.x - 12, g.z)); };
  for (let i = 0; i < 200; i++) look();   // the round
  for (const loudness of [NOISE.crouchStep + .1, NOISE.talk, NOISE.generator]) {
    w.brain.hear({ loudness, source: 'elsewhere', x: -30, z: -20 });
    for (let i = 0; i < 400; i++) look();
  }
  assert.ok(nearest > 8, `the gaze never came within ${nearest.toFixed(1)} m of the silent player`);
  assert.equal(w.brain.inspect().perceived, 0);
});

test('the player\'s own noise is a sound like any other: it looks where it came from (which is where they are)', () => {
  const w = world();
  w.player = { x: 20, y: 0, z: 0 };
  w.brain.hear({ loudness: NOISE.walkStep, source: 'footstep', x: 20, z: 0 });
  const out = w.run(.5, { move: false }).out;
  assert.ok(Math.hypot(out.gaze.x - 20, out.gaze.z) <= T.errorLoud + 1e-9);
  // Then silence: the head stays on the place it heard, and does not follow the player as they walk off.
  w.player = percept({ x: 20, z: 40 });
  const later = w.run(3, { move: false }).out;
  assert.ok(Math.hypot(later.gaze.x - 20, later.gaze.z) <= T.errorLoud + 1e-9, 'still at the last sound, not at where the player went');
});
