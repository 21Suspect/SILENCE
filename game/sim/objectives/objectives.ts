/**
 * The first gameplay loop as a pure, deterministic reducer: no three.js, no DOM,
 * no clock, no randomness. Actions are plain JSON, so a host can replay the same
 * list on every client and arrive at the same state (and the same events).
 *
 * Fetch a jerry can, fuel and pull-start the relay generator (loud), carry three
 * fuses into the hut's fuse box while it runs, then transmit.
 */
export type PlayerId = string;
export type ItemKind = 'fuse' | 'jerry' | 'backpack';
export type Item = {
  kind: ItemKind;
  /** Asset name of the place it sits at (matches game/data/world-assets.json). */
  poi: string;
  /** held: in the hand; packed: in the holder's backpack; worn: the backpack itself, on the holder's back. */
  status: 'world' | 'held' | 'packed' | 'worn' | 'used';
  holder?: PlayerId;
  /** Set when a player put it down somewhere other than its home. */
  at?: { x: number; z: number; y?: number };
};
export type Phase = 'gather' | 'fueled' | 'running' | 'powered' | 'signalSent';
export type ObjectiveState = {
  items: Record<string, Item>;
  /** What each player has in hand: one thing. */
  carrying: Record<PlayerId, string>;
  /** Each backpack wearer's pack: PACK_SLOTS slots, row by row, an item id or null. A player without one has no entry. */
  packs: Record<PlayerId, (string | null)[]>;
  generator: { fuel: boolean; running: boolean };
  /** Item id per fuse-box slot, null while empty. */
  fuseBox: (string | null)[];
  signalBy: PlayerId | null;
  phase: Phase;
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
  | { type: 'insert-fuse'; player: PlayerId; slot: number }
  | { type: 'transmit'; player: PlayerId };

export type RefusalReason =
  | 'unknown-action' | 'unknown-item' | 'unavailable' | 'hands-full' | 'empty-hands' | 'wrong-item'
  | 'already-fueled' | 'no-fuel' | 'already-running' | 'no-power' | 'bad-slot' | 'slot-taken'
  | 'not-ready' | 'complete' | 'no-pack' | 'empty-slot';

export type ObjectiveEvent =
  /** What the creature AI listens to. The reducer knows places by name only; the runtime adds x/z. */
  | { type: 'noise'; loudness: number; source: string; poi?: string; x?: number; z?: number }
  /** `to`: where it went, the hand or a pack slot (a backpack is worn, not carried, and has none). */
  | { type: 'picked-up'; player: PlayerId; item: string; kind: ItemKind; to?: Slot }
  | { type: 'moved'; player: PlayerId; from: Slot; to: Slot }
  | { type: 'dropped'; player: PlayerId; item: string; kind: ItemKind; at?: { x: number; z: number; y?: number } }
  | { type: 'refueled'; player: PlayerId; item: string }
  | { type: 'generator-started'; player: PlayerId }
  | { type: 'fuse-inserted'; player: PlayerId; item: string; slot: number; inserted: number }
  | { type: 'power-restored' }
  | { type: 'signal-sent'; player: PlayerId }
  | { type: 'refused'; action: string; player?: PlayerId; reason: RefusalReason };

export const FUSE_SLOTS = 3;
/** The backpack's grid: three across, four down (game/ui/inventory.ts lays it out the same way). */
export const PACK_COLUMNS = 3, PACK_ROWS = 4, PACK_SLOTS = PACK_COLUMNS * PACK_ROWS;

export function initialState(): ObjectiveState {
  return {
    items: {
      'fuse-mine': { kind: 'fuse', poi: 'mine', status: 'world' },
      'fuse-lookout': { kind: 'fuse', poi: 'lookout', status: 'world' },
      'fuse-logstack': { kind: 'fuse', poi: 'logstack', status: 'world' },
      'jerry-camp': { kind: 'jerry', poi: 'camp', status: 'world' },
      'backpack-cabin': { kind: 'backpack', poi: 'cabin', status: 'world' },
    },
    carrying: {},
    packs: {},
    generator: { fuel: false, running: false },
    fuseBox: Array.from({ length: FUSE_SLOTS }, () => null),
    signalBy: null,
    phase: 'gather',
  };
}

export const heldItem = (state: ObjectiveState, player: PlayerId): string | undefined => state.carrying[player];
export const heldKind = (state: ObjectiveState, player: PlayerId): ItemKind | undefined => {
  const id = state.carrying[player];
  return id === undefined ? undefined : state.items[id]?.kind;
};
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
/**
 * The carried thing the objective should talk about: the jerry can while the generator wants fuel, a fuse once it runs, wherever
 * either is carried (hand or backpack); otherwise what is in hand.
 */
export function guideKind(state: ObjectiveState, player: PlayerId): ItemKind | undefined {
  if (!state.generator.fuel && carries(state, player, 'jerry')) return 'jerry';
  if (state.generator.running && carries(state, player, 'fuse')) return 'fuse';
  return heldKind(state, player);
}
/** Whether a pickup would find room: an empty hand, or a free pack slot. */
export const hasRoom = (state: ObjectiveState, player: PlayerId): boolean => state.carrying[player] === undefined || (state.packs?.[player] ?? []).includes(null);
export const insertedFuses = (state: ObjectiveState): number => state.fuseBox.filter(Boolean).length;

// Loudness is what a creature a hundred metres away could plausibly hear: 1 is the generator roaring awake.
const LOUD = { fuse: .08, jerry: .2, backpack: .06, dropFuse: .12, dropJerry: .35, refuel: .35, start: .95, insert: .22, radio: .65 };

const phaseOf = (s: ObjectiveState): Phase =>
  s.signalBy !== null ? 'signalSent'
  : s.generator.running ? (insertedFuses(s) === FUSE_SLOTS ? 'powered' : 'running')
  : s.generator.fuel ? 'fueled' : 'gather';

const copy = (s: ObjectiveState): ObjectiveState => ({
  items: Object.fromEntries(Object.entries(s.items).map(([id, item]) => [id, { ...item }])),
  carrying: { ...s.carrying },
  packs: Object.fromEntries(Object.entries(s.packs ?? {}).map(([id, pack]) => [id, pack.slice()])),
  generator: { ...s.generator },
  fuseBox: s.fuseBox.slice(),
  signalBy: s.signalBy,
  phase: s.phase,
});

const isPackSlot = (s: unknown): s is number => typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < PACK_SLOTS;
/** Empty a carried place in `next` (already a copy) and return what was there. */
function take(next: ObjectiveState, player: PlayerId, from: Slot): string {
  if (from === 'hand') { const id = next.carrying[player]; delete next.carrying[player]; return id; }
  const id = next.packs[player][from] as string; next.packs[player][from] = null; return id;
}

export type Reduction = { state: ObjectiveState; events: ObjectiveEvent[] };

/**
 * Never throws, never mutates `state`. A refused or malformed action returns the
 * very same state object plus a single `refused` event, so callers can tell a
 * no-op by identity.
 */
export function applyAction(state: ObjectiveState, action: ObjectiveAction): Reduction {
  const a = action as Partial<ObjectiveAction> & { type?: unknown };
  const player = typeof a?.player === 'string' && a.player ? a.player : undefined;
  const refuse = (reason: RefusalReason): Reduction => ({ state, events: [{ type: 'refused', action: String(a?.type), ...(player ? { player } : {}), reason }] });
  if (player === undefined) return refuse('unknown-action');
  if (state.phase === 'signalSent') return refuse('complete');
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
          { type: 'noise', loudness: LOUD.backpack, source: 'pickup', ...where },
        ] };
      }
      // The hand first; with a backpack, the first free slot when the hand is full.
      const slot = held === undefined ? 'hand' : (state.packs?.[player] ?? []).indexOf(null);
      if (slot === -1) return refuse('hands-full');
      const next = copy(state), taken = next.items[id as string];
      taken.holder = player; delete taken.at;
      if (slot === 'hand') { taken.status = 'held'; next.carrying[player] = id as string; } else { taken.status = 'packed'; next.packs[player][slot] = id as string; }
      return { state: next, events: [
        { type: 'picked-up', player, item: id as string, kind: item.kind, to: slot },
        { type: 'noise', loudness: item.kind === 'jerry' ? LOUD.jerry : LOUD.fuse, source: 'pickup', ...where },
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
        { type: 'noise', loudness: dropped.kind === 'jerry' ? LOUD.dropJerry : LOUD.dropFuse, source: 'drop', ...(at ? { x: at.x, z: at.z } : { poi: dropped.poi }) },
      ] };
    }
    case 'move': {
      const { from, to } = a as { from?: unknown; to?: unknown };
      if (!hasPack(state, player)) return refuse('no-pack');
      if (!(from === 'hand' || isPackSlot(from)) || !(to === 'hand' || isPackSlot(to)) || from === to) return refuse('bad-slot');
      const at = (s: Slot) => s === 'hand' ? held ?? null : state.packs[player][s];
      const moving = at(from as Slot), other = at(to as Slot);
      if (moving === null) return refuse('empty-slot');
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
      if (state.generator.fuel) return refuse('already-fueled');
      const next = copy(state), used = take(next, player, from);
      next.items[used].status = 'used'; delete next.items[used].holder;
      next.generator.fuel = true; next.phase = phaseOf(next);
      return { state: next, events: [
        { type: 'refueled', player, item: used },
        { type: 'noise', loudness: LOUD.refuel, source: 'refuel', poi: 'generator' },
      ] };
    }
    case 'pull-start': {
      if (state.generator.running) return refuse('already-running');
      if (!state.generator.fuel) return refuse('no-fuel');
      const next = copy(state);
      next.generator.running = true; next.phase = phaseOf(next);
      return { state: next, events: [
        { type: 'generator-started', player },
        { type: 'noise', loudness: LOUD.start, source: 'generator-start', poi: 'generator' },
      ] };
    }
    case 'insert-fuse': {
      const slot = (a as { slot?: unknown }).slot;
      if (!state.generator.running) return refuse('no-power');
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
        { type: 'noise', loudness: LOUD.insert, source: 'fuse-insert', poi: 'hut' },
      ];
      if (next.phase === 'powered' && before !== 'powered') events.push({ type: 'power-restored' });
      return { state: next, events };
    }
    case 'transmit': {
      if (state.phase !== 'powered') return refuse(state.generator.running ? 'not-ready' : 'no-power');
      const next = copy(state);
      next.signalBy = player; next.phase = 'signalSent';
      return { state: next, events: [
        { type: 'signal-sent', player },
        { type: 'noise', loudness: LOUD.radio, source: 'radio', poi: 'hut' },
      ] };
    }
    default:
      return refuse('unknown-action');
  }
}

/** Fold a recorded action list over a state; what a host or late joiner would run. */
export function replay(actions: readonly ObjectiveAction[], from: ObjectiveState = initialState()): Reduction {
  let state = from; const events: ObjectiveEvent[] = [];
  for (const action of actions) { const r = applyAction(state, action); state = r.state; events.push(...r.events); }
  return { state, events };
}
