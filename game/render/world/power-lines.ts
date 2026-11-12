import * as THREE from 'three';
import assets from './world-assets.json';
import { SCATTER_PLACEMENTS } from './world-layout';

const SEGMENTS = 10, SIDES = 3, RADIUS = .011, SAG = .55;

/** Three sagging conductors strung through every pole beside the road, as one thin mesh. */
export function createPowerLines(scene: THREE.Scene, heightAt: (x: number, z: number) => number) {
  const hooks = (assets as unknown as Record<string, { hooks: Record<string, number[]> }>).pole?.hooks;
  const poles = SCATTER_PLACEMENTS.filter(p => p.asset === 'pole').sort((a, b) => a.x - b.x);
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), tangent = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
  const anchor = (pole: typeof poles[number], hook: number[], out: THREE.Vector3) => {
    const co = Math.cos(pole.yaw), si = Math.sin(pole.yaw);
    return out.set(pole.x + hook[0] * co + hook[2] * si, heightAt(pole.x, pole.z) + hook[1], pole.z - hook[0] * si + hook[2] * co);
  };
  if (hooks) for (let p = 0; p < poles.length - 1; p++) {
    // Rivers break the line: never string a wire across a gap of more than two spans.
    if (poles[p + 1].x - poles[p].x > 80) continue;
    for (const name of ['wire_l', 'wire_c', 'wire_r']) {
      anchor(poles[p], hooks[name], a); anchor(poles[p + 1], hooks[name], b);
      tangent.subVectors(b, a).normalize(); side.crossVectors(tangent, THREE.Object3D.DEFAULT_UP).normalize(); up.crossVectors(side, tangent).normalize();
      const start = positions.length / 3;
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS;
        v.lerpVectors(a, b, t); v.y -= SAG * 4 * t * (1 - t);
        for (let j = 0; j < SIDES; j++) {
          const angle = j / SIDES * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
          normals.push(side.x * c + up.x * s, side.y * c + up.y * s, side.z * c + up.z * s);
          positions.push(v.x + (side.x * c + up.x * s) * RADIUS, v.y + (side.y * c + up.y * s) * RADIUS, v.z + (side.z * c + up.z * s) * RADIUS);
        }
      }
      for (let i = 0; i < SEGMENTS; i++) for (let j = 0; j < SIDES; j++) {
        const j2 = (j + 1) % SIDES, q = start + i * SIDES;
        indices.push(q + j, q + SIDES + j, q + j2, q + j2, q + SIDES + j, q + SIDES + j2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  const material = new THREE.MeshStandardMaterial({ color: 0x14130f, roughness: .7, metalness: .2 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Power lines'; mesh.frustumCulled = false;
  scene.add(mesh);
  return { dispose() { scene.remove(mesh); geometry.dispose(); material.dispose(); } };
}
