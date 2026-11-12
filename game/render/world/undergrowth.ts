import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { WORLD_RADIUS, biomeAt } from '../../sim/world/world';
import { createEcology, type Flora, type GrownPlant } from '../../sim/world/ecology';
import type { LayoutCell } from '../../sim/world/placement';
import { createVegetationBatcher, type VegetationBatchDefinition } from './vegetation-batches';
import { createSlice, runSlice, runToEnd, type Slice } from '../../core/time-slice';
import { perfOn } from '../../core/perf-flags';
import { coastDistance, beachWidth } from '../../sim/world/coastal-geography';
import { WORLD_V2 } from '../../sim/world/world-flags';

type Plant = {
  x: number; y: number; z: number; sx: number; sz: number;
  sine: number; cosine: number; size: number; stretch: number; tint: number; kind: number; dry: number; soilR:number; soilG:number; soilB:number;
};
type GroundCover = { fine: Plant[]; tussock: Plant[] };
type Batch = VegetationBatchDefinition;

function hash(x: number, z: number, salt = 0) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(salt, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const smooth01 = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function patch(x: number, z: number) {
  return .5 + Math.sin(x * .17 + Math.sin(z * .11) * 1.9) * .23 + Math.cos(z * .21 - x * .073) * .19;
}

/**
 * A lighter copy of a mesh for far away: every point is snapped to a grid and points sharing a cell become one, so
 * triangles smaller than a cell vanish. The cell is grown until at most `keep` of the triangles are left. It works on
 * meshes of loose cards (leaves, fronds), where collapsing edges one at a time cannot get far.
 */
function gridSimplify(source: THREE.BufferGeometry, keep: number) {
  const geometry = source.index ? source : mergeVertices(source), position = geometry.attributes.position, index = geometry.index!;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3()), names = Object.keys(geometry.attributes), target = index.count / 3 * keep;
  let best: { remap: Int32Array; firsts: number[]; triangles: number[] } | undefined;
  for (let cell = Math.max(size.x, size.y, size.z) / 96; ; cell *= 1.25) {
    const cells = new Map<string, number>(), remap = new Int32Array(position.count), firsts: number[] = [], triangles: number[] = [];
    for (let i = 0; i < position.count; i++) {
      const key = `${Math.round(position.getX(i) / cell)},${Math.round(position.getY(i) / cell)},${Math.round(position.getZ(i) / cell)}`;
      let at = cells.get(key); if (at === undefined) { at = firsts.length; cells.set(key, at); firsts.push(i); }
      remap[i] = at;
    }
    for (let i = 0; i < index.count; i += 3) {
      const a = remap[index.getX(i)], b = remap[index.getX(i + 1)], c = remap[index.getX(i + 2)];
      if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
    }
    best = { remap, firsts, triangles };
    if (triangles.length / 3 <= target || cell > Math.max(size.x, size.y, size.z) / 6) break;
  }
  const result = new THREE.BufferGeometry();
  for (const name of names) {
    const from = geometry.attributes[name], array = new (from.array.constructor as Float32ArrayConstructor)(best.firsts.length * from.itemSize);
    for (let i = 0; i < best.firsts.length; i++) for (let k = 0; k < from.itemSize; k++) array[i * from.itemSize + k] = from.array[best.firsts[i] * from.itemSize + k];
    result.setAttribute(name, new THREE.BufferAttribute(array, from.itemSize, from.normalized));
  }
  result.setIndex(best.triangles);
  return result;
}

function grassPatch(variant: number, blades=32, segments=3, widthScale=1) {
  const vertices: number[] = [], uvs: number[] = [], indices: number[] = [];
  // Exact photographed blade regions in the Grass Medium 02 atlas (glTF V points down).
  const regions = [
    [.012, .198, .012, .988], [.145, .290, .165, .865],
    [.345, .448, .127, .738], [.855, .998, .010, .995],
  ];
  for (let blade = 0; blade < blades; blade++) {
    const random = (salt: number) => hash(blade, variant, salt);
    const angle = random(304) * Math.PI * 2;
    const rootAngle = blade * 2.399963 + variant;
    const radius = Math.sqrt(random(305)) * .043;
    const x = Math.cos(rootAngle) * radius, z = Math.sin(rootAngle) * radius;
    const height = .052 + random(306) * .038;
    const width = (.013 + random(307) * .011)*widthScale;
    const bend = .022 + random(308) * .061;
    const region = regions[(blade + variant) % regions.length];
    const start = vertices.length / 3;
    for (let segment = 0; segment <= segments; segment++) {
      const t = segment / segments;
      const px = x + Math.cos(angle) * bend * t * t;
      const pz = z + Math.sin(angle) * bend * t * t;
      const py = .006 + height * t - height * .12 * Math.pow(t, 5);
      for (const side of [-1, 1]) {
        vertices.push(px - Math.sin(angle) * width * side * .5, py, pz + Math.cos(angle) * width * side * .5);
        uvs.push(side < 0 ? region[0] : region[1], region[3] + (region[2] - region[3]) * t);
      }
      if (segment < segments) {
        const a = start + segment * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

/** Photographed botanical textures, original UVs, and a terrain-rooted streaming understory. */
export function createUndergrowth(
  scene: THREE.Scene,
  heightAt: (x: number, z: number) => number,
  exclusion: (x: number, z: number) => number,
  /** The forest layout's 32 m cells (trees, rocks, logs, stumps): the plants grow round them. */
  layoutCell: (cx: number, cz: number) => LayoutCell,
) {
  const group = new THREE.Group();
  group.name = 'Photographic forest understory';
  scene.add(group);
  const textureSet = new Set<THREE.Texture>();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  const fine: Batch[] = [], midFine: Batch[] = [], farFine: Batch[] = [], tussocks: Batch[] = [], farTussocks: Batch[] = [], ferns: Batch[] = [], farFerns: Batch[] = [];
  const groundCover = new Map<string, GroundCover>();
  // Two copies of the ring of plants. One is on screen while the other is rebuilt a few milliseconds per frame (game/core/time-slice.ts), and
  // they swap when it is whole; rebuilt in one go, the ring cost 8 to 60 ms every 4 m of walking.
  const buffers = [new THREE.Group(), new THREE.Group()];
  buffers[1].visible = false; group.add(buffers[0], buffers[1]);
  const batchers = [createVegetationBatcher(buffers[0]), createVegetationBatcher(buffers[1])];
  let shown = 0, target = 0, vegetation = batchers[0], job: Generator<void, void, void> | undefined;
  const slice = createSlice(3), warmSlice = createSlice(1.5);
  let definitionSerial = 0;
  const timeUniform = { value: 0 };
  const eyeUniform = { value: new THREE.Vector3(0, 2, 12) };
  const CELL = 6.4;
  const GRASS_RANGE = 33, TUSSOCK_RANGE=20, FERN_RANGE = 48;
  const STREAM_STEP=3.5, STREAM_BUFFER=4.5, FERN_LOD_START=12, FERN_LOD_END=16, TUSSOCK_LOD=[6,9] as const;
  const warmCells: {cx:number;cz:number;key:string;distance2:number}[] = [];
  const lastPosition = new THREE.Vector3(Infinity, 0, Infinity);
  let disposed = false, loaded = false;
  // Where every fern, tussock, shrub, herb and celandine grows, and how dense the short grass is: game/sim/world/ecology.ts.
  const ecology = createEcology({ heightAt, exclusion, biomeAt, layoutCell, radius: WORLD_RADIUS }, CELL);

  const trackedTexture = (texture: THREE.Texture) => {
    texture.anisotropy = 8;
    textureSet.add(texture);
    return texture;
  };
  /** `fernLOD` makes this one half of a pair that dissolve into each other across `band` metres from the eye. */
  function prepareMaterial(source: THREE.MeshStandardMaterial, alpha: THREE.Texture, distance: number, breeze: number, fernLOD?:'near'|'far', band: readonly [number, number] = [FERN_LOD_START, FERN_LOD_END]) {
    const material = source.clone();
    const reflected=distance!==GRASS_RANGE, ditherRange={value:false};
    // Albedo photographed in daylight must not be emitted again as light.
    // The previous emissive copy bypassed tree shadows and made every tuft glow.
    material.color.set(0xe2e5d1);
    material.emissiveMap = null;
    material.emissive.set(0x000000);
    material.emissiveIntensity = 0;
    material.transparent = false;
    material.alphaMap = alpha;
    material.alphaTest = .43;
    material.alphaToCoverage = true;
    material.alphaHash = reflected;
    if(reflected)material.onBeforeRender=renderer=>{ditherRange.value=(renderer.getRenderTarget()?.samples??0)<2;};
    material.side = THREE.DoubleSide;
    material.depthWrite = true;
    material.roughness = .92;
    material.metalness = 0;
    material.normalScale.set(.55, .55);
    // Every map uses the unmodified source mesh UVs; the separate mask shares glTF orientation.
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) trackedTexture(value);
    material.onBeforeCompile = shader => {
      shader.uniforms.uUnderstoryTime = timeUniform;
      shader.uniforms.uUnderstoryEye = eyeUniform;
      if(reflected)shader.uniforms.uUnderstoryDither=ditherRange;
      const fernVarying=fernLOD?'varying float vFernBlend;':'';
      shader.vertexShader = `
        uniform float uUnderstoryTime;
        uniform vec3 uUnderstoryEye;
        attribute vec2 plantSlope;
        attribute vec3 plantSoil;
        varying vec3 vPlantSoil;
        varying float vPlantRootShade;
        varying float vPlantFade;
        ${fernVarying}
        ${shader.vertexShader}
      `.replace(/void main\s*\(\s*\)\s*\{/,`void main(){
        #ifdef USE_INSTANCING
          vec2 awayFromPlayer=instanceMatrix[3].xz-uUnderstoryEye.xz;
          float distanceFromEye=length(awayFromPlayer);
          vPlantFade=1.-smoothstep(${(distance-7).toFixed(1)},${distance.toFixed(1)},distanceFromEye);
          ${fernLOD?`vFernBlend=smoothstep(${band[0].toFixed(1)},${band[1].toFixed(1)},distanceFromEye);`:''}
          if(vPlantFade<=0.${fernLOD==='near'?'||vFernBlend>=1.':fernLOD==='far'?'||vFernBlend<=0.':''}){
            gl_Position=vec4(2.,2.,2.,1.);return;
          }
        #endif
      `).replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 plantRoot = instanceMatrix[3].xyz;
          float plantScaleY = max(.01, length(instanceMatrix[1].xyz));
          vec3 acrossGround = mat3(instanceMatrix) * transformed;
          // Each root follows the actual local ground plane, including the river banks.
          transformed.y += dot(acrossGround.xz, plantSlope) / plantScaleY;
          float h = max(0., position.y);
          float wind = sin(uUnderstoryTime*.77 + plantRoot.x*.27 + plantRoot.z*.19);
          float flutter = sin(uUnderstoryTime*2.3 + plantRoot.x*.71 + h*19.);
          transformed.x += (wind*.7 + flutter*.15) * h*h * ${breeze.toFixed(3)};
          transformed.z += cos(uUnderstoryTime*.59 + plantRoot.z*.34) * h*h * ${(breeze * .35).toFixed(3)};
          float brush=1.-smoothstep(.2,.8,distanceFromEye);
          vec3 pushWorld=vec3(awayFromPlayer.x,0.,awayFromPlayer.y)/max(distanceFromEye,.08)*h*plantScaleY*.72*brush;
          mat3 plantBasis=mat3(instanceMatrix);
          vec3 inverseScale=vec3(dot(plantBasis[0],plantBasis[0]),dot(plantBasis[1],plantBasis[1]),dot(plantBasis[2],plantBasis[2]));
          transformed+=transpose(plantBasis)*pushWorld/max(inverseScale,vec3(.001));
          transformed.y-=h*.32*brush;

          vPlantRootShade = smoothstep(.008,.13,h*plantScaleY);
          vPlantSoil = plantSoil;
        #else
          vPlantFade=1.; vPlantRootShade=1.; vPlantSoil=vec3(.08,.07,.025);
          ${fernLOD?`vFernBlend=${fernLOD==='near'?'0.':'1.'};`:''}
        #endif
      `);
      shader.fragmentShader = `varying vec3 vPlantSoil; varying float vPlantRootShade; varying float vPlantFade; ${fernVarying}${reflected?'uniform bool uUnderstoryDither;':''}\n${shader.fragmentShader}`
        .replace('#include <alphatest_fragment>', `
          // MSAA coverage smooths both photographed leaf edges and the distance
          // fade. No screen-space hash speckles are added to the distant fog.
          float alphaWidth=max(fwidth(diffuseColor.a),.0001);
          diffuseColor.a=smoothstep(alphaTest-alphaWidth,alphaTest+alphaWidth,diffuseColor.a)*vPlantFade;
          if(diffuseColor.a<.003)discard;
        `)
        .replace('#include <alphahash_fragment>', reflected?`
          ${fernLOD?`if(vFernBlend>0.&&vFernBlend<1.&&getAlphaHashThreshold(vPosition)${fernLOD==='near'?'<':'>='}vFernBlend)discard;`:''}
          if(uUnderstoryDither&&vPlantFade<1.&&vPlantFade<getAlphaHashThreshold(vPosition))discard;
        `:'')
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          // Root color shares the damp litter palette rather than exposing a
          // bright card edge. Texture/color variation returns along each blade.
          diffuseColor.rgb=mix(vPlantSoil*.55,diffuseColor.rgb,vPlantRootShade);
        `)
        .replace('#include <lights_physical_pars_fragment>', `
          #include <lights_physical_pars_fragment>
          // Thin leaves transmit a little DIRECT light from behind. Three has
          // already applied the directional shadow to directLight.color here,
          // so transmission vanishes inside tree shadows, unlike emission.
          void RE_Direct_Plant(const in IncidentLight directLight,const in vec3 geometryPosition,const in vec3 geometryNormal,const in vec3 geometryViewDir,const in vec3 geometryClearcoatNormal,const in PhysicalMaterial material,inout ReflectedLight reflectedLight){
            RE_Direct_Physical(directLight,geometryPosition,geometryNormal,geometryViewDir,geometryClearcoatNormal,material,reflectedLight);
            float backlight=max(0.,dot(-geometryNormal,directLight.direction));
            reflectedLight.directDiffuse+=material.diffuseColor*directLight.color*backlight*.075*vPlantRootShade;
          }
          #undef RE_Direct
          #define RE_Direct RE_Direct_Plant
        `);
    };
    material.customProgramCacheKey = () => `silence-understory-streamed-${distance}-${breeze}-${fernLOD??''}-${band[0]}-${band[1]}`;
    materials.push(material);
    return material;
  }

  /** `cast`: the plant casts a sun shadow (its alpha cut out, as three.js does for alpha-tested materials). Only the near copies
   * cast: within the 12 to 20 m their bands reach, a fern's or shrub's shadow on the moss is what sits it in the floor. */
  function batch(geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial, capacity: number, layer?: number, name = 'Understory vegetation', cast = false): Batch {
    geometry.computeBoundingSphere();
    const slopes = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    slopes.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('plantSlope', slopes);
    const soil=new THREE.InstancedBufferAttribute(new Float32Array(capacity*3),3);soil.setUsage(THREE.DynamicDrawUsage);geometry.setAttribute('plantSoil',soil);
    geometries.push(geometry);
    return {id:`undergrowth-${definitionSerial++}`,geometry,material,capacity,layer,name,radius:2,spatial:false,castShadow:cast};
  }

  const loader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();
  async function source(asset: string, file = `${asset}.gltf`) {
    const [gltf, alpha] = await Promise.all([
      loader.loadAsync(`/plantassets/${asset}/${file}`),
      textureLoader.loadAsync(`/plantassets/${asset}/alpha.png`),
    ]);
    alpha.flipY = false; trackedTexture(alpha);
    const meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
    gltf.scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        meshes.push(object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>);
        const material = object.material as THREE.MeshStandardMaterial;
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) trackedTexture(value);
      }
    });
    // By name: the built GLBs (tools/assets/plants/build.py) hold one plant per mesh, a, b, c...
    meshes.sort((a, b) => a.name.localeCompare(b.name));
    return { gltf, alpha, meshes };
  }
  const ready = Promise.all([source('grass_medium_02'), source('fern_02'), source('grass_medium_01', 'grass_medium_01.glb'),
    source('celandine_01', 'celandine_01.glb'), source('shrub_01', 'shrub_01.glb'), source('shrub_04', 'shrub_04.glb')]).then(sources => {
    if (disposed) {
      for (const { meshes } of sources) for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
      for (const texture of textureSet) texture.dispose();
      return;
    }
    const [grass, fern, lushGrass, celandine, herb, shrub] = sources;
    const fineMaterial = prepareMaterial(grass.meshes[0].material, grass.alpha, 33, 1.4);
    // Tussocks are the deep green Grass Medium 01: the paler Medium 02 read as dry straw on the damp, mossy floor.
    const grassMaterial = prepareMaterial(lushGrass.meshes[0].material, lushGrass.alpha, TUSSOCK_RANGE, .6, 'near', TUSSOCK_LOD);
    const farGrassMaterial = prepareMaterial(lushGrass.meshes[0].material, lushGrass.alpha, TUSSOCK_RANGE, .6, 'far', TUSSOCK_LOD);
    const fernMaterial = prepareMaterial(fern.meshes[0].material, fern.alpha, FERN_RANGE, .17,'near');
    const farFernMaterial = prepareMaterial(fern.meshes[0].material, fern.alpha, FERN_RANGE, .17,'far');
    // One exposure/albedo scale across low grass and taller clumps prevents
    // identical atlas regions becoming abruptly brighter at a species/LOD edge.
    fernMaterial.color.set(0xe0e7ce);
    farFernMaterial.color.copy(fernMaterial.color);
    const simplifier = new SimplifyModifier();
    // Individually bowed blades retain exact photographs, veins, mottling, and alpha silhouettes.
    // A broad 32-blade cluster costs only 192 triangles and stays below 30cm after placement.
    for (let variant = 0; variant < 4; variant++) {
      fine.push(batch(grassPatch(variant), fineMaterial, 900, 2, 'Fine grass LOD'));
      midFine.push(batch(grassPatch(variant,20,2,1.2),fineMaterial,1800, 2, 'Fine grass LOD'));
      farFine.push(batch(grassPatch(variant,16,1,1.65),fineMaterial,7200, 2, 'Fine grass LOD'));
    }
    for (const mesh of lushGrass.meshes) {
      const geometry = mesh.geometry.clone();
      geometry.translate(0, .004, 0);
      tussocks.push(batch(geometry, grassMaterial, 480, undefined, 'Understory tussock', true));
      // A scanned tussock is up to 1,660 triangles and some 900 stand within 20 m: over a million triangles, more than
      // every tree in view. Past a few metres it is drawn from a copy with about a quarter of them.
      farTussocks.push(batch(gridSimplify(geometry, .26), farGrassMaterial, 480));
    }
    for (const sourceMesh of fern.meshes) {
      const geometry = sourceMesh.geometry.clone();
      // Stem bases intentionally sink by a few millimetres into the damp litter.
      geometry.translate(0, .01, 0);
      // Beyond 12 to 16 m a fern is drawn from this lighter copy, out to 48 m: some 1,700 of them at once. The edge
      // collapser gets stuck on these scans (each leaflet is its own island) and left up to 1,660 triangles a plant,
      // 2 million in all: the largest thing in the frame. Snapping the points to a coarse grid instead draws the same
      // frond outlines, which at that range are a few pixels wide, with about a fifth of the triangles.
      const lowDetail = perfOn('fernLod') ? gridSimplify(geometry, .2) : simplifier.modify(geometry, Math.floor(geometry.attributes.position.count * .66));
      ferns.push(batch(geometry, fernMaterial, 400, undefined, 'Understory fern', true));
      farFerns.push(batch(lowDetail, farFernMaterial, 1400));
    }
    // The other plants of the floor, each with a full copy near and a grid-simplified one further out that dissolve
    // into each other across `band`, like the ferns.
    const addSpecies = (name: string, from: typeof herb, flora: Flora, range: number, band: readonly [number, number], breeze: number, capacity: number) => {
      const near = prepareMaterial(from.meshes[0].material, from.alpha, range, breeze, 'near', band);
      const far = prepareMaterial(from.meshes[0].material, from.alpha, range, breeze, 'far', band);
      far.color.copy(near.color);
      const entry: Kind = { flora, range, band, near: [], far: [] };
      for (const mesh of from.meshes) {
        const geometry = mesh.geometry.clone();
        geometry.translate(0, -.006, 0);
        entry.near.push(batch(geometry, near, capacity, undefined, name, true));
        entry.far.push(batch(gridSimplify(geometry, .22), far, capacity * 2, undefined, `${name} distant`));
      }
      kinds.push(entry);
    };
    kinds.push({ flora: 'fern', near: ferns, far: farFerns, range: FERN_RANGE, band: [FERN_LOD_START, FERN_LOD_END] });
    kinds.push({ flora: 'tussock', near: tussocks, far: farTussocks, range: TUSSOCK_RANGE, band: TUSSOCK_LOD });
    addSpecies('Lesser celandine', celandine, 'celandine', 26, [8, 12], .5, 700);
    addSpecies('Woodland herbs', herb, 'herb', 34, [10, 14], .35, 300);
    addSpecies('Understory shrubs', shrub, 'shrub', 40, [12, 16], .22, 500);
    const sourceMaterials = new Set<THREE.Material>();
    for (const { meshes } of sources) for (const mesh of meshes) { mesh.geometry.dispose(); sourceMaterials.add(mesh.material); }
    sourceMaterials.forEach(material => material.dispose());
    loaded = true;
    group.userData.ready = true;
    lastPosition.set(Infinity, 0, Infinity);
  }).catch(error => {
    // Loading failures remain visible to diagnostics; they never create game HUD content.
    console.error('SILENCE: botanical assets could not be loaded.', error);
    group.userData.error = String(error);
  });

  function makePlant(x: number, z: number, ix: number, iz: number, salt: number, kind: number, size: number, biome = biomeAt(x,z)): Plant {
    const y = heightAt(x, z),leaf=biome.grove+biome.heath*.55;
    const slopeX = (heightAt(x + .18, z) - heightAt(x - .18, z)) / .36;
    const slopeZ = (heightAt(x, z + .18) - heightAt(x, z - .18)) / .36;
    const yaw = hash(ix, iz, salt + 3) * Math.PI * 2;
    return {
      x, y: y - .012, z, sx: slopeX, sz: slopeZ, kind, size,
      sine:Math.sin(yaw),cosine:Math.cos(yaw),
      stretch: .75 + hash(ix, iz, salt + 7) * .58,
      tint: .77 + hash(ix, iz, salt + 11) * .32,
      dry:biome.heath*.83+biome.alpine*.45,
      soilR:.085*(1-leaf)+.091*leaf,soilG:.071*(1-leaf)+.061*leaf,soilB:.026*(1-leaf)+.023*leaf,
    };
  }
  // A cell of ground cover is 400 grass candidates and 35 tussocks: 3 ms on average and up to 27 ms near the coast and the POIs,
  // too much for one frame. It is built a row at a time and can stop between rows (see growGroundCover).
  const partialCover = new Map<string, { cell: GroundCover; row: number }>();
  function groundCoverRow(cx: number, cz: number, ax: number, cell: GroundCover) {
    for (let az = 0; az < 20; az++) {
      const ix = cx * 20 + ax, iz = cz * 20 + az;
      const x = (ix + .12 + hash(ix, iz, 1) * .76) * .32;
      const z = (iz + .12 + hash(ix, iz, 2) * .76) * .32;
      if (Math.hypot(x, z) > WORLD_RADIUS-55) continue;
      const dune = WORLD_V2 && coastDistance(x,z)>beachWidth(x,z)*.82 && coastDistance(x,z)<beachWidth(x,z)+18;
      const e = dune ? Math.min(.2,exclusion(x,z)) : exclusion(x, z);
      if (e > .91) continue;
      const cover = patch(x, z);
      const biome=biomeAt(x,z);
      // Short grass follows the ecology's grass field: light gaps, path margins and drier ground, none in the bare patches.
      const probability = (.30 + cover * .40) * (1 - Math.pow(e, 1.3) * .93) * (1-biome.alpine*.93) * (dune ? 1 : 1.2 * smooth01(ecology.grass(x, z), .22, .6));
      if (hash(ix, iz, 5) > probability) continue;
      if (Math.abs(x + 18) < 1.55 && Math.abs(z + 46) < 1.05 && hash(ix, iz, 93) > .12) continue;
      const size = Math.min(3, (1.8 + hash(ix, iz, 8) * 1.8) * (.72 + cover * .48) * (1 - e * .42));
      const plant=makePlant(x,z,ix,iz,20,Math.floor(hash(ix,iz,14)*4),size*(dune?1.2:1),biome);
      if(dune){
        if(patch(x*.7+17,z*.7)<.42)continue;
        plant.dry=.85;plant.soilR=.34;plant.soilG=.27;plant.soilB=.17;
      }
      if(Math.hypot(plant.sx,plant.sz)<.75)cell.fine.push(plant);
    }
  }
  function tussockRow(cx: number, cz: number, cell: GroundCover) {
    for (let i = 0; i < 35; i++) {
      const x = (cx + hash(cx * 37 + i, cz, 101)) * CELL;
      const z = (cz + hash(cx, cz * 41 + i, 103)) * CELL;
      if (Math.hypot(x, z) > WORLD_RADIUS-55 || Math.hypot(x + 18, z + 46) < 2) continue;
      // Dune grass only: everywhere else the tussocks are grown with the other plants (growFlora).
      const dune = WORLD_V2 && coastDistance(x,z)>beachWidth(x,z)*.74 && coastDistance(x,z)<beachWidth(x,z)+14;
      if (!dune) continue;
      const e = Math.min(.25,exclusion(x,z)), p = patch(x, z);
      if (hash(cx * 39 + i, cz, 104) > (.3 + p * .57) * (1 - e) * (1-biomeAt(x,z).alpine*.91)) continue;
      const plant=makePlant(x,z,cx*59+i,cz,105,i%3,(dune?1.35:.9)+hash(cx*67+i,cz,107)*1.15);
      if(dune){plant.dry=.95;plant.soilR=.34;plant.soilG=.27;plant.soilB=.17;}
      if(Math.hypot(plant.sx,plant.sz)<.65)cell.tussock.push(plant);
    }
  }
  /** Builds rows of the cell until it is complete (returned) or `budget` is used up (undefined; call again to carry on). */
  function growGroundCover(cx: number, cz: number, key: string, budget?: Slice): GroundCover | undefined {
    let partial = partialCover.get(key);
    if (!partial) { partial = { cell: { fine: [], tussock: [] }, row: 0 }; partialCover.set(key, partial); }
    while (partial.row <= 20) {
      if (partial.row < 20) groundCoverRow(cx, cz, partial.row, partial.cell); else tussockRow(cx, cz, partial.cell);
      partial.row++;
      if (partial.row <= 20 && budget?.over()) return undefined;
    }
    partialCover.delete(key); groundCover.set(key, partial.cell);
    return partial.cell;
  }
  const buildGroundCover = (cx: number, cz: number, key: string) => growGroundCover(cx, cz, key)!;
  /** The ferns, tussocks, shrubs, herbs and celandine of a cell, as game/sim/world/ecology.ts grows them, by plant. */
  type Kind = { flora: Flora; near: Batch[]; far: Batch[]; range: number; band: readonly [number, number] };
  const kinds: Kind[] = [];
  const floraCells = new Map<string, Map<Flora, Plant[]>>();
  function toPlant(g: GrownPlant): Plant | undefined {
    if (Math.hypot(g.x + 18, g.z + 46) < 2.1) return;
    const sx = (heightAt(g.x + .18, g.z) - heightAt(g.x - .18, g.z)) / .36, sz = (heightAt(g.x, g.z + .18) - heightAt(g.x, g.z - .18)) / .36;
    if (Math.hypot(sx, sz) > .6) return;
    const leaf = Math.min(1, g.leaf);
    return { x: g.x, y: heightAt(g.x, g.z) - .012, z: g.z, sx, sz, kind: g.variant, size: g.size, sine: Math.sin(g.yaw), cosine: Math.cos(g.yaw),
      stretch: .85 + .3 * (g.variant * 37 % 64) / 64, tint: g.tint, dry: g.dry,
      soilR: .085 * (1 - leaf) + .091 * leaf, soilG: .071 * (1 - leaf) + .061 * leaf, soilB: .026 * (1 - leaf) + .023 * leaf };
  }
  function growFlora(cx: number, cz: number, key: string) {
    const byFlora = new Map<Flora, Plant[]>();
    for (const g of ecology.grow(cx, cz)) {
      const plant = toPlant(g);
      if (!plant) continue;
      let list = byFlora.get(g.flora);
      if (!list) byFlora.set(g.flora, list = []);
      list.push(plant);
    }
    floraCells.set(key, byFlora);
    return byFlora;
  }
  const color=new THREE.Color();
  function place(plant:Plant,batches:Batch[],fineBlade=false){
    const b=batches[plant.kind%batches.length];
    const handle=vegetation.allocate(b,plant.x,plant.z,2,plant.y); if(!handle)return;
    const i=handle.index,offset=i*16,a=handle.mesh.instanceMatrix.array;
    // Cached orientation and direct typed-array writes avoid quaternion/matrix
    // work for thousands of unchanged plants whenever the visible ring refreshes.
    const sx=plant.size,sy=plant.size*(fineBlade?Math.min(1.1,plant.stretch):plant.stretch);
    a[offset]=plant.cosine*sx;a[offset+2]=-plant.sine*sx;
    a[offset+5]=sy;a[offset+8]=plant.sine*sx;a[offset+10]=plant.cosine*sx;
    a[offset+12]=plant.x;a[offset+13]=plant.y;a[offset+14]=plant.z;a[offset+15]=1;
    color.setRGB(plant.tint*(.94+plant.dry*.2),plant.tint*(1-plant.dry*.08),plant.tint*(.86-plant.dry*.18));handle.mesh.setColorAt(i,color);
    const slopes=handle.mesh.geometry.getAttribute('plantSlope') as THREE.InstancedBufferAttribute;
    const soil=handle.mesh.geometry.getAttribute('plantSoil') as THREE.InstancedBufferAttribute;
    slopes.setXY(i,plant.sx,plant.sz);
    // Linear albedo averages of the actual soil/leaf atlases after terrain tint.
    // Root contact is darkened in the shader; biome interpolation stays smooth.
    const variation=.86+plant.tint*.14;
    soil.setXYZ(i,plant.soilR*variation,plant.soilG*variation,plant.soilB*variation);
  }
  function* refresh(player: THREE.Vector3, sliced: boolean): Generator<void, void, void> {
    vegetation.begin();
    warmCells.length = 0;
    const cx0 = Math.floor(player.x / CELL), cz0 = Math.floor(player.z / CELL);
    const range=Math.ceil((FERN_RANGE+STREAM_BUFFER)/CELL);
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        const cx = cx0 + dx, cz = cz0 + dz;
        const x = Math.abs((cx + .5) * CELL - player.x), z = Math.abs((cz + .5) * CELL - player.z);
        // Only generate a layer if some point in the cell can enter its LOD.
        const distance2 = Math.max(0,x-CELL*.5)**2 + Math.max(0,z-CELL*.5)**2;
        const key = `${cx},${cz}`;
        if (distance2 < (GRASS_RANGE+STREAM_BUFFER)**2) {
          let cell = groundCover.get(key);
          if (!cell && sliced) while (!(cell = growGroundCover(cx, cz, key, slice))) yield;
          cell ??= buildGroundCover(cx, cz, key);
          for(const plant of cell.fine){
            const distance2=(plant.x-player.x)**2+(plant.z-player.z)**2;
            if(distance2>=(GRASS_RANGE+STREAM_BUFFER)**2)continue;
            // Stagger changes per tuft rather than switching a visible circular ring.
            const stagger=hash(Math.floor(plant.x*20),Math.floor(plant.z*20),91)*4-1;
            place(plant,distance2<(7+stagger)**2?fine:distance2<(15+stagger)**2?midFine:farFine,true);
          }
          for (const plant of cell.tussock) {
            const distance2 = (plant.x - player.x) ** 2 + (plant.z - player.z) ** 2;
            if (distance2 >= (TUSSOCK_RANGE+STREAM_BUFFER)**2) continue;
            // Across the band both copies are placed and the shader dissolves the full one into the light one.
            if (distance2 < (TUSSOCK_LOD[1] + STREAM_BUFFER) ** 2) place(plant, tussocks);
            if (distance2 > Math.max(0, TUSSOCK_LOD[0] - STREAM_BUFFER) ** 2) place(plant, farTussocks);
          }
        } else if (distance2 < (GRASS_RANGE+STREAM_BUFFER+STREAM_STEP+2)**2 && !groundCover.has(key)) {
          warmCells.push({cx,cz,key,distance2});
        }
        if (distance2 >= (FERN_RANGE+STREAM_BUFFER)**2) continue;
        const flora = floraCells.get(key) ?? growFlora(cx, cz, key);
        for (const k of kinds) {
          if (distance2 >= (k.range + STREAM_BUFFER) ** 2) continue;
          for (const plant of flora.get(k.flora) ?? []) {
            const d2 = (plant.x - player.x) ** 2 + (plant.z - player.z) ** 2;
            // Across the band both copies are placed and the shader dissolves the full one into the light one.
            if (d2 < (k.band[1] + STREAM_BUFFER) ** 2) place(plant, k.near);
            if (d2 > Math.max(0, k.band[0] - STREAM_BUFFER) ** 2 && d2 < (k.range + STREAM_BUFFER) ** 2) place(plant, k.far);
          }
        }
        if (sliced && slice.over()) yield;
      }
    }
    vegetation.end();
    warmCells.sort((a,b)=>b.distance2-a.distance2);
    ecology.forget(player.x, player.z, 12);
    for (const cache of [groundCover, floraCells]) for (const key of cache.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - cx0) > 11 || Math.abs(cz - cz0) > 11) cache.delete(key);
    }
    for (const key of partialCover.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - cx0) > 11 || Math.abs(cz - cz0) > 11) partialCover.delete(key);
    }
    const built = vegetation, total=(list:Batch[])=>list.reduce((n,b)=>n+built.count(b),0);
    group.userData.counts = { fine: total([...fine,...midFine,...farFine]), closeGrass:total(fine), detailedFerns: total(ferns),
      ...Object.fromEntries(kinds.map(k => [k.flora, total([...k.near, ...k.far])])) };
    lastPosition.copy(player);
    // The ring just finished goes on screen; the one that was showing is the next to rebuild.
    if (target !== shown) { buffers[target].visible = true; buffers[shown].visible = false; shown = target; target = 1 - target; vegetation = batchers[target]; }
  }
  return {
    ready,
    /** `deferRefresh`: the forest is rebuilding this frame, so no new ring is started (one already under way carries on). */
    update(time: number, player: THREE.Vector3, deferRefresh = false) {
      timeUniform.value = time; eyeUniform.value.copy(player);
      if (!loaded || disposed) return;
      if (job) {
        // The ring on screen covers the view while the player is within STREAM_BUFFER of where it was built; past that (a very
        // low frame rate) the rest of the new one is built now rather than show bare ground at the edge.
        if (player.distanceToSquared(lastPosition) > STREAM_BUFFER ** 2) { runToEnd(job); job = undefined; }
        else if (runSlice(job, slice)) job = undefined;
        return;
      }
      // Prepare beyond the visible fade so a plant can reach full coverage
      // without waiting for the next ring refresh.
      const moved = lastPosition.distanceToSquared(player);
      // Waiting a few frames for the forest is fine while there is room to spare before the ring on screen runs out.
      if (deferRefresh && moved < (STREAM_STEP + .4) ** 2) return;
      if (moved > STREAM_STEP ** 2) {
        const sliced = perfOn('slicedRefresh');
        target = sliced ? 1 - shown : shown; vegetation = batchers[target];
        job = refresh(player.clone(), sliced);
        // The first ring, and a jump of tens of metres, are built at once: the ring on screen is no use there.
        if (!sliced || !Number.isFinite(moved) || moved > 40 * 40) { runToEnd(job); job = undefined; }
        else if (runSlice(job, slice)) job = undefined;
      } else {
        // Spread the next ring's grass generation over ordinary frames, a few rows at a time.
        const cell = warmCells.at(-1);
        if (cell) { warmSlice.begin(); if (groundCover.has(cell.key) || growGroundCover(cell.cx, cell.cz, cell.key, warmSlice)) warmCells.pop(); }
      }
    },
    dispose() {
      disposed = true;
      // Sector wrappers detach shared static vertex/index attributes before
      // disposing their geometries; release them before the source geometries.
      job = undefined; for (const batcher of batchers) batcher.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textureSet) texture.dispose();
      groundCover.clear(); floraCells.clear(); warmCells.length=0; scene.remove(group);
    },
  };
}
