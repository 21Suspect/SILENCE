import * as THREE from 'three';

const SHADOW_SIDE: Record<number, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

type Caster = THREE.Mesh & { customDepthMaterial?: THREE.Material; isInstancedMesh?: boolean; instanceColor?: THREE.InstancedBufferAttribute | null; isSkinnedMesh?: boolean };

/**
 * Shadow-pass programs, built ahead of time.
 *
 * renderer.compile() builds the programs a mesh needs in the main view, but not the depth program the same mesh needs in the sun's
 * and the torch's shadow maps: three.js makes that one the first time the mesh is drawn into a shadow map, which for a streamed prop
 * was a 15 to 116 ms stall the moment it came into range. Which depth program a caster needs depends on its material (map, alpha
 * test, side, displacement), on the mesh type (instanced or not) and, because three.js keys every program by the scene's light
 * counts, on the light state (torch, street lamps). This mirrors what WebGLShadowMap.getDepthMaterial picks for each caster, puts a
 * stand-in mesh with that depth material in a small group and compiles the group against the real scene, so the programs are in
 * three.js's program cache (shared by key, whatever the material instance) before the real caster is ever drawn.
 *
 * Only directional and spot shadows (MeshDepthMaterial) are covered: no point light in the game casts a shadow.
 * The stand-in materials are kept for the life of the game; disposing them would release the programs they built.
 */
export function createShadowProgramWarmer(renderer: THREE.WebGLRenderer) {
  const base = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const standIns = new Map<string, THREE.Mesh>();

  /** The depth material three.js would draw `mesh` with for `material`, as a stand-in, and the key it is kept under. */
  function standInFor(mesh: Caster, material: THREE.Material) {
    const m = material as THREE.MeshStandardMaterial & { alphaToCoverage: boolean; shadowSide: THREE.Side | null };
    const custom = mesh.customDepthMaterial;
    const side = m.shadowSide ?? SHADOW_SIDE[m.side];
    const alphaTest = m.alphaToCoverage ? .5 : m.alphaTest;
    const displaced = !!m.displacementMap && m.displacementScale !== 0;
    const instanced = !!mesh.isInstancedMesh, coloured = instanced && !!mesh.instanceColor;
    const key = [custom?.uuid ?? 'base', side, !!m.map, !!m.alphaMap, alphaTest > 0, displaced, instanced, coloured, !!mesh.isSkinnedMesh,
      Object.keys(mesh.geometry.morphAttributes).length, m.visible].join('|');
    if (standIns.has(key) || mesh.isSkinnedMesh || !m.visible) return key;
    const source = custom ?? base;
    const depth = source.clone() as THREE.MeshDepthMaterial;
    // clone() does not carry these over, and they are what makes a custom depth material's program its own.
    depth.onBeforeCompile = source.onBeforeCompile; depth.customProgramCacheKey = source.customProgramCacheKey;
    depth.side = side; depth.map = m.map ?? null; depth.alphaMap = m.alphaMap ?? null; depth.alphaTest = alphaTest;
    if (displaced) { depth.displacementMap = m.displacementMap; depth.displacementScale = m.displacementScale; depth.displacementBias = m.displacementBias; }
    let standIn: THREE.Mesh;
    if (instanced) {
      const im = new THREE.InstancedMesh(mesh.geometry, depth, 1);
      if (coloured) im.instanceColor = mesh.instanceColor!;
      standIn = im;
    } else standIn = new THREE.Mesh(mesh.geometry, depth);
    standIn.frustumCulled = false;
    standIns.set(key, standIn);
    return key;
  }

  return {
    /**
     * Builds the depth programs every shadow caster in `object` will need, for the lights as they are now in `scene` (call once per
     * light state, as the GPU warm-up does for the main-view programs). Returns how many distinct depth variants `object` needs.
     */
    compile(object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene) {
      const keys = new Set<string>();
      object.traverse(o => {
        const mesh = o as Caster;
        if (!mesh.isMesh || !mesh.castShadow || !mesh.material) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) keys.add(standInFor(mesh, material));
      });
      const group = new THREE.Group();
      for (const key of keys) { const standIn = standIns.get(key); if (standIn) group.children.push(standIn); }
      // The shadow pass draws with an empty scene: no fog in the key (the game has none, but a fog would make the keys differ).
      const fog = scene.fog; scene.fog = null;
      try { if (group.children.length) renderer.compile(group, camera, scene); } finally { scene.fog = fog; group.children.length = 0; }
      return keys.size;
    },
    get variants() { return standIns.size; },
  };
}
export type ShadowProgramWarmer = ReturnType<typeof createShadowProgramWarmer>;
