import { FUSE_SLOTS, insertedFuses, type ItemKind, type ObjectiveState } from './objectives';

/** What the objective corner says: one short line for the step in hand, and the progress under it. */
export type ObjectiveText = { title: string; detail?: string };
export type ObjectiveTextOptions = {
  /** The key that puts down what is carried, as the player knows it ("Q"). Omitted on touch, where a Drop button is on screen. */
  dropKey?: string;
  /** Whether a pickup would find room (an empty hand, or space in a backpack). Default: only when nothing is in hand. */
  room?: boolean;
};

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const word = (n: number) => WORDS[n] ?? String(n);

/**
 * The current step, read off the real state machine (game/sim/objectives/objectives.ts) and what the local player is carrying:
 * fuel the generator, start it, carry the fuses into the relay hut's fuse box, send the signal from the radio there.
 * Plain and imperative, no lore. `held` is `guideKind(state, me)`: the useful thing carried, in hand or in the backpack.
 */
export function objectiveText(state: ObjectiveState, held?: ItemKind, options: ObjectiveTextOptions = {}): ObjectiveText {
  const inserted = insertedFuses(state), left = FUSE_SLOTS - inserted, fuses = `Fuses ${inserted}/${FUSE_SLOTS}`;
  switch (state.phase) {
    case 'signalSent':
      return { title: 'The signal is sent', detail: 'Stay out of sight' };
    case 'powered':
      return { title: 'Send the signal from the relay hut', detail: fuses };
    case 'running':
      return {
        title: held === 'fuse' ? 'Take the fuse to the relay hut'
          : left === FUSE_SLOTS ? `Find ${word(left)} fuses for the relay hut`
          : left === 1 ? 'Find the last fuse for the relay hut'
          : `Find ${word(left)} more fuses for the relay hut`,
        detail: fuses,
      };
    case 'fueled':
      return { title: 'Start the generator', detail: fuses };
    default:
      // A fuse in hand blocks the jerry can ("Hands full"), and a fuse is no use before there is power.
      if (held === 'fuse' && !options.room) return { title: 'Find fuel for the generator', detail: `Your hands are full: put the fuse down${options.dropKey ? ` (${options.dropKey})` : ''}` };
      return { title: held === 'jerry' ? 'Take the fuel to the generator' : 'Find fuel for the generator', detail: fuses };
  }
}
