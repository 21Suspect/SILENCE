import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/register-ts-hooks.mjs';
const { createObjectiveHud, OBJECTIVE_KEY, OBJECTIVE_HOLD, OBJECTIVE_FADE } = await import('../game/objective-hud.ts');

// A DOM that records every write, so a frame that should change nothing can be shown to write nothing.
const fakeDom = () => {
  const writes = [];
  const make = () => {
    const el = {
      children: [], attrs: {}, listeners: {}, removed: false, writes,
      setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); },
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, remove() { this.removed = true; },
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

const TITLE = { title: 'Find fuel for the generator', detail: 'Fuses 0/3' };
// A clock that the test walks forward in milliseconds; each tick is one "frame".
const make = (options = {}) => {
  const { container, writes } = fakeDom(); let enabled = true, now = 1000;
  const hud = createObjectiveHud(container, { touch: false, enabled: () => enabled, ...options });
  const root = container.children[0];
  const frame = (over = {}) => hud.update({ now, allowed: true, text: TITLE, ...over });
  const advance = (seconds, over = {}, step = 100) => { for (let t = 0; t < seconds * 1000; t += step) { now += step; frame(over); } };
  return { hud, root, container, writes, frame, advance, setEnabled: v => { enabled = v; }, clear: () => { writes.length = 0; } };
};

test('the element is a quiet top-left corner in the interaction prompt\'s type, and starts invisible', () => {
  const { root, container } = make();
  assert.equal(container.children[0], root);
  const css = root.style.cssText;
  assert.match(css, /position:absolute/); assert.match(css, /left:max\(16px/); assert.match(css, /top:max\(14px/);
  assert.match(css, /opacity:0/); assert.match(css, new RegExp(`transition:opacity ${OBJECTIVE_FADE * 1000}ms`));
  assert.match(css, /pointer-events:none/, 'mouse clicks go through it');
  assert.match(css, /font:400 \d+px\/[\d.]+ system-ui,sans-serif/); assert.match(css, /letter-spacing:\.05em/); assert.match(css, /color:#dcd8c9/);
  assert.match(css, /text-shadow:0 1px 3px #000,0 0 14px rgba\(0,0,0,\.75\)/, 'the same shadow as the prompt');
  assert.match(css, /max-width:calc\(100% - 96px\)/, 'leaves the corner with the pause button alone on a 375 px screen');
  assert.equal(root.attrs.role, 'status');
  assert.equal(OBJECTIVE_FADE, .8); assert.equal(OBJECTIVE_HOLD, 7); assert.equal(OBJECTIVE_KEY, 'KeyO');
});

test('it fades up when play starts, stays about seven seconds, then fades down; never a pop', () => {
  const { hud, root, frame, advance } = make();
  frame({ allowed: false });
  assert.equal(root.style.opacity, undefined, 'nothing yet: the game has not started');
  assert.equal(hud.shown, false);
  advance(.1);
  assert.equal(root.style.opacity, '1'); assert.equal(hud.title, 'Find fuel for the generator'); assert.equal(hud.detail, 'Fuses 0/3');
  assert.match(root.style.transition, /^opacity 800ms ease$/, 'an 800 ms eased fade in');
  advance(OBJECTIVE_HOLD - 1);
  assert.equal(root.style.opacity, '1', 'still up before the seven seconds are over');
  advance(1.5);
  assert.equal(root.style.opacity, '0'); assert.equal(hud.shown, false);
  assert.match(root.style.transition, /^opacity 800ms ease$/, 'fading out is the same eased transition, not a cut');
  advance(30);
  assert.equal(root.style.opacity, '0', 'and it stays gone');
});

test('a changed step or changed progress brings it back up; the same text does not', () => {
  const { hud, root, frame, advance } = make();
  advance(OBJECTIVE_HOLD + 2);
  assert.equal(root.style.opacity, '0');
  advance(2, { text: { ...TITLE } });
  assert.equal(root.style.opacity, '0', 'an equal object is not a change');
  advance(.2, { text: { title: 'Find fuel for the generator', detail: 'Fuses 1/3' } });
  assert.equal(root.style.opacity, '1'); assert.equal(hud.detail, 'Fuses 1/3');
  advance(OBJECTIVE_HOLD + 1, { text: { title: 'Find fuel for the generator', detail: 'Fuses 1/3' } });
  assert.equal(root.style.opacity, '0');
  advance(.2, { text: { title: 'Start the generator', detail: 'Fuses 1/3' } });
  assert.equal(root.style.opacity, '1'); assert.equal(hud.title, 'Start the generator');
  frame({ text: undefined });
  assert.equal(hud.title, 'Start the generator', 'no text yet leaves what is there');
});

test('the DOM is written only when something changes', () => {
  const { writes, advance, clear, frame } = make();
  advance(.3); advance(OBJECTIVE_HOLD + 2); clear();
  advance(20); assert.deepEqual(writes, [], 'a hundred steady frames write nothing');
  clear();
  frame({ text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.deepEqual(writes.filter(w => w.startsWith('text=')), ['text=Start the generator'], 'only the line that differs is rewritten');
  clear(); advance(3, { text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.deepEqual(writes.filter(w => w.startsWith('text=')), [], 'identical words are not rewritten');
});

test('a change while it is up swaps the words by dipping them, not by popping', () => {
  const { hud, root, frame, advance, container } = make();
  advance(.3);
  const body = root.children[0];
  assert.equal(root.style.opacity, '1');
  frame({ text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(body.style.opacity, '0'); assert.equal(body.style.transition, 'none'); assert.equal(hud.title, 'Start the generator');
  frame({ text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(body.style.opacity, '1'); assert.match(body.style.transition, /opacity 450ms/);
  assert.equal(root.style.opacity, '1', 'the corner itself never blinked');
  void container;
});

test('O pins it up; O again fades it out and goes back to appearing on its own', () => {
  const { hud, root, frame, advance } = make();
  advance(OBJECTIVE_HOLD + 2);
  assert.equal(root.style.opacity, '0');
  assert.equal(hud.toggle(), true); assert.equal(hud.pinned, true);
  frame(); assert.equal(root.style.opacity, '1');
  advance(60); assert.equal(root.style.opacity, '1', 'pinned stays however long');
  assert.equal(hud.toggle(), true); assert.equal(hud.pinned, false);
  frame(); assert.equal(root.style.opacity, '0', 'unpinning fades it out at once, not after seven seconds');
  advance(.5, { text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(root.style.opacity, '1', 'auto behaviour is back: a new step brings it up');
  advance(OBJECTIVE_HOLD + 1, { text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(root.style.opacity, '0');
});

test('pinning while it is still on its first appearance keeps it; a changed step while pinned keeps it too', () => {
  const { hud, root, frame, advance } = make();
  advance(2); hud.toggle(); advance(OBJECTIVE_HOLD + 3);
  assert.equal(root.style.opacity, '1');
  advance(.2, { text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(root.style.opacity, '1'); assert.equal(hud.title, 'Start the generator');
  hud.toggle(); frame({ text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(root.style.opacity, '0');
});

test('the key hint shows only on the first appearance and while pinned', () => {
  const { hud, root, frame, advance } = make();
  const hint = root.children[1];
  advance(.2);
  assert.equal(hud.hint, 'O to keep', 'the first appearance says what the key is for');
  assert.equal(hint.style.opacity, '1');
  hud.toggle(); frame();
  assert.equal(hud.hint, 'O to hide', 'pinned: how to let it go');
  hud.toggle(); frame();
  assert.equal(hud.hint, '', 'let go: no hint');
  assert.equal(hint.style.opacity, '0'); assert.equal(hint.textContent, 'O to hide', 'the words stay while it fades so they never blink to empty');
  advance(.5, { text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(root.style.opacity, '1'); assert.equal(hud.hint, '', 'a later appearance is quiet');
  hud.toggle(); frame({ text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  assert.equal(hud.hint, 'O to hide', 'but pinning always says how to undo it');
});

test('the intro hint goes with the first appearance, whether or not anyone pressed anything', () => {
  const { hud, advance } = make();
  advance(.2); assert.equal(hud.hint, 'O to keep');
  advance(OBJECTIVE_HOLD + 1); assert.equal(hud.hint, '');
  advance(.2, { text: { title: 'Start the generator' } }); assert.equal(hud.hint, '');
});

test('with the setting off it never appears, not even when the objective changes; turning it back on shows it once', () => {
  const { hud, root, frame, advance, setEnabled } = make();
  setEnabled(false);
  advance(1); assert.equal(root.style.opacity, undefined);
  advance(1, { text: { title: 'Start the generator', detail: 'Fuses 0/3' } });
  advance(1, { text: { title: 'Find the last fuse for the relay hut', detail: 'Fuses 2/3' } });
  assert.equal(root.style.opacity, undefined, 'a change does not sneak it up');
  assert.equal(hud.toggle(), false, 'O does nothing either'); assert.equal(hud.pinned, false);
  setEnabled(true);
  advance(.2, { text: { title: 'Find the last fuse for the relay hut', detail: 'Fuses 2/3' } });
  assert.equal(root.style.opacity, '1', 'the player switched it on in the menu: it answers');
  advance(OBJECTIVE_HOLD + 1, { text: { title: 'Find the last fuse for the relay hut', detail: 'Fuses 2/3' } });
  assert.equal(root.style.opacity, '0');
});

test('switching it off while pinned lets the pin go', () => {
  const { hud, root, advance, setEnabled } = make();
  advance(.2); hud.toggle(); advance(1);
  setEnabled(false); advance(.2);
  assert.equal(root.style.opacity, '0'); assert.equal(hud.pinned, false);
  setEnabled(true); advance(OBJECTIVE_HOLD + 2);
  assert.equal(root.style.opacity, '0', 'it was shown once on re-enabling, not pinned again');
});

test('behind the pause menu, the death card or the loading veil it is gone at once, and its timer waits', () => {
  const { hud, root, frame, advance } = make();
  advance(2);
  assert.equal(root.style.opacity, '1');
  frame({ allowed: false });
  assert.equal(root.style.opacity, '0'); assert.equal(root.style.transition, 'none', 'an immediate cut, so it never shows through a menu');
  assert.equal(hud.toggle(), false, 'O in a menu does nothing');
  advance(60, { allowed: false });
  assert.equal(root.style.opacity, '0');
  advance(.1);
  assert.equal(root.style.opacity, '1', 'back from the menu with the time it had left (five of its seven seconds)');
  assert.match(root.style.transition, /opacity 800ms/, 'and it fades back, not cuts');
  advance(4); assert.equal(root.style.opacity, '1');
  advance(1.5); assert.equal(root.style.opacity, '0');
});

test('a pause never counts against the seven seconds, however long it lasts', () => {
  const { root, advance } = make();
  advance(3); advance(600, { allowed: false }, 1000);
  advance(3); assert.equal(root.style.opacity, '1', 'six of seven used');
  advance(2); assert.equal(root.style.opacity, '0');
});

test('a pinned element is hidden by a menu too, and returns pinned', () => {
  const { hud, root, advance } = make();
  advance(.2); hud.toggle(); advance(1);
  advance(1, { allowed: false }); assert.equal(root.style.opacity, '0');
  advance(.2); assert.equal(root.style.opacity, '1'); assert.equal(hud.pinned, true);
});

test('on touch a tap on the corner is the key, the corner takes taps even when faded, and menus give the touch back', () => {
  const { hud, root, frame, advance } = make({ touch: true });
  assert.equal(hud.hint, '');
  advance(.2);
  assert.equal(root.style.pointerEvents, 'auto'); assert.equal(hud.hint, 'Tap to keep');
  assert.ok(root.listeners.click?.length, 'a click handler');
  const stopped = []; const event = type => ({ type, stopPropagation() { stopped.push(type); } });
  root.listeners.click[0](event('click'));
  assert.equal(hud.pinned, true); assert.deepEqual(stopped, ['click'], 'the tap does not reach the game underneath');
  frame(); assert.equal(hud.hint, 'Tap to hide');
  for (const type of ['touchstart', 'touchend', 'pointerdown', 'mousedown']) { assert.ok(root.listeners[type]?.length, type); root.listeners[type][0](event(type)); }
  assert.ok(stopped.includes('touchstart') && stopped.includes('mousedown'));
  root.listeners.click[0](event('click')); frame();
  assert.equal(hud.pinned, false); assert.equal(root.style.opacity, '0');
  assert.equal(root.style.pointerEvents, 'auto', 'faded out but still tappable, or there would be no way to bring it back');
  root.listeners.click[0](event('click')); frame(); assert.equal(root.style.opacity, '1');
  frame({ allowed: false }); assert.equal(root.style.pointerEvents, 'none', 'a menu gets every touch');
  root.listeners.click[0](event('click')); assert.equal(hud.pinned, true, 'unchanged by a tap that a menu should have eaten');
});

test('on a mouse device the corner never takes a click', () => {
  const { root, advance } = make();
  advance(.5); assert.equal(root.style.pointerEvents, undefined); assert.deepEqual(root.listeners, {});
});

test('dispose removes it, and a custom key name is used in the hint', () => {
  const { hud, root, advance } = make({ keyName: 'H' });
  advance(.2); assert.equal(hud.hint, 'H to keep');
  hud.dispose(); assert.equal(root.removed, true);
});

test('a hidden tab or a long stall does not skip the timer past the visible time', () => {
  const { root, hud, frame, advance } = make();
  advance(.2);
  frame({ now: 1e9 }); // a huge jump in the clock counts as a quarter second at most
  assert.equal(root.style.opacity, '1'); assert.equal(hud.shown, true);
});
