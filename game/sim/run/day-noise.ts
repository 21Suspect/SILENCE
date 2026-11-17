/**
 * The day's noise log (docs/game-design.md, "The Listener"): where the player was loud, so the creature's night can start
 * at the loudest place of the day, walk the noisy places in order, and so the sleep rule can ask whether a spot was loud today.
 * Pure: the engine calls record() for every noise in the world and dawn() when the day turns.
 *
 * The log must stay small however long the player walks (a footstep every half second for a 24-minute day is thousands of
 * noises), so it keeps three bounded things, none of which grows with the number of noises:
 *  - the peak: the single loudest noise (ties: the latest), exact;
 *  - places: noises merged into spots 30 m across (the faint-grade limit, so a merged spot is one thing to the Listener);
 *    each spot keeps the position and loudness of its loudest member; capped, evicting the faintest and oldest;
 *  - loud spots: only noises of grade loud or above, merged within 2 m, for loudNear's exact-enough radius test.
 * "Loudness" for ordering is the grade's rank: a sustained noise (a generator, hammering) counts as at least 1 (100 m),
 * as noiseGrade does, so it outranks any one-off shout.
 *
 * Rolling: the night after day n uses day n's log ("starting at the loudest place of your day"), so the log is not rolled at
 * dusk or midnight but at the next dawn: dawn() makes today yesterday and starts an empty today. Noises made during the
 * night are added to the same log (they are part of the day that is ending).
 */
import { GRADE, noiseGrade } from '../noise/noise-scale';

export const DAY_NOISE = {
  /** Noises within this many metres of a spot join it: the faint-grade limit. */
  mergeRadius: 30,
  /** Loud noises within this many metres of a remembered one are the same spot for loudNear (a hammer on one nail). */
  loudMergeRadius: 2,
  /** Most spots kept: the Listener's round is never longer than this, and a day of footsteps cannot grow it. */
  maxPlaces: 64,
  /** Most loud spots kept (oldest dropped). */
  maxLoud: 128,
} as const;

export type NoiseRecord = { x: number; z: number; loudness: number; sustained?: boolean; hours: number };
export type NoisePlace = { x: number; z: number; loudness: number; sustained: boolean; hours: number; count: number };
export type DayNoiseState = { today: LogState; yesterday: LogState };
type LogState = { peak: NoisePlace | null; places: NoisePlace[]; loud: NoisePlace[] };

/** Ordering value of a noise: its loudness, but never less than 'very loud' when kept up. */
const rank = (loudness: number, sustained: boolean) => (sustained ? Math.max(loudness, GRADE.loudBelow) : loudness);
const rankOf = (p: NoisePlace) => rank(p.loudness, p.sustained);
const dist2 = (a: { x: number; z: number }, x: number, z: number) => (a.x - x) ** 2 + (a.z - z) ** 2;
const copy = (p: NoisePlace): NoisePlace => ({ ...p });
/** Louder first; equal loudness: the later one. */
const byLoudest = (a: NoisePlace, b: NoisePlace) => rankOf(b) - rankOf(a) || b.hours - a.hours;

function createLog(init?: LogState) {
  let peak: NoisePlace | null = init?.peak ? copy(init.peak) : null;
  const places: NoisePlace[] = init ? init.places.map(copy) : [];
  const loud: NoisePlace[] = init ? init.loud.map(copy) : [];

  const nearest = (list: NoisePlace[], x: number, z: number, r: number) => {
    let best: NoisePlace | null = null, bd = r * r;
    for (const p of list) { const d = dist2(p, x, z); if (d <= bd) { bd = d; best = p; } }
    return best;
  };
  /** A louder-or-equal, later noise takes over the spot's position (ties: the latest), the count always grows. */
  const merge = (p: NoisePlace, n: NoisePlace) => {
    p.count += n.count;
    if (rankOf(n) >= rankOf(p)) { p.x = n.x; p.z = n.z; p.loudness = n.loudness; p.sustained = n.sustained; p.hours = n.hours; }
    else if (n.hours > p.hours) p.hours = n.hours;
  };

  return {
    record(r: NoiseRecord) {
      if (!(r.loudness > 0) || !Number.isFinite(r.x) || !Number.isFinite(r.z)) return;
      const n: NoisePlace = { x: r.x, z: r.z, loudness: r.loudness, sustained: !!r.sustained, hours: r.hours, count: 1 };
      if (!peak || rankOf(n) >= rankOf(peak)) peak = copy(n);
      const spot = nearest(places, n.x, n.z, DAY_NOISE.mergeRadius);
      if (spot) merge(spot, n);
      else {
        places.push(copy(n));
        if (places.length > DAY_NOISE.maxPlaces) {
          // Evict the faintest, and among equals the oldest; the newcomer goes too if it is that one.
          let worst = 0;
          for (let i = 1; i < places.length; i++) { if (byLoudest(places[i], places[worst]) > 0) worst = i; }
          places.splice(worst, 1);
        }
      }
      if (noiseGrade(r.loudness, !!r.sustained) !== 'faint') {
        const l = nearest(loud, n.x, n.z, DAY_NOISE.loudMergeRadius);
        if (l) merge(l, n);
        else { loud.push(copy(n)); if (loud.length > DAY_NOISE.maxLoud) loud.shift(); }
      }
    },
    /** The place of the loudest noise of the day (ties: the latest), or null if there was none. */
    loudest(): NoisePlace | null { return peak ? copy(peak) : null; },
    /** The noisy places, merged, loudest first (ties: the latest), at most `limit`. */
    places(limit: number = DAY_NOISE.maxPlaces): NoisePlace[] { return places.slice().sort(byLoudest).slice(0, Math.max(0, limit)).map(copy); },
    /** Whether a noise of grade loud or above happened within `radius` metres of (x, z). */
    loudNear(x: number, z: number, radius: number) { return loud.some((p) => dist2(p, x, z) <= radius * radius); },
    get size() { return places.length; },
    state(): LogState { return { peak: peak ? copy(peak) : null, places: places.map(copy), loud: loud.map(copy) }; },
  };
}
export type NoiseLog = ReturnType<typeof createLog>;

/** Today's log and yesterday's (kept for the HUD, debugging and the first morning's Listener). */
export function createDayNoise(saved?: DayNoiseState) {
  let today = createLog(saved?.today);
  let yesterday = createLog(saved?.yesterday);
  return {
    /** Log a noise (every one in the world; the log merges and bounds itself). Silent (0) noises are ignored. */
    record: (r: NoiseRecord) => today.record(r),
    loudest: () => today.loudest(),
    places: (limit?: number) => today.places(limit),
    loudNear: (x: number, z: number, radius: number) => today.loudNear(x, z, radius),
    /** Dawn: today becomes yesterday and a new, empty today starts. Call exactly once per dawn event of the run. */
    dawn() { yesterday = today; today = createLog(); },
    /** The log of the day before, read-only use. */
    get yesterday(): NoiseLog { return yesterday; },
    get today(): NoiseLog { return today; },
    state(): DayNoiseState { return { today: today.state(), yesterday: yesterday.state() }; },
    restore(s: DayNoiseState) { today = createLog(s.today); yesterday = createLog(s.yesterday); },
  };
}
export type DayNoise = ReturnType<typeof createDayNoise>;
