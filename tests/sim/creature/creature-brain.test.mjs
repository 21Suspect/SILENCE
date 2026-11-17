import test from 'node:test';
import assert from 'node:assert/strict';
// The brain imports the noise scale and the stamina model with extensionless paths, which only the bundler (and this hook) resolves.
import '../../helpers/register-ts-hooks.mjs';
const {
  createCreatureBrain, createRandom, footstepLoudness, nightness, leaveHour, isNight, searchSeconds,
  FLASHLIGHT_CLICK_LOUDNESS, CREATURE_TUNING: T,
} = await import('../../../game/sim/creature/creature-brain.ts');
const { NOISE, footstepNoise, heardWithin } = await import('../../../game/sim/noise/noise-scale.ts');
const { STAMINA } = await import('../../../game/sim/player/stamina.ts');

const percept = (o = {}) => ({ x: 0, y: 0, z: 0, vx: 0, vz: 0, sprinting: false, crouching: false, flashlightOn: false, inWater: false, onLadder: false, indoors: false, ...o });
/** A round with nowhere to go: it stands where it is when it has nothing to follow. */
const STILL = () => [];
const NIGHT = 23.5, NOON = 12;

/**
 * A tiny stand-in for the host: the creature walks straight where the brain asks, at the speed it asks. Reach is the distance
 * from a head ~1.1 m ahead of the body to the player. `hours`, `day`, the beam and the player are whatever the test says.
 */
function world({ seed = 1, hours = NIGHT, day = 1, at = { x: 0, z: 0, yaw: 0 }, round = STILL, lair, places, tuning } = {}) {
  const brain = createCreatureBrain({ random: createRandom(seed), round, lair, places, tuning });
  const self = { ...at };
  let player = percept({ x: 500, z: 500 });
  const state = { hours, day };
  const step = (o = {}) => {
    const dt = o.dt ?? .05, d = Math.hypot(self.x - player.x, self.z - player.z);
    const out = brain.tick({
      dt, hours: o.hours ?? state.hours, day: o.day ?? state.day, weather: o.weather, creature: { ...self }, player,
      beamOnIt: o.beam ?? false, reach: o.reach ?? Math.max(0, d - 1.1),
    });
    const target = out.intent.target;
    if (o.move !== false && target && out.intent.speed > 0) {
      const dx = target.x - self.x, dz = target.z - self.z, l = Math.hypot(dx, dz);
      if (l > (out.intent.arrive ?? 1.2)) { const s = Math.min(l, out.intent.speed * dt); self.x += dx / l * s; self.z += dz / l * s; self.yaw = Math.atan2(dx, dz); }
    }
    return out;
  };
  /** Run for `seconds`; `o` may be a function of the time. Returns what happened. */
  const run = (seconds, o = {}) => {
    const events = [], behaviours = [];
    let out;
    for (let t = 0; t < seconds - 1e-9; t += o.dt ?? .05) {
      out = step(typeof o === 'function' ? o(t) : o);
      events.push(...out.events);
      if (behaviours[behaviours.length - 1] !== out.behaviour) behaviours.push(out.behaviour);
    }
    return { out, events, behaviours };
  };
  /** A noise `dx`, `dz` from where the creature is now, delivered to the next tick. */
  const noise = (loudness, dx, dz = 0, extra = {}) => brain.hear({ loudness, source: extra.source ?? 'test', x: self.x + dx, z: self.z + dz, sustained: extra.sustained });
  return { brain, self, step, run, noise, state, set player(p) { player = percept(p); }, get player() { return player; } };
}
const types = events => events.map(e => e.type);
const count = (events, type) => events.filter(e => e.type === type).length;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// --- The scale and the clock ------------------------------------------------------------------------------------

test('footstepLoudness is the noise scale\'s footstep: a sprint 45 m, a walk 22 m, a crouch 6 m, water loud', () => {
  for (const surface of ['road', 'dirt', 'forest', 'water']) for (const [sprinting, crouching] of [[false, false], [true, false], [false, true]]) {
    const o = { speed: 3.4, sprinting, crouching, surface };
    assert.equal(footstepLoudness(o), footstepNoise(o), `${surface} ${sprinting} ${crouching}`);
  }
  assert.equal(footstepLoudness({ speed: 0, sprinting: false, crouching: false, surface: 'road' }), 0);
  assert.ok(Math.abs(heardWithin(footstepLoudness({ speed: 5, sprinting: true, crouching: false, surface: 'dirt' })) - 45) < 1e-9);
  assert.equal(FLASHLIGHT_CLICK_LOUDNESS, NOISE.torchClick);
});

test('the clock: it leaves the lair at 19:00 on day 1 and half an hour earlier each day; its night ends at 05:30', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(d => leaveHour(d)), [19, 18.5, 18, 17.5, 17]);
  assert.equal(isNight(18.9, 1), false); assert.equal(isNight(19, 1), true);
  assert.equal(isNight(17.1, 5), true); assert.equal(isNight(17.1, 1), false);
  assert.equal(isNight(5.4, 1), true); assert.equal(isNight(5.6, 1), false); assert.equal(isNight(12, 3), false);
  assert.deepEqual([1, 2, 5].map(d => searchSeconds(d)), [20, 25, 40], 'searches 5 s longer each day');
  assert.ok(nightness(23.5) === 1 && nightness(12) === 0);
});

// --- Hearing: the noise scale, no falloff ----------------------------------------------------------------------

test('hearing is the scale: heard iff within the sound\'s own range, with no falloff and no chance', () => {
  // A door is heard within 22 m: at 21.9 m it is heard as strongly as at 1 m; at 22.1 not at all.
  for (const [d, heard] of [[1, true], [21.9, true], [22.1, false]]) {
    const w = world(); w.noise(NOISE.door, d);
    const { events } = w.run(.1);
    assert.equal(count(events, 'heard'), heard ? 1 : 0, `${d} m`);
    assert.equal(w.brain.behaviour === 'drift', heard, `${d} m`);
  }
});

test('hearing in rain: the same sound is heard half as far', () => {
  const a = world(); a.noise(NOISE.bell, 40); assert.equal(count(a.run(.1, { weather: 'still' }).events, 'heard'), 1);
  const b = world(); b.noise(NOISE.bell, 40); assert.equal(count(b.run(.1, { weather: 'rain' }).events, 'heard'), 0, 'a 70 m bell is 35 m in rain');
});

test('the grade is the sound\'s class, and a kept-up sound is very loud whatever its loudness', () => {
  const grade = (loudness, extra) => { const w = world(); w.noise(loudness, 5, 0, extra); return w.run(.1).events.find(e => e.type === 'heard').grade; };
  assert.equal(grade(NOISE.walkStep), 'faint'); assert.equal(grade(NOISE.sprintStep), 'loud'); assert.equal(grade(NOISE.generator), 'veryLoud');
  assert.equal(grade(NOISE.walkStep, { sustained: true }), 'veryLoud');
});

test('the place it makes of a noise is blurred, more for a faint one: a few metres; a loud one about right', () => {
  const errors = { faint: 0, loud: 0, veryLoud: 0 };
  for (let seed = 1; seed <= 40; seed++) for (const [grade, loudness] of [['faint', .2], ['loud', .5], ['veryLoud', 1.5]]) {
    const w = world({ seed }); w.noise(loudness, 15, 0); w.run(.1);
    errors[grade] = Math.max(errors[grade], dist(w.brain.inspect().lead, { x: 15, z: 0 }));
  }
  assert.ok(errors.faint <= T.errorFaint + 1e-9 && errors.faint > 1.5, `faint ${errors.faint.toFixed(2)} m`);
  assert.ok(errors.loud <= T.errorLoud + 1e-9, `loud ${errors.loud.toFixed(2)} m`);
  assert.ok(errors.veryLoud <= T.errorVeryLoud + 1e-9);
});

// --- The three grades -------------------------------------------------------------------------------------------

test('faint: it stops, turns toward the sound, drifts at 1.2 m/s; ten seconds of silence and it loses interest', () => {
  const w = world(); w.noise(NOISE.walkStep, 15, 0);
  let out = w.step();
  assert.equal(out.behaviour, 'drift');
  assert.equal(out.intent.speed, 0, 'stopped to turn');
  assert.ok(out.gaze.x > 10 && Math.abs(out.gaze.z) < 4, 'head toward the sound');
  assert.ok(!types(out.events).includes('call'), 'a faint noise is not worth a call');
  const turned = w.run(T.faintTurn + .1).out;
  assert.equal(turned.intent.speed, T.faintSpeed);
  const x0 = w.self.x; w.run(3);
  assert.ok(Math.abs((w.self.x - x0) / 3 - T.faintSpeed) < .05, 'drifting slowly toward it');
  assert.equal(w.brain.behaviour, 'drift');
  // 10 s after the sound (it was last heard at t = 0.05) it gives up.
  const r = w.run(T.faintForget);
  assert.equal(w.brain.behaviour, 'round', `lost interest (${r.behaviours})`);
  assert.ok(w.brain.inspect().clock > T.faintForget);
});

test('faint: a drifting creature holds on while sounds keep coming, and only the silence counts', () => {
  const w = world(); w.noise(NOISE.walkStep, 20, 0); w.run(1);
  for (let i = 0; i < 4; i++) { w.run(6); w.noise(NOISE.walkStep, 20, 0); }
  assert.equal(w.brain.behaviour, 'drift', 'never ten quiet seconds');
  w.run(T.faintForget - .5); assert.equal(w.brain.behaviour, 'drift');
  w.run(1); assert.equal(w.brain.behaviour, 'round');
});

test('loud: it calls once, trots at 4 m/s to the spot, searches it for 20 s listening, then goes back to its round', () => {
  const w = world(); w.noise(NOISE.bell, 60, 0);
  const first = w.step();
  assert.equal(first.behaviour, 'trot'); assert.equal(count(first.events, 'call'), 1, 'one call as it takes the noise up');
  assert.equal(first.intent.speed, T.trotSpeed);
  assert.ok(first.intent.speed < STAMINA.sprintSpeed && first.intent.speed > STAMINA.walkSpeed, 'between a walk and a sprint');
  const r = w.run(30);
  assert.equal(count(r.events, 'call'), 0, 'the call is once');
  assert.deepEqual(r.behaviours.slice(0, 2), ['trot', 'search']);
  const searchStart = w.brain.inspect().clock;
  assert.ok(dist(w.self, { x: 60, z: 0 }) <= T.trotArrive + T.errorLoud + .1, 'at the spot');
  // It searched for 20 s: from arrival (about 15 s in) to 35 s, then it is on its round again.
  const more = w.run(10);
  assert.ok(searchStart > 30 && w.brain.behaviour === 'round', `searched and moved on (${more.behaviours})`);
});

test('loud: the search lasts searchSeconds from arrival, with clicks every few seconds while it listens', () => {
    const v = world(); v.noise(NOISE.bell, 12, 0);
  let t = 0, searching = 0, clicks = [], inSearch = false, searchedFor = 0;
  for (; t < 40; t += .02) {
    const o = v.step({ dt: .02 });
    if (o.behaviour === 'search') { searching += .02; inSearch = true; for (const e of o.events) if (e.type === 'clicks') clicks.push(searching); } else if (inSearch) { searchedFor = searching; break; }
  }
  assert.ok(Math.abs(searchedFor - T.searchSeconds) < .1, `searched ${searchedFor.toFixed(2)} s`);
  assert.ok(clicks.length >= 3 && clicks.length <= 6, `${clicks.length} clicks`);
  assert.ok(clicks[0] >= T.clicksFirst - .05 && clicks[0] < T.clicksFirst + .1, 'the first soon after it arrives');
  for (let i = 1; i < clicks.length; i++) { const gap = clicks[i] - clicks[i - 1]; assert.ok(gap >= T.clicksEvery[0] - .05 && gap <= T.clicksEvery[1] + .05, `gap ${gap.toFixed(2)}`); }
});

test('very loud: it runs at twice the player\'s sprint (11.2 m/s) and stays at the source while it keeps sounding; then it searches there', () => {
  const w = world(); w.noise(NOISE.generator, 120, 0);
  const first = w.step();
  assert.equal(first.behaviour, 'run'); assert.equal(count(first.events, 'call'), 1);
  assert.equal(first.intent.speed, 2 * STAMINA.sprintSpeed); assert.ok(Math.abs(first.intent.speed - 11.2) < 1e-9);
  // It gets there in about 11 s, and stays while the hum goes on (a repeat every 7 s).
  let behaviours = new Set();
  for (let i = 0; i < 6; i++) { const r = w.run(7); r.behaviours.forEach(b => behaviours.add(b)); w.noise(NOISE.generator, 120 - w.self.x, 0, { sustained: true }); }
  assert.equal(w.brain.behaviour, 'run', 'still there, still listening to it');
  assert.ok(!behaviours.has('search'));
  assert.ok(dist(w.self, { x: 120, z: 0 }) < 2, 'at the source');
  assert.ok(w.run(1).out.intent.speed === 0 || w.brain.behaviour === 'run');
  // The sound stops: after stayQuiet it begins to search there, 20 s, then its round.
  const r = w.run(T.stayQuiet + 1);
  assert.equal(w.brain.behaviour, 'search');
  assert.equal(w.run(T.searchSeconds + .5).out.behaviour, 'round');
  assert.ok(r.behaviours.includes('search'));
});

test('very loud by being kept up: a faint sound flagged sustained is run to', () => {
  const w = world(); w.noise(NOISE.walkStep, 20, 0, { sustained: true });
  const out = w.step(); assert.equal(out.behaviour, 'run'); assert.equal(out.intent.speed, 11.2);
});

// --- Redirecting ------------------------------------------------------------------------------------------------

test('a second noise of the same or a louder grade always redirects it: this is how a player leads it away', () => {
  const w = world(); w.noise(NOISE.bell, 60, 0); w.run(2);
  assert.equal(w.brain.behaviour, 'trot'); assert.ok(w.brain.inspect().target.x > 50);
  // An equal one, behind it and farther than the first: it turns on its heel, and does not call again.
  w.noise(NOISE.bell, -40 - w.self.x, 0);
  const r = w.run(.2);
  assert.ok(w.brain.inspect().target.x < -30, 'now going the other way');
  assert.equal(count(r.events, 'call'), 0, 'already calling: no second call');
  // A louder one (very loud) takes over from a loud one and it runs.
  w.noise(NOISE.generator, 50 - w.self.x, 0); w.run(.1);
  assert.equal(w.brain.behaviour, 'run'); assert.ok(w.brain.inspect().target.x > 40);
});

test('a fainter noise redirects only if it is nearer to the creature than the current target', () => {
  const w = world(); w.noise(NOISE.bell, 60, 0); w.run(.5);
  w.noise(NOISE.walkStep, 0, 21); // 21 m away, but the target is ~58 m: nearer
  w.run(.1);
  assert.equal(w.brain.behaviour, 'drift', 'a nearer faint sound is taken up');
  assert.ok(Math.abs(w.brain.inspect().target.z - 21) <= T.errorFaint + .01);
  // Loud target near, faint noise farther than it: ignored.
  const v = world(); v.noise(NOISE.bell, 20, 0); v.run(.1);
  v.noise(NOISE.walkStep, 0, -21); // 21 m, target ~20 m: not nearer
  v.run(.1);
  assert.equal(v.brain.behaviour, 'trot', 'a fainter, farther sound is ignored');
  assert.ok(v.brain.inspect().target.x > 15, 'and it carries on to the loud one');
});

test('searching, it still turns to a faint sound close beside it (within 8 m), not to one farther off', () => {
  const w = world(); w.noise(NOISE.bell, 6, 0); w.run(6);
  assert.equal(w.brain.behaviour, 'search');
  w.noise(NOISE.walkStep, 0, 15); w.run(.1);
  assert.equal(w.brain.behaviour, 'search', '15 m off: ignored');
  w.noise(NOISE.walkStep, 0, T.redirectNear - 2); w.run(.1);
  assert.equal(w.brain.behaviour, 'drift', 'close beside it: it turns');
  assert.equal(w.brain.inspect().response, 0);
});

test('a faint sound upgraded by a loud one: it calls then (it took up a loud noise), not before', () => {
  const w = world(); w.noise(NOISE.walkStep, 10, 0); assert.equal(count(w.run(.1).events, 'call'), 0);
  w.noise(NOISE.bell, 30, 0); assert.equal(count(w.run(.1).events, 'call'), 1);
});

// --- Breathing and the catch ------------------------------------------------------------------------------------

test('breathing: within 3 m it hears the player breathe, unless the breath is held', () => {
  const near = world(); near.player = { x: 2.9, z: 0 };
  let out = near.step({ reach: 5 });
  assert.equal(out.perceives, true); assert.equal(out.behaviour, 'drift', 'it turns to the sound');
  assert.ok(dist(near.brain.inspect().lead, { x: 2.9, z: 0 }) < 1e-9, 'exactly where they are');
  const far = world(); far.player = { x: 3.2, z: 0 };
  assert.equal(far.step({ reach: 5 }).perceives, false, 'not past 3 m');
  const held = world(); held.player = { x: 2, z: 0, breathHeld: true };
  const r = held.run(5, { reach: 5 });
  assert.equal(r.out.perceives, false); assert.ok(!r.behaviours.includes('drift'));
});

test('the catch: it strikes only within reach of a player it perceives right now', () => {
  // Someone walking beside it makes a noise it hears: caught.
  const w = world(); w.player = { x: 2, z: 0, breathHeld: true };
  w.noise(NOISE.walkStep, 2, 0);
  const out = w.step({ reach: 1.5 });
  assert.equal(out.behaviour, 'strike'); assert.ok(types(out.events).includes('strike')); assert.equal(count(out.events, 'strike'), 1);
  assert.equal(w.step({ reach: 1.5 }).events.filter(e => e.type === 'strike').length, 0, 'one strike');
  // Out of reach: no strike however much noise.
  const far = world(); far.player = { x: 5, z: 0, breathHeld: true }; far.noise(NOISE.walkStep, 5, 0);
  assert.notEqual(far.step({ reach: 3 }).behaviour, 'strike');
  // In reach but silent (breath held, standing still): passed by.
  const still = world(); still.player = { x: 1, z: 0, breathHeld: true };
  const r = still.run(10, { reach: 1 });
  assert.ok(!r.behaviours.includes('strike'), 'holding their breath, it walks right past');
});

test('the catch: a noise keeps the player perceived for 1.5 s, and no longer', () => {
  const w = world(); w.player = { x: 2, z: 0, breathHeld: true }; w.noise(NOISE.walkStep, 2, 0);
  w.step({ reach: 9 });
  assert.equal(w.step({ reach: 9 }).perceives, true);
  w.run(T.catchWindow - .15, { reach: 9 }); assert.equal(w.step({ reach: 9 }).perceives, true, 'still within 1.5 s');
  w.run(.3, { reach: 9 }); assert.equal(w.step({ reach: 9 }).perceives, false, 'past it');
  // A sprinting player\'s footfalls keep it perceived: caught after running past.
  const s = world(); s.player = { x: 3, z: 0, breathHeld: true };
  const r = s.run(3, t => { if (Math.abs(t % .4) < .05) s.noise(NOISE.sprintStep, 3, 0); return { reach: t < 2 ? 9 : 1.5 }; });
  assert.ok(r.behaviours.includes('strike'), 'running, noisy, in reach');
});

test('a noise elsewhere (a generator) does not make the player perceived', () => {
  const w = world(); w.player = { x: 1, z: 0, breathHeld: true }; w.noise(NOISE.generator, 50, 0, { sustained: true });
  const r = w.run(1, { reach: 1 }); assert.equal(r.out.perceives, false); assert.ok(!r.behaviours.includes('strike'));
});

test('an untouchable player is neither heard breathing nor caught', () => {
  const w = world(); w.player = { x: 1, z: 0, untouchable: true }; w.noise(NOISE.walkStep, 1, 0);
  const r = w.run(2, { reach: 1 }); assert.ok(!r.behaviours.includes('strike')); assert.equal(r.out.perceives, false);
});

// --- The lair, sleep and waking --------------------------------------------------------------------------------

test('by day it sleeps in the lair: asleep, motionless, deaf to faint noises and to loud ones far from the lair', () => {
  const w = world({ hours: NOON, lair: { x: 0, z: 0 } });
  const out = w.step(); assert.equal(out.behaviour, 'asleep'); assert.equal(out.intent.speed, 0); assert.equal(out.asleep, true);
  w.noise(NOISE.door, 3); w.noise(NOISE.sprintStep, 80, 0); // faint; loud 80 m off (heard, > 60 m from the lair)
  const r = w.run(5); assert.equal(w.brain.behaviour, 'asleep'); assert.equal(count(r.events, 'wake'), 0);
  w.player = { x: 1, z: 0 }; const b = w.run(5, { reach: .5 });
  assert.equal(b.out.perceives, false, 'it cannot catch what it sleeps through'); assert.ok(!b.behaviours.includes('strike'));
});

test('asleep: a very loud noise wakes it anywhere it is heard; a loud one within 60 m of the lair', () => {
  const veryLoud = world({ hours: NOON, lair: { x: 0, z: 0 } }); veryLoud.noise(NOISE.generator, 140, 0);
  const a = veryLoud.run(.2);
  assert.ok(types(a.events).includes('wake')); assert.equal(veryLoud.brain.behaviour, 'run');
  const sustained = world({ hours: NOON, lair: { x: 0, z: 0 } }); sustained.noise(NOISE.walkStep, 10, 0, { sustained: true });
  assert.ok(types(sustained.run(.2).events).includes('wake'), 'kept up counts as very loud');
  const near = world({ hours: NOON, lair: { x: 0, z: 0 } }); near.noise(NOISE.bell, 55, 0);
  assert.ok(types(near.run(.2).events).includes('wake')); assert.equal(near.brain.behaviour, 'trot');
  const far = world({ hours: NOON, lair: { x: 0, z: 0 } }); far.noise(NOISE.bell, 65, 0);
  assert.equal(count(far.run(.2).events, 'wake'), 0, 'a loud one 65 m away leaves it asleep'); assert.equal(far.brain.behaviour, 'asleep');
  // A faint one never wakes it, even beside it.
  const faint = world({ hours: NOON, lair: { x: 0, z: 0 } }); faint.noise(NOISE.walkStep, 1, 0);
  assert.equal(count(faint.run(.2).events, 'wake'), 0);
});

test('from day 4 it sleeps lightly: any loud noise it hears wakes it, even far from the lair', () => {
  for (const [day, wakes] of [[1, false], [3, false], [4, true], [5, true]]) {
    const w = world({ hours: NOON, day, lair: { x: 0, z: 0 } }); w.noise(NOISE.bell, 65, 0);
    assert.equal(types(w.run(.2).events).includes('wake'), wakes, `day ${day}`);
  }
  const w = world({ hours: NOON, day: 4, lair: { x: 0, z: 0 } }); w.noise(NOISE.walkStep, 5, 0);
  assert.equal(count(w.run(.2).events, 'wake'), 0, 'still not a faint one');
});

test('woken by day it deals with the noise, then goes back to sleep after 90 s of quiet', () => {
  const w = world({ hours: NOON, lair: { x: 0, z: 0 } }); w.noise(NOISE.bell, 40, 0);
  const r = w.run(400, { dt: .1 });
  assert.deepEqual(r.behaviours.slice(0, 3), ['trot', 'search', 'wait']);
  assert.deepEqual(r.behaviours.slice(-2), ['return', 'asleep']);
  assert.equal(count(r.events, 'wake'), 1); assert.equal(count(r.events, 'sleep'), 1);
  assert.ok(dist(w.self, { x: 0, z: 0 }) < T.lairArrive, 'back in the lair');
  // It did not give up before the quiet was up: it set off home no sooner than 90 s after the noise.
  const v = world({ hours: NOON, lair: { x: 0, z: 0 } }); v.noise(NOISE.bell, 40, 0);
  let leftAt = -1; for (let t = 0; t < 300 && leftAt < 0; t += .1) { if (v.step({ dt: .1 }).behaviour === 'return') leftAt = t; }
  assert.ok(leftAt >= T.sleepQuiet - .2 && leftAt < T.sleepQuiet + 1, `set off home at ${leftAt.toFixed(1)} s`);
});

test('woken by day, a new noise while it walks home starts it again, and the 90 s run from that sound', () => {
  const w = world({ hours: NOON, lair: { x: 0, z: 0 } }); w.noise(NOISE.bell, 40, 0); w.run(95, { dt: .1 });
  assert.ok(['return', 'wait'].includes(w.brain.behaviour));
  w.noise(NOISE.bell, 20, 20); w.run(.2);
  assert.equal(w.brain.behaviour, 'trot'); const r = w.run(200, { dt: .1 });
  assert.equal(r.behaviours.at(-1), 'asleep');
});

// --- Dusk, dawn and the round ----------------------------------------------------------------------------------

test('dusk: it sleeps until the hour of the day, then wakes and leaves; earlier each day', () => {
  for (const [day, hour] of [[1, 19], [3, 18], [5, 17]]) {
    const w = world({ hours: hour - .3, day, lair: { x: 0, z: 0 } });
    assert.equal(w.run(.5).out.behaviour, 'asleep', `day ${day} before ${hour}`);
    const r = w.run(.5, { hours: hour + .01 });
    assert.ok(types(r.events).includes('wake') && w.brain.behaviour !== 'asleep', `day ${day} at ${hour}:00`);
  }
  // The same hour on day 1 it is still asleep; on day 5 it is out.
  const d1 = world({ hours: 17.5, day: 1, lair: { x: 0, z: 0 } }), d5 = world({ hours: 17.5, day: 5, lair: { x: 0, z: 0 } });
  assert.equal(d1.run(1).out.behaviour, 'asleep'); assert.notEqual(d5.run(1).out.behaviour, 'asleep');
});

test('dawn: at 05:30 it walks home from wherever it is and is asleep by day', () => {
  const w = world({ hours: 5.3, lair: { x: 0, z: 0 }, at: { x: 200, z: 0, yaw: 0 } });
  w.run(1); assert.notEqual(w.brain.behaviour, 'return');
  const r = w.run(80, { hours: 5.7, dt: .1 });
  assert.equal(r.behaviours[0], 'return'); assert.equal(w.brain.behaviour, 'asleep');
  assert.equal(count(r.events, 'sleep'), 1); assert.ok(dist(w.self, { x: 0, z: 0 }) <= T.lairArrive);
  assert.equal(r.out.intent.speed, 0);
});

test('dawn ends a search or a drift and sends it home; a catch in progress is not interrupted', () => {
  const w = world({ hours: 5.2, lair: { x: 0, z: 0 }, at: { x: 50, z: 0, yaw: 0 } }); w.noise(NOISE.bell, 30, 0); w.run(1);
  assert.equal(w.brain.behaviour, 'trot');
  assert.equal(w.run(.2, { hours: 5.6 }).out.behaviour, 'return');
  const s = world({ hours: 5.2 }); s.player = { x: 1, z: 0 }; s.noise(NOISE.walkStep, 1, 0);
  assert.equal(s.run(.1, { reach: .5 }).out.behaviour, 'strike');
  assert.equal(s.run(.1, { hours: 5.6, reach: .5 }).out.behaviour, 'strike');
});

test('a creature with a given lair starts the day walking home, and by night starts its round', () => {
  const day = world({ hours: NOON, lair: { x: 100, z: 0 }, at: { x: 0, z: 0, yaw: 0 } });
  assert.equal(day.step().behaviour, 'return');
  const night = world({ hours: NIGHT, lair: { x: 100, z: 0 }, at: { x: 0, z: 0, yaw: 0 } });
  assert.equal(night.step().behaviour, 'round');
  assert.deepEqual(night.brain.lair, { x: 100, z: 0 });
  const dflt = world({ hours: NOON, at: { x: 7, z: 9, yaw: 0 } }); dflt.step();
  assert.deepEqual(dflt.brain.lair, { x: 7, z: 9 }, 'by default the lair is where it first stands');
  assert.equal(dflt.brain.behaviour, 'asleep');
});

test('the night starts at the loudest place of the day, then the round from the provider, a pause at each', () => {
  const calls = []; const points = [{ x: 150, z: 60 }, { x: -80, z: 100 }];
  const w = world({ hours: 18.9, lair: { x: 0, z: 0 }, round: () => { calls.push(1); return points; } });
  w.brain.dusk({ x: 100, z: -40 });
  assert.equal(w.run(1).out.behaviour, 'asleep');
  const wake = w.run(.2, { hours: 19.1 });
  assert.ok(types(wake.events).includes('wake'));
  assert.equal(w.brain.behaviour, 'trot'); assert.equal(count(wake.events, 'call'), 0, 'it did not hear a thing: no call');
  assert.deepEqual(w.brain.inspect().target, { x: 100, z: -40 });
  assert.equal(w.brain.inspect().pendingStart, undefined, 'taken up once');
  const r = w.run(120, { hours: 19.5, dt: .1 });
  assert.deepEqual(r.behaviours.slice(0, 3), ['trot', 'search', 'round'], 'it goes there, searches it, then the round');
  assert.ok(calls.length >= 1, 'the provider was asked for the round');
  // It then visits the points in order.
  const visited = []; const v = world({ hours: NIGHT, lair: { x: 0, z: 0 }, round: () => points });
  for (let t = 0; t < 300; t += .1) { v.step({ dt: .1 }); for (const [i, q] of points.entries()) if (dist(v.self, q) < 5 && !visited.includes(i)) visited.push(i); }
  assert.deepEqual(visited, [0, 1], 'in the provider\'s order');
});

test('dusk(null) clears a start; dusk given at night to an idle creature sends it at once; the provider is asked again when the round ends', () => {
  const w = world({ hours: NIGHT, round: STILL }); w.run(1); w.brain.dusk({ x: 40, z: 0 }); const r = w.run(.2);
  assert.equal(w.brain.behaviour, 'trot'); assert.ok(types(r.events).includes('behaviour'));
  const n = world({ hours: NIGHT, round: STILL }); n.brain.dusk({ x: 40, z: 0 }); n.brain.dusk(null); n.run(1);
  assert.equal(n.brain.behaviour, 'round');
  let asked = 0; const m = world({ hours: NIGHT, round: () => { asked++; return [{ x: 30, z: 0 }]; } });
  m.run(120, { dt: .1 }); assert.ok(asked >= 3, `asked ${asked} times`);
});

test('without a provider the round is its places in a shuffled order, or points around the lair', () => {
  const places = [{ x: 100, z: 0 }, { x: 0, z: 100 }, { x: -100, z: 0 }];
  const w = world({ round: null, places, hours: NIGHT }); w.step({ dt: .1 });
  const goal = w.brain.inspect().roundGoal; assert.ok(places.some(p => dist(p, goal) <= 13), 'one of its places');
  const none = world({ round: null, hours: NIGHT, lair: { x: 0, z: 0 } }); none.step();
  const g = dist(none.brain.inspect().roundGoal, { x: 0, z: 0 }); assert.ok(g >= T.roundRadius[0] - 1e-6 && g <= T.roundRadius[1] + 1e-6, `${g.toFixed(0)} m from the lair`);
});

// --- Worse each day --------------------------------------------------------------------------------------------

test('worse each day: it searches 5 s longer each day', () => {
  const searched = day => {
    const w = world({ day }); w.noise(NOISE.bell, 10, 0); let n = 0;
    for (let t = 0; t < 80; t += .05) { const o = w.step(); if (o.behaviour === 'search') n += .05; else if (n > 0) break; }
    return n;
  };
  for (const day of [1, 2, 3, 5]) assert.ok(Math.abs(searched(day) - (20 + 5 * (day - 1))) < .2, `day ${day}`);
});

// --- Light holds it --------------------------------------------------------------------------------------------

test('the torch: pinned for .35 s it slows to a halt, is held 3.2 s, then gets going again; shorter each use', () => {
  const w = world(); w.noise(.95, 90, 0); w.run(2);
  assert.equal(w.brain.behaviour, 'trot'); assert.ok(w.self.x > 1);
  const r = w.run(.6, { beam: true });
  assert.ok(types(r.events).includes('flinch'), 'pinned');
  assert.equal(w.brain.inspect().flinch.phase, 'slowing');
  const held = w.run(.7, { beam: true }); assert.equal(held.out.stun.phase, 'held'); assert.equal(held.out.intent.speed, 0); assert.ok(held.out.flinching);
  const x = w.self.x; w.run(2, { beam: true }); assert.ok(Math.abs(w.self.x - x) < .05, 'held still');
  const starting = w.run(1.5, { beam: true });
  assert.ok(starting.events.some(e => e.type === 'stun' && e.phase === 'starting' && Math.abs(e.seconds - 3.2) < .06), 'held 3.2 s');
  const over = w.run(3);
  assert.ok(over.events.some(e => e.type === 'stun' && e.phase === 'over')); assert.ok(w.self.x > x + 1, 'on its way again');
  // The second pin holds it a little less.
  w.run(T.stunGrace + .1); const again = w.run(8, { beam: true });
  const second = again.events.find(e => e.type === 'stun' && e.phase === 'starting'); assert.ok(second && Math.abs(second.seconds - 2.6) < .06, `second hold ${second?.seconds}`);
});

test('a stunned creature cannot strike; asleep it cannot be stunned', () => {
  const w = world(); w.player = { x: 1, z: 0, breathHeld: true }; w.noise(NOISE.walkStep, 1, 0);
  w.run(.1, { reach: 9 }); w.noise(NOISE.walkStep, 1, 0);
  const r = w.run(.6, { beam: true, reach: 9 });
  assert.ok(types(r.events).includes('flinch'));
  w.noise(NOISE.walkStep, 1, 0); assert.notEqual(w.step({ reach: .5 }).behaviour, 'strike', 'held by the light');
  const s = world({ hours: NOON, lair: { x: 0, z: 0 } }); const z = s.run(2, { beam: true });
  assert.ok(!types(z.events).includes('flinch'));
});

// --- Dev tools -------------------------------------------------------------------------------------------------

test('provoke: it knows exactly where the player is, runs at them, and catches them even asleep by day', () => {
  const w = world({ hours: NOON, lair: { x: 0, z: 0 } }); w.player = { x: 60, z: 0 };
  w.run(1); w.brain.provoke();
  const r = w.run(10, { dt: .1 });
  assert.ok(types(r.events).includes('wake')); assert.ok(r.behaviours.includes('run'));
  assert.equal(r.behaviours.at(-1), 'strike', `caught (${r.behaviours})`);
});

test('alert: a loud noise handed to it, no call; it wakes it; dismiss and forget drop it', () => {
  const w = world({ hours: NOON, lair: { x: 0, z: 0 } }); w.brain.alert({ x: 30, z: 0 }, 6); const r = w.run(.2);
  assert.ok(types(r.events).includes('wake')); assert.equal(count(r.events, 'call'), 0); assert.equal(w.brain.behaviour, 'trot');
  w.brain.dismiss(); w.run(.2); assert.equal(w.brain.inspect().lead, undefined); assert.notEqual(w.brain.behaviour, 'trot');
  const n = world(); n.noise(NOISE.bell, 40, 0); n.run(.2); n.brain.forget(); n.run(.2);
  assert.equal(n.brain.behaviour, 'round'); assert.equal(n.brain.inspect().target, undefined);
});

test('struck and reset: after a catch it forgets and starts over; force runs a behaviour; unknown ones throw', () => {
  // (Breath held, so only the noise made it perceive them.)
  const w = world(); w.player = { x: 1, z: 0, breathHeld: true }; w.noise(NOISE.walkStep, 1, 0);
  assert.equal(w.run(.1, { reach: .5 }).out.behaviour, 'strike');
  w.brain.struck(); w.run(.2); assert.equal(w.brain.behaviour, 'round');
  w.noise(NOISE.bell, 30, 0); w.run(.2); w.brain.reset(); w.run(.1);
  assert.equal(w.brain.behaviour, 'round'); assert.equal(w.brain.inspect().lead, undefined);
  w.brain.force('search'); assert.equal(w.brain.behaviour, 'search');
  assert.throws(() => w.brain.force('hunt'), /Unknown creature behaviour/);
});

test('blind: nothing the player does in plain view matters, only what it hears', () => {
  // Torch on, sprinting in the open 10 m away, in full view: but silent (no noise events), so nothing.
  const w = world(); w.player = { x: 10, z: 0, flashlightOn: true, sprinting: true, vx: 5, vz: 0, breathHeld: true };
  const r = w.run(30, { reach: 8.9 });
  assert.deepEqual([...new Set(r.behaviours)], ['round']);
  assert.equal(w.brain.inspect().lead, undefined);
});

// --- Determinism and frame rate --------------------------------------------------------------------------------

test('determinism: the same seed and the same inputs give the same night', () => {
  const play = seed => {
    const w = world({ seed, hours: 18.9, lair: { x: 0, z: 0 }, places: [{ x: 90, z: 40 }, { x: -70, z: 120 }, { x: 10, z: -150 }] }), log = [];
    w.brain.dusk({ x: 60, z: 30 });
    for (let i = 0; i < 4000; i++) {
      if (i % 300 === 50) w.noise(i % 600 === 50 ? NOISE.bell : NOISE.walkStep, 20 + (i % 7), -10);
      const o = w.step({ dt: .05, hours: 18.9 + i * .05 / 3600 * 4 });
      log.push(JSON.stringify([o.behaviour, +w.self.x.toFixed(6), +w.self.z.toFixed(6), o.events.map(e => e.type)]));
    }
    return log.join('\n');
  };
  assert.equal(play(5), play(5)); assert.notEqual(play(5), play(6));
});

test('frame rate does not matter: 20 and 60 frames a second reach the same places at the same times', () => {
  const play = dt => {
    const w = world({ hours: NOON, lair: { x: 0, z: 0 }, seed: 3 }); const log = [];
    let t = 0; const at = [[1, () => w.noise(NOISE.bell, 40, 0)], [60, () => w.noise(NOISE.walkStep, 0, 30)]];
    let prev = '';
    for (let i = 0; t < 300; i++) {
      for (const [when, f] of at) if (Math.abs(t - when) < dt / 2) f();
      const o = w.step({ dt }); t += dt;
      if (o.behaviour !== prev) { log.push([o.behaviour, t]); prev = o.behaviour; }
    }
    return log;
  };
  const a = play(1 / 20), b = play(1 / 60);
  assert.deepEqual(a.map(x => x[0]), b.map(x => x[0]));
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i][1] - b[i][1]) < .4, `${a[i][0]} at ${a[i][1].toFixed(2)} vs ${b[i][1].toFixed(2)}`);
});

test('a long frame (a hitch) is clamped, not allowed to skip a search', () => {
  const w = world(); w.noise(NOISE.bell, 10, 0); w.step({ dt: 5 });
  assert.ok(w.brain.inspect().clock <= .25 + 1e-9);
});
