/**
 * Running engines (a generator, a pump) as a sound that goes on for as long as they run (docs/game-design.md, "Sound and light").
 * Pure: the numbers a voice follows and the samples one loop is made of. game/audio/audio.ts plays it: one buffer source, one
 * low-pass filter, one gain and one panner per running engine, however long it runs.
 *
 * A small four-stroke engine at about 1500 rpm fires once every two turns per cylinder: 12.5 Hz for the generator's single cylinder,
 * 25 Hz for the pump's two. Each firing is a low thump (a pressure pulse, 28 to 75 Hz), a puff of low-passed noise (the exhaust),
 * and a valve tick (a short burst of high noise) between firings; the generator also carries a faint alternator whine. Firings
 * are a little uneven in time and strength, so it lopes; and the playing speed (the rpm) wanders by a few per cent, slowly, so
 * that it never sounds like a loop.
 */

export type EngineKind = 'generator' | 'pump';

export const ENGINES = {
  /** rpm, cylinders (each fires once per two turns), the level at the reference distance, and how much valve rattle against exhaust. */
  generator: { rpm: 1500, cylinders: 1, level: .55, rattle: 1, water: 0 },
  pump: { rpm: 1500, cylinders: 2, level: .45, rattle: .45, water: 1 },
} as const;

/** Firings per second. */
export function firingHz(kind: EngineKind, rpm: number = ENGINES[kind].rpm) { return rpm / 60 / 2 * ENGINES[kind].cylinders; }

/** The distance (m) the level is quoted at, where it starts to fall; it carries on falling to nothing by `FADE_END`. */
export const ENGINE_REFERENCE = 5, ENGINE_FADE_START = 170, ENGINE_FADE_END = 260;
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * What a voice sounds like from `distance` metres: its gain (falling off a little slower than the inverse law, so that it is still
 * faintly there at 150 m), its low-pass (air takes the top first, so far off it is only the thump), and whether it is worth running
 * at all (past ENGINE_FADE_END it is not: the voice is stopped).
 */
export function engineHearing(kind: EngineKind, distance: number) {
  const d = Math.max(0, distance);
  const gain = ENGINES[kind].level * Math.pow(ENGINE_REFERENCE / Math.max(ENGINE_REFERENCE, d), .85) * (1 - smooth(d, ENGINE_FADE_START, ENGINE_FADE_END));
  const lowpass = Math.min(6000, Math.max(300, 5200 * Math.exp(-d / 85)));
  return { gain, lowpass, audible: d < ENGINE_FADE_END && gain > .0008 };
}

/** A small deterministic hash to 0..1, for per-engine phases. */
const hash = (text: string, salt: number) => {
  let h = Math.imul(2166136261 ^ salt, 16777619);
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
/**
 * The playing speed of the loop `t` seconds in: 1 is 1500 rpm. Three slow sines of unrelated periods (7.3 s, 3.1 s, 1.4 s) and
 * phases drawn from the engine's id give a wander of up to 5.5 per cent that does not repeat for minutes and differs between engines.
 */
export function engineRate(id: string, t: number) {
  const tau = Math.PI * 2;
  return 1 + .028 * Math.sin(tau * t / 7.3 + hash(id, 1) * tau) + .018 * Math.sin(tau * t / 3.1 + hash(id, 2) * tau) + .009 * Math.sin(tau * t / 1.37 + hash(id, 3) * tau);
}
/** A slow flutter of the level, +-6 per cent, from the same kind of sum. */
export function engineFlutter(id: string, t: number) {
  const tau = Math.PI * 2;
  return 1 + .04 * Math.sin(tau * t / 2.3 + hash(id, 4) * tau) + .02 * Math.sin(tau * t / .83 + hash(id, 5) * tau);
}

/** Seconds of loop: this many firings, so that the loop closes on a firing. */
export const ENGINE_LOOP_SECONDS = 1.6;

/**
 * One loop of the engine at its nominal rpm, mono, peak about .9. It is exactly a whole number of firings long, and everything is
 * added round the end, so the loop has no seam. `random` is injectable (tests): the default is Math.random.
 */
export function synthesizeEngine(kind: EngineKind, sampleRate: number, random: () => number = Math.random): Float32Array<ArrayBuffer> {
  const spec = ENGINES[kind], hz = firingHz(kind), firings = Math.round(ENGINE_LOOP_SECONDS * hz);
  const period = 1 / hz, length = Math.round(firings * period * sampleRate), out = new Float32Array(length);
  const add = (start: number, i: number, v: number) => { out[((start + i) % length + length) % length] += v; };
  for (let n = 0; n < firings; n++) {
    // Lumpy: each firing a little early or late, and every fourth a touch weak, as a single cylinder lopes.
    const at = Math.round((n * period + (random() - .5) * period * .06) * sampleRate);
    const strength = (n % 4 === 3 ? .72 : 1) * (.86 + random() * .14);
    // The thump: a pressure pulse, two decaying sines.
    const f1 = 52 + random() * 22, f2 = 27 + random() * 5, phase = random() * .6;
    const thump = Math.floor(sampleRate * .16);
    for (let i = 0; i < thump; i++) {
      const t = i / sampleRate, attack = Math.min(1, i / (sampleRate * .0025));
      add(at, i, strength * attack * (.78 * Math.exp(-t / .034) * Math.sin(Math.PI * 2 * f1 * t + phase) + .6 * Math.exp(-t / .055) * Math.sin(Math.PI * 2 * f2 * t)));
    }
    // The exhaust: a puff of noise, low-passed by a one-pole filter (about 450 Hz).
    const puff = Math.floor(sampleRate * .09), k = 1 - Math.exp(-Math.PI * 2 * 450 / sampleRate);
    let lp = 0;
    for (let i = 0; i < puff; i++) {
      const t = i / sampleRate;
      lp += (random() * 2 - 1 - lp) * k;
      add(at, i, strength * lp * 1.9 * Math.min(1, i / (sampleRate * .003)) * Math.exp(-t / .028));
    }
    // Valve ticks, between firings: short bursts of high-passed noise (the mechanism rattling).
    for (const where of spec.cylinders === 1 ? [.46] : [.3, .72]) {
      const tick = Math.floor(sampleRate * .012), start = at + Math.round(where * period * sampleRate);
      let previous = 0;
      for (let i = 0; i < tick; i++) {
        const t = i / sampleRate, w = random() * 2 - 1, high = w - previous; previous = w;
        add(start, i, high * .11 * spec.rattle * (.7 + random() * .6) * Math.exp(-t / .0035));
      }
    }
  }
  // The bed: a low rumble of the block and, on the generator, the alternator's whine (a multiple of the loop's own frequency, so it closes).
  let rumble = 0;
  const k = 1 - Math.exp(-Math.PI * 2 * 180 / sampleRate), whine = Math.round(100 * ENGINE_LOOP_SECONDS) / ENGINE_LOOP_SECONDS;
  // The same noise filtered twice round: the second pass starts where the first ended, so the loop closes without a step.
  const grit = new Float32Array(length);
  for (let i = 0; i < length; i++) grit[i] = random() * 2 - 1;
  for (let i = 0; i < length; i++) rumble += (grit[i] - rumble) * k;
  for (let i = 0; i < length; i++) {
    rumble += (grit[i] - rumble) * k;
    const t = i / sampleRate;
    out[i] += rumble * .22 + (kind === 'generator' ? .02 * Math.sin(Math.PI * 2 * whine * t) + .008 * Math.sin(Math.PI * 2 * whine * 1.5 * t) : 0);
    if (spec.water) out[i] += (random() * 2 - 1) * .035;   // the pump moving water
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = peak > 0 ? .9 / peak : 1;
  for (let i = 0; i < length; i++) out[i] *= scale;
  return out;
}
