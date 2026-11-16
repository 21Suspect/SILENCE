import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register-ts-hooks.mjs';
const { createLoadingHud } = await import('../../game/ui/loading-hud.ts');

// A DOM that records every write, so a frame that should change nothing can be shown to write nothing.
const fakeDom = () => {
  const writes = [];
  const make = () => {
    const el = {
      children: [], attrs: {}, removed: false,
      setAttribute(k, v) { this.attrs[k] = v; writes.push(`attr.${k}=${v}`); }, appendChild(c) { this.children.push(c); }, remove() { this.removed = true; },
    };
    let text = '', cssText = '';
    el.style = new Proxy({}, { set(t, k, v) { t[k] = v; writes.push(`style.${String(k)}=${v}`); return true; } });
    Object.defineProperty(el, 'textContent', { get: () => text, set: v => { text = v; writes.push(`text=${v}`); } });
    Object.defineProperty(el.style, 'cssText', { get: () => cssText, set: v => { cssText = v; }, configurable: true });
    return el;
  };
  const container = { children: [], ownerDocument: { createElement: make }, appendChild(c) { this.children.push(c); } };
  return { container, writes };
};
const make = () => {
  const { container, writes } = fakeDom();
  const hud = createLoadingHud(container);
  const root = container.children[0], [older, old, row, track] = root.children, [text, pct] = row.children, fill = track.children[0];
  let now = 1000;
  // Each call is one frame, 200 ms after the last: past the hold on a changed label.
  const frame = (fraction, label, advance = 200) => { now += advance; hud.update({ fraction, label }, now); };
  return { hud, root, older, old, text, pct, fill, container, writes, frame, clear: () => { writes.length = 0; } };
};

test('it sits low in the left corner above the veil, left-aligned and taking no clicks', () => {
  const { root, container } = make();
  assert.equal(container.children[0], root);
  const css = root.style.cssText;
  assert.match(css, /position:absolute/); assert.match(css, /left:max\(28px/); assert.match(css, /bottom:max\(28px/);
  assert.match(css, /text-align:left/); assert.match(css, /pointer-events:none/);
  assert.match(css, /z-index:101/, 'above the veil, which is 100');
  assert.doesNotMatch(css, /left:50%|translateX/, 'nothing centred');
});

test('it is a labelled progress bar for assistive technology, and says its value only when the whole percentage changes', () => {
  const { root, frame, clear, writes } = make();
  assert.equal(root.attrs.role, 'progressbar'); assert.equal(root.attrs['aria-valuemin'], '0'); assert.equal(root.attrs['aria-valuemax'], '100');
  frame(.424, 'A'); assert.equal(root.attrs['aria-valuenow'], '42');
  clear(); frame(.4249, 'A'); assert.deepEqual(writes.filter(w => w.startsWith('attr.')), []);
  frame(.43, 'A'); assert.equal(root.attrs['aria-valuenow'], '43');
});

test('the percentage and the bar follow the fraction, and broken or out-of-range values are clamped', () => {
  const { hud, pct, fill, frame } = make();
  frame(.62, 'Compiling'); assert.equal(pct.textContent, '62%'); assert.equal(hud.fill, .62); assert.equal(fill.style.transform, 'scaleX(0.62)');
  frame(7, 'x'); assert.equal(pct.textContent, '100%'); assert.equal(hud.fill, 1);
  frame(-2, 'x'); assert.equal(pct.textContent, '0%');
  frame(NaN, 'x'); assert.equal(pct.textContent, '0%');
});

test('the current line shows the latest label, and the two before it fade up above it', () => {
  const { hud, text, old, older, frame } = make();
  frame(.1, 'Terrain'); assert.equal(text.textContent, 'Terrain'); assert.equal(hud.current, 'Terrain');
  frame(.2, 'Rocks'); assert.equal(text.textContent, 'Rocks'); assert.equal(old.textContent, 'Terrain');
  frame(.3, 'Shaders'); assert.equal(text.textContent, 'Shaders'); assert.equal(old.textContent, 'Rocks'); assert.equal(older.textContent, 'Terrain');
  frame(.4, 'Stumps'); assert.equal(old.textContent, 'Shaders'); assert.equal(older.textContent, 'Rocks');
});

test('a label that changes again within the hold is dropped, so a burst of files stays readable', () => {
  const { text, frame } = make();
  frame(.1, 'One'); frame(.1, 'Two', 50); frame(.1, 'Three', 50);
  assert.equal(text.textContent, 'One', 'held');
  frame(.1, 'Four', 100);
  assert.equal(text.textContent, 'Four', 'then it takes the current one');
});

test('a steady frame writes nothing at all', () => {
  const { writes, frame, clear } = make();
  frame(.5, 'Compiling'); clear();
  for (let i = 0; i < 200; i++) frame(.5, 'Compiling');
  assert.deepEqual(writes, []);
  frame(.5004, 'Compiling'); assert.deepEqual(writes, [], 'a change finer than a percent and a step writes nothing');
});

test('finish fills the bar, fades the corner out, and ignores later updates', () => {
  const { hud, root, pct, text, frame } = make();
  frame(.5, 'Compiling');
  hud.finish();
  assert.equal(hud.done, true); assert.equal(pct.textContent, '100%'); assert.equal(hud.fill, 1); assert.equal(root.style.opacity, '0');
  assert.match(root.style.cssText, /transition:opacity \d+ms ease/);
  frame(.1, 'Late'); assert.equal(pct.textContent, '100%'); assert.equal(text.textContent, 'Compiling');
});

test('dispose takes it off the page', () => {
  const { hud, root } = make(); hud.dispose(); assert.equal(root.removed, true);
});
