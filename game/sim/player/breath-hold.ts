/**
 * Holding the breath: the one thing the player can do to be quiet when the Listener is close. Pure, stepped once a frame by the
 * engine, so the rules are testable without audio (the sound of the breath itself is game/sim/player/breathing.ts).
 *
 * Breathing is a noise (docs/game-design.md, "The Listener"): at rest it hears you within 3 m (NOISE.breath, .03). Held, nothing.
 * The rules, in plain words:
 *  - Held while the key is down, for up to 8 s. 8 s is long enough to let a creature walk past at a few metres, short enough that
 *    it cannot be used as a standing shield.
 *  - When winded (stamina's `exhausted`) the limit is 3 s: the lungs are already empty.
 *  - Reaching the limit releases it by force with a gasp. The gasp is one loud noise (NOISE.walkStep, 22 m): faint by the scale's
 *    grade, so it draws a head-turn rather than a charge, but well over the 3 m of plain breathing, so holding to the very end
 *    next to it is a bet, not a free pass.
 *  - Letting go (or being forced) is followed by a recovery in which it cannot be held again: 2 s after a normal release, 4 s
 *    after a gasp. After a gasp the key must also be let go and pressed again, so a key held down does not re-hold the moment
 *    the recovery ends.
 */
import { NOISE } from '../noise/noise-scale';

export type BreathHoldTuning = {
  /** Seconds the breath can be held, rested and winded. */
  holdSeconds: number;
  windedSeconds: number;
  /** Seconds before it can be held again, after a normal release and after a gasp. */
  recoverSeconds: number;
  gaspRecoverSeconds: number;
  /** Heard within (hundreds of metres): ordinary breathing, and the gasp. */
  breathNoise: number;
  gaspNoise: number;
};

export const BREATH_HOLD: Readonly<BreathHoldTuning> = {
  holdSeconds: 8,
  windedSeconds: 3,
  recoverSeconds: 2,
  gaspRecoverSeconds: 4,
  breathNoise: NOISE.breath,
  gaspNoise: NOISE.walkStep,
};

export type BreathHoldState = {
  /** The breath is held right now: draw no breathing, emit nothing. */
  held: boolean;
  /** Seconds of breath left while held; 0 when not held. */
  left: number;
  /** True only on the one frame a hold ends by force: play the gasp and emit `noise`. */
  gasp: boolean;
  /** Seconds until it can be held again (0 when it can). */
  recovering: number;
  /** The noise to emit this frame, as a loudness: the gasp on its frame, else the breathing (0 while held). */
  noise: number;
};

const MAX_STEP = .1;

export function createBreathHold(tuning: BreathHoldTuning = BREATH_HOLD) {
  let held = false, heldFor = 0, recovering = 0, needsRelease = false, gasp = false;
  const limit = (winded: boolean) => (winded ? tuning.windedSeconds : tuning.holdSeconds);
  const loudness = () => (held ? 0 : tuning.breathNoise);
  const state = (winded = false): BreathHoldState => ({
    held, left: held ? Math.max(0, limit(winded) - heldFor) : 0, gasp, recovering,
    noise: gasp ? tuning.gaspNoise : loudness(),
  });
  return {
    /** Advance by `dt` seconds. `wantsHold` is the key being down; `winded` is stamina's `exhausted`. A zero `dt` changes nothing. */
    update(dt: number, wantsHold: boolean, winded = false): BreathHoldState {
      if (!(dt > 0)) { gasp = false; return state(winded); }
      dt = Math.min(dt, MAX_STEP);
      gasp = false;
      if (!wantsHold) needsRelease = false;
      if (held) {
        if (!wantsHold) { held = false; heldFor = 0; recovering = tuning.recoverSeconds; }
        else {
          heldFor += dt;
          if (heldFor >= limit(winded)) { held = false; heldFor = 0; gasp = true; needsRelease = true; recovering = tuning.gaspRecoverSeconds; }
        }
      } else {
        recovering = Math.max(0, recovering - dt);
        if (wantsHold && recovering <= 0 && !needsRelease) { held = true; heldFor = dt; }
      }
      return state(winded);
    },
    /** The loudness of the breathing now (0 while held), for callers that do not step this model. */
    get loudness() { return loudness(); },
    /** Waking up: breathing normally, nothing held. */
    reset() { held = false; heldFor = 0; recovering = 0; needsRelease = false; gasp = false; },
    get state() { return state(); },
  };
}

export type BreathHold = ReturnType<typeof createBreathHold>;
