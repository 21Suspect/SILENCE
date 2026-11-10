/**
 * Ladders as a pure, deterministic per-player state machine: no three.js, no DOM, no clock, no
 * randomness. The same attach() and the same update() calls always give the same poses, rungs and
 * camera bob, so a host can replay a climb for every client. The engine owns input, collision and
 * sound; this only says where the climber is.
 *
 * A ladder is the line from `bottom` to `top` (world metres, y up). `exit` is where the player
 * stands after topping out. The climber's body hangs a little in front of the line, on the side
 * away from the structure, and moves along it at LADDER_SPEED. There is no gravity and no strafing
 * while attached, and nothing is collided with: the ladder's own rails, plinth and platform edge
 * must not stop the person on it.
 */
export type Vec3 = { x: number; y: number; z: number };
export type Ladder = { id: string; bottom: Vec3; top: Vec3; exit: Vec3; width: number };

/** Metres a second along the line, W or S held. There is no sprint on a ladder. */
export const LADDER_SPEED = 1.5;
/** Rung spacing. One knock, one camera dip, one noise event for every rung passed. */
export const LADDER_RUNG = .3;
/** How near the line (to the feet) the player has to be for the prompt to be offered. */
export const LADDER_REACH = 1;
/** Body centre, in front of the line. Wide enough that the camera does not sit inside the rungs. */
export const LADDER_FRONT = .32;
/** How far in front of the foot the climber is put down after stepping off the bottom. */
export const LADDER_DISMOUNT = .9;
const ATTACH_TIME = .2, ATTACH_MAX = .4, ATTACH_SPEED = 3.5, TOP_TIME = .35, BOTTOM_TIME = .3, BOB = .009, TELEPORT = .75;

export type LadderInput = {
  /** W up, S down, in -1..1 (a thumbstick may give anything between). */
  forward: number;
  /** Space or the interact key. */
  letGo?: boolean;
};
export type LadderStep = Vec3 & {
  /** Set on the step that ends the climb; the climber is detached afterwards. */
  done?: 'top' | 'bottom' | 'let-go';
  /** Rungs passed this step (either direction). The engine knocks once and emits one noise for each. */
  rungs: number;
  /** Camera height offset in metres. */
  bob: number;
};

const clamp = (x: number, a: number, b: number) => x < a ? a : x > b ? b : x;
const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const finite = (x: number) => Number.isFinite(x) ? x : 0;
/** Math.hypot is allowed to differ between engines in the last bit; a square root is not. Replays should agree to the bit. */
const hyp = (x: number, y: number, z = 0) => Math.sqrt(x * x + y * y + z * z);

/** The unit direction, horizontally, a climber faces away from: out from the exit toward the line. */
export function ladderFront(l: Ladder): { x: number; z: number } {
  let x = l.top.x - l.exit.x, z = l.top.z - l.exit.z, n = hyp(x, z);
  // An exit straight above the line says nothing; a leaning ladder still has its foot out in front.
  if (n < 1e-6) { x = l.bottom.x - l.top.x; z = l.bottom.z - l.top.z; n = hyp(x, z); }
  return n < 1e-6 ? { x: 0, z: 1 } : { x: x / n, z: z / n };
}
export const ladderLength = (l: Ladder) => hyp(l.top.x - l.bottom.x, l.top.y - l.bottom.y, l.top.z - l.bottom.z);

/** Where the climber's feet are with `s` metres of ladder below them. */
export function ladderBody(l: Ladder, s: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const length = ladderLength(l) || 1, t = clamp(s / length, 0, 1), f = ladderFront(l);
  out.x = l.bottom.x + (l.top.x - l.bottom.x) * t + f.x * LADDER_FRONT;
  out.y = l.bottom.y + (l.top.y - l.bottom.y) * t;
  out.z = l.bottom.z + (l.top.z - l.bottom.z) * t + f.z * LADDER_FRONT;
  return out;
}

/** Where the climber is put down after stepping off the bottom: out in front, clear of a plinth or a footing. */
function dismountPoint(l: Ladder, out: Vec3): Vec3 {
  const f = ladderFront(l);
  out.x = l.bottom.x + f.x * (LADDER_FRONT + LADDER_DISMOUNT); out.y = l.bottom.y; out.z = l.bottom.z + f.z * (LADDER_FRONT + LADDER_DISMOUNT);
  return out;
}

/** The point on the ladder line nearest `p`, as a fraction of its length and a distance. */
export function ladderNearest(l: Ladder, p: Vec3) {
  const dx = l.top.x - l.bottom.x, dy = l.top.y - l.bottom.y, dz = l.top.z - l.bottom.z, length2 = dx * dx + dy * dy + dz * dz;
  const t = length2 > 0 ? clamp(((p.x - l.bottom.x) * dx + (p.y - l.bottom.y) * dy + (p.z - l.bottom.z) * dz) / length2, 0, 1) : 0;
  const x = l.bottom.x + dx * t, y = l.bottom.y + dy * t, z = l.bottom.z + dz * t;
  return { t, x, y, z, distance: hyp(p.x - x, p.y - y, p.z - z) };
}
/** Within about a metre of the line, measured from the feet. Standing on a platform beside the top counts. */
export const ladderReachable = (l: Ladder, feet: Vec3) => ladderNearest(l, feet).distance <= LADDER_REACH;

/**
 * The point of the ladder line closest to the view ray (the eye, out `maxDistance` along `direction`),
 * so that "looking at it" works whichever way up the ladder the player looks. `gap` is how far the ray
 * passes from the line there. Closest points of two segments, after Ericson, Real-Time Collision Detection 5.1.9.
 */
export function ladderAim(l: Ladder, eye: Vec3, direction: Vec3, maxDistance: number) {
  const d1 = { x: direction.x * maxDistance, y: direction.y * maxDistance, z: direction.z * maxDistance };
  const d2 = { x: l.top.x - l.bottom.x, y: l.top.y - l.bottom.y, z: l.top.z - l.bottom.z };
  const r = { x: eye.x - l.bottom.x, y: eye.y - l.bottom.y, z: eye.z - l.bottom.z };
  const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z, e = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z, f = d2.x * r.x + d2.y * r.y + d2.z * r.z;
  let s = 0, t = 0;
  if (a > 1e-12 && e > 1e-12) {
    const c = d1.x * r.x + d1.y * r.y + d1.z * r.z, b = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z, denom = a * e - b * b;
    s = denom > 1e-12 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
  } else if (e > 1e-12) t = clamp(f / e, 0, 1);
  const x = l.bottom.x + d2.x * t, y = l.bottom.y + d2.y * t, z = l.bottom.z + d2.z * t;
  return { t, x, y, z, gap: hyp(eye.x + d1.x * s - x, eye.y + d1.y * s - y, eye.z + d1.z * s - z) };
}

type Phase = 'climb' | 'top' | 'bottom';

export function createLadderClimber() {
  let ladder: Ladder | undefined, phase: Phase = 'climb';
  /** Metres of ladder below the feet. */
  let s = 0, age = 0, blend = 0, level = 0, attachTime = ATTACH_TIME;
  /** Where the player stood when they took hold, relative to the line; it eases to nothing over `attachTime`. */
  const offset: Vec3 = { x: 0, y: 0, z: 0 }, from: Vec3 = { x: 0, y: 0, z: 0 }, last: Vec3 = { x: 0, y: 0, z: 0 };
  const scratch: Vec3 = { x: 0, y: 0, z: 0 };

  const climbPose = (l: Ladder, out: Vec3) => {
    ladderBody(l, s, out);
    const k = 1 - smooth(age / attachTime);
    out.x += offset.x * k; out.y += offset.y * k; out.z += offset.z * k;
    return out;
  };
  const finish = (done: LadderStep['done'], pose: Vec3, rungs = 0): LadderStep => {
    ladder = undefined; last.x = pose.x; last.y = pose.y; last.z = pose.z;
    return { x: pose.x, y: pose.y, z: pose.z, done, rungs, bob: 0 };
  };

  return {
    get attached() { return ladder !== undefined; },
    /** False while the final blend is under way; letting go is not possible then. */
    get canLetGo() { return ladder !== undefined && phase === 'climb'; },
    get ladder() { return ladder; },
    /** Metres up the line, 0 at the bottom; undefined while free. */
    get distance() { return ladder ? s : undefined; },
    /** A plain copy of everything the machine remembers, for tests and for a host that wants to compare clients. */
    get state() {
      return ladder ? { ladder: ladder.id, phase, s, age, blend, level, offset: { ...offset }, from: { ...from }, last: { ...last } } : undefined;
    },
    /**
     * Take hold where the player stands. They are not moved this call: the difference between where
     * they are and the line eases away over about 0.2 s, so no frame jumps. False if already on a ladder.
     */
    attach(l: Ladder, position: Vec3): boolean {
      if (ladder) return false;
      ladder = l; phase = 'climb'; age = 0; blend = 0; level = 0;
      s = ladderNearest(l, position).t * ladderLength(l);
      ladderBody(l, s, scratch);
      offset.x = position.x - scratch.x; offset.y = position.y - scratch.y; offset.z = position.z - scratch.z;
      // 0.2 s, stretched for a long reach (from a platform, across a rail) so that nothing moves faster than about 5 m/s.
      attachTime = clamp(hyp(offset.x, offset.y, offset.z) / ATTACH_SPEED, ATTACH_TIME, ATTACH_MAX);
      last.x = position.x; last.y = position.y; last.z = position.z;
      return true;
    },
    /** Let go where the climber hangs. Undefined if free, or if already topping out or stepping off. */
    release(): Vec3 | undefined {
      if (!ladder || phase !== 'climb') return undefined;
      const pose = { x: last.x, y: last.y, z: last.z };
      ladder = undefined; return pose;
    },
    /**
     * Advance by dt seconds. `position` is where the player actually is; if something else has moved
     * them (a teleport, a server correction) the climber lets go rather than drag them back.
     * Undefined when not attached.
     */
    update(dt: number, input: LadderInput, position?: Vec3): LadderStep | undefined {
      const l = ladder; if (!l) return undefined;
      if (position && hyp(position.x - last.x, position.y - last.y, position.z - last.z) > TELEPORT) return finish('let-go', position);
      // Topping out and stepping off are committed: Space in the middle of them cannot drop anyone off the edge.
      if (input.letGo && phase === 'climb') return finish('let-go', last);
      const length = ladderLength(l);
      const frame = Math.max(0, finite(dt));
      let remaining = frame, moved = 0;
      const startRung = Math.floor(s / LADDER_RUNG);

      if (phase === 'climb') {
        const v = clamp(finite(input.forward), -1, 1) * LADDER_SPEED;
        if (v !== 0 && remaining > 0) {
          const target = s + v * remaining;
          if (v > 0 && target >= length) { remaining -= (length - s) / v; moved += length - s; s = length; phase = 'top'; }
          else if (v < 0 && target <= 0) { remaining -= (0 - s) / v; moved += s; s = 0; phase = 'bottom'; }
          else { moved += Math.abs(v) * remaining; s = target; remaining = 0; }
        } else remaining = 0;
        age += frame - remaining;
        if (phase !== 'climb') {
          // Leaves from wherever the climb pose stands at the moment the end of the line is reached.
          climbPose(l, from);
          blend = 0;
        }
      }
      const rungs = Math.abs(Math.floor(s / LADDER_RUNG) - startRung);
      // The dip fades in and out with how much the climber is actually moving (an implicit-Euler lowpass, about 0.1 s).
      level += (clamp(moved / (LADDER_SPEED * Math.max(frame, 1e-6)), 0, 1) - level) * (10 * frame / (1 + 10 * frame));
      const bob = BOB * Math.sin(Math.PI * 2 * s / LADDER_RUNG) * level;

      if (phase === 'climb') {
        const pose = climbPose(l, scratch);
        last.x = pose.x; last.y = pose.y; last.z = pose.z;
        return { x: last.x, y: last.y, z: last.z, rungs, bob };
      }
      // Topping out or stepping off the bottom: a short smooth blend, then free.
      const duration = phase === 'top' ? TOP_TIME : BOTTOM_TIME;
      const to = phase === 'top' ? l.exit : dismountPoint(l, scratch);
      blend += remaining; remaining = 0;
      if (blend >= duration) return finish(phase, to, rungs);
      const k = smooth(blend / duration);
      last.x = from.x + (to.x - from.x) * k; last.y = from.y + (to.y - from.y) * k; last.z = from.z + (to.z - from.z) * k;
      return { x: last.x, y: last.y, z: last.z, rungs, bob };
    },
  };
}
export type LadderClimber = ReturnType<typeof createLadderClimber>;
