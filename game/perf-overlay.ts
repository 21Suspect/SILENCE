import * as THREE from 'three';
import { createFrameStats, type FrameSummary } from './frame-stats';

/** Shows or hides the overlay. Fixed rather than rebindable, like O for the objective; the engine stands aside if it is bound. */
export const PERF_OVERLAY_KEY = 'KeyP';
/** How often the text is rewritten. */
const REFRESH_MS = 250;

type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/**
 * The performance overlay: a few quiet lines in the top-right corner, in the objective's type. FPS and average frame time,
 * 1% and 0.1% low, CPU and GPU milliseconds a frame and their share of the frame budget, the render resolution, draw calls
 * and triangles (statistics in game/frame-stats.ts).
 *
 * GPU time comes from one EXT_disjoint_timer_query_webgl2 query around the frame's drawing (shadow maps, the scene, water, fog
 * and the post chain). Browsers without it (Safari) show "n/a". While hidden it does nothing at all: no samples, no queries, no
 * DOM writes; the engine's calls return after one test.
 */
export function createPerfOverlay(container: HTMLElement, renderer: THREE.WebGLRenderer, options: { frameCap: () => number; busy?: () => boolean }) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
  const stats = createFrameStats();
  const doc = container.ownerDocument, el = doc.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:absolute;right:max(16px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));z-index:3;pointer-events:none;'
    + 'display:none;text-align:right;white-space:pre;font:400 12px/1.5 system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:.04em;'
    + 'color:#dcd8c9;text-shadow:0 1px 3px #000,0 0 14px rgba(0,0,0,.75)';
  const lines = Array.from({ length: 5 }, () => { const line = doc.createElement('div'); el.appendChild(line); return line; });
  lines[1].style.color = lines[4].style.color = '#a9a89b';
  container.appendChild(el);

  let visible = false, lastText = -Infinity, active: WebGLQuery | undefined;
  const pending: WebGLQuery[] = [], spare: WebGLQuery[] = [];
  const size = new THREE.Vector2();

  function poll() {
    while (pending.length) {
      const q = pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      if (!gl.getParameter(ext!.GPU_DISJOINT_EXT)) stats.pushGpu(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
      spare.push(q);
    }
  }
  const fixed = (v: number | undefined, digits = 1) => v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);
  const share = (v: number | undefined) => v === undefined ? '' : ` · ${Math.round(v * 100)}%`;
  const count = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n);
  function write(s: FrameSummary | undefined, calls: number, triangles: number) {
    renderer.getDrawingBufferSize(size);
    const text = [
      s ? `${Math.round(s.fps)} FPS · ${fixed(s.frameMs)} ms` : '– FPS',
      `1% low ${s?.low1 === undefined ? '–' : Math.round(s.low1)} · 0.1% low ${s?.low01 === undefined ? '–' : Math.round(s.low01)}`,
      `CPU ${fixed(s?.cpuMs)} ms${share(s?.cpuShare)}`,
      ext ? `GPU ${fixed(s?.gpuMs)} ms${share(s?.gpuShare)}` : 'GPU n/a',
      `${size.x}×${size.y} · ${count(calls)} draws · ${count(triangles)} tris`,
    ];
    for (let i = 0; i < lines.length; i++) if (lines[i].textContent !== text[i]) lines[i].textContent = text[i];
  }

  return {
    get visible() { return visible; },
    setVisible(on: boolean) {
      if (on === visible) return;
      visible = on; el.style.display = on ? 'block' : 'none';
      if (!on) {
        // In-flight queries may be deleted; whatever they would have said is of no use now.
        if (active) { gl.endQuery(ext!.TIME_ELAPSED_EXT); pending.push(active); active = undefined; }
        for (const q of pending.splice(0)) gl.deleteQuery(q);
        stats.clear(); lastText = -Infinity;
      }
    },
    /** Just before the frame's drawing starts. */
    beginGpu() {
      if (!visible || !ext || active || options.busy?.() || pending.length > 8) return;
      active = spare.pop() ?? gl.createQuery() ?? undefined;
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    /** Just after it. */
    endGpu() {
      if (!active) return;
      gl.endQuery(ext!.TIME_ELAPSED_EXT); pending.push(active); active = undefined;
    },
    /** Once a drawn frame is done: `intervalMs` since the previous one, `cpuMs` of main-thread work on it, now in rAF time. */
    frame(now: number, intervalMs: number, cpuMs: number) {
      if (!visible) return;
      stats.push(intervalMs, cpuMs);
      if (ext) poll();
      if (now - lastText < REFRESH_MS) return;
      lastText = now;
      write(stats.summary(options.frameCap()), renderer.info.render.calls, renderer.info.render.triangles);
    },
    dispose() {
      this.setVisible(false);
      for (const q of spare.splice(0)) gl.deleteQuery(q);
      el.remove();
    },
  };
}
export type PerfOverlay = ReturnType<typeof createPerfOverlay>;
