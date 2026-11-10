import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCreatureBrain, createRandom, hearingStrength, footstepLoudness, sightRange, baseBoldness, nightness,
  FLASHLIGHT_CLICK_LOUDNESS, CREATURE_TUNING as T,
} from '../game/creature-brain.ts';
import { initialLives, loseLife, respawnHours, deathCard, grabTimeline, GRAB, LIVES, RESPAWN_ADVANCE_HOURS } from '../game/lives.ts';

const percept = (o = {}) => ({ x: 0, y: 0, z: 0, vx: 0, vz: 0, sprinting: false, crouching: false, flashlightOn: false, inWater: false, onLadder: false, indoors: false, ...o });

/**
 * A tiny stand-in for the host: the creature walks straight where the brain asks; line of sight, the beam and the
 * player's position are whatever the test says. Reach is the distance from a head ~1.1 m ahead of the body.
 */
function world({ seed = 1, hours = 23.5, darkness = 1, at = { x: 0, z: 40, yaw: Math.PI }, places } = {}) {
  const brain = createCreatureBrain({ random: createRandom(seed), places });
  const self = { ...at };
  let player = percept();
  const step = (o = {}) => {
    const dt = o.dt ?? .05, d = Math.hypot(self.x - player.x, self.z - player.z);
    const out = brain.tick({
      dt, hours: o.hours ?? hours, darkness: o.darkness ?? darkness, creature: { ...self }, player,
      lineOfSight: o.los ?? false, playerLooking: o.looking ?? false, beamOnIt: o.beam ?? false, reach: o.reach ?? Math.max(0, d - 1.1),
    });
    const target = out.intent.target;
    if (o.move !== false && target && out.intent.speed > 0) {
      const dx = target.x - self.x, dz = target.z - self.z, l = Math.hypot(dx, dz);
      if (l > (out.intent.arrive ?? 1.2)) { const s = Math.min(l, out.intent.speed * dt); self.x += dx / l * s; self.z += dz / l * s; self.yaw = Math.atan2(dx, dz); }
    }
    return out;
  };
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
  return { brain, self, step, run, set player(p) { player = percept(p); }, get player() { return player; } };
}
const types = events => events.map(e => e.type);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// --- Senses ----------------------------------------------------------------------------------------------------

test('hearing: loudness carries ~100 m per unit and fades linearly with distance', () => {
  assert.equal(hearingStrength(1, 0), 1);
  assert.ok(hearingStrength(1, 30) > hearingStrength(1, 60) && hearingStrength(1, 60) > 0);
  assert.ok(hearingStrength(.95, 90) > 0, 'the generator starting is heard 90 m away');
  assert.equal(hearingStrength(.95, 96), 0);
  assert.equal(hearingStrength(FLASHLIGHT_CLICK_LOUDNESS, 8), 0, 'the torch switch only within a few metres');
  assert.ok(hearingStrength(FLASHLIGHT_CLICK_LOUDNESS, 4) > 0);
  assert.equal(hearingStrength(0, 1), 0);
});

test('footsteps: a crouch on the forest floor is nearly silent, a sprint on the road carries far', () => {
  const step = o => footstepLoudness({ speed: 1.8, sprinting: false, crouching: false, surface: 'dirt', ...o });
  const crouch = step({ speed: .95, crouching: true, surface: 'forest' }), walk = step({}), sprint = step({ speed: 3.35, sprinting: true }), sprintRoad = step({ speed: 3.35, sprinting: true, surface: 'road' });
  assert.ok(crouch < walk && walk < sprint && sprint < sprintRoad);
  assert.ok(crouch * T.hearingRange < 4, `crouching is heard within ${(crouch * T.hearingRange).toFixed(1)} m`);
  assert.ok(walk * T.hearingRange > 10 && walk * T.hearingRange < 20, 'a walk is heard at about a dozen metres');
  assert.ok(sprintRoad * T.hearingRange > 40, 'a sprint on the gravel road carries 40+ m');
  assert.ok(step({ surface: 'water' }) > walk, 'wading is louder');
  assert.equal(step({ speed: 0 }), 0, 'standing still makes no footsteps');
});

test('sight: long by day, short at night, a beacon with the torch on; crouching and stillness shrink it', () => {
  const base = { crouching: false, sprinting: false, moving: true, indoors: false };
  const day = sightRange({ ...base, darkness: 0, flashlightOn: false });
  const night = sightRange({ ...base, darkness: 1, flashlightOn: false });
  const torch = sightRange({ ...base, darkness: 1, flashlightOn: true });
  assert.ok(day > 3 * night, `day ${day} m vs night ${night} m`);
  assert.ok(torch > day, 'at night the torch is visible further than a person by day');
  assert.equal(sightRange({ ...base, darkness: 0, flashlightOn: true }), day, 'a torch in daylight changes nothing');
  const hidden = sightRange({ ...base, darkness: 1, flashlightOn: false, crouching: true, moving: false });
  assert.ok(hidden < night * .5, `crouched, still and dark: ${hidden.toFixed(1)} m`);
  assert.ok(sightRange({ ...base, darkness: 1, flashlightOn: true, indoors: true }) < torch * .5, 'walls and windows');
});

test('a heard noise becomes a lead near where it was made, vaguer the further away it was', () => {
  const error = distance => {
    let sum = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const w = world({ seed, hours: 17, darkness: .1, at: { x: 0, z: 0, yaw: 0 } });
      w.player = { x: 300, z: 300 };
      w.brain.hear({ loudness: .95, source: 'generator-start', x: distance, z: 0 });
      w.step({ move: false });
      const lead = w.brain.inspect().lead;
      assert.ok(lead && lead.kind === 'sound', 'heard');
      assert.ok(lead.uncertainty >= T.hearingError + distance * T.hearingErrorPerMetre);
      assert.ok(dist(lead, { x: distance, z: 0 }) <= lead.uncertainty + 1e-9);
      sum += dist(lead, { x: distance, z: 0 });
    }
    return sum / 40;
  };
  assert.ok(error(80) > error(10) * 2, 'far noises are placed less precisely');
  const deaf = world({ at: { x: 0, z: 0, yaw: 0 } });
  deaf.player = { x: 300, z: 300 };
  deaf.brain.hear({ loudness: .07, source: 'ladder', x: 20, z: 0 });
  const out = deaf.step({ move: false });
  assert.equal(deaf.brain.inspect().lead, undefined, 'a ladder rung 20 m away is not heard');
  assert.ok(!types(out.events).includes('heard'));
});

test('boldness: early evening it is timid, deep night it hunts', () => {
  assert.equal(nightness(12), 0); assert.equal(nightness(2), 1); assert.ok(nightness(20) > nightness(18));
  assert.ok(baseBoldness(17, 60) < T.huntBoldnessMin, 'the start of the evening cannot hunt');
  assert.ok(baseBoldness(19, 400) < T.huntBoldnessMin, 'nor at seven');
  assert.ok(baseBoldness(23.5, 900) > T.huntBoldnessFull, 'by midnight it will');
});

// --- Selector --------------------------------------------------------------------------------------------------

test('a noise sends a roaming creature to investigate; it searches there, then roams again', () => {
  const w = world({ hours: 17, darkness: .1, at: { x: 0, z: 0, yaw: 0 } });
  w.player = { x: 400, z: -400 };
  let r = w.run(2);
  assert.equal(r.out.behaviour, 'roam');
  const noise = { x: 30, z: 20 };
  w.brain.hear({ loudness: .65, source: 'radio', ...noise });
  r = w.run(.5);
  assert.equal(r.out.behaviour, 'investigate');
  assert.ok(types(r.events).includes('heard'));
  assert.ok(dist(r.out.intent.target, noise) <= w.brain.inspect().lead.uncertainty + 1e-9, 'it heads for the noise');
  r = w.run(60);
  assert.deepEqual(r.behaviours.slice(-2), ['investigate', 'roam']);
  assert.ok(w.brain.inspect().lead.investigated);
});

test('sustained sight at night starts a hunt; the same sight in early evening only shadows', () => {
  const night = world({ hours: 23.5, darkness: 1, at: { x: 0, z: 25, yaw: Math.PI } });
  night.player = { x: 0, z: 0, flashlightOn: true };
  let r = night.run(.4, { los: true, move: false });
  assert.notEqual(r.out.behaviour, 'hunt', 'not on first glimpse');
  r = night.run(4, { los: true, move: false });
  assert.equal(r.out.behaviour, 'hunt');
  assert.ok(types(r.events).includes('spotted') || night.brain.inspect().sees);
  assert.ok(types(r.events).includes('hunt-started'));
  r = night.run(2, { los: true });
  assert.ok(r.out.intent.speed >= T.huntApproach, 'it runs at the player');

  const evening = world({ hours: 17, darkness: .15, at: { x: 0, z: 25, yaw: Math.PI } });
  evening.player = { x: 0, z: 0, flashlightOn: true };
  r = evening.run(30, { los: true });
  assert.ok(!r.behaviours.includes('hunt'), `early evening: ${r.behaviours.join(' > ')}`);
  assert.ok(r.behaviours.includes('shadow'));
  assert.ok(dist(evening.self, evening.player) > T.shadowMin, 'and keeps its distance');
});

test('shadowing: it settles at its distance and stops when the player stands, and paces them when they walk', () => {
  const w = world({ hours: 18.5, darkness: .25, at: { x: 0, z: 22, yaw: Math.PI } });
  w.player = { x: 0, z: 0 };
  w.run(3, { los: true });
  const bearing = () => Math.atan2(w.self.x - w.player.x, w.self.z - w.player.z);
  const start = bearing();
  let r = w.run(20, { los: true });
  assert.equal(r.out.behaviour, 'shadow');
  assert.equal(r.out.intent.speed, 0, 'still, like the player');
  assert.ok(Math.abs(bearing() - start) < .3, 'it did not circle round them');
  const settled = dist(w.self, w.player);
  assert.ok(settled > 18 && settled < 40, `at the edge (${settled.toFixed(1)} m)`);
  // The player walks off along +x; it follows, keeping its distance.
  for (let i = 0; i < 400; i++) { w.player = { x: i * .05 * 1.8, z: 0, vx: 1.8 }; r = w.run(.05, { los: true }); }
  assert.equal(r.out.behaviour, 'shadow');
  assert.ok(r.out.intent.speed > 1.5, 'moving with them');
  assert.ok(dist(w.self, w.player) < 40, `kept up (${dist(w.self, w.player).toFixed(1)} m)`);
});

test('losing sight mid-hunt: it investigates the last known point, then gives up and roams', () => {
  const w = world({ hours: 23.5, darkness: 1, at: { x: 0, z: 30, yaw: Math.PI } });
  w.player = { x: 0, z: 0, flashlightOn: true };
  let r = w.run(4, { los: true, move: false });
  assert.equal(r.out.behaviour, 'hunt');
  const lastKnown = { x: 0, z: 0 };
  // The player ducks behind cover and slips away out of sight and earshot.
  w.player = { x: -70, z: -60 };
  r = w.run(6, { los: false });
  assert.ok(types(r.events).includes('lost-player'));
  assert.equal(r.out.behaviour, 'investigate');
  assert.ok(dist(r.out.intent.target, lastKnown) < 3, 'toward where it last saw them');
  r = w.run(40, { los: false });
  assert.equal(r.out.behaviour, 'roam');
  assert.ok(r.behaviours.includes('investigate') || w.brain.inspect().lead.investigated);
});

test('crouching with the torch off is much harder to see than walking with it on', () => {
  const spotted = p => {
    const w = world({ hours: 23.5, darkness: 1, at: { x: 0, z: 12, yaw: Math.PI } });
    w.player = p;
    const r = w.run(15, { los: true, move: false });
    return types(r.events).includes('spotted');
  };
  assert.equal(spotted({ x: 0, z: 0, vz: 1.8, flashlightOn: true }), true);
  assert.equal(spotted({ x: 0, z: 0, crouching: true }), false);
  // Inside touch range nothing hides you.
  const w = world({ at: { x: 0, z: 2.5, yaw: Math.PI } });
  w.player = { x: 0, z: 0, crouching: true };
  assert.ok(types(w.run(1, { los: false, move: false }).events).includes('spotted'));
});

test('the generator pulls a shadowing creature away once it has lost sight of the player', () => {
  const w = world({ hours: 19, darkness: .4, at: { x: 0, z: 26, yaw: Math.PI } });
  w.player = { x: 0, z: 0, flashlightOn: true };
  let r = w.run(6, { los: true });
  assert.equal(r.out.behaviour, 'shadow');
  // The player breaks line of sight; the generator they left running hums every few seconds, 25 m off.
  const generator = { x: w.self.x + 20, z: w.self.z + 15 };
  r = w.run(16, t => { if (Math.abs(t % 7 - 2) < .025) w.brain.hear({ loudness: .5, source: 'generator', ...generator }); return { los: false }; });
  assert.ok(r.behaviours.includes('investigate'), r.behaviours.join(' > '));
  const lead = w.brain.inspect().lead;
  assert.equal(lead.source, 'generator');
  assert.ok(dist(lead, generator) < dist(lead, w.player), 'it went to the generator, not to where it lost the player');
});

test('stared at too long in early evening, it melts back; it returns from the other side', () => {
  const w = world({ hours: 18, darkness: .2, at: { x: 0, z: 28, yaw: Math.PI } });
  w.player = { x: 0, z: 0 };
  const r = w.run(20, { los: true, looking: true });
  assert.ok(r.behaviours.includes('withdraw'), r.behaviours.join(' > '));
  assert.ok(dist(w.self, w.player) > 30, `it backed off to ${dist(w.self, w.player).toFixed(1)} m`);
  // Once it is no longer stared at, it comes back to pace the player.
  const back = w.run(30, { los: true, looking: false });
  assert.ok(back.behaviours.includes('shadow'), back.behaviours.join(' > '));
});

test('the selector does not flicker in a steady situation', () => {
  const w = world({ hours: 21, darkness: .8, at: { x: 0, z: 22, yaw: Math.PI } });
  w.player = { x: 0, z: 0 };
  const r = w.run(60, t => ({ los: Math.floor(t / 3) % 2 === 0 }));
  const changes = r.events.filter(e => e.type === 'behaviour').length;
  assert.ok(changes < 14, `${changes} switches in a minute of sight flickering every 3 s`);
});

test('hunting into reach is a strike, which holds until the host says the player was taken', () => {
  const w = world({ hours: 23.5, darkness: 1, at: { x: 0, z: 20, yaw: Math.PI } });
  w.player = { x: 0, z: 0, flashlightOn: true };
  const r = w.run(10, { los: true });
  assert.ok(types(r.events).includes('strike'), r.behaviours.join(' > '));
  assert.equal(r.out.behaviour, 'strike');
  assert.equal(r.out.intent.speed, 0);
  assert.equal(w.run(3, { los: true }).out.behaviour, 'strike', 'sticky');
  assert.equal(types(w.run(1, { los: true }).events).filter(t => t === 'strike').length, 0, 'one strike event');
  w.brain.struck();
  const after = w.run(5, { los: true, move: false });
  assert.notEqual(after.out.behaviour, 'strike');
  assert.ok(w.brain.inspect().boldness < T.huntBoldnessMin, 'calm after a kill');
  assert.ok(!after.behaviours.includes('hunt'));
});

test('no strike while the player is out of play (flying, already caught)', () => {
  const w = world({ hours: 23.5, darkness: 1, at: { x: 0, z: 20, yaw: Math.PI } });
  w.player = { x: 0, z: 0, flashlightOn: true, untouchable: true };
  const r = w.run(10, { los: true });
  assert.ok(!r.behaviours.includes('hunt') && !r.behaviours.includes('strike'));
});

test('the torch makes it flinch, less each time, until it no longer works', () => {
  const w = world({ hours: 23.5, darkness: 1, at: { x: 0, z: 18, yaw: Math.PI } });
  w.player = { x: 0, z: 0, flashlightOn: true };
  const flinches = [];
  let stoppedWhileFlinching = true;
  for (let t = 0; t < 40; t += .05) {
    const out = w.step({ los: true, beam: true, move: false, reach: 10 });
    for (const e of out.events) if (e.type === 'flinch') flinches.push(e.seconds);
    if (out.flinching && out.intent.speed !== 0) stoppedWhileFlinching = false;
  }
  assert.ok(flinches.length >= 3, `${flinches.length} flinches`);
  for (let i = 1; i < flinches.length; i++) assert.ok(flinches[i] < flinches[i - 1], 'each one shorter');
  assert.ok(Math.abs(flinches[0] - T.flinchSeconds) < 1e-9);
  assert.ok(stoppedWhileFlinching, 'it hesitates: no movement while flinching');
  const spent = w.brain.inspect().flinch.effect;
  assert.ok(spent <= T.flinchFloor, 'used up');
  w.run(30, { los: true, beam: true, move: false, reach: 10 });
  assert.equal(w.brain.inspect().flinch.active, false, 'spent: the beam no longer stops it');
  w.run(120, { los: false, move: false, reach: 10 });
  assert.ok(w.brain.inspect().flinch.effect > spent + .3, 'it recovers over minutes');
});

test('no strike while flinching, even within reach', () => {
  const w = world({ hours: 23.5, darkness: 1, at: { x: 0, z: 8, yaw: Math.PI } });
  w.player = { x: 0, z: 0, flashlightOn: true };
  w.brain.provoke(w.player);
  let out = w.step({ los: true, beam: true, move: false, reach: 5 });
  for (let i = 0; i < 10; i++) out = w.step({ los: true, beam: true, move: false, reach: 5 });
  assert.equal(out.flinching, true);
  out = w.step({ los: true, beam: false, move: false, reach: 1 });
  assert.notEqual(out.behaviour, 'strike');
});

test('developer hunt: provoked, it hunts at once whatever the hour', () => {
  const w = world({ hours: 16.5, darkness: 0, at: { x: 0, z: 22, yaw: Math.PI } });
  w.player = { x: 0, z: 0 };
  w.brain.provoke(w.player);
  const r = w.run(1, { los: false });
  assert.equal(r.out.behaviour, 'hunt', 'it knows where they are without seeing them');
  w.player = { x: 30, z: -10 };
  assert.ok(dist(w.run(.5, { los: false }).out.intent.target, w.player) < 1, 'and follows them');
});

test('determinism: one seed and one script give identical decisions; another seed differs', () => {
  const script = seed => {
    const w = world({ seed, hours: 20.5, darkness: .7, at: { x: 10, z: 60, yaw: Math.PI }, places: [{ x: 100, z: 0 }, { x: -80, z: 50 }, { x: 0, z: -120 }] });
    const log = [];
    for (let i = 0; i < 1200; i++) {
      const t = i * .05;
      w.player = { x: Math.sin(t * .1) * 20, z: t * .5, vz: .5, flashlightOn: i % 400 < 200 };
      if (i === 100) w.brain.hear({ loudness: .6, source: 'radio', x: 50, z: 40 });
      if (i === 500) w.brain.hear({ loudness: .3, source: 'footstep', x: 5, z: 20 });
      const out = w.step({ los: i % 300 > 120, looking: i % 500 > 400, beam: i > 900 && i < 950 });
      log.push(JSON.stringify(out));
    }
    return log;
  };
  assert.deepEqual(script(42), script(42));
  assert.notDeepEqual(script(42), script(43));
});

// --- Lives -----------------------------------------------------------------------------------------------------

test('lives: three, then game over; a restart is a full set again', () => {
  let s = initialLives();
  assert.deepEqual(s, { remaining: LIVES, deaths: 0, gameOver: false });
  const first = loseLife(s);
  assert.equal(first.outcome, 'respawn'); assert.equal(first.state.remaining, 2); assert.equal(s.remaining, 3, 'not mutated');
  assert.deepEqual(deathCard(first.state, first.outcome), { title: 'It let you go.', line: 'Twice more.' });
  const second = loseLife(first.state);
  assert.equal(second.outcome, 'respawn'); assert.equal(deathCard(second.state, second.outcome).line, 'Once more.');
  const third = loseLife(second.state);
  assert.equal(third.outcome, 'game-over'); assert.equal(third.state.gameOver, true); assert.equal(third.state.deaths, 3);
  assert.equal(deathCard(third.state, third.outcome).title, 'It kept you.');
  assert.equal(loseLife(third.state).state, third.state, 'nothing after game over');
  s = initialLives(); assert.equal(s.remaining, 3);
});

test('waking: the clock moves on 45 minutes, wrapping past midnight', () => {
  assert.equal(RESPAWN_ADVANCE_HOURS, .75);
  assert.equal(respawnHours(20), 20.75);
  assert.ok(Math.abs(respawnHours(23.5) - .25) < 1e-9);
});

test('the grab: wrench, then black, the move happens only under full black, then the eyes open', () => {
  assert.equal(grabTimeline(0).black, 0);
  assert.equal(grabTimeline(GRAB.wrench).wrench, 1);
  assert.ok(grabTimeline(GRAB.black - .01).black === 0 && grabTimeline(GRAB.black).black === 1, 'a cut, not a fade');
  for (let t = 0; t < GRAB.done + 1; t += .01) {
    const g = grabTimeline(t);
    if (g.respawn && t < GRAB.wake) assert.equal(g.black, 1, `respawn under black at ${t.toFixed(2)}`);
    if (g.card > 0) assert.equal(g.black, 1, 'the card only on black');
  }
  assert.ok(grabTimeline(GRAB.cardIn + 1).card === 1);
  assert.ok(grabTimeline(GRAB.done).done && grabTimeline(GRAB.done).black === 0);
});
