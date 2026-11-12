import * as THREE from 'three';

type V3 = THREE.Vector3;
export type LegSample = { label: string; hip: V3; knee: V3; ankle: V3; tarsal: V3; foot: V3; footWorld: V3; swinging: boolean; pole?: V3; reachRatio?: number; contactGap?: number; lengths?: number[]; clear?: number; clearPart?: number };

const SEGMENTS = ['femur', 'tibia', 'meta', 'tarsus'] as const;
const JOINTS = ['knee', 'ankle', 'tarsal'] as const;
const RADII = [.1, .07, .04, .018];
// Solid parts of the body that a leg should stay out of, in thorax space.
const BODY: { name: string; a: number[]; b: number[]; r: number }[] = [
  { name: 'thorax', a: [0, 1.86, .55], b: [0, 1.86, -.9], r: .3 },
  { name: 'abdomen', a: [0, 1.82, -1.2], b: [0, 1.76, -2.05], r: .24 },
  { name: 'head', a: [0, 1.5, .72], b: [0, .95, .86], r: .2 },
];
const deg = (r: number) => r * 180 / Math.PI;
const TWITCH_SPEED = 45; // deg/s: slower motion cannot read as a twitch

type Channel = { max: number; values: number[] };
const channel = (): Channel => ({ max: 0, values: [] });
function note(c: Channel, v: number) { c.max = Math.max(c.max, v); c.values.push(v); }
function p95(c: Channel) { if (!c.values.length) return 0; const s = [...c.values].sort((a, b) => a - b); return s[Math.floor(s.length * .95)]; }
const fixed = (v: number, d = 1) => Number(v.toFixed(d));

function segmentDistance(p1: V3, q1: V3, p2: V3, q2: V3) {
  const d1 = new THREE.Vector3().subVectors(q1, p1), d2 = new THREE.Vector3().subVectors(q2, p2), r = new THREE.Vector3().subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), c = d1.dot(r), b = d1.dot(d2), denom = a * e - b * b;
  let s = denom > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
  let t = (b * s + f) / Math.max(e, 1e-9);
  if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / Math.max(a, 1e-9), 0, 1); }
  else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / Math.max(a, 1e-9), 0, 1); }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}

/** Records every limb, every frame, and reports exactly what moved badly. */
export function createSpiderTelemetry() {
  type Bone = { speed: Channel; twist: Channel; twitches: number; dir?: V3; normal?: V3; vel?: V3 };
  type Limb = { bones: Bone[]; joints: { min: number; max: number; rate: Channel; last?: number }[]; flips: number; inverted: number; slip: number; swings: number; shortSwings: number; tipSpeed: number; swingAge: number; wasSwinging: boolean; lastFoot?: V3; lastPose?: number[][] };
  const limbs = new Map<string, Limb>();
  const events: { frame: number; leg: string; part: string; what: string; value: number }[] = [];
  const hits = new Map<string, { frames: number; depth: number }>();
  let frame = 0, minPlanted = 99, frames = 0, airborneMost = 0, reachMost = 0, gapMost = -Infinity, breakMost = 0, floatingFrames = 0, brokenFrames = 0, overFrames = 0, floatingMost = 0;
  const treeHits = [0, 0, 0];
  const traces: { frame: number; leg: string; part: string; speed: number; before?: number[][]; after: number[][]; swinging: boolean; gap?: number }[] = [];
  const v0 = new THREE.Vector3(), q = new THREE.Quaternion();
  const event = (leg: string, part: string, what: string, value: number) => { events.push({ frame, leg, part, what, value: fixed(value) }); };
  const limbFor = (label: string) => {
    let l = limbs.get(label);
    if (!l) { l = { bones: SEGMENTS.map(() => ({ speed: channel(), twist: channel(), twitches: 0 })), joints: JOINTS.map(() => ({ min: 180, max: 0, rate: channel() })), flips: 0, inverted: 0, slip: 0, swings: 0, shortSwings: 0, tipSpeed: 0, swingAge: 0, wasSwinging: false }; limbs.set(label, l); }
    return l;
  };
  function hit(key: string, depth: number) {
    const h = hits.get(key) ?? { frames: 0, depth: 0 };
    h.frames++; h.depth = Math.max(h.depth, depth); hits.set(key, h);
  }
  return {
    sample(dt: number, samples: LegSample[]) {
      frame++; frames++;
      dt = Math.max(dt, 1e-4);
      let planted = 0;
      for (const s of samples) {
        const limb = limbFor(s.label), pts = [s.hip, s.knee, s.ankle, s.tarsal, s.foot];
        if (!s.swinging) planted++;
        const normal = new THREE.Vector3().subVectors(s.knee, s.hip).cross(v0.subVectors(s.tarsal, s.hip));
        const valid = normal.lengthSq() > 1e-8;
        if (valid) normal.normalize();
        for (let i = 0; i < 4; i++) {
          const bone = limb.bones[i], dir = new THREE.Vector3().subVectors(pts[i + 1], pts[i]).normalize();
          if (bone.dir) {
            const angle = bone.dir.angleTo(dir), speed = deg(angle) / dt;
            note(bone.speed, speed);
            const vel = new THREE.Vector3().crossVectors(bone.dir, dir);
            if (vel.lengthSq() > 1e-12) vel.normalize().multiplyScalar(speed);
            if (bone.vel && speed > TWITCH_SPEED && bone.vel.length() > TWITCH_SPEED && bone.vel.angleTo(vel) > Math.PI * .6) { bone.twitches++; event(s.label, SEGMENTS[i], 'twitch (direction reversed) deg/s', speed); }
            if (speed > 900) {
              event(s.label, SEGMENTS[i], 'bone snapped deg/s', speed);
              if (traces.length < 5 && !traces.some(t => t.leg === s.label && Math.abs(t.frame - frame) < 8)) traces.push({ frame, leg: s.label, part: SEGMENTS[i], speed: fixed(speed), before: limb.lastPose, after: pts.map(p => p.toArray().map(v => fixed(v, 3))), swinging: s.swinging, gap: s.contactGap });
            }
            bone.vel = vel;
            if (bone.normal && valid) {
              // Carry last frame's roll along the swing of the bone; what remains is spin.
              q.setFromUnitVectors(bone.dir, dir);
              const carried = bone.normal.clone().applyQuaternion(q).addScaledVector(dir, -bone.normal.clone().applyQuaternion(q).dot(dir)).normalize();
              const here = normal.clone().addScaledVector(dir, -normal.dot(dir)).normalize();
              const twist = deg(carried.angleTo(here));
              note(bone.twist, twist / dt);
              if (twist > 50) event(s.label, SEGMENTS[i], 'bone spun about its own axis deg', twist);
            }
          }
          bone.dir = dir; if (valid) bone.normal = normal.clone();
        }
        limb.lastPose = pts.map(p => p.toArray().map(v => fixed(v, 3)));
        for (let i = 0; i < 3; i++) {
          const a = v0.subVectors(pts[i], pts[i + 1]).clone().normalize(), b = v0.subVectors(pts[i + 2], pts[i + 1]).clone().normalize();
          const interior = deg(a.angleTo(b)), joint = limb.joints[i];
          joint.min = Math.min(joint.min, interior); joint.max = Math.max(joint.max, interior);
          if (joint.last !== undefined) note(joint.rate, Math.abs(interior - joint.last) / dt);
          joint.last = interior;
        }
        // The knee must sit on the raised side of the hip-to-tarsal line.
        const axis = new THREE.Vector3().subVectors(s.tarsal, s.hip).normalize();
        const off = new THREE.Vector3().subVectors(s.knee, s.hip).addScaledVector(axis, -new THREE.Vector3().subVectors(s.knee, s.hip).dot(axis));
        const raised = s.pole ? off.dot(v0.subVectors(s.pole, s.hip)) : off.y;
        if (raised < 0) { limb.inverted++; if (limb.inverted === 1) event(s.label, 'knee', 'knee inverted below the leg line', off.y); }
        if (valid && limb.bones[0].normal) { /* flip recorded below */ }
        if (limb.lastFoot) {
          const move = limb.lastFoot.distanceTo(s.footWorld);
          if (!s.swinging && !limb.wasSwinging) limb.slip = Math.max(limb.slip, move);
          if (s.swinging) limb.tipSpeed = Math.max(limb.tipSpeed, move / dt);
        }
        limb.lastFoot = (limb.lastFoot ?? new THREE.Vector3()).copy(s.footWorld);
        if (s.swinging) limb.swingAge += dt;
        if (s.swinging && !limb.wasSwinging) limb.swings++;
        if (!s.swinging && limb.wasSwinging) { if (limb.swingAge < .13) limb.shortSwings++; limb.swingAge = 0; }
        limb.wasSwinging = s.swinging;
        const prev = limb as Limb & { prevNormal?: V3 };
        if (valid) {
          if (prev.prevNormal && prev.prevNormal.dot(normal) < -.2) { limb.flips++; event(s.label, 'leg plane', 'whole leg flipped sides deg', deg(prev.prevNormal.angleTo(normal))); }
          prev.prevNormal = normal.clone();
        }
      }
      minPlanted = Math.min(minPlanted, planted);
      airborneMost = Math.max(airborneMost, samples.length - planted);
      let floating = 0, broken = 0, over = 0;
      for (const s of samples) {
        if (s.reachRatio !== undefined) { reachMost = Math.max(reachMost, s.reachRatio); if (s.reachRatio > .97) over++; }
        if (!s.swinging && s.contactGap !== undefined) { gapMost = Math.max(gapMost, s.contactGap); if (s.contactGap > .03) { floating++; event(s.label, 'foot', 'planted foot floating above surface m', s.contactGap); } }
        if (s.clear !== undefined && s.clear < 0) treeHits[s.clearPart ?? 0]++;
        if (s.lengths) {
          const pts = [s.hip, s.knee, s.ankle, s.tarsal, s.foot];
          for (let i = 0; i < 4; i++) { const err = Math.abs(pts[i].distanceTo(pts[i + 1]) - s.lengths[i]); breakMost = Math.max(breakMost, err); if (err > .01) broken++; }
        }
      }
      if (floating) floatingFrames++;
      if (broken) brokenFrames++;
      if (over) overFrames++;
      floatingMost = Math.max(floatingMost, floating);
      // Parts passing through one another.
      for (let a = 0; a < samples.length; a++) {
        const pa = [samples[a].hip, samples[a].knee, samples[a].ankle, samples[a].tarsal, samples[a].foot];
        for (let b = a + 1; b < samples.length; b++) {
          const pb = [samples[b].hip, samples[b].knee, samples[b].ankle, samples[b].tarsal, samples[b].foot];
          for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
            const depth = RADII[i] + RADII[j] - segmentDistance(pa[i], pa[i + 1], pb[j], pb[j + 1]);
            if (depth > 0) hit(`${samples[a].label}.${SEGMENTS[i]} x ${samples[b].label}.${SEGMENTS[j]}`, depth);
          }
        }
        for (const part of BODY) {
          const c1 = new THREE.Vector3().fromArray(part.a), c2 = new THREE.Vector3().fromArray(part.b);
          for (let i = 1; i < 4; i++) {
            const depth = RADII[i] + part.r - segmentDistance(pa[i], pa[i + 1], c1, c2);
            if (depth > 0) hit(`${samples[a].label}.${SEGMENTS[i]} x ${part.name}`, depth);
          }
        }
      }
    },
    report() {
      const legs = [...limbs.entries()].map(([label, l]) => ({
        leg: label, flips: l.flips, kneeInvertedFrames: l.inverted, slipMetresPerFrame: fixed(l.slip, 4), swings: l.swings, swingsUnder130ms: l.shortSwings, tipPeakSpeed: fixed(l.tipSpeed),
        bones: SEGMENTS.map((name, i) => ({ name, peakDegPerSec: fixed(l.bones[i].speed.max), p95DegPerSec: fixed(p95(l.bones[i].speed)), peakSpinDegPerSec: fixed(l.bones[i].twist.max), p95SpinDegPerSec: fixed(p95(l.bones[i].twist)), twitches: l.bones[i].twitches })),
        joints: JOINTS.map((name, i) => ({ name, minDeg: fixed(l.joints[i].min), maxDeg: fixed(l.joints[i].max), peakRate: fixed(l.joints[i].rate.max) })),
      }));
      const worstHits = [...hits.entries()].sort((a, b) => b[1].frames - a[1].frames).slice(0, 12).map(([k, v]) => ({ parts: k, frames: v.frames, deepest: fixed(v.depth, 3) }));
      const totals = {
        frames, minPlanted,
        twitches: legs.reduce((n, l) => n + l.bones.reduce((m, b) => m + b.twitches, 0), 0),
        legFlips: legs.reduce((n, l) => n + l.flips, 0),
        kneeInvertedFrames: legs.reduce((n, l) => n + l.kneeInvertedFrames, 0),
        peakBoneDegPerSec: Math.max(...legs.flatMap(l => l.bones.map(b => b.peakDegPerSec))),
        peakSpinDegPerSec: Math.max(...legs.flatMap(l => l.bones.map(b => b.peakSpinDegPerSec))),
        p95SpinDegPerSec: Math.max(...legs.flatMap(l => l.bones.map(b => b.p95SpinDegPerSec))),
        partsTouchingFrames: [...hits.values()].reduce((n, h) => n + h.frames, 0),
        shortSwings: legs.reduce((n, l) => n + l.swingsUnder130ms, 0),
        maxSlip: Math.max(...legs.map(l => l.slipMetresPerFrame)),
        peakTipSpeed: Math.max(...legs.map(l => l.tipPeakSpeed)),
        mostLegsInAir: airborneMost,
        reachPeak: fixed(reachMost, 3),
        overstretchFrames: overFrames,
        floatingFootFrames: floatingFrames,
        worstFloatingGap: fixed(gapMost === -Infinity ? 0 : gapMost, 3),
        mostFeetFloating: floatingMost,
        brokenLegFrames: brokenFrames,
        worstBoneLengthError: fixed(breakMost, 4),
        treeHitsBySegment: { femur: treeHits[0], tibia: treeHits[1], meta: treeHits[2] },
      };
      return { totals, traces, worstHits, events: [...events].sort((a, b) => b.value - a.value).slice(0, 40), eventCount: events.length, legs };
    },
  };
}
