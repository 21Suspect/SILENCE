import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
// game/spider-rig.ts uses extensionless and JSON imports that only the bundler understands;
// this test-only loader hook lets Node import it unchanged.
import './helpers/register-ts-hooks.mjs';
const { twoBone, solveSpiderLeg, LEG_SEGMENTS, LEG_REACH, LEG_COUNT, SPIDER_LEGS, SPIDER_SCALE } = await import('../game/spider-rig.ts');
const layout = JSON.parse(fs.readFileSync(new URL('../game/spider-rig.json', import.meta.url), 'utf8'));
const [L1, L2, L3, L4] = LEG_SEGMENTS;

// ---------------------------------------------------------------- helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const unit = random => { const v = new THREE.Vector3(); do v.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1); while (v.lengthSq() < 1e-3 || v.lengthSq() > 1); return v.normalize(); };
const joints = () => ({ knee: new THREE.Vector3(), ankle: new THREE.Vector3(), tarsal: new THREE.Vector3() });
const V = a => new THREE.Vector3().fromArray(a);
const EXACT = 1e-9;

// ---------------------------------------------------------------- layout
test('generated layout describes eight mirrored legs with the segment lengths the solver uses', () => {
  assert.equal(LEG_COUNT, 8);
  assert.equal(SPIDER_LEGS.length, 8);
  assert.equal(layout.segments.length, 4);
  assert.ok(Math.abs(LEG_REACH - (L1 + L2 + L3 + L4)) < 1e-12);
  assert.ok(SPIDER_SCALE >= .6 && SPIDER_SCALE <= 1.5, 'in-game scale keeps the sculpt near its authored size');
  for (const side of [-1, 1]) assert.deepEqual(SPIDER_LEGS.filter(l => l.side === side).map(l => l.index), [0, 1, 2, 3], `side ${side} has legs 0..3`);
  for (const leg of SPIDER_LEGS) {
    const mirror = SPIDER_LEGS.find(l => l.side === -leg.side && l.index === leg.index);
    assert.ok(mirror, `${leg.label} has a mirror leg`);
    assert.ok(Math.abs(leg.hip.x + mirror.hip.x) < 1e-9 && Math.abs(leg.hip.y - mirror.hip.y) < 1e-9 && Math.abs(leg.hip.z - mirror.hip.z) < 1e-9, `${leg.label} hip mirrors`);
    assert.ok(Math.abs(leg.foot.x + mirror.foot.x) < 1e-9 && Math.abs(leg.foot.z - mirror.foot.z) < 1e-9, `${leg.label} foot mirrors`);
    assert.equal(Math.sign(leg.hip.x), leg.side, `${leg.label} hip is on its own side`);
    assert.ok(leg.hip.distanceTo(leg.foot) < LEG_REACH, `${leg.label} bind stance is within reach`);
  }
});

test('bind-pose joints in the layout keep the solver segment lengths and its tarsus placement', () => {
  for (const leg of layout.legs) {
    const j = leg.joints.map(V);
    assert.equal(j.length, 5);
    LEG_SEGMENTS.forEach((length, k) => assert.ok(Math.abs(j[k].distanceTo(j[k + 1]) - length) < 1e-6, `${leg.label} segment ${k} bind length`));
    assert.ok(j[0].distanceTo(V(leg.hip)) < 1e-9 && j[4].distanceTo(V(leg.foot)) < 1e-9, `${leg.label} bind chain runs hip to foot`);
    const out = joints();
    solveSpiderLeg(V(leg.hip), V(leg.foot), V(leg.pole), new THREE.Vector3(0, 1, 0), out);
    assert.ok(out.tarsal.distanceTo(j[3]) < 1e-6, `${leg.label} solver tarsal agrees with the generated bind pose`);
  }
});

// ---------------------------------------------------------------- twoBone
test('twoBone places the joint exactly l1 from the root and l2 from the target, bulging toward the pole', () => {
  const random = mulberry32(1), out = new THREE.Vector3(), axis = new THREE.Vector3(), poleSide = new THREE.Vector3(), kneeSide = new THREE.Vector3();
  for (let i = 0; i < 2000; i++) {
    const l1 = .3 + random() * 2, l2 = .3 + random() * 2;
    const a = new THREE.Vector3(random() * 6 - 3, random() * 6 - 3, random() * 6 - 3);
    const reach = Math.abs(l1 - l2) + .02 + random() * (l1 + l2 - Math.abs(l1 - l2) - .04);
    const b = a.clone().addScaledVector(unit(random), reach), pole = a.clone().addScaledVector(unit(random), .5 + random() * 5);
    twoBone(a, b, pole, l1, l2, out);
    assert.ok(Math.abs(out.distanceTo(a) - l1) < EXACT, `upper segment ${i}`);
    assert.ok(Math.abs(out.distanceTo(b) - l2) < EXACT, `lower segment ${i}`);
    axis.subVectors(b, a).normalize();
    poleSide.subVectors(pole, a); poleSide.addScaledVector(axis, -poleSide.dot(axis));
    kneeSide.subVectors(out, a); kneeSide.addScaledVector(axis, -kneeSide.dot(axis));
    if (poleSide.length() > 1e-3 && kneeSide.length() > 1e-3) assert.ok(poleSide.dot(kneeSide) > 0, `joint bulges toward the pole ${i}`);
  }
});

test('twoBone stays finite and keeps the root segment when the target is out of reach, close, or on the pole axis', () => {
  const out = new THREE.Vector3(), a = new THREE.Vector3(1, 2, 3);
  const cases = [
    ['out of reach', a.clone().add(new THREE.Vector3(0, 0, 50)), new THREE.Vector3(0, 5, 3)],
    ['barely apart from the root', a.clone().add(new THREE.Vector3(1e-4, 0, 0)), new THREE.Vector3(0, 5, 3)],
    ['pole on the reach axis', a.clone().add(new THREE.Vector3(0, 2, 0)), a.clone().add(new THREE.Vector3(0, 7, 0))],
    ['pole at the root', a.clone().add(new THREE.Vector3(0, 2, 0)), a.clone()],
  ];
  for (const [label, b, pole] of cases) {
    twoBone(a, b, pole, 1.7, 1.2, out);
    assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z), `${label}: finite`);
    assert.ok(Math.abs(out.distanceTo(a) - 1.7) < EXACT, `${label}: root segment keeps its length`);
  }
});

// Known defect: below 1e-5 m of separation the reach axis is divided by the clamped length instead of its
// own length, so it is not a unit vector and the joint collapses onto the root (femur ~0.03 m instead of
// 1.7 m). Unreachable by the gait today (it needs the tarsal to land on the hip), hence only a TODO.
test('twoBone keeps the root segment even when the target coincides with the root', () => {
  const out = new THREE.Vector3(), a = new THREE.Vector3(1, 2, 3);
  for (const offset of [0, 1e-9, 1e-7]) {
    twoBone(a, a.clone().add(new THREE.Vector3(offset, 0, 0)), new THREE.Vector3(0, 5, 3), 1.7, 1.2, out);
    assert.ok(Math.abs(out.distanceTo(a) - 1.7) < EXACT, `offset ${offset}: femur is ${out.distanceTo(a)}`);
  }
});

// ---------------------------------------------------------------- solveSpiderLeg
test('solveSpiderLeg keeps femur, tibia, metatarsus and tarsus at their fixed lengths over many hip, foot, pole and surface configurations', () => {
  const random = mulberry32(2), out = joints();
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    // Hips range around the real layout; feet anywhere the leg can reach (any direction, any surface orientation).
    const hip = SPIDER_LEGS[i % LEG_COUNT].hip.clone().add(unit(random).multiplyScalar(random() * .6));
    const foot = hip.clone().addScaledVector(unit(random), .15 + random() * 4.2);
    const pole = hip.clone().addScaledVector(unit(random), .5 + random() * 6), up = i % 5 === 0 ? new THREE.Vector3(0, 1, 0) : unit(random);
    solveSpiderLeg(hip, foot, pole, up, out);
    const lengths = [out.knee.distanceTo(hip), out.ankle.distanceTo(out.knee), out.tarsal.distanceTo(out.ankle), foot.distanceTo(out.tarsal)];
    LEG_SEGMENTS.forEach((length, k) => assert.ok(Math.abs(lengths[k] - length) < EXACT, `config ${i}: segment ${k} is ${lengths[k]}, expected ${length}`));
    assert.ok(Math.abs(foot.distanceTo(out.tarsal) - L4) < EXACT, `config ${i}: tarsal-to-foot equals the tarsus length`);
    checked++;
  }
  assert.equal(checked, 4000);
});

test('solveSpiderLeg keeps lengths exact across the real stance range on flat ground and on a vertical trunk', () => {
  const out = joints(), pole = new THREE.Vector3();
  for (const up of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(.6, .8, 0).normalize()]) {
    for (const leg of SPIDER_LEGS) for (let step = 0; step <= 40; step++) {
      // Slide the foot from tucked-in under the thorax out to the stance limit.
      const foot = leg.hip.clone().lerp(leg.foot, .35 + step / 40 * .9);
      pole.set(leg.side * 3.4, 5.2, (foot.z + leg.hip.z) * .5);
      solveSpiderLeg(leg.hip, foot, pole, up, out);
      const lengths = [out.knee.distanceTo(leg.hip), out.ankle.distanceTo(out.knee), out.tarsal.distanceTo(out.ankle), foot.distanceTo(out.tarsal)];
      LEG_SEGMENTS.forEach((length, k) => assert.ok(Math.abs(lengths[k] - length) < EXACT, `${leg.label} step ${step}: segment ${k}`));
    }
  }
});

test('the tarsus keeps one angle to the surface, pointing off the surface and back toward the hip', () => {
  const random = mulberry32(3), out = joints(), toward = new THREE.Vector3(), dir = new THREE.Vector3(), lateral = new THREE.Vector3();
  let angle;
  for (let i = 0; i < 500; i++) {
    const up = unit(random), hip = new THREE.Vector3(random() * 2 - 1, 1.5 + random() * 2, random() * 2 - 1);
    const foot = hip.clone().addScaledVector(unit(random), 1 + random() * 3);
    solveSpiderLeg(hip, foot, hip.clone().addScaledVector(unit(random), 4), up, out);
    dir.subVectors(out.tarsal, foot).normalize();
    toward.subVectors(hip, foot); toward.addScaledVector(up, -toward.dot(up));
    if (toward.length() < 1.25) continue; // close under the hip the claw deliberately fades to the surface normal
    toward.normalize();
    angle ??= dir.dot(up);
    assert.ok(Math.abs(dir.dot(up) - angle) < 1e-9, `config ${i}: tarsus angle to the surface is constant`);
    assert.ok(dir.dot(up) > .1, `config ${i}: tarsus leaves the surface`);
    lateral.copy(dir).addScaledVector(up, -dir.dot(up));
    assert.ok(lateral.normalize().dot(toward) > .999, `config ${i}: tarsus leans toward the hip`);
  }
  assert.ok(angle !== undefined);
});

test('solveSpiderLeg is finite and keeps the three rigid segments when the foot is beyond reach or directly beneath the hip', () => {
  const out = joints(), up = new THREE.Vector3(0, 1, 0);
  const cases = [
    ['far outside the reach', new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(9, 0, 0)],
    ['directly beneath the hip', new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(0, 0, 0)],
    ['foot on the hip', new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(0, 2.5, 0)],
    ['pole on the hip-to-foot axis', new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(1, 1.25, 0)],
  ];
  for (const [label, hip, foot, pole = new THREE.Vector3(3, 5, 0)] of cases) {
    solveSpiderLeg(hip, foot, pole, up, out);
    for (const p of [out.knee, out.ankle, out.tarsal]) assert.ok(Number.isFinite(p.x + p.y + p.z), `${label}: finite`);
    assert.ok(Math.abs(out.knee.distanceTo(hip) - L1) < EXACT, `${label}: femur`);
    assert.ok(Math.abs(out.ankle.distanceTo(out.knee) - L2) < EXACT, `${label}: tibia`);
    assert.ok(Math.abs(foot.distanceTo(out.tarsal) - L4) < EXACT, `${label}: tarsus`);
  }
});

// ---------------------------------------------------------------- GLB
const glbPath = new URL('../public/creature/silence-creature-v2.glb', import.meta.url);
const file = fs.readFileSync(glbPath);
const jsonLength = file.readUInt32LE(12), gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString());
const bin = file.subarray(28 + jsonLength), view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const types = { 5121: [1, 'getUint8'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
function accessor(index) {
  const a = gltf.accessors[index], v = gltf.bufferViews[a.bufferView], [size, read] = types[a.componentType], n = components[a.type];
  const stride = v.byteStride ?? n * size, start = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: n }, (_, j) => view[read](start + i * stride + j * size, true)));
}
const primitives = gltf.meshes.flatMap(mesh => mesh.primitives.map(primitive => ({ mesh: mesh.name, primitive })));
const skin = gltf.skins[0], jointNames = skin.joints.map(j => gltf.nodes[j].name);
const triangleCount = primitive => gltf.accessors[primitive.indices].count / 3;

test('creature v2 GLB is a complete binary glTF 2.0 container with a single 76-joint skin', () => {
  assert.equal(file.subarray(0, 4).toString(), 'glTF');
  assert.equal(file.readUInt32LE(4), 2);
  assert.equal(file.readUInt32LE(8), file.length, 'declared container length matches the file');
  assert.equal(file.subarray(16, 20).toString(), 'JSON');
  assert.equal(file.subarray(24 + jsonLength, 28 + jsonLength).toString(), 'BIN\0');
  assert.equal(file.readUInt32LE(20 + jsonLength), bin.length, 'binary chunk length matches');
  assert.equal(gltf.skins.length, 1);
  assert.equal(skin.joints.length, 76);
  assert.equal(gltf.accessors[skin.inverseBindMatrices].count, 76, 'one inverse bind matrix per joint');
  assert.equal(new Set(jointNames).size, 76, 'joint names are unique');
  for (const node of gltf.nodes.filter(n => n.mesh !== undefined)) assert.equal(node.skin, 0, `${node.name} shares the one skeleton`);
});

test('creature v2 GLB stays under the 110000 triangle budget', () => {
  const total = primitives.reduce((sum, { primitive }) => sum + triangleCount(primitive), 0);
  assert.ok(Number.isInteger(total));
  assert.ok(total > 0 && total < 110000, `${total} triangles`);
  for (const { primitive } of primitives) assert.ok((primitive.mode ?? 4) === 4, 'triangle lists only');
  const body = Math.max(...primitives.map(({ primitive }) => triangleCount(primitive)));
  assert.equal(layout.triangles, body, 'spider-rig.json was generated from this skin mesh');
});

test('creature v2 GLB exposes exactly the Skin v2, Dead white eyes and Bristles materials', () => {
  assert.deepEqual(gltf.materials.map(m => m.name).sort(), ['Bristles', 'Dead white eyes', 'Skin v2']);
  assert.deepEqual([...new Set(primitives.map(({ primitive }) => gltf.materials[primitive.material].name))].sort(), ['Bristles', 'Dead white eyes', 'Skin v2'], 'every material is drawn');
  for (const { primitive } of primitives) assert.ok(primitive.material !== undefined);
});

test('every skinned vertex has weights normalised to 1 on valid joints', () => {
  for (const { mesh, primitive } of primitives) {
    const weights = accessor(primitive.attributes.WEIGHTS_0), indices = accessor(primitive.attributes.JOINTS_0);
    assert.equal(weights.length, accessor(primitive.attributes.POSITION).length, `${mesh}: weights per vertex`);
    let worst = 0;
    weights.forEach((w, i) => {
      worst = Math.max(worst, Math.abs(w[0] + w[1] + w[2] + w[3] - 1));
      w.forEach((weight, k) => { assert.ok(weight >= 0 && weight <= 1 + 1e-6, `${mesh} vertex ${i}`); if (weight > 0) assert.ok(indices[i][k] < 76, `${mesh} vertex ${i} references joint ${indices[i][k]}`); });
    });
    assert.ok(worst < 1e-5, `${mesh}: weights sum to 1 (worst deviation ${worst})`);
  }
});

test('the skeleton matches the layout and carries every bone the runtime poses', () => {
  assert.equal(layout.bones.length, 76);
  assert.deepEqual([...jointNames].sort(), layout.bones.map(b => b.name).sort(), 'GLB joints and spider-rig.json bones agree');
  const driven = [...layout.legs.flatMap(leg => ['femur', 'tibia', 'meta', 'tarsus'].map(name => `${name}_${leg.label}`)), 'upperarm_L', 'forearm_L', 'upperarm_R', 'forearm_R'];
  const weighted = new Set();
  for (const { primitive } of primitives) {
    const weights = accessor(primitive.attributes.WEIGHTS_0), indices = accessor(primitive.attributes.JOINTS_0);
    weights.forEach((w, i) => w.forEach((weight, k) => { if (weight > 0) weighted.add(jointNames[indices[i][k]]); }));
  }
  for (const name of driven) { assert.ok(jointNames.includes(name), `${name} exists in the skin`); assert.ok(weighted.has(name), `${name} deforms real vertices`); }
});

test('the eyes are a separate draw rigidly bound to the head joint', () => {
  const eyes = primitives.find(({ primitive }) => gltf.materials[primitive.material].name === 'Dead white eyes').primitive;
  const weights = accessor(eyes.attributes.WEIGHTS_0), indices = accessor(eyes.attributes.JOINTS_0);
  for (let i = 0; i < weights.length; i++) {
    const dominant = weights[i].indexOf(Math.max(...weights[i]));
    assert.equal(jointNames[indices[i][dominant]], 'head');
    assert.ok(weights[i][dominant] > .99999);
  }
});
