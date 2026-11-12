/**
 * Frame statistics for the performance overlay (game/perf-overlay.ts). Pure: the overlay feeds it one sample per drawn frame and
 * asks for a summary a few times a second. Tested in tests/frame-stats.test.mjs.
 *
 * - FPS and frame time are averages over the last second of frames.
 * - 1% and 0.1% low are the frame rates at the 99th and 99.9th percentile frame time over the whole window (the last
 *   `capacity` frames, 2,000 by default: about half a minute at 60 FPS), the definition PresentMon and FrameView use. They need
 *   100 and 1,000 frames before they mean anything, and are undefined until then.
 * - CPU is the main thread's work on the frame; GPU is what the timer query measured (it arrives a few frames late, so it is
 *   averaged over the last results that came in). Both are also given as a share of the frame budget: the frame rate limit when
 *   there is one, else the screen's refresh interval as the frame times show it.
 */
export type FrameSummary = {
  frames: number;
  fps: number; frameMs: number;
  low1?: number; low01?: number;
  cpuMs: number; gpuMs?: number;
  budgetMs: number; cpuShare: number; gpuShare?: number;
};

/** Refresh rates screens actually run at; the budget snaps to the nearest one. */
const RATES = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];

/** Linear-interpolated percentile of an ascending list (p in 0..1). */
export function percentile(sorted: ArrayLike<number>, p: number) {
  const n = sorted.length;
  if (!n) return NaN;
  const at = Math.min(n - 1, Math.max(0, p * (n - 1))), lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** The refresh interval the frame times point to: the 10th percentile interval, snapped to a real refresh rate. */
export function refreshInterval(sortedIntervals: ArrayLike<number>) {
  const fast = percentile(sortedIntervals, .1);
  if (!Number.isFinite(fast) || fast <= 0) return 1000 / 60;
  const rate = 1000 / fast;
  return 1000 / RATES.reduce((best, r) => Math.abs(r - rate) < Math.abs(best - rate) ? r : best, RATES[0]);
}

export function createFrameStats(capacity = 2000) {
  const interval = new Float64Array(capacity), cpu = new Float64Array(capacity), gpu = new Float64Array(capacity);
  let count = 0, head = 0, gpuCount = 0, gpuHead = 0;
  const sorted = new Float64Array(capacity);
  return {
    /** One drawn frame: milliseconds since the previous one, and the main thread's milliseconds on it. */
    push(intervalMs: number, cpuMs: number) {
      if (!(intervalMs > 0) || intervalMs > 2000) return;   // the first frame, and a frame after the tab was hidden
      interval[head] = intervalMs; cpu[head] = Math.max(0, cpuMs);
      head = (head + 1) % capacity; count = Math.min(capacity, count + 1);
    },
    /** A GPU timing result (milliseconds), whenever one arrives. */
    pushGpu(ms: number) {
      if (!(ms >= 0) || !Number.isFinite(ms)) return;
      gpu[gpuHead] = ms; gpuHead = (gpuHead + 1) % capacity; gpuCount = Math.min(capacity, gpuCount + 1);
    },
    clear() { count = head = gpuCount = gpuHead = 0; },
    get count() { return count; },
    /** `frameCap`: the frame rate limit, 0 for none. Undefined until there is a frame. */
    summary(frameCap = 0): FrameSummary | undefined {
      if (!count) return undefined;
      // The last second of frames, newest first.
      let span = 0, cpuSum = 0, n = 0;
      for (let i = 0; i < count && (span < 1000 || n < 2); i++) {
        const k = (head - 1 - i + capacity) % capacity;
        span += interval[k]; cpuSum += cpu[k]; n++;
      }
      const all = sorted.subarray(0, count);
      for (let i = 0; i < count; i++) all[i] = interval[(head - count + i + capacity) % capacity];
      all.sort();
      const budgetMs = frameCap > 0 ? 1000 / frameCap : refreshInterval(all);
      let gpuMs: number | undefined;
      if (gpuCount) {
        const m = Math.min(gpuCount, n);
        let sum = 0;
        for (let i = 0; i < m; i++) sum += gpu[(gpuHead - 1 - i + capacity) % capacity];
        gpuMs = sum / m;
      }
      const cpuMs = cpuSum / n;
      return {
        frames: count, fps: n * 1000 / span, frameMs: span / n,
        low1: count >= 100 ? 1000 / percentile(all, .99) : undefined,
        low01: count >= 1000 ? 1000 / percentile(all, .999) : undefined,
        cpuMs, gpuMs, budgetMs, cpuShare: cpuMs / budgetMs, gpuShare: gpuMs === undefined ? undefined : gpuMs / budgetMs,
      };
    },
  };
}
export type FrameStats = ReturnType<typeof createFrameStats>;
