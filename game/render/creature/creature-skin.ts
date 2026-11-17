import * as THREE from 'three';
import { textureVariationGLSL } from '../world/texture-variation';
import { loadTextureArray } from '../world/texture-array';

/**
 * The Listener's skin, layered like the world's buildings (props/prop-materials.ts): the creature's own atlas carries its
 * colour, folds and veins at one to two millimetres a texel, and over it lie scanned materials at about four thousand texels a
 * metre, one per kind of tissue (packed grey by tools/assets/creature-v2/layers.py, sources in public/creature/layers/attribution.json):
 *   0 skin    the face, torso, arms and hands (a scanned animal hide, at its true size)
 *   1 tissue  raw and wet: gums, the inside of the mouth, torn muscle
 *   2 hide    the legs' dead hide, the nails
 *   3 bone    teeth, the spines, the joints' knobs
 * Which is where comes from a mask per atlas that the bake writes beside the GLB (tools/assets/creature-v2/texturing.py MASK_*;
 * skin is what the other three leave). Where two meet, each scan's height decides (the higher one shows), so the edge follows the
 * relief instead of a soft fade. The first try laid one flesh scan over the whole body: it read as a film on top.
 *
 * Each scan gives a luminance ratio (grey: the atlas decides the colour), a height, a roughness, a normal and an occlusion. It is
 * projected along the three axes of the bind pose, so it sticks to the flesh as it moves, and broken into randomly turned patches
 * (texturePatch, texture-variation.ts) so no repeat shows. Its normals go on with Golus's whiteout triplanar blend in the bind
 * pose's frame, then into view space through the vertex's own skinning (no tangents needed). Past 12 to 32 m the atlas alone is
 * enough and the layers are skipped.
 */
export const CREATURE_LAYERS = ['skin', 'tissue', 'hide', 'bone'] as const;
const MASKS: Record<string, string> = { 'Skin v2 face': '/creature/skin-face-mask.png', 'Skin v2': '/creature/skin-mask.png' };
/** The patch grid's unit, in model metres (the unscaled sculpt's): a patch is about 1.4 of these across. */
const BASE = .2;
// Per layer (skin, tissue, hide, bone):
// metres of the sculpt per repeat of the scan. Skin at the hide scan's own 25 cm; tissue's pebbled leather (a 60 cm scan) at
// 12 cm, so its grain is the size of a gum's stippling; the legs' cracked plates (a 1.5 m scan) a few centimetres across at 40 cm;
// bone's crazing (1.8 m of plaster) at 14 cm, a few millimetres a cell on a tooth.
const TILE = [.25, .12, .4, .14];
/** Strength of each scan's normal. */
const RELIEF = [1.1, .9, 1., 1.];
/** Contrast of each scan's light and dark (an exponent on its luminance ratio): the hide scan varies by only 14 %. */
const TONE = [1.8, 1., 1.1, .7];
/** How much of each scan's roughness replaces the bake's (the bake knows what is wet; tissue keeps most of its gloss). */
const ROUGH = [.45, .2, .55, .45];
/** How much each scan's occlusion darkens its cracks and pores. */
const OCCLUSION = [.8, .6, .9, .5];

type Layers = { a: THREE.DataArrayTexture; b: THREE.DataArrayTexture; ready: Promise<unknown> };
const shared = new WeakMap<THREE.WebGLRenderer, Layers>();
/** The two arrays (a: tone, height, roughness; b: normal x, y, occlusion), loaded once per renderer for every creature. */
function creatureLayers(renderer: THREE.WebGLRenderer): Layers {
  let layers = shared.get(renderer);
  if (!layers) {
    const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const url = (kind: string) => CREATURE_LAYERS.map(n => `/creature/layers/${n}-${kind}.jpg`);
    const a = loadTextureArray(renderer, url('a'), { size: 1024, anisotropy }), b = loadTextureArray(renderer, url('b'), { size: 1024, anisotropy });
    layers = { a: a.texture as THREE.DataArrayTexture, b: b.texture as THREE.DataArrayTexture, ready: Promise.all([a.ready, b.ready]) };
    shared.set(renderer, layers);
  }
  return layers;
}
const blankArray = () => { const t = new THREE.DataArrayTexture(new Uint8Array(4 * CREATURE_LAYERS.length).fill(128), 1, 1, CREATURE_LAYERS.length); t.needsUpdate = true; return t; };
const blankMask = () => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; return t; };

const VERTEX = `
  // The bind pose's position and normal (the scans' projection), and its axes in view space through this vertex's skinning.
  vCreaturePos=position;vCreatureNormal=normal;
  #ifdef USE_SKINNING
    mat3 creatureBasis=normalMatrix*mat3(skinMatrix);
  #else
    mat3 creatureBasis=normalMatrix;
  #endif
  vCreatureBasisX=creatureBasis[0];vCreatureBasisY=creatureBasis[1];vCreatureBasisZ=creatureBasis[2];`;

const FRAGMENT_HEAD = `
  uniform sampler2D creatureMask;uniform sampler2DArray creatureLayerA,creatureLayerB;uniform float creatureLayersOn;
  uniform vec4 creatureTile,creatureRelief,creatureTone,creatureRough,creatureOcclusion;
  varying vec3 vCreaturePos,vCreatureNormal,vCreatureBasisX,vCreatureBasisY,vCreatureBasisZ;
  ${textureVariationGLSL}
  // One patch read of a layer, its coordinates scaled by k (patches are laid out in BASE units, each layer tiles at its own size).
  vec4 creatureRead(sampler2DArray s,TexturePatch p,float k,float layer){
    vec2 dx=p.dx*k,dy=p.dy*k;
    return textureGrad(s,vec3(p.a*k,layer),patchRotate(dx,p.ra),patchRotate(dy,p.ra))*p.w.x
      +textureGrad(s,vec3(p.b*k,layer),patchRotate(dx,p.rb),patchRotate(dy,p.rb))*p.w.y
      +textureGrad(s,vec3(p.c*k,layer),patchRotate(dx,p.rc),patchRotate(dy,p.rc))*p.w.z;
  }
  // The same for the normal map: each tap's normal turned back out of its patch's rotation; xyz the tangent normal, w occlusion.
  vec4 creatureReadNormal(sampler2DArray s,TexturePatch p,float k,float layer,float relief){
    vec2 dx=p.dx*k,dy=p.dy*k;
    vec4 a=textureGrad(s,vec3(p.a*k,layer),patchRotate(dx,p.ra),patchRotate(dy,p.ra));
    vec4 b=textureGrad(s,vec3(p.b*k,layer),patchRotate(dx,p.rb),patchRotate(dy,p.rb));
    vec4 c=textureGrad(s,vec3(p.c*k,layer),patchRotate(dx,p.rc),patchRotate(dy,p.rc));
    vec2 xy=patchRotate(a.xy*2.-1.,vec2(p.ra.x,-p.ra.y))*p.w.x+patchRotate(b.xy*2.-1.,vec2(p.rb.x,-p.rb.y))*p.w.y
      +patchRotate(c.xy*2.-1.,vec2(p.rc.x,-p.rc.y))*p.w.z;
    return vec4(normalize(vec3(xy*relief,sqrt(max(1.-dot(xy,xy),0.)))),a.z*p.w.x+b.z*p.w.y+c.z*p.w.z);
  }
  // A layer on the three projections (uvX = p.zy, uvY = p.xz, uvZ = p.xy, mirrored on the far sides): tone, height and
  // roughness in a, the bind-pose normal in n (whiteout blend onto the geometric normal g), occlusion in ao.
  void creatureLayer(float layer,float tile,float relief,TexturePatch px,TexturePatch py,TexturePatch pz,vec3 g,vec3 w,vec3 s,
      out vec3 a,out vec3 n,out float ao){
    float k=${BASE.toFixed(2)}/tile,sum=0.;a=vec3(0.);ao=0.;
    vec3 tx=vec3(0.,0.,1.),ty=tx,tz=tx;
    if(w.x>.02){vec4 r=creatureReadNormal(creatureLayerB,px,k,layer,relief);a+=creatureRead(creatureLayerA,px,k,layer).rgb*w.x;ao+=r.w*w.x;tx=r.xyz;sum+=w.x;}
    if(w.y>.02){vec4 r=creatureReadNormal(creatureLayerB,py,k,layer,relief);a+=creatureRead(creatureLayerA,py,k,layer).rgb*w.y;ao+=r.w*w.y;ty=r.xyz;sum+=w.y;}
    if(w.z>.02){vec4 r=creatureReadNormal(creatureLayerB,pz,k,layer,relief);a+=creatureRead(creatureLayerA,pz,k,layer).rgb*w.z;ao+=r.w*w.z;tz=r.xyz;sum+=w.z;}
    a/=max(sum,1e-4);ao/=max(sum,1e-4);
    tx.x*=s.x;ty.x*=s.y;tz.x*=-s.z;
    tx=vec3(tx.xy+g.zy,abs(tx.z)*g.x);ty=vec3(ty.xy+g.xz,abs(ty.z)*g.y);tz=vec3(tz.xy+g.xy,abs(tz.z)*g.z);
    n=normalize(tx.zyx*w.x+ty.xzy*w.y+tz.xyz*w.z);
  }`;

const FRAGMENT_MAP = `
  #include <map_fragment>
  // The patches (and their screen gradients) are worked out unconditionally; only the reads sit in branches, with explicit
  // gradients, so nothing takes a derivative inside one.
  vec3 cG=normalize(vCreatureNormal),cW=pow(abs(cG),vec3(4.));cW/=max(dot(cW,vec3(1.)),1e-4);
  vec3 cS=step(0.,cG)*2.-1.,cP=vCreaturePos/${BASE.toFixed(2)};
  TexturePatch cPX=texturePatch(vec2(cP.z*cS.x,cP.y),1.),cPY=texturePatch(vec2(cP.x*cS.y,cP.z)+vec2(17.3,5.1),1.),
    cPZ=texturePatch(vec2(-cP.x*cS.z,cP.y)+vec2(41.7,23.9),1.);
  vec3 cMask=texture2D(creatureMask,vMapUv).rgb;
  float cNear=creatureLayersOn*(1.-smoothstep(12.,32.,length(vViewPosition)));
  vec3 cDetail=cG;float cLayerRough=0.,cRoughAmount=0.;
  if(cNear>.001){
    vec4 w=vec4(max(1.-cMask.r-cMask.g-cMask.b,0.),cMask);w/=max(dot(w,vec4(1.)),1e-4);
    vec3 la[4],ln[4];float lao[4];vec4 score=vec4(-9.);
    for(int i=0;i<4;i++){
      la[i]=vec3(.5);ln[i]=cG;lao[i]=1.;
      if(w[i]>.01){
        vec3 ta,tn;float tao;
        creatureLayer(float(i),creatureTile[i],creatureRelief[i],cPX,cPY,cPZ,cG,cW,cS,ta,tn,tao);
        la[i]=ta;ln[i]=tn;lao[i]=tao;
        // Height blend: each layer stands at its share plus its own relief; within .18 of the highest they share.
        score[i]=w[i]+(la[i].g-.5)*.5;
      }
    }
    float top=max(max(score.x,score.y),max(score.z,score.w));
    vec4 b=max(score-(top-.18),0.);b/=max(dot(b,vec4(1.)),1e-4);
    float tone=0.,ao=0.;cDetail=vec3(0.);
    for(int i=0;i<4;i++){
      tone+=b[i]*pow(clamp(la[i].r*2.,.15,2.5),creatureTone[i]);
      ao+=b[i]*mix(1.,lao[i],creatureOcclusion[i]);
      cLayerRough+=b[i]*la[i].b;cRoughAmount+=b[i]*creatureRough[i];
      cDetail+=b[i]*ln[i];
    }
    cDetail=normalize(cDetail);cRoughAmount*=cNear;
    diffuseColor.rgb*=mix(1.,tone*ao,cNear);
  }`;

const FRAGMENT_ROUGH = `
  #include <roughnessmap_fragment>
  roughnessFactor=mix(roughnessFactor,cLayerRough,cRoughAmount);`;

const FRAGMENT_NORMAL = `
  #include <normal_fragment_maps>
  if(cNear>.001){
    // The scans' tilt of the bind-pose normal, carried into view space by this point's skinning, onto the atlas's normal.
    mat3 cB=mat3(vCreatureBasisX,vCreatureBasisY,vCreatureBasisZ);
    normal=normalize(normal+(normalize(cB*cDetail)-normalize(cB*cG))*cNear);
  }`;

/**
 * The shader edits alone, on a standard material's vertex and fragment source (exported for the tests). Throws if three.js no
 * longer has a chunk they hook onto: the program would not build anyway, and this says why.
 */
export function creatureSkinShader(vertexShader: string, fragmentShader: string) {
  const hook = (source: string, chunk: string, replacement: string) => {
    if (!source.includes(chunk)) throw new Error(`SILENCE creature skin: three.js has no ${chunk} to hook onto`);
    return source.replace(chunk, replacement);
  };
  let fragment = hook(fragmentShader, '#include <common>', `#include <common>${FRAGMENT_HEAD}`);
  fragment = hook(fragment, '#include <map_fragment>', FRAGMENT_MAP);
  fragment = hook(fragment, '#include <roughnessmap_fragment>', FRAGMENT_ROUGH);
  fragment = hook(fragment, '#include <normal_fragment_maps>', FRAGMENT_NORMAL);
  const vertex = hook(vertexShader, '#include <skinnormal_vertex>', `#include <skinnormal_vertex>${VERTEX}`);
  return {
    vertexShader: `varying vec3 vCreaturePos,vCreatureNormal,vCreatureBasisX,vCreatureBasisY,vCreatureBasisZ;\n${vertex}`,
    fragmentShader: fragment,
  };
}

/**
 * Lay the scanned layers on one of the creature's skin materials ("Skin v2 face" or "Skin v2"). The program is built once:
 * until the layers and the mask have arrived it draws the atlas alone. Returns a function that frees the mask.
 */
export function addCreatureSkin(material: THREE.MeshStandardMaterial) {
  const maskUrl = MASKS[material.name];
  if (!maskUrl) return () => {};
  const uniforms = {
    creatureMask: { value: blankMask() as THREE.Texture },
    creatureLayerA: { value: blankArray() as THREE.Texture }, creatureLayerB: { value: blankArray() as THREE.Texture },
    creatureLayersOn: { value: 0 },
    creatureTile: { value: new THREE.Vector4(...TILE) }, creatureRelief: { value: new THREE.Vector4(...RELIEF) },
    creatureTone: { value: new THREE.Vector4(...TONE) }, creatureRough: { value: new THREE.Vector4(...ROUGH) },
    creatureOcclusion: { value: new THREE.Vector4(...OCCLUSION) },
  };
  material.userData.creatureSkin = uniforms;
  let mask: THREE.Texture | undefined, layers: Layers | undefined, disposed = false;
  const switchOn = () => {
    if (disposed || !mask || !layers) return;
    uniforms.creatureMask.value = mask; uniforms.creatureLayerA.value = layers.a; uniforms.creatureLayerB.value = layers.b;
    uniforms.creatureLayersOn.value = 1;
  };
  new THREE.TextureLoader().load(maskUrl, texture => {
    if (disposed) { texture.dispose(); return; }
    // On the GLB's own UVs, so glTF's orientation (no flip); data, not colour.
    texture.flipY = false; texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true;
    mask = texture; switchOn();
  }, undefined, () => console.warn(`SILENCE: the creature's skin mask ${maskUrl} did not load; its atlas is shown alone.`));

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    // The arrays need the renderer (they are filled layer by layer straight into the GPU), which only arrives here.
    if (!layers) {
      const loading = creatureLayers(renderer);
      loading.ready.then(() => { layers = loading; switchOn(); }, () => console.warn("SILENCE: the creature's skin layers did not load; its atlas is shown alone."));
    }
    Object.assign(shader.uniforms, uniforms);
    Object.assign(shader, creatureSkinShader(shader.vertexShader, shader.fragmentShader));
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}-silence-creature-skin-v1`;
  material.needsUpdate = true;
  return () => { disposed = true; mask?.dispose(); };
}
