import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
// game/render/props/pois.ts uses extensionless and JSON imports that only the bundler understands.
import '../../helpers/register-ts-hooks.mjs';
const { createPois, worldColliders, worldHook, worldLadder, placePoint, seatPlacement, footprintOf } = await import('../../../game/render/props/pois.ts');
const { solidContact, createCollisionWorld } = await import('../../../game/sim/world/collision.ts');

const flat = h => () => h;
const hut = { url: '/world/hut.glb', radius: 5,
  colliders: [
    { kind: 'box', x: 2, z: -1, halfX: 3, halfZ: .5, yaw: .4, minY: 0, maxY: 2.5, tag: 'wall' },
    { kind: 'capsule', ax: 1, az: 2, bx: 4, bz: 2, radius: .2, minY: .1, maxY: 3, tag: 'rail' },
  ],
  hooks: { bench: [.5, .6, -1], door: [0, 1, 4] } };
const place = { id: 'h', asset: 'hut', x: 20, z: -30, yaw: 1.1 };
const wait = () => new Promise(resolve => setTimeout(resolve, 0));

/** The ground truth: what three.js itself does to a point when the model is placed. */
const toWorld = (p, local) => {
  const o = new THREE.Object3D(); o.position.set(p.x, 0, p.z); o.rotation.y = p.yaw; o.scale.setScalar(p.scale ?? 1); o.updateMatrixWorld(true);
  return o.localToWorld(local.clone());
};

test('a placement yaw turns model-local points exactly as Object3D.rotation.y does', () => {
  for (const yaw of [0, .22, 1.1, Math.PI / 2, 3.14, -.6, 5.5]) for (const scale of [undefined, 2.5]) {
    const p = { ...place, yaw, scale };
    for (const [x, z] of [[1, 0], [0, 1], [-2.3, 4.1], [3, -3]]) {
      const w = placePoint(p, x, z), truth = toWorld(p, new THREE.Vector3(x, 0, z));
      assert.ok(Math.abs(w.x - truth.x) < 1e-9 && Math.abs(w.z - truth.z) < 1e-9, `yaw ${yaw}`);
    }
  }
});

test('box colliders: a world point is inside the world box exactly when its model-local point is inside the model box', () => {
  // The convention in solidContact is easy to get backwards, so test every point against three.js, not against our own maths.
  let inside = 0, outside = 0;
  for (const yaw of [0, .22, 1.1, Math.PI / 2, 2.4, -.9]) for (const local of [0, .4, -1.2]) {
    const p = { ...place, yaw }, asset = { url: '', radius: 1, colliders: [{ kind: 'box', x: 2, z: -1, halfX: 3, halfZ: .5, yaw: local, minY: 0, maxY: 2.5 }] };
    const [box] = worldColliders(asset, p, 7);
    assert.equal(box.kind, 'box');
    assert.ok(Math.abs(box.yaw - (yaw + local)) < 1e-12);
    // The same box, built as a real child object and asked where its corners land.
    const holder = new THREE.Object3D(); holder.position.set(p.x, 0, p.z); holder.rotation.y = yaw;
    const child = new THREE.Object3D(); child.position.set(2, 0, -1); child.rotation.y = local; holder.add(child); holder.updateMatrixWorld(true);
    for (let i = 0; i < 400; i++) {
      const lx = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 8 - 4, lz = (Math.sin(i * 78.233) * 43758.5453 % 1) * 8 - 4;
      const world = child.localToWorld(new THREE.Vector3(lx, 0, lz));
      const expected = Math.abs(lx) <= 3 && Math.abs(lz) <= .5;
      if (Math.abs(Math.abs(lx) - 3) < 1e-3 || Math.abs(Math.abs(lz) - .5) < 1e-3) continue;
      assert.equal(solidContact(box, world.x, world.z, 0).depth > 0, expected, `yaw ${yaw}+${local} point ${lx.toFixed(2)},${lz.toFixed(2)}`);
      expected ? inside++ : outside++;
    }
    assert.ok(Math.abs(box.x - child.getWorldPosition(new THREE.Vector3()).x) < 1e-9 && Math.abs(box.z - child.getWorldPosition(new THREE.Vector3()).z) < 1e-9);
  }
  assert.ok(inside > 100 && outside > 100, 'the sampling really straddled the box');
});

test('a long wall along model +X lies along world -Z when the placement is turned a quarter circle', () => {
  const wall = { url: '', radius: 1, colliders: [{ kind: 'box', x: 0, z: 0, halfX: 3, halfZ: .1, minY: 0, maxY: 2 }] };
  const [c] = worldColliders(wall, { id: 'w', asset: 'w', x: 0, z: 0, yaw: Math.PI / 2 }, 0);
  assert.ok(solidContact(c, 0, 2.5, .01).depth > 0, 'now runs along Z');
  assert.ok(solidContact(c, 2.5, 0, .01).depth < 0, 'and no longer along X');
});

test('capsules, heights and scale are carried into world space', () => {
  const p = { ...place, scale: 2 }, ground = 6.5;
  const [box, rail] = worldColliders(hut, p, ground);
  assert.equal(box.tag, 'wall'); assert.equal(rail.tag, 'rail');
  assert.ok(Math.abs(box.minY - 6.5) < 1e-12 && Math.abs(box.maxY - (6.5 + 2.5 * 2)) < 1e-12);
  assert.ok(Math.abs(rail.minY - (6.5 + .2)) < 1e-12 && Math.abs(rail.maxY - (6.5 + 6)) < 1e-12);
  assert.equal(rail.radius, .4); assert.equal(box.halfX, 6); assert.equal(box.halfZ, 1);
  const a = toWorld(p, new THREE.Vector3(1, 0, 2)), b = toWorld(p, new THREE.Vector3(4, 0, 2));
  assert.ok(Math.abs(rail.ax - a.x) < 1e-9 && Math.abs(rail.az - a.z) < 1e-9 && Math.abs(rail.bx - b.x) < 1e-9 && Math.abs(rail.bz - b.z) < 1e-9);
  // It really blocks where the capsule is, in the right place.
  const mid = toWorld(p, new THREE.Vector3(2.5, 0, 2));
  assert.ok(solidContact(rail, mid.x, mid.z, .24).depth > 0);
  assert.ok(solidContact(rail, mid.x + 1, mid.z + 1, .24).depth < 0);
  assert.equal(worldColliders({ url: '', radius: 1 }, place, 0).length, 0, 'an asset without colliders is fine');
});

test('hooks come back as world positions, with Y on top of the placement ground', () => {
  for (const yaw of [0, 1.1, -2.2]) {
    const p = { ...place, yaw }, hook = worldHook(hut, p, 4.25, 'bench'), truth = toWorld(p, new THREE.Vector3(.5, 0, -1));
    assert.ok(Math.abs(hook.x - truth.x) < 1e-9 && Math.abs(hook.z - truth.z) < 1e-9);
    assert.ok(Math.abs(hook.y - (4.25 + .6)) < 1e-12);
  }
  assert.equal(worldHook(hut, place, 0, 'nope'), undefined);
  assert.equal(worldHook({ url: '', radius: 1 }, place, 0, 'bench'), undefined);
  assert.equal(worldHook({ url: '', radius: 1, hooks: { bad: [1, NaN, 2] } }, place, 0, 'bad'), undefined);
});

test('createPois exposes world colliders and hooks from the first frame and registers them with the collision world', () => {
  const scene = new THREE.Scene(), world = createCollisionWorld();
  const pois = createPois(scene, flat(3), world, { assets: { hut }, placements: [place], scatter: [], load: () => new Promise(() => {}) });
  assert.equal(pois.solidColliders.length, 2);
  assert.equal(pois.solidColliders[0].minY, 3);
  assert.equal(world.stats().solids, 2, 'registered under "pois" before any GLB arrives');
  const hook = pois.hook('h', 'bench'), truth = toWorld(place, new THREE.Vector3(.5, 0, -1));
  assert.ok(Math.abs(hook.x - truth.x) < 1e-9 && Math.abs(hook.z - truth.z) < 1e-9 && Math.abs(hook.y - 3.6) < 1e-9);
  hook.set(0, 0, 0);
  assert.notEqual(pois.hook('h', 'bench').x, 0, 'callers get a copy');
  assert.equal(pois.hook('h', 'missing'), undefined); assert.equal(pois.hook('nobody', 'bench'), undefined);
  assert.equal(pois.ready(), false, 'not ready before the first update');
  pois.dispose(); assert.equal(world.stats().solids, 0);
});

test('setCollidersEnabled bumps the version and rebuilds the list', () => {
  const world = createCollisionWorld(), pois = createPois(new THREE.Scene(), flat(0), world, { assets: { hut }, placements: [place, { ...place, id: 'h2', x: 90 }], scatter: [], load: () => new Promise(() => {}) });
  const v = pois.collisionVersion, list = pois.solidColliders;
  assert.equal(list.length, 4);
  pois.setCollidersEnabled('h2', false);
  assert.ok(pois.collisionVersion > v); assert.equal(list.length, 2, 'the same array is updated in place'); assert.equal(world.stats().solids, 2);
  pois.setCollidersEnabled('h2', false); assert.equal(pois.collisionVersion, v + 1, 'no change, no bump');
  pois.setCollidersEnabled('h2', true); assert.equal(list.length, 4);
});

function fakeLoader() {
  const calls = [];
  const load = url => {
    calls.push(url);
    if (url.includes('missing')) return Promise.reject(new Error('404'));
    const scene = new THREE.Group(), geometry = new THREE.BoxGeometry(1, 1, 1), material = new THREE.MeshStandardMaterial();
    const a = new THREE.Mesh(geometry, material), b = new THREE.Mesh(new THREE.SphereGeometry(.5), new THREE.MeshStandardMaterial());
    b.position.set(0, 2, 0); scene.add(a, b, new THREE.PointLight(0xffffff, 1));
    return Promise.resolve({ scene });
  };
  return { calls, load };
}

test('GLBs load lazily within draw + 60 m, once per asset, and placements share geometry and materials', async () => {
  const { calls, load } = fakeLoader(), scene = new THREE.Scene();
  const near = { id: 'a', asset: 'hut', x: 0, z: 0, yaw: 0, draw: 100 }, near2 = { id: 'b', asset: 'hut', x: 30, z: 10, yaw: 1, draw: 100 };
  const pois = createPois(scene, flat(0), undefined, { assets: { hut: { ...hut, radius: 0 } }, placements: [near, near2], scatter: [], load });
  assert.equal(pois.update(new THREE.Vector3(500, 0, 0)), false);
  assert.equal(calls.length, 0, 'far away nothing is requested');
  assert.equal(pois.ready(), true);
  pois.update(new THREE.Vector3(195, 0, 0)); assert.equal(calls.length, 0, 'just outside draw 100 + 60 of the nearest placement is still too far');
  pois.update(new THREE.Vector3(185, 0, 0)); assert.equal(calls.length, 1);
  assert.equal(pois.ready(), false, 'a load is in flight');
  pois.update(new THREE.Vector3(185, 0, 0)); assert.equal(calls.length, 1, 'never requested twice');
  await wait();
  assert.equal(pois.ready(), true);
  const changed = pois.update(new THREE.Vector3(185, 0, 0));
  assert.equal(changed, true, 'a new model is new shadow casters');
  const a = pois.object('a'), b = pois.object('b');
  assert.ok(a && b && a !== b);
  const meshes = o => { const r = []; o.traverse(x => { if (x.isMesh) r.push(x); }); return r; };
  assert.deepEqual(meshes(a).map(m => m.geometry === meshes(b)[meshes(a).indexOf(m)].geometry && m.material === meshes(b)[meshes(a).indexOf(m)].material), [true, true]);
  assert.ok(meshes(a).every(m => m.castShadow && m.receiveShadow));
  let lights = 0; a.traverse(o => { if (o.isLight) lights++; }); assert.equal(lights, 0, 'exported lights are stripped');
  assert.ok(Math.abs(b.rotation.y - 1) < 1e-12 && b.position.x === 30 && b.position.z === 10);
  pois.dispose();
});

test('placements hide beyond their draw distance with hysteresis, and only a real flip reports changed casters', async () => {
  const { load } = fakeLoader(), scene = new THREE.Scene();
  const pois = createPois(scene, flat(0), undefined, { assets: { hut: { ...hut, radius: 10 } }, placements: [{ id: 'a', asset: 'hut', x: 0, z: 0, yaw: 0, draw: 100 }], scatter: [], load });
  const at = x => new THREE.Vector3(x, 0, 0);
  pois.update(at(50)); await wait(); pois.update(at(50));
  const object = pois.object('a');
  assert.equal(object.visible, true);
  assert.equal(pois.update(at(109)), false); assert.equal(object.visible, true);
  assert.equal(pois.update(at(112)), false, 'drawn until draw + radius + 12');
  assert.equal(pois.update(at(123)), true); assert.equal(object.visible, false);
  assert.equal(pois.update(at(115)), false, 'and not drawn again until it is back inside draw + radius'); assert.equal(object.visible, false);
  assert.equal(pois.update(at(111)), false); assert.equal(object.visible, false);
  assert.equal(pois.update(at(109)), true); assert.equal(object.visible, true);
  assert.equal(pois.update(at(109)), false);
  pois.dispose();
});

test('a missing GLB is logged once, keeps its colliders, and the rest carries on', async () => {
  const logs = [], original = console.warn; console.warn = (...args) => logs.push(args.join(' '));
  try {
    const { calls, load } = fakeLoader();
    const assets = { hut, shed: { url: '/world/missing.glb', radius: 3, colliders: [{ kind: 'capsule', ax: 0, az: 0, bx: 0, bz: 0, radius: 1, minY: 0, maxY: 2 }] } };
    const pois = createPois(new THREE.Scene(), flat(0), undefined, { assets, placements: [place, { id: 's1', asset: 'shed', x: 21, z: -30, yaw: 0 }, { id: 's2', asset: 'shed', x: 25, z: -30, yaw: 0 }, { id: 'ghost', asset: 'unlisted', x: 0, z: 0, yaw: 0 }], scatter: [], load });
    assert.equal(logs.length, 1, 'assets with no JSON entry are reported straight away, in one line');
    assert.match(logs[0], /unlisted/);
    for (let i = 0; i < 5; i++) { pois.update(new THREE.Vector3(20, 0, -30)); await wait(); }
    assert.deepEqual(calls.sort(), ['/world/hut.glb', '/world/missing.glb'], 'a failure is not retried');
    assert.equal(logs.length, 2); assert.match(logs[1], /shed/);
    assert.equal(pois.ready(), true);
    // Once a cabin, chapel or hut has loaded, its walls also get a roof collider ('climb roof', above head height) for the creature to
    // cross: that is the fifth. The shed never loaded, so it keeps only its two posts, and nothing else gains one.
    assert.equal(pois.solidColliders.length, 5, 'two hut colliders, the hut\'s climb roof and two shed posts');
    assert.deepEqual(pois.solidColliders.map(c => c.tag).sort(), ['climb roof', 'rail', undefined, undefined, 'wall'].sort());
    const roof = pois.solidColliders.find(c => c.tag === 'climb roof');
    assert.ok(roof.minY >= 2.5 && roof.minY > 1.69, 'the roof starts above the wall tops, over a walker\'s head');
    assert.ok(pois.object('h'), 'the model that did load is placed');
    assert.equal(pois.object('s1'), undefined);
    assert.equal(pois.stats().failed, 1);
  } finally { console.warn = original; }
});

test('scatter: one InstancedMesh per GLB primitive, packed to what is in range, no clones', async () => {
  const { load } = fakeLoader(), scene = new THREE.Scene();
  const scatter = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, asset: 'hut', x: i * 10, z: 0, yaw: i * .3, scale: 1 + (i % 3) * .5, draw: 60 }));
  const pois = createPois(scene, flat(2), undefined, { assets: { hut: { ...hut, radius: 0 } }, placements: [], scatter, load });
  assert.equal(pois.solidColliders.length, 80, 'every scatter piece blocks, loaded or not');
  pois.update(new THREE.Vector3(0, 0, 0)); await wait(); pois.update(new THREE.Vector3(0, 0, 0));
  const instanced = []; scene.traverse(o => { if (o.isInstancedMesh) instanced.push(o); });
  assert.equal(instanced.length, 2, 'two primitives, two draws, however many pieces');
  assert.equal(scene.children[0].children.filter(c => c.isInstancedMesh).length, 2);
  assert.ok(instanced.every(m => m.count === 6 && m.visible), 'draw 60 from x=0 reaches pieces at 0..50');
  assert.equal(pois.object('s0'), undefined, 'no per-piece object');
  // The first instance is piece 0 on the ground at (0,2,0): translation straight from placement x/z and ground.
  const m = new THREE.Matrix4(), v = new THREE.Vector3(); instanced[0].getMatrixAt(0, m); v.setFromMatrixPosition(m);
  assert.deepEqual(v.toArray(), [0, 2, 0]);
  instanced[0].getMatrixAt(2, m); v.setFromMatrixPosition(m); assert.ok(Math.abs(v.x - 20) < 1e-6);
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixScale(m).x - 2) < 1e-6, 'scale is applied (instance matrices are float32)');
  // The second primitive is offset by its own transform inside the model (+2 on Y, scaled with the piece).
  instanced[1].getMatrixAt(2, m); v.setFromMatrixPosition(m); assert.ok(Math.abs(v.y - (2 + 2 * 2)) < 1e-6, `${v.y}`);
  // Walking away repacks, throttled by distance, and reports a real change only when the set changed.
  assert.equal(pois.update(new THREE.Vector3(.5, 0, 0)), false);
  assert.equal(pois.update(new THREE.Vector3(200, 0, 0)), true);
  assert.ok(instanced.every(i => i.count === 11 && i.boundingSphere.center.x > 140), `count ${instanced[0].count}`);
  assert.equal(pois.update(new THREE.Vector3(200.2, 0, 0)), false);
  assert.equal(pois.update(new THREE.Vector3(2000, 0, 0)), true);
  assert.ok(instanced.every(i => i.count === 0 && !i.visible), 'nothing in range, nothing drawn');
  pois.dispose();
});

test('the real layout and asset table load without the scatter export or any GLB', () => {
  const pois = createPois(new THREE.Scene(), flat(0), undefined, { load: () => Promise.reject(new Error('offline')) });
  assert.ok(Array.isArray(pois.solidColliders));
  assert.equal(pois.hook('no-such-placement', 'x'), undefined);
  assert.doesNotThrow(() => { pois.update(new THREE.Vector3(0, 0, 0)); pois.dispose(); });
});

// ---------------------------------------------------------------------------------------------------------------------
// Seating on the ground (WORLD_V2). The flag is off in this file, so everything below asks for it with `seat: true`;
// the tests above are the flag-off behaviour and must keep passing unchanged.
const tilted = (gx, gz) => (x, z) => 2 + gx * x + gz * z;
const crate = { url: '/world/crate.glb', radius: 1, colliders: [{ kind: 'box', x: 0, z: 0, halfX: .38, halfZ: .38, yaw: 0, minY: 0, maxY: .73, tag: 'crate' }], hooks: { top: [0, .73, 0] } };
const post = { url: '/world/post.glb', radius: 1, colliders: [{ kind: 'capsule', ax: 0, az: 0, bx: 0, bz: 0, radius: .1, minY: 0, maxY: 2.3 }] };
const yard = { url: '/world/yard.glb', radius: 12, colliders: [{ kind: 'box', x: 0, z: 0, halfX: 5, halfZ: 5, yaw: 0, minY: 0, maxY: 3 }] };
const boulder = { url: '/world/boulder.glb', radius: 5, colliders: [{ kind: 'capsule', ax: 0, az: 0, bx: 0, bz: 0, radius: 3, minY: -1, maxY: 3 }] };
const stand = { id: 'c1', asset: 'crate', x: 12, z: -7, yaw: .7, fit: 'tilt' };

/** The seat as the world sees it: the model transform the object, the hooks and the scatter matrix all share. */
const seatMatrix = (p, seat, scale = 1) => new THREE.Matrix4().compose(new THREE.Vector3(p.x, seat.ground, p.z),
  seat.quaternion ?? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(scale, scale, scale));
/** Worst float and worst burial of the base rectangle over a fine grid, against the terrain. */
function baseGaps(asset, p, seat, terrain) {
  const rect = footprintOf(asset, p.footprint), matrix = seatMatrix(p, seat, p.scale ?? 1);
  let float = -Infinity, bury = -Infinity;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const w = new THREE.Vector3(rect.cx + (i / 10 - 1) * rect.hx, 0, rect.cz + (j / 10 - 1) * rect.hz).applyMatrix4(matrix), g = w.y - terrain(w.x, w.z);
    float = Math.max(float, g); bury = Math.max(bury, -g);
  }
  return { float, bury };
}
const tiltDegrees = q => Math.acos(new THREE.Vector3(0, 1, 0).applyQuaternion(q).y) * 180 / Math.PI;

test('footprintOf: the declared footprint, else the bounds of the colliders (boxes by their turned extent), else a square of side radius', () => {
  const declared = { cx: 1, cz: 2, hx: 3, hz: 4 };
  assert.deepEqual(footprintOf(crate, declared), declared);
  assert.deepEqual(footprintOf(crate), { cx: 0, cz: 0, hx: .38, hz: .38 });
  const turned = footprintOf({ url: '', radius: 1, colliders: [{ kind: 'box', x: 1, z: 0, halfX: 2, halfZ: 1, yaw: Math.PI / 2, minY: 0, maxY: 1 }, { kind: 'capsule', ax: -3, az: 0, bx: -3, bz: 2, radius: .5, minY: 0, maxY: 1 }] });
  // The box turned a quarter circle covers x 0..2 and z -2..2; the capsule covers x -3.5..-2.5 and z -.5..2.5: together x -3.5..2, z -2..2.5.
  assert.ok(Math.abs(turned.cx - -.75) < 1e-9 && Math.abs(turned.hx - 2.75) < 1e-9 && Math.abs(turned.cz - .25) < 1e-9 && Math.abs(turned.hz - 2.25) < 1e-9, JSON.stringify(turned));
  assert.deepEqual(footprintOf({ url: '', radius: 1 }), { cx: 0, cz: 0, hx: .5, hz: .5 }, 'no colliders: radius * .5');
});

test('seating, upright: the base is the lowest terrain under the footprint less a small embed, so nothing floats and posts look driven in', () => {
  const terrain = tilted(.3, -.1);
  for (const yaw of [0, .7, 2.2, -1.1]) {
    const p = { id: 'p', asset: 'crate', x: 12, z: -7, yaw }, seat = seatPlacement(crate, p, terrain);
    assert.equal(seat.placement, p, 'upright placements keep their yaw'); assert.equal(seat.quaternion, undefined);
    const gaps = baseGaps(crate, p, seat, terrain);
    assert.ok(gaps.float < 0, `yaw ${yaw}: floats ${gaps.float}`);
    assert.ok(Math.abs(gaps.float + .038) < 2e-3, `yaw ${yaw}: the lowest corner is bedded in by the embed (.05 m per metre of footprint = 3.8 cm), not ${gaps.float}`);
    assert.ok(seat.ground < terrain(p.x, p.z), 'on a slope the origin is not the lowest point');
  }
  const flat = seatPlacement(post, { id: 'q', asset: 'post', x: 0, z: 0, yaw: 0 }, () => 5);
  assert.ok(Math.abs(flat.ground - (5 - .05 * .2)) < 1e-12, 'a post is driven in by a centimetre');
  assert.ok(Math.abs(seatPlacement(yard, { id: 'y', asset: 'yard', x: 0, z: 0, yaw: 0 }, () => 5).ground - (5 - .06)) < 1e-12, 'a building is bedded in by at most 6 cm');
  assert.equal(seatPlacement(yard, { id: 'y', asset: 'yard', x: 0, z: 0, yaw: 0, footprint: { cx: 0, cz: 0, hx: 1, hz: 1 } }, x => x > 1 ? 99 : 5).ground, 5 - .06, 'a declared footprint is what is sampled, not the colliders');
  assert.equal(seatPlacement(boulder, { id: 'r', asset: 'boulder', x: 4, z: 4, yaw: 1 }, tilted(.4, .2)).ground, tilted(.4, .2)(4, 4), 'a rock modelled below its origin keeps the terrain at its origin');
});

test('seating, tilted: the object lies along the slope (at most 22 degrees), never floats, and repeats do not match', () => {
  for (const [gx, gz] of [[.2, .1], [-.15, .25], [0, 0]]) {
    const terrain = tilted(gx, gz), seat = seatPlacement(crate, stand, terrain), slope = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
    assert.ok(Math.abs(tiltDegrees(seat.quaternion) - slope) <= 2.6, `terrain ${slope.toFixed(1)} deg, object ${tiltDegrees(seat.quaternion).toFixed(1)}`);
    const gaps = baseGaps(crate, seat.placement, seat, terrain);
    assert.ok(gaps.float < 1e-9, `floats ${gaps.float}`); assert.ok(gaps.bury < .038 + .76 * Math.tan(2.5 * Math.PI / 180) + 1e-6, `buried ${gaps.bury}`);
  }
  const steep = tilted(1, 0), s = seatPlacement(crate, stand, steep);
  assert.ok(tiltDegrees(s.quaternion) <= 22 + 2.6 && tiltDegrees(s.quaternion) > 19, `a 45 degree slope is capped: ${tiltDegrees(s.quaternion).toFixed(1)}`);
  assert.ok(baseGaps(crate, s.placement, s, steep).float < 1e-9, 'and it still does not float');
  const a = seatPlacement(crate, stand, tilted(.2, .1)), b = seatPlacement(crate, stand, tilted(.2, .1)), c = seatPlacement(crate, { ...stand, id: 'c2' }, tilted(.2, .1));
  assert.deepEqual(a.quaternion.toArray(), b.quaternion.toArray()); assert.equal(a.ground, b.ground);
  assert.ok(Math.abs(a.placement.yaw - stand.yaw) <= .2 + 1e-12 && Math.abs(c.placement.yaw - stand.yaw) <= .2 + 1e-12 && a.placement.yaw !== stand.yaw, 'a little extra yaw');
  assert.notEqual(a.placement.yaw, c.placement.yaw, 'another id turns differently');
  assert.notDeepEqual(a.quaternion.toArray(), c.quaternion.toArray(), 'and rolls differently');
});

test('createPois with seating: colliders, hooks, the model and the scatter instance all stand on the same ground and tilt', async () => {
  const terrain = tilted(.2, .1), { load } = fakeLoader(), scene = new THREE.Scene(), world = createCollisionWorld();
  const placements = [stand, { id: 'post1', asset: 'post', x: -6, z: 3, yaw: 1 }], scatter = [{ ...stand, id: 's1', x: 30, z: 10 }];
  const pois = createPois(scene, terrain, world, { assets: { crate, post }, placements, scatter, load, seat: true });
  const seat = seatPlacement(crate, stand, terrain), matrix = seatMatrix(seat.placement, seat), expectedHook = new THREE.Vector3(0, .73, 0).applyMatrix4(matrix);
  assert.ok(seat.quaternion, 'the crate is tilted');
  const hook = pois.hook('c1', 'top');
  assert.ok(hook.distanceTo(expectedHook) < 1e-9, 'the hook follows the tilt');
  assert.ok(hook.distanceTo(new THREE.Vector3(stand.x, seat.ground + .73, stand.z)) > .01, 'and is not where an upright crate would have it');
  const [box] = worldColliders(crate, seat.placement, seat.ground, seat.quaternion);
  assert.deepEqual(pois.solidColliders[0], box, 'the collider is the same seated one');
  assert.ok(Math.abs(box.minY - seat.ground) < 1e-9 && Math.abs(box.maxY - (seat.ground + .73)) < 1e-9 && box.x === stand.x && box.z === stand.z, 'the crate stands on the seated origin');
  const upright = seatPlacement(post, placements[1], terrain);
  assert.equal(pois.solidColliders[1].minY, upright.ground, 'an upright post is seated on its lowest sample');
  assert.ok(upright.ground < terrain(-6, 3));
  pois.update(new THREE.Vector3(12, 0, -7)); await wait(); pois.update(new THREE.Vector3(12, 0, -7));
  const object = pois.object('c1'); object.updateMatrixWorld(true);
  const world4 = new THREE.Matrix4().copy(object.matrixWorld);
  assert.ok(world4.elements.every((v, i) => Math.abs(v - matrix.elements[i]) < 1e-6), 'the model is placed with the seat matrix');
  // The scatter instance is the same matrix, with the primitive's own transform inside the model on top.
  pois.update(new THREE.Vector3(30, 0, 10)); await wait(); pois.update(new THREE.Vector3(30.5, 0, 10)); pois.update(new THREE.Vector3(33, 0, 10));
  const instanced = []; scene.traverse(o => { if (o.isInstancedMesh && o.count) instanced.push(o); });
  assert.ok(instanced.length, 'the scatter piece is drawn');
  const got = new THREE.Matrix4(), want = seatMatrix({ ...stand, x: 30, z: 10 }, seatPlacement(crate, { ...stand, id: 's1', x: 30, z: 10 }, terrain));
  instanced[0].getMatrixAt(0, got);
  assert.ok(got.elements.every((v, i) => Math.abs(v - want.elements[i]) < 1e-4), 'the instance matrix is the seat matrix');
  pois.dispose();
});

test('seating is off unless asked for or WORLD_V2 is on: Y is the terrain at the origin, as before', () => {
  const terrain = tilted(.3, .1), p = { id: 'c1', asset: 'crate', x: 12, z: -7, yaw: .7, fit: 'tilt' };
  const pois = createPois(new THREE.Scene(), terrain, undefined, { assets: { crate }, placements: [p], scatter: [], load: () => new Promise(() => {}) });
  assert.equal(pois.solidColliders[0].minY, terrain(12, -7));
  const hook = pois.hook('c1', 'top'); assert.ok(Math.abs(hook.y - (terrain(12, -7) + .73)) < 1e-12 && hook.x === 12 && hook.z === -7);
  const off = createPois(new THREE.Scene(), terrain, undefined, { assets: { crate }, placements: [p], scatter: [], load: () => new Promise(() => {}), seat: false });
  assert.equal(off.solidColliders[0].minY, terrain(12, -7));
});

test('a seated placement\'s ladder points follow the same transform as its hooks', () => {
  const ladder = { url: '', radius: 1, ladders: [{ bottom: [0, 0, 1], top: [0, 3, 1], exit: [0, 3, 0] }] };
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .2), p = { id: 'l', asset: 'ladder', x: 5, z: 6, yaw: 0 };
  const w = worldLadder(ladder, p, 2, 0, q), expected = new THREE.Vector3(0, 3, 1).applyQuaternion(q).add(new THREE.Vector3(5, 2, 6));
  assert.ok(Math.abs(w.top.x - expected.x) < 1e-12 && Math.abs(w.top.y - expected.y) < 1e-12 && Math.abs(w.top.z - expected.z) < 1e-12);
  const up = worldLadder(ladder, p, 2, 0); assert.equal(up.top.y, 5, 'upright is unchanged');
});
