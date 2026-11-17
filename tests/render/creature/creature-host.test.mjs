import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';

// The Listener's model is loaded from disk as the browser would fetch it (its textures cannot decode under Node,
// which does not matter here), so the real body, gait and visibility protection run headless.
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest { constructor(url, options) { super(new URL(url, 'http://localhost/'), options); } };
globalThis.fetch = async request => {
  const url = new URL(request.url ?? request);
  if (url.pathname.endsWith('.glb')) return new Response(readFileSync(new URL(`../../../public${url.pathname}`, import.meta.url)));
  throw new Error('offline');
};
globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class extends Event { constructor(type, init = {}) { super(type); Object.assign(this, init); } };
import '../../helpers/register-ts-hooks.mjs';
const { createEncounters } = await import('../../../game/render/creature/encounters.ts');

const quietly = async f => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; } };
const senses = (o = {}) => ({ vx: 0, vz: 0, sprinting: false, crouching: false, flashlightOn: false, inWater: false, onLadder: false, indoors: false, ...o });

/** Open flat ground, a player at the origin and a camera the test points. Without `opening` the scripted opening is skipped. */
async function stage({ seed = 3, places, solids = [], opening = false, doorAt, trace, lair, round } = {}) {
  const scene = new THREE.Scene(), sounds = [];
  const audio = new Proxy({}, { get: (_, kind) => (...args) => { sounds.push(kind); return kind === 'creatureReveal' || kind === 'stalkCue'; } });
  const player = new THREE.Vector3(), forward = new THREE.Vector3(0, 0, -1);
  const view = { position: new THREE.Vector3(), forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), verticalFov: 69, aspect: 16 / 9 };
  const aim = direction => {
    forward.copy(direction).setY(0).normalize();
    view.position.set(player.x, player.y + 1.69, player.z); view.forward.copy(forward);
    view.right.crossVectors(forward, THREE.Object3D.DEFAULT_UP).normalize(); view.up.crossVectors(view.right, forward).normalize();
  };
  aim(new THREE.Vector3(0, 0, -1));
  const encounters = await quietly(async () => {
    const world = { nearby: (x, z, r = .45) => solids.filter(c => Math.hypot(c.ax - x, c.az - z) < r + c.radius + 1) };
    const e = createEncounters(scene, () => 0, audio, world, () => view, undefined, { seed, places, opening, doorAt, trace, lair, round });
    for (let i = 0; i < 100 && !e.modelStatus().ready; i++) await new Promise(r => setTimeout(r, 50));
    return e;
  });
  assert.ok(encounters.modelStatus().ready, 'the Listener model loaded');
  let elapsed = 0;
  const frame = (o = {}) => { elapsed += 1 / 30; encounters.update(1 / 30, elapsed, player, forward, o.darkness ?? 1, o.hours ?? 23.5, senses(o)); return encounters.visibilityStatus(); };
  const creature = () => { const p = encounters.visibilityStatus().position; return new THREE.Vector3(p[0], p[1], p[2]); };
  /** Look straight away from the creature, so nothing it does can be on screen. */
  const lookAway = () => aim(player.clone().sub(creature()));
  const lookAt = () => aim(creature().sub(player));
  return { encounters, player, view, aim, frame, creature, lookAway, lookAt, sounds, world: { solids }, get elapsed() { return elapsed; } };
}

test('persistent: far and unseen it travels with no body, and gains one only out of view', async () => {
  const s = await stage();
  // 21:00 on day 1: it is out of its lair. The whole island hears a siren at the player, so it comes, running.
  let status = s.frame({ hours: 21, darkness: .5, breathHeld: true });
  assert.equal(status.presence, 'unseen');
  assert.ok(s.creature().length() >= 150, `starts far away (${s.creature().length().toFixed(0)} m)`);
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: 0 });
  // Watching the place it comes from: it never appears there. Unseen it holds at the edge, or comes in from the side,
  // out of view, and walks into view from there.
  let closest = Infinity;
  for (let i = 0; i < 30 * 120 && status.presence === 'unseen'; i++) { s.lookAt(); status = s.frame({ hours: 21, darkness: .5, breathHeld: true }); if (status.presence === 'unseen') closest = Math.min(closest, s.creature().length()); }
  assert.ok(closest >= 50 - 1e-6, `unseen, held at the edge (${closest.toFixed(1)} m)`);
  assert.ok(closest < 110, 'but it did come');
  if (status.presence === 'body') {
    const side = status.transitions.find(t => t.kind === 'arrive-side');
    assert.ok(side && !side.inView, 'it came in from the side, out of view');
    return;
  }
  // Look away and it arrives.
  for (let i = 0; i < 30 * 5 && status.presence === 'unseen'; i++) { s.lookAway(); status = s.frame({ hours: 21, darkness: .5, breathHeld: true }); }
  assert.equal(status.presence, 'body');
  const arrival = status.transitions.find(t => t.kind === 'arrive');
  assert.ok(arrival && !arrival.inView, 'placed out of view');
});

test('a loud noise brings it running to the player, who is caught while breathing; mid-grab its limbs stop pushing', async () => {
  const s = await stage();
  let status, grabbed = false, frames = 0;
  // It starts ~200 m off. A siren at the player: it calls, runs in, and takes the one who stands there breathing.
  s.frame({ hours: 23.5, darkness: 1 });
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: 0 });
  for (; frames < 30 * 90 && !grabbed; frames++) {
    s.lookAway();
    status = s.frame({ hours: 23.5, darkness: 1 });
    grabbed = s.encounters.takeStrike();
  }
  assert.ok(grabbed, `taken within ${(frames / 30).toFixed(1)} s (${status.brain.behaviour}, ${s.creature().length().toFixed(1)} m)`);
  assert.ok(status.transitions.some(t => t.kind === 'strike'));
  assert.ok(status.senses.reach < 2.3, `its head reached the player (${status.senses.reach.toFixed(2)} m)`);
  assert.equal(s.encounters.grabbing, true);
  assert.deepEqual(s.encounters.solidColliders(), [], 'no limb collisions during the grab');
  const head = s.encounters.headPosition(new THREE.Vector3());
  assert.ok(head.distanceTo(new THREE.Vector3(0, 1.4, 0)) < 3, 'the face to wrench the camera toward is right there');
  assert.equal(s.encounters.takeStrike(), false, 'one grab');
  // Under black it is moved far from where the player wakes, and does not come straight back.
  const wake = new THREE.Vector3(30, 0, 30);
  s.player.copy(wake);
  s.frame({ untouchable: true, blackout: true });
  assert.equal(s.encounters.relocate(s.player, s.elapsed), true);
  status = s.frame({ untouchable: true, blackout: true });
  assert.equal(status.presence, 'unseen'); assert.equal(s.encounters.grabbing, false);
  assert.ok(s.creature().distanceTo(wake) >= 150, 'far from the cabin');
  assert.equal(status.brain.lead, undefined, 'and it has forgotten what it was following');
});

test('holding the breath, still and silent, the player is passed by even when it stands over them', async () => {
  const s = await stage();
  s.frame({ hours: 23.5, darkness: 1, breathHeld: true });
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: 0 });
  let closest = Infinity, status;
  for (let i = 0; i < 30 * 70; i++) {
    s.lookAway();
    status = s.frame({ hours: 23.5, darkness: 1, breathHeld: true });
    if (status.presence === 'body') closest = Math.min(closest, s.creature().distanceTo(s.player));
    assert.equal(s.encounters.takeStrike(), false, `no grab at ${(i / 30).toFixed(1)} s`);
  }
  assert.ok(closest < 5, `it came right up to the spot (${closest.toFixed(1)} m)`);
  assert.ok(status.brain.clock > 60);
});

test('the developer hunt spawn brings it near, out of view, already running at them; dismiss sends it away', async () => {
  const s = await stage();
  s.frame();
  s.aim(new THREE.Vector3(0, 0, -1));
  s.encounters.spawn(s.player, new THREE.Vector3(0, 0, -1), 'hunt');
  let status;
  for (let i = 0; i < 30 * 1; i++) status = s.frame({ hours: 12, darkness: 0 });
  assert.equal(status.presence, 'body');
  assert.ok(status.transitions.some(t => t.kind === 'spawn' && !t.inView));
  assert.ok(['run', 'strike'].includes(status.brain.behaviour), `running at them at noon, as asked (${status.brain.behaviour})`);
  s.encounters.dismiss(s.elapsed);
  for (let i = 0; i < 30 * 4; i++) { s.lookAway(); status = s.frame({ hours: 12, darkness: 0 }); }
  assert.equal(status.presence, 'unseen');
  assert.ok(s.creature().length() >= 120, `gone far away (${s.creature().length().toFixed(0)} m)`);
  assert.equal(status.brain.lead, undefined, 'and it has forgotten the player');
});

test('it hears the noise stream from where it really is, by the noise scale', async () => {
  const s = await stage();
  s.frame({ hours: 21, darkness: .5 });
  const at = s.creature(), noise = { x: at.x + 30, z: at.z };
  s.encounters.hear({ loudness: .65, source: 'radio', ...noise });
  const status = s.frame({ hours: 21, darkness: .5 });
  assert.equal(status.brain.lead?.source, 'radio');
  assert.equal(status.brain.lead.grade, 'loud');
  assert.ok(Math.hypot(status.brain.lead.x - noise.x, status.brain.lead.z - noise.z) <= status.brain.lead.uncertainty + 1e-9);
  assert.equal(status.brain.behaviour, 'trot');
  s.encounters.hear({ loudness: .07, source: 'flashlight', x: 0, z: 0 });
  assert.equal(s.frame({ hours: 21, darkness: .5 }).brain.lead?.source, 'radio', 'the torch switch at the player is far out of earshot');
  // Out of range it is not heard at all, however loud it looks: a 65 m radio from 70 m.
  const t = await stage();
  t.frame({ hours: 21, darkness: .5 });
  const there = t.creature();
  t.encounters.hear({ loudness: .65, source: 'radio', x: there.x + 70, z: there.z });
  assert.equal(t.frame({ hours: 21, darkness: .5 }).brain.lead, undefined);
});

test('by day it walks home and sleeps in its lair; a loud noise too far from the lair leaves it asleep, a very loud one wakes it', async () => {
  const lair = { x: 160, z: 0 };
  const s = await stage({ lair });
  const day = { hours: 12, darkness: 0, day: 1, breathHeld: true };
  // It starts wherever it starts; by day it goes (unseen) to its lair and goes to sleep there.
  for (let i = 0; i < 30 * 150 && s.encounters.visibilityStatus().brain.behaviour !== 'asleep'; i++) { s.lookAway(); s.frame(day); }
  let status = s.encounters.visibilityStatus();
  assert.equal(status.brain.behaviour, 'asleep');
  assert.ok(s.creature().distanceTo(new THREE.Vector3(lair.x, 0, lair.z)) < 4, `in the lair (at ${s.creature().toArray().map(v => v.toFixed(1))}, ${status.brain.clock.toFixed(0)} s)`);
  // A bell (70 m) 65 m from the lair is heard but too far from it to wake a sleeper; so is a door beside it.
  s.encounters.hear({ loudness: .7, source: 'bell', x: lair.x + 65, z: lair.z });
  s.encounters.hear({ loudness: .22, source: 'door', x: lair.x + 2, z: lair.z });
  assert.equal(s.frame(day).brain.behaviour, 'asleep');
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: 0 });
  status = s.frame(day);
  assert.equal(status.brain.behaviour, 'run', 'a very loud noise wakes it');
  assert.equal(status.brain.lead.source, 'siren');
});

test('the tree ambush from the developer menu: stare, a fast drop, a roar and a bluff charge that stops short, then the brain has it', async () => {
  const trunk = { kind: 'capsule', ax: 0, az: -18, bx: 0, bz: -18, radius: .6, minY: 0, maxY: 32, tag: 'tree' };
  const s = await stage({ solids: [trunk] });
  s.frame({ hours: 21, darkness: .6 });
  s.aim(new THREE.Vector3(0, 0, 1));
  s.encounters.spawn(s.player, new THREE.Vector3(0, 0, 1), 'tree');
  let status;
  for (let i = 0; i < 30 * 2; i++) status = s.frame({ hours: 21, darkness: .6 });
  assert.equal(status.treePhase, 'perched');
  assert.ok(status.transitions.some(t => t.kind === 'tree-spawn' && !t.inView));
  assert.ok(!s.sounds.includes('creatureReveal'), 'the reveal waits for the sighting');
  // Turn round and look up at it: recognised, it stares, drops, lands, rears and charges, then slips away under the brain.
  const up = new THREE.Vector3(), phases = [], stages = [];
  let closest = Infinity, revealAt = -1, landedAt = -1;
  for (let i = 0; i < 30 * 40 && !(status.opening.script === undefined && status.brain.behaviour === 'round'); i++) {
    s.encounters.headPosition(up); s.view.position.set(0, 1.69, 0);
    s.view.forward.copy(up).sub(s.view.position).normalize(); s.view.right.crossVectors(s.view.forward, THREE.Object3D.DEFAULT_UP).normalize(); s.view.up.crossVectors(s.view.right, s.view.forward).normalize();
    status = s.frame({ hours: 21, darkness: .6 });
    if (revealAt < 0 && s.sounds.includes('creatureReveal')) revealAt = i;
    if (status.treePhase && phases[phases.length - 1] !== status.treePhase) phases.push(status.treePhase);
    const stage = status.opening.script?.stage;
    if (stage && stages[stages.length - 1] !== stage) stages.push(stage);
    if (landedAt < 0 && stage === 'rearing') landedAt = i;
    if (landedAt >= 0) closest = Math.min(closest, s.creature().length());
  }
  assert.deepEqual(phases, ['perched', 'descending', 'landing']);
  assert.deepEqual(stages, ['perched', 'staring', 'descending', 'rearing', 'charging', 'stopped']);
  assert.ok(revealAt >= 0, 'the reveal played when it was seen');
  assert.ok(closest > 7, `the bluff stops short (${closest.toFixed(1)} m)`);
  assert.equal(status.presence, 'body');
  assert.equal(status.brain.behaviour, 'round');
  assert.ok(s.sounds.includes('screech'), 'it roared');
});

test('developer idle, walk and run spawns still place it out of view and leave the brain out of it until dismissed', async () => {
  for (const mode of ['idle', 'walk', 'run']) {
    const s = await stage();
    s.frame();
    s.encounters.spawn(s.player, new THREE.Vector3(0, 0, -1), mode);
    let status;
    for (let i = 0; i < 30 * 2; i++) status = s.frame({ hours: 12, darkness: 0 });
    assert.equal(status.presence, 'body', mode);
    assert.equal(status.mode, mode);
    assert.ok(status.transitions.some(t => t.kind === 'spawn' && !t.inView));
    const at = s.creature().clone();
    for (let i = 0; i < 30 * 2; i++) status = s.frame({ hours: 12, darkness: 0 });
    const moved = s.creature().distanceTo(at);
    if (mode === 'idle') assert.ok(moved < .3, `idle holds still (${moved.toFixed(2)} m)`); else assert.ok(moved > 1, `${mode} moves (${moved.toFixed(2)} m)`);
    s.encounters.dismiss(s.elapsed);
    for (let i = 0; i < 30 * 3; i++) { s.lookAway(); status = s.frame({ hours: 12, darkness: 0 }); }
    assert.equal(status.presence, 'unseen', `${mode} dismissed`);
    assert.equal(status.mode, 'natural');
  }
});

/** A ring of trunks round the player, as a forest is: something to stand beside and something to climb. */
const grove = () => {
  const solids = [];
  for (let ring = 1; ring <= 4; ring++) for (let i = 0; i < 6 + ring * 4; i++) {
    const a = i / (6 + ring * 4) * Math.PI * 2 + ring, d = ring * 9 + 4;
    solids.push({ kind: 'capsule', ax: Math.sin(a) * d, az: Math.cos(a) * d, bx: Math.sin(a) * d, bz: Math.cos(a) * d, radius: .62, minY: 0, maxY: 30, tag: 'tree' });
  }
  return solids;
};

test('the glimpse: placed out of view ahead and to one side, the reveal at the sighting, a held gaze, then gone out of view', async () => {
  const s = await stage({ opening: true, solids: grove() });
  s.frame({ hours: 17, darkness: 0 });
  s.encounters.jumpOpening('glimpse');
  // Looking along the way they are going: it cannot be placed in view, so it waits for a glance away.
  const ahead = new THREE.Vector3(0, 0, -1);
  let status;
  for (let i = 0; i < 30 * 3; i++) { s.aim(ahead); status = s.frame({ hours: 17, darkness: 0 }); }
  if (status.presence === 'unseen') { s.aim(new THREE.Vector3(0, 0, 1)); for (let i = 0; i < 30 * 2 && s.encounters.visibilityStatus().presence === 'unseen'; i++) s.frame({ hours: 17, darkness: 0 }); }
  status = s.encounters.visibilityStatus();
  assert.equal(status.presence, 'body');
  const placed = status.transitions.find(t => t.kind === 'glimpse');
  assert.ok(placed && !placed.inView, 'placed out of view');
  const d = s.creature().length();
  assert.ok(d >= 18 && d <= 42, `${d.toFixed(1)} m away`);
  assert.ok(!s.sounds.includes('creatureReveal'), 'no reveal at the placement');
  // Turn to it: seen, the reveal plays, it holds the gaze, then walks off and is taken away once out of view.
  const stages = [];
  for (let i = 0; i < 30 * 8; i++) { s.lookAt(); status = s.frame({ hours: 17, darkness: 0 }); const st = status.opening.script?.stage; if (st && stages.at(-1) !== st) stages.push(st); }
  assert.ok(s.sounds.includes('creatureReveal'), 'the reveal played at the sighting');
  assert.deepEqual(stages.slice(0, 3), ['waiting', 'holding', 'leaving']);
  assert.equal(status.presence, 'body', 'still there while watched');
  for (let i = 0; i < 30 * 6 && status.opening.phase === 'glimpse'; i++) { s.lookAway(); status = s.frame({ hours: 17, darkness: 0 }); }
  assert.equal(status.opening.phase, 'interlude');
  assert.equal(status.presence, 'unseen');
  assert.ok(status.transitions.filter(t => t.kind === 'glimpse-gone').every(t => !t.inView));
});

test('during the opening it cannot chase or grab, even at midnight with the torch on beside it', async () => {
  const s = await stage({ opening: true, solids: grove() });
  s.frame({ hours: 23.5, darkness: 1, flashlightOn: true });
  s.encounters.jumpOpening('glimpse');
  let status, behaviours = new Set(), closest = Infinity;
  for (let i = 0; i < 30 * 60; i++) {
    // Walk at it, looking at it.
    const c = s.creature(); if (s.encounters.visibilityStatus().presence === 'body') { const to = c.clone().sub(s.player).setY(0); if (to.length() > 3) s.player.addScaledVector(to.normalize(), 1.8 / 30); s.lookAt(); } else s.lookAway();
    status = s.frame({ hours: 23.5, darkness: 1, flashlightOn: true, vz: -1.8 });
    behaviours.add(status.brain.behaviour);
    if (status.presence === 'body') closest = Math.min(closest, s.creature().distanceTo(s.player));
    assert.equal(s.encounters.takeStrike(), false, 'no grab');
  }
  assert.ok(!behaviours.has('run') && !behaviours.has('strike'), [...behaviours].join(', '));
  assert.ok(closest > 9, `it kept its distance (${closest.toFixed(1)} m)`);
});

test('every sound has a cause: one call as it takes up a loud noise, clicks while it searches, nothing at random', async () => {
  const events = [];
  const s = await stage({ trace: e => events.push(e) });
  s.frame({ hours: 23.5, darkness: 1, breathHeld: true });
  const heardAt = s.elapsed;
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: 0 });
  for (let i = 0; i < 30 * 100; i++) { s.lookAway(); s.frame({ hours: 23.5, darkness: 1, breathHeld: true }); }
  const sounds = kind => events.filter(e => e.type === 'sound' && e.kind === kind);
  assert.equal(sounds('call').length, 1, 'one call');
  assert.ok(sounds('call')[0].t - heardAt < 1, 'at the moment it heard');
  assert.ok(sounds('clicks').length >= 3, `${sounds('clicks').length} runs of clicks while it searched`);
  assert.ok(sounds('clicks')[0].t > heardAt + 15, 'only once it was there');
  assert.equal(sounds('branch').length + sounds('knock').length, 0, 'no sound without a cause');
  const kinds = new Set(events.filter(e => e.type === 'sound').map(e => e.kind));
  assert.ok([...kinds].every(k => ['call', 'clicks', 'reveal'].includes(k)), [...kinds].join(', '));
  assert.ok(events.filter(e => e.type === 'transition' && e.action !== 'strike').every(e => !e.inView));
});

test('every sound means something once: a run of stuns hisses once, and again only after the engagement has gone cold', async () => {
  // A provoked run beside a player who keeps the torch on it whenever it can be seen: pinned, held, up again, pinned again.
  const events = [], s = await stage({ seed: 8, solids: grove(), trace: e => events.push(e) });
  const sounds = kind => events.filter(e => e.type === 'sound' && e.kind === kind), pins = () => events.filter(e => e.type === 'stun' && e.phase === 'slowing');
  const run = (seconds, { beam = true, look = true } = {}) => {
    for (let i = 0; i < 30 * seconds; i++) {
      // Keep separation for this audio-only test so the faster run does not end the stun sequence in a grab.
      if (beam && s.encounters.probe().visible) {
        const creature = s.creature(), away = s.player.clone().sub(creature).setY(0);
        if (away.length() < 18) s.player.copy(creature.add(away.normalize().multiplyScalar(18))).setY(0);
      }
      if (look && s.encounters.probe().visible) s.lookAt(); else s.lookAway();
      s.frame({ hours: 23.5, darkness: 1, flashlightOn: beam, breathHeld: true });
      // Taken: black, and it is moved far off and left to start again (as the engine does).
      if (s.encounters.takeStrike()) { s.frame({ untouchable: true, blackout: true }); s.encounters.relocate(s.player, s.elapsed); return true; }
    }
    return false;
  };
  s.frame({ hours: 23.5, darkness: 1, flashlightOn: true });
  s.encounters.spawn(s.player, new THREE.Vector3(0, 0, -1), 'hunt');
  const struck = run(40);
  assert.ok(pins().length >= 2, `pinned ${pins().length} times before it reached them (${struck ? 'taken' : 'not taken'})`);
  assert.equal(sounds('hiss').length, 1, 'repeated stuns, one hiss');
  // The engagement goes cold (far more than 45 s with the beam off it): the next pin hisses again.
  s.player.set(0, 0, 0); s.encounters.dismiss(s.elapsed); run(60, { beam: false, look: false });
  s.encounters.spawn(s.player, new THREE.Vector3(0, 0, -1), 'hunt'); run(15);
  assert.ok(pins().length > 3 && sounds('hiss').length === 2, `${pins().length} stuns, ${sounds('hiss').length} hisses`);
});

test('the visible eight-legged rig sustains fast bursts with fixed planted contacts at 30 and 60 FPS', async () => {
  for (const hz of [30, 60]) for (const speed of [5.6, 11.2, 13]) {
    const { encounters } = await stage();
    encounters.preview(0, 0, 0);
    let previous, total = 0, samples = 0, peak = 0;
    for (let frame = 0; frame < hz * 6; frame++) {
      const feet = encounters.previewStep(1 / hz, frame / hz, speed);
      assert.equal(feet.length, 8);
      if (previous) for (let leg = 0; leg < feet.length; leg++) {
        if (feet[leg].swinging || previous[leg].swinging) continue;
        const slip = Math.hypot(...feet[leg].renderedPosition.map((v, axis) => v - previous[leg].renderedPosition[axis]));
        assert.ok(slip < 1e-6, `${hz} FPS at ${speed} m/s, ${feet[leg].label} slipped ${slip} m`);
      }
      previous = feet;
      if (frame > hz) {
        const actual = encounters.navigationStatus().speed;
        total += actual; samples++; peak = Math.max(peak, actual);
      }
    }
    assert.ok(peak > speed * .99, `${hz} FPS reached only ${peak} m/s`);
    assert.ok(total / samples > speed * .95, `${hz} FPS averaged only ${total / samples} m/s`);
    encounters.dispose();
  }
});
