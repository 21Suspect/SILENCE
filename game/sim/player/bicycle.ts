/**
 * The bicycle's rules (docs/game-design.md, "The whole island, and getting across it"). Pure: no world, no renderer. The engine
 * (wave 2) feeds it the key state and the ground under the wheels (surfaceAt in game/sim/world/surface.ts), moves the player by
 * the `speed` and `heading` it returns, and emits the `noise` it returns on the noise stream.
 *
 * In plain words:
 *  - Three times walking speed on roads and paths (5.4 m/s, from the stamina model's 1.8), slow off them (2.2 m/s on forest, dirt
 *    and beach: about a walk, so leaving the track is a cost, not a stop). No riding in water: wheeling into it forces a dismount.
 *  - Speed eases: 2 m/s^2 from a push, 1.2 m/s^2 of coasting drag, 6 m/s^2 more under full brake (5.4 to 0 in under a second);
 *    coming off the road onto rough ground sheds the extra at 5 m/s^2 rather than snapping to the slow speed.
 *  - Steering turns slowly at speed (2.2 rad/s at a crawl, 0.6 rad/s at 5.4 m/s) and not at all standing still.
 *  - No sprint, crouch or jump while riding.
 *  - Noise: a repeating noise once a second while rolling: NOISE.bicyclePath (7 m) on road and path, NOISE.bicycleRough (45 m) off
 *    them. Loaded, the rack rattles: NOISE.loadedBicyclePath (25 m, "instead of 8") on road and path; off them the wheels' 45 m
 *    already drowns the rattle (NOISE.rattle is 25 m), so the louder of the two is used. The bell is NOISE.bell (70 m), one ring
 *    per press, 1.5 s apart (a ring that is still sounding cannot be rung over).
 *  - A heavy part strapped to the rack slows the bicycle to x0.8.
 *  - The bicycle does not move itself: the engine owns the position (collision, terrain). It tells the bicycle where it is with
 *    `place`, and `home()` puts it back at the cabin when the player wakes by the bed.
 */
import { STAMINA } from './stamina';
import { NOISE } from '../noise/noise-scale';
import type { Surface } from '../world/surface';

export type BicycleTuning = {
  /** Top speed (m/s) on road and path, and off them. */
  roadSpeed: number;
  roughSpeed: number;
  /** Speed multiplier with a heavy part strapped on. */
  loadedFactor: number;
  accel: number; coastDrag: number; brakeDecel: number; excessDecel: number;
  /** Turn rate (rad/s) at a crawl; the rate is turnRate / (1 + speed * turnSlowing). */
  turnRate: number; turnSlowing: number;
  /** Speed (m/s) at which steering is fully effective; below it the turn is scaled down to nothing at a standstill. */
  steerSpeed: number;
  /** Below this (m/s) the bicycle is standing, and makes no noise. */
  movingSpeed: number;
  /** Seconds between the repeats of the rolling noise, and between bell rings. */
  rollInterval: number; bellCooldown: number;
  /** How close (m) the player must be to mount. */
  reach: number;
};

export const BICYCLE: Readonly<BicycleTuning> = {
  roadSpeed: 3 * STAMINA.walkSpeed,
  roughSpeed: 2.2,
  loadedFactor: .8,
  accel: 2, coastDrag: 1.2, brakeDecel: 6, excessDecel: 5,
  turnRate: 2.2, turnSlowing: .49,
  steerSpeed: .8,
  movingSpeed: .5,
  rollInterval: 1, bellCooldown: 1.5,
  reach: 2,
};

export type BicycleInput = { throttle: number; brake: number; steer: number };
export type BicycleEvent = 'dismounted-water' | 'started' | 'stopped';
export type BicycleResult = {
  mounted: boolean;
  /** m/s along `heading`, never negative. */
  speed: number;
  /** Radians. A positive steer raises it; the caller maps it onto the player's yaw. */
  heading: number;
  /** The loudness to emit this frame (a noise event's `loudness`), or 0: the rolling noise on its once-a-second frame. */
  noise: number;
  /** The loudness of the rolling now, continuously (0 when standing), for anything that wants to show or compare it. */
  loudness: number;
  events: BicycleEvent[];
};
export type RideAction = 'sprint' | 'crouch' | 'jump';
export type Point = { x: number; z: number };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const MAX_STEP = .1;
const onTrack = (s: Surface) => s === 'road' || s === 'path';

export function createBicycle(home: Point, tuning: BicycleTuning = BICYCLE) {
  let mounted = false, speed = 0, heading = 0, rollTimer = 0, bellWait = 0, load: string | null = null;
  const pos = { x: home.x, z: home.z };
  const homePos = { x: home.x, z: home.z };
  const topSpeed = (surface: Surface) => (onTrack(surface) ? tuning.roadSpeed : tuning.roughSpeed) * (load ? tuning.loadedFactor : 1);
  const rolling = (surface: Surface) => {
    if (!mounted || speed < tuning.movingSpeed) return 0;
    if (onTrack(surface)) return load ? NOISE.loadedBicyclePath : NOISE.bicyclePath;
    return load ? Math.max(NOISE.bicycleRough, NOISE.rattle) : NOISE.bicycleRough;
  };
  const self = {
    /** Whether the player, standing at `at`, may get on: within reach, not in water, not on a ladder, not already riding. */
    canMount(at: Point, surface: Surface, onLadder = false) {
      return !mounted && !onLadder && surface !== 'water' && Math.hypot(at.x - pos.x, at.z - pos.z) <= tuning.reach;
    },
    /** Get on if allowed; the bicycle takes the player's place and facing. */
    mount(at: Point, surface: Surface, yaw: number, onLadder = false) {
      if (!self.canMount(at, surface, onLadder)) return false;
      mounted = true; speed = 0; heading = yaw; rollTimer = 0; pos.x = at.x; pos.z = at.z;
      return true;
    },
    /** Dismounting is always allowed, even at speed (the engine decides what a fall costs); the bicycle stays where it stands. */
    canDismount() { return mounted; },
    dismount() { if (!mounted) return false; mounted = false; speed = 0; return true; },
    /** What the player may do now: no sprint, crouch or jump on a bicycle; everything on foot. */
    allows(action: RideAction) { return !mounted && action.length > 0; },
    get mounted() { return mounted; },
    /** The engine's own position of the bicycle (it follows the player while ridden). */
    place(x: number, z: number) { pos.x = x; pos.z = z; },
    get position(): Readonly<Point> { return pos; },
    /** Waking by the bed: the bicycle is back at the cabin, unmounted, unloaded and standing. */
    home(): Readonly<Point> {
      pos.x = homePos.x; pos.z = homePos.z; mounted = false; speed = 0; load = null; rollTimer = 0; bellWait = 0;
      return homePos;
    },
    /** Move the cabin spot (the caller knows where the cabin is). */
    setHome(x: number, z: number) { homePos.x = x; homePos.z = z; },
    /** The engine found the way blocked (a wall, a trunk): the bicycle cannot be going faster than it actually moved. */
    limitSpeed(v: number) { if (speed > v) speed = Math.max(0, v); },
    get speed() { return speed; },
    get heading() { return heading; },
    /** Strap a heavy part (any label) to the rack: slower and it rattles. One at a time; false if the rack is taken. */
    strap(kind: string) { if (load) return false; load = kind; return true; },
    /** Take the part off; returns its label, or null. */
    unstrap() { const k = load; load = null; return k; },
    get loadKind() { return load; },
    /** One press of the bell: its loudness, or 0 while the last ring is still sounding. It works standing or riding. */
    ring() { if (bellWait > 0) return 0; bellWait = tuning.bellCooldown; return NOISE.bell; },
    /** Advance by `dt` seconds on the ground `surface`. Off the bicycle, only the bell's cooldown runs. */
    update(dt: number, input: BicycleInput, surface: Surface): BicycleResult {
      const events: BicycleEvent[] = [];
      if (!(dt > 0)) return { mounted, speed, heading, noise: 0, loudness: rolling(surface), events };
      dt = Math.min(dt, MAX_STEP);
      bellWait = Math.max(0, bellWait - dt);
      if (!mounted) return { mounted, speed: 0, heading, noise: 0, loudness: 0, events };
      if (surface === 'water') {
        mounted = false; speed = 0; rollTimer = 0;
        return { mounted, speed, heading, noise: 0, loudness: 0, events: ['dismounted-water'] };
      }
      const before = speed, cap = topSpeed(surface);
      const throttle = clamp(input.throttle, 0, 1), brake = clamp(input.brake, 0, 1), steer = clamp(input.steer, -1, 1);
      // The brake overrides the throttle. Over the cap with the pedals turning (road to forest) sheds the excess hard.
      const target = brake > 0 ? 0 : cap * throttle;
      if (speed < target) speed = Math.min(target, speed + tuning.accel * dt);
      else speed = Math.max(target, speed - ((speed > cap && throttle > 0 ? tuning.excessDecel : tuning.coastDrag) + brake * tuning.brakeDecel) * dt);
      const grip = clamp(speed / tuning.steerSpeed, 0, 1);
      heading += steer * grip * (tuning.turnRate / (1 + speed * tuning.turnSlowing)) * dt;
      const loudness = rolling(surface);
      let noise = 0;
      if (loudness > 0) {
        rollTimer += dt;
        if (rollTimer >= tuning.rollInterval) { rollTimer -= tuning.rollInterval; noise = loudness; }
      } else rollTimer = 0;
      if (before < tuning.movingSpeed && speed >= tuning.movingSpeed) events.push('started');
      if (before >= tuning.movingSpeed && speed < tuning.movingSpeed) events.push('stopped');
      return { mounted, speed, heading, noise, loudness, events };
    },
  };
  return self;
}

export type Bicycle = ReturnType<typeof createBicycle>;
