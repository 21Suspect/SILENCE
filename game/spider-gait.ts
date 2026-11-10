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
};

type Leg = {
  index: number; side: number; label: string; hip: V3; rest: V3; outward: V3; inward: V3; azimuth: number; offset: number; seedLift: number;
  foot: V3; from: V3; to: V3; normal: V3; fromNormal: V3; toNormal: V3;
  swinging: boolean; pending: boolean; t: number; duration: number; lift: number; phase: number; joints: LegJoints;
  cooldown: number; hover: number; hoverAllowed: number; hoverPoint: V3; clear: number; pole: V3; lean: number; leanSide: number; tip: V3; reachRatio: number; clearPart: number; smoothUp: V3; upReady: boolean;
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
      swinging: false, pending: false, t: 1, duration: .3, lift: .4, phase: 0, joints: { knee: new THREE.Vector3(), ankle: new THREE.Vector3(), tarsal: new THREE.Vector3() },
      cooldown: 0, hover: 0, hoverAllowed: 1, hoverPoint: new THREE.Vector3(), clear: Infinity, pole: new THREE.Vector3(), lean: 0, leanSide: 0, tip: new THREE.Vector3(), reachRatio: 0, clearPart: 0, smoothUp: new THREE.Vector3(0, 1, 0), upReady: false,
    };
  });
  const contact: Contact = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) }, trial: Contact = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) };
  const prevAnchor = new THREE.Vector3(), velocity = new THREE.Vector3(), right = new THREE.Vector3(), basisF = new THREE.Vector3(), basisU = new THREE.Vector3(), mat = new THREE.Matrix4();
  const target = new THREE.Vector3(), ideal = new THREE.Vector3(), predicted = new THREE.Vector3(), localFoot = new THREE.Vector3(), localUp = new THREE.Vector3(), pole = new THREE.Vector3(), plan = new THREE.Vector3(), tmp = new THREE.Vector3(), shift = new THREE.Vector3();
  const hipW = new THREE.Vector3(), kneeW = new THREE.Vector3(), ankleW = new THREE.Vector3(), tarsalW = new THREE.Vector3(), rendered = new THREE.Vector3();
  const trunkPole = new THREE.Vector3(), foreAft = new THREE.Vector3();
  const invRoot = new THREE.Quaternion(), worldQ = new THREE.Quaternion(), bodyQ = new THREE.Quaternion(), turn_ = new THREE.Quaternion(), none = new THREE.Quaternion();
  let ready = false, phase = 0, speed = 0, smoothSpeed = 0, yawRate = 0, prevForwardAngle = 0, frequency = 0, nextIdleStep = 0, idleCursor = 0;
  let pitch = 0, roll = 0, rise = 0, heave = 0, sprint = 0, currentPace = 0;
  const idleOrder = [0, 5, 2, 7, 4, 1, 6, 3];

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
  function restWorld(leg: Leg, anchor: V3, cmd: SpiderCommand, yawAhead: number, out: V3) {
    if (cmd.rest) { cmd.rest(leg, anchor, right, basisF, yawAhead, out); return out; }
    const co = Math.cos(yawAhead), si = Math.sin(yawAhead);
    const x = leg.rest.x * cmd.width, z = leg.rest.z * cmd.length * (1 + sprint * .14);
    return out.copy(anchor).addScaledVector(right, x * co + z * si).addScaledVector(basisF, z * co - x * si);
  }
  /** Knees rise in the vertical plane through hip and foot. Nothing else moves them. */
  function kneePole(leg: Leg, foot: V3, fold: number, cmd: SpiderCommand, out: V3) {
    plan.set(foot.x - leg.hip.x, 0, foot.z - leg.hip.z);
    const reach = plan.length();
    // Near the hip the direction is unreliable: fade to the leg's own heading.
    plan.multiplyScalar(1 / Math.max(reach, 1e-4)).lerp(leg.outward, Math.max(.5, 1 - sstep(reach, .55, 1.4))).normalize();
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
    return r > NEAREST && r < FARTHEST && Math.abs(wrap(Math.atan2(dx, dz) - leg.azimuth)) < SECTOR;
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
    chooseFoothold(leg, cmd, swing, stance);
    leg.from.copy(leg.foot); leg.fromNormal.copy(leg.normal);
    leg.to.copy(contact.point); leg.toNormal.copy(contact.normal);
    let span = leg.from.distanceTo(leg.to);
    let duration = cmd.reachSpeed ? clamp(span / cmd.reachSpeed, swing, .85) : currentPace < 1.8 ? clamp(span / 7, swing, .9) : swing;
    if (cmd.reachSpeed && duration > swing) {
      // An unhurried reach must aim where the hip will be when it arrives, not when it set off.
      predicted.copy(cmd.anchor).addScaledVector(velocity, duration + stance * .5);
      restWorld(leg, predicted, cmd, yawRate * lead, target);
      cmd.surface(target, contact, leg.foot);
      leg.to.copy(contact.point); leg.toNormal.copy(contact.normal);
      span = leg.from.distanceTo(leg.to);
    }
    leg.swinging = true; leg.pending = false; leg.t = 0; leg.duration = duration;   // a long reach at low speed is unhurried leg.cooldown = .4;
    let need = 0;
    // Clear what is underneath, allowing for how low the arc is at each point.
    // Sampled every 12 cm or so: a longer stride must not step over a narrow ridge unseen.
    const samples = Math.max(10, Math.min(48, Math.ceil(span / .07)));
    if (!cmd.rest) for (let i = 1; i < samples; i++) {
      const t = i / samples;
      tmp.lerpVectors(leg.from, leg.to, smoother(t));
      cmd.surface(tmp, trial);
      const above = (trial.point.x - tmp.x) * trial.normal.x + (trial.point.y - tmp.y) * trial.normal.y + (trial.point.z - tmp.z) * trial.normal.z;
      need = Math.max(need, (above + .1 * K) / Math.max(arc(t), .08));
    }
    leg.lift = Math.max((.16 * K + Math.min(span, 4 * K) * .13 + leg.seedLift * .05 * K), Math.min(need, 1.8 * K));
  }
  function placeAll(cmd: SpiderCommand) {
    for (const leg of legs) {
      restWorld(leg, cmd.anchor, cmd, 0, target);
      cmd.surface(target, contact);
      leg.foot.copy(contact.point); leg.normal.copy(contact.normal); leg.from.copy(contact.point); leg.to.copy(contact.point);
      leg.fromNormal.copy(contact.normal); leg.toNormal.copy(contact.normal); leg.swinging = false; leg.pending = false; leg.t = 1;
    }
  }
  return {
    legs,
    get speed() { return smoothSpeed; },
    reset() { ready = false; },
    /** Lift a planted leg toward a world point, for slow probing. */
    hover(i: number, weight: number, point: V3) { legs[i].hover = weight; legs[i].hoverPoint.copy(point); },
    /** Worst limb clearance this frame, excluding the claw that must touch. */
    minimumClearance() { return legs.reduce((v, l) => Math.min(v, l.clear), Infinity); },
    update(dt: number, time: number, cmd: SpiderCommand) {
      setFrame(cmd);
      if (!ready) { placeAll(cmd); prevAnchor.copy(cmd.anchor); ready = true; prevForwardAngle = Math.atan2(basisF.x, basisF.z); frequency = 0; }
      dt = Math.max(dt, 1e-4);
      velocity.subVectors(cmd.anchor, prevAnchor).divideScalar(dt);
      prevAnchor.copy(cmd.anchor);
      speed = velocity.length();
      smoothSpeed = damp(smoothSpeed, speed, 10, dt);
      const angle = Math.atan2(basisF.x, basisF.z), turn = wrap(angle - prevForwardAngle);
      prevForwardAngle = angle;
      yawRate = damp(yawRate, Math.abs(basisU.y) > .6 ? -turn / dt : 0, 8, dt);

      // Scale: long, slow strides at speed. Each foot covers ground, not vibrates.
      const pace = Math.max(speed, smoothSpeed);
      currentPace = pace;
      const run = sstep(pace, 1.4, 6.5);
      sprint = damp(sprint, run, 5, dt);
      const stride = lerp(1.15, 3.4, run);
      const moving = smoothSpeed > .14 || speed > .3 || Math.abs(yawRate) > .3;
      const wanted = moving ? Math.max(.5, Math.max(pace, Math.abs(yawRate) * 1.5) / stride) : 0;
      frequency = damp(frequency, wanted, wanted > frequency ? 16 : 5, dt);
      const duty = lerp(.78, .56, sstep(pace, .8, 6));
      const wave = lerp(.1, .02, run);
      const beat = Math.max(frequency, .45);
      const stance = duty / beat, swing = clamp((1 - duty) / beat, .2, lerp(.5, .3, sstep(pace, .8, 3)));
      const previous = phase;
      phase += frequency * dt;

      root.position.copy(cmd.anchor);
      root.updateMatrixWorld(true);
      body.updateWorldMatrix(true, false);
      worldQ.copy(body.getWorldQuaternion(bodyQ)).invert();

      for (const leg of legs) leg.cooldown -= dt;
      // The rhythm calls each leg; a leg waits if a neighbour is still in the air.
      for (const leg of legs) {
        const shift_ = leg.offset + leg.index * wave * (leg.side > 0 ? 1 : .96);
        const a = fract(previous + shift_), b = fract(phase + shift_);
        leg.phase = b;
        if (frequency > .05 && (a < duty && b >= duty)) leg.pending = true;
      }
      let airborne = legs.filter(l => l.swinging).length;
      for (const leg of legs) {
        if (leg.swinging || leg.hover > .01) continue;
        tmp.copy(leg.hip); body.localToWorld(tmp);
        const reach = tmp.distanceTo(leg.foot) / (LEG_REACH * S);
        let lift = (leg.pending && airborne < 4) || reach > .96;   // the beat waits only for a free slot
        if (!lift && airborne < 4 && !neighbourSwinging(leg) && leg.cooldown <= 0) {
          lift = reach > .82;
          if (!lift && cmd.clearance && !cmd.rest && leg.clear < 1) {
            // Look a moment ahead: step before the moving body drags this limb into a trunk.
            shift.copy(velocity).multiplyScalar(.28);
            hipW.copy(leg.hip); body.localToWorld(hipW).add(shift);
            lift = cmd.clearance(hipW, tmp.copy(hipW).lerp(leg.foot, .96)) < .14;
          }
        }
        if (lift) { startSwing(leg, cmd, swing, stance); airborne++; }
      }
      // Coming to rest: settle slowly, one foot at a time, and only if it needs to.
      if (!moving) {
        nextIdleStep -= dt;
        if (nextIdleStep <= 0 && !legs.some(l => l.swinging)) {
          for (let i = 0; i < legs.length; i++) {
            const leg = legs[idleOrder[(idleCursor + i) % legs.length]];
            if (leg.hover > .01) continue;
            restWorld(leg, cmd.anchor, cmd, 0, target);
            if (target.distanceTo(leg.foot) > .55) {
              startSwing(leg, cmd, .42, .3);
              idleCursor = (idleCursor + i + 1) % legs.length; nextIdleStep = .12;
              break;
            }
          }
        }
      }
      for (const leg of legs) {
        if (!leg.swinging) continue;
        leg.t = Math.min(1, leg.t + dt / leg.duration);
        const t = leg.t;
        if (cmd.swingPath) cmd.swingPath(leg.from, leg.to, smoother(t), leg.foot);
        else leg.foot.lerpVectors(leg.from, leg.to, smoother(t));
        // Turn the claw at a steady angular rate, even between opposite sides of a trunk.
        turn_.setFromUnitVectors(leg.fromNormal, leg.toNormal);
        leg.normal.copy(leg.fromNormal).applyQuaternion(none.identity().slerp(turn_, smoother(t))).addScaledVector(basisU, .35 * Math.sin(Math.PI * t)).normalize();
        leg.foot.addScaledVector(leg.normal, leg.lift * arc(t));
        if (t === 1) { leg.foot.copy(leg.to); leg.normal.copy(leg.toNormal); leg.swinging = false; }
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
      body.position.set(0, (cmd.ride - 1.9 * S + rise + heave * .018 * S + breath - (cmd.crouch ?? 0)) / S, 0);
      body.rotation.set(-pitch + run * .035, 0, -roll + heave * .006, 'YXZ');
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
        kneePole(leg, localFoot, leg.swinging ? arc(leg.t) : 0, cmd, pole);
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
