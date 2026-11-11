import * as THREE from 'three';
import type { SolidCollider } from './collision';
import { obstacleClearance, type createCreatureNavigation } from './creature-navigation';
import { createSpiderGait, type Contact, type LimbClearance, type RestPose, type SpiderCommand, type SpiderSurface } from './spider-gait';
import { createSpiderRig, SPIDER_SCALE as S, LEG_SEGMENTS, twoBone } from './spider-rig';
import layout from './spider-rig.json';

const clamp = THREE.MathUtils.clamp, sstep = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp, damp = THREE.MathUtils.damp;
type Query = { nearby: (x: number, z: number, radius?: number) => SolidCollider[] };
type Trunk = SolidCollider & { kind: 'capsule' };

const arm = (side: 'L' | 'R') => {
  const up = layout.bones.find(b => b.name === `upperarm_${side}`)!, fo = layout.bones.find(b => b.name === `forearm_${side}`)!;
  const shoulder = new THREE.Vector3().fromArray(up.a), elbow = new THREE.Vector3().fromArray(up.b), wrist = new THREE.Vector3().fromArray(fo.b);
  return { shoulder, elbow, wrist, upper: shoulder.distanceTo(elbow), lower: elbow.distanceTo(wrist) };
};
const ARMS = { L: arm('L'), R: arm('R') };
// Twigs and the like are crushed underfoot, so they neither hold a foot nor block a leg.
const WALKABLE = new Set(['rock', 'river stone', 'fallen log', 'twig', 'stump', 'bridge timber', 'boundary stone', 'bridge deck', 'road bridge deck']);
// Metres of bark each foot wraps around from the body's side, and how far along the trunk it reaches.
const WRAP = [.78, 1.2, 1.2, .78], ALONG = [2.7, 1.05, -1.05, -2.7];

/** The Listener as it appears in the game: its model and procedural legs, driven by the encounter logic. */
export function createListener(scene: THREE.Scene, heightAt: (x: number, z: number) => number, navigation: ReturnType<typeof createCreatureNavigation>, world?: Query) {
  const root = new THREE.Group(); root.name = 'The Listener'; root.visible = false; root.scale.setScalar(S);
  const body = new THREE.Group(); root.add(body); scene.add(root);
  const rig = createSpiderRig(body), gait = createSpiderGait(root, body, rig);
  const anchor = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), forward = new THREE.Vector3(0, 0, 1), look = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const elbow = new THREE.Vector3(), wrist = new THREE.Vector3(), pole = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const gaze = { yaw: 0, pitch: 0 }, armLift: Record<'L' | 'R', number> = { L: 0, R: 0 };
  let jaw = 0, lookWeight = 1, headRoll = 0, neckLift = 0, armReach = 0, width = 1, solidsAge = 9, strike = 0;
  // Rearing (the roar before a bluff charge) and recoiling (from the torch), each 0-1 as asked, eased here.
  let rear = 0, rearing = 0, recoil = 0, recoiling = 0;
  let solids: SolidCollider[] = [], climbing: Trunk | undefined, groundBlend = 1;
  const trunks: { x: number; z: number; r: number }[] = [];

  const groundSurface: SpiderSurface = (target, out, from) => {
    // A foot still against bark (just down from a trunk) has no clear path from where it is: every route out of it
    // would be refused, every frame. It steps from where it stands to wherever is clear.
    const free = from && navigation.footClearance(from.x, from.z) > .2;
    const foot = navigation.findFoot(target.x, target.z, anchor.x, anchor.z, free ? from.x : undefined, free ? from.z : undefined);
    out.point.set(foot.x, foot.y, foot.z);
    const e = .35;
    out.normal.set(heightAt(foot.x - e, foot.z) - heightAt(foot.x + e, foot.z), 2 * e, heightAt(foot.x, foot.z - e) - heightAt(foot.x, foot.z + e)).normalize();
  };
  const trunkSurface: SpiderSurface = (target, out: Contact, from) => {
    const t = climbing!;
    const ground = heightAt(target.x, target.z), angle = Math.atan2(target.z - t.az, target.x - t.ax);
    if (target.y < ground + groundBlend + .05 && Math.hypot(target.x - t.ax, target.z - t.az) > t.radius + .25) { groundSurface(target, out, from); return; }
    const y = Math.max(ground + .1, target.y), p = t.barkContact?.(angle, y);
    if (p) out.point.set(p.x, p.y, p.z); else out.point.set(t.ax + Math.cos(angle) * t.radius, y, t.az + Math.sin(angle) * t.radius);
    out.normal.set(Math.cos(angle), 0, Math.sin(angle));
  };
  function refreshSolids(dt: number) {
    solidsAge += dt;
    if (solidsAge <= .2) return;
    solidsAge = 0;
    solids = (world?.nearby(anchor.x, anchor.z, 11) ?? []).filter(o => !o.tag?.startsWith('creature') && !WALKABLE.has(o.tag ?? ''));
    trunks.length = 0;
    for (const o of solids) {
      if (o === climbing || o.kind !== 'capsule' || o.tag !== 'tree') continue;
      const bark = o.barkContact?.(0, heightAt(o.ax, o.az) + 1.4);
      trunks.push({ x: o.ax, z: o.az, r: bark ? Math.hypot(bark.x - o.ax, bark.z - o.az) : o.radius });
    }
  }
  /** Clearance from the real tapering bark, not the wider collision envelope. */
  const clearance: LimbClearance = (p, q) => {
    const mx = (p.x + q.x) * .5, mz = (p.z + q.z) * .5, reach = Math.hypot(p.x - q.x, p.z - q.z) * .5;
    let nearest = Infinity;
    for (const o of solids) {
      if (o === climbing) continue;
      if (o.kind === 'capsule' && o.tag === 'tree') {
        if (Math.hypot(o.ax - mx, o.az - mz) > reach + o.radius + .5) continue;
        for (let i = 0; i <= 8; i++) {
          const k = i / 8, x = p.x + (q.x - p.x) * k, y = p.y + (q.y - p.y) * k, z = p.z + (q.z - p.z) * k;
          const bark = o.barkContact?.(Math.atan2(z - o.az, x - o.ax), y);
          nearest = Math.min(nearest, Math.hypot(x - o.ax, z - o.az) - (bark ? Math.hypot(bark.x - o.ax, bark.z - o.az) : o.radius));
        }
      } else {
        for (let i = 0; i <= 6; i++) {
          const k = i / 6, x = p.x + (q.x - p.x) * k, y = p.y + (q.y - p.y) * k, z = p.z + (q.z - p.z) * k;
          if (y >= o.minY && y <= o.maxY) nearest = Math.min(nearest, obstacleClearance(o, x, z));
        }
      }
    }
    return nearest;
  };
  const hugRest: RestPose = (leg, ahead, right, front, _yaw, out) => {
    const t = climbing!, angle = Math.atan2(ahead.z - t.az, ahead.x - t.ax), r = Math.max(.25, Math.hypot(ahead.x - t.ax, ahead.z - t.az));
    const tx = -Math.sin(angle), tz = Math.cos(angle);
    const u = leg.side * Math.min(WRAP[leg.index], r * 2.35), v = (ALONG[leg.index] + leg.side * .16) * S;
    const rt = right.x * tx + right.z * tz, ft = front.x * tx + front.z * tz;
    const th = angle + (u * rt + v * ft) / r, y = ahead.y + u * right.y + v * front.y;
    out.set(t.ax + Math.cos(th) * r, y, t.az + Math.sin(th) * r);
  };
  // Coming off the trunk the front legs reach for the ground first, and the rest follow in order.
  const dismountRest: RestPose = (leg, ahead, right, front, yaw, out) => {
    if (groundBlend > .12 + leg.index * .14) { out.copy(ahead).addScaledVector(right, leg.rest.x).addScaledVector(front, leg.rest.z); return; }
    hugRest(leg, ahead, right, front, yaw, out);
  };
  /** A foot crossing the trunk travels around the bark, not through the wood. */
  const aroundTrunk = (from: THREE.Vector3, to: THREE.Vector3, s: number, out: THREE.Vector3) => {
    const t = climbing!, fa = Math.atan2(from.z - t.az, from.x - t.ax), ta = Math.atan2(to.z - t.az, to.x - t.ax);
    const angle = fa + Math.atan2(Math.sin(ta - fa), Math.cos(ta - fa)) * s, r = lerp(Math.hypot(from.x - t.ax, from.z - t.az), Math.hypot(to.x - t.ax, to.z - t.az), s);
    return out.set(t.ax + Math.cos(angle) * r, lerp(from.y, to.y, s), t.az + Math.sin(angle) * r);
  };
  const command: SpiderCommand = { anchor, up, forward, surface: groundSurface, ride: 1.9 * S, width: 1, length: 1, crouch: 0, tension: 0, clearance, obstacles: trunks };

  function secondary(dt: number, time: number, lookAt: THREE.Vector3, darkness: number) {
    // Neck and head track the player: the head snaps round, the neck follows late.
    body.updateWorldMatrix(true, false);
    look.copy(lookAt); body.worldToLocal(look);
    const dx = look.x, dy = look.y - 1.25, dz = look.z - .8;
    const wantYaw = clamp(Math.atan2(dx, Math.max(.2, dz)), -1.5, 1.5) * lookWeight, wantPitch = clamp(Math.atan2(-dy, Math.hypot(dx, dz)), -.75, .9) * lookWeight;
    gaze.yaw = damp(gaze.yaw, wantYaw, 14, dt); gaze.pitch = damp(gaze.pitch, wantPitch, 14, dt);
    rig.joint('neck0', gaze.pitch * .18 - neckLift * .9, gaze.yaw * .2, headRoll * .06);
    rig.joint('neck1', gaze.pitch * .2 - neckLift * .35, gaze.yaw * .22, headRoll * .1);
    rig.joint('neck2', gaze.pitch * .24 + neckLift * .25, gaze.yaw * .24, headRoll * .16);
    rig.joint('head', gaze.pitch * .38 + neckLift * .35, gaze.yaw * .34, headRoll * .68);
    rig.joint('jaw', jaw, 0, 0);
    const breath = Math.sin(time * 1.1);
    rig.joint('abd0', .02 + breath * .02, Math.sin(time * .5) * .03, 0);
    rig.joint('abd1', .04 + breath * .03, Math.sin(time * .5 + .6) * .05, 0);
    for (const side of ['L', 'R'] as const) {
      const limb = ARMS[side], s = side === 'L' ? -1 : 1;
      wrist.copy(limb.wrist);
      wrist.y += armReach * .1 + Math.sin(time * .9 + s) * .006; wrist.z += armReach * .65; wrist.x += s * .15 - s * armReach * .06;
      // Keep the hanging fingers clear of the ground when the body rides low.
      tmp2.copy(wrist); tmp2.y -= .42; body.localToWorld(tmp2);
      const below = heightAt(tmp2.x, tmp2.z) + .1 - tmp2.y;
      armLift[side] = damp(below > 0 ? Math.max(armLift[side], below / S) : armLift[side], below > 0 ? below / S : 0, 6, dt);
      wrist.y += armLift[side];
      pole.set(limb.elbow.x + s * .5, limb.elbow.y - .1, limb.elbow.z - .4);
      twoBone(limb.shoulder, wrist, pole, limb.upper, limb.lower, elbow);
      rig.setArm(side, limb.shoulder, elbow, wrist);
      rig.joint(`hand_${side}`, .1, 0, s * .62);
      for (let f = 0; f < 5; f++) {
        const curl = .1 + Math.sin(time * 1.1 + f * .9 + s) * .03 * (1 - armReach * .5) + (f === 4 ? .08 : 0);
        rig.joint(`finger_${side}${f}_0`, curl * .8, 0, 0);
        rig.joint(`finger_${side}${f}_1`, curl, 0, 0);
        rig.joint(`finger_${side}${f}_2`, curl * 1.1, 0, 0);
      }
    }
    rig.eyes(2.1);
  }
  function step(dt: number, time: number, lookAt: THREE.Vector3, darkness: number) {
    const safe = Math.max(dt, 1 / 240);
    navigation.refresh(anchor.x, anchor.z, safe);
    refreshSolids(safe);
    gait.update(safe, time, command);
    secondary(safe, time, lookAt, darkness);
  }
  return {
    root,
    get ready() { return rig.ready; },
    movementAllowance: gait.movementAllowance,
    shoulders(left: THREE.Vector3, right: THREE.Vector3) {
      body.localToWorld(left.copy(gait.legs[0].hip));
      body.localToWorld(right.copy(gait.legs[4].hip));
    },
    feet() {
      return gait.legs.map(leg => {
        const points = [leg.hip, leg.joints.knee, leg.joints.ankle, leg.joints.tarsal].map(p => body.localToWorld(p.clone()));
        points.push(leg.tip.clone());
        return { label: leg.label, swinging: leg.swinging, position: leg.foot.toArray(), renderedPosition: leg.tip.toArray(), target: leg.to.toArray(),
          reachDistance: points[0].distanceTo(points[4]), reachError: Math.max(...LEG_SEGMENTS.map((length, i) => Math.abs(points[i].distanceTo(points[i + 1]) - length * S))),
          legClearance: leg.clear, shoulder: points[0].toArray(), knee: points[1].toArray() };
      });
    },
    reset() { gait.reset(); solidsAge = 9; width = 1; rear = rearing = recoil = recoiling = 0; },
    head() { return root.getObjectByName('head'); },
    /** On the ground, wherever the encounter logic has put it. */
    walk(dt: number, time: number, position: THREE.Vector3, yaw: number, lookAt: THREE.Vector3, darkness: number, pace = 0) {
      climbing = undefined; groundBlend = 1;
      anchor.copy(position); up.set(0, 1, 0); forward.set(Math.sin(yaw), 0, Math.cos(yaw));
      width = damp(width, navigation.stanceWidth, 2.2, Math.max(dt, 1 / 240));
      command.surface = groundSurface; command.rest = undefined; command.hug = 0; command.swingPath = undefined; command.reachSpeed = undefined;
      command.pace = pace;
      command.width = width; command.length = 1; command.ride = lerp(1.9, 1.56, sstep(gait.speed, 1.5, 7)) * S;
      const safe = Math.max(dt, 1 / 240);
      rearing = damp(rearing, rear, rear > rearing ? 7 : 4, safe); recoiling = damp(recoiling, recoil, recoil > recoiling ? 9 : 4, safe);
      // Rearing: the thorax lifts, the head goes up and the hands come forward. Recoiling: low and coiled, head drawn in.
      command.ride += (rearing * .28 - recoiling * .12) * S; command.crouch = recoiling * .22 * S; command.tension = Math.max(rearing, recoiling);
      // The grab: both hands come forward and the jaw drops for the screech.
      lookWeight = 1; neckLift = rearing * .55 - recoiling * .2; armReach = Math.max(strike, rearing * .7); headRoll = 0;
      jaw = Math.max(.05 + sstep(gait.speed, 3, 9) * .22, strike * .45, rearing * .5, recoiling * .3);
      step(dt, time, lookAt, darkness);
    },
    /** 0 at rest, 1 mid-grab. Read by walk(). */
    setStrike(amount: number) { strike = clamp(amount, 0, 1); },
    /** Read by walk(): 0-1 how far it rears up to roar, and how far it shrinks back from the torch. Eased in walk(). */
    setRear(amount: number) { rear = clamp(amount, 0, 1); },
    setRecoil(amount: number) { recoil = clamp(amount, 0, 1); },
    /** Head-down on a trunk. Landing blends it back to the ground. */
    onTree(dt: number, time: number, trunk: Trunk, position: THREE.Vector3, rotation: THREE.Quaternion, inset: number, landed: number, watching: number, lookAt: THREE.Vector3, darkness: number) {
      climbing = trunk; groundBlend = landed;
      up.set(0, 1, 0).applyQuaternion(rotation); forward.set(0, 0, 1).applyQuaternion(rotation);
      anchor.copy(position).addScaledVector(up, inset * (1 - landed));
      command.surface = trunkSurface; command.rest = dismountRest; command.hug = 1 - landed; command.reachSpeed = 5;
      command.pace = undefined;
      command.swingPath = landed < .6 ? aroundTrunk : undefined;
      command.width = lerp(.6, 1, landed); command.length = lerp(1.08, 1, landed); command.ride = lerp(1.02, 1.9 * S, landed); command.crouch = 0; command.tension = 0;
      lookWeight = 1; neckLift = .75 * (1 - landed); armReach = sstep(watching, 1, 3) * (1 - landed);
      headRoll = sstep(watching, 2.4, 3.2) * (.65 + Math.sin((watching - 2.4) * .3) * .35) * (1 - landed);
      jaw = sstep(watching, 5, 8) * .3 * (1 - landed);
      step(dt, time, lookAt, darkness);
    },
    /** How far its longest limb reaches from a point, for the rule that it never appears or vanishes on screen. */
    reach(center: THREE.Vector3) {
      let radius = 0;
      for (const leg of gait.legs) {
        radius = Math.max(radius, center.distanceTo(leg.tip) + .5, center.distanceTo(leg.foot) + .5, center.distanceTo(body.localToWorld(a.copy(leg.joints.knee))) + .6);
      }
      return radius;
    },
    limbs(add: (from: THREE.Vector3, to: THREE.Vector3, radius: number, tag: string) => void) {
      body.localToWorld(a.set(0, .9, 0)); body.localToWorld(b.set(0, 1.6, 0));
      add(a, b, .55*S/1.15, 'creature torso');
      for (const leg of gait.legs) {
        body.localToWorld(a.copy(leg.hip)); body.localToWorld(b.copy(leg.joints.knee)); body.localToWorld(c.copy(leg.joints.ankle));
        add(a, b, .14*S/1.15, 'creature upper limb');
        add(b, c, .12*S/1.15, 'creature lower limb');
        add(c, tmp.copy(leg.tip), .1*S/1.15, 'creature lower limb');
      }
    },
    dispose() { scene.remove(root); rig.dispose(); },
  };
}
