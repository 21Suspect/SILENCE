import type { Surface } from '../sim/world/surface';

/**
 * The bicycle's own sounds, made rather than sampled: a bell (a thumb-lever bell's three quick strikes on a steel dome, its
 * inharmonic partials beating, about a second and a quarter of ring, a little different every time) and the tyres' rolling (a soft hiss with a rattle at the wheel's turning rate whose
 * level and brightness follow speed and ground; gravel is louder than tarmac). It plays into the game's master bus like the footsteps.
 * The rules (how loud the Listener finds each: NOISE.bell, NOISE.bicyclePath) are in sim/player/bicycle.ts, not here.
 */

/** How loud each ground's rolling is at full speed, in the mix's own units. Tarmac hisses, packed earth crackles, forest floor is a muffled thump. */
const GROUND: Record<Surface, { level: number; bright: number }> = {
  road: { level: .05, bright: 1700 }, path: { level: .09, bright: 2300 }, dirt: { level: .12, bright: 2100 },
  beach: { level: .11, bright: 1500 }, forest: { level: .13, bright: 1300 }, water: { level: 0, bright: 800 },
};
const TOP_SPEED = 5.4;
/** The wheel's turning rate (Hz) is speed over the tyre's circumference (2 pi 0.355). */
export const wheelHz = (speed: number) => speed / (2 * Math.PI * .355);

/** The level of the rolling at a speed (m/s) on a ground: nothing standing, rising a little faster than the speed. */
export function rollLevel(speed: number, surface: Surface) {
  const s = Math.max(0, Math.min(1.3, speed / TOP_SPEED));
  return GROUND[surface].level * s ** 1.3;
}
/** The rolling's brightness (Hz of the band-pass): brighter the faster it goes, by the ground. */
export function rollBrightness(speed: number, surface: Surface) {
  return GROUND[surface].bright * (.7 + .5 * Math.max(0, Math.min(1.3, speed / TOP_SPEED)));
}

/** The bell's two partials (Hz): about 2.4 and 3.6 kHz (a ratio of about 1.5: a bell's, not a chord's), each moved a few percent by `random`. */
/**
 * The bell's partials (Hz) and their levels: a struck steel dome rings at inharmonic ratios (about 1 : 2.7 : 4.1 for a shallow
 * bell), and its fundamental is a close pair, beating a few times a second, because the dome is never quite round. The first bell was
 * two partials a fifth apart, which is an electronic beep. A little different every ring.
 */
export function bellPartials(random: () => number = Math.random) {
  const base = 2400 * (1 + (random() - .5) * .08);
  return [
    { frequency: base, level: 1 },
    { frequency: base * (1.0035 + random() * .002), level: .8 },
    { frequency: base * (2.7 + (random() - .5) * .04), level: .42 },
    { frequency: base * (4.1 + (random() - .5) * .06), level: .16 },
  ] as const;
}
/** A thumb-lever bell: the clapper spins and strikes the dome three times in quick succession ("trrring"), then it rings out. */
export const BELL = { attack: .003, decay: 1.25, level: .2, strikes: 3, strikeGap: .045 };

export function createBicycleAudio() {
  let context: AudioContext | undefined, out: AudioNode | undefined;
  let hiss: { gain: GainNode; band: BiquadFilterNode; source: AudioBufferSourceNode; lfo: OscillatorNode; depth: GainNode } | undefined;

  function build() {
    if (hiss || !context || !out) return;
    const length = context.sampleRate * 2, buffer = context.createBuffer(1, length, context.sampleRate), data = buffer.getChannelData(0);
    // Pink-ish: each sample a little of the last, so the hiss is soft rather than a spit.
    let last = 0; for (let i = 0; i < length; i++) { last = last * .6 + (Math.random() * 2 - 1) * .4; data[i] = last * 2; }
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
    const band = context.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = .6; band.frequency.value = 1800;
    const gain = context.createGain(); gain.gain.value = 0;
    const lfo = context.createOscillator(), depth = context.createGain(); lfo.frequency.value = 1; depth.gain.value = 0;
    lfo.connect(depth).connect(gain.gain);
    source.connect(band).connect(gain).connect(out);
    source.start(); lfo.start();
    hiss = { gain, band, source, lfo, depth };
  }

  return {
    /** Give it the game's audio context and the bus to play into (it can be called every frame; only the first, or a new context, counts). */
    attach(next: AudioContext | null | undefined, destination: AudioNode | null | undefined) {
      if (!next || !destination || (context === next && out === destination)) return;
      context = next; out = destination; hiss = undefined;
    },
    /** One ring. Safe before audio is unlocked (it is skipped). */
    bell(random: () => number = Math.random) {
      if (!context || !out || context.state !== 'running') return false;
      const c = context, t0 = c.currentTime, partials = bellPartials(random);
      for (let k = 0; k < BELL.strikes; k++) {
        // Each strike is a little weaker and a little late or early: a spun clapper, not a machine.
        const t = t0 + k * BELL.strikeGap * (.85 + random() * .3), strike = BELL.level * (1 - k * .22) * (.9 + random() * .2);
        const env = c.createGain();
        env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(strike, t + BELL.attack);
        env.gain.exponentialRampToValueAtTime(.0004, t + BELL.attack + BELL.decay);
        env.connect(out!);
        partials.forEach((p, i) => {
          const osc = c.createOscillator(), g = c.createGain();
          osc.type = 'sine'; osc.frequency.value = p.frequency; g.gain.setValueAtTime(p.level, t);
          // The upper partials die sooner, as in a struck bell.
          if (i >= 2) g.gain.exponentialRampToValueAtTime(.005, t + BELL.attack + BELL.decay * (i === 2 ? .45 : .2));
          osc.connect(g).connect(env); osc.start(t); osc.stop(t + BELL.attack + BELL.decay + .1);
          osc.onended = () => { osc.disconnect(); g.disconnect(); if (i === partials.length - 1) env.disconnect(); };
        });
      }
      return true;
    },
    /** Every frame: how fast the bicycle is rolling (0 when off it or standing) and on what. */
    roll(speed: number, surface: Surface) {
      if (!context || !out || context.state !== 'running') return;
      build();
      if (!hiss) return;
      const t = context.currentTime, level = rollLevel(speed, surface);
      hiss.gain.gain.setTargetAtTime(level, t, .08);
      hiss.band.frequency.setTargetAtTime(rollBrightness(speed, surface), t, .1);
      hiss.lfo.frequency.setTargetAtTime(Math.max(.5, wheelHz(speed)), t, .1);
      hiss.depth.gain.setTargetAtTime(level * .45, t, .1);
    },
    dispose() {
      if (hiss) { try { hiss.source.stop(); hiss.lfo.stop(); } catch { /* already stopped */ } hiss.source.disconnect(); hiss.gain.disconnect(); hiss.lfo.disconnect(); hiss = undefined; }
      context = undefined; out = undefined;
    },
  };
}
export type BicycleAudio = ReturnType<typeof createBicycleAudio>;
