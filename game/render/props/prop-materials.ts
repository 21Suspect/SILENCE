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
export const PROP_LAMP = { candela: { value: 2.5 }, colour: { value: new THREE.Color(1, .6, .28) } };
/** Luminance of a lamp's lit globe per candela of the lamp (its glass is about 0.015 m2 seen from the side). */
const GLOW_PER_CANDELA = 60;
const glows = new Set<THREE.MeshStandardMaterial>();
/** Set every baked lamp's brightness (and its globe's glow) at once. */
export function setPropLamp(candela: number) {
  PROP_LAMP.candela.value = candela;
  for (const m of glows) m.emissiveIntensity = candela * GLOW_PER_CANDELA;
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
  material.customProgramCacheKey = () => 'silence-prop-library-v2';
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
