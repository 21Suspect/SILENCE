import { FUSE_SLOTS, generatorHours, insertedFuses, padNeeds, padReady, type BankId, type Item, type ItemKind, type ObjectiveState } from './objectives';
import { placeAt, placeOf } from '../world/places';

/**
 * What the objective corner says: the next thing to do as a short title, and under it a checklist of what that step needs, each
 * with where it is ("Fuse 2: around the ruin"). `lines` has at most {@link MAX_LINES}; a done one starts with {@link TICK}.
 * `detail` is a one-off remark (the helicopter's state) and is empty in the ordinary steps.
 */
export type ObjectiveText = { title: string; detail?: string; lines?: string[] };
export type ObjectiveTextOptions = {
  /** The key that puts down what is carried, as the player knows it ("Q"). Omitted on touch, where a Drop button is on screen. */
  dropKey?: string;
  /** Whether a pickup would find room (an empty hand, or space in a backpack). Default: only when nothing is in hand. */
  room?: boolean;
};
export const MAX_LINES = 4;
export const TICK = '✓ ';

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const word = (n: number) => WORDS[n] ?? String(n);
const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** A place by the asset name an item carries, as the board says it ("the chapel"); an unknown asset is still named. */
const nameOf = (asset: string) => placeOf(asset)?.name ?? `the ${asset}`;
/** Where a bank is, in a phrase after "banked". */
const BANK_AT: Record<BankId, string> = { chest: 'at the cabin', relay: 'at the relay hut', pad: 'at the landing pad' };
const bankAt = (bank: BankId | undefined) => BANK_AT[bank ?? 'chest'] ?? BANK_AT.chest;

/** Where one part is for the HUD: in hand, in the pack, banked, fitted, or around the place it lies at (a dropped one, where it was dropped). */
function whereNow(item: Item | undefined): string {
  if (!item) return 'not found';
  if (item.status === 'used') return 'fitted';
  if (item.status === 'banked') return `banked ${bankAt(item.bank)}`;
  if (item.status === 'held') return 'in hand';
  if (item.status === 'packed') return 'in your pack';
  const dropped = item.at ? placeAt(item.at.x, item.at.z) : undefined;
  return `around ${dropped?.name ?? nameOf(item.poi)}`;
}
const part = (state: ObjectiveState, id: string): Item | undefined => Object.values(state.items).find(i => i.part === id);
const hoursText = (h: number) => `${h.toFixed(1)} h`;

/** The three fuses in the order of their part ids; a run without part ids numbers the fuses it has. */
function fuseItems(state: ObjectiveState): (Item | undefined)[] {
  const fuses = Object.values(state.items).filter(i => i.kind === 'fuse').sort((a, b) => String(a.part ?? '').localeCompare(String(b.part ?? '')));
  return Array.from({ length: FUSE_SLOTS }, (_, i) => fuses[i]);
}
/** The call's checklist: the three fuses, and the generator's fuel (or, while it has none, where the can is). */
function callLines(state: ObjectiveState): string[] {
  const out = fuseItems(state).map((item, i) => `${item?.status === 'used' ? TICK : ''}Fuse ${i + 1}: ${whereNow(item)}`);
  const hours = generatorHours(state), running = state.generator.running;
  if (hours > 0) out.push(`Generator: ${hoursText(hours)} of fuel${running ? ', running' : ''}`);
  else {
    const can = part(state, 'call-fuel');
    out.push(can && can.status !== 'used' ? `Fuel: ${whereNow(can)}` : 'Generator: out of fuel');
  }
  return out;
}
/** The pad's checklist: bulbs, cable, a can for its lights, and the lights. */
function padLines(state: ObjectiveState): string[] {
  const pad = state.pad, tick = (done: boolean) => done ? TICK : '';
  const filled = !!pad && (pad.fuel > 0 || pad.lit);
  const where = (id: string) => part(state, id) ? whereNow(part(state, id)) : 'needed';
  return [
    `${tick(!!pad?.bulbs)}Bulbs: ${pad?.bulbs ? 'fitted' : where('pad-bulbs')}`,
    `${tick(!!pad?.cable)}Cable: ${pad?.cable ? 'laid' : where('pad-cable')}`,
    `${tick(filled)}Pad fuel: ${filled ? 'filled' : where('pad-fuel')}`,
    `${tick(!!pad?.lit)}Lights: ${pad?.lit ? 'on' : 'off'}`,
  ];
}

/**
 * The current step, read off the real state machine (game/sim/objectives/objectives.ts) and what the local player is carrying. The
 * order of play: find the three fuses (the box takes them with no power), fuel the generator, start it, send the signal from the
 * radio; then ready the landing pad and board. Plain and imperative, no lore. `held` is `guideKind(state, me)`: the useful thing
 * carried, in hand or in the backpack. (A fuse in hand no longer blocks anything the generator needs, so there is no "hands full"
 * warning: the fuse's next stop is the box.)
 */
export function objectiveText(state: ObjectiveState, held?: ItemKind, options: ObjectiveTextOptions = {}): ObjectiveText {
  void options; // kept for callers: the hands-full warning it served is gone
  const left = FUSE_SLOTS - insertedFuses(state);
  const pad = state.pad, heli = state.helicopter?.status ?? 'none';
  const withLines = (title: string, lines: string[], detail?: string): ObjectiveText => ({ title, ...(detail ? { detail } : {}), lines: lines.slice(0, MAX_LINES) });
  switch (state.phase) {
    case 'escaped':
      return { title: 'You are away', detail: 'The island is behind you' };
    case 'signalSent': {
      const lines = padLines(state);
      if (heli === 'landed') return withLines('Get to the helicopter', [], 'It waits on the lit pad');
      if (heli === 'circling') return pad?.lit ? { title: 'Get to the helicopter' } : withLines('Light the landing pad now', lines);
      if (held === 'bulbs' && !pad?.bulbs) return withLines('Take the bulbs to the landing pad', lines);
      if (held === 'cable' && !pad?.cable) return withLines('Take the cable to the landing pad', lines);
      if (held === 'jerry' && pad && pad.fuel <= 0 && !pad.lit) return withLines('Take the fuel to the landing pad', lines);
      if (pad?.lit) return withLines('The pad is lit: wait for dawn', lines);
      if (pad && padReady(state)) return withLines('Switch on the pad lights at dawn', lines);
      // Nothing useful in hand: what the pad still lacks, in the order it is fitted ("Find bulbs, cable and fuel for the pad").
      const lacks = padNeeds(state).map(k => k === 'bulbs' ? 'bulbs' : k === 'cable' ? 'cable' : 'fuel');
      return withLines(lacks.length ? `Find ${list(lacks)} for the pad` : 'Ready the landing pad before dawn', lines);
    }
    default: {
      const lines = callLines(state);
      if (state.phase === 'powered') {
        if (heli === 'gone') return withLines('Send the signal again', lines, 'The helicopter left a dark pad');
        return withLines('Send the signal from the relay hut', lines);
      }
      if (held === 'fuse' && left > 0) return withLines('Take the fuse to the relay hut', lines);
      if (held === 'jerry') return withLines('Take the fuel to the generator', lines);
      if (left > 0) {
        return withLines(left === FUSE_SLOTS ? `Find ${word(left)} fuses for the relay hut`
          : left === 1 ? 'Find the last fuse for the relay hut' : `Find ${word(left)} more fuses for the relay hut`, lines);
      }
      // All three are fitted: the generator is the whole of what is left of the call.
      return withLines(generatorHours(state) > 0 ? 'Start the generator at the relay hut' : 'Find fuel for the generator', lines);
    }
  }
}

/** What each part is called on the board, and the order it is listed in. */
const PART_LABEL: Record<string, string> = {
  'call-fuse-1': 'Fuse 1', 'call-fuse-2': 'Fuse 2', 'call-fuse-3': 'Fuse 3', 'call-fuel': 'Fuel for the generator',
  'pad-bulbs': 'Bulbs', 'pad-cable': 'Cable', 'pad-fuel': 'Fuel for the pad lights',
};
const PART_ORDER = Object.keys(PART_LABEL);
/** A heading line on the board starts with this; the board panel draws it as a heading, not a part. */
export const BOARD_HEADING = '# ';
const BOARD_GROUPS: readonly { heading: string; parts: readonly string[] }[] = [
  { heading: 'For the call (relay hut)', parts: ['call-fuse-1', 'call-fuse-2', 'call-fuse-3', 'call-fuel'] },
  { heading: 'For the landing pad', parts: ['pad-bulbs', 'pad-cable', 'pad-fuel'] },
];
const BANK_WORDS: Record<BankId, string> = { chest: 'in the chest at the cabin', relay: 'in the crate at the relay hut', pad: 'in the crate at the landing pad' };

/** Where one part is, as the board says it: the area while it lies where the seed put it, never the exact spot. */
function boardWhere(item: Item): string {
  if (item.status === 'used') return 'fitted';
  if (item.status === 'banked') return `banked ${BANK_WORDS[item.bank ?? 'chest']}`;
  if (item.status === 'held' || item.status === 'packed') return 'carried';
  // A part a player moved still reads as the area the seed laid it in: the board is a hint written once, not a tracker.
  return `around ${nameOf(item.poi)}`;
}

/**
 * The board at the cabin: two groups, "For the call (relay hut)" and "For the landing pad", one line per helicopter part,
 * "Bulbs: around the chapel". The area only, never the exact spot; a part that is banked, carried or fitted says so instead of where
 * it lay. A heading is a line starting with {@link BOARD_HEADING}, and a group with no parts has none.
 */
export function boardLines(state: ObjectiveState): string[] {
  const out: string[] = [];
  for (const group of BOARD_GROUPS) {
    const parts = Object.values(state.items).filter(i => i.part !== undefined && group.parts.includes(i.part));
    if (!parts.length) continue;
    parts.sort((a, b) => PART_ORDER.indexOf(a.part!) - PART_ORDER.indexOf(b.part!));
    out.push(`${BOARD_HEADING}${group.heading}`, ...parts.map(item => `${PART_LABEL[item.part!]}: ${boardWhere(item)}`));
  }
  return out;
}
