import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
const { createInteraction, promptText, lineOfSight } = await import('../../../game/render/props/interaction.ts');
const { createCollisionWorld } = await import('../../../game/sim/world/collision.ts');

// A container that records what the prompt does, standing in for the DOM.
const fakeContainer = () => {
  const el = { style: {}, textContent: '', attrs: {}, removed: false, setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; } };
  const container = { children: [], ownerDocument: { createElement: () => el }, appendChild(child) { this.children.push(child); } };
  return { container, el };
};
const eyeCamera = (x = 0, y = 1.6, z = 0, yaw = 0, pitch = 0) => {
  const c = new THREE.PerspectiveCamera(69, 1.6, .075, 100); c.rotation.order = 'YXZ'; c.position.set(x, y, z); c.rotation.set(pitch, yaw, 0); c.updateMatrixWorld(true); return c;
};
const make = (camera = eyeCamera(), solids = [], options = {}) => {
  const world = createCollisionWorld(); world.replace('t', solids);
  const { container, el } = fakeContainer();
  return { ui: createInteraction(container, camera, world, options), el, container, world, camera };
};
const item = (over = {}) => ({ id: 'x', position: new THREE.Vector3(0, 1.2, -1.5), label: 'Left click to pick up', enabled: () => true, activate() { this.hits = (this.hits ?? 0) + 1; }, ...over });

test('the prompt is one centred, low line that fades over about 220 ms and says nothing until there is something to do', () => {
  const { ui, el, container } = make();
  assert.equal(container.children[0], el);
  assert.match(el.style.cssText, /left:50%/); assert.match(el.style.cssText, /transition:opacity 220ms/); assert.match(el.style.cssText, /pointer-events:none/);
  assert.equal(el.style.opacity, undefined, 'nothing is shown yet by script...');
  assert.match(el.style.cssText, /opacity:0/, '...and the stylesheet starts it invisible');
  ui.register(item()); ui.update();
  assert.equal(el.textContent, 'Left click to pick up'); assert.equal(el.style.opacity, '1');
  ui.update(false);
  assert.equal(el.style.opacity, '0'); assert.equal(el.textContent, 'Left click to pick up', 'the words stay while the line fades out');
  ui.dispose(); assert.equal(el.removed, true);
});

test('touch devices are told to tap; other wording is left alone', () => {
  assert.equal(promptText('Left click to pick up', true), 'Tap to pick up');
  assert.equal(promptText('Left click to pull the cord', false), 'Left click to pull the cord');
  assert.equal(promptText('Click to insert fuse', false), 'Left click to insert fuse');
  assert.equal(promptText('Hands full', true), 'Hands full');
  const { ui, el } = make(eyeCamera(), [], { touch: true }); ui.register(item()); ui.update();
  assert.equal(el.textContent, 'Tap to pick up');
});

test('range, view cone and enabled all have to agree, and the cone narrows with distance', () => {
  const { ui } = make();
  const target = (x, y, z, over = {}) => item({ id: 'a', position: new THREE.Vector3(x, y, z), ...over });
  const focusOf = it => { ui.register(it); ui.update(); return ui.focused?.id; };
  assert.equal(focusOf(target(0, 1.6, -1)), 'a', 'straight ahead');
  assert.equal(focusOf(target(0, 1.6, -2.6)), undefined, 'beyond the default 2.4 m');
  assert.equal(focusOf(target(0, 1.6, -2.6, { range: 3 })), 'a', 'a longer range is honoured');
  assert.equal(focusOf(target(0, 1.6, 1.5)), undefined, 'behind the player');
  assert.equal(focusOf(target(1.2, 1.6, -1.2)), undefined, '45 degrees off axis');
  assert.equal(focusOf(target(.45, 1.6, -1)), 'a', '24 degrees off, a metre away: inside the cone');
  assert.equal(focusOf(target(.9, 1.6, -2)), undefined, 'the same 24 degrees at two metres: the far cone is tighter');
  assert.equal(focusOf(target(0, 1.6, -1, { enabled: () => false })), undefined);
  assert.equal(focusOf(target(0, 1.4, -.1)), 'a', 'an item right under the nose is reachable whichever way you face');
});

test('the best item wins: the one in the middle of the view, then the nearer one', () => {
  const { ui } = make();
  ui.register(item({ id: 'edge', position: new THREE.Vector3(.5, 1.6, -1) }));
  ui.register(item({ id: 'centre', position: new THREE.Vector3(0, 1.6, -2) }));
  ui.update(); assert.equal(ui.focused.id, 'centre');
  ui.register(item({ id: 'centre-near', position: new THREE.Vector3(0, 1.6, -1) })); ui.update(); assert.equal(ui.focused.id, 'centre-near');
});

test('a wall between the eye and the item blocks it, but not a wall the item is leaning on', () => {
  const wall = { kind: 'box', x: 0, z: -1, halfX: 2, halfZ: .1, yaw: 0, minY: 0, maxY: 2.5 };
  const { ui } = make(eyeCamera(), [wall]);
  ui.register(item({ position: new THREE.Vector3(0, 1.6, -2) })); ui.update();
  assert.equal(ui.focused, undefined, 'behind the wall');
  assert.equal(ui.activate(), false);
  ui.register(item({ position: new THREE.Vector3(0, 1.6, -1.05) })); ui.update();
  assert.ok(ui.focused, 'hanging on the near face of the wall is fine');
  const low = { ...wall, maxY: 1 };
  const o = make(eyeCamera(), [low]); o.ui.register(item({ position: new THREE.Vector3(0, 1.6, -2) })); o.ui.update();
  assert.ok(o.ui.focused, 'a low wall is stepped over by the sight line, as in flashlight.canPick');
  const tall = make(eyeCamera(), [{ ...wall, minY: 0, maxY: 3 }]); assert.equal(lineOfSight(tall.world, new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(0, 1.6, -2)), false);
  assert.equal(lineOfSight(tall.world, new THREE.Vector3(0, 1.6, 0), new THREE.Vector3(0, 1.6, .8)), true);
});

test('activate runs the focused item once and reports whether there was one', () => {
  const { ui } = make(); const a = item();
  assert.equal(ui.activate(), false);
  ui.register(a);
  assert.equal(ui.activate(), true); assert.equal(a.hits, 1);
  const away = make(eyeCamera(0, 1.6, 0, Math.PI)); away.ui.register(item());
  assert.equal(away.ui.activate(), false, 'turned the other way, so the click falls through to the torch');
});

test('a label can change under the player and the prompt follows; unregistering removes the item', () => {
  const { ui, el } = make(); let hands = false;
  const off = ui.register(item({ label: () => hands ? 'Hands full' : 'Left click to pick up' }));
  ui.update(); assert.equal(el.textContent, 'Left click to pick up');
  hands = true; ui.update(); assert.equal(el.textContent, 'Hands full');
  off(); ui.update(); assert.equal(ui.focused, undefined); assert.equal(el.style.opacity, '0');
  ui.register(item()); ui.unregister('x'); ui.update(); assert.equal(ui.focused, undefined);
});

test('an item that disappears when used is no longer offered straight away', () => {
  const { ui, el } = make(); let there = true;
  ui.register(item({ enabled: () => there, activate() { there = false; } }));
  ui.update(); assert.equal(el.style.opacity, '1');
  assert.equal(ui.activate(), true);
  assert.equal(el.style.opacity, '0'); assert.equal(ui.activate(), false);
});

test('a key-only thing (a door) is worked by the interact key, never by a click, and its prompt names the key', () => {
  const { ui, el } = make(eyeCamera(), [], { touch: false, keyLabel: () => 'E' });
  const door = item({ id: 'door', label: 'Left click to open', keyOnly: true });
  ui.register(door); ui.update();
  assert.equal(el.textContent, 'E to open', 'the prompt says which key');
  assert.equal(ui.activate(), false, 'a click does nothing to it, so the click can go to the torch');
  assert.equal(door.hits ?? 0, 0);
  assert.equal(ui.activate(true), true, 'the key works it');
  assert.equal(door.hits, 1);
  // A rebound key is named as bound; a pickup beside it still says and takes a click.
  const rebound = make(eyeCamera(), [], { touch: false, keyLabel: () => 'F' });
  rebound.ui.register(item({ id: 'door', label: 'Left click to close', keyOnly: true })); rebound.ui.update();
  assert.equal(rebound.el.textContent, 'F to close');
  const pickup = make(eyeCamera(), [], { touch: false, keyLabel: () => 'E' });
  const torch = item(); pickup.ui.register(torch); pickup.ui.update();
  assert.equal(pickup.el.textContent, 'Left click to pick up'); assert.equal(pickup.ui.activate(), true); assert.equal(torch.hits, 1);
  // On a touch screen there is no key: a tap works the door and the prompt says so.
  const phone = make(eyeCamera(), [], { touch: true });
  const leaf = item({ id: 'door', label: 'Left click to open', keyOnly: true }); phone.ui.register(leaf); phone.ui.update();
  assert.equal(phone.el.textContent, 'Tap to open'); assert.equal(phone.ui.activate(), true); assert.equal(leaf.hits, 1);
  assert.equal(promptText('Left click to open', false, 'E'), 'E to open'); assert.equal(promptText('Hands full', false, 'E'), 'Hands full');
});
