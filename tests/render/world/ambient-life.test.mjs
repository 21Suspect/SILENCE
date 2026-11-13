import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
const { createAmbientLife } = await import('../../../game/render/world/ambient-life.ts');
const { CROW_FOOT } = await import('../../../game/render/world/crow-model.ts');

// A cabin ridge to sit on, 100 m east of the player, and four stands of trees further out.
const perches = Array.from({ length: 12 }, (_, k) => ({ x: 97 + k * .55, y: 12, z: 0, yaw: Math.PI / 2 }));
const ridge = { x: 100, y: 12, z: 0, perches };
const woods = [ridge, { x: 260, y: 18, z: 90, hidden: true }, { x: -150, y: 18, z: 100, hidden: true }, { x: 20, y: 18, z: -200, hidden: true }, { x: 300, y: 18, z: -150, hidden: true }];
const make = (over = {}) => {
  const scene = new THREE.Scene(), bursts = [];
  const life = createAmbientLife(scene, { roosts: woods, chimney: new THREE.Vector3(10, 5, 10), heightAt: () => 0, onBurst: (...p) => bursts.push(p), ...over });
  return { scene, life, bursts, crows: life.objects.crows, player: new THREE.Vector3(0, 0, 0) };
};
const run = (life, player, darkness, from, seconds, dt = 1 / 60, each) => {
  let t = from;
  for (let i = 0; i < seconds / dt; i++) { const d = typeof darkness === 'function' ? darkness(t) : darkness; life.update({ time: t, dt, player, darkness: d, viewScale: 700 }); t += dt; each?.(t, d); }
  return t;
};
const drawn = crows => { const m = new THREE.Matrix4(), out = []; for (let i = 0; i < crows.count; i++) { crows.getMatrixAt(i, m); const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s); out.push({ p, s: s.x, fold: crows.geometry.getAttribute('aBird').getZ(i), m: m.clone() }); } return out; };
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('by day the flock sits on the ridge with gaps along it, feet on the perch and wings folded; the smoke rises', () => {
  const { life, crows, player } = make();
  run(life, player, 0, 0, 2);
  const s = life.stats();
  assert.equal(s.home, 0); assert.equal(s.airborne, 0); assert.equal(s.smokeVisible, true);
  assert.ok(s.perched >= 5 && s.perched <= 8, `${s.perched} sitting: never all twelve places`);
  const birds = drawn(crows);
  assert.equal(birds.length, s.perched);
  for (const b of birds) {
    assert.ok(perches.some(q => Math.hypot(q.x - b.p.x, q.z - b.p.z) < 1e-3), 'on a perch');
    assert.ok(Math.abs(b.p.y - 12 - CROW_FOOT * b.s) < 1e-3, 'standing on it, not floating or sunk');
    assert.equal(b.fold, 1);
  }
});

test('a flock resting in the trees is not drawn at all', () => {
  const { life, crows, player } = make({ roosts: woods.slice(1) });
  run(life, player, 0, 0, 3);
  assert.ok(life.stats().home >= 0); assert.equal(crows.count, 0); assert.equal(crows.visible, false);
});

test('walking up to the roost bursts the flock out within about a second, once, and it flies away from the player to a roost 120 m off', () => {
  const { life, bursts, crows, player } = make();
  let t = run(life, player, 0, 0, 1);
  const sitting = life.stats().perched;
  player.set(60, 0, 0); t = run(life, player, 0, t, 1);
  assert.equal(bursts.length, 0, '40 m away is not a startle');
  player.set(80, 0, 0); t = run(life, player, 0, t, .1);
  assert.equal(bursts.length, 1, 'inside 25 m');
  assert.deepEqual(bursts[0], [ridge.x, ridge.y, ridge.z]);
  t = run(life, player, 0, t, 1.4);
  assert.equal(life.stats().airborne, sitting, 'every bird that sat there is up within a second and a half');
  // From here on: the flock's middle only gets further from the player, and no bird winds round (no circling).
  const centre = () => { const b = drawn(crows).filter(q => q.s > .5); return b.reduce((a, q) => a.add(q.p), new THREE.Vector3()).divideScalar(b.length || 1); };
  let last = flat(centre(), player), turned = 0, heading;
  for (let k = 0; k < 30; k++) {
    t = run(life, player, 0, t, .5);
    if (!crows.count) break;
    const c = centre(), d = flat(c, player);
    assert.ok(d > last - .5, `the flock came back towards the player (${last.toFixed(1)} -> ${d.toFixed(1)} m)`);
    const h = Math.atan2(c.x - (centre.lx ?? c.x), c.z - (centre.lz ?? c.z));
    if (centre.lx !== undefined && heading !== undefined) turned += Math.abs(Math.atan2(Math.sin(h - heading), Math.cos(h - heading)));
    if (centre.lx !== undefined) heading = h;
    centre.lx = c.x; centre.lz = c.z; last = d;
  }
  assert.ok(turned < Math.PI * .75, `the flock turned ${(turned * 180 / Math.PI).toFixed(0)} degrees in all`);
  t = run(life, player, 0, t, 40);
  const s = life.stats();
  // (Any crows still about now are commuters, not the flock.)
  assert.equal(s.transit, 0, 'the flock has landed'); assert.equal(s.perched, 0, 'in the trees, not drawn');
  assert.ok(s.home > 0, 'a new roost');
  const home = woods[s.home], away = new THREE.Vector2(ridge.x - player.x, ridge.z - player.z).normalize();
  assert.ok(Math.hypot(home.x - ridge.x, home.z - ridge.z) >= 120);
  assert.ok((home.x - ridge.x) * away.x + (home.z - ridge.z) * away.y > 0, 'on the far side of the ridge from the player');
  assert.equal(bursts.length, 1, 'standing there does not fire it again');
});

test('with nowhere to go, a startled flock still flies off into the distance and is gone', () => {
  const { life, crows, player } = make({ roosts: [ridge] });
  let t = run(life, player, 0, 0, 1);
  player.set(90, 0, 5); t = run(life, player, 0, t, 3);
  assert.ok(life.stats().airborne > 0);
  run(life, player, 0, t, 45);
  assert.equal(crows.count, 0);
});

test('by day a few crows commute between two stands of trees across the sky, high and straight, then drop out of sight', () => {
  const roosts = [{ x: -200, y: 18, z: 60, hidden: true }, { x: 210, y: 18, z: 10, hidden: true }, { x: 0, y: 18, z: 400, hidden: true }];
  const { life, crows, player } = make({ roosts });
  let t = run(life, player, 0, 0, 1);
  assert.equal(life.commute(), true);
  let most = 0, minPass = Infinity; const heights = [];
  t = run(life, player, 0, t, 30, 1 / 30, () => {
    most = Math.max(most, crows.count);
    for (const b of drawn(crows)) {
      const fromEnds = Math.min(flat(b.p, roosts[0]), flat(b.p, roosts[1]));
      if (fromEnds > 80) heights.push(b.p.y);
      minPass = Math.min(minPass, flat(b.p, player));
    }
  });
  assert.ok(most >= 1 && most <= 4, `${most} birds`);
  assert.ok(heights.length > 0 && Math.min(...heights) > 18 && Math.max(...heights) < 52, `between ${Math.min(...heights).toFixed(0)} and ${Math.max(...heights).toFixed(0)} m up`);
  assert.ok(minPass < 90, `passed within ${minPass.toFixed(0)} m of the player`);
  // Far off, no new crossing can be in sight of the player: the ones in the air land and nothing is left drawn.
  player.set(2000, 0, 2000); run(life, player, 0, t, 60);
  assert.equal(crows.count, 0, 'gone again');
});

test('at dusk the flock streams off its roost and every crow is down before dark; at night nothing is drawn', () => {
  const { life, crows, player } = make();
  player.set(60, 0, 20);
  // The game's own clock: darkness from 0 at 18:00 to .6 at 18:45 is 45 s.
  const dark = t => Math.min(1, Math.max(0, (t - 5) / 45 * .6));
  let flying = 0, lateFlying = 0;
  run(life, player, dark, 0, 80, 1 / 60, (t, d) => {
    const a = life.stats().airborne;
    if (d < .45) flying = Math.max(flying, a);
    if (d >= .6) lateFlying = Math.max(lateFlying, a);
  });
  assert.ok(flying >= 4, `${flying} in the air at dusk`);
  assert.equal(lateFlying, 0, 'none still up after dark');
  assert.equal(crows.visible, false); assert.equal(crows.count, 0);
});

test('night never draws a crow or a bat', () => {
  const { life, player, scene } = make();
  run(life, player, 1, 0, 2);
  assert.equal(life.stats().draws, 0);
  assert.equal(scene.getObjectByName('Fireflies'), undefined);
  life.startle(); run(life, player, 1, 2, 2);
  assert.equal(life.stats().draws, 0, 'not even when startled');
});

test('the flock never starts on the roost the player is standing at, and follows the player round out of sight', () => {
  const { life, player } = make();
  player.set(95, 0, 8);
  run(life, player, 0, 0, 2);
  assert.notEqual(life.stats().home, 0, 'not the ridge 10 m away');
  const far = make();
  run(far.life, far.player, 0, 0, 2); assert.equal(far.life.stats().home, 0);
  far.player.set(400, 0, -140); run(far.life, far.player, 0, 2, 3);
  assert.equal(far.life.stats().home, 4, 'moved to the stand 100 m from the player');
  assert.equal(far.life.stats().perched, 0, 'and the ridge is empty');
});

test('no allocation worth the name and well under 0.3 ms a frame, even in the busiest moment', () => {
  const { life, player } = make();
  // The busiest case: the flock startled and a commute crossing at once, smoke up, both draws live.
  let t = run(life, player, 0, 0, 1);
  player.set(85, 0, 0); t = run(life, player, 0, t, .5); life.commute();
  for (let i = 0; i < 300; i++) { life.update({ time: t, dt: 1 / 60, player, darkness: 0, viewScale: 700 }); t += 1 / 60; }
  const frames = 4000, heapBefore = process.memoryUsage().heapUsed, start = performance.now();
  for (let i = 0; i < frames; i++) { player.z = Math.sin(i * .01) * 10; life.update({ time: t, dt: 1 / 60, player, darkness: 0, viewScale: 700 }); t += 1 / 60; }
  const perFrame = (performance.now() - start) / frames, heap = process.memoryUsage().heapUsed - heapBefore;
  assert.ok(perFrame < .3, `${perFrame.toFixed(4)} ms per frame`);
  assert.ok(heap < 6 * 1024 * 1024, `heap grew ${(heap / 1024).toFixed(0)} KB over ${frames} frames`);
});

test('every drawn crow has a finite, proper (non-mirrored) transform, all through a startle', () => {
  const { life, crows, player } = make();
  let t = run(life, player, 0, 0, 1);
  player.set(82, 0, 3);
  for (let k = 0; k < 40; k++) {
    t = run(life, player, 0, t, .5);
    for (const b of drawn(crows)) { assert.ok(b.m.elements.every(Number.isFinite)); assert.ok(b.m.determinant() > 0); }
  }
});
