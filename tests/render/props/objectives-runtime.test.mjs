import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
const { createObjectivesRuntime } = await import('../../../game/render/props/objectives-runtime.ts');

// The places the runtime looks for, each a hook on an asset, matching the names in the brief.
const placements = ['mine', 'lookout', 'logstack', 'camp', 'generator', 'hut', 'mast'].map((asset, i) => ({ id: `p-${asset}`, asset, x: i * 50, z: 10 }));
const hooks = {
  mine: { fuse: [0, 1, 0] }, lookout: { fuse: [50, 1, 10] }, logstack: { fuse: [100, 1, 10] }, camp: { jerrycan: [150, 1, 10] },
  generator: { pullcord: [200, 1, 10] }, hut: { fusebox: [250, 1.4, 10], radio: [251, 1.2, 10], window: [252, 1.5, 12] }, mast: { beacon: [300, 25, 10] },
};
const fakePois = (table = hooks) => ({
  hook: (id, name) => { const asset = id.slice(2), h = table[asset]?.[name]; return h ? new THREE.Vector3(...h) : undefined; },
  object: () => undefined,
});
const setup = (over = {}) => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(69, 1.6, .075, 100), registered = new Map();
  camera.position.set(0, 1.7, 0); camera.updateMatrixWorld(true);
  const rt = createObjectivesRuntime({
    scene, camera, heightAt: () => 0, placements, pois: fakePois(over.table), load: () => new Promise(() => {}),
    interaction: { register: item => { registered.set(item.id, item); return () => registered.delete(item.id); } },
  });
  return { rt, scene, camera, registered, label: id => { const l = registered.get(id).label; return typeof l === 'function' ? l() : l; }, ok: id => registered.get(id).enabled(), use: id => registered.get(id).activate() };
};
const wait = () => new Promise(resolve => setTimeout(resolve, 0));

test('one prompt per pickup and station is registered, at the hooks the assets provide', () => {
  const { registered, rt } = setup();
  assert.deepEqual([...registered.keys()].sort(), ['generator:cord', 'hut:fusebox', 'hut:radio', 'pickup:fuse-logstack', 'pickup:fuse-lookout', 'pickup:fuse-mine', 'pickup:jerry-camp']);
  assert.deepEqual(registered.get('generator:cord').position.toArray(), [200, 1, 10]);
  assert.deepEqual(registered.get('pickup:jerry-camp').position.toArray(), [150, 1.22, 10], 'aimed a hand above the base of the can');
  assert.deepEqual(registered.get('pickup:fuse-mine').position.toArray(), [0, 1.08, 0]);
  assert.equal(rt.state.phase, 'gather');
});

test('missing hooks are reported once, in one line, and the rest still works', () => {
  const logs = [], original = console.warn; console.warn = m => logs.push(m);
  try {
    const { registered } = setup({ table: { ...hooks, camp: {}, hut: { fusebox: [250, 1.4, 10] }, mast: {} } });
    assert.equal(logs.length, 1); assert.match(logs[0], /camp\.jerrycan/); assert.match(logs[0], /hut\.radio/); assert.match(logs[0], /mast\.beacon/);
    assert.equal(registered.has('pickup:jerry-camp'), false); assert.equal(registered.has('hut:radio'), false); assert.equal(registered.has('hut:fusebox'), true);
  } finally { console.warn = original; }
});

test('the whole loop plays through the prompts, with the right words at each step', () => {
  const { rt, label, ok, use } = setup();
  assert.equal(label('pickup:jerry-camp'), 'Left click to pick up');
  assert.deepEqual(['generator:cord', 'hut:fusebox', 'hut:radio'].map(ok), [true, false, false], 'only the cord can be tried with empty hands');
  assert.equal(label('generator:cord'), 'Left click to pull the cord');
  use('generator:cord');
  assert.equal(rt.state.generator.running, false, 'a dry pull goes nowhere');

  use('pickup:jerry-camp');
  assert.equal(rt.state.carrying.local, 'jerry-camp');
  assert.equal(label('pickup:fuse-mine'), 'Hands full'); assert.equal(ok('pickup:jerry-camp'), false, 'what you hold is not offered again');
  use('pickup:fuse-mine'); assert.equal(rt.state.items['fuse-mine'].status, 'world', 'refused, nothing dropped for you');
  assert.equal(label('generator:cord'), 'Left click to refuel');
  use('generator:cord'); assert.equal(rt.state.phase, 'fueled');
  assert.equal(label('generator:cord'), 'Left click to pull the cord');
  use('generator:cord'); assert.equal(rt.state.phase, 'running'); assert.equal(ok('generator:cord'), false, 'nothing left to do at the generator');

  use('pickup:fuse-mine');
  assert.equal(ok('hut:fusebox'), true); assert.equal(label('hut:fusebox'), 'Left click to insert fuse');
  use('hut:fusebox'); assert.deepEqual(rt.state.fuseBox, ['fuse-mine', null, null]);
  assert.equal(ok('hut:fusebox'), false);
  use('pickup:fuse-lookout'); use('hut:fusebox'); use('pickup:fuse-logstack');
  assert.equal(ok('hut:radio'), false, 'the box is not full yet');
  use('hut:fusebox');
  assert.deepEqual(rt.state.fuseBox, ['fuse-mine', 'fuse-lookout', 'fuse-logstack']);
  assert.equal(rt.state.phase, 'powered'); assert.equal(ok('hut:radio'), true); assert.equal(label('hut:radio'), 'Left click to transmit');
  use('hut:radio');
  assert.equal(rt.state.phase, 'signalSent');
  assert.deepEqual(['generator:cord', 'hut:fusebox', 'hut:radio', 'pickup:jerry-camp', 'pickup:fuse-mine'].map(ok), [false, false, false, false, false]);
});

test('with the generator off, the fuse box says so rather than doing nothing', () => {
  const { rt, label, ok, use } = setup();
  use('pickup:fuse-mine');
  assert.equal(ok('hut:fusebox'), true); assert.equal(label('hut:fusebox'), 'No power');
  use('hut:fusebox'); assert.equal(rt.state.fuseBox[0], null);
});

test('noise events reach subscribers with a world position, which is what the creature will listen to', () => {
  const { rt, use } = setup(), heard = [];
  const off = rt.subscribe(e => heard.push(e));
  use('pickup:jerry-camp'); use('generator:cord'); use('generator:cord');
  const noise = heard.filter(e => e.type === 'noise');
  assert.deepEqual(noise.map(n => n.source), ['pickup', 'refuel', 'generator-start']);
  const start = noise.at(-1);
  assert.ok(start.loudness >= .9 && start.x === 200 && start.z === 10, JSON.stringify(start));
  assert.deepEqual([noise[0].x, noise[0].z], [150, 10], 'picking the can up is heard at the camp');
  off(); use('pickup:fuse-mine'); assert.equal(heard.filter(e => e.type === 'noise').length, 3, 'unsubscribed');
});

test('dispatch takes plain JSON, so a remote player can drive it too; setState adopts a snapshot', () => {
  const { rt, use, label } = setup();
  const events = rt.dispatch({ type: 'pickup', player: 'someone-else', item: 'jerry-camp' });
  assert.equal(events[0].type, 'picked-up');
  assert.equal(rt.state.carrying['someone-else'], 'jerry-camp');
  assert.equal(label('pickup:fuse-mine'), 'Left click to pick up', 'my hands are still empty');
  const snapshot = JSON.parse(JSON.stringify(rt.state));
  const other = setup(); other.rt.setState(snapshot);
  assert.deepEqual(other.rt.state, rt.state);
  other.rt.dispatch({ type: 'refuel', player: 'someone-else' }); assert.equal(other.rt.state.generator.fuel, true);
});

const visible = (scene, name) => { let v; scene.traverse(o => { if (o.name === name) v = o.visible; }); return v; };

test('pickups are drawn where they lie, vanish when taken, and the held one rides in the left hand', () => {
  const { rt, scene, camera, use } = setup();
  const group = id => scene.getObjectByName(`Pickup ${id}`);
  assert.equal(group('fuse-mine').visible, true);
  assert.deepEqual(group('fuse-mine').position.toArray(), [0, 1, 0]);
  assert.equal(rt.update(0), true, 'placing them dirtied the shadows');
  assert.equal(rt.update(.1), false);
  use('pickup:fuse-mine');
  assert.equal(rt.update(.2), true);
  assert.equal(group('fuse-mine').visible, true, 'still visible: it is in my hand');
  assert.ok(group('fuse-mine').position.distanceTo(camera.position) < .8 && group('fuse-mine').position.x < camera.position.x, 'in view, to the left');
  group('fuse-mine').traverse(o => { if (o.isMesh) assert.equal(o.castShadow, false, 'a carried thing casts no shadow'); });
  assert.equal(group('jerry-camp').visible, true, 'the others stay put');
  // Put it down ahead of the player, on the deck they stand on rather than the ground below it.
  camera.rotation.set(0, 0, 0); camera.updateMatrixWorld(true);
  assert.equal(rt.dropHeld(new THREE.Vector3(10, .42, 20), new THREE.Vector3(0, 0, -1)), true);
  assert.equal(rt.state.carrying.local, undefined);
  assert.deepEqual(group('fuse-mine').position.toArray().map(v => +v.toFixed(3)), [10, .42, 19.2]);
  assert.equal(rt.dropHeld(new THREE.Vector3(10, .42, 20), new THREE.Vector3(0, 0, -1)), false, 'nothing in hand to drop');
});

test('a dropped item is offered again where it lies, and picking it up clears the spot', () => {
  const { rt, registered, use } = setup();
  use('pickup:jerry-camp');
  rt.dropHeld(new THREE.Vector3(5, 0, 5), new THREE.Vector3(1, 0, 0));
  assert.deepEqual(registered.get('pickup:jerry-camp').position.toArray().map(v => +v.toFixed(3)), [5.8, .22, 5]);
  assert.equal(registered.get('pickup:jerry-camp').enabled(), true);
  use('pickup:jerry-camp'); assert.equal(rt.state.carrying.local, 'jerry-camp');
});

test('a running generator lights the beacon and the window; both are dark and hidden until then', () => {
  const { rt, scene, use } = setup();
  assert.equal(visible(scene, 'Generator light'), false);
  const lights = () => { const r = []; scene.traverse(o => { if (o.name === 'Generator light') r.push(o); }); return r; };
  assert.equal(lights().length, 2);
  assert.ok(lights().every(l => !l.visible));
  use('pickup:jerry-camp'); use('generator:cord'); use('generator:cord');
  rt.update(0);
  assert.ok(lights().every(l => l.visible));
  const beacon = lights().find(l => l.position.y === 25), opacities = [];
  for (let t = 0; t < 3; t += .05) { rt.update(t); opacities.push(beacon.material.opacity); }
  assert.ok(Math.max(...opacities) > .95 && Math.min(...opacities) < .1, 'it flashes');
  const bright = opacities.filter(o => o > .5).length / opacities.length;
  assert.ok(bright > .1 && bright < .35, `a short flash, a long dark: ${bright.toFixed(2)}`);
  assert.equal(beacon.material.color.getHex(), 0xff2a1a, 'aircraft-warning red');
  const window = lights().find(l => l.position.y === 1.5); assert.ok(window.material.opacity > .4 && window.material.opacity < .8);
});

test('a hut material called "glow" is switched on with the generator, and reset on dispose', async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), registered = new Map();
  const lamp = new THREE.MeshStandardMaterial({ name: 'window glow', emissive: 0xffaa55, emissiveIntensity: 0 }), wall = new THREE.MeshStandardMaterial({ name: 'wall', emissive: 0x000000 });
  const hut = new THREE.Group(); hut.add(new THREE.Mesh(new THREE.BoxGeometry(), lamp), new THREE.Mesh(new THREE.BoxGeometry(), wall));
  let loaded = false;
  const pois = { hook: fakePois().hook, object: id => loaded && id === 'p-hut' ? hut : undefined };
  const rt = createObjectivesRuntime({ scene, camera, heightAt: () => 0, placements, pois, load: () => new Promise(() => {}), interaction: { register: i => { registered.set(i.id, i); return () => {}; } } });
  registered.get('pickup:jerry-camp').activate(); registered.get('generator:cord').activate(); registered.get('generator:cord').activate();
  rt.update(0); assert.equal(lamp.emissiveIntensity, 0, 'the hut has not streamed in yet');
  loaded = true; rt.update(1);
  assert.ok(lamp.emissiveIntensity >= 1.6, 'lit as soon as it appears'); assert.equal(wall.emissiveIntensity, 1, 'other materials are left alone');
  rt.dispose(); assert.equal(lamp.emissiveIntensity, 0);
});

test('placeholders stand in until the GLB arrives, then are swapped for it', async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), asked = [];
  const fuseModel = new THREE.Group(); fuseModel.name = 'the real fuse'; fuseModel.add(new THREE.Mesh(new THREE.BoxGeometry(.01, .01, .01), new THREE.MeshBasicMaterial()));
  createObjectivesRuntime({ scene, camera, heightAt: () => 0, placements, pois: fakePois(), interaction: { register: () => () => {} },
    load: url => { asked.push(url); return url.includes('fuse') ? Promise.resolve({ scene: fuseModel }) : Promise.reject(new Error('404')); } });
  const names = id => scene.getObjectByName(`Pickup ${id}`).children.map(c => c.name || c.type);
  assert.deepEqual(names('fuse-mine'), ['Group'], 'the placeholder, straight away');
  await wait(); await wait();
  assert.deepEqual([...new Set(asked)].sort(), ['/world/fuse.glb', '/world/jerrycan.glb'], 'each model is fetched once however many pickups use it');
  assert.equal(asked.filter(u => u.includes('fuse')).length, 1);
  assert.deepEqual(names('fuse-lookout'), ['the real fuse']); assert.deepEqual(names('fuse-mine'), ['the real fuse']);
  assert.deepEqual(names('jerry-camp'), ['Group'], 'a failed model keeps its placeholder');
});

test('dispose removes everything it added', () => {
  const { rt, scene, registered } = setup();
  assert.ok(scene.children.length > 0 && registered.size > 0);
  rt.dispose(); assert.equal(scene.children.length, 0); assert.equal(registered.size, 0);
});
