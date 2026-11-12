import * as THREE from 'three';
import type { SolidCollider } from '../sim/world/collision';
import { createCreatureNavigation, obstacleClearance } from '../sim/creature/creature-navigation';
import { createSpiderGait, type Contact, type LimbClearance, type RestPose, type SpiderCommand, type SpiderSurface } from '../render/creature/spider-gait';
import { createSpiderRig, LEG_SEGMENTS, SPIDER_SCALE as S, twoBone } from '../render/creature/spider-rig';
import layout from '../data/spider-rig.json';
import { createSpiderTelemetry, type LegSample } from './spider-telemetry';
import { roadZ } from '../sim/world/world';

type Query = { nearby: (x: number, z: number, radius?: number) => SolidCollider[] };

const clamp = THREE.MathUtils.clamp, sstep = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp, damp = THREE.MathUtils.damp;
const ease = (v: number) => { const t = clamp(v, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };

const arm = (side: 'L' | 'R') => {
  const up = layout.bones.find(b => b.name === `upperarm_${side}`)!, fo = layout.bones.find(b => b.name === `forearm_${side}`)!;
  return { shoulder: new THREE.Vector3().fromArray(up.a), elbow: new THREE.Vector3().fromArray(up.b), wrist: new THREE.Vector3().fromArray(fo.b), upper: new THREE.Vector3().fromArray(up.a).distanceTo(new THREE.Vector3().fromArray(up.b)), lower: new THREE.Vector3().fromArray(fo.a).distanceTo(new THREE.Vector3().fromArray(fo.b)) };
};
const ARMS = { L: arm('L'), R: arm('R') };

type Shot = (t: number, dt: number) => void;

/** Dev-only stage for reviewing the creature inside the real forest and light. */
export function createSpiderLab(options: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; heightAt: (x: number, z: number) => number; world: Query; setHours: (h: number) => void; teleport: (x: number, z: number) => void; equip: () => void; markShadows: () => void; darkness: () => number }) {
  const { scene, camera, heightAt, world } = options;
  const root = new THREE.Group(); root.name = 'Listener v2 root';
  const body = new THREE.Group(); root.add(body); scene.add(root);
  root.scale.setScalar(S);
  const rig = createSpiderRig(body), gait = createSpiderGait(root, body, rig);
  // Twigs are neither footholds nor obstacles: something this heavy just crushes them.
  const navigation = createCreatureNavigation(heightAt, { nearby: (x, z, r) => world.nearby(x, z, r).filter(c => c.tag !== 'twig') });
  const anchor = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), forward = new THREE.Vector3(0, 0, 1), look = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  const elbow = new THREE.Vector3(), wrist = new THREE.Vector3(), pole = new THREE.Vector3();
  let shotName = '', time = 0, shot: Shot | undefined, shotTime = 0, jaw = 0, lookWeight = 1, headRoll = 0, neckLift = 0, armReach = 0, eyes = 3.2;
  const gaze = { yaw: 0, pitch: 0 };
  const armLift: Record<'L' | 'R', number> = { L: 0, R: 0 };
  let fixedCam: number[] | undefined;
  const groundSurface: SpiderSurface = (target, out, from) => {
    const foot = navigation.findFoot(target.x, target.z, anchor.x, anchor.z, from?.x, from?.z);
    out.point.set(foot.x, foot.y, foot.z);
    const e = .35;
    out.normal.set(heightAt(foot.x - e, foot.z) - heightAt(foot.x + e, foot.z), 2 * e, heightAt(foot.x, foot.z - e) - heightAt(foot.x, foot.z + e)).normalize();
  };
  // Measured against the real tapering bark, not the wider collision envelope.
  const WALKABLE = new Set(['rock', 'river stone', 'fallen log', 'twig', 'stump', 'bridge timber', 'boundary stone', 'bridge deck']);
  let solids: SolidCollider[] = [], solidsAge = 9, climbing: SolidCollider | undefined;
  const trunks: { x: number; z: number; r: number }[] = [];
  const refreshSolids = (dt: number) => {
    solidsAge += dt;
    if (solidsAge > .2) {
      solidsAge = 0;
      solids = world.nearby(anchor.x, anchor.z, 11).filter(c => !c.tag?.startsWith('creature') && !WALKABLE.has(c.tag ?? ''));
      trunks.length = 0;
      for (const o of solids) {
        if (o === climbing || o.kind !== 'capsule' || o.tag !== 'tree') continue;
        const bark = o.barkContact?.(0, heightAt(o.ax, o.az) + 1.4);
        trunks.push({ x: o.ax, z: o.az, r: bark ? Math.hypot(bark.x - o.ax, bark.z - o.az) : o.radius });
      }
    }
  };
  const realClearance = (exclude?: SolidCollider): LimbClearance => (a, b) => {
    const mx = (a.x + b.x) * .5, mz = (a.z + b.z) * .5, reach = Math.hypot(a.x - b.x, a.z - b.z) * .5;
    let nearest = Infinity;
    for (const o of solids) {
      if (o === exclude) continue;
      if (o.kind === 'capsule' && o.tag === 'tree') {
        if (Math.hypot(o.ax - mx, o.az - mz) > reach + o.radius + .5) continue;
        for (let i = 0; i <= 8; i++) {
          const k = i / 8, x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k, z = a.z + (b.z - a.z) * k;
          const angle = Math.atan2(z - o.az, x - o.ax), bark = o.barkContact?.(angle, y);
          const radius = bark ? Math.hypot(bark.x - o.ax, bark.z - o.az) : o.radius;
          nearest = Math.min(nearest, Math.hypot(x - o.ax, z - o.az) - radius);
        }
      } else {
        for (let i = 0; i <= 6; i++) {
          const k = i / 6, x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k, z = a.z + (b.z - a.z) * k;
          if (y >= o.minY && y <= o.maxY) nearest = Math.min(nearest, obstacleClearance(o, x, z));
        }
      }
    }
    return nearest;
  };
  const groundClearance = realClearance();
  const command: SpiderCommand = { anchor, up, forward, surface: groundSurface, ride: 1.9 * S, width: 1, length: 1, crouch: 0, tension: 0, clearance: groundClearance, obstacles: trunks };
  let worst = Infinity, frames = 0, touching = 0, heading = 0, steering = false, width = 1;
  let telemetry: ReturnType<typeof createSpiderTelemetry> | undefined;
  type WrapStats = { radius: number; height: number; legs: { leg: string; angle: number[]; along: number[] }[]; nearest: number[]; closest: number; through: number; deepest: number; frames: number; label: string; bySegment: number[] };
  let climbStats: WrapStats | undefined, measureWrap: (() => void) | undefined;

  function secondary(dt: number) {
    // Neck and head track the camera; the head snaps, the neck follows late.
    body.updateWorldMatrix(true, false);
    look.copy(camera.position); body.worldToLocal(look);
    const dx = look.x, dy = look.y - 1.25, dz = look.z - .8;
    const wantYaw = clamp(Math.atan2(dx, Math.max(.2, dz)), -1.5, 1.5) * lookWeight;
    const wantPitch = clamp(Math.atan2(-dy, Math.hypot(dx, dz)), -.75, .9) * lookWeight;
    gaze.yaw = damp(gaze.yaw, wantYaw, 14, dt); gaze.pitch = damp(gaze.pitch, wantPitch, 14, dt);
    const lift = neckLift;
    rig.joint('neck0', gaze.pitch * .18 - lift * .9, gaze.yaw * .2, headRoll * .06);
    rig.joint('neck1', gaze.pitch * .2 - lift * .35, gaze.yaw * .22, headRoll * .1);
    rig.joint('neck2', gaze.pitch * .24 + lift * .25, gaze.yaw * .24, headRoll * .16);
    rig.joint('head', gaze.pitch * .38 + lift * .35, gaze.yaw * .34, headRoll * .68);
    rig.joint('jaw', jaw, 0, 0);
    // Slow abdomen sag and breath.
    const b = Math.sin(time * 1.1);
    rig.joint('abd0', .02 + b * .02, Math.sin(time * .5) * .03, 0);
    rig.joint('abd1', .04 + b * .03, Math.sin(time * .5 + .6) * .05, 0);
    for (const side of ['L', 'R'] as const) {
      const a = ARMS[side], s = side === 'L' ? -1 : 1;
      const twitch = Math.sin(time * .9 + s) * .006;
      wrist.copy(a.wrist);
      wrist.y += armReach * .1 + twitch; wrist.z += armReach * .65; wrist.x += s * .15 - s * armReach * .06;
      // Keep the hanging fingers clear of the ground when the body rides low.
      tmp2.copy(wrist); tmp2.y -= .42; body.localToWorld(tmp2);
      const below = heightAt(tmp2.x, tmp2.z) + .1 - tmp2.y;
      if (below > 0) { armLift[side] = Math.max(armLift[side], below / S); }
      armLift[side] = damp(armLift[side], below > 0 ? below / S : 0, 6, dt);
      wrist.y += armLift[side];
      pole.set(a.elbow.x + s * .5, a.elbow.y - .1, a.elbow.z - .4);
      twoBone(a.shoulder, wrist, pole, a.upper, a.lower, elbow);
      rig.setArm(side, a.shoulder, elbow, wrist);
      // Wrists go limp, so the fingers fall straight down instead of reaching inward.
      rig.joint(`hand_${side}`, .1, 0, s * .62);
      for (let f = 0; f < 5; f++) {
        const ripple = Math.sin(time * 1.1 + f * .9 + s) * .03 * (1 - armReach * .5);
        const curl = .1 + ripple + (f === 4 ? .08 : 0);
        rig.joint(`finger_${side}${f}_0`, curl * .8, 0, 0);
        rig.joint(`finger_${side}${f}_1`, curl, 0, 0);
        rig.joint(`finger_${side}${f}_2`, curl * 1.1, 0, 0);
      }
    }
    rig.eyes(eyes * (1 + 13 * sstep(options.darkness(), .12, .7)));
  }
  /** How far a claw tip sits off the real surface under it; negative means pressed in. */
  function contactGap(tip: THREE.Vector3, normal: THREE.Vector3) {
    if (climbing && Math.abs(normal.y) < .5 && climbing.kind === 'capsule') {
      const angle = Math.atan2(tip.z - climbing.az, tip.x - climbing.ax), bark = climbing.barkContact?.(angle, tip.y);
      if (bark) return Math.hypot(tip.x - climbing.ax, tip.z - climbing.az) - Math.hypot(bark.x - climbing.ax, bark.z - climbing.az);
    }
    return tip.y - navigation.supportAt(tip.x, tip.z);
  }
  function step(dt: number) {
    navigation.refresh(anchor.x, anchor.z, dt);
    refreshSolids(dt);
    gait.update(dt, time, command);
    const clear = gait.minimumClearance();
    worst = Math.min(worst, clear); frames++; if (clear < 0) touching++;
    if (telemetry) {
      telemetry.sample(dt, gait.legs.map((l): LegSample => {
        const local = tmp.copy(l.tip);
        body.worldToLocal(local);
        return { label: l.label, hip: l.hip, knee: l.joints.knee, ankle: l.joints.ankle, tarsal: l.joints.tarsal, foot: local.clone(), footWorld: l.foot, swinging: l.swinging || l.hover > .02, pole: l.pole, reachRatio: l.reachRatio, lengths: LEG_SEGMENTS, contactGap: contactGap(l.tip, l.normal), clear: l.clear, clearPart: l.clearPart };
      }));
    }
    secondary(dt);
  }

  function setAnchor(x: number, z: number) { anchor.set(x, heightAt(x, z), z); }
  /** Steer the body toward a heading at a limited rate, and narrow stance gradually. */
  function steer(yaw: number, dt: number) {
    if (!steering) { heading = Math.atan2(forward.x, forward.z); steering = true; }
    const error = Math.atan2(Math.sin(yaw - heading), Math.cos(yaw - heading));
    heading += clamp(error, -2.6 * dt, 2.6 * dt);
    forward.set(Math.sin(heading), 0, Math.cos(heading));
    width = damp(width, navigation.stanceWidth, 2.2, dt);
    command.width = width;
  }
  function placeCam(x: number, y: number, z: number, tx: number, ty: number, tz: number, fov = 42) {
    camera.position.set(x, y, z);
    camera.up.set(0, 1, 0); camera.fov = fov; camera.updateProjectionMatrix();
    camera.lookAt(tx, ty, tz);
  }
  const groundCamHeight = (x: number, z: number, h: number) => heightAt(x, z) + h;

  const dist = (c: SolidCollider, p: THREE.Vector3) => c.kind === 'capsule' ? Math.hypot((c.ax + c.bx) * .5 - p.x, (c.az + c.bz) * .5 - p.z) : Math.hypot(c.x - p.x, c.z - p.z);
  function tree(from: THREE.Vector3, thin = false): (SolidCollider & { kind: 'capsule' }) | undefined {
    const options_ = world.nearby(from.x, from.z, 26).filter((c): c is SolidCollider & { kind: 'capsule' } => c.kind === 'capsule' && c.tag === 'tree' && c.maxY - c.minY > (thin ? 10 : 22) && c.radius > (thin ? .3 : .42));
    options_.sort((a, b) => thin ? a.radius - b.radius : Math.hypot(a.ax - from.x, a.az - from.z) - Math.hypot(b.ax - from.x, b.az - from.z));
    return options_[0];
  }
  function trunkSurface(c: SolidCollider & { kind: 'capsule' }, blendGround: () => number): SpiderSurface {
    return (target, out: Contact) => {
      const ground = heightAt(target.x, target.z);
      const a = Math.atan2(target.z - c.az, target.x - c.ax);
      if (target.y < ground + 1.0 * blendGround() + .05 && Math.hypot(target.x - c.ax, target.z - c.az) > c.radius + .25) {
        groundSurface(target, out); return;
      }
      const y = Math.max(ground + .1, target.y);
      const p = c.barkContact?.(a, y);
      if (p) out.point.set(p.x, p.y, p.z); else out.point.set(c.ax + Math.cos(a) * c.radius, y, c.az + Math.sin(a) * c.radius);
      out.normal.set(Math.cos(a), 0, Math.sin(a));
    };
  }

  // --- shots ---------------------------------------------------------------
  const shots: Record<string, (ox: number, oz: number, thin?: boolean, perch?: boolean) => Shot> = {
    climbThin(ox, oz) { return shots.climb(ox, oz, true); },
    /** Already head-down on the trunk, as the real tree encounter begins. */
    perch(ox, oz) { return shots.climb(ox, oz, false, true); },
    perchThin(ox, oz) { return shots.climb(ox, oz, true, true); },
    pose(ox, oz) {
      setAnchor(ox, oz); forward.set(0, 0, 1);
      return () => { step(1 / 60); };
    },
    /** Slow stalk along the open road, watched from the verge. */
    walk(ox) {
      navigation.reset();
      setAnchor(ox, roadZ(ox)); forward.set(1, 0, 0);
      return (t, dt) => {
        const ahead = anchor.x + 6, dx = ahead - anchor.x, dz = roadZ(ahead) - anchor.z;
        const moved = navigation.move(anchor, dx, dz, 1.05, dt);
        anchor.set(moved.x, heightAt(moved.x, moved.z), moved.z);
        steer(moved.yaw, dt); lookWeight = 1; jaw = .05;
        step(dt);
        const cx = anchor.x - 2.5, cz = anchor.z + 10.5;
        placeCam(cx, groundCamHeight(cx, cz, 1.69), cz, anchor.x + 1, anchor.y + 1.7, anchor.z, 46);
      };
    },
    /** Dead still, far down the road. Then it charges and stops dead at you. */
    run(ox) {
      navigation.reset();
      setAnchor(ox, roadZ(ox)); forward.set(1, 0, 0);
      const camX = ox + 34, stopAt = camX - 7.5;
      let dashSpeed = 0;
      const cam = new THREE.Vector3(camX, 0, roadZ(camX));
      return (t, dt) => {
        const dash = t > 1.8 && anchor.x < stopAt;
        const ahead = anchor.x + 8, dx = ahead - anchor.x, dz = roadZ(ahead) - anchor.z;
        dashSpeed = dash ? Math.min(6.6, dashSpeed + 4.2 * dt) : Math.max(0, dashSpeed - 12 * dt);
        const moved = navigation.move(anchor, dx, dz, dashSpeed, dt);
        anchor.set(moved.x, heightAt(moved.x, moved.z), moved.z);
        if (dash) steer(moved.yaw, dt); command.ride = lerp(1.9, 1.56, sstep(gait.speed, 1.5, 7)) * S; lookWeight = 1;
        jaw = .06 + sstep(gait.speed, 3, 9) * .22;
        headRoll = anchor.x >= stopAt ? sstep(t, 8, 9.5) * -.7 : 0;
        step(dt);
        placeCam(cam.x, groundCamHeight(cam.x, cam.z, 1.69), cam.z, anchor.x, anchor.y + 1.15, anchor.z, 50);
      };
    },
    /** Threads the densest part of the forest; every limb must miss every trunk. */
    forest(ox, oz) {
      navigation.reset();
      const spawn = navigation.safeSpawn(ox, oz);
      setAnchor(spawn?.x ?? ox, spawn?.z ?? oz); forward.set(0, 0, 1);
      return (t, dt) => {
        const moved = navigation.move(anchor, Math.sin(t * .13 + .4), Math.cos(t * .13 + .4), 1.25, dt);
        anchor.set(moved.x, heightAt(moved.x, moved.z), moved.z);
        steer(moved.yaw, dt); lookWeight = 1; jaw = .05;
        step(dt);
        const cx = anchor.x + 3, cz = anchor.z + 7.5;
        placeCam(cx, groundCamHeight(cx, cz, 1.69), cz, anchor.x, anchor.y + 1.3, anchor.z, 58);
      };
    },
    /** Walks straight over a fallen log, filmed from along the log. */
    obstacle(ox, oz) {
      navigation.reset();
      const here = new THREE.Vector3(ox, heightAt(ox, oz), oz);
      const logs = world.nearby(ox, oz, 60).filter((c): c is SolidCollider & { kind: 'capsule' } => c.kind === 'capsule' && c.tag === 'fallen log' && Math.hypot(c.bx - c.ax, c.bz - c.az) > 3);
      logs.sort((a, b) => dist(a, here) - dist(b, here));
      const treesAround = (x: number, z: number, r: number) => world.nearby(x, z, r).filter(t => t.tag === 'tree' && t.kind === 'capsule' && Math.hypot(t.ax - x, t.az - z) < r + t.radius).length;
      const c = logs.find(l => treesAround((l.ax + l.bx) * .5, (l.az + l.bz) * .5, 3.2) === 0) ?? logs[0];
      if (!c) throw new Error('No fallen log in range');
      const mx = (c.ax + c.bx) * .5, mz = (c.az + c.bz) * .5, ax = new THREE.Vector3(c.bx - c.ax, 0, c.bz - c.az).normalize();
      const across = new THREE.Vector3(-ax.z, 0, ax.x);
      setAnchor(mx - across.x * 8, mz - across.z * 8); forward.copy(across);
      const candidates = [[9.5, 2.2], [-9.5, 2.2], [9.5, -2.2], [-9.5, -2.2], [6.5, 6], [-6.5, 6], [6.5, -6], [-6.5, -6]].map(([u, v]) => new THREE.Vector3(mx + ax.x * u + across.x * v, 0, mz + ax.z * u + across.z * v));
      const blocked = (q: THREE.Vector3) => world.nearby((q.x + mx) * .5, (q.z + mz) * .5, 9).filter(t => {
        if (t.tag !== 'tree' || t.kind !== 'capsule') return false;
        const lx = mx - q.x, lz = mz - q.z, l2 = lx * lx + lz * lz, k = clamp(((t.ax - q.x) * lx + (t.az - q.z) * lz) / l2, 0, 1);
        return Math.hypot(t.ax - q.x - lx * k, t.az - q.z - lz * k) < t.radius + 1.3;
      }).length;
      const cam = candidates.sort((p, q) => blocked(p) - blocked(q))[0];
      return (t, dt) => {
        const moved = navigation.move(anchor, across.x, across.z, 1.1, dt);
        anchor.set(moved.x, heightAt(moved.x, moved.z), moved.z);
        steer(moved.yaw, dt); lookWeight = .6;
        step(dt);
        placeCam(cam.x, groundCamHeight(cam.x, cam.z, 1.3), cam.z, anchor.x, anchor.y + .8, anchor.z, 56);
      };
    },
    /** Almost nothing moves. Then one leg slowly lifts, feels the air, and sets down. */
    idle(ox, oz) {
      navigation.reset(); setAnchor(ox, oz); forward.set(0, 0, 1);
      const a = new THREE.Vector3();
      const order = [0, 4];
      return (t, dt) => {
        step(dt);
        lookWeight = 1;
        headRoll = sstep(t, 3.5, 7) * (.8 + Math.sin(t * .25) * .12);
        jaw = sstep(t, 8, 12) * .2;
        const cycle = 5.2;
        const n = Math.floor(t / cycle), k = (t % cycle) / cycle;
        gait.hover(order[(n + 1) % 2], 0, a);
        const leg = order[n % 2], l = gait.legs[leg];
        const raise = ease(clamp(k / .28, 0, 1)) * (1 - ease(clamp((k - .62) / .3, 0, 1)));
        a.copy(l.foot).addScaledVector(up, .95).addScaledVector(forward, .5 + Math.sin(k * 7) * .05);
        gait.hover(leg, raise, a);
        const cx = anchor.x + 2.5, cz = anchor.z + 8;
        placeCam(cx, groundCamHeight(cx, cz, 1.69), cz, anchor.x, anchor.y + 1.1, anchor.z, 42);
      };
    },
    approach(ox, oz) {
      navigation.reset();
      const cam = new THREE.Vector3(ox, 0, oz);
      const start = new THREE.Vector3(ox, 0, oz - 22);
      setAnchor(start.x, start.z); forward.set(0, 0, 1);
      return (t, dt) => {
        const v = t < 2.4 ? 0 : t < 12 ? 1.25 : 0;
        const moved = navigation.move(anchor, cam.x - anchor.x, cam.z - anchor.z, v, dt);
        anchor.set(moved.x, heightAt(moved.x, moved.z), moved.z);
        steer(moved.yaw, dt); lookWeight = 1;
        jaw = lerp(0, .34, sstep(t, 11.5, 14.5)); headRoll = lerp(0, -.5, sstep(t, 12, 14)) + Math.sin(t * .8) * .02;
        step(dt);
        placeCam(cam.x + 1.4, groundCamHeight(cam.x, cam.z, 1.69), cam.z, anchor.x, anchor.y + 1.75, anchor.z, 58);
      };
    },
    climb(ox, oz, thin = false, perch = false) {
      navigation.reset();
      const here = new THREE.Vector3(ox, heightAt(ox, oz), oz);
      const c = tree(here, thin);
      if (!c) throw new Error('No suitable tree in range');
      const base = heightAt(c.ax, c.az);
      // Approach from whichever side has the longest open sightline.
      const sightline = (a: number) => {
        let nearest = 16;
        for (const o of world.nearby(c.ax, c.az, 18)) {
          if (o === c || o.kind !== 'capsule' || o.tag !== 'tree') continue;
          const px = o.ax - c.ax, pz = o.az - c.az, along = px * Math.cos(a) + pz * Math.sin(a);
          if (along < 0 || along > 14) continue;
          if (Math.abs(px * Math.sin(a) - pz * Math.cos(a)) < o.radius + 1.6) nearest = Math.min(nearest, along);
        }
        return nearest;
      };
      let a0 = Math.atan2(oz - c.az, ox - c.ax), best = sightline(a0);
      for (let i = 1; i < 16; i++) { const a = a0 + i * Math.PI / 8, d = sightline(a); if (d > best + .5) { best = d; a0 = a; } }
      const radial = new THREE.Vector3(Math.cos(a0), 0, Math.sin(a0));
      const startDist = c.radius + 9, footDist = c.radius + 2.2;
      const start = new THREE.Vector3(c.ax + radial.x * startDist, 0, c.az + radial.z * startDist);
      setAnchor(start.x, start.z); forward.set(-radial.x, 0, -radial.z);
      let phase = perch ? 1 : 0, climbH = 1.8, angle = a0, facing = 1, flipT = 0, groundBlend = perch ? 0 : 1;
      const trunkAnchor = (a: number, h: number, out: THREE.Vector3) => {
        const y = base + h, p = c.barkContact?.(a, y);
        if (p) out.set(p.x, p.y, p.z); else out.set(c.ax + Math.cos(a) * c.radius, y, c.az + Math.sin(a) * c.radius);
        return out;
      };
      const surface = trunkSurface(c, () => groundBlend);
      // Metres of bark each foot wraps around from the body's side, and how far
      // along the trunk it reaches. Same spacing on any trunk: thin ones wrap deeper.
      const WRAP = [.78, 1.2, 1.2, .78], ALONG = [2.7, 1.05, -1.05, -2.7];
      const hugRest: RestPose = (leg, ahead, right, front, _yaw, out) => {
        const a = Math.atan2(ahead.z - c.az, ahead.x - c.ax), r = Math.max(.25, Math.hypot(ahead.x - c.ax, ahead.z - c.az));
        const tx = -Math.sin(a), tz = Math.cos(a);
        const u = leg.side * Math.min(WRAP[leg.index], r * 2.35), v = (ALONG[leg.index] + leg.side * .16) * S;
        const rt = right.x * tx + right.z * tz, ft = front.x * tx + front.z * tz;
        const th = a + (u * rt + v * ft) / r, y = ahead.y + u * right.y + v * front.y;
        out.set(c.ax + Math.cos(th) * r, y, c.az + Math.sin(th) * r);
      };
      // Front legs reach for the bark first and the rest follow in order, so the
      // rear legs are never left stretched behind a body that has already turned.
      let mountProgress = 0;
      const mountRest: RestPose = (leg, ahead, right, front, yaw, out) => {
        if (mountProgress > .22 + leg.index * .14) { hugRest(leg, ahead, right, front, yaw, out); return; }
        out.copy(ahead).addScaledVector(right, leg.rest.x).addScaledVector(front, leg.rest.z);
      };
      // A foot crossing the trunk travels around the bark, not through the wood.
      const aroundTrunk = (from: THREE.Vector3, to: THREE.Vector3, s: number, out: THREE.Vector3) => {
        const fa = Math.atan2(from.z - c.az, from.x - c.ax), ta = Math.atan2(to.z - c.az, to.x - c.ax);
        const a = fa + Math.atan2(Math.sin(ta - fa), Math.cos(ta - fa)) * s, r = lerp(Math.hypot(from.x - c.ax, from.z - c.az), Math.hypot(to.x - c.ax, to.z - c.az), s);
        return out.set(c.ax + Math.cos(a) * r, lerp(from.y, to.y, s), c.az + Math.sin(a) * r);
      };
      const otherTrees = realClearance(c);
      climbing = c;
      climbStats = { radius: c.radius, height: c.maxY - c.minY, legs: gait.legs.map(l => ({ leg: l.label, angle: [] as number[], along: [] as number[] })), nearest: [] as number[], closest: Infinity, through: 0, deepest: 0, frames: 0, label: 'climb', bySegment: [0, 0, 0] };
      const trunkClear = realClearance(undefined), onlyTrunk: LimbClearance = (p, q) => {
        const saved = solids; solids = [c]; const v = trunkClear(p, q); solids = saved; return v;
      };
      const hipW = new THREE.Vector3(), kneeW = new THREE.Vector3(), ankleW = new THREE.Vector3(), tarsalW = new THREE.Vector3();
      measureWrap = () => {
        const stats = climbStats!;
        const body0 = Math.atan2(anchor.z - c.az, anchor.x - c.ax);
        stats.frames++;
        let deepest = Infinity;
        gait.legs.forEach((l, i) => {
          const a = Math.atan2(l.foot.z - c.az, l.foot.x - c.ax), off = Math.atan2(Math.sin(a - body0), Math.cos(a - body0)) * 180 / Math.PI;
          stats.legs[i].angle.push(off); stats.legs[i].along.push(l.foot.y - anchor.y);
          hipW.copy(l.hip); body.localToWorld(hipW); kneeW.copy(l.joints.knee); body.localToWorld(kneeW);
          ankleW.copy(l.joints.ankle); body.localToWorld(ankleW); tarsalW.copy(l.joints.tarsal); body.localToWorld(tarsalW);
          const seg = [onlyTrunk(hipW, kneeW), onlyTrunk(kneeW, ankleW), onlyTrunk(ankleW, tarsalW)];
          seg.forEach((v, k) => { if (v < 0) stats.bySegment[k]++; });
          deepest = Math.min(deepest, ...seg);
        });
        if (deepest < 0) { stats.through++; stats.deepest = Math.min(stats.deepest, deepest); }
        let low = Infinity, sum = 0;
        gait.legs.forEach(l => {
          let best = Infinity;
          for (const o of gait.legs) if (o !== l) best = Math.min(best, l.foot.distanceTo(o.foot));
          low = Math.min(low, best); sum += best;
        });
        stats.closest = Math.min(stats.closest, low); stats.nearest.push(sum / gait.legs.length);
      };
      // It only trusts wood thick enough to carry it, measured on the real bark.
      const MIN_BARK_RADIUS = .3;
      const barkRadius = (h: number) => {
        const p = c.barkContact?.(a0, base + h);
        return p ? Math.hypot(p.x - c.ax, p.z - c.az) : c.radius * clamp(1 - h / 34, 0, 1);
      };
      let strongest = 2.0;
      while (strongest < 30 && barkRadius(strongest + .5) >= MIN_BARK_RADIUS) strongest += .5;
      const camA = a0 + .34, camD = c.radius + 6.6;
      const cam = new THREE.Vector3(c.ax + Math.cos(camA) * camD, 0, c.az + Math.sin(camA) * camD);
      const footPoint = new THREE.Vector3(c.ax + radial.x * footDist, 0, c.az + radial.z * footDist);
      const mountDur = perch ? 0 : 5, walkEnd = perch ? 0 : (startDist - footDist) / 1.6;
      return (t, dt) => {
        command.surface = surface;
        command.clearance = t < walkEnd - 2.4 ? groundClearance : otherTrees;
        if (!perch && t < walkEnd) {
          const d = lerp(startDist, footDist, t / walkEnd);
          setAnchor(c.ax + radial.x * d, c.az + radial.z * d);
          command.ride = 1.9 * S;
        } else if (!perch && t < walkEnd + mountDur) {
          const m = ease((t - walkEnd) / mountDur);
          groundBlend = 1 - sstep(m, .1, .7);
          trunkAnchor(a0, lerp(.2, 1.9, m), tmp);
          tmp2.set(footPoint.x, heightAt(footPoint.x, footPoint.z), footPoint.z);
          const blend = sstep(m, 0, 1);
          anchor.lerpVectors(tmp2, tmp, blend);
          const rx = radial.x, rz = radial.z;
          up.set(lerp(0, rx, sstep(m, .1, .9)), lerp(1, 0, sstep(m, .1, .9)), lerp(0, rz, sstep(m, .1, .9))).normalize();
          forward.set(lerp(-rx, 0, sstep(m, .1, .9)), lerp(0, 1, sstep(m, .1, .9)), lerp(-rz, 0, sstep(m, .1, .9))).normalize();
          command.ride = lerp(1.9 * S, 1.02, m); command.width = lerp(1, .6, m); command.length = lerp(1, 1.08, m); neckLift = sstep(m, .2, 1) * .75;
          mountProgress = m; command.rest = mountRest; command.hug = sstep(m, .3, .95); command.reachSpeed = 4.6; command.swingPath = aroundTrunk;
        } else {
          groundBlend = 0;
          const after = t - walkEnd - mountDur;
          const climbTop = Math.min(5.4, strongest), climbTime = (climbTop - 1.9) / 1.3;
          if (perch) {
            // Head-down from the start. It holds, then slips round the trunk out of sight.
            climbH = climbTop; flipT = 0;
            phase = after > 12 ? 2 : 1;
            if (phase === 2) angle = a0 + ease((after - 12) / 5) * Math.PI;
          } else {
            climbH = Math.min(climbTop, 1.9 + after * 1.3);
            if (after >= climbTime + 1.2) { phase = 2; const go = after - climbTime - 1.2; angle = a0 + Math.min(Math.PI, go * .7); climbH = Math.min(strongest, climbTop + go * .5); }
          }
          const flip = perch ? 1 : 0;
          trunkAnchor(angle, climbH, anchor);
          const rn = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
          up.copy(rn);
          const tangent = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), rn);
          const fa = flip * Math.PI;
          forward.set(0, 1, 0).multiplyScalar(Math.cos(fa)).addScaledVector(tangent, Math.sin(fa));
          facing = forward.y;
          command.ride = 1.02; command.rest = hugRest; command.hug = 1; neckLift = .75; command.reachSpeed = 5; command.swingPath = aroundTrunk;
          lookWeight = phase === 0 ? .3 : 1;
          const staring = phase === 1 ? sstep(t - flipT, 2.4, 3.2) : 0;
          armReach = sstep(t - flipT, 1, 3) * (phase === 1 ? 1 : 0);
          headRoll = staring * (.65 + Math.sin((t - flipT - 2.4) * .3) * .35);
          jaw = staring * sstep(t - flipT, 5, 8) * .3;
        }
        step(dt);
        if (t > (perch ? .8 : walkEnd + mountDur + .5)) measureWrap?.();
        const stare = phase === 1 ? sstep(t - flipT, 2.2, 5.5) * (1 - sstep(t - flipT, 10, 11)) : 0;
        const lookY = lerp(Math.min(anchor.y + .2, base + 8), anchor.y - 1.05, stare);
        placeCam(cam.x, groundCamHeight(cam.x, cam.z, 1.69), cam.z, anchor.x, lookY, anchor.z, lerp(56, 25, stare));
      };
    },
  };

  return {
    root, rig, gait,
    get ready() { return rig.ready; },
    trees(x: number, z: number) { return world.nearby(x, z, 30).filter(c => c.tag === 'tree').length; },
    begin(name: string, x: number, z: number) {
      fixedCam = undefined; steering = false; width = 1; gait.reset(); time = 0; shotTime = 0; jaw = 0; lookWeight = 1; headRoll = 0; neckLift = 0; armReach = 0; up.set(0, 1, 0);
      Object.assign(command, { surface: groundSurface, ride: 1.9 * S, width: 1, length: 1, crouch: 0, tension: 0, clearance: groundClearance, rest: undefined, poleWide: undefined, obstacles: trunks, hug: 0, swingPath: undefined, reachSpeed: undefined });
      climbing = undefined;
      worst = Infinity; frames = touching = 0; solidsAge = 9; telemetry = createSpiderTelemetry(); climbStats = undefined; measureWrap = undefined;
      shotName = name; shot = shots[name](x, z);
    },
    /** Hold a camera relative to the creature's anchor until the next begin(). */
    still(camX: number, camY: number, camZ: number, tx: number, ty: number, tz: number, fov = 42) {
      // Portraits square up to the camera, and only re-plant feet when it moves.
      const moved = !fixedCam || fixedCam[0] !== camX || fixedCam[2] !== camZ;
      fixedCam = [camX, camY, camZ, tx, ty, tz, fov];
      if (moved && shotName === 'pose') { forward.set(camX, 0, camZ).normalize(); gait.reset(); }
    },
    equipFlash() { options.equip(); },
    /** Degrees between where the face points and the camera. */
    gazeError() {
      const head = rig.model?.getObjectByName('head');
      if (!head) return null;
      rig.headForward(tmp);
      head.getWorldPosition(tmp2);
      return Number((tmp.angleTo(tmp2.subVectors(camera.position, tmp2)) * 180 / Math.PI).toFixed(1));
    },
    /** Debug: what is under the screen centre? */
    pick() {
      const model = rig.model; if (!model) return null;
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(0, 0), camera);
      const hits = ray.intersectObject(model, true);
      const h = hits[0]; if (!h) return null;
      const m = h.object as THREE.Mesh, attr = m.geometry.attributes.position, f = h.face!;
      const bind = [f.a, f.b, f.c].map(i => new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4(m.matrixWorld.clone().setPosition(0, 0, 0)).toArray().map(v => Number(v.toFixed(3))));
      return { mesh: m.name, material: (m.material as THREE.Material).name, uv: h.uv?.toArray(), distance: h.distance, faceIndex: h.faceIndex, bindPositions: bind };
    },
    setFace(j: number, roll: number, eyeGlow: number) { jaw = j; headRoll = roll; eyes = eyeGlow; },
    get anchor() { return anchor.toArray(); },
    telemetryReport() {
      const report = telemetry?.report() as (ReturnType<NonNullable<typeof telemetry>['report']> & { wrap?: unknown }) | undefined;
      if (report && climbStats?.frames) {
        const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
        report.wrap = {
          trunkRadius: Number(climbStats.radius.toFixed(2)),
          feet: climbStats.legs.map(l => ({ leg: l.leg, meanAngleDeg: Math.round(mean(l.angle)), minAngleDeg: Math.round(Math.min(...l.angle)), maxAngleDeg: Math.round(Math.max(...l.angle)), meanAlongM: Number(mean(l.along).toFixed(2)) })),
          closestFeetM: Number(climbStats.closest.toFixed(2)), meanNearestFootM: Number(mean(climbStats.nearest).toFixed(2)),
          framesThroughTrunk: climbStats.through, throughBySegment: { femur: climbStats.bySegment[0], tibia: climbStats.bySegment[1], meta: climbStats.bySegment[2] }, deepestM: Number(climbStats.deepest.toFixed(3)), frames: climbStats.frames,
        };
      }
      return report;
    },
    get worstClearance() { return `${worst.toFixed(3)} m; frames touching ${touching}/${frames}`; },
    get camera() { return camera.position.toArray(); },
    live: false,
    update(dt: number) {
      this.live = true;
      if (!shot || !rig.ready) return;
      time += dt; shotTime += dt;
      if (fixedCam) placeCam(anchor.x + fixedCam[0], anchor.y + fixedCam[1], anchor.z + fixedCam[2], anchor.x + fixedCam[3], anchor.y + fixedCam[4], anchor.z + fixedCam[5], fixedCam[6]);
      shot(shotTime, dt);
      if (fixedCam) placeCam(anchor.x + fixedCam[0], anchor.y + fixedCam[1], anchor.z + fixedCam[2], anchor.x + fixedCam[3], anchor.y + fixedCam[4], anchor.z + fixedCam[5], fixedCam[6]);
      options.markShadows();
    },
    dispose() { scene.remove(root); rig.dispose(); },
  };
}
