import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, RUN } from '../../../game/sim/run/run.ts';

// Drive the engine's clock like the game does: a wrapping 0-24 hour, advanced by dtSeconds real seconds per step
// (1 game hour per real minute).
function drive(run, startClock, gameHours, dtSeconds) {
  const events = [];
  const steps = Math.round((gameHours * 60) / dtSeconds);
  for (let i = 1; i <= steps; i++) events.push(...run.advance((startClock + (i * dtSeconds) / 60) % 24));
  return events;
}
const types = (ev) => ev.map((e) => `${e.type}${e.day ?? ''}`);
// A run brought to `clock` on `day` by stepping its clock a quarter hour at a time.
function at(day, clock) {
  const run = createRun();
  let c = RUN.startHour;
  while (!(run.day === day && Math.abs(run.clock - clock) < 1e-6)) {
    assert.ok(run.day <= day, 'overshot the day');
    c = (c + .25) % 24;
    run.advance(c);
  }
  return run;
}

test('the tuning is what the design asks for', () => {
  assert.equal(RUN.days, 5);
  assert.equal(RUN.dawnHour, 6);
  assert.equal(RUN.duskHour, 19);
  assert.ok(RUN.startHour > RUN.dawnHour && RUN.startHour < RUN.duskHour, 'the run begins in the morning, in daylight');
});

test('it starts on day 1 in the morning with four days to come', () => {
  const run = createRun();
  assert.equal(run.day, 1); assert.equal(run.daysBegun, 1); assert.equal(run.daysLeft, 4);
  assert.equal(run.status, 'running'); assert.equal(run.over, false);
  assert.equal(run.clock, RUN.startHour); assert.equal(run.phase, 'day');
});

test('days are counted dawn to dawn: dusk on day 1 at 19:00, day 2 at the first 06:00 after the start', () => {
  const run = createRun();
  assert.deepEqual(drive(run, 7, 11, 1), []);
  assert.deepEqual(types(drive(run, 18, 1.01, 1)), ['dusk1']);
  assert.equal(run.phase, 'night');
  assert.deepEqual(drive(run, 19.01, 10.9, 1), []);
  assert.deepEqual(types(drive(run, 5.91, .2, 1)), ['dawn2']);
  assert.equal(run.day, 2); assert.equal(run.daysLeft, 3); assert.equal(run.phase, 'day');
});

test('a whole run in one pass: dusk and dawn every day, the sixth dawn loses', () => {
  const run = createRun();
  const ev = drive(run, 7, 24 * 4 + 23 + .5, 6);
  assert.deepEqual(types(ev), ['dusk1', 'dawn2', 'dusk2', 'dawn3', 'dusk3', 'dawn4', 'dusk4', 'dawn5', 'dusk5', 'lost']);
  assert.equal(run.status, 'lost'); assert.equal(run.day, 5); assert.equal(run.over, true);
  assert.deepEqual(run.advance(12), [], 'nothing after the end');
});

test('five days exactly: the last dawn is 119 hours after a 07:00 start, not before', () => {
  const run = createRun();
  const ev = drive(run, 7, 118.9, 6);
  assert.equal(ev.filter((e) => e.type === 'lost').length, 0); assert.equal(run.day, 5);
  assert.deepEqual(types(drive(run, run.clock, .2, 6)), ['lost']);
});

test('the clock wraps at midnight without a dawn or a skipped hour', () => {
  const run = createRun();
  run.advance(20);
  const ev = [...run.advance(23.99), ...run.advance(0.01), ...run.advance(.02)];
  assert.deepEqual(ev, []);
  assert.equal(run.day, 1);
  assert.ok(Math.abs(run.hoursToDawn - 5.98) < 1e-6);
});

test('big jumps of the clock cross every dusk and dawn once, in order', () => {
  const run = createRun();
  assert.deepEqual(types(run.advance(23)), ['dusk1']);               // 07:00 -> 23:00 in one step
  assert.deepEqual(types(run.advance(7)), ['dawn2']);                // 23:00 -> 07:00: wraps, dawn once
  assert.deepEqual(run.advance(7), [], 'the same reading twice is no time');
  const r = createRun();
  assert.deepEqual(types(r.advance(5.99)), ['dusk1']);               // 22.99 h in one go
  assert.deepEqual(types(r.advance(6.01)), ['dawn2']);
});

test('a reading a hair behind is jitter, not a 24-hour jump', () => {
  const run = createRun();
  run.advance(10);
  assert.deepEqual(run.advance(10 - 1e-9), []);
  assert.equal(run.day, 1);
});

test('frame rate does not change the events: 1/30 s, 1/60 s and 1/144 s steps', () => {
  const results = [30, 60, 144].map((fps) => {
    const run = createRun();
    const ev = drive(run, 7, 24 * 3, 1 / fps);
    return { ev: types(ev), day: run.day };
  });
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
  assert.deepEqual(results[0].ev, ['dusk1', 'dawn2', 'dusk2', 'dawn3', 'dusk3', 'dawn4']);
});

test('caught at 23:00 wakes at the next dawn, on the next day', () => {
  const run = at(2, 23);
  assert.equal(run.day, 2);
  const r = run.caught();
  assert.equal(r.outcome, 'dawn'); assert.equal(r.day, 3); assert.equal(r.wakeHour, 6);
  assert.ok(Math.abs(r.hoursLost - 7) < 1e-6);
  assert.deepEqual(types(r.events), ['dawn3']);
  assert.equal(run.day, 3); assert.ok(Math.abs(run.clock - 6) < 1e-6);
  assert.deepEqual(run.advance(6.0), [], 'no second dawn when the engine sets its clock to wakeHour');
});

test('caught at 03:00 wakes at that same night\'s dawn, which still begins the next day', () => {
  const run = at(2, 3);
  assert.equal(run.day, 2);
  const r = run.caught();
  assert.equal(r.outcome, 'dawn'); assert.equal(r.day, 3); assert.ok(Math.abs(r.hoursLost - 3) < 1e-6);
});

test('caught by day is carried to the next dawn as well, and the dusk it crosses is announced', () => {
  const run = createRun();
  const r = run.caught();
  assert.equal(r.outcome, 'dawn'); assert.equal(r.day, 2);
  assert.deepEqual(types(r.events), ['dusk1', 'dawn2']);
});

test('caught in day 5\'s night loses the run', () => {
  const run = at(5, 22);
  assert.equal(run.day, 5);
  const r = run.caught();
  assert.equal(r.outcome, 'lost'); assert.deepEqual(types(r.events), ['lost']);
  assert.equal(run.status, 'lost'); assert.equal(run.day, 5);
  assert.equal(run.caught().outcome, 'lost');
});

test('after a catch the later dawns still count once each', () => {
  const run = at(2, 22);
  run.caught();
  const ev = drive(run, 6, 24 * 3 + 1, 6);
  assert.deepEqual(types(ev), ['dusk3', 'dawn4', 'dusk4', 'dawn5', 'dusk5', 'lost']);
});

test('sleep is refused by day, with the door open, and when it is not quiet', () => {
  const run = createRun();
  const ok = { doorBarred: true, quiet: true, loudHereToday: false };
  assert.deepEqual(run.sleep(ok), { ok: false, reason: 'daytime' });
  assert.equal(run.canSleepNow, false);
  run.advance(16.9);                                    // before 17:00 is still too early
  assert.deepEqual(run.sleep(ok), { ok: false, reason: 'daytime' });
  run.advance(17.01);
  assert.equal(run.canSleepNow, true);
  assert.deepEqual(run.sleep({ ...ok, doorBarred: false }), { ok: false, reason: 'door-open' });
  assert.deepEqual(run.sleep({ ...ok, quiet: false }), { ok: false, reason: 'not-quiet' });
  assert.deepEqual(run.sleep({ doorBarred: false, quiet: false, loudHereToday: false }), { ok: false, reason: 'door-open' });
  assert.equal(run.day, 1, 'refusals cost no time');
});

test('sleeping in the evening skips to dawn and announces the dusk it passes', () => {
  const run = createRun();
  run.advance(17.5);
  const r = run.sleep({ doorBarred: true, quiet: true, loudHereToday: false });
  assert.equal(r.ok, true); assert.equal(r.outcome, 'dawn'); assert.equal(r.day, 2); assert.equal(r.wakeHour, 6);
  assert.ok(Math.abs(r.hoursSlept - 12.5) < 1e-6);
  assert.deepEqual(types(r.events), ['dusk1', 'dawn2']);
  assert.equal(run.day, 2);
});

test('sleeping after midnight goes to the same night\'s dawn', () => {
  const run = at(2, 2);
  const r = run.sleep({ doorBarred: true, quiet: true, loudHereToday: false });
  assert.equal(r.outcome, 'dawn'); assert.equal(r.day, 3); assert.ok(Math.abs(r.hoursSlept - 4) < 1e-6);
});

test('if the player was loud there the Listener comes to the door an hour in, and the night goes on', () => {
  const run = at(2, 22);
  const r = run.sleep({ doorBarred: true, quiet: true, loudHereToday: true });
  assert.equal(r.ok, true); assert.equal(r.outcome, 'door');
  assert.ok(Math.abs(r.interruptedAt - 23) < 1e-6); assert.ok(Math.abs(r.hoursSlept - 1) < 1e-6);
  assert.equal(run.day, 2); assert.ok(Math.abs(run.clock - 23) < 1e-6);
  assert.deepEqual(types(drive(run, 23, 7, 6)), ['dawn3']);
});

test('a late sleep is woken at half of what was left, never after dawn', () => {
  const r = at(2, 4).sleep({ doorBarred: true, quiet: true, loudHereToday: true });
  assert.equal(r.outcome, 'door');
  assert.ok(Math.abs(r.hoursSlept - 1) < 1e-6, '2 h left: half is 1 h');
  const run2 = at(2, 5);
  const r2 = run2.sleep({ doorBarred: true, quiet: true, loudHereToday: true });
  assert.ok(Math.abs(r2.hoursSlept - .5) < 1e-6);
  assert.equal(run2.day, 2);
});

test('sleeping through day 5\'s night loses the run, but a door interruption does not', () => {
  const door = at(5, 22);
  assert.equal(door.sleep({ doorBarred: true, quiet: true, loudHereToday: true }).outcome, 'door');
  assert.equal(door.status, 'running');
  const run = at(5, 22);
  assert.equal(run.sleep({ doorBarred: true, quiet: true, loudHereToday: false }).outcome, 'lost');
  assert.equal(run.status, 'lost');
  assert.deepEqual(run.sleep({ doorBarred: true, quiet: true, loudHereToday: false }), { ok: false, reason: 'ended' });
});

test('won() ends the run: no more events, no sleeping, and a win is not a loss', () => {
  const run = createRun();
  run.won();
  assert.equal(run.status, 'won'); assert.equal(run.over, true);
  assert.deepEqual(run.advance(23), []);
  assert.equal(run.sleep({ doorBarred: true, quiet: true, loudHereToday: false }).ok, false);
  assert.equal(run.day, 1);
  const late = at(5, 22); late.won(); assert.equal(late.caught().outcome, 'lost'); assert.equal(late.status, 'won');
});

test('the tally: days begun and days left follow the dawns', () => {
  const run = createRun();
  const seen = [[run.daysBegun, run.daysLeft]];
  for (let i = 0; i < 4; i++) { run.caught(); seen.push([run.daysBegun, run.daysLeft]); }
  assert.deepEqual(seen, [[1, 4], [2, 3], [3, 2], [4, 1], [5, 0]]);
});

test('state and restore round trip, across a dusk and a dawn', () => {
  const a = createRun();
  drive(a, 7, 30, 6);
  const saved = JSON.parse(JSON.stringify(a.state()));
  const b = createRun(saved);
  assert.deepEqual(b.state(), a.state());
  const rest = (r) => types(drive(r, r.clock, 24 * 3, 6));
  assert.deepEqual(rest(b), rest(a));
  const c = createRun(); c.restore(saved);
  assert.deepEqual(c.state(), saved);
  assert.equal(c.state().daysBegun, saved.day);
});

test('restore clamps nonsense, and a dusk already passed is not announced twice', () => {
  const run = createRun({ day: 99, elapsed: -5, duskSeen: false, status: 'bogus' });
  assert.equal(run.day, 5); assert.equal(run.status, 'running');
  const r = createRun(); drive(r, 7, 13, 6);
  assert.deepEqual(createRun(r.state()).advance(20), []);
});
