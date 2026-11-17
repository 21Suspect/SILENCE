/**
 * When each of the Listener's eight feet steps: shared by the gait (spider-gait.ts, which places the legs) and the soundboard
 * (tools/sounds/creature.js, which plays what that rhythm sounds like), so they cannot drift apart. Pure.
 *
 * Measured on running spiders (Weihmann 2013, Cupiennius salei, PLoS ONE 8:e65788, table 3): opposite legs of a pair step half a
 * cycle apart, and so do neighbouring legs on a side, which makes the alternating tetrapods L1 R2 L3 R4 against R1 L2 R3 L4.
 * But the eight legs are two loosely joined groups. The hind legs (3, 4) keep that pattern tightly (coupling .88, scatter .06 to .08
 * of a cycle); the front legs (1, 2) keep it among themselves (.54) but drift against the hind ones (.07 to .11: near uniform),
 * cycling a little slower and now and then missing a contact. Within a tetrapod the mean landings are almost together (leg 2 .02
 * of a cycle after leg 4), spread by the scatter; small running spiders overlap only .3 of their stance within a set (Spagna 2011).
 *
 * Heard, that is the spider: a steady double patter from the hind legs with the front ones flamming over it, never quite on the
 * beat, and never the clean "da-dum" of two sets landing as one (which is how the first gait sounded: like a horse). The rhythm is
 * the tetrapods, a short wave from the back forward in each, one side a touch behind, and a slow wander per leg and for the front
 * group (createRhythmWander), all in phase, so a wandering leg is late or early but never steps twice or not at all.
 */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const RHYTHM = {
  /** The wave along a side within a tetrapod, in cycles from one leg to the one in front of it: hind first. Wide enough that a set's
   * four feet spread over a third of a step and the two sets run into each other: heard, a flow of feet, not a beat with gaps. */
  waveWalk: .1, waveRun: .08,
  /** The right side lands this much of a cycle after the left (Weihmann: contralateral 4th legs at .48 rather than .5). */
  sideLag: .03,
  /** How far each hind leg (3, 4) and each front leg (1, 2) wanders on its own, cycles either way; the measured scatter. */
  hindScatter: .05, frontScatter: .08,
  /** How far the front group as a whole drifts against the hind one, cycles either way. */
  frontDrift: .18,
  /** Each step on top of that is early or late by up to this, drawn afresh every step (kick): no two cycles alike. The measured
   * circular SDs are .06 to .08 for the hind legs and .15 to .22 for the front ones, of which the wander above is the slow part. */
  stepHind: .06, stepFront: .1,
  /** How long, in cycles, a wander holds a course before turning to a new one, and how quickly it follows it. */
  hold: [1.2, 2.6] as const, follow: .9,
  /** Stride (metres per cycle) at a walk and at a run. Tarantulas run faster by stepping faster, not longer (Brachypelma keeps its
   * stride); a short run stride is what makes a charge a drum roll of feet rather than a lope: 4.5 steps a second per leg at 11 m/s. */
  strideWalk: 1.15, strideRun: 2.5,
};

/** How far into a run the body is (0 a walk, 1 a run), from the speed its legs carry, m/s. */
export const runShare = (carried: number) => sstep(carried, 1.4, 6.5);
/** Metres a foot travels per cycle at that share of a run. */
export const strideAt = (run: number) => lerp(RHYTHM.strideWalk, RHYTHM.strideRun, run);
/** The share of a cycle a foot is down at the speed its legs carry: .78 creeping, .56 trotting, .5 at a full charge (the point
 * below which a small spider's run has moments with no foot down; Hololena's duty falls linearly with speed). */
export const dutyAt = (carried: number) => lerp(.78, .56, sstep(carried, .8, 6)) - .06 * sstep(carried, 6, 13);

/**
 * A leg's phase shift (cycles): its tetrapod (0 or .5), the wave from the back (index 3 calls first) to the front, and the right side's
 * lag. A larger shift calls the leg earlier in the cycle. `wander` (createRhythmWander) adds the scatter.
 */
export function legShift(index: number, side: number, run: number, wander?: RhythmWander) {
  const set = ((index + (side > 0 ? 1 : 0)) % 2) * .5;
  return set + index * lerp(RHYTHM.waveWalk, RHYTHM.waveRun, run) - (side > 0 ? RHYTHM.sideLag : 0) + (wander ? wander.shift(index, side) : 0);
}

/**
 * The gait's timing at a ground speed, as spider-gait.ts works it out on open ground: the share of a cycle a foot is down (duty),
 * the steps a second per leg (frequency) and how long a swing lasts. The gait's own frequency also follows the room each leg has
 * and the fastest-carried leg; `scale` stands in for that (the open-ground value, for the soundboard and tests).
 */
export function gaitTiming(speed: number, scale = .92) {
  const run = runShare(speed), stride = strideAt(run) * scale;
  const duty = dutyAt(speed);
  const frequency = Math.max(.45, speed / stride);
  const swing = Math.min(Math.max((1 - duty) / frequency * .94, lerp(.16, .085, sstep(speed, 5, 13))), lerp(.5, .28, sstep(speed, .8, 6)));
  return { run, duty, frequency, swing };
}

/** A small seeded generator (mulberry32), so a gait's wander is the same on every run of a test. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RhythmWander = ReturnType<typeof createRhythmWander>;

/**
 * The scatter in a spider's rhythm: each leg wanders a little early or late, and the front legs as a group drift against the hind
 * ones. Advanced in cycles, not seconds, so it is the same at every speed and stands still when the legs do. Each wander eases
 * toward a target redrawn every one to three cycles; at most it moves a few tenths of a cycle per cycle, so a leg is called once a
 * cycle whatever it does (the gait counts a step when the leg's phase crosses a whole cycle).
 */
export function createRhythmWander(seed = 7) {
  const random = seeded(seed);
  // Slots 0-7: a leg (index + 4 on the right side); slot 8: the front group.
  const value = new Float64Array(9), target = new Float64Array(9), left = new Float64Array(9), step = new Float64Array(8);
  const reach = (slot: number) => slot === 8 ? RHYTHM.frontDrift : (slot % 4) < 2 ? RHYTHM.frontScatter : RHYTHM.hindScatter;
  for (let i = 0; i < 9; i++) { target[i] = (random() * 2 - 1) * reach(i); value[i] = target[i]; left[i] = lerp(RHYTHM.hold[0], RHYTHM.hold[1], random()); }
  return {
    /** Move the wander on by this many cycles of the gait. */
    advance(cycles: number) {
      if (!(cycles > 0)) return;
      const k = 1 - Math.exp(-cycles / RHYTHM.follow);
      for (let i = 0; i < 9; i++) {
        left[i] -= cycles;
        if (left[i] <= 0) { left[i] += lerp(RHYTHM.hold[0], RHYTHM.hold[1], random()); target[i] = (random() * 2 - 1) * reach(i); }
        value[i] += (target[i] - value[i]) * k;
      }
    },
    /** The extra shift (cycles) of a leg now: its own scatter, this step's jitter, and the front group's drift for legs 1 and 2. */
    shift(index: number, side: number) { const slot = index + (side > 0 ? 4 : 0); return value[slot] + step[slot] + (index < 2 ? value[8] : 0); },
    /**
     * A leg has just been called: draw its jitter for the next step. The shift jumps, but the gait counts calls against a mark that
     * never moves back (spider-gait.ts), so a leg made later waits and one made earlier is called sooner, never twice or not at all.
     */
    kick(index: number, side: number) { step[index + (side > 0 ? 4 : 0)] = (random() * 2 - 1) * (index < 2 ? RHYTHM.stepFront : RHYTHM.stepHind); },
  };
}

/** The legs (0-7: index 0-3 front to back, side -1 left, +1 right) in the order the soundboard lists them. */
export const LEGS = [-1, 1].flatMap(side => [0, 1, 2, 3].map(index => ({ index, side })));
