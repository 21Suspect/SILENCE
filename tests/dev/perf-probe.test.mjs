import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, stat, summarize } from '../game/perf-probe.ts';
import { perfOn, perfSwitches } from '../game/perf-flags.ts';

const row = (frame, cpu = 3, gpu = 2) => ({ frame, cpu, sky: 0, move: 0, terrain: 0, forest: 0, world: 0, encounter: 0, shadowPrep: 0, audio: 0, submit: 1, shadowCpu: 0, gpu,
  calls: 100, triangles: 1e6, shadowCalls: 10, shadowTriangles: 1e5, sunShadow: false, programs: 5, textures: 6, geometries: 7 });

test('percentile interpolates between ranks and handles the ends', () => {
  const v = [1, 2, 3, 4, 5];
  assert.equal(percentile(v, 0), 1);
  assert.equal(percentile(v, 1), 5);
  assert.equal(percentile(v, .5), 3);
  assert.equal(percentile(v, .125), 1.5);
  assert.ok(Number.isNaN(percentile([], .5)));
});

test('stat ignores gaps (a GPU time that never resolved) and sorts its input', () => {
  const s = stat([5, undefined, 1, NaN, 3]);
  assert.equal(s.median, 3);
  assert.equal(s.max, 5);
  assert.equal(s.mean, 3);
  assert.ok(Number.isNaN(stat([undefined]).median));
});

test('summarize counts long frames by the interval, and heavy CPU frames by CPU time', () => {
  const rows = [row(8.3), row(8.4), row(20, 17), row(40, 9), row(120, 30)];
  const s = summarize(rows);
  assert.equal(s.frames, 5);
  assert.deepEqual(s.long, { over17: 3, over33: 2, over50: 1, worst: 120 });
  assert.deepEqual(s.cpuOver, { over8: 3, over16: 2 });
  assert.equal(s.stats.frame.median, 20);
  assert.equal(s.stats.calls.max, 100);
});

test('performance switches are on outside a dev browser, so nothing is ever left off in a build', () => {
  assert.equal(perfOn('anything'), true);
  perfSwitches.disable('anything');
  assert.equal(perfOn('anything'), true);
  perfSwitches.enableAll();
});
