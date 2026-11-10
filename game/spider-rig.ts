import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import layout from './spider-rig.json';

export const SPIDER_MODEL_URL = '/creature/silence-creature-v2.glb';
/** The sculpt is authored at full size. In-game it runs at this scale, so it
 * fits between trunks and can actually wrap its legs around one. */
/** Whole-creature scale. 1.15 brings the head and face to the size of the original creature's (about 0.95 m tall); at the old 0.8 they were a third smaller. */
export const SPIDER_SCALE = 1.15;
export const LEG_COUNT = layout.legs.length;
export const LEG_SEGMENTS = layout.segments as [number, number, number, number];
export const LEG_REACH = LEG_SEGMENTS[0] + LEG_SEGMENTS[1] + LEG_SEGMENTS[2] + LEG_SEGMENTS[3];
export const SPIDER_LEGS = layout.legs.map(l => ({
  label: l.label, side: l.side, index: l.index,
  hip: new THREE.Vector3().fromArray(l.hip),
  foot: new THREE.Vector3().fromArray(l.foot),
}));

/** Longest hip-to-tarsal distance the femur and straightened lower leg can span. */
export const LEG_MAX_TARSAL = LEG_SEGMENTS[0] + Math.sqrt(LEG_SEGMENTS[1] ** 2 + LEG_SEGMENTS[2] ** 2 + 2 * LEG_SEGMENTS[1] * LEG_SEGMENTS[2] * Math.cos(.32));
export type LegJoints = { knee: THREE.Vector3; ankle: THREE.Vector3; tarsal: THREE.Vector3 };

const _axis = new THREE.Vector3(), _side = new THREE.Vector3(), _toward = new THREE.Vector3(), _dir = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _plane = new THREE.Vector3();

/** Fixed-length two-bone solve; the joint bulges toward `pole`. */
export function twoBone(a: THREE.Vector3, b: THREE.Vector3, pole: THREE.Vector3, l1: number, l2: number, out: THREE.Vector3) {
  _axis.subVectors(b, a);
  const raw = _axis.length();
  if (raw < 1e-5) _axis.set(0, 1, 0); else _axis.divideScalar(raw);
  _side.subVectors(pole, a).addScaledVector(_axis, -_side.subVectors(pole, a).dot(_axis));
  if (_side.lengthSq() < 1e-7) _side.set(_axis.y, -_axis.x, _axis.z).cross(_axis);
  _side.normalize();
  const d = THREE.MathUtils.clamp(raw, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  return out.copy(a).addScaledVector(_axis, along).addScaledVector(_side, Math.sqrt(Math.max(0, l1 * l1 - along * along)));
}

/** Solve femur, tibia, metatarsus and tarsus. The tarsus keeps its angle to the
 * surface and the limb folds more at the ankle as it compresses, like a spider. */
export function solveSpiderLeg(hip: THREE.Vector3, foot: THREE.Vector3, pole: THREE.Vector3, surfaceUp: THREE.Vector3, out: LegJoints) {
  const [l1, l2, l3, l4] = LEG_SEGMENTS;
  _toward.subVectors(hip, foot);
  _toward.addScaledVector(surfaceUp, -_toward.dot(surfaceUp));
  // Close under the hip this direction means nothing and would whip around, so
  // its influence fades out and the claw simply stands along the surface normal.
  const near = _toward.length();
  _toward.multiplyScalar(Math.min(1, near / 1.2) / Math.max(near, 1e-6));
  _dir.copy(surfaceUp).multiplyScalar(.62).addScaledVector(_toward, .78).normalize();
  out.tarsal.copy(foot).addScaledVector(_dir, l4);
  const reach = THREE.MathUtils.clamp(hip.distanceTo(out.tarsal) / (l1 + l2 + l3), 0, 1);
  const folded = 1 - THREE.MathUtils.smoothstep(reach, .45, .9);
  const bend = THREE.MathUtils.lerp(.32, 1.05, folded);
  const combined = Math.sqrt(l2 * l2 + l3 * l3 + 2 * l2 * l3 * Math.cos(bend));
  twoBone(hip, out.tarsal, pole, l1, combined, out.knee);
  // The ankle bends within the leg's own plane, always to the same side of the
  // lower leg. A target point above it would go singular when the shin hangs
  // straight down and throw the lower leg to the opposite side in one frame.
  _a.subVectors(out.knee, hip); _b.subVectors(out.tarsal, hip);
  _plane.crossVectors(_a, _b);
  if (_plane.lengthSq() < 1e-6) _plane.crossVectors(_b, _c.subVectors(pole, hip));
  _plane.normalize();
  _c.subVectors(out.tarsal, out.knee).normalize().cross(_plane).add(out.knee);
  twoBone(out.knee, out.tarsal, _c, l2, l3, out.ankle);
  return out;
}

type Rest = { bone: THREE.Bone; bodyPos: THREE.Vector3; bodyQuat: THREE.Quaternion; localQuat: THREE.Quaternion; localPos: THREE.Vector3; parent?: string };
type Posed = { p: THREE.Vector3; q: THREE.Quaternion };

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4();
function frameQuat(a: THREE.Vector3, b: THREE.Vector3, normal: THREE.Vector3, out: THREE.Quaternion) {
  _y.subVectors(b, a).normalize();
  _x.crossVectors(_y, normal).normalize();
  _n.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _n);
  return out.setFromRotationMatrix(_m);
}

/** Loads the creature and turns solved joint positions into bone transforms. */
export function createSpiderRig(parent: THREE.Group) {
  const rest = new Map<string, Rest>();
  const posed = new Map<string, Posed>();
  const restFrames = new Map<string, THREE.Quaternion>();
  const bindOf = new Map(layout.bones.map(b => [b.name, b]));
  let model: THREE.Group | undefined, disposed = false;
  let eyeMaterial: THREE.MeshStandardMaterial | undefined;
  const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpQ3 = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpN = new THREE.Vector3(), tmpE = new THREE.Euler();
  const names = ['femur', 'tibia', 'meta', 'tarsus'];

  new GLTFLoader().load(SPIDER_MODEL_URL, gltf => {
    if (disposed) return;
    model = gltf.scene;
    model.name = 'Listener v2';
    model.updateMatrixWorld(true);
    model.traverse(o => {
      if (o instanceof THREE.Bone) {
        const bodyPos = new THREE.Vector3(), bodyQuat = new THREE.Quaternion(), scale = new THREE.Vector3();
        o.matrixWorld.decompose(bodyPos, bodyQuat, scale);
        rest.set(o.name, { bone: o, bodyPos, bodyQuat, localQuat: o.quaternion.clone(), localPos: o.position.clone(), parent: o.parent instanceof THREE.Bone ? o.parent.name : undefined });
        posed.set(o.name, { p: bodyPos.clone(), q: bodyQuat.clone() });
      }
      if (o instanceof THREE.Mesh) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        const m = o.material as THREE.MeshStandardMaterial;
        if (m.name === 'Dead white eyes') {
          eyeMaterial = m; m.color.set(0xffffff); m.emissive.set(0xffffff); m.emissiveIntensity = 3.2; m.roughness = .3;
          o.castShadow = false; o.receiveShadow = false;
        } else {
          m.vertexColors = false; m.envMapIntensity = .6; m.normalScale.set(1.15, 1.15);
          for (const map of [m.map, m.normalMap, m.roughnessMap]) if (map) map.anisotropy = 8;
        }
      }
    });
    // Rest frames: the segment plane comes straight from the bind pose.
    for (const leg of layout.legs) {
      const j = leg.joints.map(v => new THREE.Vector3().fromArray(v));
      const normal = new THREE.Vector3().subVectors(j[1], j[0]).cross(new THREE.Vector3().subVectors(j[3], j[0])).normalize();
      for (let k = 0; k < 4; k++) restFrames.set(`${names[k]}_${leg.label}`, frameQuat(j[k], j[k + 1], normal, new THREE.Quaternion()));
    }
    for (const side of ['L', 'R']) {
      const s = bindOf.get(`upperarm_${side}`)!, f = bindOf.get(`forearm_${side}`)!;
      const a = new THREE.Vector3().fromArray(s.a), b = new THREE.Vector3().fromArray(s.b), c = new THREE.Vector3().fromArray(f.b);
      const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
      restFrames.set(`upperarm_${side}`, frameQuat(a, b, normal, new THREE.Quaternion()));
      restFrames.set(`forearm_${side}`, frameQuat(b, c, normal, new THREE.Quaternion()));
    }
    parent.add(model);
  }, undefined, e => console.error('SILENCE: creature v2 failed to load.', e));

  /** Pose a bone from body-space end points, keeping its limb plane upright. */
  function setSegment(name: string, a: THREE.Vector3, b: THREE.Vector3, normal: THREE.Vector3) {
    const r = rest.get(name), frame = restFrames.get(name), current = posed.get(name);
    if (!r || !frame || !current) return;
    frameQuat(a, b, normal, tmpQ);
    current.q.copy(tmpQ).multiply(tmpQ2.copy(frame).invert()).multiply(r.bodyQuat);
    current.p.copy(a);
    const up = r.parent ? posed.get(r.parent)! : undefined;
    if (up) {
      tmpQ3.copy(up.q).invert();
      r.bone.quaternion.copy(tmpQ3).multiply(current.q);
      r.bone.position.copy(a).sub(up.p).applyQuaternion(tmpQ3);
    } else { r.bone.quaternion.copy(current.q); r.bone.position.copy(a); }
  }

  /** Rotate a bone by a rotation expressed in body axes, about its own pivot. */
  function delta(name: string, x: number, y: number, z: number, damp = 1) {
    const r = rest.get(name);
    if (!r) return;
    tmpE.set(x, y, z, 'YXZ');
    tmpQ.setFromEuler(tmpE);
    tmpQ2.copy(r.bodyQuat).invert().multiply(tmpQ).multiply(r.bodyQuat);
    tmpQ3.copy(r.localQuat).multiply(tmpQ2);
    if (damp >= 1) r.bone.quaternion.copy(tmpQ3); else r.bone.quaternion.slerp(tmpQ3, damp);
  }

  return {
    get ready() { return !!model; },
    get model() { return model; },
    setLeg(leg: number, hip: THREE.Vector3, joints: LegJoints, foot: THREE.Vector3) {
      const label = layout.legs[leg].label;
      tmpN.subVectors(joints.knee, hip).cross(tmpV.subVectors(joints.tarsal, hip)).normalize();
      const normal = tmpV.copy(tmpN).clone();
      setSegment(`femur_${label}`, hip, joints.knee, normal);
      setSegment(`tibia_${label}`, joints.knee, joints.ankle, normal);
      setSegment(`meta_${label}`, joints.ankle, joints.tarsal, normal);
      setSegment(`tarsus_${label}`, joints.tarsal, foot, normal);
    },
    setArm(side: 'L' | 'R', shoulder: THREE.Vector3, elbow: THREE.Vector3, wrist: THREE.Vector3) {
      tmpN.subVectors(elbow, shoulder).cross(tmpV.subVectors(wrist, shoulder)).normalize();
      const normal = tmpN.clone();
      setSegment(`upperarm_${side}`, shoulder, elbow, normal);
      setSegment(`forearm_${side}`, elbow, wrist, normal);
    },
    joint(name: string, x: number, y: number, z: number, damp = 1) { delta(name, x, y, z, damp); },
    /** World direction the face is pointing right now. */
    headForward(out: THREE.Vector3) {
      const r = rest.get('head');
      if (!r) return out.set(0, 0, 1);
      r.bone.getWorldQuaternion(tmpQ);
      tmpQ2.copy(r.bodyQuat).invert();
      return out.set(0, 0, 1).applyQuaternion(tmpQ.multiply(tmpQ2));
    },
    eyes(intensity: number) { if (eyeMaterial) eyeMaterial.emissiveIntensity = intensity; },
    dispose() {
      disposed = true;
      if (model) {
        parent.remove(model);
        model.traverse(o => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
            const m = o.material as THREE.MeshStandardMaterial;
            [m.map, m.normalMap, m.roughnessMap].forEach(t => t?.dispose()); m.dispose();
          }
        });
      }
      rest.clear(); posed.clear();
    },
  };
}
export type SpiderRig = ReturnType<typeof createSpiderRig>;
