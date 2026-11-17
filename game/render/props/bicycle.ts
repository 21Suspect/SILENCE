import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import worldAssets from '../../data/world-assets.json';
import { dressProp } from './prop-materials';
import { wheelTurn, crankTurn, steerAngle, leanFor, ease, angleDelta, frameOnGround } from './bicycle-math';

/**
 * The bicycle in the world: the frame, the fork with the front wheel (turning about the steering axis), the rear wheel and the cranks,
 * all from the four GLBs (tools/assets/world-v2, hooks in game/data/world-assets.json). One bike on the island. The sums are in
 * bicycle-math.ts; this file only hangs them on the parts.
 *
 *  - The wheels turn by the distance rolled over the tyre's radius; the cranks by the rear wheel's angle over the gearing while the
 *    rider pedals, and stand still when coasting or braking (a freewheel).
 *  - The fork turns about the line steer_bottom -> steer_top (it is raked), 35 degrees at a crawl and less at speed.
 *  - It leans into a curve by atan(speed * turn rate / g), eased; the camera takes 60 % of that (CAMERA_ROLL) so it feels like leaning,
 *    not like a barrel roll.
 *  - Both wheels sit on the ground: pitch from the two contact heights, the frame's origin (the middle of the wheelbase, on the ground)
 *    at their mean. Parked it leans a few degrees on its stand with the bars turned a little.
 */
type Hooks = Record<string, [number, number, number]>;
const defs = worldAssets as unknown as Record<string, { url: string; hooks: Hooks }>;
const hook = (asset: string, name: string) => new THREE.Vector3(...defs[asset].hooks[name]);

/** The share of the bike's lean the camera rolls by. */
export const CAMERA_ROLL = .6;
/** The eye, from the saddle hook (frame coordinates, m): about 0.72 m above it, a little behind the bars. */
export const EYE_ABOVE_SADDLE = .72, EYE_FORWARD = .1;
/** Parked on its stand: leaning right 4 degrees, the bars turned 14 degrees to the left. */
const PARKED_LEAN = -4 * Math.PI / 180, PARKED_STEER = 14 * Math.PI / 180;

export type BicycleViewState = {
  mounted: boolean;
  /** Where the bicycle stands (the middle of its wheelbase, on the ground). */
  x: number; z: number;
  /** The rider's heading as the player's yaw (a positive turn is to the left); only read while mounted. */
  heading: number;
  speed: number;
  /** Steering input -1..1, positive to the left. */
  steer: number;
  throttle: number; brake: number;
};

export type BicycleViewOptions = {
  scene: THREE.Scene;
  /** The height of whatever a wheel stands on at (x, z): terrain, a deck, a floor. */
  ground: (x: number, z: number) => number;
  /** Injected in tests; defaults to GLTFLoader. */
  load?: (url: string) => Promise<{ scene: THREE.Object3D }>;
};

export function createBicycleView(o: BicycleViewOptions) {
  const root = new THREE.Group(); root.name = 'Bicycle'; root.rotation.order = 'YXZ'; o.scene.add(root);
  const fork = new THREE.Group(); fork.name = 'Bicycle fork';
  const crank = new THREE.Group(); crank.name = 'Bicycle crank';
  const rear = new THREE.Group(); rear.name = 'Bicycle rear wheel';
  const front = new THREE.Group(); front.name = 'Bicycle front wheel';
  const steerBottom = hook('bicycle', 'steer_bottom'), steerTop = hook('bicycle', 'steer_top');
  const axis = steerTop.clone().sub(steerBottom).normalize();
  fork.position.copy(steerBottom);
  front.position.copy(hook('bicycle', 'front_axle')).sub(steerBottom);
  rear.position.copy(hook('bicycle', 'rear_axle'));
  crank.position.copy(hook('bicycle', 'crank'));
  fork.add(front); root.add(fork, rear, crank);

  const saddle = hook('bicycle', 'saddle'), rack = hook('bicycle', 'rack');
  const eyeLocal = new THREE.Vector3(saddle.x, saddle.y + EYE_ABOVE_SADDLE, saddle.z + EYE_FORWARD);
  const lampLocal = hook('bicycle', 'lamp');
  const wheelbase = hook('bicycle', 'front_axle').z - hook('bicycle', 'rear_axle').z;

  let yaw = 0, wheelAngle = 0, crankAngle = 0, steer = PARKED_STEER, lean = PARKED_LEAN, pitch = 0, height = 0, yawRate = 0, lastHeading = 0;
  let mounted = false, placed = false, disposed = false, loaded = false;
  const owned: THREE.Object3D[] = [];

  // Loaded the way the world's props are: the default loader (the start-up veil waits for it) and the shared scan materials.
  const loader = o.load ? undefined : new GLTFLoader();
  const fetchModel = (asset: string) => (o.load ? o.load(defs[asset].url) : loader!.loadAsync(defs[asset].url)).then(async g => {
    await dressProp(g.scene).catch(() => undefined);
    g.scene.traverse(x => { if (x instanceof THREE.Mesh) { x.castShadow = true; x.receiveShadow = true; } });
    owned.push(g.scene);
    return g.scene;
  });
  const ready = Promise.all(['bicycle', 'bicycle_fork', 'bicycle_wheel', 'bicycle_crank'].map(fetchModel)).then(([frame, forkModel, wheel, crankModel]) => {
    if (disposed) return;
    root.add(frame);
    forkModel.position.copy(steerBottom).negate(); fork.add(forkModel);
    rear.add(wheel); front.add(wheel.clone(true));
    crank.add(crankModel);
    loaded = true;
  }, error => { console.warn('SILENCE: the bicycle could not load.', error); });

  const forward = new THREE.Vector3();
  function pose(dt: number, snap: boolean) {
    forward.set(Math.sin(yaw), 0, Math.cos(yaw));
    const x = root.position.x, z = root.position.z;
    const hr = o.ground(x - forward.x * wheelbase / 2, z - forward.z * wheelbase / 2), hf = o.ground(x + forward.x * wheelbase / 2, z + forward.z * wheelbase / 2);
    const on = frameOnGround(hr, hf, wheelbase);
    if (snap) { pitch = on.pitch; height = on.height; } else { pitch = ease(pitch, on.pitch, 14, dt); height = ease(height, on.height, 22, dt); }
    root.position.y = height;
    // A positive lean is to the left: the model's +x side, which is rotation about z by the negative.
    root.rotation.set(-pitch, yaw, -lean);
    fork.quaternion.setFromAxisAngle(axis, steer);
    front.rotation.x = wheelAngle; rear.rotation.x = wheelAngle; crank.rotation.x = crankAngle;
    root.updateMatrixWorld(true);
  }

  const turnQuarter = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.PI / 2);
  return {
    root,
    /** Set it down at (x, z) facing `modelYaw` (rotation about Y: the model points +z). Used at home and when the rider gets off. */
    park(x: number, z: number, modelYaw: number) { root.position.x = x; root.position.z = z; yaw = modelYaw; mounted = false; placed = false; },
    /** The model's yaw now (where the nose points, rotation about Y). */
    get yaw() { return yaw; },
    update(dt: number, s: BicycleViewState) {
      const step = Math.min(Math.max(dt, 0), .1);
      root.position.x = s.x; root.position.z = s.z;
      if (s.mounted) {
        if (!mounted) lastHeading = s.heading;
        yaw = s.heading + Math.PI;
        const turned = wheelTurn(s.speed * step);
        wheelAngle += turned;
        // Pedalling drives the cranks through the gearing; coasting or braking, the wheel freewheels and the cranks stay.
        if (s.throttle > 0 && s.brake <= 0 && s.speed > .1) crankAngle += crankTurn(turned);
        if (step > 0) yawRate = ease(yawRate, angleDelta(s.heading, lastHeading) / step, 10, step);
        lastHeading = s.heading;
        lean = ease(lean, leanFor(s.speed, yawRate), 5, step);
        steer = ease(steer, steerAngle(s.steer, s.speed), 10, step);
      } else {
        yawRate = 0; lastHeading = yaw - Math.PI;
        lean = ease(lean, PARKED_LEAN, 4, step); steer = ease(steer, PARKED_STEER, 4, step);
      }
      mounted = s.mounted;
      pose(step, !placed); placed = true;
    },
    /** Camera roll (rad, positive tilts the head left): a share of the lean, only while riding. */
    get roll() { return mounted ? lean * CAMERA_ROLL : 0; },
    get lean() { return lean; }, get steer() { return steer; }, get wheelAngle() { return wheelAngle; }, get crankAngle() { return crankAngle; },
    get loaded() { return loaded; },
    /** The rider's eyes in the world, from the pose of the last update. */
    eye(out = new THREE.Vector3()) { return out.copy(eyeLocal).applyMatrix4(root.matrixWorld); },
    /** Where a part strapped to the rack sits (the rack hook) and which way it faces: across the rack. */
    rack(position: THREE.Vector3, quaternion: THREE.Quaternion) {
      position.copy(rack).applyMatrix4(root.matrixWorld);
      root.getWorldQuaternion(quaternion).multiply(turnQuarter);
    },
    /** Points to aim the "ride" and "strap" prompts at: the middle of the frame above the top tube, and the rack. */
    promptPoint(out = new THREE.Vector3()) { return out.set(0, .95, 0).applyMatrix4(root.matrixWorld); },
    rackPoint(out = new THREE.Vector3()) { return out.copy(rack).applyMatrix4(root.matrixWorld); },
    lampPoint(out = new THREE.Vector3()) { return out.copy(lampLocal).applyMatrix4(root.matrixWorld); },
    ready,
    dispose() {
      disposed = true; o.scene.remove(root);
      for (const m of owned) m.traverse(x => { if (x instanceof THREE.Mesh) { x.geometry.dispose(); for (const mat of Array.isArray(x.material) ? x.material : [x.material]) mat.dispose(); } });
    },
  };
}
export type BicycleView = ReturnType<typeof createBicycleView>;
