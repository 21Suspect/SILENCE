import * as THREE from 'three';

/** A soft round falloff in plain texture data: no canvas needed, so it also builds under Node. Shared by the lights that glow (mast beacon, hut window, pad lamps, helicopter beacon). */
export function glowTexture() {
  const n = 32, data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.min(1, Math.hypot(x - 15.5, y - 15.5) / 15.5), a = (1 - d) ** 2.2, i = (y * n + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
}
