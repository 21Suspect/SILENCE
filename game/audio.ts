import type * as THREE from 'three';
import {createBreathing} from './breathing';
import { riverX, waterHeightAt } from './world';
import { volumeGain, type Settings } from './settings';

type Surface = 'dirt' | 'road' | 'water';
export type ForestAudioFrame = {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  sprinting: boolean;
  darkness: number;
  surface: Surface;
  riverDistance: number;
};
type Point = { x: number; y: number; z: number };

/** A deliberately quiet soundscape. Nothing is audible until a user gesture. */
/** How many takes of each creature sound ship in public/audio/creature (see scripts/assets/audio/creature_sounds.py). */
export const CREATURE_TAKES = { screech: 5, hiss: 6, branch: 6, call: 4, clicks: 8, knock_trunk: 4 } as const;
export type CreatureSound = keyof typeof CREATURE_TAKES;

/** Field recordings in public/audio/ambience (see scripts/assets/audio/ambience.py). `owls` is not a bed: it is heard now and then, far off. */
const AMBIENCE = { day: ['day_1', 'day_2'], night: ['night_1', 'night_2'], wind: ['wind'] } as const;
type AmbienceGroup = keyof typeof AMBIENCE;
type AmbienceVoice = { name: string; source: AudioBufferSourceNode; gain: GainNode };
const smoothstep = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class ForestAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  // The player's mix (Settings > Sound). Ambience and creature are groups the game's own gains feed into, and master sits last, so each
  // slider multiplies with the fades below (master.gain, the buses, hush) instead of replacing them.
  private userMaster: GainNode | null = null;
  private ambienceGroup: GainNode | null = null;
  private creatureGroup: GainNode | null = null;
  private volume = { master: 1, ambience: 1, creature: 1 };
  private listening = false;
  private noise: AudioBuffer | null = null;
  private field: {panner:PannerNode;gain:GainNode;point:Point;kind:number;level:number;initialized:boolean;relocating:boolean}[]=[];
  private breathing=createBreathing();
  private revealPanner:PannerNode|null=null;
  private revealPoint:Point|null=null;
  private riverGain: GainNode | null = null;
  private riverPanner: PannerNode | null = null;

  private sources = new Set<AudioScheduledSourceNode>();
  private disposed = false;
  private travelled = 0;
  private lastStep = -10;
  private age = 0;
  private lastStalkCue = -Infinity;
  private revealBuffer: AudioBuffer | null = null;
  private samples = new Map<CreatureSound, AudioBuffer[]>();
  private beds = new Map<string, AudioBuffer>();
  private buses: Record<AmbienceGroup, GainNode> | null = null;
  private voices: Partial<Record<AmbienceGroup, AmbienceVoice>> = {};
  private swapAt: Record<AmbienceGroup, number> = { day: 0, night: 0, wind: 0 };
  private owlAt = 90 + Math.random() * 120;
  private hushTarget = 0;
  private hushLevel = 0;
  private lastTake = new Map<CreatureSound, number>();
  private revealSource: AudioBufferSourceNode | null = null;
  private position: Point = { x: 0, y: 0, z: 0 };

  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.context) {
      await this.context.resume();
      return;
    }
    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;
    // Decode once after audio is unlocked; encounter playback retries until ready.
    void fetch('/audio/scary%20sound.mp3').then(r=>{if(!r.ok)throw new Error('Reveal audio unavailable');return r.arrayBuffer();}).then(bytes=>context.decodeAudioData(bytes)).then(buffer=>{if(!this.disposed)this.revealBuffer=buffer;}).catch(error=>console.warn('SILENCE: reveal audio could not load',error));
    // The creature's voice: takes rendered by scripts/assets/audio/creature_sounds.py. Until one is decoded its sound is simply skipped.
    for (const [group, count] of Object.entries(CREATURE_TAKES) as [CreatureSound, number][]) for (let take = 1; take <= count; take++) {
      void fetch(`/audio/creature/${group}_${take}.mp3`).then(r => { if (!r.ok) throw new Error(`${group}_${take} unavailable`); return r.arrayBuffer(); }).then(bytes => context.decodeAudioData(bytes))
        .then(buffer => { if (this.disposed) return; const list = this.samples.get(group) ?? []; list.push(buffer); this.samples.set(group, list); }).catch(error => console.warn('SILENCE: creature sound could not load.', error));
    }
    const master = context.createGain();
    master.gain.value = 0;
    this.master = master;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.5;
    compressor.attack.value = 0.025;
    compressor.release.value = 0.3;
    // sources -> [ambience | creature group] -> master (the game's fades) -> compressor -> player's master volume -> speakers.
    // Footsteps, breathing and the torch click feed master directly. The master slider sits after the compressor so it is a plain volume knob.
    const userMaster = context.createGain(), ambienceGroup = context.createGain(), creatureGroup = context.createGain();
    userMaster.gain.value = this.volume.master; ambienceGroup.gain.value = this.volume.ambience; creatureGroup.gain.value = this.volume.creature;
    ambienceGroup.connect(master); creatureGroup.connect(master);
    this.userMaster = userMaster; this.ambienceGroup = ambienceGroup; this.creatureGroup = creatureGroup;
    master.connect(compressor).connect(userMaster).connect(context.destination);
    const length = context.sampleRate * 8;
    this.noise = context.createBuffer(1, length, context.sampleRate);
    const white = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) white[i] = Math.random() * 2 - 1;

    // The forest itself: real recordings on three buses. Nothing plays until its file has decoded.
    this.buses = { day: context.createGain(), night: context.createGain(), wind: context.createGain() };
    for (const bus of Object.values(this.buses)) { bus.gain.value = 0; bus.connect(ambienceGroup); }
    for (const name of [...AMBIENCE.day, ...AMBIENCE.night, ...AMBIENCE.wind, 'owls']) {
      void fetch(`/audio/ambience/${name}.mp3`).then(r => { if (!r.ok) throw new Error(`${name} unavailable`); return r.arrayBuffer(); }).then(bytes => context.decodeAudioData(bytes))
        .then(buffer => { if (!this.disposed) this.beds.set(name, buffer); }).catch(error => console.warn('SILENCE: ambience could not load.', error));
    }
    const water = this.loop(0, 1200, 'lowpass', 0, 1.13, true);

    this.riverGain = water;
    await context.resume();
    master.gain.setTargetAtTime(0.68, context.currentTime, 2.2);
  }

  private track(source: AudioScheduledSourceNode, cleanup: AudioNode[] = []): void {
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      for (const node of cleanup) node.disconnect();
    };
  }

  private loop(level: number, frequency: number, type: BiquadFilterType, fieldIndex: number, rate: number, river = false): GainNode {
    const context = this.context!;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    source.playbackRate.value = rate;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.3;
    const gain = context.createGain();
    gain.gain.value = level;
    let outlet: AudioNode;
    if (river) {
      const panner = context.createPanner();
      panner.panningModel = 'HRTF';
      // Distance is controlled continuously by the river gain below. The spatial
      // node supplies bearing and height without attenuating a second time.
      panner.rolloffFactor = 0;
      panner.positionY.value = waterHeightAt(0);
      this.riverPanner = panner;
      outlet = panner;
    } else {
      const spatial=context.createPanner();spatial.panningModel='HRTF';spatial.rolloffFactor=0;
      this.field.push({panner:spatial,gain,point:{x:0,y:0,z:0},kind:fieldIndex,level:0,initialized:false,relocating:false});outlet=spatial;
    }
    source.connect(filter).connect(gain).connect(outlet).connect(this.ambienceGroup!);
    this.track(source, [filter, gain, outlet]);
    source.start(0, Math.random() * 6);
    return gain;
  }

  private spatial(point: Point | undefined, to: AudioNode): AudioNode {
    const context = this.context!;
    if (!point) return to;
    const pan = context.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = 5;
    pan.maxDistance = 130;
    pan.rolloffFactor = 0.8;
    pan.positionX.value = point.x;
    pan.positionY.value = point.y;
    pan.positionZ.value = point.z;
    pan.connect(to);
    return pan;
  }

  private noiseHit(options: {
    duration: number; level: number; frequency: number;
    type?: BiquadFilterType; attack?: number; delay?: number; position?: Point; rate?: number; to?: AudioNode;
  }): void {
    if (!this.context || !this.noise || !this.master || this.context.state !== 'running') return;
    const context = this.context;
    const at = context.currentTime + (options.delay || 0);
    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = options.rate || 1;
    const filter = context.createBiquadFilter();
    filter.type = options.type || 'lowpass';
    filter.frequency.setValueAtTime(options.frequency, at);
    filter.Q.value = 0.7;
    const envelope = context.createGain();
    const attack = options.attack || 0.008;
    envelope.gain.setValueAtTime(0.00001, at);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, options.level), at + attack);
    envelope.gain.exponentialRampToValueAtTime(0.00001, at + options.duration);
    const to = options.to ?? this.master, outlet = this.spatial(options.position, to);
    source.connect(filter).connect(envelope).connect(outlet);
    this.track(source, [filter, envelope, ...(outlet === to ? [] : [outlet])]);
    source.start(at, Math.random() * 4);
    source.stop(at + options.duration + 0.025);
  }

  private tone(options: {
    frequency: number; endFrequency?: number; duration: number; level: number;
    delay?: number; attack?: number; position?: Point; type?: OscillatorType; to?: AudioNode;
  }): void {
    if (!this.context || this.context.state !== 'running' || !this.master) return;
    const context = this.context;
    const at = context.currentTime + (options.delay || 0);
    const source = context.createOscillator();
    source.type = options.type || 'sine';
    source.frequency.setValueAtTime(options.frequency, at);
    source.frequency.exponentialRampToValueAtTime(options.endFrequency || options.frequency, at + options.duration);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.00001, at);
    envelope.gain.exponentialRampToValueAtTime(options.level, at + (options.attack || 0.012));
    envelope.gain.exponentialRampToValueAtTime(0.00001, at + options.duration);
    const to = options.to ?? this.master, outlet = this.spatial(options.position, to);
    source.connect(envelope).connect(outlet);
    this.track(source, [envelope, ...(outlet === to ? [] : [outlet])]);
    source.start(at);
    source.stop(at + options.duration + 0.02);
  }

  /** Head-local airflow: rounded inhale, softer throat resonance, longer exhale.
   * New envelopes are scheduled only once per breath; no per-frame nodes. */
  private playerBreath(effort:number){
    if(!this.context||!this.noise||!this.master)return;
    const c=this.context,now=c.currentTime,pace=1-effort*.24;
    for(let phase=0;phase<2;phase++){
      const source=c.createBufferSource(),high=c.createBiquadFilter(),low=c.createBiquadFilter(),envelope=c.createGain();
      source.buffer=this.noise;source.playbackRate.value=.74+Math.random()*.12;
      high.type='highpass';high.frequency.value=phase?170:260;high.Q.value=.5;
      low.type='lowpass';low.frequency.setValueAtTime(phase?900:1500,now);low.Q.value=.55;
      const start=now+(phase?.71*pace:0),duration=(phase?.91:.62)*pace;
      const curve=new Float32Array(48),level=(phase?.105:.078)*effort;
      for(let i=0;i<48;i++){const t=i/47;curve[i]=Math.pow(Math.sin(Math.PI*t),phase?1.7:1.25)*level*(.93+Math.sin(t*23)*.07);}
      envelope.gain.value=0;envelope.gain.setValueCurveAtTime(curve,start,duration);
      source.connect(high).connect(low).connect(envelope).connect(this.master);
      this.track(source,[high,low,envelope]);source.start(start,Math.random()*5);source.stop(start+duration+.02);
    }
  }

  private footstep(surface: Surface, speed: number): void {
    const force = 0.55 + Math.min(speed, 3.4) * 0.14;
    this.tone({ frequency: 74 + Math.random() * 18, endFrequency: 33, duration: 0.13, level: 0.055 * force });
    if (surface === 'water') {
      this.noiseHit({ duration: 0.48, frequency: 1600, level: 0.18 * force, attack: 0.026 });
      this.noiseHit({ duration: 0.2, frequency: 3500, level: 0.055, delay: 0.12, type: 'bandpass' });
    } else {
      this.noiseHit({ duration: 0.24, frequency: surface === 'road' ? 1900 : 950, level: 0.095 * force });
      for (let i = 0; i < 4; i++) {
        this.noiseHit({ duration: 0.035 + Math.random() * 0.07, frequency: 1800 + Math.random() * 2400,
          level: (surface === 'road' ? 0.018 : 0.035) * force, delay: 0.018 + Math.random() * 0.17 });
      }
      if (surface === 'dirt') this.noiseHit({ duration: 0.2, frequency: 320, level: 0.075, delay: 0.055, type: 'bandpass' });
    }
  }

  /** A small, dry switch sound; safe before the first audio gesture. */
  flashlightClick(): void {
    if (!this.context || this.context.state !== 'running') return;
    this.noiseHit({ duration: 0.038, level: 0.028, frequency: 2400, type: 'bandpass', attack: 0.003 });
    this.tone({ frequency: 280, endFrequency: 130, duration: 0.045, level: 0.009, attack: 0.003 });
  }

  /** Localized spawn cue: HRTF bearing without losing audibility at range. */
  creatureReveal(position: Point): boolean {
    if (!this.context || this.context.state !== 'running' || !this.creatureGroup || !this.revealBuffer) return false;
    this.revealSource?.stop();
    const source=this.context.createBufferSource(),gain=this.context.createGain();
    source.buffer=this.revealBuffer;gain.gain.value=.72;
    const panner=this.context.createPanner();panner.panningModel='HRTF';panner.rolloffFactor=0;panner.channelCount=1;panner.channelCountMode='explicit';
    panner.positionX.value=position.x;panner.positionY.value=position.y;panner.positionZ.value=position.z;
    this.revealPanner=panner;this.revealPoint=position;
    source.connect(gain).connect(panner).connect(this.creatureGroup);this.track(source,[gain,panner]);
    this.revealSource=source;source.addEventListener('ended',()=>{if(this.revealSource===source){this.revealSource=null;this.revealPanner=null;this.revealPoint=null;}});
    source.start();return true;
  }

  /**
   * One recorded take of a creature sound, from a point in the world. Takes never repeat back to back and
   * each is played a touch faster or slower, so the animal never makes exactly the same noise twice.
   * `reach` is the distance (m) at which it starts to fall away.
   */
  private sample(group: CreatureSound, position: Point, level: number, reach: number): boolean {
    const takes = this.samples.get(group);
    if (!this.context || this.context.state !== 'running' || !this.creatureGroup || !takes?.length) return false;
    let index = Math.floor(Math.random() * takes.length);
    if (takes.length > 1 && index === this.lastTake.get(group)) index = (index + 1 + Math.floor(Math.random() * (takes.length - 1))) % takes.length;
    this.lastTake.set(group, index);
    const c = this.context, source = c.createBufferSource(), gain = c.createGain(), pan = c.createPanner();
    source.buffer = takes[index]; source.playbackRate.value = .96 + Math.random() * .08; gain.gain.value = level;
    pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = reach; pan.maxDistance = 160; pan.rolloffFactor = 1;
    pan.positionX.value = position.x; pan.positionY.value = position.y; pan.positionZ.value = position.z;
    source.connect(gain).connect(pan).connect(this.creatureGroup); this.track(source, [gain, pan]);
    source.start();
    return true;
  }

  /** Soft throat clicks from where it stands: close, unseen, and not trying to be heard. */
  stalkCue(position: Point): boolean {
    if (!this.context || this.context.state !== 'running') return false;
    const now = this.context.currentTime;
    if (now - this.lastStalkCue < 6) return false;
    if (!this.sample('clicks', position, .9, 5)) return false;
    this.lastStalkCue = now;
    return true;
  }

  /** It raps on the trunk beside it. */
  knock(position: Point): boolean { return this.sample('knock_trunk', position, .85, 7); }

  /** The roar: the grab at full strength right at the face, quieter when a hunt begins at range. */
  screech(position: Point, intensity = 1): void { this.sample('screech', position, .35 + .65 * intensity, 10); }

  /** Pinned by the torch. */
  hiss(position: Point): void { this.sample('hiss', position, .85, 6); }

  cue(kind: 'branch' | 'breath' | 'call', position: THREE.Vector3): void {
    if (!this.context || this.context.state !== 'running') return;
    if (kind === 'branch') this.sample('branch', position, 1, 12);
    else if (kind === 'call') this.sample('call', position, .9, 35);
    else {
      const to = this.creatureGroup ?? undefined;
      this.noiseHit({ duration: 2.3, level: 0.055, frequency: 680, type: 'bandpass', attack: 0.65, position, to });
      this.noiseHit({ duration: 2.1, level: 0.017, frequency: 1400, type: 'bandpass', attack: 0.8, position, delay: 0.1, to });
    }
  }

  update(dt: number, info: ForestAudioFrame): void {
    if (!this.context || this.context.state !== 'running' || this.disposed) return;
    this.age += dt;
    this.position = info.position;
    const context = this.context;
    const now = context.currentTime;
    const listener = context.listener;
    listener.positionX.value = info.position.x;
    listener.positionY.value = info.position.y;
    listener.positionZ.value = info.position.z;
    listener.forwardX.value = info.direction.x;
    listener.forwardY.value = info.direction.y;
    listener.forwardZ.value = info.direction.z;
    listener.upX.value = 0;
    listener.upY.value = 1;
    listener.upZ.value = 0;
    this.ambience(dt, info, now);
    if(this.revealPanner&&this.revealPoint){const p=this.revealPoint;this.revealPanner.positionX.setTargetAtTime(p.x,now,.04);this.revealPanner.positionY.setTargetAtTime(p.y,now,.04);this.revealPanner.positionZ.setTargetAtTime(p.z,now,.04);}
    const breath=this.breathing.update(dt,info.sprinting&&info.speed>.65);
    if(breath.breathe)this.playerBreath(breath.level);
    // Project onto the curved stream, rather than pinning its sound to one ear.
    let riverZ = info.position.z;
    for (let i = 0; i < 3; i++) {
      const slope = (riverX(riverZ + 0.1) - riverX(riverZ - 0.1)) / 0.2;
      const along = ((riverX(riverZ) - info.position.x) * slope + riverZ - info.position.z) / (1 + slope * slope);
      riverZ -= Math.max(-12, Math.min(12, along));
    }
    const riverPointX = riverX(riverZ);
    const riverDistance = Math.hypot(riverPointX - info.position.x, riverZ - info.position.z);
    if (this.riverPanner) {
      this.riverPanner.positionX.setTargetAtTime(riverPointX, now, 0.12);
      this.riverPanner.positionY.setTargetAtTime(waterHeightAt(riverZ), now, 0.12);
      this.riverPanner.positionZ.setTargetAtTime(riverZ, now, 0.12);
    }
    const river = Math.exp(-Math.max(0, riverDistance) / 11);
    this.riverGain?.gain.setTargetAtTime(river * 0.14, now, 0.5);
    if (info.speed > 0.08) {
      this.travelled += info.speed * dt;
      if (this.travelled > 0.82 && this.age - this.lastStep > 0.28) {
        this.travelled %= 0.82;
        this.lastStep = this.age;
        this.footstep(info.surface, info.speed);
      }
    } else this.travelled = Math.min(this.travelled, 0.55);
  }

  /** The creature is near: the birds stop. Call every frame it is close, with 0..1; it lets go by itself. */
  hush(level: number): void { this.hushTarget = Math.max(this.hushTarget, Math.min(1, Math.max(0, level))); }

  /**
   * Day and night beds cross over with the light, wind rises and falls in gusts, and no bed is ever heard the same
   * way twice: each starts somewhere at random in its recording and, every minute or two, hands over to the other
   * recording of its kind (again from a random point) through a slow cross-fade.
   */
  private ambience(dt: number, info: ForestAudioFrame, now: number): void {
    const buses = this.buses, context = this.context;
    if (!buses || !context) return;
    for (const group of Object.keys(AMBIENCE) as AmbienceGroup[]) {
      const current = this.voices[group], loaded = AMBIENCE[group].filter(name => this.beds.has(name));
      if (!loaded.length || (current && this.age < this.swapAt[group])) continue;
      const others = loaded.filter(name => name !== current?.name), name = (others.length ? others : loaded)[Math.floor(Math.random() * (others.length || loaded.length))];
      if (current && name === current.name && group !== 'wind') { this.swapAt[group] = this.age + 30; continue; }   // its partner has not decoded yet
      const buffer = this.beds.get(name)!, source = context.createBufferSource(), gain = context.createGain(), fade = current ? 14 : 4;
      source.buffer = buffer; source.loop = true;
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(1, now + fade);
      source.connect(gain).connect(buses[group]); this.track(source, [gain]);
      source.start(now, Math.random() * buffer.duration);
      if (current) { current.gain.gain.cancelScheduledValues(now); current.gain.gain.setValueAtTime(current.gain.gain.value, now); current.gain.gain.linearRampToValueAtTime(0, now + fade); current.source.stop(now + fade + .1); }
      this.voices[group] = { name, source, gain };
      this.swapAt[group] = this.age + 75 + Math.random() * 90;
    }
    this.hushLevel += (this.hushTarget - this.hushLevel) * (1 - Math.exp(-dt / (this.hushTarget > this.hushLevel ? 1.2 : 6)));
    this.hushTarget *= Math.exp(-dt / 3);
    const night = smoothstep(info.darkness, .35, .78), quiet = 1 - this.hushLevel;
    const gust = .55 + Math.sin(this.age * .071) * .2 + Math.sin(this.age * .19 + 2.2) * .13 + Math.sin(this.age * .023 + 1) * .12;
    buses.day.gain.setTargetAtTime((1 - night) * .85 * (1 - this.hushLevel * .9), now, .6);
    buses.night.gain.setTargetAtTime(night * .8 * (.35 + .65 * quiet), now, .6);
    buses.wind.gain.setTargetAtTime(.5 * gust * (.75 + .25 * night), now, .8);
    // An owl, far off, on some nights: a stretch of the recording from a random point, then gone.
    if (this.age > this.owlAt) {
      this.owlAt = this.age + 200 + Math.random() * 260;
      const buffer = this.beds.get('owls');
      if (buffer && night > .8 && this.hushLevel < .2 && this.ambienceGroup) {
        const source = context.createBufferSource(), gain = context.createGain(), pan = context.createPanner(), length = 9 + Math.random() * 6, a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 40;
        source.buffer = buffer; pan.panningModel = 'HRTF'; pan.rolloffFactor = 0;
        pan.positionX.value = info.position.x + Math.sin(a) * d; pan.positionY.value = info.position.y + 14; pan.positionZ.value = info.position.z + Math.cos(a) * d;
        gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.35, now + 1.5); gain.gain.setValueAtTime(.35, now + length - 2); gain.gain.linearRampToValueAtTime(0, now + length);
        source.connect(gain).connect(pan).connect(this.ambienceGroup); this.track(source, [gain, pan]);
        source.start(now, Math.random() * Math.max(0, buffer.duration - length), length);
      }
    }
  }

  /** The player's volume sliders, in percent. Applies at once (a short ramp, no clicks) if audio is running, otherwise as it starts. */
  setVolumes(v: Pick<Settings, 'masterVolume' | 'ambienceVolume' | 'creatureVolume'>): void {
    this.volume = { master: volumeGain(v.masterVolume), ambience: volumeGain(v.ambienceVolume), creature: volumeGain(v.creatureVolume) };
    const now = this.context?.currentTime ?? 0;
    this.userMaster?.gain.setTargetAtTime(this.volume.master, now, .04);
    this.ambienceGroup?.gain.setTargetAtTime(this.volume.ambience, now, .04);
    this.creatureGroup?.gain.setTargetAtTime(this.volume.creature, now, .04);
  }

  /** The pause menu's Sound page is open: the game is paused but the forest keeps running, so a slider can be heard while it moves. */
  listen(on: boolean): void {
    this.listening = on;
    if (this.context && !this.disposed) void (on ? this.context.resume() : this.context.suspend());
  }

  suspend(): void {
    if (this.listening && document.hasFocus() && !document.hidden) return;   // paused on the Sound page; leaving the window still silences it
    if (this.context?.state === 'running') void this.context.suspend();
  }
  resume(): void { if (this.context?.state === 'suspended' && !this.disposed) void this.context.resume(); }
  dispose(): void {
    this.disposed = true;
    for (const source of this.sources) { try { source.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    if (this.context) void this.context.close();
    this.context = null;
    this.noise = null;
    this.userMaster = null; this.ambienceGroup = null; this.creatureGroup = null;
    this.riverPanner = null;this.revealPanner=null;this.revealPoint=null;this.field=[];this.buses=null;this.voices={};this.beds.clear();
  }
}
