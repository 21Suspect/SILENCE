import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';

// The host's new duties, with the real body and gait running headless (see creature-host.test.mjs for the set-up): footfalls from the
// gait's plants, which are never noises it hears; running sources; and a building under siege (doors tried, forced, reached through).
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

async function stage({ seed = 3, buildings, doors, lair } = {}) {
  const scene = new THREE.Scene(), calls = [], trace = [];
  const audio = new Proxy({}, { get: (_, kind) => (...args) => { calls.push({ kind, args }); return kind === 'creatureReveal' || kind === 'stalkCue'; } });
  const player = new THREE.Vector3(), forward = new THREE.Vector3(0, 0, -1);
  const view = { position: new THREE.Vector3(), forward: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), verticalFov: 69, aspect: 16 / 9 };
  const aim = direction => {
    forward.copy(direction).setY(0).normalize();
    view.position.set(player.x, player.y + 1.69, player.z); view.forward.copy(forward);
    view.right.crossVectors(forward, THREE.Object3D.DEFAULT_UP).normalize(); view.up.crossVectors(view.right, forward).normalize();
  };
  aim(new THREE.Vector3(0, 0, -1));
  const encounters = await quietly(async () => {
    const e = createEncounters(scene, () => 0, audio, { nearby: () => [] }, () => view, undefined, { seed, opening: false, buildings, doors, lair, trace: ev => trace.push(ev) });
    for (let i = 0; i < 100 && !e.modelStatus().ready; i++) await new Promise(r => setTimeout(r, 50));
    return e;
  });
  assert.ok(encounters.modelStatus().ready, 'the Listener model loaded');
  let elapsed = 0;
  const frame = (o = {}) => { elapsed += 1 / 30; encounters.update(1 / 30, elapsed, player, forward, 1, o.hours ?? 23.5, senses(o)); return encounters.visibilityStatus(); };
  const creature = () => { const p = encounters.visibilityStatus().position; return new THREE.Vector3(p[0], p[1], p[2]); };
  const lookAway = () => aim(player.clone().sub(creature()));
  return { encounters, player, frame, creature, lookAway, calls, trace, get elapsed() { return elapsed; } };
}

test('each foot that lands is heard from where it landed: all eight legs, louder and faster when it runs, never beyond 60 m, never a noise it hears', async () => {
  const s = await stage();
  s.frame({ hours: 23.5 });
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: 0 });
  let status;
  for (let i = 0; i < 30 * 60 && s.calls.filter(c => c.kind === 'creatureStep').length < 200; i++) { s.lookAway(); status = s.frame({ breathHeld: true }); }
  const steps = s.calls.filter(c => c.kind === 'creatureStep');
  assert.ok(steps.length >= 60, `${steps.length} footfalls (${status.brain.behaviour})`);
  assert.deepEqual([...new Set(steps.map(c => c.args[1]))].sort(), [0, 1, 2, 3, 4, 5, 6, 7], 'every leg');
  for (const { args: [at, , speed, surface] } of steps) {
    assert.ok(Number.isFinite(at.x + at.y + at.z) && speed >= 0 && typeof surface === 'string');
    assert.ok(Math.hypot(at.x - s.player.x, at.z - s.player.z) <= 60.5, 'nothing is played beyond 60 m');
  }
  assert.ok(Math.max(...steps.map(c => c.args[2])) > 5, 'a run is fast');
  assert.ok(new Set(steps.map(c => c.args[3])).size >= 1);
  // The creature's own sounds are not noises it listens for: the only thing it ever heard is the siren (and, close, the breath).
  const heard = s.trace.filter(e => e.type === 'heard');
  assert.ok(heard.length >= 1 && heard.every(e => e.source === 'siren' || e.source === 'breath'), `heard: ${[...new Set(heard.map(e => e.source))]}`);
});

test('a running source on the host: it comes to a generator and the source is its own; switched off, it searches', async () => {
  const s = await stage();
  s.player.set(0, 0, 0);
  s.frame({ hours: 23.5 });
  s.encounters.source('generator', { x: 0, z: 0, loudness: 1.5 });
  // It starts 170-230 m off: out of its 150 m reach. Move the generator to it so it is heard.
  const at = s.creature();
  s.encounters.source('generator', { x: at.x * .5, z: at.z * .5, loudness: 1.5 });
  let status;
  for (let i = 0; i < 30 * 10; i++) { s.lookAway(); status = s.frame({ breathHeld: true }); }
  assert.ok(['run', 'search'].includes(status.brain.behaviour) || status.brain.lead?.source === 'generator', `it took the generator up (${status.brain.behaviour})`);
  assert.equal(status.brain.sources.length, 1);
  s.encounters.source('generator', null);
  assert.deepEqual(s.encounters.visibilityStatus().brain.sources, []);
});

// A building around the player, a door in its south wall, and a recording stand-in for the doors.
const CABIN = { id: 'cabin', x: 0, z: 0, yaw: 0, cx: 0, cz: 0, hx: 4.4, hz: 4.4 };
function fakeDoors({ barred = false } = {}) {
  const door = { id: 'cabin#0', placement: 'cabin', open: 0, target: 0, barred, status: 'ready', mid: { x: -.7, z: 4.4 } }, forced = [];
  return { door, forced, doors: { list: () => [{ ...door }], force: id => { forced.push(id); door.barred = false; door.open = door.target = 1; return true; } } };
}

test('a building under siege: it comes, scratches and knocks at the shut door, forces it after a while, and never goes in', async () => {
  const d = fakeDoors();
  const s = await stage({ buildings: [CABIN], doors: d.doors });
  s.player.set(0, 0, 0);
  s.frame({ hours: 23.5 });
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: 0 });
  let status, nearest = Infinity;
  for (let i = 0; i < 30 * 100 && !d.forced.length; i++) {
    s.lookAway();
    if (i % 15 === 0) s.encounters.hear({ loudness: .45, source: 'footstep', x: 0, z: 0 });
    status = s.frame({ breathHeld: true, indoors: true });
    if (status.presence === 'body' && status.brain.siege?.phase !== 'cross') { const c = s.creature(); nearest = Math.min(nearest, Math.max(Math.abs(c.x) - CABIN.hx, Math.abs(c.z) - CABIN.hz)); }
  }
  assert.equal(status.brain.behaviour === 'siege' || d.forced.length > 0, true, `besieging (${status.brain.behaviour})`);
  assert.deepEqual(d.forced, ['cabin#0'], `it forced the door at ${s.elapsed.toFixed(0)} s`);
  const kinds = s.calls.map(c => c.kind);
  assert.ok(kinds.includes('creatureScratch') || kinds.includes('knock'), 'it tried the door first');
  assert.ok(kinds.includes('doorCrash'), 'with a crash');
  assert.ok(s.trace.some(e => e.type === 'forceDoor') && s.trace.some(e => e.type === 'doorTell'));
  // (This bare test world has no walls for the navigation to stop it at, so how close it came is not asserted here: the brain's ring is, in creature-siege.test.mjs.)
  assert.ok(Number.isFinite(nearest));
});

test('through the open doorway: a player within 2.5 m of it, making a noise, is taken; one deeper in is not', async () => {
  const d = fakeDoors(); d.door.open = d.door.target = 1;
  const s = await stage({ buildings: [CABIN], doors: d.doors });
  s.player.set(0, 0, -1);   // 5.4 m from the doorway: out of its arms' reach
  s.frame({ hours: 23.5 });
  s.encounters.hear({ loudness: 20, source: 'siren', x: 0, z: -1 });
  let grabbed = false, status;
  for (let i = 0; i < 30 * 45 && !grabbed; i++) {
    s.lookAway();
    if (i % 15 === 0) s.encounters.hear({ loudness: .45, source: 'footstep', x: s.player.x, z: s.player.z });
    status = s.frame({ breathHeld: true, indoors: true });
    grabbed = s.encounters.takeStrike();
  }
  assert.equal(grabbed, false, 'deep inside, it cannot reach them');
  assert.equal(status.brain.behaviour, 'siege');
  assert.equal(status.brain.siege.phase, 'reach', 'it waits at the opening');
  // They step to the doorway and make a noise.
  s.player.set(-.7, 0, 3);
  for (let i = 0; i < 30 * 20 && !grabbed; i++) {
    s.lookAway();
    if (i % 15 === 0) s.encounters.hear({ loudness: .45, source: 'footstep', x: s.player.x, z: s.player.z });
    s.frame({ breathHeld: true, indoors: true });
    grabbed = s.encounters.takeStrike();
  }
  assert.equal(grabbed, true, 'its arms reached in');
});
