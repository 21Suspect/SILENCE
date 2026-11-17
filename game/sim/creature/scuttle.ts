/**
 * How a big spider covers ground when it is not in a hurry: in bursts. It scuttles, stops dead, listens, scuttles again. Pure.
 *
 * The brain asks for a speed (creeping toward a faint sound, searching, its round, going home); this turns it into bursts and
 * freezes whose mean is that speed: each burst is drawn with the freeze that follows it, and runs faster by (burst + freeze) /
 * burst. A trot to a loud noise and a charge never stop: they are not scuttled. Heard, a freeze is silence and a burst is a
 * rush of feet; seen, it is the stop-start that makes spiders hard to watch.
 *
 * Spiders on the move pause often, and the pauses are distributed exponentially (Baatrup et al. 2021, intermittent locomotion):
 * mostly short stops, now and then a long dead one. So a freeze is a floor plus an exponential draw, cut off at a ceiling, and the
 * burst before it is drawn long enough to make up for it within `maxFactor`, so the mean holds whatever the freeze.
 */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const SCUTTLE = {
  /** Asked speeds (m/s) in this range scuttle; a creep is about 1.2, a round 2 to 4. */
  minSpeed: .3, maxSpeed: 4.5,
  /** Seconds of a burst, drawn each time (lengthened if its freeze needs it). */
  burst: [.4, 1.2] as const,
  /** A freeze: at least `freeze[0]` s, plus an exponential draw of mean `freezeMean` s, never over `freeze[1]` s. Mean about .8 s. */
  freeze: [.2, 2.6] as const, freezeMean: .62,
  /** A burst never runs faster than this many times the asked speed, nor faster than `top` m/s. */
  maxFactor: 2.6, top: 7.5,
};

export type Scuttle = ReturnType<typeof createScuttle>;

export function createScuttle(random: () => number = Math.random) {
  let phase: 'burst' | 'freeze' = 'freeze', left = 0, nextFreeze = 0, factor = 1, active = false;
  return {
    /**
     * The multiplier for the asked speed now: 0 in a freeze, more than 1 in a burst, 1 when not scuttling (`scuttles` false, or the
     * speed out of range). A new spell of scuttling starts with a burst.
     */
    factor(dt: number, asked: number, scuttles: boolean): number {
      if (!scuttles || asked < SCUTTLE.minSpeed || asked > SCUTTLE.maxSpeed) { active = false; return 1; }
      if (!active) { active = true; phase = 'freeze'; left = 0; }
      left -= dt;
      if (left <= 0) {
        if (phase === 'freeze') {
          nextFreeze = Math.min(SCUTTLE.freeze[1], SCUTTLE.freeze[0] - SCUTTLE.freezeMean * Math.log(1 - random() * .999));
          const burst = Math.max(lerp(SCUTTLE.burst[0], SCUTTLE.burst[1], random()), nextFreeze / (SCUTTLE.maxFactor - 1));
          factor = Math.min(SCUTTLE.maxFactor, SCUTTLE.top / Math.max(asked, .01), (burst + nextFreeze) / burst);
          phase = 'burst'; left += burst;
        } else { phase = 'freeze'; left += nextFreeze; }
      }
      return phase === 'freeze' ? 0 : factor;
    },
    get phase() { return active ? phase : 'off'; },
    reset() { active = false; left = 0; },
  };
}
