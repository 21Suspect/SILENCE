/**
 * Development only, with ?gl-trace in the address: times every WebGL call that can wait on the GPU process (shader status and logs,
 * read-backs, syncs, uploads, draws) from before the engine is loaded, and keeps where the code was for any call over 100 ms. A
 * freeze at start-up shows up as a few such calls: on Direct3D 11 a single getProgramInfoLog waited up to 13 s for its shader.
 * `__GLTRACE__.report()` sums them; `__GLTRACE__.long` lists the slow calls with a short stack.
 */
type Stat = { n: number; ms: number; max: number };
const WATCHED = ['getProgramInfoLog', 'getShaderInfoLog', 'getProgramParameter', 'getShaderParameter', 'getActiveUniform', 'getUniformLocation',
  'getAttribLocation', 'readPixels', 'clientWaitSync', 'getError', 'getParameter', 'finish', 'linkProgram', 'compileShader', 'texImage2D',
  'texSubImage2D', 'texImage3D', 'texSubImage3D', 'texStorage2D', 'copyTexSubImage2D', 'generateMipmap', 'bufferData', 'drawElements',
  'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced'];

export function installGlTrace() {
  if (typeof WebGL2RenderingContext === 'undefined') return;
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, unknown>;
  const stats: Record<string, Stat> = {}, long: { at: number; call: string; ms: number; stack: string }[] = [];
  for (const name of WATCHED) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function (this: unknown, ...args: unknown[]) {
      const start = performance.now();
      try { return (original as (...a: unknown[]) => unknown).apply(this, args); } finally {
        const ms = performance.now() - start, s = stats[name] ??= { n: 0, ms: 0, max: 0 };
        s.n++; s.ms += ms; if (ms > s.max) s.max = ms;
        if (ms > 100 && long.length < 400) long.push({ at: Math.round(start), call: name, ms: Math.round(ms), stack: (new Error().stack ?? '').split('\n').slice(2, 8).map(l => l.trim().replace(location.origin, '')).join(' < ') });
      }
    };
  }
  const report = () => Object.entries(stats).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k} n=${v.n} ${Math.round(v.ms)} ms (max ${Math.round(v.max)})`);
  (window as unknown as { __GLTRACE__: unknown }).__GLTRACE__ = { stats, long, report };
}
