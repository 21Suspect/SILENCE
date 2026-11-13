import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyAction, replay, heldItem, firstEmptySlot, insertedFuses, hasPack, carries, hasRoom, PACK_SLOTS } from '../../../game/sim/objectives/objectives.ts';

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

test('the world starts with three fuses, one jerry can and a backpack in the cabin, all lying at their places', () => {
  const s = initialState();
  assert.deepEqual(Object.entries(s.items).map(([id, i]) => [id, i.kind, i.poi, i.status]), [
    ['fuse-mine', 'fuse', 'mine', 'world'], ['fuse-lookout', 'fuse', 'lookout', 'world'],
    ['fuse-logstack', 'fuse', 'logstack', 'world'], ['jerry-camp', 'jerry', 'camp', 'world'],
    ['backpack-cabin', 'backpack', 'cabin', 'world'],
  ]);
  assert.deepEqual(s.packs, {}, 'nobody starts with a backpack');
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
  assert.ok(Object.values(s.items).filter(i => i.kind !== 'backpack').every(i => i.status === 'used'));
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

// --- the backpack ------------------------------------------------------------------------------------------------------

const withPack = (...actions) => run(initialState(), { type: 'pickup', player: me, item: 'backpack-cabin' }, ...actions);
/** A world with extra fuses lying about, to fill a pack. */
const crowded = n => {
  const s = initialState();
  for (let i = 0; i < n; i++) s.items[`fuse-extra-${i}`] = { kind: 'fuse', poi: 'mine', status: 'world' };
  return s;
};

test('the backpack is worn, not carried: it gives an empty pack of twelve and leaves the hand free', () => {
  const { state: s, events } = withPack();
  assert.equal(s.items['backpack-cabin'].status, 'worn');
  assert.equal(s.items['backpack-cabin'].holder, me);
  assert.ok(hasPack(s, me));
  assert.equal(PACK_SLOTS, 12);
  assert.deepEqual(s.packs[me], Array(12).fill(null));
  assert.equal(heldItem(s, me), undefined, 'the hand is still empty');
  assert.equal(events[0].type, 'picked-up');
  assert.equal(events[1].type, 'noise');
  assert.ok(!hasPack(s, you));
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'state is still plain JSON');
});

test('with a backpack the hand fills first, then the pack slot by slot; without one a full hand refuses', () => {
  const without = run(initialState(), { type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'pickup', player: me, item: 'fuse-lookout' });
  assert.equal(without.events.at(-1).reason, 'hands-full');
  const { state: s, events } = withPack({ type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'pickup', player: me, item: 'fuse-lookout' }, { type: 'pickup', player: me, item: 'jerry-camp' });
  assert.equal(heldItem(s, me), 'fuse-mine');
  assert.deepEqual(s.packs[me].slice(0, 3), ['fuse-lookout', 'jerry-camp', null]);
  assert.equal(s.items['fuse-lookout'].status, 'packed');
  assert.deepEqual(events.filter(e => e.type === 'picked-up').map(e => e.to), [undefined, 'hand', 0, 1]);
});

test('a full pack and a full hand refuse a thirteenth pickup', () => {
  let s = run(crowded(14), { type: 'pickup', player: me, item: 'backpack-cabin' }).state;
  for (let i = 0; i < 13; i++) s = applyAction(s, { type: 'pickup', player: me, item: `fuse-extra-${i}` }).state;
  assert.ok(!hasRoom(s, me));
  const r = applyAction(s, { type: 'pickup', player: me, item: 'fuse-extra-13' });
  assert.equal(r.state, s);
  assert.equal(r.events[0].reason, 'hands-full');
});

test('moving swaps between the hand and any slot, and between slots', () => {
  let { state: s } = withPack({ type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'pickup', player: me, item: 'jerry-camp' });
  // hand: fuse, slot 0: jerry
  s = applyAction(s, { type: 'move', player: me, from: 0, to: 'hand' }).state;
  assert.equal(heldItem(s, me), 'jerry-camp');
  assert.equal(s.packs[me][0], 'fuse-mine');
  assert.equal(s.items['jerry-camp'].status, 'held');
  assert.equal(s.items['fuse-mine'].status, 'packed');
  s = applyAction(s, { type: 'move', player: me, from: 0, to: 11 }).state;
  assert.deepEqual([s.packs[me][0], s.packs[me][11]], [null, 'fuse-mine']);
  s = applyAction(s, { type: 'move', player: me, from: 'hand', to: 5 }).state;
  assert.equal(heldItem(s, me), undefined, 'moving into an empty slot empties the hand');
  assert.equal(s.packs[me][5], 'jerry-camp');
  const event = applyAction(s, { type: 'move', player: me, from: 5, to: 6 }).events[0];
  assert.deepEqual(event, { type: 'moved', player: me, from: 5, to: 6 });
});

test('moves that make no sense are refused and change nothing', () => {
  const plain = run(initialState(), { type: 'pickup', player: me, item: 'fuse-mine' }).state;
  assert.equal(applyAction(plain, { type: 'move', player: me, from: 'hand', to: 0 }).events[0].reason, 'no-pack');
  const { state: s } = withPack();
  for (const [from, to, reason] of [[0, 1, 'empty-slot'], ['hand', 2, 'empty-slot'], [0, 12, 'bad-slot'], [-1, 0, 'bad-slot'], [3, 3, 'bad-slot'], [1.5, 0, 'bad-slot']]) {
    const r = applyAction(s, { type: 'move', player: me, from, to });
    assert.equal(r.state, s);
    assert.equal(r.events[0].reason, reason, `${from} -> ${to}`);
  }
});

test('dropping from a pack slot puts that item on the ground and frees the slot; the hand is untouched', () => {
  const at = { x: 3, z: -4, y: .4 };
  let { state: s } = withPack({ type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'pickup', player: me, item: 'jerry-camp' });
  const r = applyAction(s, { type: 'drop', player: me, slot: 0, at });
  s = r.state;
  assert.equal(s.packs[me][0], null);
  assert.equal(s.items['jerry-camp'].status, 'world');
  assert.deepEqual(s.items['jerry-camp'].at, at);
  assert.equal(heldItem(s, me), 'fuse-mine');
  assert.deepEqual(r.events.map(e => e.type), ['dropped', 'noise']);
  assert.equal(applyAction(s, { type: 'drop', player: me, slot: 0 }).events[0].reason, 'empty-slot');
  assert.equal(applyAction(initialState(), { type: 'drop', player: me, slot: 0 }).events[0].reason, 'no-pack');
});

test('the generator and the fuse box take what they need from the pack when the hand holds something else', () => {
  let { state: s } = withPack({ type: 'pickup', player: me, item: 'fuse-mine' }, { type: 'pickup', player: me, item: 'jerry-camp' });
  assert.ok(carries(s, me, 'jerry'));
  s = applyAction(s, { type: 'refuel', player: me }).state;
  assert.ok(s.generator.fuel);
  assert.equal(heldItem(s, me), 'fuse-mine', 'the fuse stays in hand');
  assert.equal(s.packs[me][0], null);
  s = run(s, { type: 'pull-start', player: me }, { type: 'move', player: me, from: 'hand', to: 7 }).state;
  assert.equal(heldItem(s, me), undefined);
  s = applyAction(s, { type: 'insert-fuse', player: me, slot: 0 }).state;
  assert.equal(insertedFuses(s), 1);
  assert.equal(s.packs[me][7], null);
  assert.equal(applyAction(s, { type: 'insert-fuse', player: me, slot: 1 }).events[0].reason, 'wrong-item');
});
