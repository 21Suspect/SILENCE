import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const m = await import('../../../game/render/props/bicycle-math.ts');
const { BIKE } = m;
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);
const deg = r => r * 180 / Math.PI;

test('a wheel turns once per circumference, and the cranks once per 2.56 wheel turns', () => {
  near(m.wheelTurn(2 * Math.PI * BIKE.wheelRadius), 2 * Math.PI);
  near(m.wheelTurn(0), 0);
  near(BIKE.gear, 2.5555555555, 1e-6);
  near(m.crankTurn(2 * Math.PI * 2.56, 2.56), 2 * Math.PI);
  const wheel = m.wheelTurn(100), cranks = m.crankTurn(wheel);
  assert.ok(cranks < wheel && cranks > wheel / 3, 'the pedals turn slower than the wheel');
});

test('the lock closes with speed: 35 degrees at a crawl, about 12 at 5.4 m/s, and the input scales it', () => {
  near(deg(m.steerLimit(0)), 35, 1e-9);
  const fast = deg(m.steerLimit(5.4)); assert.ok(fast > 10 && fast < 14, String(fast));
  assert.ok(m.steerLimit(2) < m.steerLimit(1));
  near(m.steerAngle(.5, 0), m.steerLimit(0) / 2);
  near(m.steerAngle(3, 0), m.steerLimit(0));
  near(m.steerAngle(-1, 1), -m.steerLimit(1));
});

test('lean is atan(v * yaw rate / g): none straight or standing, a few degrees at a walk, about 18 at full speed, never past 25, and it follows the turn', () => {
  near(m.leanFor(5, 0), 0); near(m.leanFor(0, 2), 0);
  near(m.leanFor(5.4, .6), Math.atan(5.4 * .6 / 9.81));
  const walk = deg(m.leanFor(1.8, .8)), fast = deg(m.leanFor(5.4, .6));
  assert.ok(walk > 5 && walk < 10, String(walk)); assert.ok(fast > 15 && fast < 21, String(fast));
  near(deg(m.leanFor(20, 3)), 25, 1e-9);
  near(m.leanFor(5.4, -.6), -m.leanFor(5.4, .6));
});

test('the frame sits on both wheels: level ground, a slope, a dip', () => {
  const flat = m.frameOnGround(3, 3); near(flat.pitch, 0); near(flat.height, 3);
  const up = m.frameOnGround(3, 3.3); near(up.pitch, Math.atan2(.3, BIKE.wheelbase)); near(up.height, 3.15);
  const down = m.frameOnGround(3.3, 3); near(down.pitch, -up.pitch);
});

test('ease moves toward the target by a frame-rate independent share, and angleDelta takes the short way round', () => {
  near(m.ease(0, 1, 5, 0), 0);
  const once = m.ease(0, 1, 5, .1), twice = m.ease(m.ease(0, 1, 5, .05), 1, 5, .05);
  near(once, twice);
  near(m.angleDelta(.1, 2 * Math.PI - .1), .2);
  near(m.angleDelta(2 * Math.PI - .1, .1), -.2);
});
