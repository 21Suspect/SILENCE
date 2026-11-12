import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
// game/render/props/pois.ts uses extensionless and JSON imports that only the bundler understands.
import '../../helpers/register-ts-hooks.mjs';
const { doorPose, doorProblem, createDoors, DOOR_SECONDS, DOOR_CLOSED, DOOR_NOISE } = await import('../../../game/render/props/doors.ts');
const { createPois } = await import('../../../game/render/props/pois.ts');
const { createCollisionWorld, solidContact, moveCharacter } = await import('../../../game/sim/world/collision.ts');
const { lineOfSight, promptText } = await import('../../../game/render/props/interaction.ts');
const { doorTestPlacements } = await import('../../../game/dev/door-test.ts');
const { createWorldV2 } = await import('../../../game/render/props/world-v2.ts');
const shipped = (await import('../../../game/data/world-assets.json')).default;
// A door whose GLB cannot load, or an asset nobody listed, is warned about on purpose; the output is not what these test.
{ const warn = console.warn; console.warn = (...args) => { if (!String(args[0]).startsWith('SILENCE:')) warn(...args); }; }

const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const UP = new THREE.Vector3(0, 1, 0);

// --- the pure transform ------------------------------------------------------------------------------

/** The ground truth: a leaf is a child object of the placed model, at the hinge, turned about Y; ask three.js where a leaf-local point lands. */
function truth(p, ground, q, spec, open, local) {
  const parent = new THREE.Object3D(); parent.position.set(p.x, ground, p.z); parent.scale.setScalar(p.scale ?? 1);
  if (q) parent.quaternion.copy(q); else parent.rotation.y = p.yaw;
  const leaf = new THREE.Object3D(); leaf.position.set(...spec.hinge); leaf.rotation.y = spec.yaw + open * spec.swing; parent.add(leaf);
  parent.updateMatrixWorld(true);
  return leaf.localToWorld(local.clone());
}
const close = (a, b, label = '') => assert.ok(a.distanceTo(b) < 1e-9, `${label} ${a.toArray().map(v => v.toFixed(4))} vs ${b.toArray().map(v => v.toFixed(4))}`);
const door = (over = {}) => ({ asset: 'door_steel', hinge: [-.45, .1, 2], yaw: 0, swing: 1.85, width: .9, height: 2.1, thickness: .05, ...over });

test('the leaf stands at its hinge and runs along its own +x, exactly as three.js turns a child about Y (hinge at either jamb, yaw 0 and pi, both swing signs, any placement yaw)', () => {
  for (const placementYaw of [0, 1.1, -2.2]) for (const scale of [undefined, 2.5]) for (const [hinge, yaw] of [[[-.45, .1, 2], 0], [[.45, .1, 2], Math.PI]]) for (const swing of [1.85, -1.85]) for (const open of [0, .3, 1]) {
    const p = { id: 'b', x: 12, z: -30, yaw: placementYaw, scale }, spec = door({ hinge, yaw, swing }), pose = doorPose(p, 7, undefined, spec, open), s = scale ?? 1;
    const label = `placement ${placementYaw}, hinge ${hinge[0]}, swing ${swing}, open ${open}`;
    close(pose.position, truth(p, 7, undefined, spec, open, new THREE.Vector3()), `${label} hinge`);
    close(pose.tip, truth(p, 7, undefined, spec, open, new THREE.Vector3(.9, 0, 0)), `${label} tip`);
    const along = Math.max(.45, Math.min(.9 - .12, .9 * .85));
    close(pose.handle, truth(p, 7, undefined, spec, open, new THREE.Vector3(along, 1.05, 0)), `${label} handle`);
    assert.ok(near(pose.yaw, placementYaw + yaw + open * swing), `${label}: world rotation.y is the three angles added`);
    assert.ok(near(pose.scale, s) && near(pose.direction.length(), 1));
    // The object the engine would stand there turns the same way: its own point (width, 0, 0) lands on the tip.
    const object = new THREE.Object3D(); object.position.copy(pose.position); object.quaternion.copy(pose.quaternion); object.scale.setScalar(pose.scale); object.updateMatrixWorld(true);
    close(object.localToWorld(new THREE.Vector3(.9, 0, 0)), pose.tip, `${label} object`);
  }
});

test('shut, a leaf hinged on the left jamb (yaw 0) and one on the right (yaw pi) fill the same doorway; opened, they swing to opposite ends', () => {
  const p = { x: 0, z: 0, yaw: 0 }, left = door({ hinge: [-.45, 0, 0], yaw: 0, swing: -1.6 }), right = door({ hinge: [.45, 0, 0], yaw: Math.PI, swing: 1.6 });
  const a = doorPose(p, 0, undefined, left, 0), b = doorPose(p, 0, undefined, right, 0);
  assert.ok(near(a.collider.x, 0) && near(b.collider.x, 0) && near(a.collider.z, 0, 1e-12) && near(b.collider.z, 0, 1e-12), 'both centred in the doorway');
  assert.ok(near(a.collider.halfX, .45) && near(b.collider.halfX, .45));
  assert.ok(near(a.tip.x, .45) && near(b.tip.x, -.45), 'each reaches the other jamb');
  // Fully open both stand across the doorway, on the side their hinge turns them to.
  const ao = doorPose(p, 0, undefined, left, 1), bo = doorPose(p, 0, undefined, right, 1);
  assert.ok(near(ao.tip.x, -.45 + .9 * Math.cos(-1.6), 1e-9) && ao.tip.z > .85, 'left hinge, negative swing: out to +z');
  assert.ok(near(bo.tip.x, .45 + .9 * Math.cos(Math.PI + 1.6), 1e-9) && bo.tip.z > .85, 'right hinge, positive swing: also out to +z');
  const flipped = doorPose(p, 0, undefined, { ...left, swing: 1.6 }, 1);
  assert.ok(flipped.tip.z < -.85, 'the sign of swing decides which way it opens');
  // Yaw 0 and pi are the same leaf seen from opposite hinges: same shut collider box, so the doorway is blocked the same way.
  assert.ok(near(Math.abs(Math.cos(a.collider.yaw - b.collider.yaw)), 1) && near(a.collider.halfZ, b.collider.halfZ));
});

test('the collider box: centred half a leaf from the hinge along it, thickness plus a small pad, correct yaw convention, hinge to head height', () => {
  const eps = 1e-3;
  for (const placementYaw of [0, 1.1, -2.2, Math.PI]) for (const hingeAt of [[-.45, 0, 0], [.45, 0, 0]]) for (const open of [0, .4, 1]) {
    const p = { x: 3, z: -4, yaw: placementYaw }, spec = door({ hinge: hingeAt, yaw: hingeAt[0] < 0 ? 0 : Math.PI, swing: hingeAt[0] < 0 ? -1.6 : 1.6, thickness: .05 }), ground = 6.5;
    const { collider: c } = doorPose(p, ground, undefined, spec, open);
    assert.equal(c.kind, 'box'); assert.equal(c.tag, 'door');
    assert.ok(near(c.halfX, .45) && near(c.halfZ, .025 + .03), 'half length, half thickness plus the pad');
    assert.ok(near(c.minY, ground + hingeAt[1]) && near(c.maxY, ground + hingeAt[1] + 2.1), 'from the hinge height up');
    const centre = truth(p, ground, undefined, spec, open, new THREE.Vector3(.45, 0, 0));
    assert.ok(near(c.x, centre.x) && near(c.z, centre.z), 'centre half a leaf out');
    let inside = 0, outside = 0;
    for (let i = -8; i <= 26; i++) for (let j = -12; j <= 12; j++) {
      const lx = i * .05 + .0123, lz = j * .01 + .0031;
      if (Math.abs(lx) < eps || Math.abs(lx - .9) < eps || Math.abs(Math.abs(lz) - .055) < eps) continue;
      const w = truth(p, ground, undefined, spec, open, new THREE.Vector3(lx, 0, lz)), want = lx > 0 && lx < .9 && Math.abs(lz) < .055;
      assert.equal(solidContact(c, w.x, w.z, 0).depth > 0, want, `placement ${placementYaw} open ${open}: leaf point ${lx.toFixed(2)},${lz.toFixed(2)}`);
      want ? inside++ : outside++;
    }
    assert.ok(inside > 20 && outside > 100, 'the sampling straddled the box');
  }
});

test('shut and open give different boxes: it follows the leaf (a leaf standing across the doorway is a box along the other axis)', () => {
  const p = { x: 0, z: 0, yaw: 0 }, spec = door({ hinge: [0, 0, 0], yaw: 0, swing: -Math.PI / 2 });
  const shut = doorPose(p, 0, undefined, spec, 0).collider, open = doorPose(p, 0, undefined, spec, 1).collider;
  assert.ok(near(shut.x, .45) && near(shut.z, 0) && near(shut.yaw, 0));
  assert.ok(near(open.x, 0, 1e-12) && near(open.z, .45) && near(open.yaw, -Math.PI / 2), 'turned a quarter circle, along +z');
  assert.ok(solidContact(shut, .45, 0, .1).depth > 0 && solidContact(shut, 0, .45, .1).depth < 0);
  assert.ok(solidContact(open, 0, .45, .1).depth > 0 && solidContact(open, .45, 0, .1).depth < 0);
  const half = doorPose(p, 0, undefined, spec, .5).collider;
  assert.ok(near(half.yaw, -Math.PI / 4) && near(half.x, .45 * Math.cos(Math.PI / 4)) && near(half.z, .45 * Math.sin(Math.PI / 4)));
});

test('a seated (tilted) parent moves the hinge by its whole rotation; the box follows the leaf\'s horizontal run', () => {
  const q = new THREE.Quaternion().setFromAxisAngle(UP, .7).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .15));
  const p = { x: 5, z: 6, yaw: .7 }, spec = door({ hinge: [-.45, .2, 1], yaw: 0, swing: 1.2 });
  for (const open of [0, .6, 1]) {
    const pose = doorPose(p, 3, q, spec, open);
    close(pose.position, truth(p, 3, q, spec, open, new THREE.Vector3()), `tilted hinge ${open}`);
    close(pose.tip, truth(p, 3, q, spec, open, new THREE.Vector3(.9, 0, 0)), `tilted tip ${open}`);
    const [a, b] = [pose.position, pose.tip];
    assert.ok(near(pose.collider.x, (a.x + b.x) / 2) && near(pose.collider.z, (a.z + b.z) / 2));
    // The box's +x lies along the leaf's horizontal direction.
    assert.ok(near(Math.cos(pose.collider.yaw), (b.x - a.x) / Math.hypot(b.x - a.x, b.z - a.z), 1e-9));
    assert.ok(pose.collider.minY <= Math.min(a.y, b.y) + 1e-12 && pose.collider.maxY >= Math.max(a.y, b.y) + 2.1 - 1e-12);
  }
});

test('doorProblem accepts the contract and names what is wrong otherwise', () => {
  assert.equal(doorProblem(door()), undefined);
  assert.equal(doorProblem(door({ thickness: undefined })), undefined, 'thickness may be left out');
  assert.equal(doorProblem(door({ start: .6 })), undefined);
  for (const bad of [null, 'door', {}, door({ asset: '' }), door({ hinge: [1, 2] }), door({ hinge: [1, NaN, 2] }), door({ yaw: NaN }), door({ swing: undefined }), door({ width: 0 }), door({ height: -1 }), door({ width: NaN }), door({ thickness: -.1 }), door({ start: NaN })])
    assert.equal(typeof doorProblem(bad), 'string', JSON.stringify(bad));
});

// --- the runtime ----------------------------------------------------------------------------------------

function fakeLoader() {
  const calls = [];
  const load = url => {
    calls.push(url);
    if (url.includes('missing')) return Promise.reject(new Error('404'));
    const scene = new THREE.Group(), leaf = new THREE.Mesh(new THREE.BoxGeometry(.9, 2.1, .05), new THREE.MeshStandardMaterial());
    leaf.position.set(.45, 1.05, 0); scene.add(leaf, new THREE.PointLight(0xffffff, 1));
    return Promise.resolve({ scene });
  };
  return { calls, load };
}
const leaf = { url: '/world/door.glb', radius: 1.2, colliders: [] };
/** Hinge at the parent's origin, shut along +x; swung open it stands along +z (a quarter circle, so the player is easy to put in its way). */
const spec = { asset: 'door', hinge: [0, 0, 0], yaw: 0, swing: -Math.PI / 2, width: .9, height: 2.1, thickness: .05, start: 1 };
const hut = { url: '/world/hut.glb', radius: 5, colliders: [], doors: [spec] };

/** A building with doors, built as the game builds one: real pois, real collision world, a recording stand-in for the prompt registry. */
function rig({ assets = { hut, door: leaf }, placements = [{ id: 'b', asset: 'hut', x: 0, z: 0, yaw: 0 }], scatter = [], load, at = { x: 0, y: 0, z: -4 } } = {}) {
  const loader = fakeLoader(), world = createCollisionWorld(), scene = new THREE.Scene();
  const pois = createPois(scene, () => 0, world, { assets, placements, scatter, load: load ?? loader.load });
  const items = [], noises = [];
  const interaction = { register(item) { items.push(item); return () => { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); }; } };
  const doors = createDoors({ pois, collisions: world, interaction, onNoise: e => noises.push(e) });
  const player = { ...at };
  const run = (seconds, dt = 1 / 60, each) => { let changed = false; for (let t = 0; t < seconds - 1e-9; t += dt) { changed = doors.update({ dt, player }) || changed; each?.(t); } return changed; };
  const leaves = () => world.nearby(0, 0, 40).filter(c => c.tag === 'door');
  return { loader, world, pois, scene, items, noises, doors, player, run, leaves };
}
const depth = (c, p, r = .24) => solidContact(c, p.x, p.z, r).depth;

test('start is honoured, and the collider exists from the first frame, before any GLB has loaded', () => {
  const r = rig();
  assert.equal(r.doors.size, 1);
  assert.equal(r.loader.calls.length, 0, 'nothing requested yet');
  const [d] = r.doors.list();
  assert.equal(d.id, 'b#0'); assert.equal(d.placement, 'b'); assert.equal(d.open, 1); assert.equal(d.closed, false); assert.equal(d.status, 'idle');
  const [c] = r.leaves();
  assert.ok(near(c.yaw, -Math.PI / 2) && near(c.z, .45) && near(c.x, 0, 1e-12), 'start 1: standing along +z');
  const half = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: .5 }] }, door: leaf } });
  assert.ok(near(half.doors.get('b#0').open, .5)); assert.ok(near(half.leaves()[0].yaw, -Math.PI / 4));
  const shut = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } }), shutByDefault = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: undefined }] }, door: leaf } });
  assert.equal(shut.doors.get('b#0').closed, true); assert.equal(shutByDefault.doors.get('b#0').open, 0);
  assert.equal(rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 7 }] }, door: leaf } }).doors.get('b#0').open, 1, 'start is clamped');
});

test('the leaf loads once the player is near, through the same loader as everything else, and is hung on its hinge', async () => {
  const r = rig({ at: { x: 0, y: 0, z: -4 } });
  r.run(1 / 60); await wait(); r.run(1 / 60);
  assert.deepEqual(r.loader.calls, ['/world/door.glb']);
  const [d] = r.doors.list(); assert.equal(d.status, 'ready');
  const object = r.scene.getObjectByName('Door b#0');
  assert.ok(object, 'in the pois group of the scene'); assert.equal(object.visible, true);
  const world = object.localToWorld(new THREE.Vector3(.9, 0, 0));
  assert.ok(near(world.x, 0, 1e-9) && near(world.z, .9, 1e-9), 'start 1: the leaf object stands along +z, hinged at the origin');
  assert.ok(!object.getObjectByProperty('isLight', true), 'a stray lamp in the GLB was dropped');
  // Two placements with the same door share its one load and its geometry.
  const two = rig({ placements: [{ id: 'b', asset: 'hut', x: 0, z: 0, yaw: 0 }, { id: 'c', asset: 'hut', x: 9, z: 0, yaw: 1 }] });
  two.run(1 / 60); await wait();
  assert.equal(two.loader.calls.length, 1); assert.equal(two.doors.size, 2);
  const a = two.scene.getObjectByName('Door b#0'), b = two.scene.getObjectByName('Door c#0');
  assert.ok(a && b && a !== b && a.children[0].geometry === b.children[0].geometry && a.children[0].material === b.children[0].material);
});

test('far doors cost nothing: not loaded out of range, hidden beyond the draw distance (with hysteresis), still colliding', async () => {
  const r = rig({ placements: [{ id: 'b', asset: 'hut', x: 0, z: 0, yaw: 0, draw: 100 }], at: { x: 900, y: 0, z: 0 } });
  assert.equal(r.run(1 / 60), false); await wait();
  assert.equal(r.loader.calls.length, 0);
  assert.equal(r.leaves().length, 1, 'the collider is there regardless');
  r.player.x = 150; r.run(1 / 60); await wait(); r.run(1 / 60);
  const object = r.scene.getObjectByName('Door b#0');
  assert.equal(r.loader.calls.length, 1, 'draw 100 + load margin 60 + radius 5 is the load range'); assert.equal(object.visible, false, 'loaded but beyond draw');
  r.player.x = 100; assert.equal(r.run(1 / 60), true, 'showing it changes the shadow casters'); assert.equal(object.visible, true);
  r.player.x = 110; r.run(1 / 60); assert.equal(object.visible, true, 'hysteresis: just past the edge it stays');
  r.player.x = 400; assert.equal(r.run(1 / 60), true); assert.equal(object.visible, false);
  assert.equal(r.run(1 / 60), false, 'and nothing changes while nothing moves');
});

test('opening swings about the hinge with an ease over about 0.7 s; one live collider follows the leaf the whole way', async () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } });
  r.run(1 / 60); await wait(); r.run(1 / 60);
  const object = r.scene.getObjectByName('Door b#0'), samples = [];
  assert.equal(r.items.length, 1);
  r.items[0].activate();
  assert.equal(r.doors.get('b#0').target, 1);
  let last = 0, t = 0;
  while (r.doors.get('b#0').open < 1 && t < 2) {
    r.run(1 / 60); t += 1 / 60;
    const d = r.doors.get('b#0'), live = r.leaves();
    assert.equal(live.length, 1, 'exactly one collider for the door, however often it was re-registered');
    const want = doorPose({ x: 0, z: 0, yaw: 0 }, 0, undefined, spec, d.open);
    assert.ok(near(live[0].x, want.collider.x, 1e-12) && near(live[0].z, want.collider.z, 1e-12) && near(live[0].yaw, want.collider.yaw, 1e-12), 'the box is the leaf\'s current pose');
    assert.ok(near(object.rotation.y, want.yaw, 1e-9), 'and so is the object');
    assert.ok(d.open >= last - 1e-12, 'never goes back on itself'); samples.push(d.open); last = d.open;
  }
  assert.ok(t > DOOR_SECONDS - .05 && t < DOOR_SECONDS + .05, `took ${t.toFixed(3)} s`);
  assert.equal(r.doors.get('b#0').open, 1); assert.equal(r.doors.get('b#0').moving, false);
  const steps = samples.map((v, i) => v - (samples[i - 1] ?? 0));
  assert.ok(steps[1] < steps[Math.floor(steps.length / 2)] && steps.at(-2) < steps[Math.floor(steps.length / 2)], 'eased: slow at both ends, quick in the middle');
  assert.ok(near(r.leaves()[0].yaw, -Math.PI / 2) && near(r.leaves()[0].z, .45), 'open: standing along +z');
  r.items[0].activate(); r.run(DOOR_SECONDS + .1);
  assert.ok(r.doors.get('b#0').closed && near(r.leaves()[0].yaw, 0) && near(r.leaves()[0].x, .45, 1e-12), 'and shut again');
});

test('a click mid-swing turns the door round from where it is, and a quick turn takes less than a full swing', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } });
  r.items[0].activate(); r.run(.3);
  const mid = r.doors.get('b#0').open; assert.ok(mid > .1 && mid < .9);
  assert.equal(r.items[0].label(), 'Left click to close', 'heading open, a click would shut it');
  r.items[0].activate(); assert.equal(r.doors.get('b#0').target, 0);
  r.run(1 / 60); assert.ok(r.doors.get('b#0').open < mid, 'it reverses at once');
  let t = 1 / 60; while (!r.doors.get('b#0').closed && t < 2) { r.run(1 / 60); t += 1 / 60; }
  assert.ok(t < DOOR_SECONDS * mid + .35, `back in ${t.toFixed(2)} s`);
});

test('the prompt: wording as the other prompts, flips with the state, hangs on the handle at hand height and follows the leaf', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } });
  const [item] = r.items; assert.equal(r.items.length, 1);
  assert.equal(item.id, 'door:b#0'); assert.ok(item.enabled());
  assert.equal(item.label(), 'Left click to open');
  assert.equal(promptText(item.label(), true), 'Tap to open'); assert.equal(promptText('Left click to close', false), 'Left click to close');
  assert.ok(near(item.position.y, 1.05) && near(item.position.x, .765, 1e-9) && near(item.position.z, 0, 1e-9), 'handle side of the shut leaf (85% along), on its midplane');
  item.activate(); assert.equal(item.label(), 'Left click to close', 'changes the moment it is clicked');
  r.run(1);
  assert.ok(near(item.position.x, 0, 1e-9) && near(item.position.z, .765, 1e-9) && near(item.position.y, 1.05), 'swung with the leaf: along +z now');
  assert.equal(item.label(), 'Left click to close'); item.activate(); assert.equal(item.label(), 'Left click to open');
  // Scale and a high sill carry through.
  const big = rig({ assets: { hut: { ...hut, doors: [{ ...spec, hinge: [0, .1, 0], start: 0 }] }, door: leaf }, placements: [{ id: 'b', asset: 'hut', x: 0, z: 0, yaw: 0, scale: 2 }] });
  assert.ok(near(big.items[0].position.y, .2 + 2.1, 1e-9) && near(big.items[0].position.x, 2 * .765, 1e-9));
});

test('both faces of the door can see the prompt: the line of sight to the handle is clear from the room and from outside', () => {
  // A wall with the doorway in it, as a building would have, and the door shut across the gap.
  const wall = [{ kind: 'box', x: -1.1, z: 0, halfX: 1, halfZ: .1, yaw: 0, minY: 0, maxY: 2.5 }, { kind: 'box', x: 2, z: 0, halfX: 1.1, halfZ: .1, yaw: 0, minY: 0, maxY: 2.5 }];
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } });
  r.world.replace('wall', wall);
  const handle = r.items[0].position;
  for (const [x, z] of [[.8, 1.5], [.8, -1.5], [.3, .9], [.3, -.9], [1.3, 1.2], [1.3, -1.2]]) {
    const eye = new THREE.Vector3(x, 1.69, z);
    assert.equal(lineOfSight(r.world, eye, handle), true, `from ${x}, ${z}`);
    assert.ok(eye.distanceTo(handle) < 2.3, 'and within the prompt\'s reach');
  }
  assert.equal(lineOfSight(r.world, new THREE.Vector3(2, 1.69, 1.5), new THREE.Vector3(2, 1.69, -1.5)), false, 'the wall itself still blocks the view');
});

test('opening or shutting by hand makes a small noise at the handle: shutting louder than opening; diagnostics and reset are silent', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } });
  r.items[0].activate(); r.run(1); r.items[0].activate();
  assert.equal(r.noises.length, 2);
  assert.deepEqual(r.noises.map(n => [n.opening, n.loudness]), [[true, DOOR_NOISE.open], [false, DOOR_NOISE.close]]);
  assert.ok(DOOR_NOISE.close > DOOR_NOISE.open && DOOR_NOISE.close <= .2);
  assert.ok(Number.isFinite(r.noises[0].x) && Number.isFinite(r.noises[0].z) && r.noises[0].id === 'b#0');
  r.doors.set('b#0', 1); r.doors.set('b#0', 0, true); r.doors.toggle('b#0'); r.doors.reset();
  assert.equal(r.noises.length, 2);
});

test('closed doors block the way and open ones leave it clear, with the real moveCharacter', () => {
  const wall = [{ kind: 'box', x: -1.1, z: 0, halfX: 1, halfZ: .1, yaw: 0, minY: 0, maxY: 2.5 }, { kind: 'box', x: 2, z: 0, halfX: 1.1, halfZ: .1, yaw: 0, minY: 0, maxY: 2.5 }];
  const walkThrough = r => { let p = { x: .45, y: 0, z: -2 }; for (let i = 0; i < 200; i++) p = moveCharacter(p, 0, .03, 1.69, () => 0, r.world); return p; };
  const shut = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } }); shut.world.replace('wall', wall);
  assert.ok(walkThrough(shut).z < 0, 'shut: stopped at the leaf');
  const open = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } }); open.world.replace('wall', wall);
  open.doors.set('b#0', 1); assert.ok(walkThrough(open).z > 3.5, 'open: walked clean through');
});

test('the player is never trapped in the leaf: a door closing onto them holds where it is, then settles', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 1 }] }, door: leaf }, at: { x: .55, y: 0, z: .55 } });
  // Standing in the quadrant the leaf sweeps while closing. Click: it starts to close.
  r.items[0].activate();
  let worst = 0, t = 0;
  r.run(DOOR_SECONDS + 1.5, 1 / 60, () => { t += 1 / 60; worst = Math.max(worst, depth(r.leaves()[0], r.player)); });
  const d = r.doors.get('b#0');
  assert.ok(worst <= 1e-9, `the capsule never touched the leaf (worst depth ${worst})`);
  assert.ok(d.open > 0 && d.open < 1, 'it closed as far as the player let it'); assert.equal(d.moving, false, 'and gave up, rather than pushing on');
  assert.equal(d.target, d.open);
  // The player steps out of the way; a click carries on shutting it.
  r.player.x = 2; r.player.z = 2;
  assert.equal(r.items[0].label(), d.open < .5 ? 'Left click to open' : 'Left click to close');
  r.doors.set('b#0', 0, true); r.run(DOOR_SECONDS + .1);
  assert.ok(r.doors.get('b#0').closed);
});

test('a door held up by the player carries on the moment they step clear', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 1 }] }, door: leaf }, at: { x: .55, y: 0, z: .55 } });
  r.items[0].activate(); r.run(.5);
  const stuck = r.doors.get('b#0').open; assert.ok(stuck > .2 && stuck < 1);
  r.run(.2); assert.ok(near(r.doors.get('b#0').open, stuck, 1e-9), 'held');
  r.player.x = -2; r.player.z = -2; r.run(DOOR_SECONDS + .1);
  assert.ok(r.doors.get('b#0').closed, 'on its way once they moved');
});

test('a door that opens into the player nudges them clear (moveCharacter pushes them out) and never leaves them inside the leaf', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf }, at: { x: .5, y: 0, z: .35 } });
  r.items[0].activate();
  let worstAfterMove = 0, worstBeforeMove = 0, centre = 0;
  for (let i = 0; i < 240; i++) {
    r.doors.update({ dt: 1 / 60, player: r.player });
    worstBeforeMove = Math.max(worstBeforeMove, depth(r.leaves()[0], r.player));
    const p = moveCharacter(r.player, 0, 0, 1.69, () => 0, r.world); r.player.x = p.x; r.player.z = p.z;
    worstAfterMove = Math.max(worstAfterMove, depth(r.leaves()[0], r.player)); centre = Math.max(centre, depth(r.leaves()[0], r.player, 0));
  }
  assert.equal(r.doors.get('b#0').open, 1, 'it opened, with them standing in its way');
  assert.ok(worstAfterMove <= 1e-6, `never left embedded (${worstAfterMove})`);
  assert.ok(worstBeforeMove <= .1 + 1e-3, `a nudge of at most 10 cm of capsule per step (${worstBeforeMove})`);
  assert.ok(centre <= 0, 'their centre was never inside the leaf');
  assert.ok(Math.hypot(r.player.x - .5, r.player.z - .35) > .05, 'they were moved');
});

test('a door that cannot nudge the player (pinned in a corner) still never crushes them: the capsule is dug into by at most a nudge and the centre never is', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf }, at: { x: .5, y: 0, z: .45 } });
  // A corner the leaf pushes them into: a wall ahead of it (z >= .9) and one beside it (x <= .1).
  r.world.replace('wall', [{ kind: 'box', x: 0, z: 1.4, halfX: 5, halfZ: .5, yaw: 0, minY: 0, maxY: 2.5 }, { kind: 'box', x: -2.4, z: 1.5, halfX: 2.5, halfZ: 1.3, yaw: 0, minY: 0, maxY: 2.5 }]);
  r.items[0].activate();
  let worst = 0, centre = 0, squeezed = 0;
  for (let i = 0; i < 300; i++) {
    r.doors.update({ dt: 1 / 60, player: r.player });
    const before = depth(r.leaves()[0], r.player); worst = Math.max(worst, before); centre = Math.max(centre, depth(r.leaves()[0], r.player, 0));
    if (before > 0) squeezed++;
    const p = moveCharacter(r.player, 0, 0, 1.69, () => 0, r.world); r.player.x = p.x; r.player.z = p.z;
  }
  assert.ok(squeezed > 0, 'the leaf really did meet them');
  assert.ok(worst <= .1 + 1e-3, `capsule dug into by ${worst} at most`); assert.ok(centre <= 0, 'their centre never inside the leaf');
  assert.ok(depth(r.leaves()[0], r.player) <= 1e-6, 'and at the end they are clear of it');
});

test('someone upstairs, or already inside the leaf, does not freeze it: it only refuses moves that dig deeper', () => {
  const up = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 1 }] }, door: leaf }, at: { x: .55, y: 4, z: .55 } });
  up.items[0].activate(); up.run(DOOR_SECONDS + .1);
  assert.ok(up.doors.get('b#0').closed, 'a different level is not in the way');
  // Dropped into a shut door (a teleport, a shove) on the side it swings away from: the next movement resolves them out along the
  // leaf's normal, and it opens, never digging deeper in.
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf }, at: { x: .45, y: 0, z: -.1 } });
  assert.ok(depth(r.leaves()[0], r.player) > 0, 'really inside the leaf');
  r.items[0].activate();
  for (let i = 0; i < 240; i++) {
    r.doors.update({ dt: 1 / 60, player: r.player });
    const p = moveCharacter(r.player, 0, 0, 1.69, () => 0, r.world); r.player.x = p.x; r.player.z = p.z;
  }
  assert.equal(r.doors.get('b#0').open, 1, 'it got there');
  assert.ok(depth(r.leaves()[0], r.player) <= 1e-6, 'and they are out of it');
});

test('closedAt finds a shut door within reach of a point, measured to the leaf; open or far ones are not found', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf } });
  const found = r.doors.closedAt(.45, 1);
  assert.equal(found.id, 'b#0'); assert.equal(found.closed, true);
  assert.equal(r.doors.closedAt(.45, 1.3), undefined, 'default reach 1.2 m'); assert.equal(r.doors.closedAt(.45, 1.3, 2)?.id, 'b#0');
  assert.equal(r.doors.closedAt(.45, -1)?.id, 'b#0', 'from either side');
  assert.equal(r.doors.closedAt(30, 30), undefined);
  r.doors.set('b#0', 1); assert.equal(r.doors.closedAt(.45, 1), undefined, 'open');
  r.doors.set('b#0', DOOR_CLOSED); assert.equal(r.doors.closedAt(.45, 1)?.id, 'b#0', 'a hair open still counts as shut');
  assert.ok(near(r.doors.list()[0].tip.x, .9 * Math.cos(DOOR_CLOSED * -Math.PI / 2), 1e-9) && r.doors.list()[0].width === .9);
});

test('set, get and toggle by id or by placement id; bad ids and values are refused', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }, { ...spec, hinge: [2, 0, 0], start: 1 }] }, door: leaf } });
  assert.deepEqual(r.doors.list().map(d => d.id), ['b#0', 'b#1']);
  assert.equal(r.doors.set('b#1', 0), true); assert.equal(r.doors.get('b#1').open, 0);
  assert.equal(r.doors.set('b', true), true, 'the placement id means its first door'); assert.equal(r.doors.get('b#0').open, 1);
  assert.equal(r.doors.set('b#0', 3), true); assert.equal(r.doors.get('b#0').open, 1, 'clamped');
  assert.equal(r.doors.set('nope', 1), false); assert.equal(r.doors.set('b#0', NaN), false); assert.equal(r.doors.get('nope'), undefined);
  assert.equal(r.doors.toggle('b#0'), true); assert.equal(r.doors.get('b#0').target, 0); assert.equal(r.doors.toggle('nope'), false);
  r.doors.set('b#0', .5, true); assert.equal(r.doors.get('b#0').target, .5); assert.equal(r.doors.get('b#0').open, 1, 'animate: swings there');
  // An instant set moves the one collider, not adds one.
  r.doors.set('b#0', 0); assert.equal(r.leaves().length, 2);
});

test('reset puts every leaf back at its start at once, with its collider', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: .55 }] }, door: leaf } });
  r.items[0].activate(); r.run(1); r.items[0].activate(); r.run(.2);
  assert.notEqual(r.doors.get('b#0').open, .55);
  r.doors.reset();
  const d = r.doors.get('b#0'); assert.equal(d.open, .55); assert.equal(d.moving, false);
  assert.ok(near(r.leaves()[0].yaw, -.55 * Math.PI / 2) && r.leaves().length === 1);
});

test('doors on scattered placements, scaled and rotated, work like any other', () => {
  const r = rig({ assets: { hut: { ...hut, doors: [{ ...spec, start: 0 }] }, door: leaf }, placements: [], scatter: [{ id: 's', asset: 'hut', x: 20, z: 10, yaw: Math.PI / 2, scale: 2 }] });
  const [d] = r.doors.list(); assert.equal(d.id, 's#0');
  assert.ok(near(d.x, 20) && near(d.z, 10) && near(d.width, 1.8));
  const [c] = r.leaves(); assert.ok(near(c.halfX, .9) && near(c.halfZ, .025 * 2 + .03) && near(c.maxY - c.minY, 4.2));
  // Shut, the leaf lies along the placement's local +x, which a quarter turn sends to world -z.
  assert.ok(near(c.yaw, Math.PI / 2) && near(c.x, 20, 1e-9) && near(c.z, 10 - .9, 1e-9));
});

// --- nothing to do ----------------------------------------------------------------------------------------

test('an asset without doors, a door asset nobody lists, or a spec the exporter got wrong: all no-ops, and the parent\'s own colliders stay', () => {
  const solid = { ...hut, doors: undefined, colliders: [{ kind: 'box', x: 0, z: 0, halfX: 1, halfZ: 1, yaw: 0, minY: 0, maxY: 2 }] };
  for (const [name, assets] of [['no doors key', { hut: solid, door: leaf }], ['empty doors', { hut: { ...solid, doors: [] }, door: leaf }], ['asset not listed', { hut: { ...solid, doors: [spec] } }],
    ['bad spec', { hut: { ...solid, doors: [{ ...spec, width: NaN }, null, { ...spec, hinge: [0, 0] }] }, door: leaf }], ['doors not an array', { hut: { ...solid, doors: 'yes' }, door: leaf }]]) {
    const r = rig({ assets });
    assert.equal(r.doors.size, 0, name); assert.equal(r.items.length, 0, name); assert.deepEqual(r.doors.list(), [], name);
    assert.equal(r.leaves().length, 0, name); assert.equal(r.world.stats().solids, 1, `${name}: only the building's own collider`);
    assert.equal(r.run(1), false, name); assert.equal(r.doors.closedAt(0, 0), undefined, name); assert.equal(r.doors.set('b', 1), false, name);
    r.doors.reset(); r.doors.dispose(); assert.equal(r.world.stats().solids, 1, name);
  }
  // And with no pois at all.
  const none = rig({ placements: [] }); assert.equal(none.doors.size, 0); assert.equal(none.run(1), false);
});

test('a door whose model fails to load disappears altogether, collider and prompt too, leaving the doorway clear', async () => {
  const r = rig({ assets: { hut: { ...hut, colliders: [{ kind: 'box', x: 3, z: 3, halfX: 1, halfZ: 1, yaw: 0, minY: 0, maxY: 2 }] }, door: { ...leaf, url: '/world/missing.glb' } } });
  assert.equal(r.leaves().length, 1); assert.equal(r.items.length, 1);
  r.run(1 / 60); await wait(); await wait();
  assert.equal(r.doors.list().length, 0); assert.equal(r.doors.size, 0); assert.equal(r.leaves().length, 0); assert.equal(r.items.length, 0);
  assert.equal(r.world.stats().solids, 1, 'the building keeps its own');
  assert.equal(r.run(1 / 60), true, 'the change is reported once'); assert.equal(r.run(1 / 60), false);
  assert.equal(r.doors.get('b#0'), undefined); assert.equal(r.doors.set('b#0', 1), false);
  assert.equal(r.loader.calls.filter(u => u.includes('missing')).length, 1, 'asked for once, not every frame');
});

test('dispose unregisters the prompts and the colliders and takes the leaves out of the scene; a late arrival is discarded', async () => {
  const r = rig();
  r.run(1 / 60); await wait(); r.run(1 / 60);
  const object = r.scene.getObjectByName('Door b#0'); assert.ok(object?.parent);
  r.doors.dispose();
  assert.equal(r.items.length, 0); assert.equal(r.leaves().length, 0); assert.equal(object.parent, null);
  const late = rig(); late.run(1 / 60); late.doors.dispose(); await wait();
  assert.equal(late.scene.getObjectByName('Door b#0'), undefined);
});

// --- pois: what the doors stand on --------------------------------------------------------------------------

test('pois.seats gives every placement as it stands; spawn hands out independent copies of a listed asset and tolerates the rest', async () => {
  const loader = fakeLoader(), scene = new THREE.Scene();
  const pois = createPois(scene, x => x * .01, undefined, { assets: { hut, door: leaf }, placements: [{ id: 'b', asset: 'hut', x: 20, z: 5, yaw: .4 }, { id: 'ghost', asset: 'unlisted', x: 0, z: 0, yaw: 0 }],
    scatter: [{ id: 's', asset: 'hut', x: 1, z: 1, yaw: 0, scale: 2 }], load: loader.load });
  const seats = pois.seats();
  assert.deepEqual(seats.map(s => s.id), ['b', 's']); assert.equal(seats[0].def, hut); assert.ok(near(seats[0].ground, .2)); assert.equal(seats[1].placement.scale, 2);
  assert.equal(seats[0].loadRange(20, 5), true); assert.equal(seats[0].loadRange(9999, 0), false);
  assert.equal(seats[0].drawRange(20 + 150 + 5 + 5, 5, false), false); assert.equal(seats[0].drawRange(20 + 150 + 5 + 5, 5, true), true, 'hysteresis');
  assert.equal(pois.known('door'), true); assert.equal(pois.known('nope'), false);
  const [a, b] = await Promise.all([pois.spawn('door', 'one'), pois.spawn('door', 'two')]);
  assert.ok(a && b && a !== b && a.name === 'one' && b.name === 'two' && a.parent && !a.visible);
  assert.equal(loader.calls.length, 1, 'one load');
  assert.equal(await pois.spawn('nope'), undefined);
  const failing = createPois(new THREE.Scene(), () => 0, undefined, { assets: { door: { ...leaf, url: '/world/missing.glb' } }, placements: [], scatter: [], load: loader.load });
  assert.equal(await failing.spawn('door'), undefined); assert.equal(await failing.spawn('door'), undefined);
  assert.equal(failing.stats().failed, 1);
  pois.dispose(); assert.equal(await pois.spawn('door'), undefined, 'after dispose nothing is handed out');
});

// --- the shipped data ---------------------------------------------------------------------------------------

test('every door in world-assets.json is well formed, points at a listed leaf asset whose GLB exists, and opens somewhere', () => {
  let count = 0;
  for (const [name, asset] of Object.entries(shipped)) for (const [i, d] of (asset.doors ?? []).entries()) {
    count++;
    assert.equal(doorProblem(d), undefined, `${name}.doors[${i}]`);
    assert.ok(shipped[d.asset], `${name}.doors[${i}] names ${d.asset}, which is not an asset`);
    assert.ok(existsSync(new URL(`../../../public${shipped[d.asset].url}`, import.meta.url)), `${d.asset}.glb is in public/world`);
    assert.ok((d.start ?? 0) >= 0 && (d.start ?? 0) <= 1, 'start is 0..1');
    assert.ok(Math.abs(d.swing) > .5 && Math.abs(d.swing) <= Math.PI, 'swings a sensible way'); assert.ok(d.width > .5 && d.width < 1.6 && d.height > 1.6 && d.height < 3);
  }
  assert.ok(count >= 0);
});

test('the real pump house door: shut, the leaf closes its doorway between the wall ends; open, a player walks in', () => {
  const place = { id: 'pump', asset: 'pumphouse', x: 0, z: 0, yaw: 0 };
  const build = () => rig({ assets: shipped, placements: [place], at: { x: .5, y: 0, z: 4 } });
  const r = build();
  const [d] = r.doors.list();
  if (!d) return; // nothing to check until the asset carries its door
  assert.equal(d.id, 'pump#0');
  r.doors.set('pump#0', 0);
  const c = r.leaves()[0], door = shipped.pumphouse.doors[0];
  // Between the two wall ends (x .08 and 1.0 on the +z wall): the leaf's ends sit at the jambs, a few centimetres off them, shut.
  const jambs = shipped.pumphouse.colliders.filter(w => w.tag === 'pump house wall' && Math.abs(w.z - 1.3) < .01);
  assert.ok(jambs.length >= 2, 'the +z wall has a gap');
  for (const end of [[door.hinge[0], door.hinge[2]], [door.hinge[0] + door.width * Math.cos(door.yaw), door.hinge[2] - door.width * Math.sin(door.yaw)]]) {
    const nearest = Math.min(...jambs.map(w => Math.hypot(Math.max(0, Math.abs(end[0] - w.x) - w.halfX), Math.max(0, Math.abs(end[1] - w.z) - w.halfZ))));
    assert.ok(nearest < .1, `a leaf end is ${nearest.toFixed(3)} m from a jamb`);
  }
  assert.ok(near(c.z, door.hinge[2], 1e-4), 'in the wall plane, just outside it');
  // The ground floor is a slab .08 up; walk in from outside.
  const walk = (rr, x) => { let p = { x, y: 0, z: 4 }; for (let i = 0; i < 260; i++) p = moveCharacter(p, 0, -.03, 1.69, () => 0, rr.world); return p; };
  const x = (door.hinge[0] + (door.hinge[0] - door.width)) / 2;
  assert.ok(walk(r, x).z > 1.5, 'shut: stopped outside the leaf');
  r.doors.set('pump#0', 1);
  assert.ok(walk(r, x).z < 1.1, 'open: walked in through the doorway');
  r.doors.set('pump#0', door.start ?? 0);
});

// --- wiring ---------------------------------------------------------------------------------------------------

test('the dev test building exists only behind the ?door-test flag in a dev build: here it is empty', () => {
  assert.deepEqual(doorTestPlacements(() => 0), []);
  const was = globalThis.location; globalThis.location = { search: '?door-test' };
  try { assert.deepEqual(doorTestPlacements(() => 0), [], 'a flag alone is not enough outside a dev build'); } finally { globalThis.location = was; if (was === undefined) delete globalThis.location; }
});

test('the rebuilt world wires doors in: they swing only while the game simulates, and a restart puts them back, silently', () => {
  const element = () => ({ style: {}, textContent: '', setAttribute() {}, addEventListener() {}, remove() {} });
  const container = { ownerDocument: { createElement: element }, appendChild() {} };
  const camera = new THREE.PerspectiveCamera(69, 1.6, .075, 1800), collisions = createCollisionWorld(), warn = console.warn; console.warn = () => {};
  const flashlight = { owned: true, setSeat() {}, pickUp: () => true, inspect: () => ({ pickupPosition: [0, 0, 0] }) };
  const world = createWorldV2({ scene: new THREE.Scene(), camera, container, heightAt: () => 0, collisions, flashlight, viewHeight: () => 720, riverX: () => 1e6, exclusion: () => 0 });
  try {
    const doors = world.debug.doors, first = doors.list()[0];
    assert.equal(typeof doors.closedAt, 'function');
    if (!first) return; // no placed building has a door yet
    assert.equal(collisions.nearby(first.x, first.z, 3).filter(c => c.tag === 'door').length >= 1, true, 'its collider is in the world from the first frame');
    const player = new THREE.Vector3(first.x + 60, 0, first.z), frame = (dt, simulate) => world.update({ dt, time: 0, player, darkness: 0, active: true, simulate });
    doors.set(first.id, 1, true); frame(.2, false); frame(.2, false);
    assert.equal(doors.get(first.id).open, first.open, 'paused: it does not move');
    for (let i = 0; i < 60; i++) frame(1 / 30, true);
    assert.equal(doors.get(first.id).open, 1, 'simulating: it swung open');
    const noises = []; world.noise.subscribe(e => noises.push(e));
    world.restart();
    assert.equal(doors.get(first.id).open, first.open, 'a restarted night: back where it began');
    assert.equal(noises.length, 0, 'and silently');
  } finally { console.warn = warn; world.dispose(); }
});
