import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { createBicycleView, CAMERA_ROLL } = await import('../../../game/render/props/bicycle.ts');
const { BIKE } = await import('../../../game/render/props/bicycle-math.ts');

const model = () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshStandardMaterial())); return Promise.resolve({ scene: g }); };
const make = (ground = () => 0) => { const scene = new THREE.Scene(); const view = createBicycleView({ scene, ground, load: model }); return { scene, view }; };
const state = (o = {}) => ({ mounted: true, x: 10, z: 20, heading: 0, speed: 0, steer: 0, throttle: 0, brake: 0, ...o });
const run = (view, seconds, o, dt = 1 / 60) => { let s = o; for (let t = 0; t < seconds - 1e-9; t += dt) view.update(dt, typeof o === 'function' ? o(t) : o); };

test('the parts are assembled once the models arrive: frame, fork with its wheel, rear wheel, cranks', async () => {
  const { scene, view } = make(); await view.ready;
  assert.equal(view.loaded, true);
  assert.ok(scene.getObjectByName('Bicycle'));
  for (const n of ['Bicycle fork', 'Bicycle front wheel', 'Bicycle rear wheel', 'Bicycle crank']) assert.ok(scene.getObjectByName(n), n);
  assert.equal(scene.getObjectByName('Bicycle front wheel').parent, scene.getObjectByName('Bicycle fork'), 'the front wheel turns with the fork');
});

test('the wheels turn by distance over radius and the cranks by the gearing while pedalling only', () => {
  const { view } = make();
  run(view, 2, state({ speed: 5, throttle: 1 }));
  const wheel = 5 * 2 / BIKE.wheelRadius;
  assert.ok(Math.abs(view.wheelAngle - wheel) < 1e-6, `${view.wheelAngle} vs ${wheel}`);
  assert.ok(Math.abs(view.crankAngle - wheel / BIKE.gear) < 1e-6);
  const cranks = view.crankAngle;
  run(view, 1, state({ speed: 5, throttle: 0 }));
  assert.equal(view.crankAngle, cranks, 'coasting: the cranks stand still');
  run(view, 1, state({ speed: 5, throttle: 1, brake: 1 }));
  assert.equal(view.crankAngle, cranks, 'braking: the cranks stand still');
  assert.ok(view.wheelAngle > wheel + 5 / BIKE.wheelRadius * 1.9, 'the wheels kept turning');
});

test('the bars turn to the steering, less at speed', () => {
  const slow = make(), fast = make();
  run(slow.view, 1, state({ speed: .01, steer: 1 }));
  run(fast.view, 1, state({ speed: 5.4, steer: 1 }));
  assert.ok(Math.abs(slow.view.steer - BIKE.maxSteer) < .02, String(slow.view.steer));
  assert.ok(fast.view.steer > .1 && fast.view.steer < slow.view.steer / 2);
  const fork = slow.scene.getObjectByName('Bicycle fork');
  assert.ok(Math.abs(fork.quaternion.angleTo(new THREE.Quaternion()) - slow.view.steer) < 1e-6, 'the fork is turned by that angle about its axis');
});

test('it leans into a left turn (to its left, the model\'s +x side) and the camera takes 60 % of it', () => {
  const { scene, view } = make();
  run(view, 3, t => state({ speed: 5.4, throttle: 1, heading: .6 * t, steer: 1 }));
  assert.ok(view.lean > .2 && view.lean < BIKE.maxLean + 1e-9, String(view.lean));
  assert.ok(Math.abs(view.roll - view.lean * CAMERA_ROLL) < 1e-12);
  const root = scene.getObjectByName('Bicycle');
  const top = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, root.rotation.z)));
  assert.ok(top.x > 0, 'the top of the bike moves toward +x, its left');
  run(view, 3, state({ speed: 5.4, throttle: 1, heading: 1.8 * 3 }));
  assert.ok(Math.abs(view.lean) < .02, 'straight again, upright');
});

test('both wheels stand on the ground: pitched along a slope, set at the mean height', () => {
  const { scene, view } = make((x, z) => .25 * z);
  run(view, 1, state({ mounted: false }));
  view.park(0, 5, 0); run(view, 1, state({ mounted: false, x: 0, z: 5 }));
  const root = scene.getObjectByName('Bicycle');
  assert.ok(Math.abs(root.rotation.x + Math.atan2(.25 * BIKE.wheelbase, BIKE.wheelbase)) < 1e-3, 'nose up the slope');
  assert.ok(Math.abs(root.position.y - 1.25) < .01);
  assert.equal(view.roll, 0, 'parked: no camera roll');
});

test('the eye is above the saddle, a little behind the bars, and turns with the bike', () => {
  const { view } = make();
  run(view, 1, state({ heading: 0, speed: 0 }));
  const eye = view.eye();
  // heading 0 is the player's yaw 0: facing -z, so the model's yaw is pi and its +z (forward) points to -z.
  assert.ok(Math.abs(eye.x - 10) < 5e-3 && eye.y > 1.5 && eye.y < 1.9, JSON.stringify(eye));
  assert.ok(eye.z > 20 - .4 && eye.z < 20 + .6, 'near the saddle, over the middle of the bike');
  const ahead = new THREE.Vector3(); view.rackPoint(ahead);
  assert.ok(ahead.z > 20, 'the rack is behind the bike: toward +z when the bike points to -z');
});
