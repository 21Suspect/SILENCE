import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
// game/render/props/world-v2.ts uses extensionless and JSON imports that only the bundler understands.
import '../../helpers/register-ts-hooks.mjs';
const { createWorldV2, indoorsAt, cabinWakePoint, bedPlan, bedWakePoint, splashLoudness, GENERATOR_HUM } = await import('../../../game/render/props/world-v2.ts');
const { createCollisionWorld } = await import('../../../game/sim/world/collision.ts');
const { POI_PLACEMENTS, placeLocal } = await import('../../../game/sim/world/world-layout.ts');
const { initialState } = await import('../../../game/sim/objectives/objectives.ts');

// The rebuilt world's wiring, with stand-ins for the DOM, flashlight and camera (as in tests/sim/player/ladders.test.mjs).
function makeWorld() {
  const element = () => ({ style: {}, textContent: '', setAttribute() {}, addEventListener() {}, remove() {} });
  const container = { ownerDocument: { createElement: element }, appendChild() {} };
  const camera = new THREE.PerspectiveCamera(69, 1.6, .075, 1800); camera.rotation.order = 'YXZ';
  const scene = new THREE.Scene(), collisions = createCollisionWorld(), warn = console.warn; console.warn = () => {};
  const flashlight = { owned: true, setSeat() {}, pickUp: () => true, inspect: () => ({ pickupPosition: [0, 0, 0] }) };
  const world = createWorldV2({ scene, camera, container, heightAt: () => 0, collisions, flashlight, viewHeight: () => 720, riverX: () => 1e6, exclusion: () => 0 });
  const player = new THREE.Vector3(), heard = [];
  const unsubscribe = world.noise.subscribe(e => heard.push(e));
  let time = 0;
  const frame = (dt = 1 / 30) => { time += dt; world.update({ dt, time, player, darkness: 0, active: true, simulate: true }); };
  return { world, player, heard, frame, unsubscribe, restore: () => { console.warn = warn; world.dispose(); } };
}

test('one noise stream: what the engine emits (footsteps, the torch) reaches the creature with its position', () => {
  const w = makeWorld();
  try {
    w.world.noise.emit({ type: 'noise', loudness: .13, source: 'footstep', x: 3, z: -4 });
    assert.deepEqual(w.heard.at(-1), { type: 'noise', loudness: .13, source: 'footstep', x: 3, z: -4 });
    // The objectives' own noises go to the same listeners, given a place.
    // The seed lays the parts: a can of fuel is wherever it was put this run.
    w.world.debug.dispatch({ type: 'pickup', player: 'local', item: Object.keys(w.world.debug.state.items).find(id => w.world.debug.state.items[id].kind === 'jerry') });
    const pickup = w.heard.at(-1);
    assert.equal(pickup.source, 'pickup'); assert.ok(Number.isFinite(pickup.x) && Number.isFinite(pickup.z));
    w.unsubscribe(); w.world.noise.emit({ type: 'noise', loudness: 1, source: 'footstep', x: 0, z: 0 });
    assert.equal(w.heard.at(-1), pickup, 'unsubscribed');
  } finally { w.restore(); }
});

test('a running generator hums into the stream every few seconds, from where it stands; a stopped one is silent', () => {
  const w = makeWorld();
  try {
    for (let i = 0; i < 30 * 20; i++) w.frame();
    assert.equal(w.heard.filter(e => e.source === 'generator').length, 0);
    w.world.debug.objectives.setState({ ...initialState(), generator: { fuel: true, running: true }, phase: 'running' });
    for (let i = 0; i < 30 * 22; i++) w.frame();
    const hums = w.heard.filter(e => e.source === 'generator');
    assert.equal(hums.length, Math.floor(22 / GENERATOR_HUM.every));
    const generator = POI_PLACEMENTS.find(p => p.asset === 'generator');
    for (const hum of hums) {
      assert.equal(hum.loudness, GENERATOR_HUM.loudness);
      assert.ok(Math.hypot(hum.x - generator.x, hum.z - generator.z) < 4, 'at the generator');
    }
    w.world.restart();
    assert.equal(w.world.debug.state.generator.running, false, 'a restarted night stops it');
  } finally { w.restore(); }
});

test('indoors means inside a roofed building, not on its porch; the wake point is just out from the cabin door', () => {
  const cabin = POI_PLACEMENTS.find(p => p.id === 'cabin');
  const [cx, cz] = placeLocal(cabin, cabin.footprint.cx, cabin.footprint.cz);
  assert.equal(indoorsAt(cx, cz), true);
  const [ox, oz] = placeLocal(cabin, cabin.footprint.cx, cabin.footprint.cz + cabin.footprint.hz + 1);
  assert.equal(indoorsAt(ox, oz), false);
  assert.equal(indoorsAt(cabin.x + 200, cabin.z + 200), false);
  const wake = cabinWakePoint();
  assert.equal(indoorsAt(wake.x, wake.z), false);
  assert.ok(Math.hypot(wake.x - cabin.x, wake.z - cabin.z) < 12, 'beside the cabin');
  // A camera with this yaw looks along (-sin, -cos): toward the cabin.
  const look = { x: -Math.sin(wake.yaw), z: -Math.cos(wake.yaw) }, to = { x: cabin.x - wake.x, z: cabin.z - wake.z };
  assert.ok((look.x * to.x + look.z * to.z) / Math.hypot(to.x, to.z) > .99, 'facing it');
});

test('the player wakes by the bed: inside the cabin, clear of every solid, facing the room; the generator hum is kept up at 150 m; a splash is about 45 m', async () => {
  const cabin = POI_PLACEMENTS.find(p => p.id === 'cabin'), bed = bedPlan(), wake = bedWakePoint();
  assert.ok(bed); assert.deepEqual(wake, bed.stand);
  assert.equal(indoorsAt(wake.x, wake.z), true);
  assert.ok(Math.hypot(wake.x - bed.x, wake.z - bed.z) > 1 && Math.hypot(wake.x - bed.x, wake.z - bed.z) < 2.5, 'beside the bed');
  const { solidContact } = await import('../../../game/sim/world/collision.ts');
  const assets = (await import('../../../game/data/world-assets.json')).default.cabin;
  // The cabin's colliders are in its own frame: put the wake point back into it and test the body (.24 m) against every solid that reaches head height.
  const c = Math.cos(cabin.yaw), s = Math.sin(cabin.yaw), dx = wake.x - cabin.x, dz = wake.z - cabin.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
  for (const col of assets.colliders) if (col.minY < 1.7 && col.maxY > .6 && col.tag !== 'cabin floor') assert.ok(solidContact(col, lx, lz, .24).depth <= 0, `standing inside "${col.tag}"`);
  const look = { x: -Math.sin(wake.yaw), z: -Math.cos(wake.yaw) }, toRoom = { x: cabin.x - wake.x, z: cabin.z - wake.z };
  assert.ok((look.x * toRoom.x + look.z * toRoom.z) / Math.hypot(toRoom.x, toRoom.z) > .7, 'looking into the room, not at a wall');
  assert.equal(GENERATOR_HUM.loudness, 1.5); assert.equal(GENERATOR_HUM.sustained, true);
  assert.ok(Math.abs(splashLoudness(.5) - .375) < 1e-9 && splashLoudness(1) <= .6 && splashLoudness(.18) >= .25);
});
