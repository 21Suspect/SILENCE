import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const THREE = await import('three');
const { instanceCulled, instanceCullGLSL } = await import('../../../game/render/world/instance-cull.ts');

const camera = new THREE.PerspectiveCamera(70, 16 / 9, .1, 500);
camera.position.set(0, 1.7, 0); camera.lookAt(0, 1.7, -10); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
const clip = (x, y, z) => { const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(vp); return [v.x, v.y, v.z, v.w]; };
const p00 = camera.projectionMatrix.elements[0], p11 = camera.projectionMatrix.elements[5];
// A conifer: 0 to 31 m tall, crown 6.5 m round its axis.
const tree = (x, z) => instanceCulled(clip, [x, 0, z], 0, 31, 6.5, p00, p11);

test('trees in front of the camera are kept, trees well behind or beside it are culled', () => {
  assert.equal(tree(0, -20), false, 'straight ahead');
  assert.equal(tree(0, 30), true, 'well behind');
  assert.equal(tree(60, -5), true, 'far off to the side');
  assert.equal(tree(-60, -5), true, 'far off to the other side');
});

test('a tree whose crown only just reaches into view is kept: the margin is the crown radius', () => {
  // Just outside the right edge of the view at 20 m depth, its trunk out of view but its crown within 6.5 m of the plane.
  const halfWidth = 20 / p00;
  assert.equal(tree(halfWidth + 4, -20), false);
  assert.equal(tree(halfWidth + 12, -20), true);
});

test('a tree standing beside the player is kept even though its base is behind the near plane', () => {
  assert.equal(tree(2, 1), false);
});

test('the shader snippet carries the bounds it was given', () => {
  const glsl = instanceCullGLSL(-1, 33, 6.5);
  assert.match(glsl, /\*-1\.000/); assert.match(glsl, /\*33\.000/); assert.match(glsl, /6\.500\*length/);
});
