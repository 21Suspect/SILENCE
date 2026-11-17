/**
 * The sounds of the run's machines, made here and played in a context of their own (the forest's audio keeps its context private):
 * the running generators (the relay's and the landing pad's), a steady low hum that sounds for as long as the thing runs, and the
 * helicopter, a rotor's slapping thump with a tail rotor's buzz and a turbine's whine. Each is one looping buffer rendered at start
 * from a few sines and filtered noise, then placed in space with a panner, so it needs no sound file and always matches the
 * visual: the thump is ten a second because the main rotor is drawn at five turns a second with two blades.
 *
 * Nothing here is heard by the Listener: its noise is the objective events' (sustained 'generator', 'pad-generator', 'helicopter'),
 * made by the reducer. This is only what the player hears.
 */
export type Point3 = { x: number; y: number; z: number };

/** Main rotor turns per second (the drawn speed, helicopter.ts) and blades, so the audible thump keeps time with what is seen. */
export const MAIN_ROTOR_HZ = 5, MAIN_BLADES = 2, TAIL_ROTOR_HZ = 14;

function render(context: BaseAudioContext, seconds: number, fill: (t: number, i: number, n: number) => number) {
  const n = Math.floor(context.sampleRate * seconds), buffer = context.createBuffer(1, n, context.sampleRate), data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = fill(i / context.sampleRate, i, n);
  return buffer;
}
/** A fixed pseudo-random stream, so a rendered buffer is the same each time and its loop point needs no luck. */
function noise(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1; }; }

/** A generator: 50 Hz and its harmonics, a 24 Hz beat in the level, and a little filtered grit. Two seconds, a whole number of every cycle. */
export function generatorBuffer(context: BaseAudioContext) {
  const rand = noise(7); let low = 0;
  return render(context, 2, t => {
    low += (rand() - low) * .06;
    const beat = .78 + .22 * Math.sin(2 * Math.PI * 24 * t);
    const tone = Math.sin(2 * Math.PI * 50 * t) * .55 + Math.sin(2 * Math.PI * 100 * t + 1) * .34 + Math.sin(2 * Math.PI * 150 * t + 2) * .2 + Math.sin(2 * Math.PI * 200 * t + .5) * .1;
    return (tone * beat + low * .5) * .5;
  });
}
/** A helicopter: one second holding ten rotor slaps (a low thump and a short crack), a buzz at the tail rotor's rate, and a thin whine. */
export function helicopterBuffer(context: BaseAudioContext) {
  const rand = noise(23), pulse = 1 / (MAIN_ROTOR_HZ * MAIN_BLADES); let low = 0, high = 0;
  return render(context, 1, t => {
    const since = t % pulse, slap = Math.exp(-since * 55) * Math.min(1, since * 900);
    low += (rand() - low) * .08; high += (rand() - high) * .55;
    const thump = Math.sin(2 * Math.PI * 46 * since) * Math.exp(-since * 38) * 1.3 + low * 2.2 * slap + high * .5 * Math.exp(-since * 120);
    const buzz = high * .09 * (.5 + .5 * Math.sin(2 * Math.PI * TAIL_ROTOR_HZ * 4 * t)), whine = Math.sin(2 * Math.PI * 1100 * t) * .018 + Math.sin(2 * Math.PI * 1650 * t) * .01;
    return Math.max(-1, Math.min(1, thump * .55 + buzz + whine));
  });
}

type Voice = { source: AudioBufferSourceNode; gain: GainNode; panner: PannerNode; filter: BiquadFilterNode; level: number; target: number };

export function createRunAudio() {
  let context: AudioContext | undefined, master: GainNode | undefined, generator: AudioBuffer | undefined, heli: AudioBuffer | undefined, failed = false, disposed = false;
  const hums = new Map<string, Voice & { at: Point3 }>();
  let rotor: (Voice & { at: Point3 }) | undefined;
  // Told of every machine starting, moving and stopping (the engine: the creature hears them as running sources). For a generator it
  // may answer true, meaning the game's own engine voice (audio.ts engine(), the sound on the soundboard) plays it and this one stays quiet.
  let machine: ((id: string, at: Point3 | undefined, kind: 'generator' | 'helicopter') => boolean | void) | undefined;

  const ensure = () => {
    if (context || failed || disposed) return context;
    try {
      context = new AudioContext({ latencyHint: 'interactive' });
      master = context.createGain(); master.gain.value = .9; master.connect(context.destination);
      generator = generatorBuffer(context); heli = helicopterBuffer(context);
    } catch (error) { failed = true; console.warn('SILENCE: the run\'s machines will be silent (no audio context).', error); }
    return context;
  };
  const voice = (buffer: AudioBuffer, panner: { ref: number; rolloff: number; max: number }): Voice | undefined => {
    if (!context || !master) return undefined;
    const source = context.createBufferSource(), gain = context.createGain(), p = context.createPanner(), filter = context.createBiquadFilter();
    source.buffer = buffer; source.loop = true; gain.gain.value = 0; filter.type = 'lowpass'; filter.frequency.value = 6000;
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = panner.ref; p.rolloffFactor = panner.rolloff; p.maxDistance = panner.max;
    source.connect(filter).connect(gain).connect(p).connect(master); source.start();
    return { source, gain, panner: p, filter, level: 0, target: 0 };
  };
  const place = (v: Voice, at: Point3) => { v.panner.positionX.value = at.x; v.panner.positionY.value = at.y; v.panner.positionZ.value = at.z; };

  return {
    /** A running generator, by id, at a place; `undefined` stops it. */
    setHum(id: string, at: Point3 | undefined, level = .5) {
      const had = hums.get(id);
      if (machine?.(id, at, 'generator') === true) { if (had) had.target = 0; return; }
      if (!at) { if (had) had.target = 0; return; }
      if (!had && !ensure()) return;
      let v = had;
      if (!v) { const made = generator && voice(generator, { ref: 6, rolloff: 1.4, max: 400 }); if (!made) return; v = { ...made, at }; hums.set(id, v); }
      v.at = at; v.target = level; place(v, at);
    },
    /** The helicopter's rotors: where it is, and how fast they turn (0 stopped .. 1 flying). `undefined` silences it. */
    setHelicopter(at: Point3 | undefined, rpm = 1, level = 1) {
      machine?.('helicopter', at && rpm > .05 ? at : undefined, 'helicopter');
      if (!at) { if (rotor) rotor.target = 0; return; }
      if (!rotor && !ensure()) return;
      if (!rotor) { const made = heli && voice(heli, { ref: 70, rolloff: .85, max: 4000 }); if (!made) return; rotor = { ...made, at }; }
      rotor.at = at; rotor.target = level * Math.min(1, rpm * 1.2); place(rotor, at);
      rotor.source.playbackRate.value = .55 + .45 * Math.min(1, Math.max(0, rpm));
    },
    /** Once a frame: the listener (the camera), the fades, and the context's sleep while the game is not being played. */
    update(dt: number, listener: { position: Point3; forward: Point3 }, active: boolean) {
      if (!context) return;
      if (!active) { if (context.state === 'running') void context.suspend(); return; }
      if (context.state === 'suspended') void context.resume();
      const l = context.listener, f = listener.forward;
      if (l.positionX) { l.positionX.value = listener.position.x; l.positionY.value = listener.position.y; l.positionZ.value = listener.position.z; l.forwardX.value = f.x; l.forwardY.value = f.y; l.forwardZ.value = f.z; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0; }
      const k = 1 - Math.exp(-dt * 2.2);
      const step = (v: Voice & { at: Point3 }, far: number) => {
        v.level += (v.target - v.level) * k; v.gain.gain.value = v.level;
        const d = Math.hypot(v.at.x - listener.position.x, v.at.y - listener.position.y, v.at.z - listener.position.z);
        v.filter.frequency.value = 900 + 9000 / (1 + d / far);
      };
      for (const v of hums.values()) step(v, 60);
      if (rotor) step(rotor, 260);
    },
    resume() { if (context && context.state === 'suspended') void context.resume(); },
    /** Who to tell about machines (see `machine` above); one listener. */
    onMachine(listener: typeof machine) { machine = listener; },
    get started() { return !!context; },
    dispose() {
      disposed = true;
      for (const v of [...hums.values(), ...(rotor ? [rotor] : [])]) { try { v.source.stop(); } catch { /* already stopped */ } v.source.disconnect(); v.gain.disconnect(); }
      hums.clear(); rotor = undefined;
      void context?.close(); context = undefined;
    },
  };
}
export type RunAudio = ReturnType<typeof createRunAudio>;
