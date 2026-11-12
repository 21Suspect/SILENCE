import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
const { seatPlacement } = await import('../../../game/render/props/pois.ts');
const assets = JSON.parse(fs.readFileSync(new URL('../../../game/data/world-assets.json', import.meta.url)));

// Test the exported geometry, not merely the construction instructions or colliders.
function model(name) {
  const data = fs.readFileSync(new URL(`../../../public/world/${name}.glb`, import.meta.url));
  const length = data.readUInt32LE(12), gltf = JSON.parse(data.subarray(20, 20 + length));
  const binary = data.subarray(28 + length), view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const types = { 5123: ['getUint16', 2], 5125: ['getUint32', 4], 5126: ['getFloat32', 4] };
  function read(i, n) {
    const a = gltf.accessors[i], b = gltf.bufferViews[a.bufferView], [get, bytes] = types[a.componentType];
    return Array.from({ length: a.count * n }, (_, k) => view[get]((b.byteOffset ?? 0) + (a.byteOffset ?? 0) + Math.floor(k / n) * (b.byteStride ?? bytes * n) + k % n * bytes, true));
  }
  const group = new THREE.Group();
  function add(i, parent) {
    const node = gltf.nodes[i], o = new THREE.Group(); parent.add(o);
    if (node.matrix) { o.matrix.fromArray(node.matrix); o.matrix.decompose(o.position, o.quaternion, o.scale); }
    else { o.position.fromArray(node.translation ?? [0, 0, 0]); o.quaternion.fromArray(node.rotation ?? [0, 0, 0, 1]); o.scale.fromArray(node.scale ?? [1, 1, 1]); }
    if (node.mesh !== undefined) for (const p of gltf.meshes[node.mesh].primitives) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(read(p.attributes.POSITION, 3), 3)); g.setIndex(read(p.indices, 1));
      o.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })));
    }
    node.children?.forEach(c => add(c, o));
  }
  gltf.scenes[gltf.scene ?? 0].nodes.forEach(n => add(n, group)); group.updateMatrixWorld(true);
  return group;
}
const ray = new THREE.Raycaster();
function hits(o, origin, dir, far) { ray.set(new THREE.Vector3(...origin), new THREE.Vector3(...dir)); ray.far = far; return ray.intersectObject(o, true); }

test('lookout has a full person-height opening through its front bracing', () => {
  const o = model('lookout');
  for (const x of [-.7, -.48, -.26]) for (const y of [.35, .75, 1.1, 1.6, 1.95])
    assert.equal(hits(o, [x, y, -2.6], [0, 0, 1], .6).length, 0, `blocked at x ${x}, y ${y}`);
});
test('chapel siding closes the corners above all six pointed windows', () => {
  const o = model('chapel');
  for (const side of [-1, 1]) for (const z of [-2.8, 0, 2.8]) for (const dz of [-.4, .4])
    assert.ok(hits(o, [side * 3.1, 2.86, z + dz], [-side, 0, 0], .5).length > 0, `open corner ${side}, ${z}, ${dz}`);
});
test('thin shovel blade remains above the ground on level and sloping soil', () => {
  for (const slope of [0, .18, -.25]) {
    const height = (x, z) => 3 + x * slope + z * .07;
    const p = { id: 'shovel-check', asset: 'shovel', fit: 'tilt', x: 8, z: -4, yaw: .65 };
    const seat = seatPlacement(assets.shovel, p, height);
    for (const z of [.4, .55, .68]) {
      const v = new THREE.Vector3(0, .041, z).applyQuaternion(seat.quaternion).add(new THREE.Vector3(p.x, seat.ground, p.z));
      const gap = v.y - height(v.x, v.z);
      assert.ok(gap > .015 && gap < .065, `blade clearance ${gap}`);
    }
  }
});

test('scanned boulder cut bases stay buried across their whole underside on banks', () => {
  for (const name of ['rock_a', 'rock_b', 'rock_c', 'rock_d']) {
    const o = model(name), bottom = new THREE.Box3().setFromObject(o).min.y;
    for (const slope of [0, .4, 1.5, 3]) {
      const p = {id: 'bank-rock', asset: name, x: 12, z: -5, yaw: .73, scale: .22};
      const height = (x, z) => x * slope + z * .1;
      const seat = seatPlacement(assets[name], p, height), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),p.yaw);
      let count = 0;
      o.traverse(mesh => {
        if (!mesh.isMesh) return;
        const pos=mesh.geometry.attributes.position;
        for(let i=0;i<pos.count;i++) {
          const v=new THREE.Vector3().fromBufferAttribute(pos,i).applyMatrix4(mesh.matrixWorld);
          if(v.y>bottom+.015)continue;
          v.multiplyScalar(p.scale).applyQuaternion(q).add(new THREE.Vector3(p.x,seat.ground,p.z));
          assert.ok(v.y-height(v.x,v.z)<.06, `${name} floating cut base on slope ${slope}`);count++;
        }
      });
      assert.ok(count>10);
    }
  }
});
test('camp cooler clears both log seats', () => {
  const cooler=assets.camp.colliders.find(c=>c.tag==='cooler');
  for(const log of assets.camp.colliders.filter(c=>c.tag==='log seat')) {
    const dx=log.bx-log.ax,dz=log.bz-log.az;
    const t=Math.max(0,Math.min(1,((cooler.x-log.ax)*dx+(cooler.z-log.az)*dz)/(dx*dx+dz*dz)));
    const clearance=Math.hypot(cooler.x-log.ax-t*dx,cooler.z-log.az-t*dz)-log.radius-Math.hypot(cooler.halfX,cooler.halfZ);
    assert.ok(clearance>.1,`cooler/log clearance ${clearance}`);
  }
});
