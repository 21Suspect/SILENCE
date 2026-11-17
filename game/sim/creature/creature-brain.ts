/**
 * The Listener's mind: blind. It knows only what it hears (docs/game-design.md, "The Listener", "Sound and light").
 *
 * Pure and deterministic. No three.js, no scene, no clock and no Math.random: the host (game/render/creature/encounters.ts)
 * moves the body and tells it where the torch beam points and how far its head is from the player; this module hears and
 * decides. Randomness comes from the injected `random`, and time only from the `dt` of each tick, so a fixed seed and a fixed
 * script of inputs replay exactly.
 *
 * What it does, by what it heard (the grade is the sound's own class from game/sim/noise/noise-scale.ts, not how near it was):
 *   faint     stops, turns its head, drifts that way slowly; ten seconds of silence and it loses interest
 *   loud      calls once, trots to the spot and searches it for 20 s, listening (clicks)
 *   veryLoud  (or kept up) runs at twice the player's sprint and stays while it goes on; then searches there
 * A running source (a generator, a pump: brain.source(id, {x, z, loudness}) while it runs, null when it stops) is heard whenever
 * the creature is inside its reach, as a kept-up noise: it runs there and, while it runs, prowls round it in widening rings
 * (behaviour 'prowl': hunting whoever started it, never parked at it); when it stops it searches.
 * Too big to enter a building: a loud noise from inside makes it besiege it (behaviour 'siege', see siegeStep): it comes to the walls,
 * goes round them, tries the doors (scratching), forces a shut one after a while if the noise inside keeps up, and reaches in
 * through an open doorway for anyone it perceives near it. Quiet inside, it searches outside and moves on.
 * A second noise redirects it (see `take`): that is how a player leads it away. Within 3 m it hears breathing unless it is held.
 * It catches only a player it perceives right now: one who made a heard noise in the last 1.5 s or is breathing within 3 m.
 *
 * By day it sleeps in its lair (the only place it rests); at dusk it leaves, earlier each day, for the loudest place of the
 * day and then makes its round. Worse each day: it leaves earlier, searches longer, and from day 4 wakes to any loud noise.
 */
import { STAMINA } from '../player/stamina';
import { NOISE, hears, noiseGrade, footstepNoise, type NoiseGrade, type WeatherCover } from '../noise/noise-scale';
import { buildingAt, bearingOf, ringPoint, standAt, toLocal, type Building, type Opening } from './buildings';

export type Vec2 = { x: number; z: number };
/** A world point. Without y the host picks a height (the ground plus head height). */
export type Point = { x: number; y?: number; z: number };

/**
 * Something that made a sound, from the objectives' noise stream (footsteps, ladder rungs, the generator...). `sustained`
 * marks a sound that is kept up (the generator's hum, hammering): it counts as very loud whatever its loudness.
 */
export type NoiseEvent = { loudness: number; source: string; x: number; z: number; sustained?: boolean };
/** A sound that goes on for as long as the thing runs (a generator, a pump, the helicopter): see brain.source. */
export type RunningSource = { x: number; z: number; loudness: number };

/** What is true about the player this instant. The brain only uses where they are (for breathing and the catch) and the torch. */
export type PlayerPercept = {
  x: number; y: number; z: number;
  /** Ground velocity, m/s. */
  vx: number; vz: number;
  sprinting: boolean; crouching: boolean; flashlightOn: boolean;
  inWater: boolean; onLadder: boolean; indoors: boolean;
  /** Holding their breath: it cannot hear them breathe, whatever the distance. Default false. */
  breathHeld?: boolean;
  /** Flying/noclip, already caught, or otherwise out of play: it can neither sense nor strike them. */
  untouchable?: boolean;
};

export type BrainInput = {
  /** Seconds since the last tick. All of the brain's time comes from this. */
  dt: number;
  /** Local solar time, 0-24. Day and night are the brain's own business: asleep by day, out from dusk. */
  hours: number;
  /** How dark it is, 0-1. The blind Listener does not use it; kept so hosts need not change. */
  darkness?: number;
  /** Which day of the run, 1 to 5 (default 1): it leaves the lair earlier, searches longer, from day 4 sleeps lightly. */
  day?: number;
  /** Weather is cover: it shortens every distance a noise carries (default still). */
  weather?: WeatherCover;
  /** Where it is, which way it faces, and (if the host knows) how fast its body is really moving, m/s. */
  creature: { x: number; z: number; yaw: number; speed?: number };
  player: PlayerPercept;
  /** The torch is on, aimed at its head and close enough to dazzle. */
  beamOnIt: boolean;
  /** Metres from its head and hands to the player's chest; Infinity when there is no body to reach with. */
  reach: number;
  /** The doorways of the buildings (and how open they are), if the host knows them. Without them a siege never forces or reaches in. */
  openings?: readonly Opening[];
};

export type Intent = {
  /** Where to go. Without a target it stands still. */
  target?: Vec2;
  /** Requested ground speed, m/s. */
  speed: number;
  /** Close enough to the target to stop, metres. */
  arrive?: number;
};

export type BrainEvent =
  | { type: 'behaviour'; from: string; to: string }
  /** A noise it heard (within its range), with its grade and how far off it was. */
  | { type: 'heard'; source: string; grade: NoiseGrade; distance: number }
  /** Its call: it has taken up a loud (or louder) noise. The host plays it. */
  | { type: 'call' }
  /** A run of clicks while it searches, listening. The host plays them. */
  | { type: 'clicks' }
  | { type: 'wake'; cause: string }
  | { type: 'sleep' }
  /** It has the player: the host plays out the grab. */
  | { type: 'strike' }
  /** The torch has pinned it: it begins to slow to a halt and will be held for `seconds` if the beam stays on it. */
  | { type: 'flinch'; seconds: number }
  /** The stun moves on: held (it has stopped), starting (it is getting going again, `seconds` it was held), over. */
  | { type: 'stun'; phase: 'held' | 'starting' | 'over'; seconds?: number }
  /** At a shut door of the building it besieges: it scratches or knocks (the host plays it, at the door). */
  | { type: 'doorTell'; kind: 'scratch' | 'knock'; door: string; x: number; z: number }
  /** It has forced a door: the host swings it open hard (a crash, a noise at the door) and breaks the bar if there was one. */
  | { type: 'forceDoor'; door: string; barred: boolean; x: number; z: number };

/** The torch stun: slowing to a halt, held, then getting going again. */
export type StunPhase = 'none' | 'slowing' | 'held' | 'starting';
export type StunState = {
  phase: StunPhase;
  /** 0-1: how far it has shrunk from the light (crouched, coiled, head turned away). */
  recoil: number;
  /** m/s it steps backward, without turning, early in the held phase. */
  backstep: number;
};

/** asleep in the lair; return to it; wait (woken by day, listening out the quiet); the night's round; the responses (siege: a building with someone loud in it); the catch. */
export type BehaviourId = 'asleep' | 'return' | 'wait' | 'round' | 'drift' | 'trot' | 'run' | 'prowl' | 'search' | 'siege' | 'strike';
const BEHAVIOURS: readonly BehaviourId[] = ['asleep', 'return', 'wait', 'round', 'drift', 'trot', 'run', 'prowl', 'search', 'siege', 'strike'];

export type BrainOutput = {
  behaviour: BehaviourId;
  intent: Intent;
  /** Where its head should look, or undefined to look along its path. */
  gaze?: Point;
  events: BrainEvent[];
  /** Slowing or held by the torch: it cannot strike. */
  flinching: boolean;
  stun: StunState;
  asleep: boolean;
  /** It perceives the player right now (a heard noise of theirs in the last catchWindow, or breathing within 3 m). */
  perceives: boolean;
};

/** Every number that shapes how it hunts. Distances in metres, times in seconds, speeds in m/s. */
export const CREATURE_TUNING = {
  // --- Hearing. A noise is heard iff it is within heardWithin(loudness) (noise-scale.ts): no falloff, no chance. Only the
  // position it makes of it is blurred, more for a faint sound than a loud one ("about right").
  /** Error radius (m) of the place it makes of a faint, a loud and a very loud noise. */
  errorFaint: 3, errorLoud: 1, errorVeryLoud: .5,
  /** A heard noise within this far of the player's position is the player's own (footsteps, the torch, a door they opened). */
  playerNoiseRadius: 6,
  /** How long it perceives a player after hearing a noise of theirs: a walker's footfalls are 0.5 s apart, a crouch 0.9 s. */
  catchWindow: 1.5,
  /** The grab: metres from its head to the player's chest. */
  grabReach: 2.2,

  // --- Faint: stop, turn the head, drift. 1.2 m/s is under a walk (1.8): a player who keeps still is not caught up with.
  faintTurn: 1.2, faintSpeed: 1.2, faintArrive: 2,
  /** Seconds with no further sound before it loses interest (design: ten). */
  faintForget: 10,

  // --- Loud: call once, trot, search. 4 m/s is more than a walk (1.8) and under a sprint (5.6): a sprinter can still outrun it.
  trotSpeed: 4, trotArrive: 3,
  /** Searching the spot, listening: seconds on day 1 and the extra each later day. */
  searchSeconds: 20, searchPerDay: 5,
  /** While it searches it clicks: the first after this long, then every so many seconds (drawn between the two). */
  clicksFirst: 1.5, clicksEvery: [3.5, 6] as readonly number[],

  // --- Very loud or kept up: it runs at runMultiplier x the player's sprint (STAMINA.sprintSpeed, 5.6 -> 11.2).
  runMultiplier: 2, runArrive: 1.5,
  /** At the source it stays while the sound goes on. The generator hums every 7 s, so quiet this long means it has stopped. */
  stayQuiet: 10,
  /** A running source (brain.source) is steady, so quiet this long at it means it was switched off; and it pulls a creature that is following something else back this often. */
  sourceStayQuiet: 3, sourceRetake: 7,
  /**
   * At a running machine it does not wait: within `prowlStart` m of it, it prowls round it hunting whoever started it, at
   * `prowlSpeed` m/s (scuttled), on rings that widen from `prowlRing[0]` to `prowlRing[1]` m and close again every `prowlWiden` s,
   * now and then turning back the other way. So a running generator pulls it across the island, and is the worst place to be.
   */
  prowlStart: 6, prowlSpeed: 2.6, prowlRing: [9, 42] as readonly number[], prowlWiden: 40, prowlTurn: [10, 22] as readonly number[],

  // --- Indoors. It is too big to enter: it besieges the building. Distances in metres from the walls or an opening.
  /** How far from the walls its middle goes as it circles (its legs reach the rest of the way). */
  siegeRing: 3.6,
  /** No noise from inside for this long: it gives up, searches outside and moves on. */
  siegeQuiet: 10,
  /** With the noise inside kept up, a shut door is forced after this long (barred: after the second), by a creature at it: counted from when the siege began, whatever it was doing meanwhile. */
  forceSeconds: 8, forceBarredSeconds: 25,
  /** One visit to a door lasts this long before it goes round the building again (and over it, where it can climb); at a shut door it tells (scratches, knocks) every so often. */
  doorSpell: 9, tellEvery: [1.4, 3] as readonly number[],
  /** Going round, then (every so often) straight across to the far side, over the roof where the surface-climb takes it. */
  circleSeconds: [6, 10] as readonly number[], crossEvery: [14, 22] as readonly number[],
  /** A door open this far (0-1) is a way in for its arms. Inside this far (m) of an opening, and perceived, it strikes through it. */
  openingOpen: .3, openingReach: 2.5,
  /** It waits this far out from an opening it works at; it can strike from this far plus a body's reach. */
  openingStand: 3.2, openingStrikeFrom: 4.8,
  siegeSpeed: 3.2,
  /** Within this far of the walls it is at the building (the quiet is counted from there). */
  siegeNear: 14,
  /** It counts the noise inside as kept up (and works at a door) while the last of it is this recent. */
  keptUp: 4,

  // --- A second noise (see `take`). A fainter noise redirects it only if it is nearer than the current target; a creature
  // that is already at its target counts that target as this far, so a faint sound close beside a searcher still draws it.
  redirectNear: 8,

  // --- The lair and the day. By day it sleeps in the lair; it walks back from dawnReturn (05:30) and rests on arrival.
  returnSpeed: 5, lairArrive: 3, dawnReturn: 5.5,
  /** Woken by day it goes back to sleep after this many seconds of quiet. */
  sleepQuiet: 90,
  /** It leaves the lair at 19:00 on day 1 and half an hour earlier each day (17:00 on day 5). */
  leaveHour: 19, leaveEarlier: .5,
  /** Asleep: a loud noise within this far of the lair wakes it (a very loud one wakes it anywhere it is heard)... */
  lairWakeRadius: 60,
  /** ...and from this day it sleeps lightly: any loud noise it hears wakes it. */
  lightSleepDay: 4,

  // --- The round, when it has nothing to follow: a place, a pause to listen, the next. Slow near, brisk when far.
  roundSpeed: 2.2, roundFar: 110, roundFarSpeed: 4.5, roundArrive: 3, roundPause: [5, 9] as readonly number[],
  /** Without a provider from the host: its places in a shuffled order, or this many points this far (a range) from the lair. */
  roundPoints: 5, roundRadius: [120, 220] as readonly number[],

  // --- Developer hunt: it knows exactly where the player is, for this long.
  provokeSeconds: 90,

  // --- Torch stun, in three phases: it slows to a halt, it is held, it gets going again. Never a hard stop.
  /** Seconds the beam must hold on its face before it takes. */
  stunPin: .35,
  /** Seconds it takes to slow from whatever it was doing to a standstill (an eased stop, not a hard brake). */
  stunSlow: .58,
  /** Seconds it is held, first use onward. It stops shrinking at the last: never immune. */
  stunHeld: [3.2, 2.6, 2, 1.5],
  /** The beam must stay on it: off its face during the held phase, it is released this much later. */
  stunRelease: .6,
  /** Seconds from a walk back up to full pace, and the walk it restarts at. */
  stunStart: 1.4, stunStartSpeed: 2,
  /** Seconds out of the beam for full strength again (a step of strength back every third of it). */
  stunRecharge: 60,
  /** A short recovery window lets it advance before the beam can pin it again. */
  stunGrace: 1.2,
  /** The step back: seconds and top speed, early in the held phase. */
  stunBack: .7, stunBackSpeed: .8,
};
export type CreatureTuning = typeof CREATURE_TUNING;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (v: number, a: number, b: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const RANK: Record<NoiseGrade, number> = { faint: 0, loud: 1, veryLoud: 2 };

/** Mulberry32: small, fast, and identical on every client for the same seed. */
export function createRandom(seed: number) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------------------
// Senses and the clock, as plain functions so they can be checked on their own.

export type FootSurface = 'road' | 'dirt' | 'forest' | 'water';
/** Loudness of one footfall (the noise scale's: a sprint carries 45 m, a walk 22 m, a crouch 6 m). */
export function footstepLoudness(o: { speed: number; sprinting: boolean; crouching: boolean; surface: FootSurface }) { return footstepNoise(o); }
/** The torch switch: a small dry click, heard within a few metres. */
export const FLASHLIGHT_CLICK_LOUDNESS = NOISE.torchClick;

/** How dark the hour is, as far as courage once went: nothing by day, rising through the evening, full after 23:00. */
export function nightness(hours: number) {
  const h = ((hours % 24) + 24) % 24;
  if (h >= 16) return smoothstep(h, 16.5, 23);
  if (h < 4.5) return 1;
  return 1 - smoothstep(h, 4.5, 7);
}

/** The hour it leaves the lair on a day of the run: 19:00 on day 1, half an hour earlier each day. */
export function leaveHour(day: number, tuning: CreatureTuning = CREATURE_TUNING) { return tuning.leaveHour - tuning.leaveEarlier * (clamp(Math.round(day), 1, 99) - 1); }
/** Its night: from the hour it leaves the lair to dawnReturn. The rest is its day, spent asleep. */
export function isNight(hours: number, day = 1, tuning: CreatureTuning = CREATURE_TUNING) {
  const h = ((hours % 24) + 24) % 24;
  return h >= leaveHour(day, tuning) || h < tuning.dawnReturn;
}
/** Seconds it searches a spot on a day of the run: 20 s on day 1, 5 s longer each day. */
export function searchSeconds(day: number, tuning: CreatureTuning = CREATURE_TUNING) { return tuning.searchSeconds + tuning.searchPerDay * (clamp(Math.round(day), 1, 99) - 1); }

// ------------------------------------------------------------------------------------------------------------

export type CreatureBrainOptions = {
  random: () => number;
  /** Places worth patrolling between (the cabin, the relay, the mine...): the default round. */
  places?: readonly Vec2[];
  /** Where it sleeps by day. Default: where it is at its first tick. */
  lair?: Vec2;
  /** The points of one round, asked for each time it has nothing to follow (the day's noisy places, then roads and paths). */
  round?: () => readonly Vec2[];
  tuning?: Partial<CreatureTuning>;
  /** The buildings it besieges (creatureBuildings in ./buildings): a loud noise from inside one brings it to the walls. */
  buildings?: readonly Building[];
};
/** What it is following: the place it made of the last noise it took up. */
export type Lead = { x: number; z: number; source: string; grade: NoiseGrade; uncertainty: number; at: number };

/** It arrives a little before the distance it counts as arrived, so a body that stops short still counts. */
const ARRIVE = .8;

export function createCreatureBrain(options: CreatureBrainOptions) {
  const tuning: CreatureTuning = { ...CREATURE_TUNING, ...options.tuning };
  const random = options.random, places = options.places ?? [];
  const queue: NoiseEvent[] = [];
  let lair: Vec2 | undefined = options.lair && { x: options.lair.x, z: options.lair.z };
  let now = 0, mode: BehaviourId = 'round', modeAt = 0, started = false, wasNight: boolean | undefined, day = 1;
  // Woken by day: it stays up (responding, then waiting out the quiet) until the lair takes it back.
  let awakeByDay = false;
  let target: Vec2 | undefined, respRank = 0, lastSoundAt = -Infinity, lead: Lead | undefined;
  let turnUntil = 0, searchUntil = 0, nextClicks = 0, pauseUntil = Infinity, roundGoal: Vec2 | undefined, plan: Vec2[] = [], pendingStart: Vec2 | undefined;
  let perceivedUntil = -Infinity, provokedUntil = -Infinity, breathing = false;
  const carry: BrainEvent[] = [];
  const buildings = options.buildings ?? [];
  // A running source is on or off (brain.source); it is heard whenever the creature is inside its reach.
  const sources = new Map<string, RunningSource & { inReach: boolean; takenAt: number }>();
  let leadIsSource = false;
  // Prowling: which way round it goes (1 or -1) and when it next turns back.
  let prowlSide = 1, prowlTurnAt = 0;
  type SiegePhase = 'approach' | 'door' | 'reach' | 'circle' | 'cross';
  type Siege = {
    b: Building; lastInside: number; quietFrom: number; phase: SiegePhase; phaseAt: number; until: number; doorId?: string; atDoor: number; pressure: Map<string, number>;
    dir: 1 | -1; tick: number; nextTell: number; nextCross: number; nextClicks: number; goal?: Vec2;
  };
  let siege: Siege | undefined, ticks = 0;
  let siegeIntent: Intent = { speed: 0 };
  const alerts: { at: Vec2; uncertainty: number }[] = [];
  // The stun: its phase and how long it has been in it, how long the held phase lasts this time, when a beam that has
  // left its face lets it go, how many uses have worn it down, and the pace it was slowing from.
  let stunPhase: StunPhase = 'none', stunT = 0, stunHeldFor = 0, stunRelease = Infinity, stunSpent = 0, stunFrom = 0, outOfBeam = 0, beamTime = 0, flinchEnded = -Infinity;
  let last: BrainOutput | undefined, creature = { x: 0, z: 0, yaw: 0 };
  const between = (range: readonly number[]) => range[0] + random() * (range[1] - range[0]);
  const runSpeed = () => tuning.runMultiplier * STAMINA.sprintSpeed;

  function setMode(to: BehaviourId, events: BrainEvent[]) {
    if (to === mode) return;
    if (mode === 'siege') siege = undefined;
    events.push({ type: 'behaviour', from: mode, to }); mode = to; modeAt = now;
  }
  const engaged = () => mode === 'drift' || mode === 'trot' || mode === 'run' || mode === 'prowl' || mode === 'search' || mode === 'siege';
  const night = (input: BrainInput) => isNight(input.hours, day, tuning);

  /** Nothing to follow any more: the round by night; by day, waiting out the quiet if it was woken, else back to the lair. */
  function idle(input: BrainInput, events: BrainEvent[]) {
    target = undefined; roundGoal = undefined; respRank = 0;
    if (night(input)) setMode('round', events);
    else setMode(awakeByDay && now < lastSoundAt + tuning.sleepQuiet ? 'wait' : 'return', events);
  }
  function wake(cause: string, events: BrainEvent[]) {
    events.push({ type: 'wake', cause }); setMode('round', events);
  }

  /**
   * It has heard something worth following, `grade` at `pos`. Is it taken up? The rule: while it is following something, a noise
   * of the same or a louder grade always takes over (so a player can lead it by making noise elsewhere, and a sound kept up
   * holds it); a fainter one takes over only if it is nearer to the creature than the current target is (the target counted as
   * at least redirectNear away, so a creature standing at its spot still turns to a faint sound close beside it). Idle, it takes
   * up anything. Taking up a loud or louder noise from something less than a response to a loud noise is the one place it calls.
   */
  function take(pos: Vec2, grade: NoiseGrade, source: string, input: BrainInput, events: BrainEvent[], error: number, call = true) {
    const rank = RANK[grade], self = input.creature;
    if (engaged() && target && rank < respRank && !(dist(self, pos) < Math.max(dist(self, target), tuning.redirectNear))) return false;
    const a = random() * Math.PI * 2, r = Math.sqrt(random()) * error;
    const loudBefore = mode === 'trot' || mode === 'run' || mode === 'search';
    target = { x: pos.x + Math.sin(a) * r, z: pos.z + Math.cos(a) * r };
    leadIsSource = sources.has(source);
    respRank = rank; lastSoundAt = now; lead = { x: target.x, z: target.z, source, grade, uncertainty: error, at: now };
    if (!night(input)) awakeByDay = true;
    if (rank === 0) { if (mode !== 'drift') turnUntil = now + tuning.faintTurn; setMode('drift', events); }
    else setMode(rank === 1 ? 'trot' : 'run', events);
    if (rank >= 1 && !loudBefore && call) events.push({ type: 'call' });
    return true;
  }
  /** Asleep, does this heard noise wake it: a very loud one anywhere it carries; a loud one near the lair, or any from day 4. */
  const wakes = (n: NoiseEvent, grade: NoiseGrade) => grade === 'veryLoud' || (grade === 'loud' && (day >= tuning.lightSleepDay || dist(n, lair!) <= tuning.lairWakeRadius));

  function listen(input: BrainInput, events: BrainEvent[]) {
    const p = input.player, self = input.creature, weather = input.weather ?? 'still';
    breathing = false;
    for (const al of alerts.splice(0)) {
      if (mode === 'asleep') wake('alert', events);
      if (mode !== 'strike') take(al.at, 'loud', 'alert', input, events, al.uncertainty, false);
    }
    if (now < provokedUntil && !p.untouchable) {
      if (mode === 'asleep') wake('provoked', events);
      if (mode !== 'strike') take(p, 'veryLoud', 'provoked', input, events, 0, false);
    }
    // Running sources first: each is a kept-up noise heard for as long as it is in reach. One the creature is already following just
    // keeps it there; one it is not following is taken up when it comes into reach, and again every sourceRetake seconds.
    const incoming = queue.splice(0);
    for (const [id, src] of sources) {
      if (!hears(src.loudness, dist(self, src), weather)) { src.inReach = false; continue; }
      if (engaged() && lead?.source === id && mode !== 'search') { lastSoundAt = now; src.takenAt = now; src.inReach = true; continue; }
      if (!src.inReach || now - src.takenAt >= tuning.sourceRetake) { src.inReach = true; src.takenAt = now; incoming.push({ loudness: src.loudness, source: id, x: src.x, z: src.z, sustained: true }); }
    }
    for (const n of incoming) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.z)) continue;
      const d = dist(self, n);
      if (!hears(n.loudness, d, weather)) continue;
      const grade = noiseGrade(n.loudness, !!n.sustained);
      events.push({ type: 'heard', source: n.source, grade, distance: d });
      if (mode === 'asleep') { if (!wakes(n, grade)) continue; wake(grade === 'veryLoud' ? 'very loud noise' : 'loud noise', events); }
      if (mode === 'strike') continue;
      if (!p.untouchable && dist(n, p) <= tuning.playerNoiseRadius) perceivedUntil = now + tuning.catchWindow;
      const within = buildings.length ? buildingAt(buildings, n.x, n.z, -.3) : undefined;
      if (within) takeInside(within, n, grade, input, events);
      else take(n, grade, n.source, input, events, grade === 'faint' ? tuning.errorFaint : grade === 'loud' ? tuning.errorLoud : tuning.errorVeryLoud);
    }
    // Close up it hears breathing, a faint noise at the player's exact place, unless the breath is held. Asleep, it does not.
    if (mode !== 'asleep' && mode !== 'strike' && !p.untouchable && !p.breathHeld && hears(NOISE.breath, dist(self, p), weather)) {
      breathing = true;
      // Through a wall it still hears them: that keeps the siege up, and it needs no other lead.
      if (mode === 'siege' && siege && buildingAt([siege.b], p.x, p.z, -.3)) { siege.lastInside = now; lastSoundAt = now; }
      else take(p, 'faint', 'breath', input, events, 0);
    }
  }

  /**
   * A noise heard from inside a building. Where it is already besieging that building it just keeps the siege up. Otherwise a faint
   * one draws it to the walls like any faint sound; a loud one (or louder) begins the siege, by the same rule as `take` for whether
   * it breaks off what it was doing.
   */
  function takeInside(b: Building, n: NoiseEvent, grade: NoiseGrade, input: BrainInput, events: BrainEvent[]) {
    const rank = RANK[grade], self = input.creature;
    if (mode === 'siege' && siege && siege.b === b) {
      siege.lastInside = now; lastSoundAt = now; respRank = Math.max(respRank, rank);
      lead = { x: n.x, z: n.z, source: n.source, grade, uncertainty: 0, at: now };
      return;
    }
    if (rank === 0) { take(ringPoint(b, bearingOf(b, self.x, self.z), tuning.siegeRing), grade, n.source, input, events, tuning.errorFaint); return; }
    if (engaged() && target && rank < respRank && !(dist(self, n) < Math.max(dist(self, target), tuning.redirectNear))) return;
    const loudBefore = mode === 'trot' || mode === 'run' || mode === 'search' || mode === 'siege';
    siege = {
      b, lastInside: now, quietFrom: now, phase: 'approach', phaseAt: now, until: Infinity, atDoor: 0, pressure: new Map(), dir: random() < .5 ? 1 : -1, tick: -1,
      nextTell: now, nextCross: now + between(tuning.crossEvery), nextClicks: now + tuning.clicksFirst,
    };
    leadIsSource = false; respRank = Math.max(rank, 1); lastSoundAt = now;
    lead = { x: n.x, z: n.z, source: n.source, grade, uncertainty: 0, at: now };
    if (!night(input)) awakeByDay = true;
    setMode('siege', events);
    if (!loudBefore) events.push({ type: 'call' });
  }
  const outsidePoint = (b: Building, self: Vec2, bearing = bearingOf(b, self.x, self.z)) => ringPoint(b, bearing, tuning.siegeRing);
  /** The noise inside has stopped: it searches outside, where it stands, and then moves on. */
  function leaveSiege(input: BrainInput, events: BrainEvent[]) {
    target = outsidePoint(siege!.b, input.creature); respRank = 1; lastSoundAt = now; leadIsSource = false;
    beginSearch(events);
  }
  /** Whether an open doorway of the besieged building is within reach of the player, with the creature close enough to it to reach in. */
  function throughOpening(input: BrainInput) {
    if (mode !== 'siege' || !siege) return false;
    const p = input.player, self = input.creature;
    for (const o of input.openings ?? []) {
      if (o.building !== siege.b.id || o.open < tuning.openingOpen) continue;
      if (dist(p, o) <= tuning.openingReach && dist(self, o) <= tuning.openingStrikeFrom) return true;
    }
    return false;
  }
  /**
   * One tick of the siege: where it goes and what it does at the building. It comes to the walls (approach); works at a shut
   * door a while (door: scratches and knocks, and forces it once its pressure, which builds only while the noise inside is kept up,
   * reaches forceSeconds, or forceBarredSeconds if barred); goes round the walls (circle) and now and then straight across to the far
   * side (cross: over the roof wherever the navigation can climb it, so the feet are heard above); and at an open doorway it waits,
   * listening, for anyone within reach of its arms (the strike itself is decided in tick). Quiet inside for siegeQuiet: it leaves.
   */
  function siegeStep(input: BrainInput, events: BrainEvent[]) {
    const s = siege;
    if (!s) { idle(input, events); return; }
    // advance runs twice a tick (before and after listening): time passes once.
    const dt = s.tick === ticks ? 0 : input.dt; s.tick = ticks;
    const self = input.creature, b = s.b, openings = (input.openings ?? []).filter(o => o.building === b.id);
    // The quiet is counted from when it gets there: a noise that drew it from afar need not be kept up all the way.
    // (Until it is there, whatever the phase: a doorway open from the start sends it straight to it.)
    const local = toLocal(b, self.x, self.z), away = Math.hypot(Math.max(0, Math.abs(local.x) - b.hx), Math.max(0, Math.abs(local.z) - b.hz));
    if (s.phase === 'approach' || away > tuning.siegeNear) s.quietFrom = now;
    if (now - Math.max(s.lastInside, s.quietFrom) >= tuning.siegeQuiet) { leaveSiege(input, events); return; }
    lastSoundAt = Math.max(lastSoundAt, s.lastInside);
    const kept = now - s.lastInside < tuning.keptUp;
    const wide = openings.filter(o => o.open >= tuning.openingOpen), shut = openings.filter(o => o.open < tuning.openingOpen);
    const nearest = (list: readonly Opening[], at: Vec2) => list.reduce<Opening | undefined>((best, o) => !best || dist(o, at) < dist(best, at) ? o : best, undefined);
    const go = (phase: SiegePhase, extra: Partial<Siege> = {}) => { s.phase = phase; s.phaseAt = now; s.atDoor = 0; s.goal = undefined; Object.assign(s, extra); };
    const nextVisit = () => {
      const o = nearest(shut, self);
      if (o) go('door', { doorId: o.id }); else go('circle', { until: now + between(tuning.circleSeconds) });
    };
    // The noise inside keeps up: every shut door is under pressure, whether or not it is at that door this moment (it hammers, scratches, leans).
    // It forces one when it is at it and the pressure is enough; a door that is ready draws it back from the rounds.
    const limit = (o: Opening) => o.barred ? tuning.forceBarredSeconds : tuning.forceSeconds;
    if (kept) for (const o of shut) s.pressure.set(o.id, (s.pressure.get(o.id) ?? 0) + dt);
    const ready = shut.filter(o => (s.pressure.get(o.id) ?? 0) >= limit(o));
    // A doorway stands open: that is where it works, whatever else it was doing (it goes back to the walls if the door is shut again).
    if (wide.length) {
      if (s.phase !== 'reach' || !wide.some(o => o.id === s.doorId)) go('reach', { doorId: nearest(wide, lead ?? self)!.id });
    } else if (s.phase === 'reach') nextVisit();
    else if (ready.length && s.phase !== 'door' && s.phase !== 'approach') go('door', { doorId: nearest(ready, self)!.id });
    const bearing = bearingOf(b, self.x, self.z);
    let goal: Vec2 | undefined, speed = tuning.siegeSpeed;
    switch (s.phase) {
      case 'approach': {
        goal = outsidePoint(b, self, bearing); speed = respRank >= 2 ? runSpeed() : tuning.trotSpeed;
        if (dist(self, goal) <= 4) nextVisit();
        break;
      }
      case 'door': {
        const o = openings.find(q => q.id === s.doorId && q.open < tuning.openingOpen);
        if (!o) { nextVisit(); break; }
        goal = standAt(b, o, tuning.openingStand); speed = tuning.trotSpeed;
        if (dist(self, goal) <= 2.4) {
          s.atDoor += dt; speed = 0;
          if (now >= s.nextTell) { events.push({ type: 'doorTell', kind: random() < .6 ? 'scratch' : 'knock', door: o.id, x: o.x, z: o.z }); s.nextTell = now + between(tuning.tellEvery); }
          if ((s.pressure.get(o.id) ?? 0) >= limit(o)) {
            events.push({ type: 'forceDoor', door: o.id, barred: o.barred, x: o.x, z: o.z }); s.pressure.set(o.id, 0);
            go('reach', { doorId: o.id });
          }
          if (s.phase === 'door' && s.atDoor >= tuning.doorSpell && !ready.includes(o)) go('circle', { until: now + between(tuning.circleSeconds), dir: random() < .5 ? 1 : -1 });
        }
        break;
      }
      case 'circle': {
        goal = outsidePoint(b, self, bearing + s.dir * .7);
        if (now >= s.until) { if (now >= s.nextCross) { go('cross', { until: now + 14 }); s.nextCross = now + between(tuning.crossEvery); } else nextVisit(); }
        break;
      }
      case 'cross': {
        goal = outsidePoint(b, self, bearing + Math.PI); speed = tuning.trotSpeed;
        if (dist(self, goal) <= 3 || now >= s.until) go('circle', { until: now + between(tuning.circleSeconds), dir: random() < .5 ? 1 : -1 });
        break;
      }
      case 'reach': {
        const o = openings.find(q => q.id === s.doorId && q.open >= tuning.openingOpen);
        if (!o) { nextVisit(); break; }
        goal = standAt(b, o, tuning.openingStand); speed = dist(self, goal) > 2 ? tuning.trotSpeed : 0;
        if (now >= s.nextClicks) { events.push({ type: 'clicks' }); s.nextClicks = now + between(tuning.clicksEvery); }
        break;
      }
    }
    // Still far off, it comes at the pace the noise called for (a very loud one: a run); the work at the building is for when it is there.
    if (away > tuning.siegeNear && speed > 0) speed = Math.max(speed, respRank >= 2 ? runSpeed() : tuning.trotSpeed);
    s.goal = goal; target = goal;
    siegeIntent = { target: goal, speed, arrive: 1.6 * ARRIVE };
  }

  const defaultRound = (): Vec2[] => {
    if (places.length) {
      const order = places.map(q => ({ x: q.x, z: q.z })); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      return order.map(q => { const a = random() * Math.PI * 2, d = 4 + random() * 8; return { x: q.x + Math.sin(a) * d, z: q.z + Math.cos(a) * d }; });
    }
    const home = lair ?? creature;
    return Array.from({ length: tuning.roundPoints }, () => { const a = random() * Math.PI * 2, d = between(tuning.roundRadius); return { x: home.x + Math.sin(a) * d, z: home.z + Math.cos(a) * d }; });
  };

  /** Where in its day it is, and what has finished: the mode changes that need no sound. */
  function advance(input: BrainInput, events: BrainEvent[]) {
    const self = input.creature, isNightNow = night(input);
    if (!started) {
      started = true; lair ??= { x: self.x, z: self.z };
      if (isNightNow) setMode('round', events);
      else { mode = dist(self, lair) <= tuning.lairArrive ? 'asleep' : 'return'; modeAt = now; }
      wasNight = isNightNow;
    }
    if (wasNight !== isNightNow) {
      awakeByDay = false; wasNight = isNightNow;
      if (!isNightNow && mode !== 'asleep' && mode !== 'strike') { target = undefined; roundGoal = undefined; respRank = 0; setMode('return', events); }
    }
    if (mode === 'strike') return;
    if (isNightNow && (mode === 'asleep' || mode === 'return' || mode === 'wait')) { if (mode === 'asleep') wake('dusk', events); else setMode('round', events); }
    if (!isNightNow && mode === 'round') idle(input, events);
    if (!isNightNow && !awakeByDay && mode !== 'asleep' && mode !== 'return') { target = undefined; roundGoal = undefined; respRank = 0; setMode('return', events); }
    if (isNightNow && mode === 'round' && pendingStart) {
      // The night starts at the loudest place of the day: it goes there as it would to a loud noise, but it has not heard it.
      target = pendingStart; pendingStart = undefined; respRank = 1; lastSoundAt = now; roundGoal = undefined; setMode('trot', events);
    }
    switch (mode) {
      case 'drift': if (now - lastSoundAt >= tuning.faintForget) idle(input, events); break;
      case 'trot': if (target && dist(self, target) <= tuning.trotArrive) beginSearch(events); break;
      case 'run':
        if (target && leadIsSource && dist(self, target) <= tuning.prowlStart && now - lastSoundAt < tuning.sourceStayQuiet) {
          prowlSide = random() < .5 ? -1 : 1; prowlTurnAt = now + between(tuning.prowlTurn); setMode('prowl', events);
        } else if (target && dist(self, target) <= tuning.runArrive && now - lastSoundAt >= (leadIsSource ? tuning.sourceStayQuiet : tuning.stayQuiet)) beginSearch(events);
        break;
      case 'prowl':
        if (!leadIsSource || now - lastSoundAt >= tuning.sourceStayQuiet) beginSearch(events);
        else if (now >= prowlTurnAt) { prowlSide = -prowlSide; prowlTurnAt = now + between(tuning.prowlTurn); }
        break;
      case 'siege': siegeStep(input, events); break;
      case 'search': if (now >= searchUntil) idle(input, events); break;
      case 'wait': if (now >= lastSoundAt + tuning.sleepQuiet) setMode('return', events); break;
      case 'return': if (lair && dist(self, lair) <= tuning.lairArrive) { if (isNightNow) idle(input, events); else { awakeByDay = false; setMode('asleep', events); events.push({ type: 'sleep' }); } } break;
      case 'round': {
        if (!roundGoal) {
          if (!plan.length) plan = [...(options.round?.() ?? defaultRound())].map(q => ({ x: q.x, z: q.z }));
          roundGoal = plan.shift(); pauseUntil = Infinity;
        }
        if (roundGoal && pauseUntil === Infinity && dist(self, roundGoal) <= tuning.roundArrive) pauseUntil = now + between(tuning.roundPause);
        if (roundGoal && now >= pauseUntil) { roundGoal = undefined; pauseUntil = Infinity; }
        break;
      }
      default: break;
    }
  }
  function beginSearch(events: BrainEvent[]) {
    searchUntil = now + searchSeconds(day, tuning); nextClicks = now + tuning.clicksFirst; setMode('search', events);
  }

  /** What each behaviour asks of the body. */
  function act(input: BrainInput, events: BrainEvent[]): { intent: Intent; gaze?: Point } {
    const self = input.creature;
    // Looking about: a sweep either side of where it is facing, or, searching, either side of the way to the last thing it heard.
    const sweep = (t: number, base = self.yaw) => { const a = base + Math.sin(t * 1.4) * 1.3; return { x: self.x + Math.sin(a) * 9, z: self.z + Math.cos(a) * 9 }; };
    switch (mode) {
      case 'asleep': return { intent: { speed: 0 } };
      case 'return': return { intent: { target: lair, speed: tuning.returnSpeed, arrive: tuning.lairArrive * ARRIVE }, gaze: lair };
      case 'wait': return { intent: { speed: 0 }, gaze: sweep(now) };
      case 'round': {
        if (!roundGoal || pauseUntil !== Infinity) return { intent: { speed: 0 }, gaze: sweep(now) };
        return { intent: { target: roundGoal, speed: dist(self, roundGoal) > tuning.roundFar ? tuning.roundFarSpeed : tuning.roundSpeed, arrive: tuning.roundArrive * ARRIVE }, gaze: roundGoal };
      }
      case 'drift': return { intent: { target, speed: now < turnUntil ? 0 : tuning.faintSpeed, arrive: tuning.faintArrive }, gaze: target };
      case 'trot': return { intent: { target, speed: tuning.trotSpeed, arrive: tuning.trotArrive * ARRIVE }, gaze: target };
      case 'run': return { intent: { target, speed: runSpeed(), arrive: tuning.runArrive * ARRIVE }, gaze: target };
      case 'prowl': {
        if (!target) return { intent: { speed: 0 }, gaze: sweep(now) };
        // A point a little further round the ring than it is now, the ring widening and closing like a search pattern.
        const [r0, r1] = tuning.prowlRing, u = ((now - modeAt) / tuning.prowlWiden) % 1, ring = r0 + (r1 - r0) * (1 - Math.abs(1 - 2 * u));
        const bearing = Math.atan2(self.x - target.x, self.z - target.z) + prowlSide * Math.min(.9, 7 / ring);
        const goal = { x: target.x + Math.sin(bearing) * ring, z: target.z + Math.cos(bearing) * ring };
        return { intent: { target: goal, speed: tuning.prowlSpeed, arrive: .5 }, gaze: goal };
      }
      case 'search':
        if (now >= nextClicks) { events.push({ type: 'clicks' }); nextClicks = now + between(tuning.clicksEvery); }
        return { intent: { target, speed: 0 }, gaze: sweep(now - modeAt, lead && dist(self, lead) > 1 ? Math.atan2(lead.x - self.x, lead.z - self.z) : self.yaw) };
      case 'siege': return { intent: siegeIntent, gaze: lead && { x: lead.x, z: lead.z } };
      default: return { intent: { speed: 0 }, gaze: input.player };
    }
  }

  const stunning = () => stunPhase === 'slowing' || stunPhase === 'held';
  /**
   * The torch. Pinned for stunPin, it slows to a halt over stunSlow, is held (shorter each use, never less than the
   * last entry), and gets going again over stunStart. The beam must stay on it while it is held. Out of the beam
   * it gets its nerve back, a step at a time. Light holds it; nothing else does.
   */
  function stun(input: BrainInput, events: BrainEvent[]) {
    const dt = input.dt, held = tuning.stunHeld;
    if (stunPhase === 'none') {
      if (input.beamOnIt) outOfBeam = 0;
      else if (stunSpent > 0 && (outOfBeam += dt) >= tuning.stunRecharge / Math.max(1, held.length - 1)) { stunSpent--; outOfBeam = 0; }
      if (input.beamOnIt && !input.player.untouchable && mode !== 'strike' && mode !== 'asleep' && now - flinchEnded >= tuning.stunGrace) {
        beamTime += dt;
        if (beamTime >= tuning.stunPin) {
          stunHeldFor = held[Math.min(stunSpent, held.length - 1)];
          stunSpent = Math.min(stunSpent + 1, held.length - 1);
          stunPhase = 'slowing'; stunT = 0; beamTime = 0; stunRelease = Infinity; stunFrom = input.creature.speed ?? last?.intent.speed ?? 0;
          events.push({ type: 'flinch', seconds: stunHeldFor });
        }
      } else beamTime = 0;
      return;
    }
    stunT += dt;
    if (stunPhase === 'slowing') {
      if (stunT >= tuning.stunSlow) { stunPhase = 'held'; stunT = 0; events.push({ type: 'stun', phase: 'held', seconds: stunHeldFor }); }
    } else if (stunPhase === 'held') {
      // A flicker of the beam is forgiven; off its face for stunRelease, it is free.
      if (input.beamOnIt) stunRelease = Infinity; else if (stunRelease === Infinity) stunRelease = stunT + tuning.stunRelease;
      if (stunT >= Math.min(stunHeldFor, stunRelease)) {
        events.push({ type: 'stun', phase: 'starting', seconds: stunT });
        stunPhase = 'starting'; stunT = 0; flinchEnded = now;
      }
    } else if (stunT >= tuning.stunStart) { stunPhase = 'none'; stunT = 0; beamTime = 0; outOfBeam = 0; events.push({ type: 'stun', phase: 'over' }); }
  }
  const easeInOut = (u: number) => { const t = clamp(u, 0, 1); return t * t * (3 - 2 * t); };
  /** What the stun does to the behaviour's intent: an eased stop, a held stand, an eased restart from a walk. */
  function stunned(intent: Intent): { intent: Intent; stun: StunState } {
    const t = tuning;
    if (stunPhase === 'slowing') {
      const u = stunT / t.stunSlow;
      return { intent: { ...intent, speed: stunFrom * (1 - easeInOut(u)) }, stun: { phase: 'slowing', recoil: easeInOut(u), backstep: 0 } };
    }
    if (stunPhase === 'held') {
      const backstep = stunT < t.stunBack ? t.stunBackSpeed * Math.sin(Math.PI * stunT / t.stunBack) : 0;
      return { intent: { ...intent, speed: 0 }, stun: { phase: 'held', recoil: 1, backstep } };
    }
    if (stunPhase === 'starting') {
      const u = stunT / t.stunStart, cap = lerp(t.stunStartSpeed, Math.max(t.stunStartSpeed, intent.speed), easeInOut(u));
      return { intent: { ...intent, speed: Math.min(intent.speed, cap) }, stun: { phase: 'starting', recoil: 1 - easeInOut(u * 2), backstep: 0 } };
    }
    return { intent, stun: { phase: 'none', recoil: 0, backstep: 0 } };
  }

  const resetStun = () => { stunPhase = 'none'; stunT = stunHeldFor = stunSpent = stunFrom = outOfBeam = beamTime = 0; stunRelease = Infinity; flinchEnded = -Infinity; };
  const forget = () => {
    queue.length = 0; alerts.length = 0; lead = undefined; target = undefined; roundGoal = undefined; respRank = 0; perceivedUntil = -Infinity; siege = undefined;
    for (const src of sources.values()) src.inReach = false;
    if (engaged()) { mode = 'round'; modeAt = now; }
  };

  return {
    get tuning() { return tuning; },
    get behaviour() { return mode; },
    get lair() { return lair && { ...lair }; },
    /**
     * A running source: something that makes a sound for as long as it runs (a generator, a pump, the pad's generator, the helicopter).
     * `source(id, { x, z, loudness })` switches it on (or moves it), `source(id, null)` off. While it runs the creature hears it
     * whenever it is inside heardWithin(loudness) as a kept-up, very loud noise: it runs there and stays; when it stops it searches.
     */
    source(id: string, spec: RunningSource | null) {
      if (!spec) { sources.delete(id); return; }
      if (![spec.x, spec.z, spec.loudness].every(Number.isFinite)) return;
      const at = sources.get(id);
      if (at) { at.x = spec.x; at.z = spec.z; at.loudness = spec.loudness; } else sources.set(id, { x: spec.x, z: spec.z, loudness: spec.loudness, inReach: false, takenAt: -Infinity });
    },
    /** The running sources now (id, place, loudness), for logs and tests. */
    sources() { return [...sources].map(([id, v]) => ({ id, x: v.x, z: v.z, loudness: v.loudness })); },
    /** Queue a noise; it is heard (or not) from wherever the creature is on the next tick. */
    hear(noise: NoiseEvent) { queue.push({ loudness: noise.loudness, source: noise.source, x: noise.x, z: noise.z, sustained: noise.sustained }); if (queue.length > 64) queue.shift(); },
    tick(input: BrainInput): BrainOutput {
      const dt = Math.max(0, Math.min(input.dt, .25)), events: BrainEvent[] = carry.splice(0);
      input = dt === input.dt ? input : { ...input, dt };
      day = clamp(Math.round(input.day ?? 1), 1, 99);
      now += dt; ticks++; creature = { ...input.creature };
      advance(input, events);
      listen(input, events);
      // A noise may have taken it up or woken it; settle what that means before it moves.
      advance(input, events);
      if (mode !== 'asleep') stun(input, events); else beamTime = 0;
      const p = input.player;
      const perceives = mode !== 'asleep' && !p.untouchable && (now < provokedUntil || breathing || now < perceivedUntil);
      // The catch: only a player it perceives right now, in reach, and it is not held by the light.
      // Besieging a building it cannot get its head into: a wall is between it and anyone inside, so only an open doorway lets it reach.
      const walled = mode === 'siege' && !!siege && !!buildingAt([siege.b], p.x, p.z, -.3);
      if (perceives && mode !== 'strike' && ((input.reach < tuning.grabReach && !walled) || throughOpening(input)) && !stunning()) { setMode('strike', events); events.push({ type: 'strike' }); }
      const action = act(input, events), flinching = stunning(), shaped = stunned(action.intent);
      let gaze = action.gaze;
      // Close enough to hear the breath, its face finds it: the breath is at the player's place, which it has heard. Never otherwise.
      if (breathing && mode !== 'strike') gaze = { x: p.x, y: p.y + 1.3, z: p.z };
      if (flinching) {
        // Pinned by the beam: its face turns aside from the light.
        const ax = input.creature.x - p.x, az = input.creature.z - p.z, l = Math.hypot(ax, az) || 1;
        gaze = { x: input.creature.x + (-az / l) * 6 + ax / l * 3, y: p.y + 4, z: input.creature.z + (ax / l) * 6 + az / l * 3 };
      }
      last = { behaviour: mode, intent: shaped.intent, gaze, events, flinching, stun: shaped.stun, asleep: mode === 'asleep', perceives };
      return last;
    },
    /** The night's start: the loudest place of the day (null for none). It goes there first, once, when it has nothing to follow. */
    dusk(start: Vec2 | null) { pendingStart = start ? { x: start.x, z: start.z } : undefined; },
    /** Where it sleeps by day. */
    setLair(at: Vec2) { lair = { x: at.x, z: at.z }; },
    /** The player was taken and woke elsewhere: it forgets what it was following and starts again from nothing. */
    struck() { forget(); resetStun(); provokedUntil = -Infinity; if (mode === 'strike') { mode = 'round'; modeAt = now; } plan = []; started = false; },
    /** The host moved the body (a spawn or relocation): drop the half-finished walk, keep what it knows. */
    relocated() { roundGoal = undefined; if (mode === 'strike') { mode = 'round'; modeAt = now; started = false; } },
    /** Developer dismiss: break off and forget. */
    dismiss() { provokedUntil = -Infinity; forget(); if (mode === 'strike') { mode = 'round'; modeAt = now; } started = false; },
    /** Everything it was following and the noises it heard, gone. */
    forget,
    /** Developer hunt: it knows exactly where the player is, and runs at them. */
    provoke() { provokedUntil = now + tuning.provokeSeconds; awakeByDay = true; },
    /** Give it something to investigate (a developer "natural" spawn hands it the player's rough position): a loud noise, no call. */
    alert(at: Vec2, uncertainty = 8) { alerts.push({ at: { x: at.x, z: at.z }, uncertainty }); },
    /** Run a behaviour now, whatever it was doing (hosts and tests). */
    force(id: BehaviourId) {
      if (!BEHAVIOURS.includes(id)) throw new Error(`Unknown creature behaviour "${id}"`);
      if (id === 'siege' && !siege) return;   // a siege needs a building and a noise inside it: begin one by making a noise there
      mode = id; modeAt = now; roundGoal = undefined; started = true;
      if (id === 'search') { searchUntil = now + searchSeconds(day, tuning); nextClicks = now + tuning.clicksFirst; target ??= { x: creature.x, z: creature.z }; }
    },
    /** A new night: everything forgotten (the lair stays). */
    reset() {
      queue.length = 0; alerts.length = 0; carry.length = 0; now = 0; mode = 'round'; modeAt = 0; started = false; wasNight = undefined; awakeByDay = false;
      siege = undefined; for (const src of sources.values()) src.inReach = false; leadIsSource = false;
      target = undefined; respRank = 0; lastSoundAt = -Infinity; lead = undefined; turnUntil = searchUntil = nextClicks = 0; pauseUntil = Infinity; roundGoal = undefined; plan = [];
      pendingStart = undefined; perceivedUntil = provokedUntil = -Infinity; breathing = false; resetStun(); last = undefined;
    },
    inspect() {
      return {
        clock: now, behaviour: mode, inBehaviour: now - modeAt, asleep: mode === 'asleep', night: wasNight, day, lair: lair && { ...lair }, awakeByDay,
        lead: lead && { ...lead, age: now - lead.at }, target: target && { ...target }, response: mode === 'asleep' ? undefined : respRank, pendingStart: pendingStart && { ...pendingStart },
        roundGoal: roundGoal && { ...roundGoal }, roundLeft: plan.length, perceived: Math.max(0, perceivedUntil - now), breathing, provoked: Math.max(0, provokedUntil - now),
        searchLeft: mode === 'search' ? Math.max(0, searchUntil - now) : 0, quietFor: now - lastSoundAt, creature: { ...creature },
        flinch: { active: stunning(), phase: stunPhase, inPhase: stunT, held: stunHeldFor, spent: stunSpent, nextHeld: tuning.stunHeld[Math.min(stunSpent, tuning.stunHeld.length - 1)], outOfBeam },
        intent: last?.intent,
        siege: siege && { building: siege.b.id, phase: siege.phase, inPhase: now - siege.phaseAt, door: siege.doorId, quietFor: now - siege.lastInside, pressure: Object.fromEntries(siege.pressure) },
        sources: [...sources].map(([id, v]) => ({ id, x: v.x, z: v.z, loudness: v.loudness })),
      };
    },
  };
}
export type CreatureBrain = ReturnType<typeof createCreatureBrain>;
