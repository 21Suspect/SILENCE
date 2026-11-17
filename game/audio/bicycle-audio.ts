import type { Surface } from '../sim/world/surface';
import { crackleBuffer } from './creature-steps';

/**
 * The bicycle's own sounds, made rather than sampled: a bell (a thumb-lever bell's three quick strikes on a steel dome, its
 * inharmonic partials beating, about a second and a quarter of ring, a little different every time) and its rolling, one continuous
 * sound that revs with the speed: the chain's whir at the rate its links meet the teeth while you pedal, the freewheel's buzz when you
 * coast, the tyres' hum, grit and rumble by the ground under them, and the rack and mudguards rattling over the rough. It plays into
 * the game's master bus like the footsteps.
 * The rules (how loud the Listener finds each: NOISE.bell, NOISE.bicyclePath) are in sim/player/bicycle.ts, not here.
 */

/**
 * The ground under the tyres at full speed, in the mix's own units: the tyre's hum (band-passed noise at `hum` Hz), the grit it
 * crunches (stick-slip crackle at `gritHz`), the low rumble of the carcass on the ground, and how often a bump rattles the rack and
 * mudguards (per second at full speed). Tarmac hums and barely crunches; a path's gravel crunches; the forest floor rumbles and knocks.
 */
const GROUND: Record<Surface, { tyre: number; hum: number; grit: number; gritHz: number; rumble: number; bumps: number }> = {
  road: { tyre: .03, hum: 950, grit: .012, gritHz: 3600, rumble: .03, bumps: .1 },
  path: { tyre: .03, hum: 1250, grit: .07, gritHz: 2600, rumble: .045, bumps: .9 },
  dirt: { tyre: .035, hum: 1000, grit: .05, gritHz: 1900, rumble: .06, bumps: 1.3 },
  beach: { tyre: .05, hum: 1700, grit: .045, gritHz: 4300, rumble: .035, bumps: .3 },
  forest: { tyre: .035, hum: 750, grit: .065, gritHz: 1500, rumble: .07, bumps: 2 },
  water: { tyre: 0, hum: 800, grit: 0, gritHz: 1000, rumble: 0, bumps: 0 },
};
/** The speed the mix is balanced at (a cruise on the road, m/s). */
const CRUISE = 8.4;
/** The wheel's turning rate (Hz) is speed over the tyre's circumference (2 pi 0.355). */
export const wheelHz = (speed: number) => speed / (2 * Math.PI * .355);
/** The drivetrain (models_bicycle.py): a 46-tooth ring, an 18-tooth sprocket, a freewheel of 24 points. */
export const DRIVE = { ring: 46, sprocket: 18, ratchet: 24 };
/** How often a chain link meets a tooth (Hz): the whir's pitch. 68 Hz at a road cruise, a flutter of 15 at a walking pace. */
export const chainHz = (speed: number) => wheelHz(speed) * DRIVE.sprocket;
/** How often the freewheel's pawls click while coasting (Hz). */
export const ratchetHz = (speed: number) => wheelHz(speed) * DRIVE.ratchet;

/**
 * Everything the rolling is at a speed (m/s), on a ground, pedalling (1) or coasting (0): levels in the mix's units and rates in Hz.
 * Silent standing; every part rises with speed, so starting and stopping rev it up and down.
 */
export function rollMix(speed: number, surface: Surface, pedal: number) {
  const g = GROUND[surface], s = Math.max(0, Math.min(1.25, speed / CRUISE)), moving = Math.min(1, Math.max(0, (speed - .2) / .6)), p = Math.min(1, Math.max(0, pedal));
  return {
    tyre: g.tyre * s ** 1.15 * moving, hum: g.hum * (.6 + .55 * s),
    grit: g.grit * s ** 1.05 * moving, gritRate: .45 + 1.25 * s, gritHz: g.gritHz,
    rumble: g.rumble * s ** 1.3 * moving,
    // The chain only sounds while it turns (pedalling); off the pedals the freewheel takes over.
    chain: .028 * s ** .7 * p * moving, chainHz: chainHz(speed),
    ratchet: .014 * s ** .6 * (1 - p) * moving, ratchetHz: ratchetHz(speed),
    bumps: g.bumps * s * moving,
  };
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
  let context: AudioContext | undefined, out: AudioNode | undefined, lastT = 0, pedalNow = 1;
  type Rolling = {
    sources: AudioScheduledSourceNode[]; nodes: AudioNode[];
    tyre: GainNode; hum: BiquadFilterNode; grit: GainNode; gritBand: BiquadFilterNode; gritSource: AudioBufferSourceNode; rumble: GainNode;
    chain: GainNode; chainLfo: OscillatorNode; chainBody: OscillatorNode; ratchet: GainNode; ratchetLfo: OscillatorNode;
    white: AudioBuffer;
  };
  let rolling: Rolling | undefined;

  function noiseBuffer(c: BaseAudioContext, pink: boolean) {
    const length = c.sampleRate * 2, buffer = c.createBuffer(1, length, c.sampleRate), data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) { const w = Math.random() * 2 - 1; last = pink ? last * .6 + w * .4 : w; data[i] = pink ? last * 2 : w; }
    return buffer;
  }
  function build() {
    if (rolling || !context || !out) return;
    const c = context, o = out, sources: AudioScheduledSourceNode[] = [], nodes: AudioNode[] = [];
    const white = noiseBuffer(c, false), pink = noiseBuffer(c, true);
    const loop = (buffer: AudioBuffer) => { const src = c.createBufferSource(); src.buffer = buffer; src.loop = true; sources.push(src); return src; };
    const filter = (type: BiquadFilterType, frequency: number, q: number) => { const f = c.createBiquadFilter(); f.type = type; f.frequency.value = frequency; f.Q.value = q; nodes.push(f); return f; };
    const gain = (value = 0) => { const g = c.createGain(); g.gain.value = value; nodes.push(g); return g; };
    // The tyres: a hum of the tread on the ground, and the carcass's low rumble under it.
    const hum = filter('bandpass', 1000, .7), tyre = gain(), rumble = gain(), low = filter('lowpass', 150, .6);
    loop(pink).connect(hum).connect(tyre).connect(o);
    loop(pink).connect(low).connect(rumble).connect(o);
    // The grit the tyres crunch: stick-slip crackle (the same grains the creature's legs brush with), faster the faster they roll.
    const gritSource = loop(crackleBuffer(c)), gritBand = filter('bandpass', 2500, .9), grit = gain();
    gritSource.connect(gritBand).connect(grit).connect(o);
    // The chain: metal noise gated at the rate its links meet the teeth (a square wave, so each meeting is a clack and the run of
    // them a "vrrrr"), with a little of that rate as a tone for body. Its pitch is the speed, so it revs up and down.
    const chainVca = gain(.5), chainDepth = gain(.5), chainLfo = c.createOscillator(), chainBand = filter('bandpass', 2600, 1.3), chain = gain();
    chainLfo.type = 'square'; chainLfo.frequency.value = 20; chainLfo.connect(chainDepth).connect(chainVca.gain); sources.push(chainLfo);
    loop(white).connect(chainBand).connect(chainVca).connect(chain).connect(o);
    const chainBody = c.createOscillator(), bodyLow = filter('lowpass', 420, .7), bodyLevel = gain(.22);
    chainBody.type = 'sawtooth'; chainBody.frequency.value = 20; chainBody.connect(bodyLow).connect(bodyLevel).connect(chain); sources.push(chainBody);
    // The freewheel: bright ticks, one per pawl click, from a narrow pulse (twelve equal harmonics) gating high noise.
    const real = new Float32Array(13), imag = new Float32Array(13); for (let k = 1; k < 13; k++) real[k] = 1;
    const ratchetLfo = c.createOscillator(); ratchetLfo.setPeriodicWave(c.createPeriodicWave(real, imag)); ratchetLfo.frequency.value = 20; sources.push(ratchetLfo);
    const ratchetVca = gain(0), ratchetDepth = gain(.09), ratchetHigh = filter('highpass', 3200, .7), ratchet = gain();
    ratchetLfo.connect(ratchetDepth).connect(ratchetVca.gain);
    loop(white).connect(ratchetHigh).connect(ratchetVca).connect(ratchet).connect(o);
    for (const src of sources) src.start();
    rolling = { sources, nodes, tyre, hum, grit, gritBand, gritSource, rumble, chain, chainLfo, chainBody, ratchet, ratchetLfo, white };
  }
  /** A bump: the tyre thuds and the rack and mudguards rattle, three or four knocks dying away. */
  function bump(level: number) {
    if (!context || !out || !rolling) return;
    const c = context, t = c.currentTime, white = rolling.white;
    const knock = (type: BiquadFilterType, frequency: number, q: number, peak: number, at: number, length: number) => {
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = white; f.type = type; f.frequency.value = frequency; f.Q.value = q;
      g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(Math.max(.0002, peak), at + .003); g.gain.exponentialRampToValueAtTime(.0001, at + length);
      src.connect(f).connect(g).connect(out!); src.start(at, Math.random() * 1.5); src.stop(at + length + .02);
      src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
    };
    knock('lowpass', 260, .7, level * 2.2, t, .09);
    let at = t + .012;
    for (let k = 0; k < 3 + Math.floor(Math.random() * 2); k++) { knock('bandpass', 1400 + Math.random() * 1400, 3, level * .9 * .62 ** k, at, .025); at += .022 + Math.random() * .018; }
  }

  return {
    /** Give it the game's audio context and the bus to play into (it can be called every frame; only the first, or a new context, counts). */
    attach(next: AudioContext | null | undefined, destination: AudioNode | null | undefined) {
      if (!next || !destination || (context === next && out === destination)) return;
      context = next; out = destination; rolling = undefined;
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
    /**
     * Every frame: how fast the bicycle is rolling (0 when off it or standing), on what, and whether the rider is pedalling (1) or
     * coasting (0).
     */
    roll(speed: number, surface: Surface, pedal = 1) {
      if (!context || !out || context.state !== 'running') return;
      build();
      if (!rolling) return;
      const t = context.currentTime, dt = Math.min(.25, Math.max(0, t - lastT)); lastT = t;
      // The feet do not leave the pedals in a frame: a quarter second to go from pedalling to coasting and back.
      pedalNow += (pedal - pedalNow) * Math.min(1, dt / .25);
      const m = rollMix(speed, surface, pedalNow), r = rolling;
      r.tyre.gain.setTargetAtTime(m.tyre, t, .08); r.hum.frequency.setTargetAtTime(m.hum, t, .12);
      r.rumble.gain.setTargetAtTime(m.rumble, t, .1);
      r.grit.gain.setTargetAtTime(m.grit * (.75 + Math.random() * .5), t, .05); r.gritBand.frequency.setTargetAtTime(m.gritHz, t, .1);
      r.gritSource.playbackRate.setTargetAtTime(m.gritRate, t, .1);
      r.chain.gain.setTargetAtTime(m.chain, t, .08);
      r.chainLfo.frequency.setTargetAtTime(Math.max(4, m.chainHz), t, .1); r.chainBody.frequency.setTargetAtTime(Math.max(20, m.chainHz), t, .1);
      r.ratchet.gain.setTargetAtTime(m.ratchet, t, .08); r.ratchetLfo.frequency.setTargetAtTime(Math.max(2, m.ratchetHz), t, .1);
      if (m.bumps > 0 && Math.random() < m.bumps * dt) bump(.03 + .03 * Math.random() * Math.min(1, speed / CRUISE));
    },
    dispose() {
      if (rolling) {
        for (const src of rolling.sources) { try { src.stop(); } catch { /* already stopped */ } src.disconnect(); }
        for (const n of rolling.nodes) n.disconnect();
        rolling = undefined;
      }
      context = undefined; out = undefined;
    },
  };
}
export type BicycleAudio = ReturnType<typeof createBicycleAudio>;
