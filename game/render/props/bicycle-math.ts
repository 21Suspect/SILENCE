/**
 * The bicycle's moving parts, as plain numbers (no three.js, so tests/render/props/bicycle-math.test.mjs can pin them): how far the
 * wheels and cranks have turned, how far the bars turn, how far the whole bike leans, and how it sits on uneven ground.
 * Angles are radians. A positive steer, yaw rate or lean is to the bike's LEFT (the side a positive heading turns toward).
 */
export const BIKE = {
  /** The tyre's outside radius (m): a wheel turns distance / radius. */
  wheelRadius: .355,
  /** A 46-tooth ring on an 18-tooth sprocket: the cranks turn once for every 2.56 turns of the rear wheel. */
  gear: 46 / 18,
  /** The bars turn this far (rad) at a crawl: 35 degrees. */
  maxSteer: 35 * Math.PI / 180,
  /** How fast the lock closes with speed: the limit is maxSteer / (1 + speed * steerSlowing), 12 degrees at 5.4 m/s. */
  steerSlowing: .37,
  /** The most the bike leans (25 degrees). */
  maxLean: 25 * Math.PI / 180,
  gravity: 9.81,
  /** Axle to axle (m), from the model's hooks (rear_axle z -0.56, front_axle z 0.56). */
  wheelbase: 1.12,
};

/** How far a wheel of the tyre's radius turns (rad) while the bike rolls `distance` metres. */
export const wheelTurn = (distance: number, radius = BIKE.wheelRadius) => distance / radius;
/** The cranks' angle for a rear wheel at `wheelAngle`: slower than the wheel, by the gearing. */
export const crankTurn = (wheelAngle: number, gear = BIKE.gear) => wheelAngle / gear;

/** The most the bars may turn at this speed (rad): 35 degrees standing, less the faster it goes. */
export const steerLimit = (speed: number) => BIKE.maxSteer / (1 + Math.max(0, speed) * BIKE.steerSlowing);
/** The bars' angle (rad) for a steering input in -1..1 at this speed. */
export const steerAngle = (input: number, speed: number) => Math.max(-1, Math.min(1, input)) * steerLimit(speed);

/** The lean (rad) that balances a turn: atan(v * yawRate / g), clamped to 25 degrees. Zero standing still or going straight. */
export function leanFor(speed: number, yawRate: number) {
  const angle = Math.atan(Math.max(0, speed) * yawRate / BIKE.gravity);
  return Math.max(-BIKE.maxLean, Math.min(BIKE.maxLean, angle));
}

/** A frame-rate independent ease of `value` toward `target` at `rate` per second. */
export const ease = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));

/** Shortest signed difference between two angles. */
export const angleDelta = (to: number, from: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** The bike on the ground: the nose-up pitch (rad) and the height of the point midway between the wheels' contacts. */
export function frameOnGround(rearGround: number, frontGround: number, wheelbase = BIKE.wheelbase) {
  return { pitch: Math.atan2(frontGround - rearGround, wheelbase), height: (rearGround + frontGround) / 2 };
}
