import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createBicycle, BICYCLE } = await import('../../../game/sim/player/bicycle.ts');
const { STAMINA } = await import('../../../game/sim/player/stamina.ts');
const { NOISE, hears } = await import('../../../game/sim/noise/noise-scale.ts');

const HOME = { x: 10, z: 20 };
const GO = { throttle: 1, brake: 0, steer: 0 };
const IDLE = { throttle: 0, brake: 0, steer: 0 };
const ridden = () => { const b = createBicycle(HOME); assert.ok(b.mount(HOME, 'dirt', 0)); return b; };
const run = (b, seconds, input, surface, dt = 1 / 60) => {
  let r; const noises = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) { r = b.update(dt, input, surface); if (r.noise) noises.push(r.noise); }
  return { r, noises };
};

test('top speeds: three times walking on roads and paths, slow elsewhere', () => {
  assert.equal(BICYCLE.roadSpeed, 3 * STAMINA.walkSpeed);
  for (const [surface, v] of [['road', 5.4], ['path', 5.4], ['forest', 2.2], ['dirt', 2.2], ['beach', 2.2]]) {
    const { r } = run(ridden(), 8, GO, surface);
    assert.ok(Math.abs(r.speed - v) < 1e-9, `${surface}: ${r.speed}`);
  }
});

test('a heavy part strapped on: x0.8, and one rack only', () => {
  const b = ridden();
  assert.equal(b.strap('motor'), true); assert.equal(b.strap('battery'), false);
  assert.ok(Math.abs(run(b, 8, GO, 'road').r.speed - 5.4 * .8) < 1e-9);
  assert.ok(Math.abs(run(b, 8, GO, 'forest').r.speed - 2.2 * .8) < 1e-9);
  assert.equal(b.unstrap(), 'motor'); assert.equal(b.unstrap(), null);
  assert.ok(Math.abs(run(b, 8, GO, 'road').r.speed - 5.4) < 1e-9);
});

test('speed eases: not instant up, braking is quicker than coasting, and leaving the road sheds the extra', () => {
  const b = ridden();
  const first = run(b, 1 / 60, GO, 'road').r.speed; assert.ok(first > 0 && first < .1);
  run(b, 8, GO, 'road');
  const coast = ridden(); run(coast, 8, GO, 'road');
  const c = run(coast, 1, IDLE, 'road').r.speed, k = run(b, 1, { ...IDLE, brake: 1 }, 'road').r.speed;
  assert.ok(c > 3 && k === 0, `coasted to ${c}, braked to ${k}`);
  const fast = ridden(); run(fast, 8, GO, 'road');
  const off = run(fast, 1 / 60, GO, 'forest').r.speed; assert.ok(off > 5, 'not snapped');
  assert.ok(Math.abs(run(fast, 2, GO, 'forest').r.speed - 2.2) < 1e-9);
});

test('steering turns slowly at speed and not at all standing still', () => {
  const still = ridden(); assert.equal(run(still, 2, { ...IDLE, steer: 1 }, 'road').r.heading, 0);
  const slow = ridden(); run(slow, .6, GO, 'road'); const h0 = slow.update(1e-6, GO, 'road').heading;
  const hSlow = run(slow, 1, { ...GO, steer: 1 }, 'road').r.heading - h0;
  const fast = ridden(); run(fast, 8, GO, 'road'); const f0 = fast.update(1e-6, GO, 'road').heading;
  const hFast = run(fast, 1, { ...GO, steer: 1 }, 'road').r.heading - f0;
  assert.ok(hSlow > hFast && hFast > .4 && hFast < .8, `slow ${hSlow}, fast ${hFast}`);
  const left = run(ridden(), 4, { throttle: 1, brake: 0, steer: -1 }, 'road').r.heading; assert.ok(left < 0);
});

test('no sprint, crouch or jump while riding; free on foot', () => {
  const b = createBicycle(HOME);
  for (const a of ['sprint', 'crouch', 'jump']) assert.equal(b.allows(a), true);
  b.mount(HOME, 'road', 0);
  for (const a of ['sprint', 'crouch', 'jump']) assert.equal(b.allows(a), false);
});

test('rolling noise: 7 m on tracks, 45 m off them, once a second, none standing', () => {
  const { noises } = run(ridden(), 10, GO, 'path');
  assert.ok(noises.length >= 8 && noises.length <= 10, `${noises.length} pulses`);
  assert.ok(noises.every(x => x === NOISE.bicyclePath));
  assert.ok(hears(NOISE.bicyclePath, 6) && !hears(NOISE.bicyclePath, 8));
  const rough = run(ridden(), 10, GO, 'forest');
  assert.ok(rough.noises.length >= 8 && rough.noises.every(x => x === NOISE.bicycleRough));
  assert.ok(rough.noises[0] > noises[0] * 5);
  const standing = run(ridden(), 5, IDLE, 'road'); assert.equal(standing.noises.length, 0); assert.equal(standing.r.loudness, 0);
});

test('loaded: 25 m on tracks, still 45 m off them', () => {
  const b = ridden(); b.strap('motor');
  assert.ok(run(b, 10, GO, 'road').noises.every(x => x === NOISE.loadedBicyclePath));
  assert.ok(run(b, 10, GO, 'forest').noises.every(x => x === NOISE.bicycleRough));
  assert.ok(NOISE.loadedBicyclePath > NOISE.bicyclePath * 3);
});

test('the pulse rate is the same at 30, 60 and 144 steps a second', () => {
  for (const hz of [30, 60, 144]) {
    const { noises } = run(ridden(), 20, GO, 'road', 1 / hz);
    assert.ok(noises.length >= 18 && noises.length <= 20, `${hz} Hz: ${noises.length}`);
  }
});

test('speed and turn at 30 and 144 steps a second agree', () => {
  const at = hz => { const b = ridden(); run(b, 3, GO, 'road', 1 / hz); return run(b, 2, { ...GO, steer: .5 }, 'road', 1 / hz).r; };
  const a = at(30), c = at(144);
  assert.ok(Math.abs(a.speed - c.speed) < .01 && Math.abs(a.heading - c.heading) < .03, `${a.heading} vs ${c.heading}`);
});

test('the bell: 70 m, one ring per press, 1.5 s apart, on foot or riding', () => {
  const b = ridden();
  assert.equal(b.ring(), NOISE.bell); assert.equal(b.ring(), 0);
  run(b, 1.4, IDLE, 'road'); assert.equal(b.ring(), 0);
  run(b, .2, IDLE, 'road'); assert.equal(b.ring(), NOISE.bell);
  b.dismount(); run(b, 1.6, IDLE, 'road'); assert.equal(b.ring(), NOISE.bell);
});

test('water: cannot mount, and riding into it forces a dismount', () => {
  const b = createBicycle(HOME);
  assert.equal(b.mount(HOME, 'water', 0), false);
  assert.equal(b.mount(HOME, 'road', 0), true);
  run(b, 3, GO, 'road');
  const r = b.update(1 / 60, GO, 'water');
  assert.equal(r.mounted, false); assert.equal(r.speed, 0); assert.deepEqual(r.events, ['dismounted-water']);
  assert.equal(b.mounted, false);
  assert.equal(run(b, 2, GO, 'road').r.speed, 0, 'a parked bicycle does not ride off');
});

test('mount rules: within reach, not on a ladder, not twice', () => {
  const b = createBicycle(HOME);
  assert.equal(b.canMount({ x: 10, z: 21.9 }, 'dirt'), true);
  assert.equal(b.canMount({ x: 10, z: 22.5 }, 'dirt'), false);
  assert.equal(b.canMount(HOME, 'dirt', true), false);
  assert.equal(b.canDismount(), false);
  assert.equal(b.mount(HOME, 'dirt', 1.2), true);
  assert.equal(b.canMount(HOME, 'dirt'), false); assert.equal(b.canDismount(), true);
  assert.equal(b.dismount(), true); assert.equal(b.dismount(), false);
});

test('waking by the bed puts the bicycle back at the cabin, unmounted and unloaded', () => {
  const b = ridden(); b.strap('fuel'); run(b, 5, GO, 'road'); b.place(300, -50);
  assert.deepEqual({ ...b.home() }, HOME);
  assert.deepEqual({ ...b.position }, HOME); assert.equal(b.mounted, false); assert.equal(b.loadKind, null);
  b.setHome(1, 2); b.home(); assert.deepEqual({ ...b.position }, { x: 1, z: 2 });
});

test('a zero step changes nothing', () => {
  const b = ridden(); run(b, 2, GO, 'road'); const s = b.update(1e-6, GO, 'road').speed;
  assert.equal(b.update(0, GO, 'road').speed, s);
});

test('limitSpeed: a blocked bicycle cannot keep its speed, and an open one is not slowed', () => {
  const b = ridden();
  run(b, 4, GO, 'road');
  assert.ok(Math.abs(b.speed - 5.4) < 1e-9);
  b.limitSpeed(9); assert.ok(Math.abs(b.speed - 5.4) < 1e-9);
  b.limitSpeed(1.5); assert.equal(b.speed, 1.5);
  b.limitSpeed(-3); assert.equal(b.speed, 0);
  assert.equal(b.heading, 0);
});
