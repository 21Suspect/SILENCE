import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register-ts-hooks.mjs';
const { createBoardPanel } = await import('../../game/ui/board-panel.ts');
const { createEndingCard } = await import('../../game/ui/ending-card.ts');

// Just enough DOM: a tree of elements with style, text and listeners, and a window to hang key handlers on.
const fakeDom = () => {
  const win = { listeners: {}, addEventListener(t, f) { (this.listeners[t] ??= new Set()).add(f); }, removeEventListener(t, f) { this.listeners[t]?.delete(f); },
    press(code, type = 'keydown') { const e = { code, type, repeat: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } }; for (const f of [...(this.listeners[type] ?? [])]) f(e); return e; } };
  const make = () => {
    const el = { children: [], style: {}, attrs: {}, listeners: {}, removed: false, _text: '', offsetWidth: 0,
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
      addEventListener(t, f) { (this.listeners[t] ??= new Set()).add(f); }, removeEventListener(t, f) { this.listeners[t]?.delete(f); }, remove() { this.removed = true; },
      set textContent(v) { this._text = v; this.children = []; }, get textContent() { return this.children.length ? this.children.map(c => c.textContent).join(' ') : this._text; } };
    return el;
  };
  const doc = { createElement: make, defaultView: win };
  const container = { ownerDocument: doc, children: [], appendChild(c) { this.children.push(c); return c; } };
  return { container, win };
};

test('the board shows one line per part, closes on E, and swallows the key it closes with', () => {
  const { container, win } = fakeDom();
  const panel = createBoardPanel(container, { lines: () => ['Bulbs: around the chapel', 'Cable: banked in the chest at the cabin'] });
  assert.equal(panel.isOpen, false);
  panel.open();
  assert.equal(panel.isOpen, true);
  assert.match(panel.text, /Bulbs:\s+around the chapel/);
  assert.match(panel.text, /Cable:\s+banked in the chest/);
  const real = Date.now; Date.now = () => real() + 1000; // the opening keypress is not the closing one
  try {
    const e = win.press('KeyE');
    assert.equal(e.stopped, true, 'the interact key is not also handed to the game');
    assert.equal(panel.isOpen, false);
    assert.equal(win.press('KeyE').stopped, false, 'closed: the key is the game\'s again');
  } finally { Date.now = real; }
});

test('Escape closes it and does not pause the game; walking away closes it too; other keys pass through', () => {
  const { container, win } = fakeDom();
  const panel = createBoardPanel(container, { lines: () => [] });
  panel.open(); assert.match(panel.text, /Nothing is listed/);
  const real = Date.now; Date.now = () => real() + 1000;
  try {
    assert.equal(win.press('KeyW').stopped, false);
    assert.equal(win.press('Escape').stopped, true); assert.equal(panel.isOpen, false);
    panel.open(); panel.update(3); assert.equal(panel.isOpen, true, 'beside it, it stays'); panel.update(6); assert.equal(panel.isOpen, false, 'walked off');
  } finally { Date.now = real; }
  panel.dispose(); assert.equal(Object.values(win.listeners).every(s => s.size === 0), true, 'no listener left on the window');
});

test('the ending card fades up, says the line, and tells the caller once it is up', async () => {
  const { container } = fakeDom();
  const card = createEndingCard(container, { fadeSeconds: .01, holdSeconds: .01 });
  let done = 0; card.play(() => { done++; }); card.play(() => { done++; });
  assert.equal(card.playing, true);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(done, 1);
  assert.match(container.children[0].textContent, /You got off the island\./);
  card.reset(); assert.equal(card.playing, false); card.dispose();
});

test('a "# " line is a group heading, drawn without the part\'s name and colon', () => {
  const { container } = fakeDom();
  const panel = createBoardPanel(container, { lines: () => ['# For the call (relay hut)', 'Fuse 1: around the mine', '# For the landing pad', 'Bulbs: around the chapel'] });
  panel.open();
  assert.match(panel.text, /For the call \(relay hut\)/); assert.doesNotMatch(panel.text, /# /);
  assert.match(panel.text, /Fuse 1:\s+around the mine/); assert.match(panel.text, /For the landing pad/);
  const items = container.children[0].children[0].children[1].children[1].children;
  assert.equal(items.length, 4); assert.match(items[0].style.cssText, /text-transform:uppercase/); assert.doesNotMatch(items[1].style.cssText, /uppercase/);
});
