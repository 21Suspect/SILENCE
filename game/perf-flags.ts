/**
 * Dev-only A/B switches for the performance pass. Every optimisation that can be toggled at run time asks `perfOn(name)`
 * at the point where it decides. `?perf-baseline` turns them all off (the behaviour from before the pass) and
 * `__SILENCE__.perf.disable(name)` / `.enable(name)` flip one at a time, so before and after can be measured in the same
 * build, in the same session, on the same tree. In a production build `import.meta.env.DEV` is false and every call is
 * a constant `true`: the switches cost nothing and cannot be reached.
 */
const dev = typeof import.meta !== 'undefined' && !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
const baseline = dev && typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf-baseline');
const off = new Set<string>();

export const perfOn = (name: string) => !dev || (!baseline && !off.has(name));
export const perfSwitches = {
  /** Names that have been asked about so far, with whether each is on. */
  list: () => ({ baseline, off: [...off] }),
  disable: (name: string) => { off.add(name); },
  enable: (name: string) => { off.delete(name); },
  enableAll: () => { off.clear(); },
};
