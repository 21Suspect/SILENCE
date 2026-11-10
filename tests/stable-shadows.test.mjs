import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStableSunShadow } from '../game/shadows.ts';

test('a stationary surface retains its shadow-texel phase throughout a hilly walk', () => {
  for (const limit of [4096, 2048]) {
    const sun = new THREE.DirectionalLight();
    const shadows = createStableSunShadow(sun, limit);
    const landmark = new THREE.Vector3(7.23, 1.91, -13.4);
    let first;
    for (let step = 0; step < 1200; step++) {
      const t = step / 60;
      shadows.update(new THREE.Vector3(Math.sin(t) * 110, Math.sin(t * 1.7) * 5, Math.cos(t) * 110));
      sun.shadow.updateMatrices(sun);
      const projected = landmark.clone().applyMatrix4(sun.shadow.matrix);
      first ??= projected.clone();
      for (const axis of ['x', 'y']) {
        const displacement = (projected[axis] - first[axis]) * shadows.size;
        assert.ok(Math.abs(displacement - Math.round(displacement)) < 1e-7,
          `Shadow sampling slid by a fractional texel at step ${step}`);
      }
    }
    assert.equal(shadows.size, limit);
  }
});

test('standing still or turning the view does not invalidate the static shadow map', () => {
  const sun = new THREE.DirectionalLight();
  const shadows = createStableSunShadow(sun, 4096);
  assert.equal(shadows.update(new THREE.Vector3(0, 2, 0)), true);
  const light = sun.position.clone(), target = sun.target.position.clone();
  for (let frame = 0; frame < 180; frame++) {
    assert.equal(shadows.update(new THREE.Vector3(0, 2, 0)), false);
    assert.ok(sun.position.equals(light));
    assert.ok(sun.target.position.equals(target));
  }
  assert.equal(shadows.update(new THREE.Vector3(3, 2, 0)), true);
});

test('continuous small sun movement refreshes shadows each frame without angular steps',()=>{
 const sun=new THREE.DirectionalLight(),shadows=createStableSunShadow(sun,4096),p=new THREE.Vector3();
 for(let i=0;i<120;i++){const d=new THREE.Vector3(.3+i*.00001,.5,-.8).normalize();assert.equal(shadows.update(p,d),true);const actual=sun.position.clone().sub(sun.target.position).normalize();assert.ok(actual.distanceTo(d)<1e-12);}
});
