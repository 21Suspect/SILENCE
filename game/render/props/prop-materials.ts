import { LIGHT_TUNING, lightTuningVersion } from '../../core/light-tuning';
import * as THREE from 'three';

/**
 * The shared material library for buildings (tools/assets/world-v2/library.py and tiled.py). A tiled prop's GLB carries
 * plain materials that name a library entry in their extras (`lib`), metric tiling UVs on TEXCOORD_0 and its own small
 * macro map on TEXCOORD_1 in the occlusion slot: R ambient occlusion, G moss, B grime, A tone variation; a prop with lamps
 * also carries their baked light in the emissive slot (TEXCOORD_1). Here every such material gets the entry's colour, normal
 * and ORM maps (one GPU copy for all props) and a patch that reads the macro and lamp maps.
 *
 * Why: one unique atlas per building gave the cabin 123 texels per metre (work/gfx/research/texture-audit.md); the
 * library scans tile at 900 to 2000.
 */
const ROOT = '/world/materials/';
type Entry = { map: THREE.Texture; normalMap: THREE.Texture; orm: THREE.Texture; ready: Promise<void> };
const entries = new Map<string, Entry>();
const loader = new THREE.TextureLoader();

/** A lazily loaded library entry. Textures follow glTF's conventions (no flip), since they go on glTF UVs. */
function entry(id: string): Entry {
  let e = entries.get(id);
  if (e) return e;
  const load = (name: string, srgb: boolean) => {
    const t = new THREE.Texture();
    t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.name = `${id} ${name}`;
    const ready = loader.loadAsync(`${ROOT}${id}/${name}.jpg`).then(image => { t.image = image.image; t.needsUpdate = true; image.dispose(); });
    return { t, ready };
  };
  const c = load('color', true), n = load('normal', false), o = load('orm', false);
  e = { map: c.t, normalMap: n.t, orm: o.t, ready: Promise.all([c.ready, n.ready, o.ready]).then(() => undefined) };
  entries.set(id, e);
  return e;
}

/** Moss in linear light: the yellow-green of the ground's moss layer, a little paler where it dries on wood. */
const MOSS = new THREE.Color(.075, .095, .03);

/**
 * The lamps baked into tiled props (tiled.py bake_lamps): their light is a map of irradiance per candela on the prop's own atlas,
 * turned into light here as `map x candela x colour x albedo / pi`, so one number sets how bright every baked lamp is. Kerosene
 * flame, about 1900 K. In the game's units (the sun is 1.62, the torch 14, a street lamp 16) 2.5 lights the cabin's room to
 * about half the shade outside by day and reads as a warm, steady lantern at night.
 */
/** Luminance of a lamp's lit globe per candela of the lamp (its glass is about 0.015 m2 seen from the side). */
const GLOW_PER_CANDELA = 60;
const glows = new Set<THREE.MeshStandardMaterial>();
// The uniform reads its value as it is uploaded, so the developer tab's lamp knob (core/light-tuning.ts) applies at once; the
// globes' glow follows it the first frame they are drawn after a change.
let lampCandela = 2.5, glowVersion = -1;
export const PROP_LAMP = {
  candela: { get value() {
    if (glowVersion !== lightTuningVersion) { glowVersion = lightTuningVersion; for (const m of glows) m.emissiveIntensity = lampCandela * LIGHT_TUNING.lamps * GLOW_PER_CANDELA; }
    return lampCandela * LIGHT_TUNING.lamps;
  }, set value(candela: number) { lampCandela = candela; glowVersion = -1; } },
  colour: { value: new THREE.Color(1, .6, .28) },
};
/** Set every baked lamp's brightness (and its globe's glow) at once. */
export function setPropLamp(candela: number) {
  PROP_LAMP.candela.value = candela;
  for (const m of glows) m.emissiveIntensity = candela * LIGHT_TUNING.lamps * GLOW_PER_CANDELA;
}

/**
 * A room of a tiled prop (the cabin): its box in the prop's own frame and its lamp. The prop's own surfaces know they are
 * indoors (the macro map's sky openness and the baked lamp); loose things that come and go inside it (pickups, a door leaf)
 * do not, and without this a backpack on the bed took the full blue sky's light and glowed pale in a dim room. In the room's
 * box they take the same share of the sky as a closed room (tiled.py INDOOR_AMBIENT) and the lamp's light as a plain
 * point (they are near it, and nothing in the room shadows it much). One room for now: the cabin's.
 */
export const PROP_ROOM = {
  toLocal: { value: new THREE.Matrix4() }, min: { value: new THREE.Vector3() }, max: { value: new THREE.Vector3() },
  lamp: { value: new THREE.Vector3() }, on: { value: 0 },
};
const INDOOR_AMBIENT = .16;
/** Set the room: `toLocal` takes world positions into the prop's frame, where it spans `min` to `max`; `lamp` is in world metres. */
export function setPropRoom(toLocal: THREE.Matrix4, min: readonly number[], max: readonly number[], lamp?: THREE.Vector3) {
  PROP_ROOM.toLocal.value.copy(toLocal); PROP_ROOM.min.value.fromArray(min); PROP_ROOM.max.value.fromArray(max);
  if (lamp) PROP_ROOM.lamp.value.copy(lamp);
  PROP_ROOM.on.value = 1;
}
const ROOM_VERTEX = `
  vLeafSide = objectNormal.z;
  vec4 propWorld = vec4( transformed, 1. );
  #ifdef USE_INSTANCING
    propWorld = instanceMatrix * propWorld;
  #endif
  vPropWorld = ( modelMatrix * propWorld ).xyz;`;
const ROOM_FRAGMENT = `
  {
    // Inside the room's box (soft over its last 15 cm), the sky is mostly shut out and the lamp lights it.
    vec3 local = ( uRoomToLocal * vec4( vPropWorld, 1. ) ).xyz;
    vec3 box = smoothstep( uRoomMin, uRoomMin + .15, local ) * ( 1. - smoothstep( uRoomMax - .15, uRoomMax, local ) );
    float inside = box.x * box.y * box.z * uRoomOn;
    // A door leaf's face that looks into its building (see doorLeafMaterial): indoors wherever the leaf stands, shut in the
    // doorway (outside the room's box) or swung in. Its edges and the outer face keep the open sky.
    float leafIn = smoothstep( .3, .7, vLeafSide * uLeafSide );
    float lampLit = max( inside, leafIn * uLeafLamp );
    inside = max( inside, leafIn );
    reflectedLight.indirectDiffuse *= mix( 1., ${INDOOR_AMBIENT.toFixed(2)}, inside );
    reflectedLight.indirectSpecular *= mix( 1., ${INDOOR_AMBIENT.toFixed(2)}, inside );
    vec3 toLamp = uRoomLamp - vPropWorld;
    float lampDistance = max( dot( toLamp, toLamp ), .04 );
    vec3 lampDirection = normalize( ( viewMatrix * vec4( toLamp, 0. ) ).xyz );
    reflectedLight.directDiffuse += lampLit * saturate( dot( normal, lampDirection ) ) * uLampCandela / lampDistance * uLampColour * BRDF_Lambert( material.diffuseColor );
  }`;
/** Give a standard material the room's light (see PROP_ROOM); chains any patch it already has. */
export function patchInterior(material: THREE.MeshStandardMaterial) {
  const before = material.onBeforeCompile, key = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    before?.call(material, shader, renderer);
    interior(shader, material);
  };
  material.customProgramCacheKey = () => `${key.call(material)}|silence-room-v3`;
  material.needsUpdate = true;
}
function interior(shader: THREE.WebGLProgramParametersWithUniforms, material: THREE.Material) {
  const leaf = material.userData.leaf as { side: number; lamp: number } | undefined;
  shader.uniforms.uLeafSide = { value: leaf?.side ?? 0 }; shader.uniforms.uLeafLamp = { value: leaf?.lamp ?? 0 };
  shader.uniforms.uRoomToLocal = PROP_ROOM.toLocal; shader.uniforms.uRoomMin = PROP_ROOM.min; shader.uniforms.uRoomMax = PROP_ROOM.max;
  shader.uniforms.uRoomLamp = PROP_ROOM.lamp; shader.uniforms.uRoomOn = PROP_ROOM.on;
  shader.uniforms.uLampCandela ??= PROP_LAMP.candela; shader.uniforms.uLampColour ??= PROP_LAMP.colour;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vPropWorld;\nvarying float vLeafSide;')
    .replace('#include <project_vertex>', `#include <project_vertex>${ROOM_VERTEX}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
varying vec3 vPropWorld;
varying float vLeafSide;
uniform float uLeafSide,uLeafLamp;
uniform mat4 uRoomToLocal;
uniform vec3 uRoomMin,uRoomMax,uRoomLamp;
uniform float uRoomOn;
${shader.fragmentShader.includes('uLampCandela;') ? '' : 'uniform float uLampCandela;\nuniform vec3 uLampColour;'}`)
    // After the lights, not at the occlusion chunk: a library material's own patch expands that chunk first, and the room's
    // light then never reached a library-textured leaf (the cabin's door kept the open sky and ignored the lantern).
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>${ROOM_FRAGMENT}`);
}

function patch(material: THREE.MeshStandardMaterial, vary: number, lampMax: number) {
  material.onBeforeCompile = shader => {
    shader.uniforms.uPropVary = { value: vary };
    shader.uniforms.uPropMoss = { value: MOSS };
    shader.uniforms.uLampMax = { value: lampMax };
    shader.uniforms.uLampCandela = PROP_LAMP.candela;
    shader.uniforms.uLampColour = PROP_LAMP.colour;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPropVary,uLampMax,uLampCandela;\nuniform vec3 uPropMoss,uLampColour;')
      // The emissive slot carries the baked lamp light (sRGB-encoded irradiance per candela over uLampMax), not a glow.
      .replace('#include <emissivemap_fragment>', `
  #ifdef USE_EMISSIVEMAP
    totalEmissiveRadiance += texture2D( emissiveMap, vEmissiveMapUv ).r * uLampMax * uLampCandela * uLampColour * diffuseColor.rgb * RECIPROCAL_PI;
  #endif`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  #ifdef USE_AOMAP
    vec4 propMacro = texture2D( aoMap, vAoMapUv );
  #else
    vec4 propMacro = vec4( 1., 0., 0., .5 );
  #endif
  float propMoss = 0.;
  #ifdef USE_MAP
  {
    // The texel against the scan's own mean (its last mip): dark texels are its cracks and joints.
    float lum = dot( sampledDiffuseColor.rgb, vec3( .2126, .7152, .0722 ) );
    float mean = max( dot( textureLod( map, vMapUv, 12. ).rgb, vec3( .2126, .7152, .0722 ) ), .01 );
    float rel = lum / mean;
    diffuseColor.rgb *= 1. + uPropVary * ( propMacro.a - .5 ) * 2.;
    // Grime darkens, more in the cracks it runs into.
    diffuseColor.rgb *= 1. - propMacro.b * ( .32 + .2 * saturate( 1. - rel ) );
    // Moss takes the cracks first, so its edge follows the scan instead of a soft stain.
    propMoss = smoothstep( .25, .6, propMacro.g + ( 1. - rel ) * .35 * propMacro.g );
    diffuseColor.rgb = mix( diffuseColor.rgb, uPropMoss * ( .55 + .6 * rel ), propMoss );
  }
  #endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix( min( 1., roughnessFactor + .08 * propMacro.b ), .95, propMoss );`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = normalize( mix( normal, nonPerturbedNormal, propMoss * .55 ) );`)
      // The scan's own cavity occlusion (ORM red) deepens the baked macro occlusion.
      .replace('#include <aomap_fragment>', THREE.ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r',
        'propMacro.r * mix( 1., texture2D( roughnessMap, vRoughnessMapUv ).r, .8 )'));
  };
  // Loose library-textured things (a door leaf) take the room's light; a prop with its own baked lamp (the cabin) already has it.
  if (!lampMax) {
    const own = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => { own.call(material, shader, renderer); interior(shader, material); };
  }
  material.customProgramCacheKey = () => `silence-prop-library-v5-${lampMax ? 'lit' : 'room'}`;
}

/**
 * A door leaf swings, so it cannot carry its building's baked light: shut, it stands in the doorway, outside the room's box,
 * and its inner face took the full open sky (the cabin's door read pale blue-grey beside the lantern-lit brown walls; the
 * other buildings' doors had no indoor light at all). Its copy of each material knows which face looks into the building,
 * `side` (+1 or -1, the leaf's local z), and whether that building has the lamp (`lamp`): that face takes the room's dim sky
 * and the lamp, as the walls round it do. One copy per material, side and lamp, shared by every leaf that matches.
 */
const leafCopies = new Map<string, THREE.Material>();
export function doorLeafMaterial(material: THREE.Material, side: number, lamp: boolean): THREE.Material {
  if (!(material instanceof THREE.MeshStandardMaterial)) return material;
  const key = `${material.uuid}|${side}|${lamp ? 1 : 0}`;
  let copy = leafCopies.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!copy) {
    copy = material.clone();
    copy.userData.leaf = { side, lamp: lamp ? 1 : 0 };
    // A clone keeps the maps but not the shader patches: dress it again.
    if (typeof copy.userData.lib === 'string') patch(copy, Number(copy.userData.vary ?? .15), Number(copy.userData.lampMax ?? 0));
    else patchInterior(copy);
    leafCopies.set(key, copy);
  }
  return copy;
}

/**
 * Give every library material under `root` its shared maps and the macro patch. Resolves once the maps are loaded, so a
 * model is never shown with half its textures. Materials without a `lib` are left alone.
 */
export async function dressProp(root: THREE.Object3D): Promise<void> {
  const found = new Set<THREE.MeshStandardMaterial>();
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      if (typeof m.userData.lib === 'string') found.add(m);
      else if (m.userData.glow) {
        // A lamp's globe: its glow follows the lamp's brightness.
        const tint = m.userData.tint;
        m.emissive.copy(PROP_LAMP.colour.value);
        if (Array.isArray(tint) && tint.length === 3) m.color.setRGB(Number(tint[0]), Number(tint[1]), Number(tint[2]), THREE.LinearSRGBColorSpace);
        m.emissiveIntensity = PROP_LAMP.candela.value * GLOW_PER_CANDELA;
        glows.add(m);
      }
    }
  });
  const waits: Promise<void>[] = [];
  for (const m of found) {
    const e = entry(m.userData.lib as string), strength = Number(m.userData.normal ?? 1);
    // The tint may brighten the scan, which glTF's base colour (clamped to 1) cannot carry: it comes in the extras.
    const tint = m.userData.tint;
    if (Array.isArray(tint) && tint.length === 3) m.color.setRGB(Number(tint[0]), Number(tint[1]), Number(tint[2]), THREE.LinearSRGBColorSpace);
    m.map = e.map; m.normalMap = e.normalMap; m.roughnessMap = e.orm; m.metalnessMap = e.orm;
    // glTF normal maps on derivative tangents: GLTFLoader flips y the same way.
    m.normalScale.set(strength, -strength);
    patch(m, Number(m.userData.vary ?? .15), Number(m.userData.lampMax ?? 0));
    m.needsUpdate = true;
    waits.push(e.ready);
  }
  await Promise.all(waits);
}

/** Library entries loaded so far (for the texture-memory audit). */
export function propLibraryTextures(): THREE.Texture[] {
  return [...entries.values()].flatMap(e => [e.map, e.normalMap, e.orm]);
}
