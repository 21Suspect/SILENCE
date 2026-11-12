import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyAction, replay, heldItem, firstEmptySlot, insertedFuses } from '../../../game/sim/objectives/objectives.ts';

const me = 'p1', you = 'p2';
const run = (state, ...actions) => replay(actions, state);
const winning = [
  { type: 'pickup', player: me, item: 'jerry-camp' },
  { type: 'refuel', player: me },
  { type: 'pull-start', player: me },
  ...['fuse-mine', 'fuse-lookout', 'fuse-logstack'].flatMap((item, slot) => [
    { type: 'pickup', player: me, item }, { type: 'insert-fuse', player: me, slot },
  ]),
  { type: 'transmit', player: me },
];

test('the world starts with three fuses and one jerry can, all lying at their places', () => {
  const s = initialState();
  assert.deepEqual(Object.entries(s.items).map(([id, i]) => [id, i.kind, i.poi, i.status]), [
    ['fuse-mine', 'fuse', 'mine', 'world'], ['fuse-lookout', 'fuse', 'lookout', 'world'],
    ['fuse-logstack', 'fuse', 'logstack', 'world'], ['jerry-camp', 'jerry', 'camp', 'world'],
  ]);
  assert.equal(s.phase, 'gather');
  assert.deepEqual(s.fuseBox, [null, null, null]);
  assert.notEqual(initialState().items, s.items, 'every call returns a fresh object');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'state is plain JSON');
});

test('the full loop ends in signalSent, and each step moves the phase on', () => {
  let s = initialState(); const phases = [];
  for (const action of winning) { s = applyAction(s, action).state; phases.push(s.phase); }
  assert.deepEqual(phases, ['gather', 'fueled', 'running', 'running', 'running', 'running', 'running', 'running', 'powered', 'signalSent']);
  assert.equal(s.signalBy, me);
  assert.deepEqual(s.carrying, {});
  assert.ok(Object.values(s.items).every(i => i.status === 'used'));
  assert.equal(insertedFuses(s), 3);
});

test('reducing never mutates the previous state', () => {
  let s = initialState();
  for (const action of winning) {
    const before = structuredClone(s), r = applyAction(s, action);
    assert.deepEqual(s, before);
    assert.notEqual(r.state, s);
    s = r.state;
  }
});

test('a player carries one thing; picking up a second is refused, nothing is dropped for them', () => {
  const s1 = applyAction(initialState(), { type: 'pickup', player: me, item: 'fuse-mine' }).state;
  const r = applyAction(s1, { type: 'pickup', player: me, item: 'jerry-camp' });
  assert.equal(r.state, s1, 'a refusal returns the same state object');
  assert.deepEqual(r.events, [{ type: 'refused', action: 'pickup', player: me, reason: 'hands-full' }]);
  assert.equal(heldItem(s1, me), 'fuse-mine');
  assert.equal(s1.items['jerry-camp'].status, 'world');
  // The held item is gone for everyone else.
  const other = applyAction(s1, { type: 'pickup', player: you, item: 'fuse-mine' });
  assert.equal(other.events[0].reason, 'unavailable');
});

test('dropping puts the item back so a wrong first pick cannot soft-lock the run', () => {
  let s = run(initialState(), { type: 'pickup', player: me, item: 'fuse-mine' }).state;
  assert.equal(applyAction(s, { type: 'pickup', player: me, item: 'jerry-camp' }).events[0].reason, 'hands-full');
  const dropped = applyAction(s, { type: 'drop', player: me, at: { x: 3, z: -4 } });
  s = dropped.state;
  assert.deepEqual(s.items['fuse-mine'], { kind: 'fuse', poi: 'mine', status: 'world', at: { x: 3, z: -4 } });
  assert.equal(heldItem(s, me), undefined);
  assert.deepEqual(dropped.events.find(e => e.type === 'noise'), { type: 'noise', loudness: .12, source: 'drop', x: 3, z: -4 });
  assert.equal(applyAction(s, { type: 'pickup', player: me, item: 'jerry-camp' }).events[0].type, 'picked-up');
  // Picking it up again clears the drop spot; dropping without a place sends it home.
  s = run(s, { type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'drop', player: me }).state;
  assert.equal('at' in s.items['fuse-mine'], false);
  assert.equal(applyAction(s, { type: 'drop', player: me }).events[0].reason, 'empty-hands');
});

test('a drop remembers the height it was made at, so a fuse set down on a cabin floor stays on it', () => {
  const held = run(initialState(), { type: 'pickup', player: me, item: 'fuse-mine' }).state;
  const r = applyAction(held, { type: 'drop', player: me, at: { x: 1, z: 2, y: .42 } });
  assert.deepEqual(r.state.items['fuse-mine'].at, { x: 1, z: 2, y: .42 });
  assert.deepEqual(r.events[1], { type: 'noise', loudness: .12, source: 'drop', x: 1, z: 2 });
  assert.deepEqual(applyAction(held, { type: 'drop', player: me, at: { x: 1, z: 2, y: 'up' } }).state.items['fuse-mine'].at, { x: 1, z: 2 }, 'junk heights are ignored');
});

test('fuel is required before the pull, the pull before the fuse box, power before transmitting', () => {
  const s0 = initialState(), reason = (s, action) => applyAction(s, action).events[0].reason;
  assert.equal(reason(s0, { type: 'refuel', player: me }), 'wrong-item');
  assert.equal(reason(s0, { type: 'pull-start', player: me }), 'no-fuel');
  assert.equal(reason(s0, { type: 'transmit', player: me }), 'no-power');
  const withFuse = run(s0, { type: 'pickup', player: me, item: 'fuse-mine' }).state;
  assert.equal(reason(withFuse, { type: 'insert-fuse', player: me, slot: 0 }), 'no-power', 'a dead generator powers nothing');
  assert.equal(reason(withFuse, { type: 'refuel', player: me }), 'wrong-item', 'a fuse is not fuel');

  const fueled = run(s0, winning[0], winning[1]).state;
  assert.equal(fueled.phase, 'fueled');
  assert.equal(reason(fueled, { type: 'pull-start', player: me }), undefined, 'now it starts');
  const jerry2 = structuredClone(fueled); jerry2.items['fuse-mine'].kind = 'jerry'; // a second can must not refuel a full tank
  assert.equal(reason(run(jerry2, { type: 'pickup', player: me, item: 'fuse-mine' }).state, { type: 'refuel', player: me }), 'already-fueled');

  const running = run(fueled, winning[2]).state;
  assert.equal(reason(running, { type: 'pull-start', player: me }), 'already-running');
  assert.equal(reason(running, { type: 'transmit', player: me }), 'not-ready', 'running, but the box is empty');
  const oneFuse = run(running, { type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'insert-fuse', player: me, slot: 1 }).state;
  assert.equal(reason(oneFuse, { type: 'transmit', player: me }), 'not-ready');
  assert.equal(firstEmptySlot(oneFuse), 0);
});

test('fuse slots reject bad, repeated and wrong-item insertions', () => {
  const ready = run(initialState(), ...winning.slice(0, 3)).state;
  const hold = run(ready, { type: 'pickup', player: me, item: 'fuse-lookout' }).state;
  for (const slot of [-1, 3, 1.5, NaN, '0', undefined]) assert.equal(applyAction(hold, { type: 'insert-fuse', player: me, slot }).events[0].reason, 'bad-slot');
  const in0 = run(hold, { type: 'insert-fuse', player: me, slot: 0 }).state;
  const again = run(in0, { type: 'pickup', player: me, item: 'fuse-mine' }).state;
  assert.equal(applyAction(again, { type: 'insert-fuse', player: me, slot: 0 }).events[0].reason, 'slot-taken');
  assert.equal(applyAction(run(ready, { type: 'pickup', player: me, item: 'jerry-camp' }).state, { type: 'insert-fuse', player: me, slot: 0 }).events[0].reason, 'wrong-item');
  assert.equal(applyAction(ready, { type: 'insert-fuse', player: me, slot: 0 }).events[0].reason, 'wrong-item', 'empty hands');
});

test('events: pull-start is loud, power-restored fires once, everything is JSON and in range', () => {
  const { events, state } = replay(winning);
  const byType = type => events.filter(e => e.type === type);
  assert.equal(byType('generator-started').length, 1);
  assert.equal(byType('power-restored').length, 1);
  assert.equal(byType('signal-sent').length, 1);
  assert.deepEqual(byType('fuse-inserted').map(e => e.inserted), [1, 2, 3]);
  const start = events.find(e => e.type === 'noise' && e.source === 'generator-start');
  assert.ok(start.loudness >= .9 && start.poi === 'generator');
  const noises = byType('noise');
  assert.ok(noises.length >= 8);
  for (const n of noises) assert.ok(n.loudness >= 0 && n.loudness <= 1 && typeof n.source === 'string');
  assert.ok(Math.max(...noises.filter(n => n.source !== 'generator-start').map(n => n.loudness)) < start.loudness, 'the generator is the loudest thing you can do');
  assert.deepEqual(JSON.parse(JSON.stringify(events)), events);
  assert.equal(state.phase, 'signalSent');
  // The objective is over: nothing else changes the world.
  assert.equal(applyAction(state, { type: 'drop', player: me }).events[0].reason, 'complete');
});

test('replaying recorded JSON gives the same state and events on any client', () => {
  const wire = JSON.stringify(winning);
  const a = replay(JSON.parse(wire)), b = replay(JSON.parse(wire));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'byte-identical, so a host can checksum it');
  // A late joiner can start from a snapshot and a suffix.
  const mid = replay(winning.slice(0, 5)), tail = replay(winning.slice(5), JSON.parse(JSON.stringify(mid.state)));
  assert.deepEqual(tail.state, a.state);
});

test('two players hold different things and cooperate on the same box', () => {
  const s = run(initialState(),
    { type: 'pickup', player: me, item: 'jerry-camp' }, { type: 'refuel', player: me }, { type: 'pull-start', player: me },
    { type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'pickup', player: you, item: 'fuse-lookout' },
    { type: 'insert-fuse', player: you, slot: 2 }, { type: 'insert-fuse', player: me, slot: 0 },
    { type: 'pickup', player: you, item: 'fuse-logstack' }, { type: 'insert-fuse', player: you, slot: 1 }).state;
  assert.equal(s.phase, 'powered');
  assert.deepEqual(s.fuseBox, ['fuse-mine', 'fuse-logstack', 'fuse-lookout']);
  assert.equal(applyAction(s, { type: 'transmit', player: you }).state.signalBy, you);
});

test('malformed actions are refused, never thrown', () => {
  const s = initialState();
  for (const junk of [null, undefined, {}, { type: 'nope', player: me }, { type: 'pickup' }, { type: 'pickup', player: '', item: 'fuse-mine' },
    { type: 'pickup', player: me, item: 'toString' }, { type: 'pickup', player: me, item: 7 }, { type: 'drop', player: me, at: { x: 'a', z: 1 } }, 'pickup', 42]) {
    const r = applyAction(s, junk);
    assert.equal(r.state, s);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].type, 'refused');
  }
});
