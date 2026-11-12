import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createShadowProgramWarmer } from '../game/shadow-programs.ts';

// A stand-in for WebGLRenderer.compile: records which depth materials it was asked to build, and with which meshes.
function stubRenderer() {
  const calls = [];
  return { calls, compile(group) { calls.push(group.children.map(m => ({ material: m.material, instanced: !!m.isInstancedMesh }))); } };
}
const camera = new THREE.PerspectiveCamera(), scene = new THREE.Scene();

test('one stand-in per depth variant the shadow pass will pick, whatever the number of casters', () => {
  const renderer = stubRenderer(), warmer = createShadowProgramWarmer(renderer);
  const geometry = new THREE.BoxGeometry(), plank = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  const prop = new THREE.Group();
  for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(geometry, plank); m.castShadow = true; prop.add(m); }
  const glass = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()); glass.castShadow = false; prop.add(glass);
  const scatter = new THREE.InstancedMesh(geometry, plank, 4); scatter.castShadow = true; prop.add(scatter);
  assert.equal(warmer.compile(prop, camera, scene), 2, 'plain and instanced; the mesh that casts no shadow is left out');
  assert.equal(renderer.calls.length, 1);
  assert.deepEqual(renderer.calls[0].map(c => c.instanced).sort(), [false, true]);
  for (const { material } of renderer.calls[0]) {
    assert.ok(material.isMeshDepthMaterial);
    assert.equal(material.depthPacking, THREE.RGBADepthPacking);
    assert.equal(material.map, plank.map, 'the depth pass samples the map, so it is part of the program');
    assert.equal(material.side, THREE.BackSide, 'front faces cast from their back side');
  }
  // A second prop with the same kind of material needs nothing new, but is still compiled (light states differ between calls).
  const again = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: new THREE.Texture() })); again.castShadow = true;
  assert.equal(warmer.compile(again, camera, scene), 1);
  assert.equal(warmer.variants, 2);
});

test('a custom depth material keeps its own program key and shader edits, and alpha-to-coverage becomes an alpha test', () => {
  const renderer = stubRenderer(), warmer = createShadowProgramWarmer(renderer);
  const custom = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  custom.onBeforeCompile = () => {}; custom.customProgramCacheKey = () => 'slope-depth';
  const leaves = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), alphaToCoverage: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), leaves); mesh.castShadow = true; mesh.customDepthMaterial = custom;
  warmer.compile(mesh, camera, scene);
  const [{ material }] = renderer.calls[0];
  assert.notEqual(material, custom, 'a copy: the real one is reconfigured by the shadow pass for every caster');
  assert.equal(material.customProgramCacheKey(), 'slope-depth');
  assert.equal(material.onBeforeCompile, custom.onBeforeCompile);
  assert.equal(material.alphaTest, .5);
  assert.equal(material.side, THREE.DoubleSide);
});

test('the scene fog is out of the way while compiling, as in the shadow pass, and put back', () => {
  const renderer = stubRenderer(), warmer = createShadowProgramWarmer(renderer);
  const fogged = new THREE.Scene(); fogged.fog = new THREE.FogExp2(0xffffff, .01);
  let seen = 'unset'; renderer.compile = (group, cam, target) => { seen = target.fog; };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); mesh.castShadow = true;
  warmer.compile(mesh, camera, fogged);
  assert.equal(seen, null);
  assert.ok(fogged.fog.isFogExp2);
});
