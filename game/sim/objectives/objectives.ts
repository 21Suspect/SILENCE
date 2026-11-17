import { NOISE } from '../noise/noise-scale';

/**
 * The gameplay loop as a pure, deterministic reducer: no three.js, no DOM, no clock of its own, no randomness. Actions are plain
 * JSON, so a host can replay the same list on every client and arrive at the same state (and the same events).
 *
 * The helicopter's way out has two halves. The call, quietly first: carry three fuses into the hut's fuse box (no power needed), then
 * fetch a can of fuel, fuel and pull-start the relay generator (loud, and it burns fuel only while it runs), transmit from the radio,
 * and switch the generator off again; the helicopter is then due at the next dawn. The pad: fit
 * bulbs, lay the cable, fuel the pad's generator and switch the lights on; the helicopter lands only on a lit pad, and
 * boarding it wins. The run's clock lives elsewhere: the host feeds it in with { type: 'time', hours }.
 *
 * Every noise is placed on the scale in game/sim/noise/noise-scale.ts (loudness = distance heard within, in hundreds of metres).
 */
export type PlayerId = string;
export type ItemKind = 'fuse' | 'jerry' | 'backpack' | 'bulbs' | 'cable';
/** Where a part can be banked: the chest at the cabin, the crate at the relay hut, the crate at the landing pad. */
export type BankId = 'chest' | 'relay' | 'pad';
export const BANKS: readonly BankId[] = ['chest', 'relay', 'pad'];
export type Item = {
  kind: ItemKind;
  /** Asset name of the place it sits at (matches game/data/world-assets.json). */
  poi: string;
  /** held: in the hand; packed: in the holder's backpack; worn: the backpack itself; used: fitted or burnt; banked: in a crate or the chest, out of the world. */
  status: 'world' | 'held' | 'packed' | 'worn' | 'used' | 'banked';
  holder?: PlayerId;
  /** Set when a player put it down somewhere other than its home, or when the seed laid it on the ground beside its place. */
  at?: { x: number; z: number; y?: number };
  /** Which of the helicopter's parts this is (game/sim/run/parts.ts); the board talks about parts. */
  part?: string;
  /** The id of the place (not just its asset) and the prop hook it lies at, when the seed placed it. */
  poiId?: string;
  hook?: string;
  /** While status is 'banked': where. */
  bank?: BankId;
};
export type Phase = 'gather' | 'fueled' | 'running' | 'powered' | 'signalSent' | 'escaped';
/** The landing pad's kit. `fuel` is hours of light left in the can it was given (0 when empty); it burns only while `lit`. */
export type PadState = { bulbs: boolean; cable: boolean; fuel: number; lit: boolean };
/**
 * none: not called. inbound: called, due at `arrives`. circling: it is here and the pad is dark; it leaves at `until`. landed: on
 * the pad, waiting for someone to board until `until`. gone: it left, and the call has to be made again. `calls` counts transmissions.
 */
export type HelicopterState = { status: 'none' | 'inbound' | 'circling' | 'landed' | 'gone'; arrives: number | null; until: number | null; calls: number };
export type ObjectiveState = {
  items: Record<string, Item>;
  /** What each player has in hand: one thing. */
  carrying: Record<PlayerId, string>;
  /** Each backpack wearer's pack: PACK_SLOTS slots, row by row, an item id or null. A player without one has no entry. */
  packs: Record<PlayerId, (string | null)[]>;
  /** `hours` is game hours of fuel left (see GENERATOR_FUEL_HOURS); `fuel` is just hours > 0, kept for old callers and saves. A state without `hours` and with fuel is a full can. */
  generator: { fuel: boolean; running: boolean; hours?: number };
  /** Item id per fuse-box slot, null while empty. */
  fuseBox: (string | null)[];
  signalBy: PlayerId | null;
  phase: Phase;
  pad: PadState;
  helicopter: HelicopterState;
  /** The last game time the host told us, in absolute game hours (day * 24 + hour of day). */
  clock: number;
};

/** A place something can be carried: the hand, or a backpack slot (0 .. PACK_SLOTS - 1). */
export type Slot = 'hand' | number;
export type ObjectiveAction =
  | { type: 'pickup'; player: PlayerId; item: string }
  /** Without this a player who grabbed a fuse first could never lift the jerry can. `slot` drops from the pack; the default is the hand. */
  | { type: 'drop'; player: PlayerId; at?: { x: number; z: number; y?: number }; slot?: Slot }
  /** Rearranging: whatever is at `from` goes to `to`, and whatever was at `to` comes back to `from`. Needs a backpack. */
  | { type: 'move'; player: PlayerId; from: Slot; to: Slot }
  | { type: 'refuel'; player: PlayerId }
  | { type: 'pull-start'; player: PlayerId }
  /** Switch the relay generator off: it stops burning and keeps what fuel is left. */
  | { type: 'stop-generator'; player: PlayerId }
  | { type: 'insert-fuse'; player: PlayerId; slot: number }
  /** `hours`: the game time now (absolute hours); the helicopter is due at the next dawn after it. Without it, the last time seen. */
  | { type: 'transmit'; player: PlayerId; hours?: number }
  /** Put what is in the hand (or a pack slot) into a crate or the chest. The runtime checks the player is beside it. */
  | { type: 'deposit'; player: PlayerId; bank: BankId; slot?: Slot }
  | { type: 'withdraw'; player: PlayerId; bank: BankId; item: string }
  | { type: 'pad-fit-bulbs'; player: PlayerId }
  | { type: 'pad-lay-cable'; player: PlayerId }
  | { type: 'pad-refuel'; player: PlayerId }
  /** Switch the pad's lights on (the default) or off (to save fuel). On needs bulbs, cable and fuel. */
  | { type: 'pad-lights'; player: PlayerId; on?: boolean }
  /** Get in the helicopter while it waits on the pad: the win. */
  | { type: 'board'; player: PlayerId }
  /** The run's clock moved to `hours` (absolute game hours, never backwards). Nobody's doing, so no player is needed. */
  | { type: 'time'; hours: number };

export type RefusalReason =
  | 'unknown-action' | 'unknown-item' | 'unavailable' | 'hands-full' | 'empty-hands' | 'wrong-item'
  | 'already-fueled' | 'no-fuel' | 'already-running' | 'not-running' | 'no-power' | 'bad-slot' | 'slot-taken'
  | 'not-ready' | 'complete' | 'no-pack' | 'empty-slot'
  | 'too-heavy' | 'bad-bank' | 'already-fitted' | 'no-bulbs' | 'no-cable' | 'already-lit' | 'not-lit' | 'bad-time' | 'no-helicopter';

export type ObjectiveEvent =
  /** What the creature AI listens to. The reducer knows places by name only; the runtime adds x/z. `sustained`: kept up, not a one-off. */
  | { type: 'noise'; loudness: number; source: string; poi?: string; x?: number; z?: number; sustained?: boolean }
  /** `to`: where it went, the hand or a pack slot (a backpack is worn, not carried, and has none). */
  | { type: 'picked-up'; player: PlayerId; item: string; kind: ItemKind; to?: Slot }
  | { type: 'moved'; player: PlayerId; from: Slot; to: Slot }
  | { type: 'dropped'; player: PlayerId; item: string; kind: ItemKind; at?: { x: number; z: number; y?: number } }
  | { type: 'banked'; player: PlayerId; item: string; kind: ItemKind; bank: BankId }
  | { type: 'withdrawn'; player: PlayerId; item: string; kind: ItemKind; bank: BankId; to: Slot }
  | { type: 'refueled'; player: PlayerId; item: string }
  | { type: 'generator-started'; player: PlayerId }
  | { type: 'generator-stopped'; player: PlayerId }
  /** The can ran out while it was running: it stopped by itself. */
  | { type: 'generator-dry' }
  | { type: 'fuse-inserted'; player: PlayerId; item: string; slot: number; inserted: number }
  | { type: 'power-restored' }
  | { type: 'signal-sent'; player: PlayerId; arrives: number }
  | { type: 'pad-fitted'; player: PlayerId; part: 'bulbs' | 'cable' }
  | { type: 'pad-refueled'; player: PlayerId; item: string }
  | { type: 'pad-lights'; on: boolean }
  | { type: 'helicopter-circling'; until: number }
  | { type: 'helicopter-landed'; until: number }
  | { type: 'helicopter-left'; reason: 'dark-pad' | 'waited-out' | 'no-pad' }
  | { type: 'escaped'; player: PlayerId }
  | { type: 'refused'; action: string; player?: PlayerId; reason: RefusalReason };

export const FUSE_SLOTS = 3;
/**
 * One can runs the relay generator 4 game hours (4 minutes of play at the run's pace), and only while it runs. Long enough to start
 * it, walk to the hut's radio and send the call with time to spare; short enough that a generator left running is a lure with a
 * price (it pulls the Listener across the island) and not a free one. Above GENERATOR_REFUEL_MAX hours left a can is refused: it
 * would mostly spill.
 */
export const GENERATOR_FUEL_HOURS = 4, GENERATOR_REFUEL_MAX = 3.5;
/** The backpack's grid: three across, four down (game/ui/inventory.ts lays it out the same way). */
export const PACK_COLUMNS = 3, PACK_ROWS = 4, PACK_SLOTS = PACK_COLUMNS * PACK_ROWS;

/** The hour of day the helicopter comes at: first light, so a night spent readying the pad ends with it. */
export const DAWN_HOUR = 6;
/**
 * The pad's lights burn 90 game minutes per can of fuel, and only while switched on. Long enough to light them a little before
 * dawn and still cover the helicopter's circling and wait (25 minutes at most) with an hour of slack; short enough that lighting
 * them at dusk and walking away leaves nothing for the dawn, so the player has to be there, at the pad, at the right time.
 */
export const PAD_FUEL_HOURS = 1.5;
/** How long it circles over a dark pad before it gives up (15 game minutes), and how long it waits on a lit one (10). */
export const HELI_CIRCLE_HOURS = .25, HELI_WAIT_HOURS = 1 / 6;

/** What is too heavy for a pack: a can of fuel is carried in the hands, at a walk. */
export const HEAVY_KINDS: readonly ItemKind[] = ['jerry'];
export const isHeavy = (kind: ItemKind | undefined): boolean => kind !== undefined && HEAVY_KINDS.includes(kind);

/** The items of a plain run: three fuses, a can of fuel and the backpack at the cabin. A seeded run passes game/sim/run/parts.ts's items instead. */
export function legacyItems(): Record<string, Item> {
  return {
    'fuse-mine': { kind: 'fuse', poi: 'mine', status: 'world', part: 'call-fuse-1' },
    'fuse-lookout': { kind: 'fuse', poi: 'lookout', status: 'world', part: 'call-fuse-2' },
    'fuse-logstack': { kind: 'fuse', poi: 'logstack', status: 'world', part: 'call-fuse-3' },
    'jerry-camp': { kind: 'jerry', poi: 'camp', status: 'world', part: 'call-fuel' },
    'backpack-cabin': { kind: 'backpack', poi: 'cabin', status: 'world' },
  };
}

export function initialState(items: Record<string, Item> = legacyItems()): ObjectiveState {
  return {
    items,
    carrying: {},
    packs: {},
    generator: { fuel: false, running: false, hours: 0 },
    fuseBox: Array.from({ length: FUSE_SLOTS }, () => null),
    signalBy: null,
    phase: 'gather',
    pad: { bulbs: false, cable: false, fuel: 0, lit: false },
    helicopter: { status: 'none', arrives: null, until: null, calls: 0 },
    clock: 0,
  };
}

export const heldItem = (state: ObjectiveState, player: PlayerId): string | undefined => state.carrying[player];
export const heldKind = (state: ObjectiveState, player: PlayerId): ItemKind | undefined => {
  const id = state.carrying[player];
  return id === undefined ? undefined : state.items[id]?.kind;
};
/** The engine's carry rule: no sprinting while a can (anything heavy) is in the hands; it is carried at a walk. */
export const canSprint = (state: ObjectiveState, player: PlayerId): boolean => !isHeavy(heldKind(state, player));
/** Hours of fuel in the relay generator; a state from before fuel burned (fuel true, no hours) counts as a full can. */
export const generatorHours = (state: ObjectiveState): number => state.generator.hours ?? (state.generator.fuel ? GENERATOR_FUEL_HOURS : 0);
export const firstEmptySlot = (state: ObjectiveState): number => state.fuseBox.indexOf(null);
export const hasPack = (state: ObjectiveState, player: PlayerId): boolean => Object.hasOwn(state.packs ?? {}, player);
/** Where a player carries something of this kind: the hand first, then the pack's first slot that has one; undefined if nowhere. */
export function carriedSlot(state: ObjectiveState, player: PlayerId, kind: ItemKind): Slot | undefined {
  const held = state.carrying[player];
  if (held !== undefined && state.items[held]?.kind === kind) return 'hand';
  const at = (state.packs?.[player] ?? []).findIndex(id => id !== null && state.items[id]?.kind === kind);
  return at >= 0 ? at : undefined;
}
export const carries = (state: ObjectiveState, player: PlayerId, kind: ItemKind): boolean => carriedSlot(state, player, kind) !== undefined;
/** What the landing pad still lacks, as the kinds that would fix it. */
export const padNeeds = (state: ObjectiveState): ItemKind[] => {
  const pad = state.pad ?? { bulbs: false, cable: false, fuel: 0, lit: false }, out: ItemKind[] = [];
  if (!pad.bulbs) out.push('bulbs');
  if (!pad.cable) out.push('cable');
  if (pad.fuel <= 0 && !pad.lit) out.push('jerry');
  return out;
};
/** Whether the pad has everything the lights need: bulbs, cable and fuel. */
export const padReady = (state: ObjectiveState): boolean => state.pad.bulbs && state.pad.cable && state.pad.fuel > 0;
/**
 * The carried thing the objective should talk about: the jerry can while a generator wants fuel, a fuse once the relay runs, the
 * bulbs or cable while the pad wants them, wherever carried (hand or backpack); otherwise what is in hand.
 */
export function guideKind(state: ObjectiveState, player: PlayerId): ItemKind | undefined {
  // Fuses first: they are quiet work and the box takes them with no power. Then a can where a generator wants it.
  if (insertedFuses(state) < FUSE_SLOTS && carries(state, player, 'fuse')) return 'fuse';
  const generatorWants = state.signalBy === null && generatorHours(state) <= GENERATOR_REFUEL_MAX;
  if (carries(state, player, 'jerry') && (generatorWants || padNeeds(state).includes('jerry'))) return 'jerry';
  if (!state.pad?.bulbs && carries(state, player, 'bulbs')) return 'bulbs';
  if (!state.pad?.cable && carries(state, player, 'cable')) return 'cable';
  return heldKind(state, player);
}
/** Whether a pickup would find room: an empty hand, or a free pack slot. (A heavy thing needs the hand: see {@link hasRoomFor}.) */
export const hasRoom = (state: ObjectiveState, player: PlayerId): boolean => state.carrying[player] === undefined || (state.packs?.[player] ?? []).includes(null);
/** Room for this kind: heavy things only ever go in the hand. */
export const hasRoomFor = (state: ObjectiveState, player: PlayerId, kind: ItemKind): boolean => isHeavy(kind) ? state.carrying[player] === undefined : hasRoom(state, player);
export const insertedFuses = (state: ObjectiveState): number => state.fuseBox.filter(Boolean).length;

/** The noise a thing makes picked up or put down: the scale has a row for small things and one for heavy. */
const pickupNoise = (kind: ItemKind) => isHeavy(kind) ? NOISE.pickupHeavy : NOISE.pickupSmall;
const dropNoise = (kind: ItemKind) => isHeavy(kind) ? NOISE.dropHeavy : NOISE.dropSmall;

const phaseOf = (s: ObjectiveState): Phase =>
  s.phase === 'escaped' ? 'escaped'
  : s.signalBy !== null ? 'signalSent'
  : s.generator.running ? (insertedFuses(s) === FUSE_SLOTS ? 'powered' : 'running')
  : s.generator.fuel ? 'fueled' : 'gather';

const copy = (s: ObjectiveState): ObjectiveState => ({
  items: Object.fromEntries(Object.entries(s.items).map(([id, item]) => [id, { ...item }])),
  carrying: { ...s.carrying },
  packs: Object.fromEntries(Object.entries(s.packs ?? {}).map(([id, pack]) => [id, pack.slice()])),
  generator: { ...s.generator, hours: s.generator.hours ?? (s.generator.fuel ? GENERATOR_FUEL_HOURS : 0) },
  fuseBox: s.fuseBox.slice(),
  signalBy: s.signalBy,
  phase: s.phase,
  pad: { ...(s.pad ?? { bulbs: false, cable: false, fuel: 0, lit: false }) },
  helicopter: { ...(s.helicopter ?? { status: 'none', arrives: null, until: null, calls: 0 }) },
  clock: s.clock ?? 0,
});

const isPackSlot = (s: unknown): s is number => typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < PACK_SLOTS;
/** Empty a carried place in `next` (already a copy) and return what was there. */
function take(next: ObjectiveState, player: PlayerId, from: Slot): string {
  if (from === 'hand') { const id = next.carrying[player]; delete next.carrying[player]; return id; }
  const id = next.packs[player][from] as string; next.packs[player][from] = null; return id;
}
/** Where a pickup of this kind would go: the hand when it is free, else (never for a heavy thing) the pack's first free slot; -1 for nowhere. */
const roomFor = (state: ObjectiveState, player: PlayerId, kind: ItemKind): Slot =>
  state.carrying[player] === undefined ? 'hand' : isHeavy(kind) ? -1 : (state.packs?.[player] ?? []).indexOf(null);

/** The first dawn strictly after `hours` (absolute game hours). */
export const nextDawn = (hours: number): number => {
  const today = Math.floor(hours / 24) * 24 + DAWN_HOUR;
  return today > hours ? today : today + 24;
};

export type Reduction = { state: ObjectiveState; events: ObjectiveEvent[] };

/**
 * Move the clock of `next` (a copy) on to `to`, step by step to each moment something happens: the pad's fuel runs out, the
 * helicopter arrives, gives up circling, or leaves. Returns whether the helicopter was in the sky or on the pad at any point.
 */
function advance(next: ObjectiveState, to: number, events: ObjectiveEvent[]): boolean {
  const heli = next.helicopter, pad = next.pad, gen = next.generator;
  let here = false;
  for (let guard = 0; guard < 16 && next.clock < to; guard++) {
    let step = to;
    if (pad.lit) step = Math.min(step, next.clock + pad.fuel);
    if (gen.running) step = Math.min(step, next.clock + (gen.hours ?? 0));
    if (heli.status === 'inbound' && heli.arrives !== null) step = Math.min(step, heli.arrives);
    if ((heli.status === 'circling' || heli.status === 'landed') && heli.until !== null) step = Math.min(step, heli.until);
    step = Math.max(step, next.clock);
    if (pad.lit) pad.fuel = Math.max(0, pad.fuel - (step - next.clock));
    if (gen.running) gen.hours = Math.max(0, (gen.hours ?? 0) - (step - next.clock));
    next.clock = step;
    // Dry: the relay generator stops by itself (and with it its noise); the call already sent stands.
    if (gen.running && (gen.hours ?? 0) <= 1e-9) { gen.running = false; gen.fuel = false; gen.hours = 0; next.phase = phaseOf(next); events.push({ type: 'generator-dry' }); }
    if (pad.lit && pad.fuel <= 1e-9) { pad.lit = false; pad.fuel = 0; events.push({ type: 'pad-lights', on: false }); }
    if (settle(next, events)) here = true;
  }
  return here || heli.status === 'circling' || heli.status === 'landed';
}

/** The helicopter's decisions at the clock's current moment. Returns whether it is, or has just been, at the island. */
function settle(next: ObjectiveState, events: ObjectiveEvent[]): boolean {
  const heli = next.helicopter, now = next.clock, lit = next.pad.lit;
  let here = false;
  const land = () => { heli.status = 'landed'; heli.until = now + HELI_WAIT_HOURS; events.push({ type: 'helicopter-landed', until: heli.until }); };
  const leave = (reason: 'dark-pad' | 'waited-out' | 'no-pad') => {
    heli.status = 'gone'; heli.until = null; events.push({ type: 'helicopter-left', reason });
    // The call has to be made again: the radio, the running generator and the fitted fuses all stand, so the cost is a day and the noise.
    next.signalBy = null; next.phase = phaseOf(next); here = true;
  };
  if (heli.status === 'inbound' && heli.arrives !== null && now >= heli.arrives) {
    if (lit) land(); else { heli.status = 'circling'; heli.until = now + HELI_CIRCLE_HOURS; events.push({ type: 'helicopter-circling', until: heli.until }); }
    here = true;
  } else if (heli.status === 'circling') {
    if (lit) land(); else if (heli.until !== null && now >= heli.until) leave('no-pad');
    here = true;
  } else if (heli.status === 'landed') {
    // A pilot will not sit on a dark pad: the lights going out sends it off at once.
    if (!lit) leave('dark-pad'); else if (heli.until !== null && now >= heli.until) leave('waited-out');
    here = true;
  }
  return here;
}

/**
 * Never throws, never mutates `state`. A refused or malformed action returns the
 * very same state object plus a single `refused` event, so callers can tell a
 * no-op by identity.
 */
export function applyAction(state: ObjectiveState, action: ObjectiveAction): Reduction {
  const a = action as { type?: unknown; player?: unknown };
  const player = typeof a?.player === 'string' && a.player ? a.player : undefined;
  const refuse = (reason: RefusalReason): Reduction => ({ state, events: [{ type: 'refused', action: String(a?.type), ...(player ? { player } : {}), reason }] });
  if (a?.type === 'time') {
    const hours = (a as { hours?: unknown }).hours, clock = state.clock ?? 0;
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < clock) return refuse('bad-time');
    if (state.phase === 'escaped' || hours === clock) return { state, events: [] };
    const next = copy(state), events: ObjectiveEvent[] = [];
    const here = advance(next, hours, events);
    // Kept up while it flies or waits, and while the pad's generator runs: the host repeats these every tick it advances.
    if (here) events.push({ type: 'noise', loudness: NOISE.island, source: 'helicopter', poi: 'pad', sustained: true });
    if (next.pad.lit) events.push({ type: 'noise', loudness: NOISE.generator, source: 'pad-generator', poi: 'pad', sustained: true });
    return { state: next, events };
  }
  if (player === undefined) return refuse('unknown-action');
  if (state.phase === 'escaped') return refuse('complete');
  const held = state.carrying[player];

  switch (a.type) {
    case 'pickup': {
      const id = (a as { item?: unknown }).item, item = typeof id === 'string' && Object.hasOwn(state.items, id) ? state.items[id] : undefined;
      if (!item) return refuse('unknown-item');
      if (item.status !== 'world') return refuse('unavailable');
      const where = item.at ? { x: item.at.x, z: item.at.z } : { poi: item.poi };
      if (item.kind === 'backpack') {
        // Worn, not carried: it takes neither the hand nor a slot, and a second one is no use.
        if (hasPack(state, player)) return refuse('unavailable');
        const next = copy(state), worn = next.items[id as string];
        worn.status = 'worn'; worn.holder = player; delete worn.at; next.packs[player] = Array.from({ length: PACK_SLOTS }, () => null);
        return { state: next, events: [
          { type: 'picked-up', player, item: id as string, kind: item.kind },
          { type: 'noise', loudness: NOISE.pickupSmall, source: 'pickup', ...where },
        ] };
      }
      // The hand first; with a backpack, the first free slot when the hand is full, but never for a heavy thing.
      const slot = roomFor(state, player, item.kind);
      if (slot === -1) return refuse('hands-full');
      const next = copy(state), taken = next.items[id as string];
      taken.holder = player; delete taken.at;
      if (slot === 'hand') { taken.status = 'held'; next.carrying[player] = id as string; } else { taken.status = 'packed'; next.packs[player][slot] = id as string; }
      return { state: next, events: [
        { type: 'picked-up', player, item: id as string, kind: item.kind, to: slot },
        { type: 'noise', loudness: pickupNoise(item.kind), source: 'pickup', ...where },
      ] };
    }
    case 'drop': {
      const from = (a as { slot?: unknown }).slot ?? 'hand';
      if (from !== 'hand' && !isPackSlot(from)) return refuse('bad-slot');
      if (from !== 'hand' && !hasPack(state, player)) return refuse('no-pack');
      const id = from === 'hand' ? held : state.packs[player][from as number] ?? undefined;
      if (id === undefined || !state.items[id]) return refuse(from === 'hand' ? 'empty-hands' : 'empty-slot');
      const raw = (a as { at?: { x?: unknown; z?: unknown; y?: unknown } }).at;
      // y is where the player's feet were: on a cabin floor that is above the terrain beneath it.
      const at = raw && Number.isFinite(raw.x) && Number.isFinite(raw.z) ? { x: raw.x as number, z: raw.z as number, ...(Number.isFinite(raw.y) ? { y: raw.y as number } : {}) } : undefined;
      const next = copy(state), dropped = next.items[id];
      dropped.status = 'world'; delete dropped.holder; if (at) dropped.at = at;
      if (from === 'hand') delete next.carrying[player]; else next.packs[player][from as number] = null;
      return { state: next, events: [
        { type: 'dropped', player, item: id, kind: dropped.kind, ...(at ? { at } : {}) },
        { type: 'noise', loudness: dropNoise(dropped.kind), source: 'drop', ...(at ? { x: at.x, z: at.z } : { poi: dropped.poi }) },
      ] };
    }
    case 'move': {
      const { from, to } = a as { from?: unknown; to?: unknown };
      if (!hasPack(state, player)) return refuse('no-pack');
      if (!(from === 'hand' || isPackSlot(from)) || !(to === 'hand' || isPackSlot(to)) || from === to) return refuse('bad-slot');
      const at = (s: Slot) => s === 'hand' ? held ?? null : state.packs[player][s];
      const moving = at(from as Slot), other = at(to as Slot);
      if (moving === null) return refuse('empty-slot');
      // Nothing heavy goes into the pack, whichever way round the swap is.
      if ((to !== 'hand' && isHeavy(state.items[moving]?.kind)) || (from !== 'hand' && other !== null && isHeavy(state.items[other]?.kind))) return refuse('too-heavy');
      const next = copy(state);
      const put = (s: Slot, id: string | null) => {
        if (s === 'hand') { if (id === null) delete next.carrying[player]; else next.carrying[player] = id; }
        else next.packs[player][s] = id;
        if (id !== null) next.items[id].status = s === 'hand' ? 'held' : 'packed';
      };
      put(to as Slot, moving); put(from as Slot, other);
      // Near silent: a creature hears the drop, not the rummaging.
      return { state: next, events: [{ type: 'moved', player, from: from as Slot, to: to as Slot }] };
    }
    case 'refuel': {
      // The can in hand, or one from the pack.
      const from = carriedSlot(state, player, 'jerry');
      if (from === undefined) return refuse('wrong-item');
      if (generatorHours(state) > GENERATOR_REFUEL_MAX) return refuse('already-fueled');
      const next = copy(state), used = take(next, player, from);
      next.items[used].status = 'used'; delete next.items[used].holder;
      next.generator.fuel = true; next.generator.hours = GENERATOR_FUEL_HOURS; next.phase = phaseOf(next);
      return { state: next, events: [
        { type: 'refueled', player, item: used },
        { type: 'noise', loudness: NOISE.refuel, source: 'refuel', poi: 'generator' },
      ] };
    }
    case 'pull-start': {
      if (state.generator.running) return refuse('already-running');
      if (generatorHours(state) <= 0) return refuse('no-fuel');
      const next = copy(state);
      next.generator.running = true; next.phase = phaseOf(next);
      // The runtime keeps the hum up at the same loudness (NOISE.generator) while it runs.
      return { state: next, events: [
        { type: 'generator-started', player },
        { type: 'noise', loudness: NOISE.generator, source: 'generator-start', poi: 'generator' },
      ] };
    }
    case 'stop-generator': {
      if (!state.generator.running) return refuse('not-running');
      const next = copy(state);
      next.generator.running = false; next.phase = phaseOf(next);
      return { state: next, events: [{ type: 'generator-stopped', player }] };
    }
    case 'insert-fuse': {
      const slot = (a as { slot?: unknown }).slot;
      // No power needed: the fuse box is quiet work, and only the radio wants the generator.
      const from = carriedSlot(state, player, 'fuse');
      if (from === undefined) return refuse('wrong-item');
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= FUSE_SLOTS) return refuse('bad-slot');
      if (state.fuseBox[slot] !== null) return refuse('slot-taken');
      const next = copy(state), used = take(next, player, from);
      next.items[used].status = 'used'; delete next.items[used].holder;
      next.fuseBox[slot] = used;
      const before = next.phase; next.phase = phaseOf(next);
      const events: ObjectiveEvent[] = [
        { type: 'fuse-inserted', player, item: used, slot, inserted: insertedFuses(next) },
        { type: 'noise', loudness: NOISE.fuseInsert, source: 'fuse-insert', poi: 'hut' },
      ];
      if (next.phase === 'powered' && before !== 'powered') events.push({ type: 'power-restored' });
      return { state: next, events };
    }
    case 'transmit': {
      // The radio needs the generator running and all three fuses fitted, in whatever order they came.
      if (state.phase !== 'powered') return refuse(state.generator.running ? 'not-ready' : 'no-power');
      const given = (a as { hours?: unknown }).hours, clock = state.clock ?? 0;
      if (given !== undefined && (typeof given !== 'number' || !Number.isFinite(given) || given < clock)) return refuse('bad-time');
      const next = copy(state), events: ObjectiveEvent[] = [], now = (given as number | undefined) ?? clock;
      next.clock = now;
      const arrives = nextDawn(now);
      next.signalBy = player; next.phase = 'signalSent';
      next.helicopter = { status: 'inbound', arrives, until: null, calls: next.helicopter.calls + 1 };
      events.push({ type: 'signal-sent', player, arrives }, { type: 'noise', loudness: NOISE.radio, source: 'radio', poi: 'hut' });
      return { state: next, events };
    }
    case 'deposit': {
      const { bank, slot } = a as { bank?: unknown; slot?: unknown };
      if (!BANKS.includes(bank as BankId)) return refuse('bad-bank');
      const from = slot ?? 'hand';
      if (from !== 'hand' && !isPackSlot(from)) return refuse('bad-slot');
      if (from !== 'hand' && !hasPack(state, player)) return refuse('no-pack');
      const id = from === 'hand' ? held : state.packs[player][from as number] ?? undefined;
      if (id === undefined || !state.items[id]) return refuse(from === 'hand' ? 'empty-hands' : 'empty-slot');
      // The backpack is worn, not carried, so it is never in a hand or slot; nothing else is refused.
      const next = copy(state), put = next.items[id];
      take(next, player, from as Slot);
      put.status = 'banked'; put.bank = bank as BankId; delete put.holder; delete put.at;
      return { state: next, events: [
        { type: 'banked', player, item: id, kind: put.kind, bank: bank as BankId },
        { type: 'noise', loudness: dropNoise(put.kind), source: 'bank', poi: BANK_POI[bank as BankId] },
      ] };
    }
    case 'withdraw': {
      const { bank, item: id } = a as { bank?: unknown; item?: unknown };
      if (!BANKS.includes(bank as BankId)) return refuse('bad-bank');
      const item = typeof id === 'string' && Object.hasOwn(state.items, id) ? state.items[id] : undefined;
      if (!item) return refuse('unknown-item');
      if (item.status !== 'banked' || item.bank !== bank) return refuse('unavailable');
      const slot = roomFor(state, player, item.kind);
      if (slot === -1) return refuse('hands-full');
      const next = copy(state), out = next.items[id as string];
      delete out.bank; out.holder = player;
      if (slot === 'hand') { out.status = 'held'; next.carrying[player] = id as string; } else { out.status = 'packed'; next.packs[player][slot] = id as string; }
      return { state: next, events: [
        { type: 'withdrawn', player, item: id as string, kind: item.kind, bank: bank as BankId, to: slot },
        { type: 'noise', loudness: pickupNoise(item.kind), source: 'bank', poi: BANK_POI[bank as BankId] },
      ] };
    }
    case 'pad-fit-bulbs':
    case 'pad-lay-cable': {
      const kind: ItemKind = a.type === 'pad-fit-bulbs' ? 'bulbs' : 'cable', part = kind === 'bulbs' ? 'bulbs' : 'cable';
      const from = carriedSlot(state, player, kind);
      if (from === undefined) return refuse('wrong-item');
      if (state.pad[part]) return refuse('already-fitted');
      const next = copy(state), used = take(next, player, from);
      next.items[used].status = 'used'; delete next.items[used].holder; next.pad[part] = true;
      return { state: next, events: [
        { type: 'pad-fitted', player, part },
        // Bulbs click in, a cable is paid out across the ground: both about as loud as dropping something small.
        { type: 'noise', loudness: NOISE.dropSmall, source: 'pad-fit', poi: 'pad' },
      ] };
    }
    case 'pad-refuel': {
      const from = carriedSlot(state, player, 'jerry');
      if (from === undefined) return refuse('wrong-item');
      if (state.pad.fuel > 0) return refuse('already-fueled');
      const next = copy(state), used = take(next, player, from);
      next.items[used].status = 'used'; delete next.items[used].holder; next.pad.fuel = PAD_FUEL_HOURS;
      return { state: next, events: [
        { type: 'pad-refueled', player, item: used },
        { type: 'noise', loudness: NOISE.refuel, source: 'refuel', poi: 'pad' },
      ] };
    }
    case 'pad-lights': {
      const on = (a as { on?: unknown }).on !== false;
      if (on) {
        if (state.pad.lit) return refuse('already-lit');
        if (!state.pad.bulbs) return refuse('no-bulbs');
        if (!state.pad.cable) return refuse('no-cable');
        if (state.pad.fuel <= 0) return refuse('no-fuel');
        const next = copy(state), events: ObjectiveEvent[] = [{ type: 'pad-lights', on: true }, { type: 'noise', loudness: NOISE.generator, source: 'pad-generator-start', poi: 'pad' }];
        next.pad.lit = true;
        // A helicopter already circling sees the lights and comes down.
        settle(next, events);
        return { state: next, events };
      }
      if (!state.pad.lit) return refuse('not-lit');
      const next = copy(state), events: ObjectiveEvent[] = [{ type: 'pad-lights', on: false }];
      next.pad.lit = false;
      settle(next, events);
      return { state: next, events };
    }
    case 'board': {
      if (state.helicopter.status !== 'landed') return refuse('no-helicopter');
      const next = copy(state);
      next.phase = 'escaped';
      return { state: next, events: [{ type: 'escaped', player }] };
    }
    default:
      return refuse('unknown-action');
  }
}

/** Where a bank's noise is heard from; the runtime turns these names into positions. */
const BANK_POI: Record<BankId, string> = { chest: 'cabin', relay: 'hut', pad: 'pad' };

/** Fold a recorded action list over a state; what a host or late joiner would run. */
export function replay(actions: readonly ObjectiveAction[], from: ObjectiveState = initialState()): Reduction {
  let state = from; const events: ObjectiveEvent[] = [];
  for (const action of actions) { const r = applyAction(state, action); state = r.state; events.push(...r.events); }
  return { state, events };
}
