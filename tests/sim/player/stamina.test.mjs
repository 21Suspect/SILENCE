import test from 'node:test';
import assert from 'node:assert/strict';
import { createStamina, gaitSpeed, sprintFov, STAMINA } from '../game/stamina.ts';

const DT = 1 / 60;
// Run the model for `seconds` of game time with the player asking to sprint (or not) at a measured speed.
const run = (s, seconds, wants, speed, dt = DT) => { let r = s.state; for (let t = 0; t < seconds - 1e-9; t += dt) r = s.update(dt, wants, speed); return r; };
const SPRINT_SPEED = STAMINA.sprintSpeed;

test('the tuning is what the design asks for', () => {
  assert.equal(STAMINA.walkSpeed, 1.8);
  assert.equal(STAMINA.sprintSpeed, 5.6);
  assert.equal(STAMINA.drainSeconds, 9);
  assert.equal(STAMINA.walkRefillSeconds, 14);
  assert.equal(STAMINA.standRefillSeconds, 8);
  assert.equal(STAMINA.fovBoost, 7);
  assert.equal(STAMINA.blendIn, .25);
  assert.equal(STAMINA.blendOut, .4);
  assert.ok(STAMINA.sprintSpeed > 4.6 && STAMINA.sprintSpeed < 8.5, 'faster than the creature approaches, slower than it charges');
});

test('it starts full and a still player does not change it', () => {
  const s = createStamina();
  assert.deepEqual(s.state, { value: 1, exhausted: false, sprinting: false, blend: 0 });
  const r = run(s, 5, false, 0);
  assert.equal(r.value, 1); assert.equal(r.sprinting, false);
});

test('about nine seconds of continuous sprinting empties it, and then the player is out of breath', () => {
  const s = createStamina();
  let r = run(s, 8.8, true, SPRINT_SPEED);
  assert.equal(r.sprinting, true); assert.equal(r.exhausted, false); assert.ok(r.value > 0 && r.value < .05, `value ${r.value}`);
  let t = 8.8;
  while (!r.exhausted && t < 12) { r = s.update(DT, true, SPRINT_SPEED); t += DT; }
  assert.ok(Math.abs(t - 9) < .05, `ran dry after ${t.toFixed(2)} s`);
  assert.equal(r.value, 0); assert.equal(r.sprinting, false, 'dry: a walk from this frame on');
});

test('draining takes the same game time at any frame rate', () => {
  for (const hz of [30, 60, 144]) {
    const s = createStamina(); const r = run(s, 4.5, true, SPRINT_SPEED, 1 / hz);
    assert.ok(Math.abs(r.value - .5) < .01, `${hz} Hz: ${r.value}`);
  }
});

test('holding the key while standing still, or against a wall, is not sprinting and costs nothing', () => {
  const s = createStamina();
  const r = run(s, 10, true, 0);
  assert.equal(r.sprinting, false); assert.equal(r.value, 1); assert.equal(r.blend, 0);
  const slow = run(createStamina(), 3, true, STAMINA.movingSpeed - .05);
  assert.equal(slow.sprinting, false, 'barely creeping is standing');
});

test('refill: about fourteen seconds walking, eight standing, and standing is the faster of the two', () => {
  const drained = () => { const s = createStamina(); run(s, 4.5, true, SPRINT_SPEED); return s; };
  const walking = drained(), standing = drained();
  const w = run(walking, 7, false, STAMINA.walkSpeed), t = run(standing, 4, false, 0);
  assert.ok(Math.abs(w.value - 1) < .01, `half back after seven walking seconds, got ${w.value}`);
  assert.ok(Math.abs(t.value - 1) < .01, `half back after four standing seconds, got ${t.value}`);
  assert.equal(run(walking, 7.05, false, STAMINA.walkSpeed).value, 1, 'full after fourteen');
  assert.equal(run(standing, 4.05, false, 0).value, 1, 'full after eight');
  const a = drained(), b = drained();
  assert.ok(run(b, 2, false, 0).value > run(a, 2, false, STAMINA.walkSpeed).value);
});

test('a sprint always drains and never refills, however long it has gone on', () => {
  const s = createStamina(); run(s, 3, true, SPRINT_SPEED);
  const before = s.state.value; run(s, 1, true, SPRINT_SPEED);
  assert.ok(s.state.value < before);
});

// Sprint until the frame it runs dry, so the lockout can be timed from zero.
const runDry = () => { const s = createStamina(); while (!s.update(DT, true, SPRINT_SPEED).exhausted); return s; };

test('after running dry sprinting stays locked until a modest share is back, even with the key held', () => {
  const s = runDry();
  assert.equal(s.state.value, 0);
  // Holding the key and walking: the walk refill rate brings it back to resumeAt in resumeAt * 14 seconds.
  const lockout = STAMINA.resumeAt * STAMINA.walkRefillSeconds;
  let r = run(s, lockout - .3, true, STAMINA.walkSpeed);
  assert.equal(r.exhausted, true); assert.equal(r.sprinting, false); assert.ok(r.value < STAMINA.resumeAt);
  r = run(s, .5, true, STAMINA.walkSpeed);
  assert.equal(r.exhausted, false); assert.equal(r.sprinting, true, 'the key is still down, so it sprints again');
  assert.ok(r.value > STAMINA.resumeAt - .05);
});

test('no flicker at the threshold: a held key near the line gives one clean walk-then-sprint, not a stutter', () => {
  const s = createStamina(); run(s, 9.5, true, SPRINT_SPEED);
  const flags = [];
  for (let i = 0; i < 60 * 8; i++) flags.push(s.update(DT, true, STAMINA.walkSpeed).sprinting);
  let switches = 0; for (let i = 1; i < flags.length; i++) if (flags[i] !== flags[i - 1]) switches++;
  // Walk while refilling, one switch to sprint, and a second one only when it runs dry again (about two seconds later).
  assert.ok(switches <= 2, `${switches} switches in ${flags.length} frames`);
  assert.equal(flags[0], false);
  // Right at the resume value, wobbling measured speed (a stalled step, a bump) must not matter for the lockout flag.
  const t = createStamina(); run(t, 9.5, true, SPRINT_SPEED);
  const seen = []; for (let i = 0; i < 60 * 6; i++) seen.push(t.update(DT, true, i % 2 ? 4 : .1).exhausted);
  let flips = 0; for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) flips++;
  assert.ok(flips <= 1, `lockout flag flipped ${flips} times`);
});

test('when the lockout ends with the key released, the player is simply able to sprint again on the next press', () => {
  const s = createStamina(); run(s, 9.5, true, SPRINT_SPEED);
  run(s, 6, false, 0);
  assert.equal(s.state.exhausted, false);
  assert.equal(s.update(DT, true, 3).sprinting, true);
});

test('releasing the key early never locks the player out; they can sprint again at any non-empty value', () => {
  const s = createStamina(); run(s, 6, true, SPRINT_SPEED);
  const r = run(s, .5, false, SPRINT_SPEED);
  assert.equal(r.exhausted, false);
  assert.equal(s.update(DT, true, SPRINT_SPEED).sprinting, true);
});

test('a paused frame (dt 0, negative or NaN) changes nothing', () => {
  const s = createStamina(); run(s, 2, true, SPRINT_SPEED);
  const before = s.state;
  assert.deepEqual(s.update(0, true, SPRINT_SPEED), before);
  assert.deepEqual(s.update(-1, true, SPRINT_SPEED), before);
  assert.deepEqual(s.update(NaN, true, SPRINT_SPEED), before);
});

test('a long stall is capped, so one slow frame cannot swallow the whole bar', () => {
  const s = createStamina(); const r = s.update(5, true, SPRINT_SPEED);
  assert.ok(r.value > .98, `value ${r.value}`);
});

test('the sprint blend eases up in a quarter of a second and down in four tenths, and never overshoots', () => {
  const s = createStamina(); let r = s.state, last = 0;
  for (let t = 0; t < .24; t += DT) { r = s.update(DT, true, 3); assert.ok(r.blend >= last && r.blend <= 1); last = r.blend; }
  assert.ok(r.blend > .9 && r.blend < 1, `after ~0.24 s: ${r.blend}`);
  r = run(s, .05, true, 3); assert.equal(r.blend, 1);
  r = run(s, .38, false, 3); assert.ok(r.blend > 0 && r.blend < .1, `after 0.38 s of letting go: ${r.blend}`);
  r = run(s, .05, false, 3); assert.equal(r.blend, 0);
});

test('speed and field of view follow the blend smoothly from walk to sprint', () => {
  assert.equal(gaitSpeed(0), 1.8); assert.equal(gaitSpeed(1), 5.6);
  assert.equal(sprintFov(0), 0); assert.equal(sprintFov(1), 7);
  let lastSpeed = gaitSpeed(0), lastFov = 0;
  for (let b = 0; b <= 1.0001; b += .01) {
    const v = gaitSpeed(b), f = sprintFov(b);
    assert.ok(v >= lastSpeed && f >= lastFov, 'monotonic');
    assert.ok(v - lastSpeed < .1 && f - lastFov < .12, 'no jump between hundredths');
    lastSpeed = v; lastFov = f;
  }
  assert.equal(gaitSpeed(-3), 1.8); assert.equal(gaitSpeed(9), 5.6, 'out-of-range input is clamped');
  assert.ok(sprintFov(.5) > 3 && sprintFov(.5) < 4, 'smoothstep midpoint');
});

test('the sprint flag is true only while really sprinting: not during the ease out, not while exhausted, not when stopped', () => {
  const s = createStamina(); run(s, 1, true, SPRINT_SPEED);
  assert.equal(s.state.sprinting, true);
  const r = s.update(DT, false, SPRINT_SPEED);
  assert.equal(r.sprinting, false); assert.ok(r.blend > .9, 'the blend is still easing down');
  const t = createStamina(); run(t, 1, true, SPRINT_SPEED);
  assert.equal(t.update(DT, true, 0).sprinting, false, 'stopped dead');
  const u = createStamina(); run(u, 9.5, true, SPRINT_SPEED);
  assert.equal(u.state.exhausted, true);
  for (let i = 0; i < 100; i++) assert.equal(u.update(DT, true, SPRINT_SPEED).sprinting, false, 'locked out');
});

test('a full run: sprint, run dry, recover while walking, sprint again; the value stays inside 0..1 throughout', () => {
  const s = createStamina(); let sprintTime = 0, lo = 1, hi = 0;
  for (let i = 0; i < 60 * 60; i++) {
    const r = s.update(DT, true, i % 2 ? SPRINT_SPEED : STAMINA.walkSpeed * 2);
    sprintTime += r.sprinting ? DT : 0; lo = Math.min(lo, r.value); hi = Math.max(hi, r.value);
  }
  assert.ok(lo >= 0 && hi <= 1);
  // Holding the key for a minute: nine seconds at the start, then short bursts between walking refills.
  assert.ok(sprintTime > 9 && sprintTime < 30, `sprinted ${sprintTime.toFixed(1)} s of 60`);
});

test('reset gives back full stamina, a walk, and no lockout', () => {
  const s = createStamina(); run(s, 10, true, SPRINT_SPEED); assert.equal(s.state.exhausted, true);
  s.reset(); assert.deepEqual(s.state, { value: 1, exhausted: false, sprinting: false, blend: 0 });
});

test('a custom tuning is honoured, and the shared tuning object is not mutated', () => {
  const quick = { ...STAMINA, drainSeconds: 2 };
  const s = createStamina(quick); const r = run(s, 2.1, true, SPRINT_SPEED);
  assert.equal(r.exhausted, true);
  assert.equal(STAMINA.drainSeconds, 9);
});
