import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register-ts-hooks.mjs';
const { createObjectiveHud, OBJECTIVE_KEY, OBJECTIVE_HINT_SECONDS, OBJECTIVE_FADE } = await import('../../game/ui/objective-hud.ts');

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
const NEXT = { title: 'Start the generator', detail: 'Fuses 0/3' };
// A clock that the test walks forward in milliseconds; each tick is one "frame". With no `enabled` option the HUD keeps its own flag.
const make = (options = {}) => {
  const { container, writes } = fakeDom(); let now = 1000;
  const hud = createObjectiveHud(container, { touch: false, ...options });
  const root = container.children[0];
  const frame = (over = {}) => hud.update({ now, allowed: true, text: TITLE, ...over });
  const advance = (seconds, over = {}, step = 100) => { for (let t = 0; t < seconds * 1000 - 1e-6; t += step) { now += step; frame(over); } };
  return { hud, root, container, writes, frame, advance, clear: () => { writes.length = 0; } };
};
// The saved setting as the engine wires it: one flag that the menu checkbox and O both flip, and that the next load reads back.
const saved = initial => { const store = { on: initial, saves: 0 }; return { store, enabled: () => store.on, setEnabled: v => { store.on = v; store.saves++; } }; };

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
  assert.equal(OBJECTIVE_FADE, .8); assert.equal(OBJECTIVE_HINT_SECONDS, 7); assert.equal(OBJECTIVE_KEY, 'KeyO');
});

test('it is shown by default: it fades up when play starts and then simply stays, however long', () => {
  const { hud, root, frame, advance } = make();
  frame({ allowed: false });
  assert.equal(root.style.opacity, undefined, 'nothing yet: the game has not started');
  assert.equal(hud.shown, false);
  advance(.1);
  assert.equal(root.style.opacity, '1'); assert.equal(hud.title, 'Find fuel for the generator'); assert.equal(hud.detail, 'Fuses 0/3');
  assert.match(root.style.transition, /^opacity 800ms ease$/, 'an 800 ms eased fade in, not a pop');
  assert.equal(hud.hidden, false);
  advance(OBJECTIVE_HINT_SECONDS + 3); assert.equal(root.style.opacity, '1', 'the old seven-second fade is gone');
  advance(15 * 60, {}, 1000); assert.equal(root.style.opacity, '1', 'a quarter of an hour on, the same steady text');
  assert.equal(hud.shown, true);
});

test('nothing is shown before the first words arrive, whatever the setting says', () => {
  const { hud, root, advance } = make();
  advance(2, { text: undefined });
  assert.equal(root.style.opacity, undefined); assert.equal(hud.shown, false);
  advance(.2); assert.equal(root.style.opacity, '1');
});

test('a changed step or changed progress swaps the words and the corner stays up; it never goes away on its own', () => {
  const { hud, root, frame, advance } = make();
  advance(.3);
  advance(2, { text: { ...TITLE } });
  assert.equal(root.style.opacity, '1', 'an equal object is not a change');
  advance(OBJECTIVE_HINT_SECONDS + 2, { text: { title: 'Find fuel for the generator', detail: 'Fuses 1/3' } });
  assert.equal(root.style.opacity, '1'); assert.equal(hud.detail, 'Fuses 1/3');
  advance(.2, { text: NEXT });
  assert.equal(root.style.opacity, '1'); assert.equal(hud.title, 'Start the generator');
  frame({ text: undefined });
  assert.equal(hud.title, 'Start the generator', 'no text yet leaves what is there');
});

test('the DOM is written only when something changes', () => {
  const { writes, advance, clear, frame } = make();
  advance(.3); advance(OBJECTIVE_HINT_SECONDS + 2); clear();
  advance(20); assert.deepEqual(writes, [], 'two hundred steady frames write nothing');
  clear();
  frame({ text: NEXT });
  assert.deepEqual(writes.filter(w => w.startsWith('text=')), ['text=Start the generator'], 'only the line that differs is rewritten');
  clear(); advance(3, { text: NEXT });
  assert.deepEqual(writes.filter(w => w.startsWith('text=')), [], 'identical words are not rewritten');
});

test('a change while it is up swaps the words by dipping them, not by popping', () => {
  const { hud, root, frame, advance } = make();
  advance(.3);
  const body = root.children[0];
  assert.equal(root.style.opacity, '1');
  frame({ text: NEXT });
  assert.equal(body.style.opacity, '0'); assert.equal(body.style.transition, 'none'); assert.equal(hud.title, 'Start the generator');
  frame({ text: NEXT });
  assert.equal(body.style.opacity, '1'); assert.match(body.style.transition, /opacity 450ms/);
  assert.equal(root.style.opacity, '1', 'the corner itself never blinked');
});

test('O hides it with a fade, and O again shows it; without a saved setting that is a flag in memory', () => {
  const { hud, root, frame, advance } = make();
  advance(2);
  assert.equal(hud.toggle(), true); assert.equal(hud.hidden, true);
  frame(); assert.equal(root.style.opacity, '0'); assert.equal(hud.shown, false);
  assert.notEqual(root.style.transition, 'none', 'the player\'s own hide keeps the eased fade from the stylesheet: not a cut');
  assert.match(root.style.cssText, /transition:opacity 800ms ease/);
  advance(60); assert.equal(root.style.opacity, '0', 'and it stays hidden however long, whatever the objective does');
  advance(2, { text: NEXT }); assert.equal(root.style.opacity, '0', 'a changed step does not bring it back by itself');
  assert.equal(hud.toggle(), true); assert.equal(hud.hidden, false);
  frame({ text: NEXT }); assert.equal(root.style.opacity, '1'); assert.equal(hud.title, 'Start the generator', 'it shows the current step, not a stale one');
  assert.notEqual(root.style.transition, 'none');
});

test('the choice is the saved setting: O writes it, and a reload that reads it back starts hidden or shown to match', () => {
  const s = saved(true);
  const a = make(s);
  a.advance(1); assert.equal(a.root.style.opacity, '1', 'on by default');
  a.hud.toggle(); assert.equal(s.store.on, false, 'O wrote the setting through'); assert.equal(s.store.saves, 1);
  a.advance(1); assert.equal(a.root.style.opacity, '0');
  // "Reload": a new HUD built over the same stored value.
  const b = make(s);
  b.advance(3); assert.equal(b.root.style.opacity, undefined, 'still hidden after a reload: never written, never shown'); assert.equal(b.hud.hidden, true);
  b.hud.toggle(); b.advance(1); assert.equal(s.store.on, true); assert.equal(s.store.saves, 2);
  assert.equal(b.root.style.opacity, '1');
  const c = make(s); c.advance(1); assert.equal(c.root.style.opacity, '1', 'and shown again after the next reload');
});

test('the Settings checkbox and O are the same switch: a change made in the menu is what O flips next', () => {
  const s = saved(true);
  const { hud, root, advance } = make(s);
  advance(1); advance(1, { allowed: false });
  s.store.on = false;                                  // unticked in the menu
  advance(1); assert.equal(root.style.opacity, '0', 'back from the menu: hidden, as chosen'); assert.equal(hud.shown, false);
  assert.equal(hud.toggle(), true); assert.equal(s.store.on, true, 'O now shows it');
  advance(.2); assert.equal(root.style.opacity, '1');
});

test('with the setting off it never appears, not even when the objective changes, and O is only unavailable behind a menu', () => {
  const s = saved(false);
  const { hud, root, advance } = make(s);
  advance(1); assert.equal(root.style.opacity, undefined);
  advance(1, { text: NEXT });
  advance(1, { text: { title: 'Find the last fuse for the relay hut', detail: 'Fuses 2/3' } });
  assert.equal(root.style.opacity, undefined, 'a change does not sneak it up');
  s.store.on = true; advance(.2, { text: { title: 'Find the last fuse for the relay hut', detail: 'Fuses 2/3' } });
  assert.equal(root.style.opacity, '1', 'the player switched it on in the menu: it answers');
  assert.equal(hud.title, 'Find the last fuse for the relay hut');
  s.store.on = false; advance(.2); assert.equal(root.style.opacity, '0');
});

test('the key hint says which key hides it for the first seven seconds on screen, then goes; the objective stays', () => {
  const { hud, root, advance } = make();
  const hint = root.children[1];
  advance(.2);
  assert.equal(hud.hint, 'O to hide'); assert.equal(hint.style.opacity, '1');
  advance(OBJECTIVE_HINT_SECONDS - 1); assert.equal(hud.hint, 'O to hide');
  advance(1.5);
  assert.equal(hud.hint, ''); assert.equal(hint.style.opacity, '0'); assert.equal(hint.textContent, 'O to hide', 'the words stay while it fades so they never blink to empty');
  assert.equal(root.style.opacity, '1');
  advance(.5, { text: NEXT }); assert.equal(hud.hint, '', 'a later step is quiet');
});

test('time behind a menu or while hidden does not use up the hint; pressing O does, since that player knows the key', () => {
  const a = make();
  a.advance(3); a.advance(600, { allowed: false }, 1000); a.advance(.2);
  assert.equal(a.hud.hint, 'O to hide', 'a pause does not eat it');
  a.advance(3.5); assert.equal(a.hud.hint, 'O to hide', 'six of seven seconds used');
  a.advance(1.2); assert.equal(a.hud.hint, '');
  const b = make();
  b.advance(.2); b.hud.toggle(); b.advance(30); b.hud.toggle(); b.advance(.5);
  assert.equal(b.root.style.opacity, '1'); assert.equal(b.hud.hint, '', 'shown again by O: no instructions');
});

test('behind the pause menu, the death card or the loading veil it is gone at once, and returns with a fade', () => {
  const { hud, root, frame, advance } = make();
  advance(2);
  assert.equal(root.style.opacity, '1');
  frame({ allowed: false });
  assert.equal(root.style.opacity, '0'); assert.equal(root.style.transition, 'none', 'an immediate cut, so it never shows through a menu');
  assert.equal(hud.toggle(), false, 'O in a menu does nothing'); assert.equal(hud.hidden, false);
  advance(60, { allowed: false });
  assert.equal(root.style.opacity, '0');
  advance(.1);
  assert.equal(root.style.opacity, '1', 'back from the menu');
  assert.match(root.style.transition, /opacity 800ms/, 'and it fades back, not cuts');
});

test('a hidden objective stays hidden through a menu, and does not reappear when it closes', () => {
  const s = saved(true);
  const { hud, root, advance } = make(s);
  advance(.5); hud.toggle(); advance(1);
  advance(1, { allowed: false }); assert.equal(root.style.opacity, '0');
  advance(2); assert.equal(root.style.opacity, '0'); assert.equal(hud.hidden, true);
});

test('on touch a tap on the corner is the key, the corner takes taps even while hidden, and menus give the touch back', () => {
  const s = saved(true);
  const { hud, root, frame, advance } = make({ touch: true, ...s });
  assert.equal(hud.hint, '');
  advance(.2);
  assert.equal(root.style.pointerEvents, 'auto'); assert.equal(hud.hint, 'Tap to hide');
  assert.ok(root.listeners.click?.length, 'a click handler');
  const stopped = []; const event = type => ({ type, stopPropagation() { stopped.push(type); } });
  root.listeners.click[0](event('click'));
  assert.equal(s.store.on, false); assert.deepEqual(stopped, ['click'], 'the tap does not reach the game underneath');
  frame(); assert.equal(root.style.opacity, '0');
  assert.equal(root.style.pointerEvents, 'auto', 'hidden but still tappable, or there would be no way to bring it back');
  for (const type of ['touchstart', 'touchend', 'pointerdown', 'mousedown']) { assert.ok(root.listeners[type]?.length, type); root.listeners[type][0](event(type)); }
  assert.ok(stopped.includes('touchstart') && stopped.includes('mousedown'));
  root.listeners.click[0](event('click')); frame(); assert.equal(root.style.opacity, '1'); assert.equal(s.store.on, true);
  frame({ allowed: false }); assert.equal(root.style.pointerEvents, 'none', 'a menu gets every touch');
  root.listeners.click[0](event('click')); assert.equal(s.store.on, true, 'unchanged by a tap that a menu should have eaten');
});

test('on a mouse device the corner never takes a click', () => {
  const { root, advance } = make();
  advance(.5); assert.equal(root.style.pointerEvents, undefined); assert.deepEqual(root.listeners, {});
});

test('dispose removes it, and a custom key name is used in the hint', () => {
  const { hud, root, advance } = make({ keyName: 'H' });
  advance(.2); assert.equal(hud.hint, 'H to hide');
  hud.dispose(); assert.equal(root.removed, true);
});

test('a hidden tab or a long stall does not skip the hint timer past the visible time', () => {
  const { root, hud, frame, advance } = make();
  advance(.2);
  frame({ now: 1e9 }); // a huge jump in the clock counts as a quarter second at most
  assert.equal(root.style.opacity, '1'); assert.equal(hud.shown, true); assert.equal(hud.hint, 'O to hide');
});
