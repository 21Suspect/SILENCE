import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameStats, percentile, refreshInterval } from '../../game/ui/frame-stats.ts';

const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not ${b}`);

test('a steady 60 FPS reads as 60, with its CPU share of a 60 FPS budget', () => {
  const stats = createFrameStats();
  for (let i = 0; i < 300; i++) stats.push(1000 / 60, 4);
  const s = stats.summary(60);
  near(s.fps, 60, 1e-9); near(s.frameMs, 1000 / 60, 1e-9);
  near(s.low1, 60, 1e-9);
  assert.equal(s.low01, undefined, '0.1% low needs a thousand frames');
  near(s.budgetMs, 1000 / 60); near(s.cpuMs, 4); near(s.cpuShare, .24);
  assert.equal(s.gpuMs, undefined); assert.equal(s.gpuShare, undefined);
});

test('FPS and frame time are the last second; the lows are the 99th and 99.9th percentile frame over the window', () => {
  const stats = createFrameStats(2000);
  // 2,000 frames: 2% at 50 ms, 0.2% at 100 ms, the rest at 60 FPS, slow ones spread through the run.
  for (let i = 0; i < 2000; i++) stats.push(i % 50 === 7 ? (i % 500 === 7 ? 100 : 50) : 1000 / 60, 3);
  // Then a second at 30 FPS: the average follows it at once, the lows only shift a little.
  for (let i = 0; i < 30; i++) stats.push(1000 / 30, 9);
  const s = stats.summary(0);
  near(s.fps, 30, 1e-9); near(s.cpuMs, 9);
  assert.equal(s.frames, 2000);
  assert.ok(s.low1 > 19 && s.low1 <= 30, `1% low ${s.low1}`);
  assert.ok(s.low01 >= 10 && s.low01 < 20, `0.1% low ${s.low01}`);
});

test('the first frame, a frame after the tab was hidden and nonsense are left out', () => {
  const stats = createFrameStats();
  for (const v of [0, -5, NaN, 5000]) stats.push(v, 1);
  assert.equal(stats.count, 0);
  assert.equal(stats.summary(), undefined);
  stats.push(10, 1); assert.equal(stats.count, 1);
});

test('without a frame rate limit the budget is the refresh interval the frame times show', () => {
  const at120 = createFrameStats();
  for (let i = 0; i < 400; i++) at120.push(i % 9 ? 1000 / 120 : 1000 / 60, 2);
  near(at120.summary(0).budgetMs, 1000 / 120);
  // A busy 60 Hz screen: frames miss refreshes, but the fastest ones still say 60.
  const at60 = createFrameStats();
  for (let i = 0; i < 400; i++) at60.push(i % 3 ? 1000 / 60 : 1000 / 30, 2);
  near(at60.summary(0).budgetMs, 1000 / 60);
  // A limit wins over what the screen does.
  near(at120.summary(60).budgetMs, 1000 / 60);
});

test('GPU time is the average of the latest results, as a share of the budget', () => {
  const stats = createFrameStats();
  for (let i = 0; i < 120; i++) stats.push(1000 / 60, 2);
  for (const ms of [20, 20, 8, 8, 8, 8]) stats.pushGpu(ms);
  stats.pushGpu(NaN); stats.pushGpu(-1);
  const s = stats.summary(60);
  near(s.gpuMs, (20 * 2 + 8 * 4) / 6); near(s.gpuShare, s.gpuMs / (1000 / 60));
  stats.clear(); assert.equal(stats.summary(60), undefined);
});

test('percentile interpolates and the refresh guess snaps to real rates', () => {
  near(percentile([1, 2, 3, 4], .5), 2.5);
  near(percentile([5], .99), 5);
  assert.ok(Number.isNaN(percentile([], .5)));
  near(refreshInterval([6.9, 6.95, 7, 7, 7, 7.1, 7.2, 8, 9, 30]), 1000 / 144);
  near(refreshInterval([]), 1000 / 60);
});
