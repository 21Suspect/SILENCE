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
  if (url.pathname.endsWith('.glb')) return new Response(readFileSync(new URL(`../public${url.pathname}`, import.meta.url)));
  throw new Error('offline');
};
globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class extends Event { constructor(type, init = {}) { super(type); Object.assign(this, init); } };
import './helpers/register-ts-hooks.mjs';
const { createEncounters } = await import('../game/encounters.ts');

const quietly = async f => { const e = console.error, w = console.warn; console.error = console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; } };
const senses = (o = {}) => ({ vx: 0, vz: 0, sprinting: false, crouching: false, flashlightOn: false, inWater: false, onLadder: false, indoors: false, ...o });

/** Open flat ground, a player at the origin and a camera the test points. */
async function stage({ seed = 3, places, solids = [] } = {}) {
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
    const e = createEncounters(scene, () => 0, audio, world, () => view, undefined, { seed, places });
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
  return { encounters, player, view, aim, frame, creature, lookAway, lookAt, sounds, get elapsed() { return elapsed; } };
}

test('persistent: far and unseen it travels with no body, and gains one only out of view', async () => {
  const s = await stage();
  let status = s.frame({ hours: 17, darkness: .1 });
  assert.equal(status.presence, 'unseen');
  assert.ok(s.creature().length() >= 150, `starts far away (${s.creature().length().toFixed(0)} m)`);
  // Watching the place it comes from: it waits out at the edge rather than appear in view.
  let closest = Infinity;
  for (let i = 0; i < 30 * 120; i++) { s.lookAt(); status = s.frame({ hours: 17, darkness: .1 }); closest = Math.min(closest, s.creature().length()); assert.equal(status.presence, 'unseen', 'never gets a body while watched'); }
  assert.ok(closest >= 50 - 1e-6, `held at the edge (${closest.toFixed(1)} m)`);
  assert.ok(closest < 110, 'but it did come');
  // Look away and it arrives.
  for (let i = 0; i < 30 * 5 && status.presence === 'unseen'; i++) { s.lookAway(); status = s.frame({ hours: 17, darkness: .1 }); }
  assert.equal(status.presence, 'body');
  const arrival = status.transitions.find(t => t.kind === 'arrive');
  assert.ok(arrival && !arrival.inView, 'placed out of view');
});

test('at night with the torch on it hunts, charges and grabs; mid-grab its limbs stop pushing', async () => {
  const s = await stage();
  let status, grabbed = false, frames = 0;
  // It starts ~200 m off: it roams in, picks out the torch, shadows a moment, then runs.
  for (; frames < 30 * 180 && !grabbed; frames++) {
    s.lookAway();
    status = s.frame({ hours: 23.5, darkness: 1, flashlightOn: true });
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
  assert.ok(status.brain.calm > 0 && status.brain.boldness < .5, 'and calm for a while');
});

test('the developer hunt spawn brings it near, out of view, already hunting; dismiss sends it away', async () => {
  const s = await stage();
  s.frame();
  s.aim(new THREE.Vector3(0, 0, -1));
  s.encounters.spawn(s.player, new THREE.Vector3(0, 0, -1), 'hunt');
  let status;
  for (let i = 0; i < 30 * 3; i++) status = s.frame({ hours: 12, darkness: 0 });
  assert.equal(status.presence, 'body');
  assert.ok(status.transitions.some(t => t.kind === 'spawn' && !t.inView));
  assert.equal(status.brain.behaviour, 'hunt', 'hunting at noon, as asked');
  s.encounters.dismiss(s.elapsed);
  for (let i = 0; i < 30 * 4; i++) { s.lookAway(); status = s.frame({ hours: 12, darkness: 0 }); }
  assert.equal(status.presence, 'unseen');
  assert.ok(s.creature().length() >= 120, `gone far away (${s.creature().length().toFixed(0)} m)`);
  assert.equal(status.brain.lead, undefined, 'and it has forgotten the player');
});

test('it hears the noise stream from where it really is', async () => {
  const s = await stage();
  s.frame({ hours: 17, darkness: .1 });
  const at = s.creature(), noise = { x: at.x + 30, z: at.z };
  s.encounters.hear({ loudness: .65, source: 'radio', ...noise });
  const status = s.frame({ hours: 17, darkness: .1 });
  assert.equal(status.brain.lead?.source, 'radio');
  assert.ok(Math.hypot(status.brain.lead.x - noise.x, status.brain.lead.z - noise.z) <= status.brain.lead.uncertainty);
  s.encounters.hear({ loudness: .07, source: 'flashlight', x: 0, z: 0 });
  assert.equal(s.frame({ hours: 17, darkness: .1 }).brain.lead?.source, 'radio', 'the torch switch at the player is far out of earshot');
});

test('the tree ambush still works from the developer menu, and the brain takes over once it is down', async () => {
  const trunk = { kind: 'capsule', ax: 0, az: -18, bx: 0, bz: -18, radius: .6, minY: 0, maxY: 32, tag: 'tree' };
  const s = await stage({ solids: [trunk] });
  s.frame({ hours: 21, darkness: .6 });
  s.aim(new THREE.Vector3(0, 0, 1));
  s.encounters.spawn(s.player, new THREE.Vector3(0, 0, 1), 'tree');
  let status;
  for (let i = 0; i < 30 * 2; i++) status = s.frame({ hours: 21, darkness: .6 });
  assert.equal(status.treePhase, 'perched');
  assert.ok(status.transitions.some(t => t.kind === 'tree-spawn' && !t.inView));
  // Turn round and look up at it: once recognised it climbs down, lands, and slips away under the brain.
  const up = new THREE.Vector3(), seen = [];
  for (let i = 0; i < 30 * 40 && status.treePhase !== null; i++) {
    s.encounters.headPosition(up); s.view.position.set(0, 1.69, 0);
    s.view.forward.copy(up).sub(s.view.position).normalize(); s.view.right.crossVectors(s.view.forward, THREE.Object3D.DEFAULT_UP).normalize(); s.view.up.crossVectors(s.view.right, s.view.forward).normalize();
    status = s.frame({ hours: 21, darkness: .6 });
    if (status.treePhase && seen[seen.length - 1] !== status.treePhase) seen.push(status.treePhase);
  }
  assert.deepEqual(seen, ['perched', 'descending', 'landing']);
  assert.equal(status.presence, 'body');
  assert.equal(status.brain.behaviour, 'withdraw');
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
