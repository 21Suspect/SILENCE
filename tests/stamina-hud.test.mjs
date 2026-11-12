import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/register-ts-hooks.mjs';
const { createStaminaHud } = await import('../game/stamina-hud.ts');

// A DOM that records every write, so a frame that should change nothing can be shown to write nothing.
const fakeDom = () => {
  const writes = [];
  const make = () => {
    const el = {
      children: [], attrs: {}, removed: false,
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); }, remove() { this.removed = true; },
    };
    let cssText = '';
    el.style = new Proxy({}, { set(t, k, v) { t[k] = v; writes.push(`style.${String(k)}=${v}`); return true; } });
    Object.defineProperty(el.style, 'cssText', { get: () => cssText, set: v => { cssText = v; }, configurable: true });
    return el;
  };
  const container = { children: [], ownerDocument: { createElement: make }, appendChild(c) { this.children.push(c); } };
  return { container, writes };
};
const make = () => {
  const { container, writes } = fakeDom();
  const hud = createStaminaHud(container);
  const root = container.children[0], fill = root.children[0];
  const frame = (value, over = {}) => hud.update({ allowed: true, value, exhausted: false, ...over });
  return { hud, root, fill, container, writes, frame, clear: () => { writes.length = 0; } };
};

test('a thin bar low on the screen, in the objective corner\'s quiet style, taking no clicks and starting invisible', () => {
  const { root, fill, container } = make();
  assert.equal(container.children[0], root);
  const css = root.style.cssText;
  assert.match(css, /position:absolute/); assert.match(css, /left:50%/); assert.match(css, /bottom:max\(/);
  assert.match(css, /height:3px/); assert.match(css, /pointer-events:none/); assert.match(css, /opacity:0/);
  assert.match(css, /z-index:3/, 'under the pause button and every menu, like the objective corner');
  assert.equal(root.attrs['aria-hidden'], 'true');
  assert.match(fill.style.cssText, /background:#dcd8c9/, 'the HUD\'s own text colour');
});

test('it uses only colours the objective corner already uses', () => {
  const { root, fill, frame } = make();
  frame(.5, { exhausted: true });
  const allowed = new Set(['#dcd8c9', '#a9a89b', '#8b8c80', '#000']);
  const seen = [...(root.style.cssText + ' ' + fill.style.cssText + ' ' + fill.style.background).matchAll(/#[0-9a-f]{3,6}\b/gi)].map(m => m[0].toLowerCase());
  for (const c of seen) assert.ok(allowed.has(c), `${c} is not an existing HUD colour`);
  assert.equal(fill.style.background, '#8b8c80');
});

test('it is shown only while stamina is below full', () => {
  const { hud, root, frame } = make();
  frame(1); assert.equal(hud.shown, false); assert.equal(root.style.opacity, undefined, 'full from the start: never written, never shown');
  frame(.97); assert.equal(hud.shown, true); assert.equal(root.style.opacity, '1');
  frame(.2); assert.equal(root.style.opacity, '1');
  frame(1); assert.equal(hud.shown, false); assert.equal(root.style.opacity, '0');
});

test('the fill follows the value, and out-of-range or broken values are clamped', () => {
  const { hud, fill, frame } = make();
  frame(.5); assert.equal(hud.fill, .5); assert.equal(fill.style.transform, 'scaleX(0.5)');
  frame(.25); assert.equal(hud.fill, .25);
  frame(-3); assert.equal(hud.fill, 0);
  frame(NaN); assert.equal(hud.shown, false, 'a broken value reads as full rather than as a flash of empty');
  frame(7); assert.equal(hud.shown, false);
});

test('it fades up quickly, fades away slowly once refilled, and is cut at once behind a menu or the death card', () => {
  const { root, frame } = make();
  frame(.8); assert.equal(root.style.transition, 'opacity 200ms ease');
  frame(1); assert.equal(root.style.transition, 'opacity 700ms ease');
  frame(.8, { allowed: false }); assert.equal(root.style.opacity, '0'); assert.equal(root.style.transition, 'none');
  frame(.8); assert.equal(root.style.opacity, '1', 'back from the menu with what it had');
});

test('it does not recolour or rewrite the DOM unless something differs, and a steady bar writes nothing', () => {
  const { writes, frame, clear, fill } = make();
  frame(.6); clear();
  for (let i = 0; i < 200; i++) frame(.6); assert.deepEqual(writes, [], 'two hundred steady frames write nothing');
  frame(.6001); assert.deepEqual(writes, [], 'a change finer than the step does not write');
  frame(.6, { exhausted: true });
  assert.deepEqual(writes, ['style.background=#8b8c80']);
  clear(); frame(.6, { exhausted: false });
  assert.deepEqual(writes, ['style.background=#dcd8c9']); void fill;
});

test('while fading out at full the fill is left alone, so it never snaps to full and back', () => {
  const { writes, frame, clear, hud } = make();
  frame(.9); frame(.9995); clear();
  frame(1); assert.deepEqual(writes.filter(w => w.startsWith('style.transform')), []);
  assert.equal(hud.fill, 1);
});

test('dispose removes it', () => {
  const { root, hud } = make(); hud.dispose(); assert.equal(root.removed, true);
});
