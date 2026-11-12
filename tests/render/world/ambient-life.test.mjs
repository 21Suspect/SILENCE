import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
const { createAmbientLife } = await import('../../../game/render/world/ambient-life.ts');

const roost = { x: 100, y: 12, z: 0 };
const make = (over = {}) => {
  const scene = new THREE.Scene(), bursts = [];
  const life = createAmbientLife(scene, { roosts: [roost], chimney: new THREE.Vector3(10, 5, 10), heightAt: () => 0, habitat: () => 1, onBurst: (...p) => bursts.push(p), ...over });
  return { scene, life, bursts, crows: life.objects.crows, player: new THREE.Vector3(0, 0, 0) };
};
const run = (life, player, darkness, from, seconds, dt = 1 / 60) => {
  let t = from; for (let i = 0; i < seconds / dt; i++) { life.update({ time: t, dt, player, darkness, viewScale: 700 }); t += dt; } return t;
};
const positions = crows => { const m = new THREE.Matrix4(), v = new THREE.Vector3(), out = []; for (let i = 0; i < crows.count; i++) { crows.getMatrixAt(i, m); out.push(v.setFromMatrixPosition(m).clone()); } return out; };

test('by day the flock sits on its roost, the smoke rises, and there are no fireflies', () => {
  const { life, crows, player } = make();
  run(life, player, 0, 0, 2);
  const s = life.stats();
  assert.equal(s.home, 0); assert.equal(s.airborne, 0); assert.equal(s.crowsVisible, true); assert.equal(s.smokeVisible, true);
  for (const p of positions(crows)) { assert.ok(Math.abs(p.x - roost.x) < 1.5 && Math.abs(p.y - roost.y) < .5 && Math.abs(p.z - roost.z) < 1.5, p.toArray().join()); }
  assert.ok(positions(crows).some(p => p.x !== positions(crows)[0].x), 'spread around the perch, not one point');
});

test('walking up to the roost bursts the flock upward, once, and it circles high', () => {
  const { life, bursts, crows, player } = make();
  let t = run(life, player, 0, 0, 1);
  player.set(60, 0, 0); t = run(life, player, 0, t, 1);
  assert.equal(bursts.length, 0, '40 m away is not a startle');
  player.set(78, 0, 0); t = run(life, player, 0, t, .5);
  assert.equal(bursts.length, 1, 'inside 25 m');
  assert.deepEqual(bursts[0], [roost.x, roost.y, roost.z]);
  const before = life.stats().airborne;
  t = run(life, player, 0, t, 3);
  assert.ok(life.stats().airborne >= 22 && life.stats().airborne > before, `almost all are airborne after a few seconds (${life.stats().airborne})`);
  t = run(life, player, 0, t, 8);
  for (const p of positions(crows)) assert.ok(p.y > roost.y + 20, `high: ${p.y.toFixed(1)}`);
  const centre = positions(crows).reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(crows.count);
  assert.ok(Math.hypot(centre.x - roost.x, centre.z - roost.z) < 25, 'circling about the roost, not flying away');
  assert.equal(bursts.length, 1, 'standing there does not keep re-firing the caw');
  // They stay up for a while after a day-time startle, then settle again.
  player.set(0, 0, 0); t = run(life, player, 0, t, 25); assert.ok(life.stats().airborne > 20);
  t = run(life, player, 0, t, 90); assert.equal(life.stats().airborne, 0, 'back on the roost once things are quiet');
});

test('at dusk they lift off on their own, a few at a time, and circle', () => {
  const { life, crows, player } = make();
  let t = run(life, player, 0, 0, 1);
  t = run(life, player, .35, t, 6); const early = life.stats().airborne;
  assert.ok(early < 24, 'a slow take-off, not all at once');
  t = run(life, player, .35, t, 40);
  assert.equal(life.stats().airborne, 24);
  const first = positions(crows); t = run(life, player, .35, t, 3); const later = positions(crows);
  assert.ok(first.some((p, i) => p.distanceTo(later[i]) > 10), 'they are moving along their circles');
  assert.ok(later.every(p => p.y > roost.y + 28 && Math.hypot(p.x - roost.x, p.z - roost.z) < 50));
  // Deep night they are gone; at dawn they start from the roost again.
  run(life, player, .99, t, 1); assert.equal(life.stats().crowsVisible, false);
});

test('night never creates fireflies', () => {
  const {life, player, scene} = make(); run(life, player, 1, 0, 2);
  assert.equal(scene.getObjectByName('Fireflies'), undefined);
  assert.equal(life.stats().draws, 0);
});

test('no allocation worth the name and well under 0.3 ms a frame, even in the busiest moment', () => {
  const { life, player } = make();
  // The busiest case: dusk, flock aloft and alarmed, smoke up, both draws live.
  player.set(90, 0, 0);
  let t = run(life, player, .6, 0, 3);
  for (let i = 0; i < 300; i++) { player.x = 90 + Math.sin(i * .05) * 20; life.update({ time: t, dt: 1 / 60, player, darkness: .6, viewScale: 700 }); t += 1 / 60; }
  const frames = 4000, heapBefore = process.memoryUsage().heapUsed, start = performance.now();
  for (let i = 0; i < frames; i++) { player.x = 90 + Math.sin(i * .05) * 20; player.z = Math.cos(i * .03) * 30; life.update({ time: t, dt: 1 / 60, player, darkness: .6, viewScale: 700 }); t += 1 / 60; }
  const perFrame = (performance.now() - start) / frames, heap = process.memoryUsage().heapUsed - heapBefore;
  assert.ok(life.stats().draws === 2, 'both layers were live');
  assert.ok(perFrame < .3, `${perFrame.toFixed(4)} ms per frame`);
  assert.ok(heap < 6 * 1024 * 1024, `heap grew ${(heap / 1024).toFixed(0)} KB over ${frames} frames`);
  // Every instance matrix is finite and a proper (non-mirrored) transform.
  const m = new THREE.Matrix4();
  for (let i = 0; i < life.objects.crows.count; i++) { life.objects.crows.getMatrixAt(i, m); assert.ok(m.elements.every(Number.isFinite)); assert.ok(m.determinant() > 0); }
});

test('hidden roosts keep the birds out of sight until they break cover', () => {
  const { life, crows, player } = make({ roosts: [{ ...roost, hidden: true }] });
  run(life, player, 0, 0, 1);
  const m = new THREE.Matrix4(), scale = new THREE.Vector3();
  for (let i = 0; i < crows.count; i++) { crows.getMatrixAt(i, m); assert.ok(scale.setFromMatrixScale(m).length() < 1e-6, 'collapsed to nothing while perched'); }
  player.set(90, 0, 0); run(life, player, 0, 1, 4);
  crows.getMatrixAt(3, m); assert.ok(scale.setFromMatrixScale(m).x > .5, 'full size once airborne');
});

test('the flock moves to a nearer roost when the player is far away and it is out of sight', () => {
  const { life, player } = make({ roosts: [roost, { x: -400, y: 12, z: 0 }] });
  player.set(80, 0, 0); run(life, player, 0, 0, 2); // 20 m from the first: startled, chooses the farther-than-60 m one
  assert.equal(life.stats().home, 1, 'never starts on top of the player');
  const dawn = make({ roosts: [roost, { x: -400, y: 12, z: 0 }] });
  dawn.player.set(0, 0, 0); run(dawn.life, dawn.player, 0, 0, 2); assert.equal(dawn.life.stats().home, 0);
  dawn.player.set(-380, 0, 20); run(dawn.life, dawn.player, 0, 2, 3); // teleported to 20 m from the far roost: it is too close to pop birds onto
  assert.equal(dawn.life.stats().home, 0, 'the flock does not appear on top of the player');
  dawn.player.set(-300, 0, 20); run(dawn.life, dawn.player, 0, 5, 3); // 100 m out, and 400 m from the flock: it is already there when you arrive
  assert.equal(dawn.life.stats().home, 1);
});
