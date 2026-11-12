import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStableSunShadow, sunTurnLimit } from '../../../game/render/world/shadows.ts';

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

test('the light follows the sun at every frame, and the shadow map is redrawn only when it is stale by under half a texel',()=>{
 const sun=new THREE.DirectionalLight(),shadows=createStableSunShadow(sun,4096),p=new THREE.Vector3();
 let redraws=0,last;
 for(let i=0;i<600;i++){
  const d=new THREE.Vector3(.3+i*.00001,.5,-.8).normalize();
  if(shadows.update(p,d)){redraws++;last=d.clone();}
  // Lighting is never quantised: the light is where the sun is.
  const actual=sun.position.clone().sub(sun.target.position).normalize();assert.ok(actual.distanceTo(d)<1e-12);
  // And the map is never staler than the limit.
  assert.ok(last.distanceTo(d)<=sunTurnLimit(shadows.texel,d.y)+1e-12,`stale by more than the limit at frame ${i}`);
 }
 assert.ok(redraws>1&&redraws<300,`expected a few dozen redraws for 600 small steps, got ${redraws}`);
});

test('a fast sun (a scrubbed day) redraws every frame, and a walking player every two metres',()=>{
 const sun=new THREE.DirectionalLight(),shadows=createStableSunShadow(sun,4096),p=new THREE.Vector3();
 for(let i=0;i<60;i++)assert.equal(shadows.update(p,new THREE.Vector3(.3+i*.01,.5,-.8).normalize()),true);
 const d=new THREE.Vector3(1,.6,-.8).normalize();
 assert.equal(shadows.update(p,d),true);
 assert.equal(shadows.update(p,d),false);
 assert.equal(shadows.update(new THREE.Vector3(1.5,0,0),d),false,'1.5 m is inside the covered area');
 assert.equal(shadows.update(new THREE.Vector3(2.5,0,0),d),true);
});

test('the limit tightens as the sun gets lower and as the map gets coarser or finer',()=>{
 assert.ok(sunTurnLimit(72/4096,.9)>sunTurnLimit(72/4096,.4));
 assert.ok(sunTurnLimit(72/4096,.4)>sunTurnLimit(72/4096,.19));
 assert.equal(sunTurnLimit(72/4096,.05),sunTurnLimit(72/4096,.18),'below 10 degrees the lever is capped (and the engine draws every frame there anyway)');
 assert.ok(sunTurnLimit(72/2048,.7)>sunTurnLimit(72/4096,.7));
 // About 20 redraws a second at normal day speed (a quarter of a degree a second) around midday.
 const perSecond=(.25*Math.PI/180)/sunTurnLimit(72/4096,.8);
 assert.ok(perSecond>10&&perSecond<40,String(perSecond));
});
