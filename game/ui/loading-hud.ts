import type { LoadingReport } from './loading-progress';

/** The bar's width is written in steps this fine, and a label is held this long (ms) so a burst of files stays readable. */
const STEPS = 200, DWELL = 140;
/** The corner's fade once loading is over, ms: a little quicker than the veil's, so the bar is gone before the world is clear. */
const FADE = 700;

/**
 * The loading corner: while the veil is black it says what the game is busy with and how far along it is, so a long first load does
 * not read as a broken page. A thin white bar low in the left corner, the current step above it with the percentage at the end of its
 * line, and the two steps before it fading upwards. Everything is left-aligned; nothing here takes a click. Call `update` once a frame
 * with `loading-progress.ts`'s report; the DOM is written only when something differs from what is already there.
 *
 * It sits above the veil (z 101 against its 100). `finish` fills the bar and fades the corner out; `dispose` takes it off the page.
 */
export function createLoadingHud(container: HTMLElement) {
  const doc = container.ownerDocument, make = (tag = 'div') => doc.createElement(tag);
  const root = make(), older = make(), old = make(), row = make(), text = make('span'), pct = make('span'), track = make(), fill = make();
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-label', 'Loading');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '100');
  // Every line has a fixed height, so the bar does not jump as the lines above it fill in. The left margin and bottom edge follow the
  // objective corner's safe areas on a phone.
  root.style.cssText = `position:absolute;left:max(28px,env(safe-area-inset-left));bottom:max(28px,calc(env(safe-area-inset-bottom) + 18px));width:min(260px,calc(100% - 56px));z-index:101;pointer-events:none;text-align:left;font:400 12px/1.6 system-ui,sans-serif;letter-spacing:.03em;color:#fff;transition:opacity ${FADE}ms ease`;
  const line = 'height:1.6em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  older.style.cssText = `${line};color:rgba(255,255,255,.28)`;
  old.style.cssText = `${line};color:rgba(255,255,255,.45)`;
  row.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;height:1.6em;margin-top:2px;color:rgba(255,255,255,.92)';
  text.style.cssText = 'flex:1;min-width:0;margin-right:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  pct.style.cssText = 'font-variant-numeric:tabular-nums';
  track.style.cssText = 'margin-top:8px;height:2px;background:rgba(255,255,255,.16);border-radius:1px;overflow:hidden';
  fill.style.cssText = 'width:100%;height:100%;transform-origin:0 50%;transform:scaleX(0);background:#fff;transition:transform 300ms ease-out';
  row.appendChild(text); row.appendChild(pct); track.appendChild(fill);
  for (const child of [older, old, row, track]) root.appendChild(child);
  container.appendChild(root);

  // What the DOM already holds.
  let label = '', trail1 = '', trail2 = '', percent = -1, scale = -1, changedAt = -Infinity, finished = false;

  function setProgress(fraction: number) {
    const p = Math.round(fraction * 100);
    if (p !== percent) { percent = p; pct.textContent = `${p}%`; root.setAttribute('aria-valuenow', String(p)); }
    const s = Math.round(fraction * STEPS);
    if (s !== scale) { scale = s; fill.style.transform = `scaleX(${s / STEPS})`; }
  }

  return {
    /** `now` is the frame's clock in ms. A label that changes again within the dwell is dropped; the next frame brings the current one. */
    update({ fraction, label: next }: LoadingReport, now: number) {
      if (finished) return;
      setProgress(Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0);
      if (!next || next === label || now - changedAt < DWELL) return;
      if (label) { trail2 = trail1; trail1 = label; older.textContent = trail2; old.textContent = trail1; }
      label = next; text.textContent = label; changedAt = now;
    },
    /** Loading is over: the bar fills, the corner fades out. Later `update`s are ignored. */
    finish() {
      if (finished) return;
      finished = true;
      setProgress(1);
      root.style.opacity = '0';
    },
    /** The label on the current line. */
    get current() { return label; },
    /** The bar, 0..1. */
    get fill() { return scale / STEPS; },
    get done() { return finished; },
    dispose() { root.remove(); },
  };
}

export type LoadingHud = ReturnType<typeof createLoadingHud>;
