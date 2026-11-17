/**
 * How the Listener sounds as it moves (docs/gameplay-plan.md, "It sounds like it moves"): what a footfall is made of, chosen by the
 * surface under the foot, the speed and the leg (footfallPlan, pure), and the voice that plays it (buildFootfall, Web Audio). Eight
 * legs under a four-metre body: each landing is a low thump of weight, the strike of a claw tip and the ground's own sound, never
 * twice the same (a take, a pitch and a gain drawn each time, and each leg has its own pitch); heavier and sharper when it runs, with
 * claws scraping, a soft press when it drifts. The body's creak, a door scratched and a door forced are built here too, so the game
 * and the soundboard (tools/sounds/creature.html) play exactly the same thing.
 *
 * None of this is a noise the Listener hears (game/sim/noise): its own sounds are not noises it listens for.
 */

/** What a foot lands on. `stone` is a building's masonry, `metal` its iron roof. */
export type FootSurface = 'earth' | 'rock' | 'wood' | 'road' | 'water' | 'bark' | 'metal' | 'stone';

export const FOOTFALL = {
  /** At most this many footfall voices at once; the rest are dropped (never queued). A run lands four feet together every
   * fifth of a second and each footfall rings about .15 s: ten keep a gallop whole. */
  maxVoices: 10,
  /** Beyond this far from the listener a foot makes no sound at all. */
  maxDistance: 60,
  /** Speeds (m/s): below `quiet` a drift is a whisper; from `loud` on, a run. */
  quiet: .5, loud: 9,
  /** The footstep recordings play near their own pitch (times the leg's): pitched up, they made a small animal of it. */
  rate: [.82, 1.12] as const,
};

const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Each leg's own pitch: a fixed offset from .91 to 1.09 per leg, so eight feet never ring alike. */
export function legPitch(leg: number) { const v = Math.sin((leg + 1) * 12.9898) * 43758.5453; return .91 + (v - Math.floor(v)) * .18; }

/** The sample beds (public/audio/footsteps) a surface borrows from, and how many takes each has. */
export const BEDS = { gravel: 10, wood: 10, stone: 6, sand: 6 } as const;
export type BedKind = keyof typeof BEDS;
/** The file (without .wav) of the nth take of a bed: gravel0..9, wood0..9, Stone{L,R}1..3, Sand{L,R}1..3. */
export function bedName(kind: BedKind, take: number) {
  const n = ((take % BEDS[kind]) + BEDS[kind]) % BEDS[kind];
  if (kind === 'stone' || kind === 'sand') return `${kind === 'stone' ? 'Stone' : 'Sand'}${n < 3 ? 'L' : 'R'}${n % 3 + 1}`;
  return `${kind}${n}`;
}

type Recipe = {
  /** The weight landing: a low thump falling from `thump[0]` to `thump[1]` Hz over `thumpDecay` s, at `thumpGain`. */
  thump: readonly [number, number]; thumpDecay: number; thumpGain: number;
  /** How much of the landing is a dull thud of noise rather than the falling tone (0 to 1): soft ground gives, it does not go bonk. */
  thud?: number;
  /** The claw tip striking: a short band of noise at `tip` Hz. */
  tip: readonly [number, number]; tipGain: number;
  /** The ground's own texture from the footstep recordings, near their natural pitch, and the lowpass that keeps soft ground soft. */
  bed?: BedKind; bedGain: number; bedLowpass: number;
  /** Leaves, grit, splash: band-passed noise, its centre range (Hz), width (Q), length (s) and share. */
  rustle: readonly [number, number]; rustleQ: number; rustleLength: number; rustleGain: number;
  /** A resonant body: wood's hollow knock (one partial), or (`sheet`) a corrugated iron sheet flexing under the weight. */
  body?: { frequency: readonly [number, number]; decay: number; gain: number; ring: boolean; sheet?: boolean };
  /** The whole surface's level against earth. */
  level: number;
};
// A four-metre spider: what carries is weight (the thump), then the claw's strike, then the ground. The first recipes pitched
// player footsteps up two octaves and cut everything under a kilohertz: a cat's pitter-patter, not a creature this size.
const RECIPES: Record<FootSurface, Recipe> = {
  // The forest floor: soil and litter giving under the weight. A thud more noise than tone, the soft crunch of the sand recordings
  // (the gravel takes, even low-passed, were stones knocking: it sounded clanky), a hushed rustle of leaves, and almost no claw: a
  // claw goes into dirt, it does not click on it.
  earth: { thump: [100, 44], thumpDecay: .13, thumpGain: .72, thud: .85, tip: [600, 950], tipGain: .07, bed: 'sand', bedGain: 1.15, bedLowpass: 1900, rustle: [1200, 2400], rustleQ: .55, rustleLength: .14, rustleGain: .38, level: 1 },
  // The gravel road: a firmer thump and the whole crunch of the grit.
  road: { thump: [125, 52], thumpDecay: .11, thumpGain: .5, tip: [2000, 2800], tipGain: .6, bed: 'gravel', bedGain: 1.8, bedLowpass: 9000, rustle: [3000, 5000], rustleQ: .8, rustleLength: .08, rustleGain: .25, level: 1.05 },
  // Rock: a short, tight thump, the claw's hard click on stone.
  rock: { thump: [150, 70], thumpDecay: .075, thumpGain: .38, tip: [2600, 4200], tipGain: 1.4, bed: 'stone', bedGain: 1.3, bedLowpass: 11000, rustle: [4000, 6000], rustleQ: .9, rustleLength: .05, rustleGain: .2, level: 1.1 },
  stone: { thump: [145, 66], thumpDecay: .08, thumpGain: .42, tip: [2400, 3800], tipGain: 1.2, bed: 'stone', bedGain: 1.3, bedLowpass: 10000, rustle: [3800, 5600], rustleQ: .9, rustleLength: .05, rustleGain: .15, level: 1.05 },
  // Boards: a hollow knock of the planks over the thump.
  wood: { thump: [110, 58], thumpDecay: .1, thumpGain: .55, tip: [900, 1400], tipGain: .6, bed: 'wood', bedGain: 1.4, bedLowpass: 7000, rustle: [2400, 3600], rustleQ: 1, rustleLength: .04, rustleGain: .08, body: { frequency: [190, 300], decay: .09, gain: .55, ring: false }, level: 1.1 },
  // Water: a low plunk and a splash, droplets after.
  water: { thump: [180, 110], thumpDecay: .08, thumpGain: .4, tip: [700, 1100], tipGain: .08, bedGain: 0, bedLowpass: 4000, rustle: [800, 1500], rustleQ: .7, rustleLength: .26, rustleGain: .9, level: 1.1 },
  // Bark, climbing: claws catching, a scratch more than a step.
  bark: { thump: [140, 80], thumpDecay: .06, thumpGain: .3, tip: [1300, 2000], tipGain: .4, bedGain: 0, bedLowpass: 5000, rustle: [1200, 2400], rustleQ: 1.1, rustleLength: .1, rustleGain: .9, level: .8 },
  // A cabin's corrugated iron roof, heard from under it: a hollow boom as the sheet flexes and gives, and the loose sheet rattling on
  // its purlins. The first roof rang (two partials at 380-620 Hz, a 2.76 ratio: a xylophone bar's); a sheet nailed down on every
  // other rib is damped, its modes low and bending down as it gives.
  metal: { thump: [92, 46], thumpDecay: .11, thumpGain: .62, thud: .35, tip: [1000, 1500], tipGain: .28, bedGain: 0, bedLowpass: 6000, rustle: [2500, 4000], rustleQ: 1, rustleLength: .03, rustleGain: .05, body: { frequency: [62, 96], decay: .2, gain: .75, ring: false, sheet: true }, level: 1 },
};

/** What one footfall is made of; see `footfallPlan`. Frequencies in Hz, seconds for times, gains are linear. */
export type FootfallPlan = {
  surface: FootSurface;
  /** The overall level: about 0.05 for a drift up to about 0.22 for a run. */
  gain: number;
  /** Air takes the top off a distant step: a lowpass closing from 18 kHz at the foot to about 2 kHz at 60 m. */
  distanceCut: number;
  thump: { from: number; to: number; decay: number; gain: number; thud?: number };
  tip: { frequency: number; length: number; gain: number };
  /** The recording borrowed (if any): which take, its playing speed (near its own pitch), share, lowpass and length. */
  bed?: BedKind; take: number; rate: number; bedGain: number; bedLowpass: number; bedLength: number;
  rustle: { frequency: number; q: number; length: number; gain: number };
  body?: { frequency: number; decay: number; gain: number; ring: boolean; sheet?: boolean; rattle?: { at: number; frequency: number; gain: number }[] };
  /** A claw coming down a moment after its foot (`at` s after the landing), and at speed a scrabble of claws catching: tiny ticks. */
  settle?: { at: number; frequency: number; gain: number };
  skitter?: { at: number; frequency: number; gain: number }[];
  /** Claws dragging, above a run: a band-passed noise, 0 when it is not running. */
  scrape: { gain: number; frequency: number; length: number };
  splash: boolean;
  /** How long the voice lives. */
  duration: number;
};

/** `lift`: the foot leaving the ground rather than landing (a claw ticking free, no weight behind it). */
export type FootfallRequest = { surface: FootSurface; speed: number; leg: number; distance: number; lift?: boolean };

/**
 * One footfall: undefined past FOOTFALL.maxDistance (silent), otherwise the plan. `random` supplies the variety.
 * Speed scales the level (a drift is a soft press, a run heavy and sharp), the surface its colour, the leg its pitch.
 */
export function footfallPlan(req: FootfallRequest, random: () => number = Math.random): FootfallPlan | undefined {
  if (!(req.distance <= FOOTFALL.maxDistance)) return undefined;
  const r = RECIPES[req.surface], run = smooth(req.speed, FOOTFALL.quiet, FOOTFALL.loud), pitch = legPitch(req.leg);
  const jitter = .8 + random() * .4;
  // Four feet land together at a run: at .3 one footfall peaked at .4 at 6 m and a gallop summed past 1. Two thirds of that.
  // A trot (4 m/s) passing 8 m off peaked at .055 with the curve at .8: clearly there now, a drift still a creep.
  const gain = lerp(.045, .2, Math.pow(run, .7)) * r.level * jitter;
  // No two steps alike. A big spider's feet do not come down with one weight: some carry the body, some only touch, and a light
  // touch is more claw than thump. Heard one after another, the same recipe at the same weight is what made it sound like a machine.
  const weight = .55 + random() * .8, light = (1.35 - weight) / .8;
  const thumpDecay = r.thumpDecay * lerp(1.15, .85, run) * (.9 + random() * .2);
  const bedLength = lerp(.17, .11, run) * (.9 + random() * .2);
  const rustleLength = r.rustleLength * (.85 + random() * .3);
  const body = r.body && {
    frequency: lerp(r.body.frequency[0], r.body.frequency[1], random()) * pitch, decay: r.body.decay * (.85 + random() * .3), gain: r.body.gain, ring: r.body.ring, sheet: r.body.sheet,
    // The loose sheet rattling on its purlins: a few buzzy knocks a couple of hundredths apart, dying away; more of them at a run.
    rattle: r.body.sheet ? Array.from({ length: 3 + Math.round(run * 3 + random()) }, (_, k) => ({ at: .012 + k * .021 + random() * .01, frequency: lerp(650, 1150, random()), gain: Math.pow(.6, k) * lerp(.25, .4, run) })) : undefined,
  };
  const scrape = req.speed > 5.5 ? { gain: .12 * smooth(req.speed, 5.5, 11) * (req.surface === 'water' ? .2 : 1), frequency: lerp(1400, 2600, random()), length: .12 } : { gain: 0, frequency: 2000, length: 0 };
  const rattleEnd = body?.rattle?.length ? body.rattle[body.rattle.length - 1].at + .03 : 0;
  // A claw that comes down a beat after its foot (a third of the steps), and at speed now and then a scrabble: two to four claws
  // catching and slipping over the next tenth of a second. On soft ground these are grit and litter, on hard ground clicks.
  const hard = r.tipGain >= .5, clawBand = (k: number) => hard ? lerp(r.tip[0], r.tip[1], k) * pitch : lerp(r.rustle[0], r.rustle[1], k) * pitch;
  const settle = random() < .35 ? { at: lerp(.012, .045, random()), frequency: clawBand(random()), gain: Math.max(r.tipGain, .12) * lerp(.35, .6, random()) } : undefined;
  const skitter = req.speed > 2.5 && random() < lerp(.12, .45, run)
    ? Array.from({ length: 2 + Math.floor(random() * 3) }, (_, k) => ({ at: .03 + k * lerp(.018, .032, random()), frequency: clawBand(random()), gain: Math.max(r.tipGain, .1) * lerp(.25, .5, random()) * Math.pow(.8, k) }))
    : undefined;
  const skitterEnd = skitter ? skitter[skitter.length - 1].at + .02 : 0;
  const duration = Math.max(thumpDecay * 2.4, r.bedGain > 0 ? bedLength : 0, rustleLength * (req.surface === 'water' ? 1.6 : 1), body ? body.decay * (body.ring ? 3 : 2.2) : 0, rattleEnd, skitterEnd, scrape.length) + .02;
  if (req.lift) {
    // The claw leaving the ground: a light, higher tick and a little of the ground's grit, no weight, a third as loud. Between the
    // landings these make the patter of a spider rather than the thud of a big animal.
    // On soft ground the claw slides out of the soil (the recipe's faint tip); on rock and the road it clicks.
    const tick = lerp(r.tip[0], r.tip[1], random()) * pitch * 1.25, length = lerp(.012, .007, run);
    return {
      surface: req.surface, gain: gain * .32,
      distanceCut: 2000 + 16000 * Math.pow(Math.max(0, 1 - req.distance / FOOTFALL.maxDistance), 1.6),
      thump: { from: r.thump[0] * pitch, to: r.thump[1] * pitch, decay: .02, gain: 0 },
      tip: { frequency: tick, length, gain: r.tipGain * .9 * lerp(.8, 1.3, run) },
      bed: r.bed, take: Math.floor(random() * 1000), rate: lerp(1.05, 1.3, random()) * pitch, bedGain: r.bedGain * .3, bedLowpass: r.bedLowpass, bedLength: .05,
      rustle: { frequency: lerp(r.rustle[0], r.rustle[1], random()) * pitch, q: r.rustleQ, length: rustleLength * .5, gain: r.rustleGain * .45 },
      scrape: { gain: 0, frequency: 2000, length: 0 }, splash: false, duration: Math.max(.06, rustleLength * .5) + .02,
    };
  }
  return {
    surface: req.surface, gain,
    distanceCut: 2000 + 16000 * Math.pow(Math.max(0, 1 - req.distance / FOOTFALL.maxDistance), 1.6),
    thump: { from: r.thump[0] * pitch * (.9 + .2 * random()), to: r.thump[1] * pitch, decay: thumpDecay, gain: r.thumpGain * lerp(.7, 1.3, run) * weight, thud: r.thud ?? 0 },
    tip: { frequency: lerp(r.tip[0], r.tip[1], random()) * pitch, length: lerp(.016, .008, run), gain: r.tipGain * lerp(.5, 1.2, run) * lerp(.7, 1.5, light) },
    bed: r.bed, take: Math.floor(random() * 1000), rate: lerp(FOOTFALL.rate[0], FOOTFALL.rate[1], random()) * pitch, bedGain: r.bedGain * lerp(.65, 1.2, random()), bedLowpass: r.bedLowpass, bedLength,
    rustle: { frequency: lerp(r.rustle[0], r.rustle[1], random()) * pitch, q: r.rustleQ * (.8 + random() * .4), length: rustleLength, gain: r.rustleGain * lerp(.6, 1, run) },
    body, settle, skitter, scrape, splash: req.surface === 'water', duration,
  };
}

/**
 * A cap on concurrent voices: `take(now, duration)` is true (and the voice is counted until now + duration) while fewer than `max`
 * are alive. A full pool refuses; it never waits.
 */
export function createVoicePool(max = FOOTFALL.maxVoices) {
  const ends: number[] = [];
  return {
    take(now: number, duration: number) {
      for (let i = ends.length - 1; i >= 0; i--) if (ends[i] <= now) ends.splice(i, 1);
      if (ends.length >= max) return false;
      ends.push(now + duration); return true;
    },
    active(now: number) { return ends.filter(e => e > now).length; },
    clear() { ends.length = 0; },
  };
}

// --- What is under a foot -------------------------------------------------------------------------------------

/** Collider tags a foot can stand on, by what they are made of (game/render/props, world-assets.json). */
const WOOD = new Set(['cabin floor', 'chapel floor', 'hut floor', 'pump house floor', 'bridge deck', 'road bridge deck', 'bridge timber', 'fallen log', 'stump', 'step', 'logstack', 'dock', 'pier']);
const ROCK = new Set(['rock', 'river stone', 'boundary stone']);
/** Every tag that changes how a foot sounds (the host looks for a solid with one of them under the foot). */
export const FOOT_TAGS: ReadonlySet<string> = new Set([...WOOD, ...ROCK]);
/** The ground sim/world/surface.ts names (and the road's gravel). */
export type GroundKind = 'road' | 'path' | 'forest' | 'water' | 'beach' | 'dirt';

export type UnderFoot = {
  /** What the foot is on: the ground, a tree (it is climbing one), or a building (over a wall or roof). */
  on: 'ground' | 'tree' | 'building';
  /** The foot's surface normal, y component: a roof is flat, a wall is not. */
  normalY: number;
  ground: GroundKind;
  /** The tag of a solid the foot is standing on, if the host found one. */
  tag?: string;
};
/** The surface a footfall sounds like. */
export function footSurface(u: UnderFoot): FootSurface {
  if (u.on === 'tree') return 'bark';
  if (u.on === 'building') return u.normalY > .6 ? 'metal' : 'wood';
  if (u.ground === 'water') return 'water';
  if (u.tag && ROCK.has(u.tag)) return 'rock';
  if (u.tag && WOOD.has(u.tag)) return 'wood';
  if (u.ground === 'road') return 'road';
  return 'earth';
}

/**
 * Now and then, running, a creak and rattle of the body: how often (seconds between) and how strong, by speed. Undefined when it is
 * not going fast enough to rattle.
 */
export function creakPlan(speed: number, random: () => number = Math.random) {
  if (speed < 6) return undefined;
  const run = smooth(speed, 6, 11);
  return { gain: lerp(.05, .12, run) * (.8 + random() * .4), frequency: lerp(280, 620, random()), next: lerp(2.6, 1.1, run) * (.7 + random() * .6) };
}

// --- The voices (Web Audio). The game (audio.ts) and the soundboard (tools/sounds/creature.html) both play through these. --------

/** A built voice: its sources (the last one ends last) and every node to let go when it has. */
export type Voice = { sources: AudioScheduledSourceNode[]; nodes: AudioNode[]; end: number };
type Kit = { context: BaseAudioContext; out: AudioNode; noise: AudioBuffer; when: number };

function voiceKit(k: Kit) {
  const c = k.context, sources: AudioScheduledSourceNode[] = [], stops = new Map<AudioScheduledSourceNode, number>(), nodes: AudioNode[] = [];
  let end = k.when;
  const envelope = (from: AudioNode, level: number, attack: number, length: number, at = k.when) => {
    const env = c.createGain();
    env.gain.setValueAtTime(.00001, at); env.gain.exponentialRampToValueAtTime(Math.max(.0001, level), at + attack);
    env.gain.exponentialRampToValueAtTime(.00001, at + attack + length);
    from.connect(env).connect(k.out); nodes.push(env);
    return at + attack + length + .02;
  };
  const start = (source: AudioScheduledSourceNode, at: number, stop: number) => { source.start(at); source.stop(stop); sources.push(source); stops.set(source, stop); end = Math.max(end, stop); };
  /** Band of noise: `type` filter at `frequency`, enveloped. */
  const noise = (type: BiquadFilterType, frequency: number, q: number, level: number, attack: number, length: number, at = k.when, rate = 1) => {
    const source = c.createBufferSource(), filter = c.createBiquadFilter();
    source.buffer = k.noise; source.playbackRate.value = rate; filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
    source.connect(filter); nodes.push(filter);
    start(source, at, envelope(filter, level, attack, length, at));
  };
  /** A tone gliding from `from` to `to`. */
  const tone = (type: OscillatorType, from: number, to: number, glide: number, level: number, attack: number, length: number, at = k.when) => {
    const osc = c.createOscillator();
    osc.type = type; osc.frequency.setValueAtTime(from, at); osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + glide);
    start(osc, at, envelope(osc, level, attack, length, at));
  };
  // The source that stops last comes first: whoever plays the voice frees its nodes when that one ends.
  const finish = (): Voice => ({ sources: sources.slice().sort((a, b) => stops.get(b)! - stops.get(a)!), nodes, end });
  return { c, nodes, noise, tone, start, envelope, finish, get end() { return end; } };
}

/**
 * One footfall into `out` (a panner, in the game) at `when`: the thump of the weight (a sine falling an octave, with a short
 * low-passed knock of noise so small speakers hear the impact too), the claw tip's strike, the ground's recording near its own
 * pitch, the rustle or splash, a hollow knock or a roof's ring, and the scrape of claws when it runs; air closes the top with distance.
 */
export function buildFootfall(context: BaseAudioContext, plan: FootfallPlan, out: AudioNode, noise: AudioBuffer, bed: (name: string) => AudioBuffer | undefined, when: number): Voice {
  const bus = context.createGain(), air = context.createBiquadFilter();
  bus.gain.value = plan.gain; air.type = 'lowpass'; air.frequency.value = plan.distanceCut; air.Q.value = .5;
  bus.connect(air).connect(out);
  const v = voiceKit({ context, out: bus, noise, when });
  v.nodes.push(bus, air);
  const t = plan.thump;
  if (t.gain > 0) {
    // The tone is the weight; the thud share turns it into ground giving: less tone, no octave above, a longer, lower knock of noise.
    const d = t.thud ?? 0;
    v.tone('sine', t.from, t.to, t.decay * 1.4, t.gain * (1 - .45 * d), .003, t.decay * 2.2);
    if (d < .7) v.tone('triangle', t.from * 2, t.to * 2, t.decay, t.gain * .18 * (1 - d), .002, t.decay * 1.6);
    v.noise('lowpass', 420 - 190 * d, .7, t.gain * (.35 + .75 * d), .002, .04 + .06 * d);
  }
  if (plan.tip.gain > .02) v.noise('bandpass', plan.tip.frequency, 1.4, plan.tip.gain, .0008, plan.tip.length);
  const sample = plan.bed ? bed(bedName(plan.bed, plan.take)) : undefined;
  if (sample && plan.bedGain > 0) {
    const source = context.createBufferSource(), high = context.createBiquadFilter(), low = context.createBiquadFilter();
    source.buffer = sample; source.playbackRate.value = plan.rate;
    high.type = 'highpass'; high.frequency.value = 80; low.type = 'lowpass'; low.frequency.value = plan.bedLowpass;
    source.connect(high).connect(low); v.nodes.push(high, low);
    v.start(source, when, v.envelope(low, plan.bedGain, .003, plan.bedLength));
  }
  if (plan.splash) {
    v.noise('bandpass', plan.rustle.frequency, plan.rustle.q, plan.rustle.gain, .012, plan.rustle.length * 1.3);
    v.noise('highpass', 3500, .7, plan.rustle.gain * .22, .02, plan.rustle.length * .9, when + .035);
  } else if (plan.rustle.gain > .01) v.noise('bandpass', plan.rustle.frequency, plan.rustle.q, plan.rustle.gain, .005, plan.rustle.length);
  if (plan.body?.sheet) {
    // A corrugated sheet giving under the weight: four low modes (ratios of a clamped plate, not a bar), each bending down a few
    // per cent as the sheet flexes, a wash of the sheet's noise in the low mids, and the rattle of it lifting and slapping its purlins.
    const b = plan.body;
    for (const [ratio, share] of [[1, 1], [1.59, .55], [2.14, .32], [2.95, .16]] as const)
      v.tone('sine', b.frequency * ratio * 1.05, b.frequency * ratio * .95, b.decay * .7, b.gain * share, .003, b.decay * (1.25 - .12 * ratio));
    v.noise('bandpass', b.frequency * 6.5, .8, b.gain * .55, .004, b.decay * 1.2);
    for (const r of b.rattle ?? []) v.noise('bandpass', r.frequency, 1.8, b.gain * r.gain, .001, .013, when + r.at);
  } else if (plan.body) {
    const b = plan.body;
    v.tone('sine', b.frequency, b.frequency * .97, b.decay, b.gain, .002, b.decay * (b.ring ? 2.9 : 2.1));
    v.tone('sine', b.frequency * (b.ring ? 2.76 : 2.3), b.frequency * (b.ring ? 2.7 : 2.25), b.decay, b.gain * (b.ring ? .6 : .25), .002, b.decay * (b.ring ? 2.4 : 1.5));
  }
  if (plan.settle) v.noise('bandpass', plan.settle.frequency, 1.6, plan.settle.gain, .0008, .008, when + plan.settle.at);
  for (const k of plan.skitter ?? []) v.noise('bandpass', k.frequency, 1.5, k.gain, .0008, .009, when + k.at);
  if (plan.scrape.gain > .005) v.noise('bandpass', plan.scrape.frequency, 1.6, plan.scrape.gain, .012, plan.scrape.length, when + .01, .7 + Math.random() * .2);
  return v.finish();
}

const crackles = new WeakMap<BaseAudioContext, AudioBuffer>();
/**
 * Stick-slip: a train of tiny clicks, uneven in time and size (chitin rubbing on chitin, claws catching on grain). Made once per
 * context, half a second, played through a band-pass so its colour is the material's.
 */
export function crackleBuffer(context: BaseAudioContext, random: () => number = Math.random): AudioBuffer {
  let b = crackles.get(context);
  if (b) return b;
  const rate = context.sampleRate, length = Math.floor(rate * .5);
  b = context.createBuffer(1, length, rate);
  const d = b.getChannelData(0);
  let at = 0;
  while (at < length) {
    const size = .3 + random() * .7, ring = 18 + random() * 40;
    for (let i = 0; i < ring && at + i < length; i++) d[at + i] += (random() * 2 - 1) * size * Math.exp(-i / (ring * .3));
    at += Math.floor(rate * (.004 + random() * random() * .03));
  }
  crackles.set(context, b);
  return b;
}

/**
 * The legs between the footfalls: eight legs never still, hairs and segments brushing the ground and each other, claws catching. A
 * quiet loop of stick-slip crackle and a little noise through the surface's band, whose level follows the speed and flutters (each
 * set() draws it afresh), so the footfalls sit in a flow of sound instead of in silence with gaps between them.
 */
export const BRUSH = {
  /** Level at a full run against a footfall's .2; it is a bed under the steps, not a hiss. */
  level: .05,
  /** Band (Hz) and width of the brush on each surface. */
  band: { earth: [1300, .7], road: [2400, .8], rock: [3000, 1], stone: [2900, 1], wood: [1900, .9], water: [900, .6], bark: [2100, 1], metal: [2600, 1] } as Record<FootSurface, readonly [number, number]>,
};
/** How loud the brush is at a speed on a surface, before its flutter. */
export function brushLevel(speed: number, surface: FootSurface) { return BRUSH.level * Math.pow(smooth(speed, .25, 9), .8) * RECIPES[surface].level; }
export type Brush = ReturnType<typeof createBrush>;
/** A running brush into `out` (a panner). `set` it a dozen times a second while the creature moves; `stop` lets it go. */
export function createBrush(context: BaseAudioContext, out: AudioNode, noise: AudioBuffer, random: () => number = Math.random) {
  const grains = context.createBufferSource(), air = context.createBufferSource();
  grains.buffer = crackleBuffer(context); grains.loop = true; air.buffer = noise; air.loop = true; air.loopStart = random();
  const band = context.createBiquadFilter(), hiss = context.createBiquadFilter(), hissLevel = context.createGain(), level = context.createGain();
  band.type = 'bandpass'; hiss.type = 'bandpass'; hiss.Q.value = .6; hissLevel.gain.value = .3; level.gain.value = 0;
  grains.connect(band).connect(level); air.connect(hiss).connect(hissLevel).connect(level); level.connect(out);
  const at0 = context.currentTime; grains.start(at0, random() * .4); air.start(at0, random() * 1.5);
  return {
    set(speed: number, surface: FootSurface, at = context.currentTime) {
      const [f, q] = BRUSH.band[surface], k = .85 + random() * .3;
      band.frequency.setTargetAtTime(f * k, at, .05); band.Q.setTargetAtTime(q, at, .05); hiss.frequency.setTargetAtTime(f * .7 * k, at, .05);
      level.gain.setTargetAtTime(brushLevel(speed, surface) * (.5 + random()), at, .05);
      grains.playbackRate.setTargetAtTime(lerp(.75, 1.45, smooth(speed, 0, 9)) * (.85 + random() * .3), at, .08);
    },
    stop(at = context.currentTime) { level.gain.setTargetAtTime(0, at, .05); grains.stop(at + .5); air.stop(at + .5); },
    nodes: [grains, air, band, hiss, hissLevel, level] as AudioNode[],
  };
}

function crackle(v: ReturnType<typeof voiceKit>, buffer: AudioBuffer, frequency: number, q: number, level: number, attack: number, length: number, at: number, rate = 1) {
  const source = v.c.createBufferSource(), filter = v.c.createBiquadFilter();
  source.buffer = buffer; source.playbackRate.value = rate; filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = q;
  source.connect(filter); v.nodes.push(filter);
  v.start(source, at, v.envelope(filter, level, attack, length, at));
}

/** The body creaking as it runs: two joints grinding (stick-slip crackle through a hollow band) with a low groan under them. */
export function buildCreak(context: BaseAudioContext, plan: { gain: number; frequency: number }, out: AudioNode, noise: AudioBuffer, when: number): Voice {
  const v = voiceKit({ context, out, noise, when }), cr = crackleBuffer(context);
  crackle(v, cr, plan.frequency * 1.6, 2.2, plan.gain * 1.4, .02, .18, when, .55 + Math.random() * .2);
  crackle(v, cr, plan.frequency * 2.6, 3, plan.gain * .8, .015, .12, when + .09, .7 + Math.random() * .2);
  v.tone('sine', plan.frequency * .3, plan.frequency * .24, .25, plan.gain * .25, .04, .2);
  return v.finish();
}

/** Claws dragged down a shut door, three strokes: each a run of catches on the grain, rising as the claw slows. */
export function buildScratch(context: BaseAudioContext, out: AudioNode, noise: AudioBuffer, when: number, random: () => number = Math.random): Voice {
  const v = voiceKit({ context, out, noise, when }), cr = crackleBuffer(context, random);
  for (let i = 0; i < 3; i++) {
    const at = when + i * (.2 + random() * .08), length = .16 + random() * .08;
    crackle(v, cr, 1500 + random() * 700, 1.4, .28, .02, length, at, .9 + random() * .4);
    v.noise('bandpass', 2600 + random() * 900, 1.2, .04, .01, length * .8, at);
    v.tone('sine', 140, 90, length, .05, .005, length * .6, at);
  }
  return v.finish();
}

/** A door forced or a bar broken: the leaf thrown back against the wall, splinters, the boards ringing. */
export function buildCrash(context: BaseAudioContext, out: AudioNode, noise: AudioBuffer, when: number, random: () => number = Math.random): Voice {
  const v = voiceKit({ context, out, noise, when }), cr = crackleBuffer(context, random);
  v.tone('sine', 95, 38, .35, .5, .003, .45);
  v.noise('lowpass', 700, .8, .45, .003, .45);
  crackle(v, cr, 2400, 1, .5, .002, .3, when + .015, 1.3);
  v.noise('highpass', 2200, .7, .14, .003, .25, when + .02);
  v.tone('sine', 230 + random() * 60, 220, .5, .12, .004, .5, when + .01);   // the boards ringing
  v.tone('sine', 120, 70, .2, .3, .003, .25, when + .32);                   // the leaf hitting the wall
  return v.finish();
}
