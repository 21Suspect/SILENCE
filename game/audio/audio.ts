import type * as THREE from 'three';
import {createBreathing, type Breath} from '../sim/player/breathing';
import { riverX, waterHeightAt } from '../sim/world/world';
import { coastDistance, SEA_LEVEL } from '../sim/world/coastal-geography';
import { WORLD_V2 } from '../sim/world/world-flags';
import { volumeGain, type Settings } from '../core/settings';

type Surface = 'dirt' | 'road' | 'water' | 'wood';
export type ForestAudioFrame = {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
  sprinting: boolean;
  /** The player's stamina, 1 full .. 0 empty, and whether they are locked out of sprinting: this is what the breathing follows. */
  stamina?: number;
  winded?: boolean;
  darkness: number;
  surface: Surface;
  riverDistance: number;
};
type Point = { x: number; y: number; z: number };

/** A deliberately quiet soundscape. Nothing is audible until a user gesture. */
/** How many takes of each creature sound ship in public/audio/creature (see tools/assets/audio/creature_sounds.py). */
export const CREATURE_TAKES = { screech: 5, hiss: 6, branch: 6, call: 4, clicks: 8, knock_trunk: 4 } as const;
export type CreatureSound = keyof typeof CREATURE_TAKES;

/** Field recordings in public/audio/ambience (see tools/assets/audio/ambience.py). `owls` is not a bed: it is heard now and then, far off. */
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
  // Full-strength baseline; user sliders remain independent.
  private volume = { master: 1, ambience: 1, creature: 1 };
  private listening = false;
  private noise: AudioBuffer | null = null;
  private field: {panner:PannerNode;gain:GainNode;point:Point;kind:number;level:number;initialized:boolean;relocating:boolean}[]=[];
  private breathing=createBreathing();
  private revealPanner:PannerNode|null=null;
  private revealPoint:Point|null=null;
  private surfVoices: {gain:GainNode;pan:PannerNode;side:number}[]=[];
  private riverGain: GainNode | null = null;
  private riverPanner: PannerNode | null = null;

  private sources = new Set<AudioScheduledSourceNode>();
  private disposed = false;
  private ambienceDirections = new Map<PannerNode, Point>();
  private stepSide = 1;
  private stepTake = 0;
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
    // The creature's voice: takes rendered by tools/assets/audio/creature_sounds.py. Until one is decoded its sound is simply skipped.
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
    // Recorded stream, faded and spatialized at the nearest river segment.
    const water=context.createGain(), riverPan=context.createPanner();
    water.gain.value=0; riverPan.panningModel='HRTF';riverPan.rolloffFactor=0;
    water.connect(riverPan).connect(ambienceGroup);this.riverPanner=riverPan;
    void fetch('/audio/ambience/river.mp3').then(r=>{if(!r.ok)throw Error('River unavailable');return r.arrayBuffer();}).then(b=>context.decodeAudioData(b)).then(buffer=>{
      if(this.disposed)return;
      // Crossfade the recording ends once, instead of clicking at each loop seam.
      const n=Math.min(context.sampleRate*3,Math.floor(buffer.length/4)), length=buffer.length-n;
      const loop=context.createBuffer(1,length,buffer.sampleRate), out=loop.getChannelData(0);
      for(let i=0;i<length;i++){let v=0;for(let c=0;c<buffer.numberOfChannels;c++){const a=buffer.getChannelData(c);v+=i<n?a[i]*(i/n)+a[length+i]*(1-i/n):a[i];}out[i]=v/buffer.numberOfChannels;}
      const source=context.createBufferSource();source.buffer=loop;source.loop=true;source.connect(water);this.track(source,[water,riverPan]);source.start();
    }).catch(e=>console.warn('SILENCE: river recording unavailable',e));
    if(WORLD_V2)void fetch('/audio/ambience/surf.mp3').then(r=>{if(!r.ok)throw Error('Surf unavailable');return r.arrayBuffer();}).then(b=>context.decodeAudioData(b)).then(buffer=>{
      if(this.disposed)return;
      // Two coherent channels placed along the beach retain the recording's
      // stereo width while the entire sound field follows the coast, not the head.
      const n=Math.min(buffer.sampleRate*3,Math.floor(buffer.length/4)),length=buffer.length-n;
      for(let c=0;c<2;c++){
        const loop=context.createBuffer(1,length,buffer.sampleRate),out=loop.getChannelData(0),a=buffer.getChannelData(c%buffer.numberOfChannels);
        for(let i=0;i<length;i++)out[i]=i<n?a[i]*(i/n)+a[length+i]*(1-i/n):a[i];
        const source=context.createBufferSource(),gain=context.createGain(),pan=context.createPanner();
        source.buffer=loop;source.loop=true;gain.gain.value=0;pan.panningModel='HRTF';pan.rolloffFactor=0;
        source.connect(gain).connect(pan).connect(ambienceGroup);this.track(source,[gain,pan]);source.start();
        this.surfVoices.push({gain,pan,side:c===0?-1:1});
      }
    }).catch(e=>console.warn('SILENCE: surf recording unavailable',e));
    for(const material of ['Sand','Stone'])for(const side of ['L','R'])for(let i=1;i<=3;i++){
      const name=`${material}${side}${i}`;
      void fetch(`/audio/footsteps/${name}.wav`).then(r=>{if(!r.ok)throw Error(name);return r.arrayBuffer();}).then(b=>context.decodeAudioData(b)).then(b=>{if(!this.disposed)this.beds.set(name,b);}).catch(e=>console.warn('SILENCE: footstep unavailable',e));
    }

    for(const kind of ['wood','gravel'])for(let i=0;i<10;i++){
      const name=kind+i;void fetch(`/audio/footsteps/${name}.wav`).then(r=>{if(!r.ok)throw Error(name);return r.arrayBuffer();}).then(b=>context.decodeAudioData(b)).then(b=>{if(!this.disposed)this.beds.set(name,b);}).catch(e=>console.warn('Footstep unavailable',e));
    }
    this.riverGain = water;
    await context.resume();
    master.gain.setTargetAtTime(0.68, context.currentTime, 2.2);
  }

  private track(source: AudioScheduledSourceNode, cleanup: AudioNode[] = []): void {
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      for (const node of cleanup) { this.ambienceDirections.delete(node as PannerNode); node.disconnect(); }
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

  /**
   * The player's own breath: an inhale and an exhale of band-passed noise, shaped by game/sim/player/breathing.ts (which decides the
   * timing, the colour of each half and the little differences between breaths). It is head-local, with no panner, and it
   * feeds the master bus like the footsteps, so only the master slider moves it. Nothing here is an oscillator, so it cannot
   * whistle. Both halves are scheduled at once, one set of nodes per half, and the nodes are dropped when the noise ends.
   */
  private playerBreath(breath:Breath){
    if(!this.context||!this.noise||!this.master||this.context.state!=='running')return;
    const c=this.context,now=c.currentTime+.02;
    for(const part of [breath.inhale,breath.exhale]){
      const start=now+part.delay,end=start+part.duration;
      const source=c.createBufferSource(),high=c.createBiquadFilter(),envelope=c.createGain();
      source.buffer=this.noise;
      high.type='highpass';high.frequency.value=part.highpass;high.Q.value=.5;
      source.connect(high);
      const nodes:AudioNode[]=[high,envelope];
      for(const band of part.bands){
        const filter=c.createBiquadFilter(),gain=c.createGain();
        filter.type='bandpass';filter.Q.value=band.q;
        // The colour glides over the breath: an inhale brightens, an exhale sinks as the air runs out.
        filter.frequency.setValueAtTime(band.frequency,start);filter.frequency.exponentialRampToValueAtTime(band.frequency*part.sweep,end);
        gain.gain.value=band.gain;
        high.connect(filter).connect(gain).connect(envelope);nodes.push(filter,gain);
      }
      envelope.gain.value=0;envelope.gain.setValueCurveAtTime(part.curve,start,part.duration);
      envelope.connect(this.master);
      // The noise buffer is 8 s long; start somewhere in its first five seconds so the segment (at most about two seconds) never runs off the end.
      this.track(source,nodes);source.start(start,Math.random()*5);source.stop(end+.05);
    }
  }

  private footstep(surface: Surface, speed: number): void {
    const force = 0.55 + Math.min(speed, 3.4) * 0.14;
    if(surface!=='water'){
      this.stepSide*=-1;this.stepTake=(this.stepTake+1+Math.floor(Math.random()*9))%10;
      const buffer=this.beds.get(surface==='road'?`Stone${this.stepSide<0?'L':'R'}${this.stepTake%3+1}`:`${surface==='wood'?'wood':'gravel'}${this.stepTake}`);
      if(!buffer||!this.context||!this.master)return;
      const source=this.context.createBufferSource(), gain=this.context.createGain(), pan=this.context.createStereoPanner();
      source.buffer=buffer;source.playbackRate.value=.97+Math.random()*.06;
      gain.gain.value=(surface==='dirt'?.19:.22)*force*(.88+Math.random()*.24);pan.pan.value=0;
      gain.channelCount=1;gain.channelCountMode='explicit';
      source.connect(gain).connect(pan).connect(this.master);this.track(source,[gain,pan]);source.start();
    }else{
      this.noiseHit({ duration: 0.48, frequency: 1600, level: 0.12 * force, attack: 0.026 });
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
    // Diffuse forest ambience follows translation, but not head rotation. It
    // surrounds the listener anywhere on the map instead of collecting behind them.
    for(const [pan,offset] of this.ambienceDirections){
      pan.positionX.value=info.position.x+offset.x;
      pan.positionY.value=info.position.y+offset.y;
      pan.positionZ.value=info.position.z+offset.z;
    }
    if(this.revealPanner&&this.revealPoint){const p=this.revealPoint;this.revealPanner.positionX.setTargetAtTime(p.x,now,.04);this.revealPanner.positionY.setTargetAtTime(p.y,now,.04);this.revealPanner.positionZ.setTargetAtTime(p.z,now,.04);}
    const breath=this.breathing.update(dt,{stamina:info.stamina??1,winded:info.winded??false});
    if(breath.breath)this.playerBreath(breath.breath);
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
    const river = Math.exp(-Math.max(0, riverDistance) / 11) * (1 - smoothstep(riverDistance, 35, 55));
    this.riverGain?.gain.setTargetAtTime(river * 0.9, now, 0.5);
    if(this.surfVoices.length){
      const x=info.position.x,z=info.position.z,d=coastDistance(x,z);
      let nx=coastDistance(x+1,z)-coastDistance(x-1,z),nz=coastDistance(x,z+1)-coastDistance(x,z-1);
      const length=Math.hypot(nx,nz)||1;nx/=length;nz/=length;
      const level=(1-smoothstep(Math.abs(d),12,100))*.42;
      for(const voice of this.surfVoices){
        voice.gain.gain.setTargetAtTime(level,now,.5);
        voice.pan.positionX.setTargetAtTime(x-nx*(d+7)-nz*voice.side*18,now,.25);
        voice.pan.positionZ.setTargetAtTime(z-nz*(d+7)+nx*voice.side*18,now,.25);
        voice.pan.positionY.setTargetAtTime(SEA_LEVEL+.3,now,.25);
      }
    }
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
      // Opposing bearings form a surrounding field, kept relative to listener position.
      const split=context.createChannelSplitter(2), nodes:AudioNode[]=[gain,split];
      source.connect(gain).connect(split);
      const bearing=group==='day'?.45:group==='night'?2.6:4.1;
      for(let channel=0;channel<2;channel++){
        const pan=context.createPanner(), angle=bearing+channel*Math.PI;
        pan.panningModel='HRTF';pan.rolloffFactor=0;
        this.ambienceDirections.set(pan,{x:Math.sin(angle)*45,y:group==='wind'?18:6,z:Math.cos(angle)*45});
        pan.positionX.value=info.position.x+Math.sin(angle)*45;
        pan.positionY.value=info.position.y+(group==='wind'?18:6);
        pan.positionZ.value=info.position.z+Math.cos(angle)*45;
        split.connect(pan,Math.min(channel,buffer.numberOfChannels-1));pan.connect(buses[group]);nodes.push(pan);
      }
      this.track(source,nodes);
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
    this.riverPanner = null;this.revealPanner=null;this.revealPoint=null;this.field=[];this.ambienceDirections.clear();this.buses=null;this.voices={};this.beds.clear();
  }
}
