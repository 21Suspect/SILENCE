/**
 * The first gameplay loop as a pure, deterministic reducer: no three.js, no DOM,
 * no clock, no randomness. Actions are plain JSON, so a host can replay the same
 * list on every client and arrive at the same state (and the same events).
 *
 * Fetch a jerry can, fuel and pull-start the relay generator (loud), carry three
 * fuses into the hut's fuse box while it runs, then transmit.
 */
export type PlayerId = string;
export type ItemKind = 'fuse' | 'jerry';
export type Item = {
  kind: ItemKind;
  /** Asset name of the place it sits at (matches game/world-assets.json). */
  poi: string;
  status: 'world' | 'held' | 'used';
  holder?: PlayerId;
  /** Set when a player put it down somewhere other than its home. */
  at?: { x: number; z: number; y?: number };
};
export type Phase = 'gather' | 'fueled' | 'running' | 'powered' | 'signalSent';
export type ObjectiveState = {
  items: Record<string, Item>;
  carrying: Record<PlayerId, string>;
  generator: { fuel: boolean; running: boolean };
  /** Item id per fuse-box slot, null while empty. */
  fuseBox: (string | null)[];
  signalBy: PlayerId | null;
  phase: Phase;
};

export type ObjectiveAction =
  | { type: 'pickup'; player: PlayerId; item: string }
  /** Without this a player who grabbed a fuse first could never lift the jerry can. */
  | { type: 'drop'; player: PlayerId; at?: { x: number; z: number; y?: number } }
  | { type: 'refuel'; player: PlayerId }
  | { type: 'pull-start'; player: PlayerId }
  | { type: 'insert-fuse'; player: PlayerId; slot: number }
  | { type: 'transmit'; player: PlayerId };

export type RefusalReason =
  | 'unknown-action' | 'unknown-item' | 'unavailable' | 'hands-full' | 'empty-hands' | 'wrong-item'
  | 'already-fueled' | 'no-fuel' | 'already-running' | 'no-power' | 'bad-slot' | 'slot-taken'
  | 'not-ready' | 'complete';

export type ObjectiveEvent =
  /** What the creature AI listens to. The reducer knows places by name only; the runtime adds x/z. */
  | { type: 'noise'; loudness: number; source: string; poi?: string; x?: number; z?: number }
  | { type: 'picked-up'; player: PlayerId; item: string; kind: ItemKind }
  | { type: 'dropped'; player: PlayerId; item: string; kind: ItemKind; at?: { x: number; z: number; y?: number } }
  | { type: 'refueled'; player: PlayerId; item: string }
  | { type: 'generator-started'; player: PlayerId }
  | { type: 'fuse-inserted'; player: PlayerId; item: string; slot: number; inserted: number }
  | { type: 'power-restored' }
  | { type: 'signal-sent'; player: PlayerId }
  | { type: 'refused'; action: string; player?: PlayerId; reason: RefusalReason };

export const FUSE_SLOTS = 3;

export function initialState(): ObjectiveState {
  return {
    items: {
      'fuse-mine': { kind: 'fuse', poi: 'mine', status: 'world' },
      'fuse-lookout': { kind: 'fuse', poi: 'lookout', status: 'world' },
      'fuse-logstack': { kind: 'fuse', poi: 'logstack', status: 'world' },
      'jerry-camp': { kind: 'jerry', poi: 'camp', status: 'world' },
    },
    carrying: {},
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
export const insertedFuses = (state: ObjectiveState): number => state.fuseBox.filter(Boolean).length;

// Loudness is what a creature a hundred metres away could plausibly hear: 1 is the generator roaring awake.
const LOUD = { fuse: .08, jerry: .2, dropFuse: .12, dropJerry: .35, refuel: .35, start: .95, insert: .22, radio: .65 };

const phaseOf = (s: ObjectiveState): Phase =>
  s.signalBy !== null ? 'signalSent'
  : s.generator.running ? (insertedFuses(s) === FUSE_SLOTS ? 'powered' : 'running')
  : s.generator.fuel ? 'fueled' : 'gather';

const copy = (s: ObjectiveState): ObjectiveState => ({
  items: Object.fromEntries(Object.entries(s.items).map(([id, item]) => [id, { ...item }])),
  carrying: { ...s.carrying },
  generator: { ...s.generator },
  fuseBox: s.fuseBox.slice(),
  signalBy: s.signalBy,
  phase: s.phase,
});

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
  const held = state.carrying[player], holding = held === undefined ? undefined : state.items[held];

  switch (a.type) {
    case 'pickup': {
      const id = (a as { item?: unknown }).item, item = typeof id === 'string' && Object.hasOwn(state.items, id) ? state.items[id] : undefined;
      if (!item) return refuse('unknown-item');
      if (item.status !== 'world') return refuse('unavailable');
      if (held !== undefined) return refuse('hands-full');
      const next = copy(state), taken = next.items[id as string];
      taken.status = 'held'; taken.holder = player; delete taken.at; next.carrying[player] = id as string;
      return { state: next, events: [
        { type: 'picked-up', player, item: id as string, kind: item.kind },
        { type: 'noise', loudness: item.kind === 'jerry' ? LOUD.jerry : LOUD.fuse, source: 'pickup', ...(item.at ? { x: item.at.x, z: item.at.z } : { poi: item.poi }) },
      ] };
    }
    case 'drop': {
      if (held === undefined || !holding) return refuse('empty-hands');
      const raw = (a as { at?: { x?: unknown; z?: unknown; y?: unknown } }).at;
      // y is where the player's feet were: on a cabin floor that is above the terrain beneath it.
      const at = raw && Number.isFinite(raw.x) && Number.isFinite(raw.z) ? { x: raw.x as number, z: raw.z as number, ...(Number.isFinite(raw.y) ? { y: raw.y as number } : {}) } : undefined;
      const next = copy(state), dropped = next.items[held];
      dropped.status = 'world'; delete dropped.holder; if (at) dropped.at = at; delete next.carrying[player];
      return { state: next, events: [
        { type: 'dropped', player, item: held, kind: dropped.kind, ...(at ? { at } : {}) },
        { type: 'noise', loudness: dropped.kind === 'jerry' ? LOUD.dropJerry : LOUD.dropFuse, source: 'drop', ...(at ? { x: at.x, z: at.z } : { poi: dropped.poi }) },
      ] };
    }
    case 'refuel': {
      if (holding?.kind !== 'jerry' || held === undefined) return refuse('wrong-item');
      if (state.generator.fuel) return refuse('already-fueled');
      const next = copy(state);
      next.items[held].status = 'used'; delete next.items[held].holder; delete next.carrying[player];
      next.generator.fuel = true; next.phase = phaseOf(next);
      return { state: next, events: [
        { type: 'refueled', player, item: held },
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
      if (holding?.kind !== 'fuse' || held === undefined) return refuse('wrong-item');
      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= FUSE_SLOTS) return refuse('bad-slot');
      if (state.fuseBox[slot] !== null) return refuse('slot-taken');
      const next = copy(state);
      next.items[held].status = 'used'; delete next.items[held].holder; delete next.carrying[player];
      next.fuseBox[slot] = held;
      const before = next.phase; next.phase = phaseOf(next);
      const events: ObjectiveEvent[] = [
        { type: 'fuse-inserted', player, item: held, slot, inserted: insertedFuses(next) },
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
