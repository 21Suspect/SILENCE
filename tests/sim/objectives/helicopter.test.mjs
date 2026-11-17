import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const O = await import('../../../game/sim/objectives/objectives.ts');
const { NOISE } = await import('../../../game/sim/noise/noise-scale.ts');
const { objectiveText, boardLines } = await import('../../../game/sim/objectives/objective-text.ts');
const { initialState, legacyItems, applyAction, replay, isHeavy, canSprint, nextDawn, PAD_FUEL_HOURS, HELI_CIRCLE_HOURS, HELI_WAIT_HOURS } = O;

const me = 'p1', you = 'p2';
const run = (state, ...actions) => replay(actions, state).state;
const events = (state, ...actions) => replay(actions, state).events;
const world = () => ({
  ...legacyItems(),
  'pad-bulbs': { kind: 'bulbs', poi: 'chapel', status: 'world', part: 'pad-bulbs' },
  'pad-cable': { kind: 'cable', poi: 'well', status: 'world', part: 'pad-cable' },
  'pad-fuel': { kind: 'jerry', poi: 'ruin', status: 'world', part: 'pad-fuel' },
});
const pick = item => ({ type: 'pickup', player: me, item });
const t = hours => ({ type: 'time', hours });

/** The whole call, ending with a transmit at `hours` and the generator switched off again (it keeps what fuel is left). */
const callAt = (hours, state = initialState(world())) => run(state,
  ...['fuse-mine', 'fuse-lookout', 'fuse-logstack'].flatMap((item, slot) => [pick(item), { type: 'insert-fuse', player: me, slot }]),
  pick('jerry-camp'), { type: 'refuel', player: me }, { type: 'pull-start', player: me },
  { type: 'transmit', player: me, hours }, { type: 'stop-generator', player: me });
/** The pad, ready but not lit. */
const padReady = state => run(state,
  pick('pad-bulbs'), { type: 'pad-fit-bulbs', player: me }, pick('pad-cable'), { type: 'pad-lay-cable', player: me },
  pick('pad-fuel'), { type: 'pad-refuel', player: me });
const lights = { type: 'pad-lights', player: me };

test('heavy parts: a can is carried in the hands only, never in the pack, and not at a run', () => {
  assert.ok(isHeavy('jerry'));
  for (const k of ['fuse', 'bulbs', 'cable', 'backpack']) assert.ok(!isHeavy(k), k);
  const packed = run(initialState(world()), pick('backpack-cabin'));
  // A free hand takes it; a full hand refuses it even with room in the pack.
  const withFuse = run(packed, pick('fuse-mine'));
  const r = applyAction(withFuse, pick('jerry-camp'));
  assert.equal(r.state, withFuse);
  assert.equal(r.events[0].reason, 'hands-full');
  const small = applyAction(withFuse, pick('fuse-lookout'));
  assert.equal(small.state.packs[me][0], 'fuse-lookout', 'a small thing still goes in the pack');
  // The can cannot be moved into the pack either way round.
  const canned = run(packed, pick('jerry-camp'));
  assert.equal(applyAction(canned, { type: 'move', player: me, from: 'hand', to: 3 }).events[0].reason, 'too-heavy');
  assert.equal(canSprint(canned, me), false, 'walks while carrying a can');
  assert.equal(canSprint(packed, me), true);
  assert.equal(canSprint(run(packed, pick('fuse-mine')), me), true);
  assert.equal(canSprint(canned, you), true, 'only the carrier is slowed');
});

test('every noise sits on the scale', () => {
  const s0 = initialState(world());
  const noise = (state, action) => events(state, action).find(e => e.type === 'noise');
  assert.equal(noise(s0, pick('fuse-mine')).loudness, NOISE.pickupSmall);
  assert.equal(noise(s0, pick('jerry-camp')).loudness, NOISE.pickupHeavy);
  assert.equal(noise(s0, pick('backpack-cabin')).loudness, NOISE.pickupSmall);
  assert.equal(noise(run(s0, pick('fuse-mine')), { type: 'drop', player: me }).loudness, NOISE.dropSmall);
  assert.equal(noise(run(s0, pick('jerry-camp')), { type: 'drop', player: me }).loudness, NOISE.dropHeavy);
  const fueled = run(s0, pick('jerry-camp'), { type: 'refuel', player: me });
  assert.equal(events(s0, pick('jerry-camp'), { type: 'refuel', player: me }).at(-1).loudness, NOISE.refuel);
  assert.equal(noise(fueled, { type: 'pull-start', player: me }).loudness, NOISE.generator);
  const running = run(fueled, { type: 'pull-start', player: me });
  assert.equal(noise(run(running, pick('fuse-mine')), { type: 'insert-fuse', player: me, slot: 0 }).loudness, NOISE.fuseInsert);
  const justPowered = (() => { let s = running; for (const [slot, item] of ['fuse-mine', 'fuse-lookout', 'fuse-logstack'].entries()) s = run(s, pick(item), { type: 'insert-fuse', player: me, slot }); return s; })();
  assert.equal(noise(justPowered, { type: 'transmit', player: me }).loudness, NOISE.radio);
});

test('banking: a part put in a crate or the chest is out of the world and stays for the run', () => {
  const s0 = initialState(world());
  const held = run(s0, pick('pad-bulbs'));
  const r = applyAction(held, { type: 'deposit', player: me, bank: 'chest' });
  const s = r.state;
  assert.equal(s.items['pad-bulbs'].status, 'banked');
  assert.equal(s.items['pad-bulbs'].bank, 'chest');
  assert.equal(heldOf(s), undefined);
  assert.deepEqual(r.events.map(e => e.type), ['banked', 'noise']);
  assert.equal(r.events[1].loudness, NOISE.dropSmall);
  // Not in the world: nobody can pick it up; only the right bank gives it back.
  assert.equal(applyAction(s, pick('pad-bulbs')).events[0].reason, 'unavailable');
  assert.equal(applyAction(s, { type: 'withdraw', player: me, bank: 'pad', item: 'pad-bulbs' }).events[0].reason, 'unavailable');
  assert.equal(applyAction(s, { type: 'withdraw', player: you, bank: 'chest', item: 'pad-bulbs' }).state.carrying[you], 'pad-bulbs', 'any player may take it out');
  // It stays banked across time, a transmit, everything else.
  const later = run(s, t(30), t(50));
  assert.equal(later.items['pad-bulbs'].status, 'banked');
  // A can is withdrawn into the hands only.
  const canBanked = run(s0, pick('jerry-camp'), { type: 'deposit', player: me, bank: 'relay' });
  const packed = run(canBanked, pick('backpack-cabin'), pick('fuse-mine'));
  assert.equal(applyAction(packed, { type: 'withdraw', player: me, bank: 'relay', item: 'jerry-camp' }).events[0].reason, 'hands-full');
  assert.equal(applyAction(canBanked, { type: 'withdraw', player: me, bank: 'relay', item: 'jerry-camp' }).events[1].loudness, NOISE.pickupHeavy);
  // Bad input.
  assert.equal(applyAction(held, { type: 'deposit', player: me, bank: 'attic' }).events[0].reason, 'bad-bank');
  assert.equal(applyAction(s0, { type: 'deposit', player: me, bank: 'chest' }).events[0].reason, 'empty-hands');
  assert.equal(applyAction(s0, { type: 'withdraw', player: me, bank: 'chest', item: 'nope' }).events[0].reason, 'unknown-item');
  // Deposit from a pack slot.
  const inPack = run(s0, pick('backpack-cabin'), pick('fuse-mine'), pick('pad-cable'));
  const fromPack = applyAction(inPack, { type: 'deposit', player: me, bank: 'pad', slot: 0 }).state;
  assert.equal(fromPack.items['pad-cable'].bank, 'pad');
  assert.equal(fromPack.packs[me][0], null);
});
const heldOf = s => s.carrying[me];

test('the board names each part and its area, never the spot, and says what is banked or fitted', () => {
  const s0 = initialState(world());
  const lines = boardLines(s0);
  assert.deepEqual(lines, [
    '# For the call (relay hut)', 'Fuse 1: around the mine', 'Fuse 2: around the lookout', 'Fuse 3: around the logging camp', 'Fuel for the generator: around the camp',
    '# For the landing pad', 'Bulbs: around the chapel', 'Cable: around the well', 'Fuel for the pad lights: around the ruin',
  ]);
  assert.ok(lines.every(l => !/\d\d|\d\.\d/.test(l)), 'no coordinates on the board (only the fuse numbers)');
  const placed = { ...world(), 'pad-bulbs': { kind: 'bulbs', poi: 'chapel', status: 'world', part: 'pad-bulbs', poiId: 'chapel', at: { x: 301.2, z: 238.9 } } };
  assert.ok(boardLines(initialState(placed)).includes('Bulbs: around the chapel'), 'the ground spot stays off the board');
  let s = run(s0, pick('pad-bulbs'));
  assert.ok(boardLines(s).includes('Bulbs: carried'));
  s = run(s, { type: 'deposit', player: me, bank: 'chest' });
  assert.ok(boardLines(s).includes('Bulbs: banked in the chest at the cabin'));
  s = run(s, { type: 'withdraw', player: me, bank: 'chest', item: 'pad-bulbs' }, { type: 'pad-fit-bulbs', player: me });
  assert.ok(boardLines(s).includes('Bulbs: fitted'));
  assert.deepEqual(boardLines(initialState({ 'backpack-cabin': { kind: 'backpack', poi: 'cabin', status: 'world' } })), [], 'the backpack is not a part');
});

test('the call schedules the helicopter for the next dawn', () => {
  assert.equal(nextDawn(0), 6);
  assert.equal(nextDawn(5.99), 6);
  assert.equal(nextDawn(6), 30, 'at dawn itself the next one is tomorrow');
  assert.equal(nextDawn(21), 30);
  assert.equal(nextDawn(30.5), 54);
  const s = callAt(21);
  assert.equal(s.phase, 'signalSent');
  assert.deepEqual(s.helicopter, { status: 'inbound', arrives: 30, until: null, calls: 1 });
  assert.equal(s.clock, 21);
  // Without hours it uses the last time the host gave.
  const late = callAt(undefined, run(initialState(world()), t(40)));
  assert.equal(late.helicopter.arrives, 54);
  assert.equal(applyAction(initialState(world()), t(-1)).state.clock, 0);
  assert.equal(applyAction(run(initialState(world()), t(5)), t(4)).events[0].reason, 'bad-time');
  assert.equal(applyAction(initialState(world()), t(NaN)).events[0].reason, 'bad-time');
});

test('the pad: bulbs, cable and fuel, and the lights cannot go on without all three', () => {
  let s = initialState(world());
  const reason = (state, action) => applyAction(state, action).events[0].reason;
  assert.equal(reason(s, lights), 'no-bulbs');
  assert.equal(reason(s, { type: 'pad-fit-bulbs', player: me }), 'wrong-item');
  s = run(s, pick('pad-bulbs'), { type: 'pad-fit-bulbs', player: me });
  assert.ok(s.pad.bulbs);
  assert.equal(s.items['pad-bulbs'].status, 'used');
  assert.equal(reason(s, lights), 'no-cable');
  s = run(s, pick('pad-cable'), { type: 'pad-lay-cable', player: me });
  assert.equal(reason(s, lights), 'no-fuel');
  assert.equal(reason(run(s, pick('pad-cable')), { type: 'pad-lay-cable', player: me }), 'wrong-item');
  s = run(s, pick('pad-fuel'));
  assert.equal(reason(s, { type: 'pad-fit-bulbs', player: me }), 'wrong-item');
  const r = applyAction(s, { type: 'pad-refuel', player: me });
  assert.equal(r.state.pad.fuel, PAD_FUEL_HOURS);
  assert.equal(r.events[1].loudness, NOISE.refuel);
  s = r.state;
  assert.equal(PAD_FUEL_HOURS, 1.5, 'ninety game minutes a can');
  const on = applyAction(s, lights);
  assert.ok(on.state.pad.lit);
  assert.equal(on.events.find(e => e.type === 'noise').loudness, NOISE.generator, 'a generator starting is heard at 150 m');
  assert.equal(reason(on.state, lights), 'already-lit');
  assert.equal(reason(s, { ...lights, on: false }), 'not-lit');
  assert.equal(applyAction(on.state, { ...lights, on: false }).state.pad.lit, false);
  // Already fitted parts are refused, and the relay's generator takes a can, never the pad's.
  assert.equal(reason(run(s, pick('jerry-camp')), { type: 'pad-refuel', player: me }), 'already-fueled');
});

test('pad fuel burns only while the lights are on, and the lights go out when it is gone', () => {
  let s = padReady(initialState(world()));
  s = run(s, t(10));
  assert.equal(s.pad.fuel, PAD_FUEL_HOURS, 'unlit, it keeps');
  s = run(s, lights, t(10.5));
  assert.ok(Math.abs(s.pad.fuel - 1) < 1e-9);
  const off = run(s, { ...lights, on: false }, t(20));
  assert.ok(Math.abs(off.pad.fuel - 1) < 1e-9, 'switched off, it stops burning');
  const out = replay([t(11.4)], s);
  assert.ok(out.state.pad.lit);
  const done = replay([t(11.5)], s);
  assert.equal(done.state.pad.lit, false);
  assert.equal(done.state.pad.fuel, 0);
  assert.deepEqual(done.events.filter(e => e.type === 'pad-lights'), [{ type: 'pad-lights', on: false }]);
  // A big jump past the end still stops exactly there, with no negative fuel.
  const jump = run(s, t(100));
  assert.equal(jump.pad.fuel, 0);
  assert.equal(jump.clock, 100);
  // With no fuel left the lights will not come on again.
  assert.equal(applyAction(jump, lights).events[0].reason, 'no-fuel');
});

test('the whole helicopter chain to a win', () => {
  let s = callAt(20);
  const phases = [s.phase];
  assert.equal(s.helicopter.arrives, 30);
  s = padReady(s);
  // Dusk to dawn with the lights off: nothing happens and the helicopter is not yet here.
  let r = replay([t(25)], s);
  assert.equal(r.events.filter(e => e.type === 'noise').length, 0, 'before it comes there is only silence');
  s = r.state;
  assert.equal(objectiveText(s).title, 'Switch on the pad lights at dawn');
  // Lights on at 29:30, half an hour before it comes.
  s = run(s, t(29.5), lights);
  assert.equal(objectiveText(s).title, 'The pad is lit: wait for dawn');
  r = replay([t(30)], s);
  s = r.state;
  assert.equal(s.helicopter.status, 'landed');
  assert.ok(Math.abs(s.helicopter.until - (30 + HELI_WAIT_HOURS)) < 1e-9);
  assert.deepEqual(r.events.filter(e => e.type === 'helicopter-landed').length, 1);
  const island = r.events.filter(e => e.type === 'noise' && e.source === 'helicopter');
  assert.equal(island.length, 1);
  assert.equal(island[0].loudness, NOISE.island);
  assert.ok(island[0].sustained);
  assert.ok(r.events.some(e => e.type === 'noise' && e.source === 'pad-generator' && e.loudness === NOISE.generator && e.sustained));
  assert.equal(objectiveText(s).title, 'Get to the helicopter');
  // It keeps being heard every tick while it waits.
  r = replay([t(30.05)], s);
  assert.ok(r.events.some(e => e.type === 'noise' && e.source === 'helicopter'));
  s = r.state;
  const board = applyAction(s, { type: 'board', player: you });
  assert.equal(board.state.phase, 'escaped');
  assert.deepEqual(board.events, [{ type: 'escaped', player: you }]);
  assert.equal(objectiveText(board.state).title, 'You are away');
  assert.equal(applyAction(board.state, t(31)).state, board.state, 'the clock stops mattering');
  assert.equal(applyAction(board.state, pick('jerry-camp')).events[0].reason, 'complete');
  phases.push(board.state.phase);
  assert.deepEqual(phases, ['signalSent', 'escaped']);
});

test('boarding needs the helicopter on the pad', () => {
  const called = callAt(0);
  assert.equal(applyAction(called, { type: 'board', player: me }).events[0].reason, 'no-helicopter');
  assert.equal(applyAction(initialState(world()), { type: 'board', player: me }).events[0].reason, 'no-helicopter');
});

test('a dark pad: it circles for fifteen minutes and lands as soon as the lights come on', () => {
  let s = padReady(callAt(0));
  assert.equal(HELI_CIRCLE_HOURS, .25);
  let r = replay([t(6)], s);
  s = r.state;
  assert.equal(s.helicopter.status, 'circling');
  assert.equal(s.helicopter.until, 6.25);
  assert.ok(r.events.some(e => e.type === 'helicopter-circling'));
  const noise = r.events.find(e => e.type === 'noise' && e.source === 'helicopter');
  assert.deepEqual([noise.loudness, noise.sustained], [NOISE.island, true], 'the helicopter is the noise, kept up while it circles');
  assert.equal(objectiveText(s).title, 'Light the landing pad now');
  assert.equal(applyAction(s, { type: 'board', player: me }).events[0].reason, 'no-helicopter');
  s = run(s, t(6.2));
  assert.equal(s.helicopter.status, 'circling');
  r = replay([lights], s);
  assert.equal(r.state.helicopter.status, 'landed', 'it sees the lights and comes down');
  assert.ok(Math.abs(r.state.helicopter.until - (6.2 + HELI_WAIT_HOURS)) < 1e-9);
  assert.equal(replay([{ type: 'board', player: me }], r.state).state.phase, 'escaped');
});

test('a pad left dark: it leaves, and the call has to be made again', () => {
  let s = callAt(0);
  const r = replay([t(6), t(7)], s);
  s = r.state;
  assert.equal(s.helicopter.status, 'gone');
  assert.deepEqual(r.events.filter(e => e.type === 'helicopter-left'), [{ type: 'helicopter-left', reason: 'no-pad' }]);
  // The cost: a day and a second radio call. The fuses stay fitted and the can has fuel left, so it is a restart and one loud transmit.
  assert.equal(s.phase, 'fueled');
  assert.equal(s.signalBy, null);
  assert.equal(objectiveText(s).title, 'Start the generator at the relay hut');
  s = run(s, { type: 'pull-start', player: me });
  assert.equal(objectiveText(s).title, 'Send the signal again', 'a running generator and a full box: the radio only');
  const again = applyAction(s, { type: 'transmit', player: me, hours: 7 });
  assert.equal(again.state.helicopter.status, 'inbound');
  assert.equal(again.state.helicopter.arrives, 30, 'a missed dawn costs a whole day');
  assert.equal(again.state.helicopter.calls, 2);
  assert.ok(again.events.some(e => e.type === 'noise' && e.loudness === NOISE.radio));
  // After a miss the pad can still be readied and the second call answered.
  const win = run(padReady(again.state), t(29.8), lights, t(30), { type: 'board', player: me });
  assert.equal(win.phase, 'escaped');
});

test('it will not sit on a pad that goes dark, nor wait longer than ten minutes', () => {
  const lit = run(padReady(callAt(0)), t(5.9), lights);
  let s = run(lit, t(6));
  assert.equal(s.helicopter.status, 'landed');
  // The lights go out (switched off) while it waits: it lifts off at once.
  const dark = replay([{ ...lights, on: false }], s);
  assert.equal(dark.state.helicopter.status, 'gone');
  assert.deepEqual(dark.events.filter(e => e.type === 'helicopter-left'), [{ type: 'helicopter-left', reason: 'dark-pad' }]);
  assert.equal(dark.state.phase, 'fueled', 'the generator was switched off after the call');
  // Nobody boards in ten game minutes: it leaves.
  const waited = replay([t(6 + HELI_WAIT_HOURS)], s);
  assert.equal(waited.state.helicopter.status, 'gone');
  assert.deepEqual(waited.events.filter(e => e.type === 'helicopter-left'), [{ type: 'helicopter-left', reason: 'waited-out' }]);
  // Just before the end it still waits.
  assert.equal(run(s, t(6 + HELI_WAIT_HOURS - .001)).helicopter.status, 'landed');
});

test('pad fuel running out at the wrong moment: lit at dusk, dark at dawn, the helicopter circles then leaves', () => {
  const dusk = run(padReady(callAt(18)), t(19), lights);
  const dawn = run(dusk, t(30));
  assert.equal(dawn.pad.lit, false, 'ninety minutes of light were gone by midnight');
  assert.equal(dawn.helicopter.status, 'circling');
  assert.equal(run(dawn, t(31)).helicopter.status, 'gone');
});

test('a jump over the whole night resolves in order: out, arrive, circle, leave', () => {
  const r = replay([t(60)], run(padReady(callAt(0)), lights));
  const kinds = r.events.map(e => e.type).filter(t => t !== 'noise');
  assert.deepEqual(kinds, ['pad-lights', 'helicopter-circling', 'helicopter-left']);
  assert.equal(r.state.clock, 60);
});

test('the reducer stays pure with the new actions', () => {
  const s = padReady(callAt(0));
  const frozen = JSON.stringify(s);
  for (const a of [t(6), lights, { type: 'board', player: me }, { type: 'deposit', player: me, bank: 'chest' }, { type: 'pad-refuel', player: me }]) applyAction(s, a);
  assert.equal(JSON.stringify(s), frozen);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  // Replaying the same JSON gives the same bytes.
  const actions = [t(5), lights, t(6), { type: 'board', player: me }];
  assert.equal(JSON.stringify(replay(actions, s)), JSON.stringify(replay(JSON.parse(JSON.stringify(actions)), JSON.parse(JSON.stringify(s)))));
});
