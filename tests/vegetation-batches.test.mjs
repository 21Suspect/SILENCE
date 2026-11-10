import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVegetationBatcher } from '../game/vegetation-batches.ts';

test('sector batches preserve the global instance budget and keep independent bounds', () => {
  const group = new THREE.Group(), batches = createVegetationBatcher(group, 16);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  const definition = { id: 'crowns', geometry, material, capacity: 4 };
  batches.begin();
  for (const x of [0, 1, 64, 65]) {
    batches.place(definition, new THREE.Matrix4().makeTranslation(x, 0, 0), 2);
  }
  assert.equal(batches.allocate(definition, 66, 0), undefined);
  batches.end();
  assert.equal(group.children.length, 2);
  assert.equal(batches.count(definition), 4);
  for (const mesh of group.children) {
    assert.equal(mesh.geometry, geometry);
    assert.ok(mesh.boundingSphere.radius < 5);
    assert.deepEqual(mesh.instanceMatrix.updateRanges, [{ start: 0, count: 32 }]);
  }
  assert.ok(group.children[0].boundingSphere.center.distanceTo(group.children[1].boundingSphere.center) > 60);
  let geometryDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++);
  for (let step = 0; step < 10; step++) {
    batches.begin();
    batches.place(definition, new THREE.Matrix4().makeTranslation(64, 0, 0));
    batches.end();
  }
  assert.equal(group.children.length, 1);
  assert.equal(geometryDisposals, 0);
  batches.dispose();
  geometry.dispose();
  material.dispose();
});

test('streamed root attributes are private to each sector', () => {
  const group = new THREE.Group(), batches = createVegetationBatcher(group, 16);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshBasicMaterial();
  geometry.setAttribute('rootHeightsA', new THREE.InstancedBufferAttribute(new Float32Array(16), 4));
  const definition = { id: 'trunks', geometry, material, capacity: 4 };
  batches.begin();
  const first = batches.allocate(definition, 0, 0);
  const second = batches.allocate(definition, 64, 0);
  first.mesh.geometry.getAttribute('rootHeightsA').setX(first.index, .25);
  batches.end();
  assert.equal(second.mesh.geometry.getAttribute('rootHeightsA').getX(second.index), 0);
  assert.deepEqual(first.mesh.geometry.getAttribute('rootHeightsA').updateRanges, [{ start: 0, count: 4 }]);
  batches.dispose();
  geometry.dispose();
  material.dispose();
});
