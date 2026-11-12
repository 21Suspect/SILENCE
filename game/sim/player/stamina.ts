/**
 * Sprint stamina: a small pure model that the engine steps once a frame (game/core/engine.ts), so the rules can be tested
 * without a renderer. It owns three things: how much breath the player has left, whether they may sprint right now, and
 * a 0..1 "sprint blend" that eases in and out so speed and field of view never jump.
 *
 * The rules, in plain words:
 *  - Sprinting drains stamina; standing or walking refills it (standing faster).
 *  - Running dry drops the player to a walk, and they cannot sprint again until a modest share has come back. That
 *    lockout is one flag with two different thresholds (empty to start it, `resumeAt` to end it), so a stamina value
 *    sitting right at the line cannot flicker between sprinting and walking.
 *  - "Sprinting" means actually moving fast on purpose: the key held, the legs moving, and stamina available. Holding
 *    the key while standing still or against a wall is not sprinting and costs nothing.
 */

export type StaminaTuning = {
  /** Metres per second at a walk and at a full sprint. The creature approaches at 4.6 and charges at 8.5. */
  walkSpeed: number;
  sprintSpeed: number;
  /** Seconds of unbroken sprinting from full to empty. */
  drainSeconds: number;
  /** Seconds to refill from empty to full while walking, and while standing still. */
  walkRefillSeconds: number;
  standRefillSeconds: number;
  /** After running dry, the fraction (0..1) that must be back before sprinting is allowed again. */
  resumeAt: number;
  /** Measured speed (m/s) above which the player counts as moving rather than standing. */
  movingSpeed: number;
  /** Degrees of extra field of view at full sprint. */
  fovBoost: number;
  /** Seconds the sprint blend takes to go from 0 to 1 when sprinting starts, and from 1 to 0 when it stops. */
  blendIn: number;
  blendOut: number;
};

export const STAMINA: Readonly<StaminaTuning> = {
  walkSpeed: 1.8,
  sprintSpeed: 5.6,
  drainSeconds: 9,
  walkRefillSeconds: 14,
  standRefillSeconds: 8,
  resumeAt: .25,
  movingSpeed: .6,
  fovBoost: 7,
  blendIn: .25,
  blendOut: .4,
};

export type StaminaState = {
  /** 1 full, 0 empty. */
  value: number;
  /** Out of breath: sprinting is locked until `resumeAt` has been refilled. */
  exhausted: boolean;
  /** True only on frames where the player really is sprinting; this is what the creature is told. */
  sprinting: boolean;
  /** 0..1, eased: 0 at a walk, 1 at a full sprint. Drives speed (gaitSpeed) and field of view (sprintFov). */
  blend: number;
};

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The ground speed the player is steering towards, between a walk and a sprint. Movement still eases towards it. */
export const gaitSpeed = (blend: number, tuning: StaminaTuning = STAMINA) => tuning.walkSpeed + (tuning.sprintSpeed - tuning.walkSpeed) * smooth(clamp01(blend));
/** Extra degrees of field of view for a given sprint blend. */
export const sprintFov = (blend: number, tuning: StaminaTuning = STAMINA) => tuning.fovBoost * smooth(clamp01(blend));

export function createStamina(tuning: StaminaTuning = STAMINA) {
  let value = 1, exhausted = false, sprinting = false, blend = 0;
  const state = (): StaminaState => ({ value, exhausted, sprinting, blend });
  return {
    /**
     * Advance by `dt` seconds. `wantsSprint` is whether the player is asking to sprint and is allowed to in principle (the
     * engine leaves it false while crouching, flying, climbing or taken); `speed` is how fast they actually moved last
     * frame, in m/s. A zero `dt` (paused) changes nothing.
     */
    update(dt: number, wantsSprint: boolean, speed: number): StaminaState {
      if (!(dt > 0)) return state();
      dt = Math.min(dt, .1);
      const moving = speed > tuning.movingSpeed;
      sprinting = wantsSprint && moving && !exhausted && value > 0;
      if (sprinting) {
        value -= dt / tuning.drainSeconds;
        // Dry: walk from this frame on, and stay walking until a modest share has come back.
        if (value <= 0) { value = 0; exhausted = true; sprinting = false; }
      } else {
        value = Math.min(1, value + dt / (moving ? tuning.walkRefillSeconds : tuning.standRefillSeconds));
        if (exhausted && value >= tuning.resumeAt) exhausted = false;
      }
      blend = clamp01(blend + (sprinting ? dt / tuning.blendIn : -dt / tuning.blendOut));
      return state();
    },
    /** Full stamina, walking: after waking up at the cabin or starting the night again. */
    reset() { value = 1; exhausted = false; sprinting = false; blend = 0; },
    get state() { return state(); },
  };
}

export type Stamina = ReturnType<typeof createStamina>;
