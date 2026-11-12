import * as THREE from 'three';
import { LEG_MAX_TARSAL, LEG_REACH, SPIDER_LEGS, SPIDER_SCALE as S, solveSpiderLeg, type LegJoints, type SpiderRig } from './spider-rig';

type V3 = THREE.Vector3;
/** Where a foot should go, given a desired world point near a surface. */
export type Contact = { point: V3; normal: V3 };
export type SpiderSurface = (target: V3, out: Contact, from?: V3) => void;
/** Metres between a limb segment and the nearest solid it must not touch. */
export type LimbClearance = (a: V3, b: V3) => number;
/** Overrides where a leg wants to stand, e.g. wrapped around a trunk. */
export type RestPose = (leg: { index: number; side: number; rest: V3 }, anchor: V3, right: V3, forward: V3, yawAhead: number, out: V3) => void;

export type SpiderCommand = {
  anchor: V3;   // point on the surface under the thorax
  up: V3;       // surface normal the body stands on
  forward: V3;  // tangent the head points along
  surface: SpiderSurface;
  ride: number;            // thorax height above the surface, world metres
  width: number;           // stance width multiplier
  length: number;          // stance length multiplier
  crouch?: number;
  tension?: number;        // 0 calm, 1 coiled and rigid
  clearance?: LimbClearance;
  rest?: RestPose;
  poleWide?: number;       // how far the knees splay outward
  hug?: number;            // 0 on the ground, 1 wrapped on a trunk: knees blend between the two
  obstacles?: { x: number; z: number; r: number }[];   // vertical trunks a leg must lean around
  /** Route for a swinging foot, e.g. around a trunk rather than through it. s runs 0 to 1. */
  swingPath?: (from: V3, to: V3, s: number, out: V3) => V3;
  /** Metres per second a reaching foot travels when the body is not in a hurry. */
  reachSpeed?: number;
  /** Navigation's unobstructed pace, before support feet limit this frame's body motion. */
  pace?: number;
};

type Leg = {
  index: number; side: number; label: string; hip: V3; rest: V3; outward: V3; inward: V3; azimuth: number; offset: number; seedLift: number;
  foot: V3; from: V3; to: V3; normal: V3; fromNormal: V3; toNormal: V3;
  swinging: boolean; pending: boolean; t: number; duration: number; lift: number; phase: number; liftPriority: number; joints: LegJoints;
  /** Where this leg stands now, thorax units in the body's own horizontal plane, and the unit direction from hip to there. */
  restNow: { x: number; z: number }; outNow: V3; azimuthNow: number;
  /** The leg's own direction when its planted foot came down. A foot is judged against the stance it was placed for, not one the body has changed to since. */
  outPlant: V3;
  /** How far ahead of (hi) and behind (lo) that stance point a planted foot may be before the leg runs out, along the line of travel. */
  windowLo: number; windowHi: number; centre: number;
  /** The way the ground passes under this leg, in the body's frame (unit), and how fast in metres per second. */
  dirX: number; dirZ: number; drive: number;
  /** Seconds since this foot came down, and whether its next lift is one it cannot wait for. */
  planted: number; urgent: boolean;
  cooldown: number; settled: boolean; hover: number; hoverAllowed: number; hoverPoint: V3; clear: number; pole: V3; poleYaw: number; lean: number; leanSide: number; tip: V3; reachRatio: number; clearPart: number; smoothUp: V3; upReady: boolean;
};

const clamp = THREE.MathUtils.clamp, sstep = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp, damp = THREE.MathUtils.damp;
const fract = (v: number) => v - Math.floor(v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
/** Height through a swing: one smooth rise and fall with no sudden change of speed. */
const arc = (t: number) => Math.sin(Math.PI * t) ** 1.5;
/** The last hand-span of a claw is a thin needle: plant it in the surface so the visible claw touches. */
const CLAW_SINK = .075;
const CLEAR_MARGIN = .42;          // metres a limb's plan line must keep from solids
const SECTOR = .45;               // radians a foot may stray from its leg's own direction
const NEAREST = 1.15, FARTHEST = 5.0;   // hip-to-foot limits in thorax units
/**
 * Stride planning, thorax units. A planted foot is carried backwards under the moving body until its leg runs out: either
 * the hip-to-foot distance reaches PLAN_REACH of the leg's length, or the foot comes within PLAN_INSIDE of passing under
 * the hip. Every step is planned to use at most WINDOW_USE of the room between those two, so in ordinary travel no leg
 * ever reaches a limit and the body never has to wait for one. Past HARD_REACH / HARD_INSIDE the body is held (gently).
 */
const PLAN_REACH = .86, PLAN_INSIDE = .95, WINDOW_USE = .78;
/** A planted leg stretched past URGENT lifts at once, whatever the rhythm says. From SOFT to HARD the body is eased to a halt. */
const URGENT_REACH = .905, SOFT_REACH = .935, HARD_REACH = .985;
const URGENT_INSIDE = .7, SOFT_INSIDE = .5, HARD_INSIDE = .15;
/** The last joint before the claw stands this far in toward the hip and above the claw's tip (see solveSpiderLeg). */
const CLAW_IN = .33, CLAW_UP = .18;
/** The middle of the thorax, between the eight hips, in its own units: what the body pitches and rolls about. */
const PIVOT = SPIDER_LEGS.reduce((sum, l) => sum.addScaledVector(l.hip, 1 / SPIDER_LEGS.length), new THREE.Vector3()).setX(0);
/** Fastest the legs will cycle. Beyond what that carries, the body is asked to go no faster (see `capacity`). */
const MAX_STEP_RATE = 6.2;

/** Clearances and lifts were tuned when the creature stood at 0.8 scale; they grow with it. */
const K = S / .8;
/**
 * Spider gait: alternating tetrapods with Cruse-style neighbour coordination.
 *
 * Every limb stays in the vertical plane through its hip and foot, with the knee
 * above: it cannot flip, because nothing ever chooses a knee direction. Feet are
 * world-locked and a foothold is chosen once, at lift-off, inside that leg's own
 * sector and clear of trunks for its whole stance. Timing scales to the animal's
 * size so a body this heavy reads as heavy instead of vibrating.
 */
export function createSpiderGait(root: THREE.Group, body: THREE.Group, rig: SpiderRig) {
  const legs: Leg[] = SPIDER_LEGS.map((l, i) => {
    const outward = new THREE.Vector3(l.foot.x - l.hip.x, 0, l.foot.z - l.hip.z).normalize();
    return {
      index: l.index, side: l.side, label: l.label, hip: l.hip.clone(), rest: l.foot.clone().setY(0).multiplyScalar(S),
      outward, inward: outward.clone().negate(), azimuth: Math.atan2(outward.x, outward.z),
      // L0 R1 L2 R3 against R0 L1 R2 L3: the classic alternating tetrapods.
      offset: ((l.index + (l.side > 0 ? 1 : 0)) % 2) * .5,
      seedLift: fract(Math.sin(i * 91.7) * 43758.5453),
      foot: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), fromNormal: new THREE.Vector3(0, 1, 0), toNormal: new THREE.Vector3(0, 1, 0),
      swinging: false, pending: false, t: 1, duration: .3, lift: .4, phase: 0, liftPriority: 0, joints: { knee: new THREE.Vector3(), ankle: new THREE.Vector3(), tarsal: new THREE.Vector3() },
      restNow: { x: l.foot.x, z: l.foot.z }, outNow: outward.clone(), outPlant: outward.clone(), azimuthNow: Math.atan2(outward.x, outward.z), windowLo: -1, windowHi: 1, centre: 0,
      dirX: 0, dirZ: 1, drive: 0, planted: 1, urgent: false,
      cooldown: 0, settled: false, hover: 0, hoverAllowed: 1, hoverPoint: new THREE.Vector3(), clear: Infinity, pole: new THREE.Vector3(), poleYaw: 0, lean: 0, leanSide: 0, tip: new THREE.Vector3(), reachRatio: 0, clearPart: 0, smoothUp: new THREE.Vector3(0, 1, 0), upReady: false,
    };
  });
  const contact: Contact = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) }, trial: Contact = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) };
  const prevAnchor = new THREE.Vector3(), velocity = new THREE.Vector3(), right = new THREE.Vector3(), basisF = new THREE.Vector3(), basisU = new THREE.Vector3(), mat = new THREE.Matrix4();
  const target = new THREE.Vector3(), ideal = new THREE.Vector3(), predicted = new THREE.Vector3(), localFoot = new THREE.Vector3(), localUp = new THREE.Vector3(), pole = new THREE.Vector3(), plan = new THREE.Vector3(), tmp = new THREE.Vector3(), shift = new THREE.Vector3();
  const hipW = new THREE.Vector3(), kneeW = new THREE.Vector3(), ankleW = new THREE.Vector3(), tarsalW = new THREE.Vector3(), rendered = new THREE.Vector3();
  const trunkPole = new THREE.Vector3(), foreAft = new THREE.Vector3(), pivot = new THREE.Vector3();
  const stepFrom = new THREE.Vector3(), stepTo = new THREE.Vector3(), forwardFrom = new THREE.Vector3(), forwardTo = new THREE.Vector3(), upFrom = new THREE.Vector3(), upTo = new THREE.Vector3();
  const invRoot = new THREE.Quaternion(), worldQ = new THREE.Quaternion(), bodyQ = new THREE.Quaternion(), turn_ = new THREE.Quaternion(), none = new THREE.Quaternion();
  let ready = false, phase = 0, speed = 0, smoothSpeed = 0, yawRate = 0, prevForwardAngle = 0, frequency = 0, nextIdleStep = 0, idleCursor = 0;
  let pitch = 0, roll = 0, rise = 0, heave = 0, sprint = 0, currentPace = 0, capacity = 30, wasMoving = false;
  /** Which planted leg last held the body back, and why: for diagnosis and tests. */
  let limitedBy: { leg: string; why: 'reach' | 'inward'; value: number; pending: boolean; cooldown: number } | undefined;
  const idleOrder = [0, 5, 2, 7, 4, 1, 6, 3];
  const due: Leg[] = [];
  const liftOrder = (a: Leg, b: Leg) => b.liftPriority - a.liftPriority;

  function neighbourSwinging(leg: Leg) {
    return legs.some(o => o !== leg && o.swinging && ((o.side === leg.side && Math.abs(o.index - leg.index) === 1) || (o.side !== leg.side && o.index === leg.index)));
  }
  function setFrame(cmd: SpiderCommand) {
    basisU.copy(cmd.up).normalize();
    right.crossVectors(basisU, cmd.forward).normalize();
    basisF.crossVectors(right, basisU).normalize();
    mat.makeBasis(right, basisU, basisF);
    root.quaternion.setFromRotationMatrix(mat);
  }
  /**
   * Where each leg stands for this stance width. A narrow stance (squeezing between trunks) is not the wide one with its
   * feet pulled in under the body: that leaves a leg nowhere to go, and the first step forward folds it under its own hip.
   * The legs swing fore and aft instead, front pairs forward and rear pairs back, staying as long as they were.
   */
  function poseStance(cmd: SpiderCommand) {
    const long = cmd.length * (1 + sprint * .14);
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i], base = SPIDER_LEGS[i], dx = base.foot.x - leg.hip.x, dz = base.foot.z - leg.hip.z, r = Math.hypot(dx, dz);
      const widest = Math.abs(base.foot.x), allowed = widest * Math.min(1, cmd.width);
      let x = base.foot.x, z = base.foot.z;
      if (allowed < widest - 1e-4) {
        const sine = clamp((allowed - Math.abs(leg.hip.x)) / r, .04, 1), cosine = Math.sqrt(1 - sine * sine);
        x = leg.hip.x + leg.side * r * sine; z = leg.hip.z + (leg.index < 2 ? 1 : -1) * r * cosine;
      }
      leg.restNow.x = x; leg.restNow.z = z * long;
      const ox = leg.restNow.x - leg.hip.x, oz = leg.restNow.z - leg.hip.z, ol = Math.hypot(ox, oz) || 1;
      leg.outNow.set(ox / ol, 0, oz / ol); leg.azimuthNow = Math.atan2(ox, oz);
    }
  }
  /** How stretched a leg is: its hip-to-last-joint distance over the longest it can be. Offsets are in the body's frame, thorax units. */
  const strain = (across: number, down: number) => Math.hypot(Math.max(0, across - CLAW_IN), Math.max(0, down - CLAW_UP)) / LEG_MAX_TARSAL;
  /**
   * The room a leg has along the line its foot is carried (leg.dirX, leg.dirZ), with its hip `hipLift` above rest height:
   * how far ahead of its stance point a foot may land (windowHi) and how far behind it may trail (windowLo) before the leg
   * is too stretched or folds in under its own hip.
   */
  function legWindow(leg: Leg, hipLift: number) {
    const px = leg.restNow.x - leg.hip.x, pz = leg.restNow.z - leg.hip.z, down = Math.max(.1, leg.hip.y + hipLift - CLAW_UP);
    const far = LEG_MAX_TARSAL * PLAN_REACH, radius = far > down ? CLAW_IN + Math.sqrt(far * far - down * down) : 0;
    const b = px * leg.dirX + pz * leg.dirZ, c = px * px + pz * pz - radius * radius, room = px * leg.outNow.x + pz * leg.outNow.z - PLAN_INSIDE;
    if (c >= 0 || room <= 0) { leg.windowLo = leg.windowHi = 0; return; }
    const root_ = Math.sqrt(b * b - c), turn = leg.outNow.x * leg.dirX + leg.outNow.z * leg.dirZ;
    let lo = -b - root_, hi = -b + root_;
    if (turn > 1e-3) lo = Math.max(lo, -room / turn); else if (turn < -1e-3) hi = Math.min(hi, room / -turn);
    leg.windowLo = lo; leg.windowHi = hi;
  }
  function restWorld(leg: Leg, anchor: V3, cmd: SpiderCommand, yawAhead: number, out: V3) {
    if (cmd.rest) { cmd.rest(leg, anchor, right, basisF, yawAhead, out); return out; }
    const co = Math.cos(yawAhead), si = Math.sin(yawAhead);
    const x = leg.restNow.x * S, z = leg.restNow.z * S;
    return out.copy(anchor).addScaledVector(right, x * co + z * si).addScaledVector(basisF, z * co - x * si);
  }
  /** Knees rise in the vertical plane through hip and foot. Nothing else moves them. */
  function kneePole(leg: Leg, foot: V3, fold: number, cmd: SpiderCommand, dt: number, out: V3) {
    plan.set(foot.x - leg.hip.x, 0, foot.z - leg.hip.z);
    const reach = plan.length();
    // Opposing direction vectors can cancel and flip the knee plane in one frame.
    // Turn within the leg's sector at a bounded rate while keeping the foot planted.
    plan.multiplyScalar(1 / Math.max(reach, 1e-4));
    const angle = Math.atan2(leg.outNow.z * plan.x - leg.outNow.x * plan.z, leg.outNow.dot(plan));
    const wanted = clamp(angle, -.9, .9) * .5 * sstep(reach, .55, 1.4);
    leg.poleYaw += clamp((wanted - leg.poleYaw) * (1 - Math.exp(-dt * 9)), -dt * 2.4, dt * 2.4);
    plan.copy(leg.outNow).applyAxisAngle(THREE.Object3D.DEFAULT_UP, leg.poleYaw);
    // Squeezing between trunks: front knees fold forward and rear knees back, along
    // the body, so nothing sticks out sideways into the trees on either side.
    const squeeze = clamp((1 - cmd.width) / .6, 0, 1);
    if (squeeze > 0) plan.lerp(foreAft.set(0, 0, leg.index < 2 ? 1 : -1), squeeze * .3).normalize();
    const wide = cmd.poleWide ?? 3.0, tension = cmd.tension ?? 0;
    out.set(leg.hip.x + plan.x * wide, leg.hip.y + 5.2 + fold * .9 + tension * .8, leg.hip.z + plan.z * wide);
    const hug = cmd.hug ?? 0;
    // On a trunk the foot is below the hip, so knees push out sideways and fan
    // along the trunk. The switch is gradual: a jump here throws every knee at once.
    if (hug > 0) trunkPole.set(leg.hip.x + leg.side * 5, leg.hip.y + 1.9 + fold * .6, leg.hip.z + (foot.z - leg.hip.z) * .35 + (1.5 - leg.index) * 3.2 * sstep(hug, .82, 1));
    return hug > 0 ? out.lerp(trunkPole, hug) : out;
  }
  /** A trunk near the hip-to-foot line tilts the limb sideways so the knee goes round it. */
  function leanAround(leg: Leg, foot: V3, cmd: SpiderCommand, dt: number) {
    let wanted = 0, closest = Infinity, side = leg.leanSide;
    plan.set(foot.x - leg.hip.x, 0, foot.z - leg.hip.z);
    const length = plan.length();
    const kneeOut = Math.hypot(leg.joints.knee.x - leg.hip.x, leg.joints.knee.z - leg.hip.z) + .4;
    if (cmd.obstacles && length > .4) {
      plan.divideScalar(length);
      for (const o of cmd.obstacles) {
        tmp.set(o.x, cmd.anchor.y, o.z); body.worldToLocal(tmp);
        const dx = tmp.x - leg.hip.x, dz = tmp.z - leg.hip.z, along = dx * plan.x + dz * plan.z;
        if (along < .05 * length || along > Math.max(length, kneeOut)) continue;
        const across = -plan.z * dx + plan.x * dz, gap = Math.abs(across) - o.r / S;
        if (gap > 1.1 || gap >= closest) continue;
        closest = gap;
        // Keep the chosen side while nearly centred, so the limb cannot dither.
        if (Math.abs(across) > .12 || !side) side = Math.sign(across) || 1;
        wanted = -side * clamp((1.1 - gap) / 1.4, 0, 1) * 1.35;
      }
    }
    if (closest === Infinity) side = 0;
    leg.leanSide = side;
    const step = wanted - leg.lean, limit = 2.4 * dt;
    leg.lean += clamp(step * (1 - Math.exp(-5 * dt)), -limit, limit);
  }
  let resting = false;
  function limbClear(leg: Leg, cmd: SpiderCommand) {
    if (!cmd.clearance) return Infinity;
    hipW.copy(leg.hip); body.localToWorld(hipW);
    kneeW.copy(leg.joints.knee); body.localToWorld(kneeW);
    ankleW.copy(leg.joints.ankle); body.localToWorld(ankleW);
    tarsalW.copy(leg.joints.tarsal); body.localToWorld(tarsalW);
    const values = [cmd.clearance(hipW, kneeW), cmd.clearance(kneeW, ankleW), cmd.clearance(ankleW, tarsalW)];
    leg.clearPart = values.indexOf(Math.min(...values));
    return Math.min(...values);
  }
  /** The hip-to-foot line must stay clear for the whole stance; the leg lies above it. */
  function stanceClear(leg: Leg, cmd: SpiderCommand, foot: V3, landing: number, stance: number) {
    if (!cmd.clearance) return Infinity;
    let lowest = Infinity;
    for (const t of [landing, landing + stance * .5, landing + stance]) {
      shift.copy(velocity).multiplyScalar(t);
      hipW.copy(leg.hip); body.localToWorld(hipW).add(shift);
      tmp.copy(hipW).lerp(foot, Math.max(.96, 1.9 / Math.max(hipW.distanceTo(foot), .5)));
      lowest = Math.min(lowest, cmd.clearance(hipW, tmp));
    }
    return lowest;
  }
  /** A foot may only stand in its own leg's slice of the circle around its hip. */
  function inSector(leg: Leg, foot: V3, lead: number) {
    shift.copy(velocity).multiplyScalar(lead);
    localFoot.copy(foot).sub(shift); body.worldToLocal(localFoot);
    const dx = localFoot.x - leg.hip.x, dz = localFoot.z - leg.hip.z, r = Math.hypot(dx, dz);
    return r > NEAREST && r < FARTHEST && Math.abs(wrap(Math.atan2(dx, dz) - leg.azimuthNow)) < SECTOR;
  }
  function chooseFoothold(leg: Leg, cmd: SpiderCommand, landing: number, stance: number) {
    cmd.surface(target, contact, leg.foot);
    if (cmd.rest) return;
    ideal.copy(target);
    const score = (c: Contact) => (inSector(leg, c.point, landing) ? 0 : -.08) + Math.min(CLEAR_MARGIN, stanceClear(leg, cmd, c.point, landing, stance));
    let best = score(contact);
    if (best >= CLEAR_MARGIN) return;
    hipW.copy(leg.hip); body.localToWorld(hipW);
    // Try the nearest alternatives first, so a blocked foot barely changes its plan.
    for (const radial of [0, -.5, .5, -1, -1.6, -2.2]) for (const angle of [0, .22, -.22, .44, -.44, .7, -.7]) {
      if (!radial && !angle) continue;
      target.subVectors(ideal, hipW).setComponent(1, 0);
      const r = Math.max(.6, target.length() + radial);
      target.normalize().applyAxisAngle(basisU, angle).multiplyScalar(r).add(hipW);
      target.y = ideal.y;
      cmd.surface(target, trial, leg.foot);
      const value = score(trial);
      if (value > best + .01) { best = value; contact.point.copy(trial.point); contact.normal.copy(trial.normal); }
      if (best >= CLEAR_MARGIN) return;
    }
  }
  function startSwing(leg: Leg, cmd: SpiderCommand, swing: number, stance: number) {
    const lead = swing + stance * .5;
    predicted.copy(cmd.anchor).addScaledVector(velocity, lead);
    restWorld(leg, predicted, cmd, yawRate * lead, target);
    // Mid-stance is where the leg's room is centred, which is not always its stance point (a rear leg has more room behind).
    if (!cmd.rest) target.addScaledVector(right, leg.dirX * leg.centre * S).addScaledVector(basisF, leg.dirZ * leg.centre * S);
    chooseFoothold(leg, cmd, swing, stance);
    leg.from.copy(leg.foot); leg.fromNormal.copy(leg.normal);
    leg.to.copy(contact.point); leg.toNormal.copy(contact.normal);
    let span = leg.from.distanceTo(leg.to);
    const duration = cmd.reachSpeed ? clamp(span / cmd.reachSpeed, swing, .85) : currentPace < 1.8 ? clamp(span / 7, swing, .9) : swing;
    if (cmd.reachSpeed && duration > swing) {
      // An unhurried reach must aim where the hip will be when it arrives, not when it set off.
      predicted.copy(cmd.anchor).addScaledVector(velocity, duration + stance * .5);
      restWorld(leg, predicted, cmd, yawRate * lead, target);
      if (!cmd.rest) target.addScaledVector(right, leg.dirX * leg.centre * S).addScaledVector(basisF, leg.dirZ * leg.centre * S);
      cmd.surface(target, contact, leg.foot);
      leg.to.copy(contact.point); leg.toNormal.copy(contact.normal);
      span = leg.from.distanceTo(leg.to);
    }
    // Standing still, a step that would land where the foot already is (a trunk leaves it no better place) is
    // not taken: otherwise that leg lifts and sets down again for ever.
    if (resting && span < .32 * K) { leg.pending = false; leg.settled = true; leg.cooldown = 1.5; return false; }
    leg.swinging = true; leg.pending = false; leg.urgent = false; leg.t = 0; leg.duration = duration; leg.cooldown = .4; leg.settled = false;
    let need = 0;
    // Clear what is underneath, allowing for how low the arc is at each point.
    // Sampled every 12 cm or so: a longer stride must not step over a narrow ridge unseen.
    const samples = Math.max(10, Math.min(48, Math.ceil(span / .07)));
    if (!cmd.rest) for (let i = 1; i < samples; i++) {
      const t = i / samples;
      tmp.lerpVectors(leg.from, leg.to, smoother(t));
      cmd.surface(tmp, trial);
      const above = (trial.point.x - tmp.x) * trial.normal.x + (trial.point.y - tmp.y) * trial.normal.y + (trial.point.z - tmp.z) * trial.normal.z;
      // Fade toe clearance at contact: a constant margin divided by the tiny
      // end-of-swing arc used to force high lifts even on perfectly flat ground.
      const hump = arc(t);
      need = Math.max(need, (above + (above > .01 * K ? .1 * K : .035 * K * hump)) / Math.max(hump, .08));
    }
    // Use actual smoothed body speed, not the requested speed when blocked.
    // Lock the height at lift-off so acceleration cannot pop a foot mid-swing.
    const paceLift = sstep(smoothSpeed, .25, 9);
    const strideLift = sstep(span / K, .15, 2.5);
    const naturalLift = K * (.055 + .34 * paceLift) * (.65 + .35 * strideLift)
      + .012 * K * leg.seedLift * strideLift;
    leg.lift = Math.max(naturalLift, Math.min(need, 1.8 * K));
    return true;
  }
  function placeAll(cmd: SpiderCommand) {
    for (const leg of legs) {
      restWorld(leg, cmd.anchor, cmd, 0, target);
      cmd.surface(target, contact);
      leg.foot.copy(contact.point); leg.normal.copy(contact.normal); leg.from.copy(contact.point); leg.to.copy(contact.point);
      leg.fromNormal.copy(contact.normal); leg.toNormal.copy(contact.normal); leg.swinging = false; leg.pending = false; leg.t = 1; leg.planted = 1; leg.outPlant.copy(leg.outNow);
    }
  }
  return {
    legs,
    get speed() { return smoothSpeed; },
    get limitedBy() { return limitedBy; },
    get frequency() { return frequency; },
    /** The fastest the body can travel in a straight line with the legs it has room to swing now, metres per second. */
    get capacity() { return capacity; },
    reset() {
      ready = false; phase = speed = smoothSpeed = yawRate = frequency = currentPace = 0; capacity = 30; wasMoving = false;
      pitch = roll = rise = heave = sprint = 0;
      for (const leg of legs) { leg.pending = false; leg.poleYaw = leg.lean = leg.leanSide = 0; leg.upReady = false; leg.settled = false; }
    },
    /**
     * How much of this frame's body motion the planted legs allow, 0 to 1. Steps are planned so that this is 1: it is the
     * safety for what planning cannot see (a shove, a sudden turn). A leg past SOFT slows the body progressively and it
     * stops only at HARD, so the answer changes smoothly from frame to frame instead of snapping to zero.
     */
    movementAllowance(dx: number, dy: number, dz: number, turn: number) {
      if (!ready) return 1;
      let fraction = 1;
      limitedBy = undefined;
      const co = Math.cos(turn), si = Math.sin(turn);
      for (const leg of legs) {
        if (leg.swinging) continue;
        // Measured in the body's own frame, exactly as the lift rule measures it, so the two can never disagree.
        localFoot.copy(leg.foot); body.worldToLocal(localFoot).sub(leg.hip);
        const before = strain(Math.hypot(localFoot.x, localFoot.z), -localFoot.y), insideBefore = localFoot.x * leg.outPlant.x + localFoot.z * leg.outPlant.z;
        // The body moving by (dx, dy, dz) and turning is the foot moving the other way about it.
        const x = leg.foot.x - root.position.x - dx, z = leg.foot.z - root.position.z - dz;
        localFoot.set(root.position.x + x * co - z * si, leg.foot.y - dy, root.position.z + z * co + x * si); body.worldToLocal(localFoot).sub(leg.hip);
        const after = strain(Math.hypot(localFoot.x, localFoot.z), -localFoot.y), insideAfter = localFoot.x * leg.outPlant.x + localFoot.z * leg.outPlant.z;
        if (after > SOFT_REACH && after > before + 1e-6) {
          const f = Math.min(clamp((HARD_REACH - after) / (HARD_REACH - SOFT_REACH), 0, 1), clamp((HARD_REACH - before) / (after - before), 0, 1));
          if (f < fraction) { fraction = f; limitedBy = { leg: leg.label, why: 'reach', value: after, pending: leg.pending, cooldown: leg.cooldown }; }
        }
        if (insideAfter < SOFT_INSIDE && insideAfter < insideBefore - 1e-6) {
          const f = Math.min(clamp((insideAfter - HARD_INSIDE) / (SOFT_INSIDE - HARD_INSIDE), 0, 1), clamp((insideBefore - HARD_INSIDE) / (insideBefore - insideAfter), 0, 1));
          if (f < fraction) { fraction = f; limitedBy = { leg: leg.label, why: 'inward', value: insideAfter, pending: leg.pending, cooldown: leg.cooldown }; }
        }
      }
      return fraction;
    },
    /** Lift a planted leg toward a world point, for slow probing. */
    hover(i: number, weight: number, point: V3) { legs[i].hover = weight; legs[i].hoverPoint.copy(point); },
    /** Worst limb clearance this frame, excluding the claw that must touch. */
    minimumClearance() { return legs.reduce((v, l) => Math.min(v, l.clear), Infinity); },
    update(dt: number, time: number, cmd: SpiderCommand) {
      // Keep contact and IK integration steady through a slow rendered frame.
      // Normal 60 Hz frames perform one solve, with no extra surface queries.
      if (ready && dt > 1 / 40) {
        const steps = Math.ceil(dt * 40), step = dt / steps;
        stepFrom.copy(prevAnchor); stepTo.copy(cmd.anchor);
        forwardFrom.copy(basisF); forwardTo.copy(cmd.forward);
        upFrom.copy(basisU); upTo.copy(cmd.up);
        for (let i = 1; i <= steps; i++) {
          const blend = i / steps;
          cmd.anchor.lerpVectors(stepFrom, stepTo, blend);
          cmd.forward.lerpVectors(forwardFrom, forwardTo, blend).normalize();
          cmd.up.lerpVectors(upFrom, upTo, blend).normalize();
          this.update(step, time - dt + step * i, cmd);
        }
        cmd.anchor.copy(stepTo); cmd.forward.copy(forwardTo); cmd.up.copy(upTo);
        return;
      }
      setFrame(cmd);
      if (!ready) { poseStance(cmd); placeAll(cmd); prevAnchor.copy(cmd.anchor); ready = true; prevForwardAngle = Math.atan2(basisF.x, basisF.z); frequency = 0; }
      dt = Math.max(dt, 1e-4);
      velocity.subVectors(cmd.anchor, prevAnchor).divideScalar(dt);
      prevAnchor.copy(cmd.anchor);
      speed = velocity.length();
      smoothSpeed = damp(smoothSpeed, speed, 10, dt);
      const plannedPace = Math.max(speed, cmd.pace ?? 0);
      if (plannedPace > speed) {
        if (speed > .05) velocity.multiplyScalar(plannedPace / speed);
        else velocity.copy(basisF).multiplyScalar(plannedPace);
      }
      const angle = Math.atan2(basisF.x, basisF.z), turn = wrap(angle - prevForwardAngle);
      prevForwardAngle = angle;
      yawRate = damp(yawRate, Math.abs(basisU.y) > .6 ? turn / dt : 0, 8, dt);

      // Scale: long, slow strides at speed. Each foot covers ground, not vibrates.
      const pace = Math.max(plannedPace, smoothSpeed);
      currentPace = pace;
      sprint = damp(sprint, sstep(pace, 1.4, 6.5), 5, dt);
      const moving = smoothSpeed > .14 || speed > .3 || Math.abs(yawRate) > .3;
      resting = !moving;
      if (moving) for (const leg of legs) leg.settled = false;

      // What the ground does under each leg: the body's own travel, plus its turning about the thorax. A leg on the outside
      // of a turn is carried faster than the body moves, and it is the fastest-carried leg that sets the rhythm.
      poseStance(cmd);
      const planned = !cmd.rest, vx = velocity.dot(right), vz = velocity.dot(basisF);
      let carried = pace;
      for (const leg of legs) {
        const lx = vx + yawRate * leg.restNow.z * S, lz = vz - yawRate * leg.restNow.x * S, l = Math.hypot(lx, lz);
        leg.drive = Math.max(l, 0);
        if (l > .05) { leg.dirX = lx / l; leg.dirZ = lz / l; } else { leg.dirX = 0; leg.dirZ = 1; }
        carried = Math.max(carried, l);
      }
      const run = sstep(carried, 1.4, 6.5);
      const stride = lerp(1.15, 3.4, run);
      const duty = lerp(.78, .56, sstep(carried, .8, 6)) - .06 * sstep(carried, 6, 13);
      // Each leg carries its foot `travel` metres back under the body per step. The stride asks for stride * duty; a leg
      // with less room than that (a tall ride, a turn that sweeps it sideways) takes shorter, quicker steps instead of
      // running out of leg.
      const hipLift = (cmd.ride - (cmd.crouch ?? 0)) / S - 1.9, travel = stride * duty;
      let wanted = 0, limit = 30;
      for (const leg of legs) {
        if (planned) legWindow(leg, hipLift); else { leg.windowLo = -4; leg.windowHi = 4; }
        const room = (leg.windowHi - leg.windowLo) * S * WINDOW_USE;
        wanted = Math.max(wanted, leg.drive * duty / Math.max(.05, Math.min(travel, room)));
        limit = Math.min(limit, MAX_STEP_RATE * Math.max(.05, Math.min(3.4 * .5, room)) / .5);
      }
      capacity = limit;
      wanted = moving ? clamp(wanted, .5, MAX_STEP_RATE) : 0;
      // Setting off, the first tetrapod steps at once rather than after most of a cycle.
      if (moving && !wasMoving) phase = Math.ceil(phase) + duty - .01;
      wasMoving = moving;
      frequency = damp(frequency, wanted, wanted > frequency ? 16 : 5, dt);
      const wave = lerp(.1, .02, run);
      const beat = Math.max(frequency, .45);
      const stance = duty / beat, swing = clamp((1 - duty) / beat * .94, lerp(.16, .085, sstep(pace, 5, 13)), lerp(.5, .28, sstep(pace, .8, 6)));
      for (const leg of legs) {
        // Sit the step in the middle of the leg's room when it fits about the stance point, else as near to it as fits.
        const used = leg.drive * stance / S, room = leg.windowHi - leg.windowLo, slack = room - used;
        if (slack <= 0) leg.centre = (leg.windowLo + leg.windowHi) / 2;
        else { const margin = Math.min(slack / 2, .12 * room); leg.centre = clamp(0, leg.windowLo + used / 2 + margin, leg.windowHi - used / 2 - margin); }
      }
      const previous = phase;
      phase += frequency * dt;

      root.position.copy(cmd.anchor);
      root.updateMatrixWorld(true);
      body.updateWorldMatrix(true, false);
      worldQ.copy(body.getWorldQuaternion(bodyQ)).invert();

      for (const leg of legs) leg.cooldown -= dt;
      // The rhythm calls each leg. A call that finds the foot in the air, or only just down, is passed over.
      for (const leg of legs) {
        const shift_ = leg.offset + leg.index * wave * (leg.side > 0 ? 1 : .96);
        const b = fract(phase + shift_);
        leg.phase = b;
        if (!leg.swinging) leg.planted += dt;
        if (frequency > .05 && Math.floor(previous + shift_ - duty) < Math.floor(phase + shift_ - duty) && !leg.swinging && leg.planted > stance * .25) leg.pending = true;
      }
      let airborne = legs.filter(l => l.swinging).length;
      due.length = 0;
      for (const leg of legs) {
        if (leg.swinging || leg.hover > .01) continue;
        hipW.copy(leg.hip); body.localToWorld(hipW);
        localFoot.copy(leg.foot); body.worldToLocal(localFoot).sub(leg.hip);
        // Judged a frame and a half ahead, so a fast body cannot carry a leg from fine to overstretched between two looks.
        const ahead = leg.drive * dt * 1.5 / S;
        localFoot.x -= leg.dirX * ahead; localFoot.z -= leg.dirZ * ahead;
        const stretch = strain(Math.hypot(localFoot.x, localFoot.z), -localFoot.y), inside = localFoot.x * leg.outPlant.x + localFoot.z * leg.outPlant.z;
        leg.urgent = stretch > URGENT_REACH || inside < URGENT_INSIDE;
        let lift = leg.pending || leg.urgent;
        if (!lift && airborne < 4 && !neighbourSwinging(leg) && leg.cooldown <= 0 && cmd.clearance && !cmd.rest && leg.clear < 1) {
          // Look a moment ahead: step before the moving body drags this limb into a trunk.
          shift.copy(velocity).multiplyScalar(.28);
          hipW.add(shift);
          lift = cmd.clearance(hipW, tmp.copy(hipW).lerp(leg.foot, .96)) < .14;
        }
        if (lift) { leg.liftPriority = (leg.urgent ? 2 : 0) + stretch + (leg.pending ? .08 : 0) + Math.max(0, URGENT_INSIDE - inside); due.push(leg); }
      }
      // The most stretched leg steps first. Four in the air is the rule; a leg that cannot wait may join them, down to two on the ground.
      due.sort(liftOrder);
      for (const leg of due) {
        if (airborne >= (leg.urgent ? 6 : 4)) continue;
        if (startSwing(leg, cmd, swing, stance)) airborne++;
      }
      // Coming to rest: settle slowly, one foot at a time, and only if it needs to.
      if (!moving) {
        nextIdleStep -= dt;
        if (nextIdleStep <= 0 && !legs.some(l => l.swinging)) {
          for (let i = 0; i < legs.length; i++) {
            const leg = legs[idleOrder[(idleCursor + i) % legs.length]];
            if (leg.hover > .01 || leg.settled) continue;
            restWorld(leg, cmd.anchor, cmd, 0, target);
            if (target.distanceTo(leg.foot) > .55 * K) {
              if (!startSwing(leg, cmd, .42, .3)) continue;   // nowhere better to stand: leave it, try the next leg
              idleCursor = (idleCursor + i + 1) % legs.length; nextIdleStep = .12;
              break;
            } else leg.settled = true;
          }
        }
      }
      for (const leg of legs) {
        if (!leg.swinging) continue;
        if (pace > 1.8) leg.duration = damp(leg.duration, Math.min(leg.duration, swing), 10, dt);
        leg.t = Math.min(1, leg.t + dt / leg.duration);
        const t = leg.t;
        if (cmd.swingPath) cmd.swingPath(leg.from, leg.to, smoother(t), leg.foot);
        else leg.foot.lerpVectors(leg.from, leg.to, smoother(t));
        // Turn the claw at a steady angular rate, even between opposite sides of a trunk.
        turn_.setFromUnitVectors(leg.fromNormal, leg.toNormal);
        leg.normal.copy(leg.fromNormal).applyQuaternion(none.identity().slerp(turn_, smoother(t))).addScaledVector(basisU, .35 * Math.sin(Math.PI * t)).normalize();
        leg.foot.addScaledVector(leg.normal, leg.lift * arc(t));
        if (t === 1) {
          // A body slowed by another support foot can arrive short of the
          // predicted landing. Plant within reach once, then lock that contact.
          hipW.copy(leg.hip); body.localToWorld(hipW);
          const dx = leg.to.x - hipW.x, dz = leg.to.z - hipW.z, horizontal = Math.hypot(dx, dz);
          const reach = LEG_MAX_TARSAL * S * .94, height = hipW.y - leg.to.y;
          const available = Math.sqrt(Math.max(.25, reach * reach - height * height));
          if (horizontal > available) {
            target.set(hipW.x + dx * available / horizontal, leg.to.y, hipW.z + dz * available / horizontal);
            cmd.surface(target, contact, leg.foot);
            leg.to.copy(contact.point); leg.toNormal.copy(contact.normal);
          }
          leg.foot.copy(leg.to); leg.normal.copy(leg.toNormal); leg.swinging = false; leg.planted = 0; leg.outPlant.copy(leg.outNow);
        }
      }

      // The thorax rides the average of where its feet are and are going.
      invRoot.copy(root.quaternion).invert();
      let front = 0, rear = 0, left = 0, rightH = 0, frontN = 0, rearN = 0, avg = 0;
      for (const leg of legs) {
        localFoot.copy(leg.swinging ? leg.to : leg.foot).sub(root.position).applyQuaternion(invRoot);
        const y = localFoot.y; avg += y;
        if (leg.index < 2) { front += y; frontN++; } else { rear += y; rearN++; }
        if (leg.side < 0) left += y; else rightH += y;
      }
      avg /= legs.length;
      pitch = damp(pitch, clamp(Math.atan2(front / frontN - rear / rearN, 3.4 * S), -.3, .3), 3.5, dt);
      roll = damp(roll, clamp(Math.atan2(rightH / 4 - left / 4, 5 * S), -.2, .2), 3.5, dt);
      rise = damp(rise, avg, 4.5, dt);
      heave = damp(heave, Math.sin(phase * Math.PI * 4) * (.4 + run * .6) * sstep(frequency, .3, 1), 14, dt);
      const breath = Math.sin(time * 1.1) * .007 * (1 - run);
      body.rotation.set(-pitch + run * .035, 0, -roll + heave * .006, 'YXZ');
      // The thorax tilts about its own middle, between the hips. Tilting it about the ground underneath swung the whole
      // body fore and aft (and side to side) by most of a metre every time the slope under the feet changed.
      pivot.copy(PIVOT).applyEuler(body.rotation);
      body.position.set(PIVOT.x - pivot.x, (cmd.ride - 1.9 * S + rise + heave * .018 * S + breath - (cmd.crouch ?? 0)) / S + PIVOT.y - pivot.y, PIVOT.z - pivot.z);
      root.updateMatrixWorld(true);
      body.updateWorldMatrix(true, false);
      worldQ.copy(body.getWorldQuaternion(bodyQ)).invert();

      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        rendered.copy(leg.foot);
        if (leg.hover > 0) rendered.lerp(leg.hoverPoint, leg.hover * leg.hoverAllowed);
        rendered.addScaledVector(leg.normal, -CLAW_SINK * (leg.swinging ? 1 - arc(leg.t) : 1));
        leg.tip.copy(rendered);
        localFoot.copy(rendered); body.worldToLocal(localFoot);
        localUp.copy(leg.normal).applyQuaternion(worldQ).normalize();
        // The claw is the lightest bone: filter its aim so a landing cannot flick it.
        if (!leg.upReady) { leg.smoothUp.copy(localUp); leg.upReady = true; }
        leg.smoothUp.lerp(localUp, 1 - Math.exp(-24 * dt)).normalize();
        localUp.copy(leg.smoothUp);
        kneePole(leg, localFoot, leg.swinging ? arc(leg.t) : 0, cmd, dt, pole);
        leanAround(leg, localFoot, cmd, dt);
        if (Math.abs(leg.lean) > 1e-3) {
          tmp.subVectors(localFoot, leg.hip).normalize();
          pole.sub(leg.hip).applyAxisAngle(tmp, leg.lean).add(leg.hip);
        }
        leg.pole.copy(pole);
        solveSpiderLeg(leg.hip, localFoot, pole, localUp, leg.joints);
        // If a foot ever gets out of reach, draw it in rather than let the chain break apart.
        leg.reachRatio = leg.hip.distanceTo(leg.joints.tarsal) / LEG_MAX_TARSAL;
        if (leg.reachRatio > .995) {
          localFoot.lerp(leg.hip, 1 - .99 / leg.reachRatio);
          solveSpiderLeg(leg.hip, localFoot, pole, localUp, leg.joints);
          leg.tip.copy(localFoot); body.localToWorld(leg.tip);
        }
        const clear = limbClear(leg, cmd);
        leg.clear = clear;
        leg.hoverAllowed = damp(leg.hoverAllowed, clear < CLEAR_MARGIN ? 0 : 1, clear < CLEAR_MARGIN ? 12 : 2, dt);
        rig.setLeg(i, leg.hip, leg.joints, localFoot);
      }
    },
  };
}
export type SpiderGait = ReturnType<typeof createSpiderGait>;
