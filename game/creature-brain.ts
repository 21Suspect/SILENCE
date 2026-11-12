/**
 * The Listener's mind: senses, memory and a utility selector over behaviours.
 *
 * Pure and deterministic. No three.js, no scene, no clock and no Math.random: the host (game/encounters.ts)
 * measures the world for it (line of sight, where the torch beam points, how far its head is from the player)
 * and moves the body; this module only perceives and decides. Randomness comes from the injected `random`, and
 * time only from the `dt` of each tick, so a fixed seed and a fixed script of inputs replay exactly. That keeps
 * it testable and lets a multiplayer host own it later.
 *
 * Decisions: every behaviour scores itself against the current situation; the best one runs. The running one
 * gets a small bonus (hysteresis) and a minimum commitment, so it does not flicker. New behaviours (Stage 2's
 * Watch, Bluff, Cut off) are new entries in the list handed to createCreatureBrain; nothing else changes.
 */

export type Vec2 = { x: number; z: number };
/** A world point. Without y the host picks a height (the ground plus head height). */
export type Point = { x: number; y?: number; z: number };

/** Something that made a sound, from the objectives' noise stream (footsteps, ladder rungs, the generator...). */
export type NoiseEvent = { loudness: number; source: string; x: number; z: number };

/** What is true about the player this instant. The brain only uses position and motion when it senses them. */
export type PlayerPercept = {
  x: number; y: number; z: number;
  /** Ground velocity, m/s. */
  vx: number; vz: number;
  sprinting: boolean; crouching: boolean; flashlightOn: boolean;
  inWater: boolean; onLadder: boolean; indoors: boolean;
  /** Flying/noclip, already caught, or otherwise out of play: it can neither sense nor strike them. */
  untouchable?: boolean;
};

export type BrainInput = {
  /** Seconds since the last tick. All of the brain's time comes from this. */
  dt: number;
  /** Local solar time, 0-24, and how dark it is, 0-1. */
  hours: number; darkness: number;
  /** Where it is, which way it faces, and (if the host knows) how fast its body is really moving, m/s. */
  creature: { x: number; z: number; yaw: number; speed?: number };
  player: PlayerPercept;
  /** Measured by the host: nothing solid between its eyes and the player's body. */
  lineOfSight: boolean;
  /** The player has it on screen, unobstructed. */
  playerLooking: boolean;
  /** The torch is on, aimed at its head and close enough to dazzle. */
  beamOnIt: boolean;
  /** Metres from its head and hands to the player's chest; Infinity when there is no body to reach with. */
  reach: number;
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
  | { type: 'spotted' }
  | { type: 'heard'; source: string; strength: number }
  | { type: 'hunt-started' }
  | { type: 'strike' }
  /** It lost them: `from` is the behaviour that ended (a hunt lost is a chase that got away; a shadow lost is nothing much). */
  | { type: 'lost-player'; from: string }
  /** It has decided to get ahead of the player and wait on their way. */
  | { type: 'ambush' }
  /** The torch has pinned it: it begins to slow to a halt and will be held for `seconds` if the beam stays on it. */
  | { type: 'flinch'; seconds: number }
  /** The stun moves on: held (it has stopped), starting (it is getting going again, `seconds` it was held), over. */
  | { type: 'stun'; phase: 'held' | 'starting' | 'over'; seconds?: number };

/** The torch stun: slowing to a halt, held, then getting going again. */
export type StunPhase = 'none' | 'slowing' | 'held' | 'starting';
export type StunState = {
  phase: StunPhase;
  /** 0-1: how far it has shrunk from the light (crouched, coiled, head turned away). */
  recoil: number;
  /** m/s it steps backward, without turning, early in the held phase. */
  backstep: number;
};

export type BrainOutput = {
  behaviour: string;
  intent: Intent;
  /** Where its head should look, or undefined to look along its path. */
  gaze?: Point;
  events: BrainEvent[];
  /** Slowing or held by the torch: it cannot strike. */
  flinching: boolean;
  stun: StunState;
  sees: boolean;
  boldness: number;
};

/** Every number that shapes how it hunts. Distances in metres, times in seconds, speeds in m/s. */
export const CREATURE_TUNING = {
  // --- Hearing. A noise of loudness 1 (the generator roaring awake) carries this far.
  hearingRange: 100,
  /** Position error of a heard noise: a base, a share of the distance, and more for a faint one. */
  hearingError: 2, hearingErrorPerMetre: .1, hearingErrorFaint: 6,

  // --- Sight ranges for a standing, walking player.
  sightDay: 55,
  /** Full night, torch off: a dark shape among trunks. */
  sightNight: 15,
  /** Torch on in the dark: a beacon. */
  sightBeacon: 80,
  sightCrouch: .55, sightStill: .8, sightSprint: 1.15, sightIndoors: .35,
  /** Half-angle (radians) its ring of eyes sees well within; behind that the range shrinks to sightBehind. */
  sightFov: 2.3, sightBehind: .6,
  /** It feels a player this close whatever it can see. */
  touchRange: 3.2,
  /** Seconds of clear view to recognise the player: close is near-instant, at the edge of range slow. */
  recogniseNear: .25, recogniseFar: 2.2, forgetRate: .8,

  // --- Memory.
  /** How long a lead (a heard noise, a last sighting) is worth following. */
  leadMemory: 45,
  /** How fast a last sighting loses out to a new noise: a loud one wins within seconds of losing sight. */
  sightLeadFade: 12,
  /** How long after losing sight it can still shadow from memory. */
  shadowMemory: 7,
  /** How long a hunt runs on toward where the player was heading after losing sight. */
  huntPersist: 6,

  // --- Boldness: night does most of it, the length of the evening the rest.
  boldNight: .85, boldElapsed: .15, boldElapsedFrom: 90, boldElapsedTo: 600,
  /** Free-roam playtime also builds courage, even after the sun comes up. */
  pressureFrom: 120, pressureFull: 300, pressureBoldness: .72,
  /** Boldness where hunting starts to be possible, and where it is a certainty. */
  huntBoldnessMin: .5, huntBoldnessFull: .8,
  /**
   * The host can withhold hunting (the scripted opening). Once it is allowed again there is none for huntPermitDelay
   * seconds; then the drive rises from huntPermitFloor to its full strength over huntPermitRamp: rare at first, certain
   * later.
   */
  huntPermitDelay: 90, huntPermitFloor: .12, huntPermitRamp: 90,
  /**
   * A hunt that has run this long without a grab is broken off (it loses the scent, or its nerve): it withdraws, and for
   * huntCooldown seconds after any hunt ends (lost, broken off, timed out) it will not take one up again.
   */
  huntLimit: 20, huntCooldown: 90,
  /** Seconds of continuous sight before it commits to a hunt, when bold and when timid. */
  huntSight: 1, huntSightTimid: 2.4,
  /** After a death it is calm for a while (boldness scaled down); after losing a chase, briefly. */
  calmAfterDeath: 200, calmScale: .25, calmAfterLoss: 60, calmLossScale: .5,
  /** Developer "hunt" spawn: boldness 1 for this long. */
  provokeSeconds: 90,

  // --- Movement.
  roamSpeed: 1.8, roamFarSpeed: 4.5, roamFar: 110,
  investigateSpeed: 2.2, investigateUrgent: 4, investigateArrive: 4, investigateGiveUp: 40, searchSeconds: 4.5,
  /** Shadowing distance when timid and when bold (closer at night). */
  shadowFar: 28, shadowNear: 16, shadowMin: 10, shadowMaxSpeed: 5,
  /** Shadowing distance multipliers in full daylight and full dark: about 28 m by day, so it is there to be seen. */
  shadowDaylight: 1, shadowDark: .75,
  /** Roam waypoints near the player's area keep at least this far off when timid, this far when bold. */
  roamOffTimid: 75, roamOffBold: 45,
  /**
   * It does not follow the player about. After pacing them for paceBudget seconds (a number drawn afresh each time) it
   * either gets ahead of them (ambushChance, if they are walking somewhere) or goes away. Away, for the seconds given,
   * it roams elsewhere and only a noise of recallSalience or louder brings it back.
   */
  paceBudget: [8, 20], ambushChance: .55,
  awayAfterPace: [50, 100], awayAfterSearch: [45, 90], awayAfterHunt: [70, 120], awayAfterWithdraw: [35, 70], recallSalience: .55,
  /** The ambush: how far ahead on the player's way it waits, how wide it swings to get there, its pace, how long it waits, and how near they must come. */
  ambushAhead: 62, ambushWide: 40, ambushSpeed: 6.2, ambushWait: 55, ambushMeet: 24,
  // A sprinting player covers 3.35 m/s: it is still far faster, but a charge can now be seen coming and answered (the torch,
  // a door, the water). At 13.5 m/s it crossed its whole charge distance in under two seconds.
  huntApproach: 4.6, huntCharge: 8.5, huntChargeDistance: 20,
  /** It rears for this long when a hunt starts (and screeches) before it runs. */
  huntWindup: 1.2,
  /** Seconds of the player's velocity it leads them by. */
  huntLead: .45,
  withdrawSpeed: 6.5, withdrawDistance: 42, withdrawSeconds: 12,

  // --- The grab: metres from its head to the player's chest.
  grabReach: 2.2,

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
  /** For this long after a stun a timid creature prefers to withdraw. */
  stunShy: 6,
  /**
   * A hunt the torch has held may be broken off when it gets going again: the chance is this times how far it is
   * from its full hunting drive. Early in the night the light can save you; deep in it, it only buys a moment.
   */
  stunBreakOff: .9,
  /** How much of its hunting drive shields a hunt from being broken off by the torch: at full drive the chance is stunBreakOff x (1 - this). */
  stunBreakDrive: .25,

  // --- Being watched: seconds the player can stare before a timid / bold creature melts back.
  watchTolerance: 1.6, watchToleranceBold: 3.5,

  // --- Selector.
  decisionInterval: .2, hysteresis: .12, interruptMargin: .3,
};
export type CreatureTuning = typeof CREATURE_TUNING;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (v: number, a: number, b: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

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
// Senses, as plain functions so they can be checked on their own.

/** How clearly a noise is heard, 0 (not at all) to 1 (right beside it). Falls off linearly to loudness x range. */
export function hearingStrength(loudness: number, distance: number, tuning: CreatureTuning = CREATURE_TUNING) {
  const range = Math.max(0, loudness) * tuning.hearingRange;
  return range <= 0 ? 0 : clamp(1 - distance / range, 0, 1);
}

export type FootSurface = 'road' | 'dirt' | 'forest' | 'water';
/** Loudness of one footfall. A sprint on the gravel road carries ~45 m; a crouch on the forest floor ~3 m. */
export function footstepLoudness(o: { speed: number; sprinting: boolean; crouching: boolean; surface: FootSurface }) {
  if (o.speed < .2) return 0;
  const gait = o.crouching ? .04 : o.sprinting && o.speed > 2.2 ? .34 : .13 + clamp(o.speed - 1, 0, 1.5) * .03;
  const surface = o.surface === 'road' ? 1.35 : o.surface === 'water' ? 2 : o.surface === 'forest' ? .8 : 1;
  return gait * surface;
}
/** The torch switch: a small dry click, heard within a few metres. */
export const FLASHLIGHT_CLICK_LOUDNESS = .07;

/** How far it can see the player, before line of sight and its own field of view are considered. */
export function sightRange(o: { darkness: number; flashlightOn: boolean; crouching: boolean; sprinting: boolean; moving: boolean; indoors: boolean }, tuning: CreatureTuning = CREATURE_TUNING) {
  const dark = clamp(o.darkness, 0, 1);
  // The beam is what it sees at night, and the darker it is the more it stands out.
  let range = o.flashlightOn ? Math.max(lerp(tuning.sightDay, tuning.sightNight, dark), lerp(tuning.sightDay, tuning.sightBeacon, smoothstep(dark, .15, .7))) : lerp(tuning.sightDay, tuning.sightNight, dark);
  if (o.crouching) range *= tuning.sightCrouch;
  if (!o.moving) range *= tuning.sightStill;
  else if (o.sprinting) range *= tuning.sightSprint;
  if (o.indoors) range *= tuning.sightIndoors;
  return range;
}

/** How dark the hour is, as far as courage goes: nothing by day, rising through the evening, full after 23:00. */
export function nightness(hours: number) {
  const h = ((hours % 24) + 24) % 24;
  if (h >= 16) return smoothstep(h, 16.5, 23);
  if (h < 4.5) return 1;
  return 1 - smoothstep(h, 4.5, 7);
}

/** Courage before calm and provocation: mostly the hour, partly how long the evening has gone on. */
export function baseBoldness(hours: number, elapsed: number, tuning: CreatureTuning = CREATURE_TUNING) {
  return clamp(tuning.boldNight * nightness(hours) + tuning.boldElapsed * smoothstep(elapsed, tuning.boldElapsedFrom, tuning.boldElapsedTo), 0, 1);
}

// ------------------------------------------------------------------------------------------------------------
// Memory.

export type Sighting = { x: number; y: number; z: number; vx: number; vz: number; at: number };
/** Something worth going to look at: a heard noise, or where the player was last seen. */
export type Lead = { id: number; kind: 'sight' | 'sound'; source: string; x: number; z: number; y?: number; uncertainty: number; salience: number; at: number; investigated: boolean };

// ------------------------------------------------------------------------------------------------------------
// Behaviours.

/** A behaviour's own working notes (waypoints, timers, sweep angles): each behaviour keeps different things in it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Scratch = Record<string, any>;

export type BrainContext = {
  now: number; dt: number; random: () => number; tuning: CreatureTuning;
  input: BrainInput; self: Vec2 & { yaw: number };
  sees: boolean; sightTime: number;
  lastSeen?: Sighting; lastSeenAge: number;
  lead?: Lead; leadAge: number;
  boldness: number; huntDrive: number;
  /** Seconds the player has kept it on screen. */
  watched: number;
  flinching: boolean; sinceFlinch: number;
  dismissed: boolean;
  /** The torch broke its nerve: it gives up this hunt and withdraws. */
  shaken: boolean;
  /** The side (+1/-1) it shadows from; Withdraw flips it so it comes back from the other side. */
  flank: number;
  current: string; inCurrent: number;
  /** It has had enough of the player for now (a lost chase, a search that found nothing, a long look): it is off elsewhere. */
  away: boolean;
  /** Seconds it has spent pacing the player since it last went away, and how many it allows itself. */
  paced: number; paceBudget: number;
  /** A place ahead of the player it has decided to get to and wait at, by way of a point well off to one side. */
  ambush?: { via: Vec2; at: Vec2; from: Vec2; until: number; reached: boolean };
  /** Go away for a while (seconds), dropping what it was following. */
  leave(seconds: number): void;
  endAmbush(): void;
  /** True distance to the player. Only for pacing (how fast to travel while far); never for finding them. */
  distanceToPlayer: number;
  places: readonly Vec2[];
  /** Per-behaviour scratch state, cleared when the behaviour is entered. */
  state: Scratch;
  stateOf(id: string): Scratch;
  setFlank(side: number): void;
  clearDismissed(): void;
  emit(event: BrainEvent): void;
};

export type Behaviour = {
  id: string;
  /** Seconds it runs before a merely better option may replace it (a much better one interrupts at once). */
  commit: number;
  score(c: BrainContext): number;
  enter?(c: BrainContext): void;
  exit?(c: BrainContext): void;
  act(c: BrainContext): { intent: Intent; gaze?: Point };
};

const watchTolerance = (c: BrainContext) => lerp(c.tuning.watchTolerance, c.tuning.watchToleranceBold, c.boldness);
/** Where the player probably is now: what it sees, or the last sighting carried along their heading a little. */
function playerEstimate(c: BrainContext, lead = 0): Point | undefined {
  const p = c.input.player;
  if (c.sees) return { x: p.x + p.vx * lead, y: p.y + 1.5, z: p.z + p.vz * lead };
  const s = c.lastSeen; if (!s) return undefined;
  const t = Math.min(1.5, c.lastSeenAge + lead);
  return { x: s.x + s.vx * t, y: s.y + 1.5, z: s.z + s.vz * t };
}
const ahead = (from: Vec2 & { yaw: number }, to?: Vec2): Point => {
  if (!to || dist(from, to) < .5) return { x: from.x + Math.sin(from.yaw) * 10, z: from.z + Math.cos(from.yaw) * 10 };
  const d = dist(from, to); return { x: from.x + (to.x - from.x) / d * 10, z: from.z + (to.z - from.z) / d * 10 };
};

/** Patrols between the places the player needs, drifting toward where the player roughly is (a director's hint). */
export const roam: Behaviour = {
  id: 'roam', commit: 3,
  score: () => .2,
  act(c) {
    const s = c.state, t = c.tuning;
    // Having turned away from the player it picks somewhere new at once, well away from them.
    if (!s.waypoint || dist(c.self, s.waypoint) < 6 || c.now > s.until || s.away !== c.away) { s.away = c.away; s.waypoint = c.away ? pickFarWaypoint(c) : pickWaypoint(c); s.until = c.now + 40 + c.random() * 30; }
    return { intent: { target: s.waypoint, speed: c.distanceToPlayer > t.roamFar ? t.roamFarSpeed : t.roamSpeed, arrive: 3 }, gaze: ahead(c.self, s.waypoint) };
  },
};
function pickWaypoint(c: BrainContext): Vec2 {
  const p = c.input.player, r = c.random;
  // The hint is coarse: the player's area, not their position.
  const hint = { x: p.x + (r() - .5) * 40, z: p.z + (r() - .5) * 40 };
  if (!c.places.length || r() < .35 + .5 * c.boldness) {
    const a = r() * Math.PI * 2, d = lerp(c.tuning.roamOffTimid, c.tuning.roamOffBold, c.boldness) + r() * 35;
    return { x: hint.x + Math.sin(a) * d, z: hint.z + Math.cos(a) * d };
  }
  let total = 0; const weights = c.places.map(q => { const w = 1 / (1 + dist(q, hint) / 60) ** 2; total += w; return w; });
  let pick = r() * total, i = 0;
  while (i < weights.length - 1 && pick > weights[i]) pick -= weights[i++];
  const q = c.places[i], a = r() * Math.PI * 2, d = 4 + r() * 8;
  return { x: q.x + Math.sin(a) * d, z: q.z + Math.cos(a) * d };
}

/** Somewhere to be that is not where the player is: one of its places a good way off, or just off into the forest. */
function pickFarWaypoint(c: BrainContext): Vec2 {
  const p = c.input.player, r = c.random, far = c.places.filter(q => dist(q, p) > 110 && dist(q, p) < 320);
  if (far.length && r() < .7) { const q = far[Math.floor(r() * far.length)], a = r() * Math.PI * 2, d = 4 + r() * 10; return { x: q.x + Math.sin(a) * d, z: q.z + Math.cos(a) * d }; }
  // Onward the way it is already going from them, not back across them.
  const out = Math.atan2(c.self.x - p.x, c.self.z - p.z) + (r() - .5) * 1.6, d = 130 + r() * 70;
  return { x: p.x + Math.sin(out) * d, z: p.z + Math.cos(out) * d };
}

/** Goes to a noise or a last sighting, slowly, then stands and sweeps its head. */
export const investigate: Behaviour = {
  id: 'investigate', commit: 2,
  score(c) {
    // With the player in sight there is nothing to go and look for: shadowing, hunting or withdrawing decide.
    const lead = c.lead; if (!lead || lead.investigated || c.sees) return 0;
    const fresh = 1 - c.leadAge / c.tuning.leadMemory; if (fresh <= 0) return 0;
    // Gone off elsewhere, only a real noise brings it back: not the memory of where it last saw them.
    if (c.away && (lead.kind === 'sight' || lead.salience < c.tuning.recallSalience)) return 0;
    // A sighting is not worth walking to the moment it is lost: for a few seconds it paces them from memory.
    return (.3 + .45 * fresh * Math.min(1, lead.salience)) * (lead.kind === 'sight' ? smoothstep(c.leadAge, 1, 4) : 1);
  },
  act(c) {
    const lead = c.lead!, t = c.tuning, s = c.state;
    if (s.leadId !== lead.id) { s.leadId = lead.id; s.search = undefined; s.since = c.now; s.probe = undefined; }
    const goal: Vec2 = s.probe ?? lead;
    if (s.search === undefined && dist(c.self, goal) < t.investigateArrive) { s.search = c.now; s.sweep = c.self.yaw; }
    if (s.search !== undefined) {
      const searching = c.now - s.search;
      if (searching > t.searchSeconds) {
        // A vague noise gets one more look somewhere inside its uncertainty before it gives up.
        if (!s.probe && lead.uncertainty > 6) {
          const a = c.random() * Math.PI * 2, d = lead.uncertainty * (.4 + c.random() * .5);
          s.probe = { x: lead.x + Math.sin(a) * d, z: lead.z + Math.cos(a) * d }; s.search = undefined;
        } else {
          // It looked, they were not there: it loses interest and goes elsewhere. A player who hid has got away.
          lead.investigated = true; c.leave(t.awayAfterSearch[0] + c.random() * (t.awayAfterSearch[1] - t.awayAfterSearch[0]));
        }
      }
      const a = s.sweep + Math.sin(searching * 1.4) * 1.3;
      return { intent: { target: goal, speed: 0 }, gaze: { x: c.self.x + Math.sin(a) * 9, z: c.self.z + Math.cos(a) * 9 } };
    }
    if (c.now - s.since > t.investigateGiveUp) lead.investigated = true;
    const urgent = lead.kind === 'sight' || lead.salience > .6;
    const urgency = clamp(lead.salience, 0, 1) * (.4 + .6 * c.boldness);
    const speed = lerp(t.investigateSpeed, t.investigateUrgent, Math.max(urgency, urgent ? c.boldness : 0));
    return { intent: { target: goal, speed, arrive: 1.5 }, gaze: { x: goal.x, y: lead.y, z: goal.z } };
  },
};

/** Paces the player at the edge of the fog, off to one side; stops when they stop. */
export const shadow: Behaviour = {
  id: 'shadow', commit: 2,
  score(c) {
    if (c.input.player.untouchable) return 0;
    const t = c.tuning;
    if (!c.sees && !(c.lastSeen && c.lastSeenAge < t.shadowMemory)) return 0;
    // It does not trail the player all evening: a spell of pacing them, then it does something else (see `tick`). Gone
    // away it does not pace them at all, and a player who has gone indoors out of its sight is not paced round the walls.
    if (c.away || c.ambush || c.paced >= c.paceBudget || (c.input.player.indoors && !c.sees)) return 0;
    let s = .5 + .15 * (1 - c.huntDrive);
    if (!c.sees) s *= 1 - .5 * c.lastSeenAge / t.shadowMemory;
    if (c.watched > watchTolerance(c)) s -= .45;
    return s;
  },
  act(c) {
    const t = c.tuning, anchor = playerEstimate(c)!, p = c.input.player;
    // Further off in daylight, closer as the dark comes on: always about the edge of what can be seen.
    const range = lerp(t.shadowFar, t.shadowNear, c.boldness) * lerp(t.shadowDaylight, t.shadowDark, c.input.darkness);
    const vx = c.sees ? p.vx : c.lastSeen?.vx ?? 0, vz = c.sees ? p.vz : c.lastSeen?.vz ?? 0, playerSpeed = Math.hypot(vx, vz);
    // Walking, they are paced from beside and a little behind, on its flank. Standing, it holds its bearing and
    // only settles the distance, so it does not circle them.
    const angle = playerSpeed > .3 ? Math.atan2(vx, vz) + c.flank * 1.9
      : dist(c.self, anchor) < .01 ? c.self.yaw + Math.PI : Math.atan2(c.self.x - anchor.x, c.self.z - anchor.z);
    const target = { x: anchor.x + Math.sin(angle) * range, z: anchor.z + Math.cos(angle) * range }, gap = dist(c.self, target);
    // A little inside its distance is close enough to stand: walking away would turn its back on them.
    const settled = playerSpeed < .3 && (gap < 4 || (dist(c.self, anchor) < range && dist(c.self, anchor) > range - 7));
    const speed = settled ? 0 : clamp(playerSpeed * 1.1 + gap * .25, .6, t.shadowMaxSpeed);
    return { intent: { target, speed, arrive: 2 }, gaze: anchor };
  },
};

/** The run at the player: an approach, then a charge, toward where they will be. */
export const hunt: Behaviour = {
  id: 'hunt', commit: 2.5,
  score(c) {
    const t = c.tuning, p = c.input.player;
    if (p.untouchable || c.huntDrive <= 0) return 0;
    const need = lerp(t.huntSightTimid, t.huntSight, c.huntDrive);
    let s = 0;
    if (c.sees && (c.sightTime >= need || c.current === 'hunt')) s = .65 + .5 * c.huntDrive;
    else if (c.current === 'hunt' && c.lastSeen && c.lastSeenAge < t.huntPersist) s = .65 + .5 * c.huntDrive;
    if (p.indoors) s *= .3;
    return s;
  },
  enter(c) { c.state.started = c.now; c.emit({ type: 'hunt-started' }); },
  act(c) {
    const t = c.tuning, near = playerEstimate(c) ?? { x: c.input.player.x, z: c.input.player.z };
    c.state.started ??= c.now;
    const d = dist(c.self, near), target = playerEstimate(c, Math.min(1.2, t.huntLead + d / t.huntCharge * .5)) ?? near;
    const closing = 1 - smoothstep(d, t.huntChargeDistance * .25, t.huntChargeDistance * 1.6);
    const urgency = Math.max(c.huntDrive, clamp(Math.hypot(c.input.player.vx, c.input.player.vz) / 3.35, 0, 1));
    const speed = c.now - c.state.started < t.huntWindup ? 0 : lerp(t.huntApproach, t.huntCharge, closing * (.55 + .45 * urgency));
    return { intent: { target, speed, arrive: .5 }, gaze: near };
  },
};

/** The grab. The host plays it out; the brain holds here until it is told the player was taken or escaped. */
export const strike: Behaviour = {
  id: 'strike', commit: Infinity,
  score(c) {
    if (c.input.player.untouchable) return 0;
    if (c.current === 'strike') return 3;
    return c.current === 'hunt' && !c.flinching && c.input.reach < c.tuning.grabReach ? 3 : 0;
  },
  enter(c) { c.emit({ type: 'strike' }); },
  act(c) { return { intent: { speed: 0 }, gaze: playerEstimate(c) }; },
};

/**
 * Gets ahead of the player. Having watched which way they are walking it swings wide, out of sight, to a place on their
 * way, and stands there facing them until they walk up to it. It goes by what it last saw: a player who turns aside
 * is not met, and it gives up waiting.
 */
export const ambush: Behaviour = {
  id: 'ambush', commit: 3,
  score(c) {
    const plan = c.ambush; if (!plan || c.away || c.input.player.untouchable) return 0;
    // Met: from here it is a hunt, or a retreat. Never both waiting and seen up close.
    if (c.sees && dist(c.self, c.input.player) < c.tuning.ambushMeet) return 0;
    return c.now < plan.until ? .62 : 0;
  },
  exit(c) { if (c.ambush && (c.now >= c.ambush.until || (c.sees && dist(c.self, c.input.player) < c.tuning.ambushMeet))) c.endAmbush(); },
  act(c) {
    const plan = c.ambush!, t = c.tuning;
    if (c.now >= plan.until) { c.endAmbush(); c.leave(t.awayAfterSearch[0] + c.random() * (t.awayAfterSearch[1] - t.awayAfterSearch[0])); return { intent: { speed: 0 } }; }
    if (!plan.reached && dist(c.self, plan.via) < 8) plan.reached = true;
    const goal = plan.reached ? plan.at : plan.via, waiting = plan.reached && dist(c.self, plan.at) < 4;
    // Standing in their way it looks back along it, toward where they will come from.
    return { intent: { target: goal, speed: waiting ? 0 : t.ambushSpeed, arrive: 2.5 }, gaze: waiting ? { x: plan.from.x, y: 1.5, z: plan.from.z } : ahead(c.self, goal) };
  },
};

/** Breaks off and circles away; afterwards it returns from the other side. */
export const withdraw: Behaviour = {
  id: 'withdraw', commit: 4,
  score(c) {
    const t = c.tuning, s = c.stateOf('withdraw'), running = c.current === 'withdraw';
    if (running && s.done) return 0;
    if (c.dismissed || c.shaken) return 1.5;
    if (running) return .8;
    let score = 0;
    if (c.sinceFlinch < t.stunShy) score = Math.max(score, .8 * (1 - .6 * c.boldness));
    if (c.current !== 'hunt' && c.huntDrive < .45 && c.watched > watchTolerance(c)) score = Math.max(score, .75);
    if (c.current !== 'hunt' && c.huntDrive < .45 && c.lastSeen && c.lastSeenAge < 3 && dist(c.self, c.lastSeen) < t.shadowMin) score = Math.max(score, .72);
    return score;
  },
  enter(c) { const s = c.state, t = c.tuning; s.side = c.random() < .5 ? -1 : 1; s.until = c.now + t.withdrawSeconds * (.7 + c.random() * .5); s.done = false; },
  exit(c) { c.setFlank(-c.stateOf('withdraw').side || 1); c.clearDismissed(); if (!c.sees) c.leave(c.tuning.awayAfterWithdraw[0] + c.random() * (c.tuning.awayAfterWithdraw[1] - c.tuning.awayAfterWithdraw[0])); },
  act(c) {
    const s = c.state, t = c.tuning, p = c.input.player;
    if (s.side === undefined) withdraw.enter!(c);
    // It knows what it is backing away from, even when it has lost sight of them.
    const anchor: Point = playerEstimate(c) ?? { x: p.x, y: p.y + 1.5, z: p.z };
    const d = dist(c.self, anchor);
    // One bearing, chosen as it turns away: out and round to one side, not a spiral.
    s.angle ??= (d < .01 ? c.self.yaw + Math.PI : Math.atan2(c.self.x - anchor.x, c.self.z - anchor.z)) + s.side * .6;
    const target = { x: anchor.x + Math.sin(s.angle) * t.withdrawDistance, z: anchor.z + Math.cos(s.angle) * t.withdrawDistance };
    if ((d > t.withdrawDistance - 6 && !c.input.playerLooking) || c.now > s.until) s.done = true;
    const pressure = 1 - smoothstep(d, 7, t.withdrawDistance);
    return { intent: { target, speed: s.done ? 0 : lerp(t.roamSpeed * 1.4, t.withdrawSpeed, pressure), arrive: 3 }, gaze: anchor };
  },
};

/** Stage 1's repertoire. Stage 2 adds entries here (or passes its own list); the selector needs no change. */
export const STAGE_ONE_BEHAVIOURS: readonly Behaviour[] = [roam, investigate, shadow, ambush, hunt, strike, withdraw];

// ------------------------------------------------------------------------------------------------------------

export type CreatureBrainOptions = {
  random: () => number;
  /** Places worth patrolling between (the cabin, the relay, the mine...). */
  places?: readonly Vec2[];
  tuning?: Partial<CreatureTuning>;
  behaviours?: readonly Behaviour[];
};

export function createCreatureBrain(options: CreatureBrainOptions) {
  const tuning: CreatureTuning = { ...CREATURE_TUNING, ...options.tuning };
  const behaviours = options.behaviours ?? STAGE_ONE_BEHAVIOURS, byId = new Map(behaviours.map(b => [b.id, b]));
  const random = options.random, places = options.places ?? [];
  const heard: NoiseEvent[] = [];

  let now = 0, current = behaviours[0].id, enteredAt = 0, decideIn = 0, states: Record<string, Scratch> = {};
  let exposure = 0, sees = false, sightTime = 0, watched = 0, lastSeen: Sighting | undefined, lead: Lead | undefined, leadIds = 0;
  // The stun: its phase and how long it has been in it, how long the held phase lasts this time, when a beam that has
  // left its face lets it go, how many uses have worn it down, and the pace it was slowing from.
  let stunPhase: StunPhase = 'none', stunT = 0, stunHeldFor = 0, stunRelease = Infinity, stunSpent = 0, stunFrom = 0, outOfBeam = 0, beamTime = 0, flinchEnded = -Infinity;
  let calmUntil = -Infinity, calmScale = 1, provokedUntil = -Infinity, dismissed = false, shaken = false, flank = 1, huntAllowed = true, huntAllowedAt = -Infinity, huntCooldownUntil = -Infinity;
  let awayUntil = -Infinity, paced = 0, paceBudget = (tuning.paceBudget[0] + tuning.paceBudget[1]) / 2, ambushPlan: BrainContext['ambush'];
  const between = (range: readonly number[]) => range[0] + random() * (range[1] - range[0]);
  /** Off elsewhere for a while: nothing it was following is kept, and its next spell of pacing them is drawn afresh. */
  const leave = (seconds: number) => { awayUntil = Math.max(awayUntil, now + seconds); paced = 0; paceBudget = between(tuning.paceBudget); ambushPlan = undefined; if (lead && lead.kind === 'sight') lead.investigated = true; decideIn = 0; };
  let scores: Record<string, number> = {}, last: BrainOutput | undefined, lastInput: BrainInput | undefined, boldness = 0, huntDrive = 0, creature = { x: 0, z: 0, yaw: 0 };

  const stateOf = (id: string) => (states[id] ??= {});
  const forget = () => { lastSeen = undefined; lead = undefined; exposure = 0; sees = false; sightTime = 0; watched = 0; heard.length = 0; };

  function listen(input: BrainInput, events: BrainEvent[]) {
    for (const noise of heard.splice(0)) {
      if (!Number.isFinite(noise.x) || !Number.isFinite(noise.z)) continue;
      const d = dist(input.creature, noise), strength = hearingStrength(noise.loudness, d, tuning);
      if (strength <= 0) continue;
      events.push({ type: 'heard', source: noise.source, strength });
      const salience = Math.min(1.2, strength + noise.loudness * .5);
      // What it is already following, worth less as it ages. A sighting goes stale fastest (the player moves on),
      // which is what lets the generator or the radio pull it away from where it lost them.
      const held = lead && !lead.investigated ? lead.salience * Math.max(0, 1 - (now - lead.at) / (lead.kind === 'sight' ? tuning.sightLeadFade : tuning.leadMemory)) : 0;
      if (held > 0 && salience < held * .8) continue;
      const error = tuning.hearingError + d * tuning.hearingErrorPerMetre + (1 - strength) * tuning.hearingErrorFaint;
      const a = random() * Math.PI * 2, r = Math.sqrt(random()) * error;
      lead = { id: ++leadIds, kind: 'sound', source: noise.source, x: noise.x + Math.sin(a) * r, z: noise.z + Math.cos(a) * r, uncertainty: error, salience, at: now, investigated: false };
    }
  }

  function look(input: BrainInput, events: BrainEvent[]) {
    const p = input.player, dt = input.dt;
    const moving = Math.hypot(p.vx, p.vz) > .3;
    let range = sightRange({ darkness: input.darkness, flashlightOn: p.flashlightOn, crouching: p.crouching, sprinting: p.sprinting, moving, indoors: p.indoors }, tuning);
    const dx = p.x - input.creature.x, dz = p.z - input.creature.z, d = Math.hypot(dx, dz);
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dx, dz) - input.creature.yaw), Math.cos(Math.atan2(dx, dz) - input.creature.yaw)));
    if (off > tuning.sightFov) range *= tuning.sightBehind;
    // Provoked (the developer hunt), it knows where the player is wherever they hide.
    const told = now < provokedUntil;
    const visible = !p.untouchable && (told || (input.lineOfSight && d < range) || d < tuning.touchRange);
    if (told && visible) exposure = Math.max(exposure, 1);
    if (visible) exposure = Math.min(1.5, exposure + dt / lerp(tuning.recogniseNear, tuning.recogniseFar, clamp(d / range, 0, 1) ** 2));
    else exposure = Math.max(0, exposure - dt * tuning.forgetRate);
    const was = sees;
    sees = visible && exposure >= 1;
    if (sees && !was) events.push({ type: 'spotted' });
    if (sees) {
      sightTime += dt;
      lastSeen = { x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz, at: now };
      if (!lead || lead.kind !== 'sight' || lead.investigated) lead = { id: ++leadIds, kind: 'sight', source: 'sight', x: p.x, y: p.y + 1.5, z: p.z, uncertainty: 1, salience: 1.2, at: now, investigated: false };
      else { lead.x = p.x; lead.y = p.y + 1.5; lead.z = p.z; lead.at = now; }
    } else sightTime = Math.max(0, sightTime - dt * .5);
    watched = input.playerLooking && !p.untouchable ? watched + dt : Math.max(0, watched - dt * 2);
  }

  const stunning = () => stunPhase === 'slowing' || stunPhase === 'held';
  /**
   * The torch. Pinned for stunPin, it slows to a halt over stunSlow, is held (shorter each use, never less than the
   * last entry), and gets going again over stunStart. The beam must stay on it while it is held. Out of the beam
   * it gets its nerve back, a step at a time.
   */
  function stun(input: BrainInput, events: BrainEvent[]) {
    const dt = input.dt, held = tuning.stunHeld;
    if (stunPhase === 'none') {
      if (input.beamOnIt) outOfBeam = 0;
      else if (stunSpent > 0 && (outOfBeam += dt) >= tuning.stunRecharge / Math.max(1, held.length - 1)) { stunSpent--; outOfBeam = 0; }
      if (input.beamOnIt && !input.player.untouchable && current !== 'strike' && now - flinchEnded >= tuning.stunGrace) {
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
        if (current === 'hunt' && now >= provokedUntil && random() < tuning.stunBreakOff * (1 - tuning.stunBreakDrive * huntDrive)) { shaken = true; decideIn = 0; }
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
  /** How much of its hunting drive the host allows: none while withheld, then rising from huntPermitFloor. */
  const huntPermit = () => !huntAllowed || now - huntAllowedAt < tuning.huntPermitDelay ? 0 : lerp(tuning.huntPermitFloor, 1, smoothstep(now - huntAllowedAt - tuning.huntPermitDelay, 0, tuning.huntPermitRamp));

  function context(input: BrainInput, events: BrainEvent[], id: string): BrainContext {
    return {
      now, dt: input.dt, random, tuning, input, self: input.creature,
      sees, sightTime, lastSeen, lastSeenAge: lastSeen ? now - lastSeen.at : Infinity,
      lead, leadAge: lead ? now - lead.at : Infinity,
      boldness, huntDrive, watched,
      flinching: stunning(), sinceFlinch: stunning() ? 0 : now - flinchEnded,
      dismissed, shaken, flank, current, inCurrent: now - enteredAt,
      away: now < awayUntil, paced, paceBudget, ambush: ambushPlan, leave, endAmbush: () => { ambushPlan = undefined; },
      distanceToPlayer: dist(input.creature, input.player), places,
      state: stateOf(id), stateOf,
      setFlank: side => { flank = side; }, clearDismissed: () => { dismissed = false; shaken = false; },
      emit: e => events.push(e),
    };
  }

  function switchTo(id: string, input: BrainInput, events: BrainEvent[]) {
    const from = current;
    byId.get(from)?.exit?.(context(input, events, from));
    if (from === 'hunt' && id !== 'strike') { huntCooldownUntil = now + tuning.huntCooldown; if (!sees || shaken) leave(between(tuning.awayAfterHunt)); }
    if ((from === 'hunt' && id !== 'strike') || (from === 'shadow' && (id === 'investigate' || id === 'roam'))) {
      if (!sees) {
        events.push({ type: 'lost-player', from });
        // A lost chase takes the edge off for a while, unless it is already calmer than that (after a death).
        if (from === 'hunt' && !(now < calmUntil && calmScale <= tuning.calmLossScale)) { calmUntil = now + tuning.calmAfterLoss; calmScale = tuning.calmLossScale; }
      }
    }
    current = id; enteredAt = now; states[id] = {};
    byId.get(id)!.enter?.(context(input, events, id));
    events.push({ type: 'behaviour', from, to: id });
  }

  function decide(input: BrainInput, events: BrainEvent[]) {
    let best = current, bestScore = -Infinity;
    scores = {};
    for (const b of behaviours) {
      const s = b.score(context(input, events, b.id)) + (b.id === current ? tuning.hysteresis : 0);
      scores[b.id] = s;
      if (s > bestScore) { bestScore = s; best = b.id; }
    }
    if (best === current) return;
    const running = byId.get(current)!, held = scores[current] ?? -Infinity;
    if (now - enteredAt < running.commit && bestScore < held + tuning.interruptMargin) return;
    switchTo(best, input, events);
  }

  return {
    get tuning() { return tuning; },
    get behaviour() { return current; },
    /** Queue a noise; it is heard (or not) from wherever the creature is on the next tick. */
    hear(noise: NoiseEvent) { heard.push({ loudness: noise.loudness, source: noise.source, x: noise.x, z: noise.z }); if (heard.length > 64) heard.shift(); },
    tick(input: BrainInput): BrainOutput {
      const dt = Math.max(0, Math.min(input.dt, .25)), events: BrainEvent[] = [];
      input = dt === input.dt ? input : { ...input, dt };
      now += dt; creature = { ...input.creature }; lastInput = input;
      const calm = now < calmUntil ? calmScale : 1, provoked = now < provokedUntil;
      const pressure = tuning.pressureBoldness * smoothstep(now, tuning.pressureFrom, tuning.pressureFull);
      boldness = provoked ? 1 : Math.max(baseBoldness(input.hours, now, tuning), pressure) * calm;
      huntDrive = provoked ? 1 : now < huntCooldownUntil ? 0 : smoothstep(boldness, tuning.huntBoldnessMin, tuning.huntBoldnessFull) * huntPermit();
      listen(input, events);
      look(input, events);
      stun(input, events);
      // A hunt that has gone on too long is given up: it withdraws, and the cooldown (set as it ends) keeps it from starting another straight away.
      if (current === 'hunt' && !shaken && now >= provokedUntil && now - enteredAt > tuning.huntLimit && !stunning()) { shaken = true; decideIn = 0; }
      // A loud noise calls it back from wherever it had gone.
      if (now < awayUntil && lead && !lead.investigated && lead.kind === 'sound' && lead.salience >= tuning.recallSalience && lead.at > awayUntil - 400 && now - lead.at < 1) awayUntil = now;
      // Its spell of pacing the player runs out: it gets ahead of them if they are going somewhere, or it goes away.
      if (current === 'shadow') {
        paced += dt;
        if (paced >= paceBudget && !stunning()) {
          const seen = lastSeen, pace = seen ? Math.hypot(seen.vx, seen.vz) : 0;
          if (seen && pace > .8 && !input.player.indoors && random() < tuning.ambushChance) {
            const hx = seen.vx / pace, hz = seen.vz / pace, side = flank || 1, reach = tuning.ambushAhead + pace * 14;
            ambushPlan = {
              from: { x: seen.x, z: seen.z },
              via: { x: seen.x + hx * reach * .45 + hz * side * tuning.ambushWide, z: seen.z + hz * reach * .45 - hx * side * tuning.ambushWide },
              at: { x: seen.x + hx * reach, z: seen.z + hz * reach }, until: now + tuning.ambushWait, reached: false,
            };
            events.push({ type: 'ambush' }); decideIn = 0;
          } else leave(between(tuning.awayAfterPace));
        }
      }
      decideIn -= dt;
      // A grab cannot wait for the next decision tick.
      const reachable = current === 'hunt' && input.reach < tuning.grabReach;
      if (decideIn <= 0 || reachable) { decideIn = tuning.decisionInterval; decide(input, events); }
      const ctx = context(input, events, current), action = byId.get(current)!.act(ctx);
      const flinching = stunning(), shaped = stunned(action.intent);
      const intent = shaped.intent;
      let gaze = action.gaze;
      if (flinching) {
        // Pinned by the beam: its face turns aside from the light.
        const p = input.player, ax = input.creature.x - p.x, az = input.creature.z - p.z, l = Math.hypot(ax, az) || 1;
        gaze = { x: input.creature.x + (-az / l) * 6 * flank + ax / l * 3, y: p.y + 4, z: input.creature.z + (ax / l) * 6 * flank + az / l * 3 };
      }
      last = { behaviour: current, intent, gaze, events, flinching, stun: shaped.stun, sees, boldness };
      return last;
    },
    /** No hunting (the host's scripted opening owns the creature) until permitHunting. */
    holdHunting() { huntAllowed = false; },
    /** Hunting allowed again: rare at first, its full drive after huntPermitRamp (or at once, with ramp false). */
    permitHunting(ramp = true) { huntAllowed = true; huntAllowedAt = ramp ? now : -Infinity; },
    /** The player was taken and woke elsewhere: forget them and stay calm for a while. */
    struck() {
      forget(); beamTime = 0; stunPhase = 'none'; stunT = 0;
      calmUntil = now + tuning.calmAfterDeath; calmScale = tuning.calmScale; provokedUntil = -Infinity; dismissed = false; huntCooldownUntil = -Infinity;
      awayUntil = now + between(tuning.awayAfterHunt); paced = 0; ambushPlan = undefined;
      current = 'roam'; enteredAt = now; states = {}; decideIn = 0;
    },
    /** The host moved the body (a spawn or relocation): drop half-finished plans, keep what it knows. */
    relocated() { states = {}; decideIn = 0; },
    /** Developer dismiss: break off, forget the player, and stay calm for a while. */
    dismiss() { dismissed = true; provokedUntil = -Infinity; calmUntil = now + tuning.calmAfterDeath; calmScale = tuning.calmScale; decideIn = 0; forget(); },
    /** Everything it knew about the player and the noises it heard, gone. */
    forget,
    /** Developer hunt: full courage, and it knows exactly where the player is. */
    provoke(player: PlayerPercept) {
      provokedUntil = now + tuning.provokeSeconds; calmUntil = -Infinity; dismissed = false; awayUntil = -Infinity; paced = 0;
      lastSeen = { x: player.x, y: player.y, z: player.z, vx: 0, vz: 0, at: now };
      exposure = 1; sightTime = tuning.huntSightTimid;
      lead = { id: ++leadIds, kind: 'sight', source: 'sight', x: player.x, y: player.y + 1.5, z: player.z, uncertainty: 1, salience: 1.2, at: now, investigated: false };
      decideIn = 0;
    },
    /** Give it something to investigate (a developer "natural" spawn hands it the player's rough position). */
    alert(at: Vec2, uncertainty = 8) {
      awayUntil = -Infinity;
      lead = { id: ++leadIds, kind: 'sound', source: 'alert', x: at.x, z: at.z, uncertainty, salience: .8, at: now, investigated: false };
      decideIn = 0;
    },
    /** Run a behaviour now, whatever the scores say (hosts and tests). */
    force(id: string, input = lastInput) {
      if (!byId.has(id)) throw new Error(`Unknown creature behaviour "${id}"`);
      if (input) switchTo(id, input, []);
      else { current = id; enteredAt = now; states[id] = {}; }
      decideIn = tuning.decisionInterval;
    },
    /** A new night: everything forgotten, courage back to the start of the evening. */
    reset() {
      now = 0; current = behaviours[0].id; enteredAt = 0; decideIn = 0; states = {}; heard.length = 0;
      exposure = 0; sees = false; sightTime = 0; watched = 0; lastSeen = undefined; lead = undefined;
      stunPhase = 'none'; stunT = stunHeldFor = stunSpent = stunFrom = outOfBeam = beamTime = 0; stunRelease = Infinity; flinchEnded = -Infinity;
      calmUntil = provokedUntil = -Infinity; calmScale = 1; dismissed = shaken = false; flank = 1; scores = {}; last = undefined;
      huntAllowed = true; huntAllowedAt = -Infinity; huntCooldownUntil = -Infinity;
      awayUntil = -Infinity; paced = 0; ambushPlan = undefined;
    },
    inspect() {
      return {
        clock: now, behaviour: current, inBehaviour: now - enteredAt, scores: { ...scores }, boldness, huntDrive, huntPermit: huntPermit(),
        sees, exposure, sightTime, watched, creature: { ...creature },
        lastSeen: lastSeen && { ...lastSeen, age: now - lastSeen.at }, lead: lead && { ...lead, age: now - lead.at },
        flinch: { active: stunning(), phase: stunPhase, inPhase: stunT, held: stunHeldFor, spent: stunSpent, nextHeld: tuning.stunHeld[Math.min(stunSpent, tuning.stunHeld.length - 1)], outOfBeam },
        away: Math.max(0, awayUntil - now), paced, paceBudget, ambush: ambushPlan && { ...ambushPlan },
        calm: Math.max(0, calmUntil - now), cooldown: Math.max(0, huntCooldownUntil - now), provoked: Math.max(0, provokedUntil - now), dismissed, shaken, flank,
        intent: last?.intent,
      };
    },
  };
}
export type CreatureBrain = ReturnType<typeof createCreatureBrain>;
