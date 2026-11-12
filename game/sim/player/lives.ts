/**
 * Three lives, as a pure reducer, and the timing of being taken. No DOM, no clock: game/core/engine.ts feeds it.
 *
 * Being caught costs a life: the player wakes at the cabin with the night further along, and whatever they were
 * carrying lies where they fell. The third time it keeps them and the night starts again.
 */
export const LIVES = 3;
/** Game hours that pass while the player lies senseless (45 minutes). */
export const RESPAWN_ADVANCE_HOURS = .75;
/** The evening a restarted night begins at, as at the start of the game. */
export const NIGHT_START_HOURS = 16;

export type LivesState = { remaining: number; deaths: number; gameOver: boolean };
export type DeathOutcome = 'respawn' | 'game-over';

export const initialLives = (lives = LIVES): LivesState => ({ remaining: lives, deaths: 0, gameOver: false });

/** Never mutates. A death after game over changes nothing. */
export function loseLife(state: LivesState): { state: LivesState; outcome: DeathOutcome } {
  if (state.gameOver) return { state, outcome: 'game-over' };
  const remaining = Math.max(0, state.remaining - 1);
  return { state: { remaining, deaths: state.deaths + 1, gameOver: remaining === 0 }, outcome: remaining === 0 ? 'game-over' : 'respawn' };
}

/** The clock after waking, wrapped to 0-24. */
export const respawnHours = (hours: number) => ((hours + RESPAWN_ADVANCE_HOURS) % 24 + 24) % 24;

/** The text card on black. Lives are told in words, never shown as a HUD. */
export function deathCard(state: LivesState, outcome: DeathOutcome): { title: string; line: string } {
  if (outcome === 'game-over') return { title: 'It kept you.', line: 'The night begins again.' };
  return { title: 'It let you go.', line: state.remaining === 1 ? 'Once more.' : state.remaining === 2 ? 'Twice more.' : `${state.remaining} more times.` };
}

/** Seconds into being taken at which each thing happens. */
export const GRAB = {
  /** The camera is turned to its face over this long: quick, but a turn the eye can follow. */
  wrench: .45,
  /** The camera is dragged in toward its face from pullFrom until the cut, and stops this far short of it (metres). */
  pullFrom: .3, standOff: .66,
  /** Hard cut to black, with the face filling the view. */
  black: 1.0,
  /** While black: drop the player at the cabin and move the creature away. */
  respawn: 1.6,
  /** The card fades in, holds, and fades out. */
  cardIn: 1.9, cardHold: 4.6, cardOut: 5.3,
  /** Eyes open: the black lifts. */
  wake: 5.5, done: 7,
} as const;

/** What the screen shows at time t of a grab: wrench 0-1, black 0-1 (1 is solid), card 0-1. */
export function grabTimeline(t: number) {
  const ramp = (v: number, a: number, b: number) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  return {
    wrench: ramp(t, 0, GRAB.wrench),
    black: t < GRAB.black ? 0 : t < GRAB.wake ? 1 : 1 - ramp(t, GRAB.wake, GRAB.done),
    card: t < GRAB.cardIn ? 0 : t < GRAB.cardHold ? ramp(t, GRAB.cardIn, GRAB.cardIn + .6) : 1 - ramp(t, GRAB.cardHold, GRAB.cardOut),
    respawn: t >= GRAB.respawn,
    done: t >= GRAB.done,
  };
}
