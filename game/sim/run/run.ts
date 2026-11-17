/**
 * The run: five days, as a pure model (docs/game-design.md, "A run"). No DOM, no renderer, no wall clock: game/core/engine.ts
 * feeds it the game clock and acts on what it says.
 *
 * A day runs dawn to dawn. Day 1 begins where the run does (a morning, waking by the bed); day n+1 begins at the n-th dawn
 * after that. The run is lost at the sixth dawn, the one that would begin day 6. It is won by leaving (won(), called from
 * outside when the helicopter is boarded).
 *
 * The run keeps its own count of hours since the run began, and the engine's clock (which wraps at 24) is only read as a
 * difference. That is what makes it independent of frame rate and safe across the midnight wrap and across big jumps: a
 * dawn is crossed exactly once, whatever the step size. Sleeping and being caught are told to the run (sleep(), caught()),
 * which moves its own time to the right dawn and says what the engine should set its clock to.
 *
 * Being caught keeps everything: the player carries on with the pack, the tools and the banked parts, and wakes by the bed.
 * That is the engine's job (it simply does not drop anything); nothing here knows about items.
 */

export const RUN = {
  /** Days in a run (the design's five). */
  days: 5,
  /** Dawn: the day, and the creature's sleep, begin. 06:00, with the island's light already coming up. */
  dawnHour: 6,
  /** Dusk on day 1 (19:00); the creature's own departure time (earlier each day) is the Listener's business, not the run's. */
  duskHour: 19,
  /** The run begins at 07:00 on day 1: an hour after dawn, so day 1 has 12 hours of light to learn the island in. */
  startHour: 7,
  /** Sleeping is allowed from this many hours before dusk (17:00): late afternoon is when a player wants to get through to
   *  the next day, but the morning and noon are for working, not for skipping. */
  sleepFromBeforeDusk: 2,
  /** If the Listener comes to the door, it comes this long after lying down (game hours; a game hour is a real minute)... */
  doorAfterHours: 1,
  /** ...but never later than this fraction of what is left of the night, so a late sleep is not woken at the last moment. */
  doorAtMostFraction: .5,
  /** A clock reading this close to a whole day behind is read as the same instant a hair earlier (frame jitter), not as a
   *  24-hour jump forward. */
  backwardsEpsilon: 1e-6,
} as const;

export type RunStatus = 'running' | 'won' | 'lost';
export type RunEvent = { type: 'dawn'; day: number } | { type: 'dusk'; day: number } | { type: 'lost' };

export type RunState = {
  /** 1 .. RUN.days (the day the player is in; it stays RUN.days once lost, the run being over). */
  day: number;
  /** Game hours since the run began. */
  elapsed: number;
  /** Whether this day's dusk has already been announced. */
  duskSeen: boolean;
  status: RunStatus;
};

export type CaughtResult =
  | { outcome: 'dawn'; day: number; wakeHour: number; hoursLost: number; events: RunEvent[] }
  | { outcome: 'lost'; events: RunEvent[] };

export type SleepArgs = {
  /** The place's door is barred. */
  doorBarred: boolean;
  /** No Listener close or searching nearby: the caller decides. */
  quiet: boolean;
  /** A noise of grade loud or above was made near here today (DayNoise.loudNear). */
  loudHereToday: boolean;
};
export type SleepRefusal = 'ended' | 'daytime' | 'door-open' | 'not-quiet';
export type SleepResult =
  /** Slept till dawn: set the clock to wakeHour, wake by the bed. */
  | { ok: true; outcome: 'dawn'; day: number; wakeHour: number; hoursSlept: number; events: RunEvent[] }
  /** The Listener came to the door at `interruptedAt` (a clock hour); the player is awake there and the night goes on. */
  | { ok: true; outcome: 'door'; interruptedAt: number; hoursSlept: number; events: RunEvent[] }
  /** The sleep carried the run past the sixth dawn. */
  | { ok: true; outcome: 'lost'; events: RunEvent[] }
  | { ok: false; reason: SleepRefusal };

const mod24 = (h: number) => ((h % 24) + 24) % 24;

export function createRun(saved?: RunState, tuning: Readonly<typeof RUN> = RUN) {
  const T = tuning;
  /** Hours from the run's start to the first dawn: 23 for a 07:00 start (never 0: a start at dawn begins a full day). */
  const firstDawn = mod24(T.dawnHour - T.startHour) || 24;
  /** Where day n begins and ends, in hours since the run began. Day n ends where day n+1 begins. */
  const dayStart = (n: number) => (n <= 1 ? 0 : firstDawn + 24 * (n - 2));
  const dayEnd = (n: number) => dayStart(n + 1);
  const duskAt = (n: number) => dayStart(n) + mod24(T.duskHour - (n <= 1 ? T.startHour : T.dawnHour));
  const clockOf = (elapsed: number) => mod24(T.startHour + elapsed);

  function validate(r: RunState): RunState {
    const day = Math.min(T.days, Math.max(1, Math.round(Number(r.day) || 1)));
    const status: RunStatus = r.status === 'won' || r.status === 'lost' ? r.status : 'running';
    const elapsed = Math.min(dayEnd(day), Math.max(dayStart(day), Number(r.elapsed) || 0));
    return { day, elapsed, duskSeen: !!r.duskSeen || elapsed >= duskAt(day), status };
  }

  let s: RunState = saved ? validate(saved) : { day: 1, elapsed: 0, duskSeen: false, status: 'running' };

  /** Move to `target` hours since the start, announcing every dusk and dawn crossed on the way, each exactly once, in order. */
  function moveTo(target: number): RunEvent[] {
    const events: RunEvent[] = [];
    if (s.status !== 'running' || target <= s.elapsed) return events;
    for (;;) {
      if (!s.duskSeen && target >= duskAt(s.day)) { s.duskSeen = true; events.push({ type: 'dusk', day: s.day }); }
      if (target < dayEnd(s.day)) break;
      if (s.day >= T.days) { s.elapsed = dayEnd(s.day); s.status = 'lost'; events.push({ type: 'lost' }); return events; }
      s.day++; s.duskSeen = false; events.push({ type: 'dawn', day: s.day });
    }
    s.elapsed = target;
    return events;
  }

  /** Late enough in the day to sleep: the evening or the night. */
  const sleepy = () => s.elapsed >= duskAt(s.day) - T.sleepFromBeforeDusk;

  return {
    /**
     * Step with the engine's clock (0-24, wrapping). The change since the last call is read as forward time modulo 24, so
     * midnight is nothing special, any step size gives the same events, and a jump of up to 23.99 hours is honoured. A
     * reading a hair behind (jitter) counts as no time passing. A deliberate set-back of the clock (debug) is not
     * supported: it would read as a jump forward; restore() a saved state instead.
     */
    advance(clockHours: number): RunEvent[] {
      if (s.status !== 'running') return [];
      let d = mod24(clockHours - clockOf(s.elapsed));
      if (d > 24 - T.backwardsEpsilon) d = 0;
      return moveTo(s.elapsed + d);
    },

    /**
     * The player was taken. Time goes to the next dawn, whatever the hour: the rest of the night (or of the day) is gone.
     * 'dawn' says the day that dawn begins and the clock hour to set (wake by the bed); 'lost' means that dawn is the sixth.
     * Everything carried is kept. `events` holds the dusk crossed, if any, and the dawn or loss, so the engine need not
     * advance() across the jump: set the clock to wakeHour and carry on.
     */
    caught(): CaughtResult {
      if (s.status !== 'running') return { outcome: 'lost', events: [] };
      const from = s.elapsed;
      const events = moveTo(dayEnd(s.day));
      if (events.some((e) => e.type === 'lost')) return { outcome: 'lost', events };
      return { outcome: 'dawn', day: s.day, wakeHour: T.dawnHour, hoursLost: s.elapsed - from, events };
    },

    /**
     * May the player sleep here till dawn? Only in the evening and at night (from 2 h before dusk), with the door barred and
     * the place quiet; it costs the night's hours. If they were loud near here today the Listener comes to the door instead:
     * 'door' (a success, not a refusal) leaves the player awake `interruptedAt`, 1 h after lying down (or halfway to dawn
     * if less is left), for the engine to stage; they may sleep again later, and the day's noise log still says they were
     * loud. Refusals are checked in the order daytime, door-open, not-quiet. Events as for caught().
     */
    sleep(a: SleepArgs): SleepResult {
      if (s.status !== 'running') return { ok: false, reason: 'ended' };
      if (!sleepy()) return { ok: false, reason: 'daytime' };
      if (!a.doorBarred) return { ok: false, reason: 'door-open' };
      if (!a.quiet) return { ok: false, reason: 'not-quiet' };
      const from = s.elapsed;
      if (a.loudHereToday) {
        const left = dayEnd(s.day) - from;
        const events = moveTo(from + Math.min(T.doorAfterHours, left * T.doorAtMostFraction));
        return { ok: true, outcome: 'door', interruptedAt: clockOf(s.elapsed), hoursSlept: s.elapsed - from, events };
      }
      const events = moveTo(dayEnd(s.day));
      if (events.some((e) => e.type === 'lost')) return { ok: true, outcome: 'lost', events };
      return { ok: true, outcome: 'dawn', day: s.day, wakeHour: T.dawnHour, hoursSlept: s.elapsed - from, events };
    },

    /** Won by leaving: the run ends; nothing advances after it. */
    won() { if (s.status === 'running') s.status = 'won'; },

    /** The day the player is in, 1-based: the number of days scratched on the wall by the bed. */
    get day() { return s.day; },
    get daysBegun() { return s.day; },
    /** Days still to come after this one (0 on the last day). */
    get daysLeft() { return T.days - s.day; },
    get status(): RunStatus { return s.status; },
    get over() { return s.status !== 'running'; },
    /** The run's own idea of the clock, 0-24. */
    get clock() { return clockOf(s.elapsed); },
    /** Game hours left before the next dawn. */
    get hoursToDawn() { return dayEnd(s.day) - s.elapsed; },
    /** 'day' until dusk, then 'night' until the next dawn. */
    get phase(): 'day' | 'night' { return s.elapsed >= duskAt(s.day) ? 'night' : 'day'; },
    /** Whether the time of day allows sleep (the other conditions are sleep()'s). */
    get canSleepNow() { return s.status === 'running' && sleepy(); },

    /** Everything the HUD and the save need. A copy: mutating it changes nothing. */
    state(): RunState & { daysBegun: number; daysLeft: number; clock: number } {
      return { ...s, daysBegun: s.day, daysLeft: T.days - s.day, clock: clockOf(s.elapsed) };
    },
    /** Put a saved state back (extra fields are ignored; values are clamped into the run). */
    restore(r: RunState) { s = validate(r); },
  };
}
export type Run = ReturnType<typeof createRun>;
