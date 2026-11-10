import type * as THREE from 'three';
import {createBreathing} from './breathing';
import { riverX, waterHeightAt } from './world';

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
export class ForestAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
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
  private birdAt = 8 + Math.random() * 8;
  private creakAt = 22 + Math.random() * 22;
  private lastStalkCue = -Infinity;
  private revealBuffer: AudioBuffer | null = null;
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
    void fetch('/audio/creature-reveal.mp3').then(r=>{if(!r.ok)throw new Error('Reveal audio unavailable');return r.arrayBuffer();}).then(bytes=>context.decodeAudioData(bytes)).then(buffer=>{if(!this.disposed)this.revealBuffer=buffer;}).catch(error=>console.warn('SILENCE: reveal audio could not load',error));
    const master = context.createGain();
    master.gain.value = 0;
    this.master = master;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 18;
    compressor.ratio.value = 2.5;
    compressor.attack.value = 0.025;
    compressor.release.value = 0.3;
    master.connect(compressor).connect(context.destination);
    const length = context.sampleRate * 8;
    this.noise = context.createBuffer(1, length, context.sampleRate);
    const white = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) white[i] = Math.random() * 2 - 1;

    for(let i=0;i<4;i++)this.loop(0,i%2?1450:190,i%2?'bandpass':'lowpass',i,.69+i*.09);
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
    source.connect(filter).connect(gain).connect(outlet).connect(this.master!);
    this.track(source, [filter, gain, outlet]);
    source.start(0, Math.random() * 6);
    return gain;
  }

  private spatial(point?: Point): AudioNode {
    const context = this.context!;
    if (!point) return this.master!;
    const pan = context.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = 5;
    pan.maxDistance = 130;
    pan.rolloffFactor = 0.8;
    pan.positionX.value = point.x;
    pan.positionY.value = point.y;
    pan.positionZ.value = point.z;
    pan.connect(this.master!);
    return pan;
  }

  private noiseHit(options: {
    duration: number; level: number; frequency: number;
    type?: BiquadFilterType; attack?: number; delay?: number; position?: Point; rate?: number;
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
    const outlet = this.spatial(options.position);
    source.connect(filter).connect(envelope).connect(outlet);
    this.track(source, [filter, envelope, ...(outlet === this.master ? [] : [outlet])]);
    source.start(at, Math.random() * 4);
    source.stop(at + options.duration + 0.025);
  }

  private tone(options: {
    frequency: number; endFrequency?: number; duration: number; level: number;
    delay?: number; attack?: number; position?: Point; type?: OscillatorType;
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
    const outlet = this.spatial(options.position);
    source.connect(envelope).connect(outlet);
    this.track(source, [envelope, ...(outlet === this.master ? [] : [outlet])]);
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
    if (!this.context || this.context.state !== 'running' || !this.master || !this.revealBuffer) return false;
    this.revealSource?.stop();
    const source=this.context.createBufferSource(),gain=this.context.createGain();
    source.buffer=this.revealBuffer;gain.gain.value=.72;
    const panner=this.context.createPanner();panner.panningModel='HRTF';panner.rolloffFactor=0;panner.channelCount=1;panner.channelCountMode='explicit';
    panner.positionX.value=position.x;panner.positionY.value=position.y;panner.positionZ.value=position.z;
    this.revealPanner=panner;this.revealPoint=position;
    source.connect(gain).connect(panner).connect(this.master);this.track(source,[gain,panner]);
    this.revealSource=source;source.addEventListener('ended',()=>{if(this.revealSource===source){this.revealSource=null;this.revealPanner=null;this.revealPoint=null;}});
    source.start();return true;
  }

  /** Restrained positional invitation to look, separate from the reveal. */
  stalkCue(position: Point): boolean {
    if (!this.context || this.context.state !== 'running' || !this.master) return false;
    const now = this.context.currentTime;
    if (now - this.lastStalkCue < 14) return false;
    this.lastStalkCue = now;
    this.noiseHit({ duration: 0.17, level: 0.15, frequency: 1450, attack: 0.025, position, rate: 0.74 });
    this.noiseHit({ duration: 0.8, level: 0.045, frequency: 740, type: 'bandpass', attack: 0.15, delay: 0.12, position });
    this.tone({ frequency: 180, endFrequency: 82, duration: 0.36, level: 0.045, attack: 0.035, delay: 0.06, position });
    return true;
  }

  cue(kind: 'branch' | 'breath' | 'call', position: THREE.Vector3): void {
    if (!this.context || this.context.state !== 'running') return;
    if (kind === 'branch') {
      this.noiseHit({ duration: 0.08, level: 0.17, frequency: 1800, position });
      this.tone({ frequency: 150, endFrequency: 70, duration: 0.24, level: 0.09, position });
      for (let i = 0; i < 3; i++) this.noiseHit({ duration: 0.1, level: 0.06 / (i + 1), frequency: 700 + i * 900, delay: 0.09 + i * 0.12, position });
    } else if (kind === 'breath') {
      this.noiseHit({ duration: 2.3, level: 0.055, frequency: 680, type: 'bandpass', attack: 0.65, position });
      this.noiseHit({ duration: 2.1, level: 0.017, frequency: 1400, type: 'bandpass', attack: 0.8, position, delay: 0.1 });
    } else {
      // The recognizable start of a distant animal call, with an imperfect trailing overtone.
      for (let i = 0; i < 2; i++) {
        const delay = i * 0.48;
        this.tone({ frequency: 350 - i * 18, endFrequency: 205, duration: 0.52, level: 0.042, position, delay, type: 'triangle', attack: 0.065 });
        this.noiseHit({ duration: 0.5, level: 0.05, frequency: 520, type: 'bandpass', attack: 0.045, position, delay });
      }
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
    const gust = 0.63 + Math.sin(this.age * 0.071) * 0.18 + Math.sin(this.age * 0.19 + 2.2) * 0.12;
    for(const emitter of this.field){
      const distance=Math.hypot(info.position.x-emitter.point.x,info.position.z-emitter.point.z);
      if(distance>65)emitter.relocating=true;
      const target=emitter.relocating?0:(emitter.kind%2?.021:.105)*gust*(emitter.kind%2?1-info.darkness*.4:1);
      emitter.level+=(target-emitter.level)*(1-Math.exp(-dt/1.5));
      if(!emitter.initialized||(emitter.relocating&&emitter.level<.0002)){
        const a=emitter.kind*Math.PI/2+.35;
        emitter.point={x:info.position.x+Math.cos(a)*30,y:info.position.y+8+emitter.kind*2,z:info.position.z+Math.sin(a)*30};
        emitter.initialized=true;emitter.relocating=false;
        emitter.panner.positionX.value=emitter.point.x;emitter.panner.positionY.value=emitter.point.y;emitter.panner.positionZ.value=emitter.point.z;
      }
      emitter.gain.gain.setTargetAtTime(emitter.level,now,.08);
    }
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

    if (this.age > this.birdAt) {
      this.birdAt = this.age + 16 + Math.random() * 38 + info.darkness * 75;
      if (Math.random() > info.darkness * 0.9) {
        const a = Math.random() * Math.PI * 2;
        const distance = 24 + Math.random() * 40;
        const point = { x: info.position.x + Math.sin(a) * distance, y: info.position.y + 9, z: info.position.z + Math.cos(a) * distance };
        if (Math.random() < 0.38) {
          for (let i = 0; i < 2; i++) {
            this.noiseHit({ duration: 0.3, frequency: 1200, type: 'bandpass', level: 0.08, attack: 0.04, position: point, delay: i * 0.58 });
            this.tone({ frequency: 590, endFrequency: 390, duration: 0.25, level: 0.025, position: point, delay: i * 0.58, type: 'triangle', attack: 0.04 });
          }
        } else {
          for (let i = 0; i < 3; i++) this.tone({ frequency: 1700 + Math.random() * 700, endFrequency: 2300 + Math.random() * 500, duration: 0.13 + Math.random() * 0.09, level: 0.024, delay: i * 0.23, position: point, attack: 0.022 });
        }
      }
    }
    if (this.age > this.creakAt) {
      this.creakAt = this.age + 30 + Math.random() * 55;
      const angle = Math.random() * Math.PI * 2;
      const point = { x: info.position.x + Math.sin(angle) * 23, y: info.position.y + 5, z: info.position.z + Math.cos(angle) * 23 };
      this.noiseHit({ duration: 1.5, level: 0.025, frequency: 430, type: 'bandpass', attack: 0.4, position: point });
      this.tone({ frequency: 120 + Math.random() * 90, endFrequency: 88, duration: 1.7, level: 0.018, attack: 0.55, position: point });
    }
  }

  suspend(): void { if (this.context?.state === 'running') void this.context.suspend(); }
  resume(): void { if (this.context?.state === 'suspended' && !this.disposed) void this.context.resume(); }
  dispose(): void {
    this.disposed = true;
    for (const source of this.sources) { try { source.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    if (this.context) void this.context.close();
    this.context = null;
    this.noise = null;
    this.riverPanner = null;this.revealPanner=null;this.revealPoint=null;this.field=[];
  }
}
