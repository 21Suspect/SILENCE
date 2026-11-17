import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { initialState, applyAction, heldKind, guideKind, FUSE_SLOTS } = await import('../../../game/sim/objectives/objectives.ts');
const { objectiveText, boardLines, MAX_LINES, TICK } = await import('../../../game/sim/objectives/objective-text.ts');

const me = 'p1';
const run = (state, ...actions) => actions.reduce((s, a) => applyAction(s, a).state, state);
const text = state => objectiveText(state, guideKind(state, me));
const pickup = item => ({ type: 'pickup', player: me, item });
const fuel = [pickup('jerry-camp'), { type: 'refuel', player: me }];
const start = { type: 'pull-start', player: me };
const stop = { type: 'stop-generator', player: me };
const insert = (item, slot) => [pickup(item), { type: 'insert-fuse', player: me, slot }];
const allFuses = [...insert('fuse-mine', 0), ...insert('fuse-lookout', 1), ...insert('fuse-logstack', 2)];
/** The seven parts at named places, as a seeded run lays them. */
const parts = () => ({ ...initialState().items,
  'fuse-mine': { kind: 'fuse', poi: 'mine', status: 'world', part: 'call-fuse-1' }, 'fuse-lookout': { kind: 'fuse', poi: 'ruin', status: 'world', part: 'call-fuse-2' },
  'fuse-logstack': { kind: 'fuse', poi: 'logstack', status: 'world', part: 'call-fuse-3' }, 'jerry-camp': { kind: 'jerry', poi: 'camp', status: 'world', part: 'call-fuel' },
  'pad-bulbs': { kind: 'bulbs', poi: 'chapel', status: 'world', part: 'pad-bulbs' }, 'pad-cable': { kind: 'cable', poi: 'well', status: 'world', part: 'pad-cable' },
  'pad-fuel': { kind: 'jerry', poi: 'shrine', status: 'world', part: 'pad-fuel' } });
const seeded = () => initialState(parts());

test('every stage has a plain short title and at most four short lines, and none of it shouts', () => {
  const states = {
    gather: seeded(),
    fused: run(seeded(), ...allFuses),
    fueled: run(seeded(), ...allFuses, ...fuel),
    powered: run(seeded(), ...allFuses, ...fuel, start),
  };
  states.signalSent = run(states.powered, { type: 'transmit', player: me });
  const titles = new Set();
  for (const [stage, state] of Object.entries(states)) for (const held of [undefined, 'fuse', 'jerry', 'bulbs']) {
    const t = objectiveText(state, held);
    assert.ok(t.title.length > 3 && t.title.length <= 40, `${stage}/${held}: "${t.title}"`);
    assert.ok((t.lines ?? []).length <= MAX_LINES, `${stage}/${held} lines`);
    for (const line of t.lines ?? []) assert.ok(line.length <= 40, `${stage}/${held}: "${line}" is too long`);
    assert.doesNotMatch(`${t.title} ${t.detail ?? ''} ${(t.lines ?? []).join(' ')}`, /[!?]|\.\.\./, 'no exclamation marks, no drama');
    assert.ok(/^[A-Z]/.test(t.title), 'a sentence, capitalised');
    titles.add(t.title);
  }
  assert.ok(titles.size >= 6, 'each step says something of its own');
});

test('the order of play: fuses, fuel, start, transmit, then the pad', () => {
  const at = (...actions) => text(run(seeded(), ...actions));
  assert.equal(at().title, 'Find three fuses for the relay hut');
  assert.equal(at(pickup('fuse-mine')).title, 'Take the fuse to the relay hut');
  assert.equal(at(...insert('fuse-mine', 0)).title, 'Find two more fuses for the relay hut');
  assert.equal(at(...insert('fuse-mine', 0), ...insert('fuse-lookout', 1)).title, 'Find the last fuse for the relay hut');
  assert.equal(at(...allFuses).title, 'Find fuel for the generator');
  assert.equal(at(...allFuses, pickup('jerry-camp')).title, 'Take the fuel to the generator');
  assert.equal(at(...allFuses, ...fuel).title, 'Start the generator at the relay hut');
  assert.equal(at(...allFuses, ...fuel, start).title, 'Send the signal from the relay hut');
  assert.equal(at(...allFuses, ...fuel, start, { type: 'transmit', player: me }).title, 'Find bulbs, cable and fuel for the pad');
  // The generator may be fuelled and started first: the fuse stage still comes first.
  assert.equal(at(...fuel, start).title, 'Find three fuses for the relay hut');
  assert.equal(at(...fuel, start, ...allFuses).title, 'Send the signal from the relay hut');
  assert.equal(at(...fuel, start, ...allFuses, stop).title, 'Start the generator at the relay hut', 'switched off with fuel left');
});

test('the checklist names each fuse, ticks what is fitted and says where the rest is', () => {
  assert.equal(FUSE_SLOTS, 3);
  let s = seeded();
  assert.deepEqual(text(s).lines, ['Fuse 1: around the mine', 'Fuse 2: around the ruin', 'Fuse 3: around the logging camp', 'Fuel: around the camp']);
  s = run(s, pickup('fuse-mine'));
  assert.equal(text(s).lines[0], 'Fuse 1: in hand');
  s = run(s, { type: 'insert-fuse', player: me, slot: 0 });
  assert.equal(text(s).lines[0], `${TICK}Fuse 1: fitted`);
  // A pack and a bank: carried reads "in your pack", banked says where, and counts as found.
  s = run(s, pickup('backpack-cabin'), pickup('fuse-lookout'), pickup('fuse-logstack'));
  assert.equal(text(s).lines[2], 'Fuse 3: in your pack');
  s = run(s, { type: 'deposit', player: me, bank: 'relay' });
  assert.equal(text(s).lines[1], 'Fuse 2: banked at the relay hut');
  s = run(s, { type: 'deposit', player: me, bank: 'chest', slot: 0 });
  assert.equal(text(s).lines[2], 'Fuse 3: banked at the cabin');
  assert.equal(text(run(s, { type: 'deposit', player: me, bank: 'pad' })).lines.length, 4);
  // A dropped fuse reads as the place it lies in now.
  const dropped = run(seeded(), pickup('fuse-mine'), { type: 'drop', player: me, at: { x: 0, z: 0 } });
  assert.match(text(dropped).lines[0], /^Fuse 1: around /);
});

test('the generator line shows the fuel left, and the can\'s place while there is none', () => {
  let s = run(seeded(), ...allFuses);
  assert.equal(text(s).lines[3], 'Fuel: around the camp');
  s = run(s, ...fuel);
  assert.equal(text(s).lines[3], 'Generator: 4.0 h of fuel');
  s = run(s, start, { type: 'time', hours: 1.25 });
  assert.equal(text(s).lines[3], 'Generator: 2.8 h of fuel, running');
  s = run(s, { type: 'time', hours: 10 });
  assert.equal(text(s).lines[3], 'Generator: out of fuel', 'dry, and the call\'s can is spent');
  assert.equal(text(s).title, 'Find fuel for the generator');
});

test('the pad stage lists bulbs, cable, fuel and lights, with where each is and a tick when done', () => {
  const called = run(seeded(), ...allFuses, ...fuel, start, { type: 'transmit', player: me, hours: 12 });
  assert.deepEqual(text(called).lines, ['Bulbs: around the chapel', 'Cable: around the well', 'Pad fuel: around the shrine', 'Lights: off']);
  const bulbs = run(called, pickup('pad-bulbs'));
  assert.equal(text(bulbs).title, 'Take the bulbs to the landing pad'); assert.equal(text(bulbs).lines[0], 'Bulbs: in hand');
  const fitted = run(bulbs, { type: 'pad-fit-bulbs', player: me });
  assert.deepEqual([text(fitted).title, text(fitted).lines[0]], ['Find cable and fuel for the pad', `${TICK}Bulbs: fitted`]);
  const cabled = run(fitted, pickup('pad-cable'), { type: 'pad-lay-cable', player: me });
  assert.equal(text(cabled).title, 'Find fuel for the pad'); assert.equal(text(cabled).lines[1], `${TICK}Cable: laid`);
  const fueled = run(cabled, pickup('pad-fuel'), { type: 'pad-refuel', player: me });
  assert.deepEqual([text(fueled).title, text(fueled).lines[2]], ['Switch on the pad lights at dawn', `${TICK}Pad fuel: filled`]);
  const lit = run(fueled, { type: 'pad-lights', player: me });
  assert.deepEqual([text(lit).title, text(lit).lines[3]], ['The pad is lit: wait for dawn', `${TICK}Lights: on`]);
  assert.equal(text(run(called, pickup('pad-fuel'))).title, 'Take the fuel to the landing pad');
});

test('the helicopter, landing and escape special cases stand', () => {
  const ready = run(seeded(), ...allFuses, ...fuel, start, { type: 'transmit', player: me, hours: 0 }, stop,
    pickup('pad-bulbs'), { type: 'pad-fit-bulbs', player: me }, pickup('pad-cable'), { type: 'pad-lay-cable', player: me }, pickup('pad-fuel'), { type: 'pad-refuel', player: me });
  const circling = run(ready, { type: 'time', hours: 6 });
  assert.equal(text(circling).title, 'Light the landing pad now');
  const landed = run(circling, { type: 'pad-lights', player: me });
  assert.deepEqual([text(landed).title, text(landed).detail], ['Get to the helicopter', 'It waits on the lit pad']);
  assert.deepEqual(text(run(landed, { type: 'board', player: me })), { title: 'You are away', detail: 'The island is behind you' });
  // Missed: a restart and a second call.
  const gone = run(circling, { type: 'time', hours: 7 });
  assert.equal(text(gone).title, 'Start the generator at the relay hut');
  assert.deepEqual([text(run(gone, start)).title, text(run(gone, start)).detail], ['Send the signal again', 'The helicopter left a dark pad']);
});

test('it is a pure function of its arguments, and an unknown phase falls back to the first step', () => {
  const s = run(seeded(), ...fuel, start);
  const frozen = JSON.stringify(s);
  assert.deepEqual(objectiveText(s, undefined), objectiveText(s, undefined));
  assert.equal(JSON.stringify(s), frozen, 'the state is untouched');
  assert.deepEqual(objectiveText({ ...initialState(), phase: 'nonsense' }), objectiveText(initialState()));
  assert.equal(heldKind(s, me), undefined);
});

test('the board has two groups with headings, numbered fuses and an area for each part', () => {
  const lines = boardLines(seeded());
  assert.deepEqual(lines, [
    '# For the call (relay hut)', 'Fuse 1: around the mine', 'Fuse 2: around the ruin', 'Fuse 3: around the logging camp', 'Fuel for the generator: around the camp',
    '# For the landing pad', 'Bulbs: around the chapel', 'Cable: around the well', 'Fuel for the pad lights: around the shrine',
  ]);
  // The board is a hint written once: a part that was moved still reads as its area; only carried, banked and fitted change it.
  const moved = run(seeded(), pickup('fuse-mine'), { type: 'drop', player: me, at: { x: 5, z: 5 } });
  assert.equal(boardLines(moved)[1], 'Fuse 1: around the mine');
  const held = run(seeded(), pickup('fuse-mine'));
  assert.equal(boardLines(held)[1], 'Fuse 1: carried');
  assert.equal(boardLines(run(held, { type: 'deposit', player: me, bank: 'relay' }))[1], 'Fuse 1: banked in the crate at the relay hut');
  assert.equal(boardLines(run(held, { type: 'insert-fuse', player: me, slot: 0 }))[1], 'Fuse 1: fitted');
  assert.deepEqual(boardLines(initialState({ 'backpack-cabin': { kind: 'backpack', poi: 'cabin', status: 'world' } })), [], 'no parts, no headings');
});
