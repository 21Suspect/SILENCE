import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';

// The torch paints its own textures on canvases; a stand-in that swallows drawing is all it needs here.
const context = new Proxy({}, { get: (_, key) => key === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}, set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
const { createFlashlight } = await import('../../../game/render/props/flashlight.ts');

const make = () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(69, 1.6, .075, 100), clicks = [];
  camera.rotation.order = 'YXZ';
  const torch = createFlashlight(scene, camera, () => 0, { nearby: () => [] }, () => clicks.push('click'));
  const look = (from, at) => { camera.position.copy(from); camera.lookAt(at); camera.updateMatrixWorld(true); };
  return { scene, camera, torch, clicks, look, group: scene.getObjectByName('Bench flashlight') };
};

test('unchanged for WORLD_V2 off: interact() still picks up silently on the old bench, then toggles', () => {
  const { torch, look, scene } = make(), seat = new THREE.Vector3().fromArray(torch.inspect().pickupPosition);
  assert.ok(Math.abs(seat.x + 17.2) < .5 && Math.abs(seat.z + 46.3) < .5, 'the lean-to bench');
  look(new THREE.Vector3(seat.x, seat.y + .6, seat.z + 1.2), seat);
  assert.equal(torch.interact(true), true); assert.equal(torch.inspect().owned, true);
  assert.equal(scene.getObjectByName('Carried flashlight') !== undefined, true);
  assert.equal(torch.interact(true), false, 'E only picks up');
  assert.equal(torch.interact(), true, 'a click switches it');
});

test('interact() cannot pick the torch up from behind or from too far, as before', () => {
  const { torch, look } = make(), seat = new THREE.Vector3().fromArray(torch.inspect().pickupPosition);
  look(new THREE.Vector3(seat.x, seat.y + .6, seat.z + 1.2), seat.clone().add(new THREE.Vector3(0, 0, 5)));
  assert.equal(torch.interact(), false);
  look(new THREE.Vector3(seat.x, seat.y + .6, seat.z + 5), seat);
  assert.equal(torch.interact(), false);
});

test('setSeat moves the resting place, the pickup point and the model, and only while it is still lying there', () => {
  const { torch, group, look } = make(), bench = new THREE.Vector3(-18.4, .95, -41.2);
  torch.setSeat(bench);
  assert.deepEqual(torch.inspect().pickupPosition, bench.toArray());
  assert.deepEqual(group.position.toArray(), bench.toArray());
  bench.set(0, 0, 0); assert.notEqual(torch.inspect().pickupPosition[0], 0, 'it copies, it does not alias');
  const seat = new THREE.Vector3().fromArray(torch.inspect().pickupPosition);
  look(new THREE.Vector3(seat.x, seat.y + .6, seat.z + 1.2), seat);
  assert.equal(torch.canPickNow(), true);
  assert.equal(torch.interact(true), true);
  torch.setSeat(new THREE.Vector3(100, 0, 100));
  assert.notEqual(group.position.x, 100, 'a torch in the hand is not teleported to the bench');
});

test('pickUp, toggle and owned are the split halves that game/render/props/interaction.ts uses', () => {
  const { torch, look } = make(), seat = new THREE.Vector3().fromArray(torch.inspect().pickupPosition);
  assert.equal(torch.owned, false); assert.equal(torch.toggle(), false, 'nothing to switch before it is picked up');
  look(new THREE.Vector3(seat.x, seat.y + .6, seat.z + 1.2), new THREE.Vector3(seat.x, seat.y + .6, seat.z + 9));
  assert.equal(torch.canPickNow(), false, 'canPickNow is the old view-and-reach test, for anything that wants it');
  assert.equal(torch.pickUp(), true, 'but pickUp trusts the caller, which has already done its own check');
  assert.equal(torch.owned, true); assert.equal(torch.canPickNow(), false);
  assert.equal(torch.pickUp(), false);
  assert.equal(torch.toggle(), true);
  assert.equal(torch.toggle(), true);
  assert.equal(torch.interact(), true, 'and the old call still toggles it too');
});

test('a restarted night returns the scanned torch to its bench and clears its light', () => {
  const { torch } = make(), seat = new THREE.Vector3(-18.4, .95, -41.2);
  torch.setSeat(seat);
  torch.devEquip();
  assert.equal(torch.owned, true);
  torch.reset();
  assert.equal(torch.owned, false);
  assert.equal(torch.inspect().on, false);
  assert.deepEqual(torch.inspect().pickupPosition, seat.toArray());
  assert.equal(torch.pickUp(), true);
});
