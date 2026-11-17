import * as THREE from 'three';
import { BANKS, type BankId, type ItemKind, type ObjectiveAction, type ObjectiveState, type Slot } from '../../sim/objectives/objectives';
import { ITEM_NAME } from './objectives-runtime';
import type { Interaction } from './interaction';

/** What each container is called in a prompt. */
const BANK_NAME: Record<BankId, string> = { chest: 'the chest', relay: 'the crate', pad: 'the crate' };
const lower = (kind: ItemKind) => ITEM_NAME[kind].toLowerCase();

/** The items banked in one container, in the order the parts are listed (item ids are the part ids, in the board's order). */
export function bankedIn(state: ObjectiveState, bank: BankId): string[] {
  return Object.entries(state.items).filter(([, item]) => item.status === 'banked' && item.bank === bank).map(([id]) => id);
}
/** What a player would put in: what is in hand, else the first thing in the backpack. The backpack itself is worn and never offered. */
export function depositable(state: ObjectiveState, player: string): { slot: Slot; id: string; kind: ItemKind } | undefined {
  const held = state.carrying[player];
  if (held !== undefined && state.items[held]) return { slot: 'hand', id: held, kind: state.items[held].kind };
  const pack = state.packs?.[player] ?? [];
  for (let i = 0; i < pack.length; i++) { const id = pack[i]; if (id && state.items[id]) return { slot: i, id, kind: state.items[id].kind }; }
  return undefined;
}

export type ContainerSite = {
  /** Where the prompt to put something in aims (the lid) and where the prompt to take something out aims (the front). Look at the lid, or at the side. */
  lid: THREE.Vector3; front: THREE.Vector3;
};
export type ContainersOptions = {
  interaction: Pick<Interaction, 'register'>;
  state: () => ObjectiveState;
  dispatch: (action: ObjectiveAction) => unknown;
  me: string;
  sites: Partial<Record<BankId, ContainerSite>>;
};

/**
 * The chest in the cabin and the crates at the relay hut and the landing pad: "Put the jerry can in the chest" and "Take the bulbs".
 * Each container has two prompts a little apart, the lid to put something in and the side to take something out, so that a player
 * holding a part and wanting another one can do either. Banked parts are not drawn; the prompt counts them, and the board lists them.
 */
export function createContainers(o: ContainersOptions) {
  const disposers: (() => void)[] = [];
  for (const bank of BANKS) {
    const site = o.sites[bank]; if (!site) continue;
    disposers.push(o.interaction.register({
      id: `bank:${bank}:put`, position: site.lid, range: 2.4,
      label: () => { const d = depositable(o.state(), o.me); return d ? `Left click to put the ${lower(d.kind)} in ${BANK_NAME[bank]}` : ''; },
      enabled: () => depositable(o.state(), o.me) !== undefined,
      activate: () => { const d = depositable(o.state(), o.me); if (d) o.dispatch({ type: 'deposit', player: o.me, bank, slot: d.slot }); },
    }));
    const next = () => { const s = o.state(), id = bankedIn(s, bank)[0]; return id ? { id, kind: s.items[id].kind, count: bankedIn(s, bank).length } : undefined; };
    disposers.push(o.interaction.register({
      id: `bank:${bank}:take`, position: site.front, range: 2.4,
      label: () => {
        const n = next(), s = o.state(); if (!n) return '';
        const room = s.carrying[o.me] === undefined || (n.kind !== 'jerry' && (s.packs?.[o.me] ?? []).includes(null));
        if (!room) return 'Hands full';
        return `Left click to take the ${lower(n.kind)} from ${BANK_NAME[bank]}${n.count > 1 ? ` (${n.count} inside)` : ''}`;
      },
      enabled: () => next() !== undefined,
      activate: () => { const n = next(); if (n) o.dispatch({ type: 'withdraw', player: o.me, bank, item: n.id }); },
    }));
  }
  return { dispose() { for (const d of disposers) d(); disposers.length = 0; } };
}
export type Containers = ReturnType<typeof createContainers>;
