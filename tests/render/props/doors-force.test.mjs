import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
// The Listener's way at a door: doorsNear, isOpen, the doorway's middle, and force (a bar breaks, the leaf is flung open, a crash is reported).
import '../../helpers/register-ts-hooks.mjs';
const { createDoors, DOOR_SECONDS, DOOR_NOISE, FORCED_SPEED } = await import('../../../game/render/props/doors.ts');
const { createPois } = await import('../../../game/render/props/pois.ts');
const { createCollisionWorld } = await import('../../../game/sim/world/collision.ts');
{ const warn = console.warn; console.warn = (...args) => { if (!String(args[0]).startsWith('SILENCE:')) warn(...args); }; }

const leaf = { url: '/world/door.glb', radius: 1.2, colliders: [] };
/** Hinge at the building's origin, shut along +x; swung open it stands along +z. */
const spec = { asset: 'door', hinge: [0, 0, 0], yaw: 0, swing: -Math.PI / 2, width: .9, height: 2.1, thickness: .05, start: 0 };
const hut = { url: '/world/hut.glb', radius: 5, colliders: [], doors: [spec] };

function rig(placements = [{ id: 'b', asset: 'hut', x: 10, z: 20, yaw: 0 }]) {
  const world = createCollisionWorld(), scene = new THREE.Scene();
  const load = () => Promise.resolve({ scene: new THREE.Group() });
  const pois = createPois(scene, () => 0, world, { assets: { hut, door: leaf }, placements, scatter: [], load });
  const noises = [], doors = createDoors({ pois, collisions: world, onNoise: e => noises.push(e), barrable: () => true, indoors: () => true });
  const player = { x: 100, y: 0, z: 100 };
  const run = (seconds, dt = 1 / 60) => { for (let t = 0; t < seconds - 1e-9; t += dt) doors.update({ dt, player }); };
  return { doors, noises, run };
}

test('a door says where its doorway is, whatever the leaf is doing', () => {
  const r = rig(), shut = r.doors.get('b#0').mid;
  assert.ok(Math.abs(shut.x - 10.45) < 1e-9 && Math.abs(shut.z - 20) < 1e-9, 'the middle of the shut leaf');
  r.doors.set('b#0', 1);
  assert.deepEqual(r.doors.get('b#0').mid, shut, 'open, the doorway has not moved');
  assert.ok(Math.hypot(r.doors.get('b#0').tip.x - shut.x, r.doors.get('b#0').tip.z - shut.z) > .3, 'though the leaf has');
});

test('doorsNear lists the doors within a radius of the doorway, nearest first; isOpen counts one on its way open', () => {
  const r = rig([{ id: 'a', asset: 'hut', x: 0, z: 0, yaw: 0 }, { id: 'b', asset: 'hut', x: 6, z: 0, yaw: 0 }, { id: 'c', asset: 'hut', x: 60, z: 0, yaw: 0 }]);
  assert.deepEqual(r.doors.doorsNear(7, 0, 8).map(d => d.placement), ['b', 'a']);
  assert.deepEqual(r.doors.doorsNear(0, 0, 3).map(d => d.placement), ['a']);
  assert.deepEqual(r.doors.doorsNear(300, 300, 10), []);
  assert.equal(r.doors.isOpen('a#0'), false);
  r.doors.toggle('a#0');
  assert.equal(r.doors.isOpen('a#0'), true, 'heading open already counts');
  assert.equal(r.doors.isOpen('nope'), false);
});

test('force: a shut unbarred door is flung open several times faster than a hand opens it, with a crash for the noise stream', () => {
  const r = rig();
  assert.equal(r.doors.force('b#0'), true);
  assert.equal(r.noises.length, 1);
  assert.equal(r.noises[0].forced, true); assert.equal(r.noises[0].loudness, DOOR_NOISE.forced); assert.equal(r.noises[0].id, 'b#0');
  assert.ok(DOOR_NOISE.forced > DOOR_NOISE.open, 'a crash is louder than a hand on the latch');
  r.run(DOOR_SECONDS / FORCED_SPEED + .05);
  assert.equal(r.doors.get('b#0').open, 1, 'fully open in a fraction of the hand speed');
  // A hand takes the full DOOR_SECONDS.
  const h = rig(); h.doors.toggle('b#0'); h.run(DOOR_SECONDS / FORCED_SPEED + .05);
  assert.ok(h.doors.get('b#0').open < 1, 'a hand is slower');
});

test('force: a barred door loses its bar for good, and opens; an open door is left alone', () => {
  const r = rig();
  assert.equal(r.doors.setBar('b#0', true), true);
  assert.equal(r.doors.toggle('b#0'), true); r.run(1);
  assert.equal(r.doors.get('b#0').closed, true, 'a barred door will not open to a hand');
  assert.equal(r.doors.force('b#0'), true);
  assert.equal(r.doors.isBarred('b#0'), false, 'the bar is broken');
  r.run(.6);
  assert.equal(r.doors.get('b#0').open, 1);
  const before = r.noises.length;
  assert.equal(r.doors.force('b#0'), false, 'nothing to force once it stands open');
  assert.equal(r.noises.length, before, 'and no second crash');
  assert.equal(r.doors.force('missing'), false);
});

test('force does not stay fast: the next hand on the door swings it at the normal speed, and a restart puts it back silently', () => {
  const r = rig();
  r.doors.force('b#0'); r.run(.5);
  r.doors.toggle('b#0'); r.run(DOOR_SECONDS / FORCED_SPEED + .05);
  assert.ok(r.doors.get('b#0').open > 0, 'a hand closes it at hand speed (still on its way)');
  r.doors.reset();
  assert.equal(r.doors.get('b#0').open, 0); assert.equal(r.doors.isBarred('b#0'), false);
});
