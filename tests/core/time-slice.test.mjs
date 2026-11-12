import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlice, runSlice, runToEnd } from '../game/time-slice.ts';

// A job that does 100 units of work one at a time and may stop between any two of them.
function* job(slice, log) {
  for (let i = 0; i < 100; i++) { log.push(i); if (slice.over()) yield; }
}

test('a sliced job does its work in order, in several frames, and finishes', () => {
  let now = 0;
  const slice = createSlice(3, () => now), log = [], g = job(slice, log);
  let frames = 0;
  // Each unit of work costs half a millisecond: six units fit in a 3 ms slice.
  const tick = () => { now += .5; };
  const original = log.push.bind(log); log.push = value => { tick(); return original(value); };
  while (!runSlice(g, slice)) frames++;
  assert.equal(log.length, 100);
  assert.deepEqual([...log], [...Array(100).keys()]);
  assert.ok(frames >= 14 && frames <= 18, `expected about 17 slices, got ${frames + 1}`);
});

test('a slice never lets one frame run longer than its budget by more than one unit of work', () => {
  let now = 0;
  const slice = createSlice(2, () => now), log = [], g = job(slice, log);
  let worst = 0;
  const original = log.push.bind(log); log.push = value => { now += .4; return original(value); };
  for (;;) {
    const before = now, done = runSlice(g, slice);
    worst = Math.max(worst, now - before);
    if (done) break;
  }
  assert.ok(worst <= 2 + .4 + 1e-9, `a slice took ${worst} ms`);
});

test('running to the end gives the same result as slicing, however stale the slice clock is', () => {
  const a = [], b = [];
  runToEnd(job(createSlice(0, () => 0), a));
  let now = 0; const slice = createSlice(1, () => now);
  const g = job(slice, b); const original = b.push.bind(b); b.push = value => { now += .3; return original(value); };
  while (!runSlice(g, slice));
  assert.deepEqual([...a], [...b]);
});

test('a job that never needs to stop finishes in the first slice', () => {
  const slice = createSlice(1000, () => 0), log = [];
  assert.equal(runSlice(job(slice, log), slice), true);
  assert.equal(log.length, 100);
});
