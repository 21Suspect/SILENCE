import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createMeshSurface} from '../game/surface-support.ts';

test('foot contacts follow rotated, nonuniform rocks and miss outside the visible edge',()=>{
  const geometry=new THREE.SphereGeometry(1,24,16),transform=new THREE.Matrix4().compose(new THREE.Vector3(8,.5,-4),new THREE.Quaternion().setFromEuler(new THREE.Euler(.3,.7,.4)),new THREE.Vector3(1.7,.8,.9));
  const surface=createMeshSurface(geometry,transform),mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.matrixAutoUpdate=false;mesh.matrixWorld.copy(transform);
  const raycaster=new THREE.Raycaster();let checked=0;
  for(let x=6.2;x<10;x+=.17)for(let z=-5.5;z<-2.5;z+=.17){
    raycaster.set(new THREE.Vector3(x,10,z),new THREE.Vector3(0,-1,0));const hit=raycaster.intersectObject(mesh)[0],height=surface(x,z);
    if(hit){assert.ok(Math.abs(height-hit.point.y)<1e-6);checked++;}else assert.equal(height,undefined);
  }
  assert.ok(checked>100);assert.notEqual(surface(8,-4),surface(8.6,-4));geometry.dispose();mesh.material.dispose();
});

test('tilted fallen trunks support feet along their curved upper surface',()=>{
  const geometry=new THREE.CylinderGeometry(.35,.55,5,24,4),q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(1,.2,0).normalize()),matrix=new THREE.Matrix4().compose(new THREE.Vector3(0,.6,0),q,new THREE.Vector3(1,1,1)),surface=createMeshSurface(geometry,matrix);
  assert.ok(surface(1,0)>surface(-1,0));assert.ok(surface(0,0)>surface(0,.3));assert.equal(surface(0,.8),undefined);assert.equal(surface(3,0),undefined);geometry.dispose();
});
