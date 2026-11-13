import * as THREE from 'three';
import { FAR_RANGE, farRangeHeight } from './far-range-shape';
import { mountainLayers, mountainGLSL } from './mountain-surface';
import { horizonAngles, gridHeights, horizonGLSL } from './terrain-horizon';

/**
 * The far mountains (far-range-shape.ts has the shape and why): one mesh, a polar grid round the world's middle, finer across
 * the arc than along the rays because the eye reads a skyline's crests, not its depth. 960 x 140 cells: 46 m between crests at
 * the far edge, under 3 px at 1280 wide. Lit like everything else (sun, sky, the environment's ambient); its surface is the
 * island range's (mountain-surface.ts) at six times the scale. No shadow map reaches 2 km, so it neither casts nor takes
 * shadows; the faces turned from the sun are shaded by the light alone. The haze over it is the long-range air in
 * atmosphere.ts, which thins with height, so its summits stand clear of the haze that hides its feet.
 */
const AZIMUTHS = 960, RINGS = 140, UP = new THREE.Vector3(0, 1, 0);

export function createFarRange(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array((AZIMUTHS + 1) * (RINGS + 1) * 3);
  // Rings spaced in proportion to their distance: as fine in the eye at 2 km as at 9.
  const ratio = (FAR_RANGE.outer / FAR_RANGE.inner) ** (1 / RINGS);
  let k = 0;
  for (let j = 0; j <= RINGS; j++) {
    const r = FAR_RANGE.inner * ratio ** j;
    for (let i = 0; i <= AZIMUTHS; i++) {
      const phi = -FAR_RANGE.sweep + 2 * FAR_RANGE.sweep * i / AZIMUTHS, x = r * Math.sin(phi), z = r * Math.cos(phi);
      positions[k++] = x; positions[k++] = farRangeHeight(x, z); positions[k++] = z;
    }
  }
  const index = new Uint32Array(AZIMUTHS * RINGS * 6);
  k = 0;
  for (let j = 0; j < RINGS; j++) for (let i = 0; i < AZIMUTHS; i++) {
    const a = j * (AZIMUTHS + 1) + i, b = a + 1, c = a + AZIMUTHS + 1, d = c + 1;
    // Counter-clockwise seen from above, so the faces (and normals) point up: wound the other way, the island saw the range's
    // inside, flat-lit and with overhanging undersides at its foot.
    index[k++] = a; index[k++] = c; index[k++] = b; index[k++] = b; index[k++] = c; index[k++] = d;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  // Its own shadows and sky occlusion (terrain-horizon.ts): horizons from a 50 m grid of the range, out to 3 km.
  {
    const n = 381, step = 50, x0 = -9500, grid = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid[j * n + i] = farRangeHeight(x0 + i * step, x0 + j * step);
    const count = positions.length / 3, angles = horizonAngles(positions, count, gridHeights(grid, n, step, x0, x0), step, 3000);
    const a = new Uint8Array(count * 4), b = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) for (let q = 0; q < 4; q++) { a[i * 4 + q] = angles[i * 8 + q]; b[i * 4 + q] = angles[i * 8 + 4 + q]; }
    geometry.setAttribute('horizonA', new THREE.BufferAttribute(a, 4, true)); geometry.setAttribute('horizonB', new THREE.BufferAttribute(b, 4, true));
  }
  geometry.computeBoundingSphere();

  const layers = mountainLayers(renderer);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .95, metalness: 0 });
  material.onBeforeCompile = shader => {
    shader.uniforms.uMountainColor = { value: layers.color }; shader.uniforms.uMountainSurface = { value: layers.surface };
    shader.uniforms.uSunDirection = { get value() { return (scene.userData.sunDirection as THREE.Vector3 | undefined) ?? UP; } };
    shader.vertexShader = `attribute vec4 horizonA,horizonB;varying vec4 vHorizonA,vHorizonB;varying vec3 vFarWorld;varying vec3 vFarNormal;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvHorizonA=horizonA;vHorizonB=horizonB;vFarWorld=(modelMatrix*vec4(transformed,1.)).xyz;vFarNormal=normalize(mat3(modelMatrix)*objectNormal);');
    // The same surface as the island's range at six times its scale: zones, strata and tones grow with the land (a tree line at
    // 650 m, snow from 1.25 km: at 1.65 km the range's crests seen from the island held almost none), while the grain stays the scans' own size.
    shader.fragmentShader = `uniform vec3 uSunDirection;varying vec3 vFarWorld;varying vec3 vFarNormal;\n${mountainGLSL}\n${horizonGLSL}\nMountain farLook;\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', 'farLook=mountainLook(vFarWorld,normalize(vFarNormal),6.,vec2(650.,1250.));diffuseColor.rgb*=farLook.albedo;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor=farLook.roughness;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal=normalize(mat3(viewMatrix)*farLook.normal);')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n{float sh=horizonShadow(normalize(uSunDirection)),sky=horizonSky();reflectedLight.directDiffuse*=sh;reflectedLight.directSpecular*=sh;reflectedLight.indirectDiffuse*=sky;reflectedLight.indirectSpecular*=sky;}');
  };
  material.customProgramCacheKey = () => 'silence-far-range-v10';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Far mountain range';
  // Drawn with the horizon (layer 2: the main view, not the water's reflection), after the ground so the near land's depth
  // spares it the pixels it covers, and before the sky.
  mesh.layers.set(2); mesh.renderOrder = 3; mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    mesh,
    dispose() { scene.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}
