import * as THREE from 'three';
import { INSTANCE_CULL_HEADER, instanceCullGLSL, instanceCullSwitch } from './instance-cull';
import { foliageLite } from './foliage-shading';
import type { AlderModel, AlderPart } from './alder';

/**
 * The alders' materials (alder.ts has the meshes). One set a model and level, so each carries its own bounds as uniforms while all
 * share one shader program a kind (the program key does not name the model). Every material dissolves by the distance of its instance
 * from the eye with the dither the rest of the forest uses (forest.ts fadeInstances): a level fades in across the band it takes over
 * from the finer one (`inBand`, metres) and out across the band the coarser one takes over (`outBand`), so the levels overlap and
 * never switch. All of them thin out to nothing at the edge of the fog (`rangeFrom`, `rangeTo`).
 */
export type AlderMaterials = ReturnType<typeof createAlderMaterials>;

const BARK = new Set(['Tileable', 'Trunk_01', 'Trunk_02']);

export function createAlderMaterials(textureBase: string, forestEye: { value: THREE.Vector3 }, windTime: { value: number }, rangeFrom: number, rangeTo: number, uploads: THREE.Texture[]) {
  const loader = new THREE.TextureLoader(), maps = new Map<string, THREE.Texture>();
  const map = (name: string, srgb: boolean, anisotropy: number) => {
    const key = `${name}`;
    let t = maps.get(key);
    if (!t) {
      t = loader.load(`${textureBase}${name}.webp`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      maps.set(key, t); uploads.push(t);
    }
    return t;
  };
  const all: THREE.Material[] = [];
  const cache = new Map<string, THREE.Material[]>();

  function base(part: string): THREE.MeshStandardMaterial {
    if (BARK.has(part)) return new THREE.MeshStandardMaterial({ map: map(`${part}_albedo`, true, 8), normalMap: map(`${part}_normal`, false, 8), roughness: 1, normalScale: new THREE.Vector2(1, 1) });
    const cut = part === 'Decoration';
    return new THREE.MeshStandardMaterial({
      map: map(`${part}_albedo`, true, 4), normalMap: map(`${part}_normal`, false, 4), roughness: cut ? 1 : .82, normalScale: new THREE.Vector2(.8, .8),
      alphaTest: .5, alphaToCoverage: true, side: THREE.DoubleSide,
      // The scanned summer leaf averages 0.06 linear albedo (sRGB 70): the lighting of the world turns that to near black. Real
      // leaves reflect 0.10 to 0.18, and a little more green than the scan shows.
      color: cut ? 0xffffff : new THREE.Color().setRGB(2.4, 2.6, 1.9),
    });
  }

  type Band = readonly [number, number] | undefined;
  function dissolve(material: THREE.MeshStandardMaterial, model: AlderModel, leaf: boolean, inBand: Band, outBand: Band) {
    const compile = material.onBeforeCompile, cacheKey = material.customProgramCacheKey();
    material.alphaHash = true;
    material.customProgramCacheKey = () => `${cacheKey}-alder-${leaf ? 'leaf' : 'wood'}`;
    const tree = { value: new THREE.Vector4(model.height, -.5, model.height + 1, model.reach + .5) };
    // (in start, in end, out start, out end) squared; no fade in is an edge pair under every distance, no fade out one beyond them all.
    const bands = { value: new THREE.Vector4(...(inBand ? [inBand[0] ** 2, inBand[1] ** 2] : [-2, -1]), ...(outBand ? [outBand[0] ** 2, outBand[1] ** 2] : [1e9, 1e9 + 1])) };
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      shader.uniforms.uForestEye = forestEye; shader.uniforms.uInstanceCull = instanceCullSwitch;
      shader.uniforms.uTree = tree; shader.uniforms.uBands = bands; shader.uniforms.uAlderTime = windTime;
      shader.vertexShader = `${INSTANCE_CULL_HEADER}uniform vec3 uForestEye;uniform vec4 uTree,uBands;uniform float uAlderTime;varying float vForestCoverage;\n${shader.vertexShader}`
        .replace(/void main\s*\(\s*\)\s*\{/, `void main(){
        vForestCoverage=1.;
        #ifdef USE_INSTANCING
          vec2 eyeOffset=instanceMatrix[3].xz-uForestEye.xz;
          float distanceSquared=dot(eyeOffset,eyeOffset);
          vForestCoverage=smoothstep(uBands.x,uBands.y,distanceSquared)*(1.-smoothstep(uBands.z,uBands.w,distanceSquared))*(1.-smoothstep(${rangeFrom ** 2}.,${rangeTo ** 2}.,distanceSquared));
          if(vForestCoverage<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
        #endif
        ${instanceCullGLSL('uTree.y', 'uTree.z', 'uTree.w')}
      `);
      if (leaf) shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 forestOrigin=instanceMatrix[3].xyz;
          float tip=clamp(transformed.y/uTree.x,0.,1.);
          float wind=uAlderTime*.4+forestOrigin.x*.09+forestOrigin.z*.08;
          transformed.x+=sin(wind)*tip*tip*.05;
          transformed.z+=cos(wind*.83)*tip*tip*.03;
        #endif
      `);
      shader.fragmentShader = `varying float vForestCoverage;\n${shader.fragmentShader}`.replace('#include <alphahash_fragment>', `
        if(vForestCoverage<1.&&vForestCoverage<getAlphaHashThreshold(vPosition))discard;
      `);
      if (leaf) {
        // A leaf lit from behind glows a yellower green instead of going black (the same as the needles and sprays, forest.ts).
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment.replace(
          'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
          '$&\n\treflectedLight.directDiffuse += saturate( - dot( geometryNormal, directLight.direction ) ) * directLight.color * BRDF_Lambert( material.diffuseColor ) * vec3( .6, .68, .3 );'));
        foliageLite(shader);
      }
    };
  }

  // What the shadow pass draws for a tree: the far mesh with every vertex sent out of view (so nothing is drawn in the picture)
  // but the cut-out kept for the shadow, as the crown stand-ins do (forest.ts crownShadows).
  const hide = (shader: THREE.WebGLProgramParametersWithUniforms) => { shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position=vec4(2.,2.,2.,1.);'); };
  const caster = (name: string, source?: THREE.Texture) => {
    const m = new THREE.MeshBasicMaterial({ map: source, alphaTest: source ? .5 : 0, side: THREE.DoubleSide });
    m.shadowSide = THREE.DoubleSide; m.name = name; m.onBeforeCompile = hide; m.customProgramCacheKey = () => `silence-shadow-only-${source ? 'cut' : 'solid'}`;
    all.push(m); return m;
  };
  let casters: { wood: THREE.Material; leaf: THREE.Material; none: THREE.Material } | undefined;

  return {
    /** The materials for one level of a model (`key` names the variant), one for each of the mesh's parts in order. */
    forMesh(model: AlderModel, key: string, parts: readonly AlderPart[], inBand: Band, outBand: Band): THREE.Material[] {
      const id = `${model.name}:${key}`;
      let list = cache.get(id);
      if (!list) {
        list = parts.map(part => {
          const m = base(part.name), leaf = part.name === 'TwoSided_Summer';
          m.name = `${model.name} ${key} ${part.name}`;
          dissolve(m, model, leaf, inBand, outBand);
          // Past the second band the moss cards are a draw call for nothing a pixel could show.
          if (part.name === 'Decoration' && outBand === undefined) m.visible = false;
          all.push(m); return m;
        });
        cache.set(id, list);
      }
      return list;
    },
    /** The shadow-only materials for a model's far mesh, one for each part in order (the moss casts nothing). */
    casting(parts: readonly AlderPart[]): THREE.Material[] {
      casters ??= { wood: caster('Alder bark (shadow only)'), leaf: caster('Alder leaves (shadow only)', map('TwoSided_Summer_albedo', true, 4)), none: caster('Alder moss (no shadow)') };
      casters.none.visible = false;
      return parts.map(p => BARK.has(p.name) ? casters!.wood : p.name === 'TwoSided_Summer' ? casters!.leaf : casters!.none);
    },
    dispose() { for (const m of all) m.dispose(); for (const t of maps.values()) t.dispose(); for (const list of cache.values()) for (const m of list) m.dispose(); },
  };
}
