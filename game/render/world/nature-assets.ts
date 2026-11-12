import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Photographed grey rocks, fallen branches, stumps and a fallen trunk: CC0 scans from Poly Haven's pine forest collection, cut
 * down for instancing by tools/assets/nature/build.py (attribution: public/world/nature/attribution.json). Each GLB holds
 * several variants sharing one material; the pebble files are 70-triangle cuts of the same rocks, shipped without textures
 * and given their rock set's material here. Geometry is normalised so the forest can place a piece by a size in metres:
 *   'sphere'  centred, largest horizontal half-size 1 (rocks and pebbles, like a unit sphere)
 *   'base'    largest horizontal half-size 1, lowest point at y = 0 (stumps)
 *   'lengthZ' length 1 along z, lowest point at y = 0 (branches lying on the ground)
 *   'lengthX' length 1 along x, centred (the fallen trunk, placed along its axis)
 */
export type NatureVariant = { geometry: THREE.BufferGeometry; size: THREE.Vector3; material: THREE.MeshStandardMaterial };
export type NatureSet = { material: THREE.MeshStandardMaterial; variants: NatureVariant[] };
export type NatureAssets = { rocks: NatureSet; pebbles: NatureSet; branches: NatureSet; stumps: NatureSet[]; trunk: NatureSet };

type Fit = 'sphere' | 'base' | 'lengthZ' | 'lengthX';

function normalise(source: THREE.BufferGeometry, fit: Fit, material: THREE.MeshStandardMaterial): NatureVariant {
  const geometry = source.clone();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!, size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const grounded = fit === 'base' || fit === 'lengthZ';
  geometry.translate(-center.x, grounded ? -box.min.y : -center.y, -center.z);
  const scale = fit === 'lengthZ' ? 1 / size.z : fit === 'lengthX' ? 1 / size.x : 1 / (Math.max(size.x, size.z) / 2);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return { geometry, size: size.multiplyScalar(scale), material };
}

function read(gltf: { scene: THREE.Object3D }, fit: Fit, material?: THREE.MeshStandardMaterial): NatureSet {
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  // By node name, so a pebble cut lines up with the rock it was cut from.
  meshes.sort((a, b) => a.name.localeCompare(b.name));
  const own = meshes[0].material as THREE.MeshStandardMaterial;
  if (material) for (const mesh of meshes) (mesh.material as THREE.Material).dispose();
  const shared = material ?? own;
  for (const map of [shared.map, shared.normalMap, shared.roughnessMap]) if (map) map.anisotropy = 8;
  // The exporter marks every scan double-sided. They are closed shells: the back faces only cost fill and shadow acne.
  shared.side = THREE.FrontSide;
  const variants = meshes.map(mesh => { const v = normalise(mesh.geometry, fit, shared); mesh.geometry.dispose(); return v; });
  return { material: shared, variants };
}

export async function loadNature(): Promise<NatureAssets> {
  const loader = new GLTFLoader(), load = (name: string) => loader.loadAsync(`/world/nature/${name}.glb`);
  // Only the grey, lichen-spotted rock set: its sibling (rock_moss_set_01) is an ochre sandstone, and brown stones on a
  // brown floor read as more floor.
  const [rockSet, pebbleSet, branches, stump1, stump2, trunk] = await Promise.all(
    ['rock_moss_set_02', 'pebbles_02', 'dry_branches_medium_01', 'tree_stump_01', 'tree_stump_02', 'dead_tree_trunk'].map(load));
  const rocks = read(rockSet, 'sphere');
  return {
    rocks, pebbles: read(pebbleSet, 'sphere', rocks.material),
    branches: read(branches, 'lengthZ'), stumps: [read(stump1, 'base'), read(stump2, 'base')], trunk: read(trunk, 'lengthX'),
  };
}
