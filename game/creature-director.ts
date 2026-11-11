/**
 * The opening act. Everyone who plays meets the Listener twice before it may hunt them: a glimpse by 3:00 and the
 * tree by 6:00 (docs/creature-ai-plan.md, "Amendment: scripted opening"). Both are harmless.
 *
 *   quiet      0:00-1:30  forest only
 *   glimpse    1:30-3:00  encounter 1: placed out of view ahead, seen by 3:00
 *   interlude  after it   quiet, one distant call from where it went; at least `quietAfter`, never before 3:45
 *   tree       3:45-6:00  encounter 2: head-down on a trunk ahead (or crossing the path), seen by 6:00
 *   breathing  60-90 s    it has gone; nothing yet
 *   free       after      the creature's own mind (game/creature-brain.ts) has it: it can hunt and kill
 *
 * Pure and deterministic, like the brain: time only from each tick's dt, chance only from the injected random, no
 * scene. The host (game/encounters.ts) does the placing and the walking and tells it what happened: whether the
 * scripted creature has been seen, and when it has gone again. Its clock pauses while the player is indoors during
 * an encounter that has not been seen yet, so a deadline is play time out in the open. Once free, it stays free: a
 * death or a new night does not replay the opening.
 */

export const OPENING = {
  /** Seconds of play: when the glimpse begins, and the time it must have been seen by. */
  glimpseFrom: 90, glimpseBy: 180,
  /** The tree encounter never begins before treeFrom, nor sooner than quietAfter after the glimpse has gone. */
  quietAfter: 40, treeFrom: 225, treeBy: 360,
  /** Unseen, an encounter is re-placed closer and more directly ahead this often. */
  escalateEvery: 20,
  /** This long before its deadline an unseen creature stops waiting to be found and walks into view. */
  forceLead: 45,
  /** Still unseen this long after the deadline, the director moves on regardless (a stuck encounter never blocks). */
  giveUpAfter: 60,
  /** A seen creature may never finish leaving while watched or obstructed. Release the script anyway. */
  leaveTimeout: 90,
  /** Seconds into the interlude for the one distant call. */
  callAfter: [10, 22] as const,
  /** The breathing room after the tree. */
  breathing: [60, 90] as const,
};
export type OpeningTuning = typeof OPENING;

export type OpeningPhase = 'quiet' | 'glimpse' | 'interlude' | 'tree' | 'breathing' | 'free';
export type DirectorEvent =
  | { type: 'phase'; from: OpeningPhase; to: OpeningPhase }
  /** Not seen for another escalateEvery: re-place it closer and more directly ahead. `step` counts from 1. */
  | { type: 'escalate'; step: number }
  /** The deadline is near and it has not been seen: walk into view. */
  | { type: 'force' }
  /** The host reported the encounter seen, at this clock. */
  | { type: 'seen'; phase: OpeningPhase; at: number; late: boolean }
  /** One distant call from where it went. */
  | { type: 'call' }
  /** The sighting deadline or departure timeout expired. */
  | { type: 'gave-up'; phase: OpeningPhase };

export type DirectorInput = {
  dt: number;
  /** The player is inside a building. */
  indoors: boolean;
  /** The scripted creature has been recognised this encounter (the host's sighting test; sticky is fine). */
  seen: boolean;
  /** After being seen, it has left and its body has been taken away out of view. */
  gone: boolean;
};

export type DirectorOutput = {
  phase: OpeningPhase;
  /** Escalation steps taken in this encounter, 0 at its start. */
  step: number;
  /** Walk into view now. */
  forced: boolean;
  /** The deadline clock is paused (indoors, encounter unseen). */
  paused: boolean;
  /** The opening's clock (play time out of doors during encounters), and the seconds left to this encounter's deadline. */
  clock: number; left: number;
  events: DirectorEvent[];
};

export function createOpeningDirector(options: { random: () => number; tuning?: Partial<OpeningTuning> }) {
  const t: OpeningTuning = { ...OPENING, ...options.tuning }, random = options.random;
  let phase: OpeningPhase = 'quiet', clock = 0, time = 0, phaseAt = 0, step = 0, nextEscalate = Infinity, forced = false, seenAt: number | undefined;
  let callAt = Infinity, called = false, treeAt = Infinity, breathingUntil = Infinity;
  const history: { phase: OpeningPhase; clock: number; time: number }[] = [{ phase, clock: 0, time: 0 }];

  const deadline = () => phase === 'glimpse' ? t.glimpseBy : phase === 'tree' ? t.treeBy : Infinity;
  function enter(to: OpeningPhase, events: DirectorEvent[]) {
    events.push({ type: 'phase', from: phase, to });
    phase = to; phaseAt = clock; step = 0; forced = false; seenAt = undefined; nextEscalate = Infinity;
    history.push({ phase, clock, time });
    if (to === 'glimpse' || to === 'tree') nextEscalate = clock + t.escalateEvery;
    if (to === 'interlude') {
      called = false; callAt = clock + t.callAfter[0] + random() * (t.callAfter[1] - t.callAfter[0]);
      treeAt = Math.max(clock + t.quietAfter, t.treeFrom);
    }
    if (to === 'breathing') breathingUntil = clock + t.breathing[0] + random() * (t.breathing[1] - t.breathing[0]);
  }

  return {
    get phase() { return phase; },
    /** The creature belongs to the script (no hunting, no grabs, no free-roam brain). */
    get scripted() { return phase !== 'free'; },
    tick(input: DirectorInput): DirectorOutput {
      const dt = Math.max(0, Math.min(input.dt, .25)), events: DirectorEvent[] = [];
      const encounter = phase === 'glimpse' || phase === 'tree';
      const paused = encounter && input.indoors && seenAt === undefined;
      time += dt;
      if (!paused) clock += dt;
      if (phase === 'quiet') {
        if (clock >= t.glimpseFrom) enter('glimpse', events);
      } else if (encounter) {
        if (input.seen && seenAt === undefined) { seenAt = clock; events.push({ type: 'seen', phase, at: clock, late: clock > deadline() }); }
        if (seenAt === undefined) {
          if (clock >= nextEscalate) { step++; nextEscalate += t.escalateEvery; events.push({ type: 'escalate', step }); }
          if (!forced && clock >= deadline() - t.forceLead) { forced = true; events.push({ type: 'force' }); }
        }
        const done = seenAt !== undefined && input.gone, stuck = seenAt === undefined ? clock > deadline() + t.giveUpAfter : clock - seenAt > t.leaveTimeout;
        if (stuck) events.push({ type: 'gave-up', phase });
        if (done || stuck) enter(phase === 'glimpse' ? 'interlude' : 'breathing', events);
      } else if (phase === 'interlude') {
        if (!called && clock >= callAt) { called = true; events.push({ type: 'call' }); }
        if (clock >= treeAt) enter('tree', events);
      } else if (phase === 'breathing') {
        if (clock >= breathingUntil) enter('free', events);
      }
      return { phase, step, forced, paused, clock, left: deadline() - clock, events };
    },
    /** Jump to a phase now (the developer menu, a test, or a new night that should not replay the opening). */
    jump(to: OpeningPhase): DirectorEvent[] {
      const events: DirectorEvent[] = [];
      if (to === phase) return events;
      // An encounter jumped to starts at its own beginning, with its full window.
      if (to === 'glimpse') clock = Math.max(clock, t.glimpseFrom); else if (to === 'tree') clock = Math.max(clock, t.treeFrom);
      enter(to, events);
      return events;
    },
    inspect() {
      return { phase, clock, time, inPhase: clock - phaseAt, step, forced, seenAt, deadline: deadline(), callAt: called ? undefined : callAt, treeAt, breathingUntil, history: history.map(h => ({ ...h })) };
    },
  };
}
export type OpeningDirector = ReturnType<typeof createOpeningDirector>;
