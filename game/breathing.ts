/**
 * The player's heavy breathing, driven by stamina (game/stamina.ts) rather than by a held key. This file decides *when* a
 * breath happens and *what shape* it has; game/audio.ts only turns that shape into sound. Keeping the two apart means the
 * timing, loudness and irregularity can be tested without an audio context.
 *
 * A breath is an inhale and an exhale of band-passed noise, never an oscillator, so nothing in it has a pitch to squeak:
 *  - the inhale is thinner and brighter (a mouth drawing air in), swelling for most of its length and then stopping short;
 *  - the exhale is lower and rounder, with a quick onset and a long tail, its colour sinking as the air runs out;
 *  - every breath differs a little: its length, its loudness, its colour, a small wobble in the envelope, and now and then
 *    a hitch before the next one.
 * It begins quietly when stamina gets low, is heavy and quick at empty, and eases off (slowly, so it lingers) as the
 * stamina comes back.
 */

export type BreathBand = {
  /** Centre frequency, Hz. */
  frequency: number;
  /** Kept at about 1 or below: broad bands, so the noise reads as air and never rings as a note. */
  q: number;
  gain: number;
};
export type BreathSegment = {
  /** Seconds after the breath begins. */
  delay: number;
  duration: number;
  /** High-pass corner, Hz: keeps rumble out of the air noise. */
  highpass: number;
  bands: readonly BreathBand[];
  /** The ratio the bands' centre frequencies glide by over the segment (above 1 rising, below 1 falling). */
  sweep: number;
  /** Gain envelope, evenly spaced over `duration`, for setValueCurveAtTime. Starts and ends at zero; its top is the loudest the segment gets. */
  curve: Float32Array;
};
export type Breath = {
  /** How hard it is (0..1): 0 a first quiet breath, 1 gasping. */
  effort: number;
  inhale: BreathSegment;
  exhale: BreathSegment;
  /** Seconds from this breath's start to the start of the next: the whole cycle, including the pause. */
  length: number;
};

export const BREATH = {
  /** Above this much stamina there is no breathing to hear. Below it, it comes in gradually. */
  begin: .45,
  /** While locked out of sprinting the breathing is at least this heavy. */
  windedFloor: .85,
  /** Time constants (s) for the breathing to build up, and to ease off again. Easing off is slower, so it lingers. */
  rise: .9,
  fall: 2.4,
  /** Below this level no new breath starts (one already begun is always finished). */
  min: .03,
  /** Seconds for a whole breath at the quietest and at the heaviest. */
  slowPeriod: 3.6,
  fastPeriod: 1.3,
  /**
   * Loudest point of the envelope, as a gain on the band-passed noise, at full effort. An offline render of these shapes puts a gasping
   * breath at about -33 dBFS RMS (peaks near -23) before the master gain, and the first quiet ones near -40: under the footsteps and
   * far under the creature's calls, so the creature is heard over it.
   */
  inhalePeak: .06,
  exhalePeak: .08,
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** How much breathing the current stamina calls for, 0..1, before easing. */
export function breathNeed(stamina: number, winded: boolean, tuning = BREATH) {
  const t = clamp01((tuning.begin - (Number.isFinite(stamina) ? stamina : 1)) / tuning.begin);
  const need = t * t * (3 - 2 * t);
  return winded ? Math.max(need, tuning.windedFloor) : need;
}

// One half-cycle of air: rises to its peak at `peakAt` (0..1 of the segment) and falls to nothing, each side with its own bend.
const swell = (t: number, peakAt: number, rise: number, fall: number) =>
  t < peakAt ? Math.pow(Math.sin(Math.PI / 2 * t / peakAt), rise) : Math.pow(Math.max(0, Math.cos(Math.PI / 2 * (t - peakAt) / (1 - peakAt))), fall);

/** Smooth random wobble: random values spread along the segment and joined with cosine curves. Returns -1..1. */
function wobble(random: () => number, duration: number) {
  const points = Array.from({ length: Math.max(3, Math.ceil(duration * 7) + 1) }, () => random() * 2 - 1);
  return (t: number) => {
    const x = t * (points.length - 1), i = Math.min(points.length - 2, Math.floor(x)), f = (1 - Math.cos((x - i) * Math.PI)) / 2;
    return lerp(points[i], points[i + 1], f);
  };
}

function curve(random: () => number, duration: number, peak: number, shape: { peakAt: number; rise: number; fall: number }, flutter: number) {
  const n = Math.max(24, Math.min(200, Math.round(duration * 120))), noise = wobble(random, duration), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = peak * swell(t, shape.peakAt, shape.rise, shape.fall) * (1 + flutter * noise(t));
  }
  out[0] = 0; out[n - 1] = 0;
  return out;
}

/** One breath at the given effort (0..1), with its own random irregularities. */
export function makeBreath(effort: number, random: () => number = Math.random, tuning = BREATH): Breath {
  const level = clamp01(effort);
  const jitter = (spread: number) => 1 + (random() * 2 - 1) * spread;
  // A hitch, now and then, before the next breath: more often when it is hard.
  const hitch = random() < .08 + .16 * level ? .15 + random() * .3 : 0;
  const period = lerp(tuning.slowPeriod, tuning.fastPeriod, level) * jitter(.14);
  const inhaleLength = period * (.34 + .04 * level + (random() - .5) * .05), exhaleLength = period * (.46 - .02 * level + (random() - .5) * .05);
  // Soft at the start, then up to full: the first breaths are barely there, and the loudness never beats the cap.
  const strength = lerp(.4, 1, Math.pow(level, .8)) * jitter(.15);
  // Heavier breathing is a little brighter, as the air moves faster. Each breath's colour drifts a few percent.
  const bright = 1 + .2 * level, colour = () => jitter(.06);
  const inhale: BreathSegment = {
    delay: 0, duration: inhaleLength, highpass: 380,
    bands: [
      { frequency: 1000 * bright * colour(), q: .8, gain: 1 },
      { frequency: 2800 * bright * colour(), q: 1, gain: .75 },
    ],
    sweep: 1.18,
    curve: curve(random, inhaleLength, tuning.inhalePeak * strength, { peakAt: .6, rise: 1.3, fall: .9 }, .08 + .1 * level),
  };
  const exhale: BreathSegment = {
    delay: inhaleLength + .05, duration: exhaleLength, highpass: 150,
    bands: [
      { frequency: 480 * (1 + .1 * level) * colour(), q: .9, gain: 1 },
      { frequency: 1250 * bright * colour(), q: .9, gain: .65 },
      { frequency: 2500 * bright * colour(), q: 1, gain: .2 },
    ],
    sweep: .7,
    curve: curve(random, exhaleLength, tuning.exhalePeak * strength * jitter(.1), { peakAt: .16, rise: .8, fall: 1.5 }, .08 + .1 * level),
  };
  return { effort: level, inhale, exhale, length: period + hitch };
}

export type BreathingInput = {
  /** 0..1 (game/stamina.ts). */
  stamina: number;
  /** Locked out of sprinting. */
  winded: boolean;
};

/**
 * Steps with the game's frames. `level` is the eased amount of breathing (0..1); `breath` is set only on the frame a new
 * breath starts, and the caller plays the whole of it from that moment. A breath is never cut off and the next one never
 * starts before the last has finished.
 */
export function createBreathing(random: () => number = Math.random, tuning = BREATH) {
  let level = 0, untilNext = 0;
  return {
    update(dt: number, { stamina, winded }: BreathingInput): { level: number; breath: Breath | undefined } {
      dt = Math.max(0, Math.min(.1, dt));
      const target = breathNeed(stamina, winded, tuning);
      level += (target - level) * (1 - Math.exp(-dt / (target > level ? tuning.rise : tuning.fall)));
      untilNext -= dt;
      let breath: Breath | undefined;
      if (level > tuning.min && untilNext <= 0) {
        breath = makeBreath(level, random, tuning);
        untilNext = breath.length;
      }
      return { level, breath };
    },
    get level() { return level; },
  };
}
