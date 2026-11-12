import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { initialState, applyAction, heldKind, FUSE_SLOTS } = await import('../../../game/sim/objectives/objectives.ts');
const { objectiveText } = await import('../../../game/sim/objectives/objective-text.ts');

const me = 'p1';
const run = (state, ...actions) => actions.reduce((s, a) => applyAction(s, a).state, state);
const text = state => objectiveText(state, heldKind(state, me));
const pickup = item => ({ type: 'pickup', player: me, item });
const fuel = [pickup('jerry-camp'), { type: 'refuel', player: me }];
const start = { type: 'pull-start', player: me };
const insert = (item, slot) => [pickup(item), { type: 'insert-fuse', player: me, slot }];

test('every phase has a plain one-line title, and none of it shouts', () => {
  const states = {
    gather: initialState(),
    fueled: run(initialState(), ...fuel),
    running: run(initialState(), ...fuel, start),
    powered: run(initialState(), ...fuel, start, ...insert('fuse-mine', 0), ...insert('fuse-lookout', 1), ...insert('fuse-logstack', 2)),
  };
  states.signalSent = run(states.powered, { type: 'transmit', player: me });
  assert.deepEqual(Object.keys(states).map(k => states[k].phase), ['gather', 'fueled', 'running', 'powered', 'signalSent']);
  const titles = new Set();
  for (const [phase, state] of Object.entries(states)) for (const held of [undefined, 'fuse', 'jerry']) {
    const t = objectiveText(state, held);
    assert.ok(typeof t.title === 'string' && t.title.length > 3 && t.title.length <= 40, `${phase}/${held}: "${t.title}"`);
    assert.ok(t.detail === undefined || (typeof t.detail === 'string' && t.detail.length > 0), `${phase}/${held} detail`);
    assert.doesNotMatch(`${t.title} ${t.detail ?? ''}`, /[!?]|\.\.\./, 'no exclamation marks, no drama');
    assert.ok(/^[A-Z]/.test(t.title), 'a sentence, capitalised');
    titles.add(t.title);
  }
  assert.ok(titles.size >= 6, 'each step says something of its own');
});

test('the wording follows the real loop: fuel, start, fuses to the hut, send the signal', () => {
  const at = (...actions) => text(run(initialState(), ...actions));
  assert.equal(at().title, 'Find fuel for the generator');
  assert.equal(at(pickup('jerry-camp')).title, 'Take the fuel to the generator');
  assert.equal(at(...fuel).title, 'Start the generator');
  assert.equal(at(...fuel, start).title, 'Find three fuses for the relay hut');
  assert.equal(at(...fuel, start, pickup('fuse-mine')).title, 'Take the fuse to the relay hut');
  assert.equal(at(...fuel, start, ...insert('fuse-mine', 0)).title, 'Find two more fuses for the relay hut');
  assert.equal(at(...fuel, start, ...insert('fuse-mine', 0), ...insert('fuse-lookout', 1)).title, 'Find the last fuse for the relay hut');
  assert.equal(at(...fuel, start, ...insert('fuse-mine', 0), ...insert('fuse-lookout', 1), ...insert('fuse-logstack', 2)).title, 'Send the signal from the relay hut');
  assert.equal(at(...fuel, start, ...insert('fuse-mine', 0), ...insert('fuse-lookout', 1), ...insert('fuse-logstack', 2), { type: 'transmit', player: me }).title, 'The signal is sent');
});

test('the detail counts the fuses that are in the box, not the ones that are carried', () => {
  assert.equal(FUSE_SLOTS, 3);
  let s = run(initialState(), ...fuel, start);
  assert.equal(text(s).detail, 'Fuses 0/3');
  s = run(s, pickup('fuse-mine'));
  assert.equal(text(s).detail, 'Fuses 0/3', 'in hand is not in the box');
  s = run(s, { type: 'insert-fuse', player: me, slot: 0 });
  assert.equal(text(s).detail, 'Fuses 1/3');
  s = run(s, ...insert('fuse-lookout', 1));
  assert.equal(text(s).detail, 'Fuses 2/3');
  s = run(s, ...insert('fuse-logstack', 2));
  assert.equal(text(s).detail, 'Fuses 3/3');
  assert.equal(text(run(s, { type: 'transmit', player: me })).detail, 'Stay out of sight');
  // Progress is shown from the first step, so the three fuses are never a surprise.
  assert.equal(text(initialState()).detail, 'Fuses 0/3');
  assert.equal(text(run(initialState(), ...fuel)).detail, 'Fuses 0/3');
});

test('a fuse in hand before there is fuel says why the can cannot be lifted, naming the drop key when there is one', () => {
  const s = run(initialState(), pickup('fuse-mine'));
  assert.equal(heldKind(s, me), 'fuse');
  assert.equal(objectiveText(s, 'fuse', { dropKey: 'Q' }).title, 'Find fuel for the generator');
  assert.equal(objectiveText(s, 'fuse', { dropKey: 'Q' }).detail, 'Your hands are full: put the fuse down (Q)');
  assert.equal(objectiveText(s, 'fuse').detail, 'Your hands are full: put the fuse down', 'touch has a Drop button instead of a key');
  // Once there is fuel the fuse is not in the way: the cord needs no free hand.
  assert.equal(objectiveText(run(initialState(), ...fuel, pickup('fuse-mine')), 'fuse').detail, 'Fuses 0/3');
});

test('it is a pure function of its arguments', () => {
  const s = run(initialState(), ...fuel, start);
  const frozen = JSON.stringify(s);
  assert.deepEqual(objectiveText(s, undefined), objectiveText(s, undefined));
  assert.equal(JSON.stringify(s), frozen);
  assert.deepEqual(objectiveText({ ...initialState(), phase: 'nonsense' }), objectiveText(initialState()), 'an unknown phase falls back to the first step rather than to nothing');
});
