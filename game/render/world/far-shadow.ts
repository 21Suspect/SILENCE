import * as THREE from 'three';
import { perfOn } from '../../core/perf-flags';

/**
 * The sun's shadows over the whole island. The sun's own shadow map (shadows.ts) is drawn for 72 m round the player, fine enough
 * for a twig's shadow; past 36 m nothing cast a shadow at all, so the distant forest floor, the far trees and the land beyond lay in
 * full sun however dense the wood, flat and one colour beside the shaded ground near the eye. This second map covers the island
 * from the sun (a fixed 1.7 km square over its middle, 2048 texels: .83 m each, five to ten across a crown), and everything far
 * samples it: the distant ground (terrain.ts), the impostor forest (far-forest.ts) and the near ground past the sun's own map.
 *
 * Casters: the distant ground (so ridges throw their shadows) and every tree of the forest as its impostor turned to the sun, drawn
 * by those modules into `casters`; and whole subtrees of the scene (`addCasterRoot`: the buildings and props, the streamed forest),
 * drawn depth-only through an override material. Nothing moves in it but the sun, so it is redrawn only when the sun has turned far
 * enough to move the end of a tall tree's shadow by half a texel: about every two seconds at normal day speed, a depth-only pass of a
 * third of a million triangles and twelve thousand quads.
 *
 * Redrawn that rarely, a map is a step: every two seconds each shadow edge from here to the horizon jumped by up to a texel (at 50 m that
 * is 6 pixels). So there are two maps side by side in one texture (one sampler: the ground's shader is near the limit of sixteen), the
 * second drawn for the sun as it will be one such turn later, and the lookup blends them by how far the sun has got between the two
 * (shadows.ts has the reasoning): the edge slides instead of jumping, as a real shadow's edge does, whose penumbra at those distances
 * (the sun's half degree over 47 m, .44 m) is wider than the half texel the blend crosses.
 */
export const FAR_SHADOW = { size: 2048, span: 1700, depth: 2400 } as const;
const TALLEST = 33;

export type FarShadow = ReturnType<typeof createFarShadow>;

export function createFarShadow(renderer: THREE.WebGLRenderer) {
  const { size, span, depth } = FAR_SHADOW;
  // A colour attachment is required by the target; one byte a texel keeps it small. Two maps side by side: slot 0 left, slot 1 right.
  const target = new THREE.WebGLRenderTarget(size * 2, size, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
  target.depthTexture = new THREE.DepthTexture(size * 2, size, THREE.UnsignedIntType);
  target.depthTexture.minFilter = target.depthTexture.magFilter = THREE.NearestFilter;
  target.scissorTest = true;
  const camera = new THREE.OrthographicCamera(-span / 2, span / 2, span / 2, -span / 2, 1, depth);
  const casters = new THREE.Scene();
  casters.matrixWorldAutoUpdate = false;
  // Whole subtrees of the scene that cast too, each drawn depth-only: parented for the pass into this scene (identity transform, matrices
  // as the last frame left them) and put back at the same place.
  const roots = new Set<THREE.Object3D>();
  const rootScene = new THREE.Scene();
  rootScene.matrixWorldAutoUpdate = false;
  rootScene.overrideMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const bias = new THREE.Matrix4().set(.5, 0, 0, .5, 0, .5, 0, .5, 0, 0, .5, .5, 0, 0, 0, 1);
  const matrices = [new THREE.Matrix4(), new THREE.Matrix4()];
  const sunUniform = { value: new THREE.Vector3(0, 1, 0) };
  const uniforms = {
    uFarShadowMap: { value: target.depthTexture as THREE.Texture },
    uFarShadowMatrix: { value: matrices[0] },
    uFarShadowMatrixB: { value: matrices[1] },
    uFarShadowOn: { value: 0 },
    /** The weight of the second map, 0 to 1. */
    uFarShadowMix: { value: 0 },
  };
  const texel = span / size;
  // Which map is the sun as it is (`current`), what each was drawn for, and how far the sun has got to the other one.
  const directions = [new THREE.Vector3(), new THREE.Vector3()], valid = [false, false];
  let current = 0, blending = false, weight = 0, stale = true, stillFor = 0;
  const previous = new THREE.Vector3(), backward = new THREE.Vector3(), step = new THREE.Vector3(), ahead = new THREE.Vector3(), chord = new THREE.Vector3(), along = new THREE.Vector3();
  const publish = () => { uniforms.uFarShadowMix.value = current === 1 ? 1 - weight : weight; };

  /** Draws the map `slot` for the sun at `direction`. */
  function draw(slot: number, direction: THREE.Vector3) {
    sunUniform.value.copy(direction).normalize();
    camera.position.copy(sunUniform.value).multiplyScalar(depth * .5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    matrices[slot].multiplyMatrices(bias, camera.projectionMatrix).multiply(camera.matrixWorldInverse);
    directions[slot].copy(sunUniform.value); valid[slot] = true;
    target.viewport.set(slot * size, 0, size, size); target.scissor.copy(target.viewport);
    const saved = renderer.getRenderTarget(), autoClear = renderer.autoClear;
    renderer.autoClear = true; renderer.setRenderTarget(target); renderer.render(casters, camera);
    renderer.autoClear = false;
    for (const root of roots) {
      const parent = root.parent, index = parent ? parent.children.indexOf(root) : -1;
      rootScene.add(root);
      try { renderer.render(rootScene, camera); } finally {
        rootScene.remove(root);
        if (parent) { parent.children.splice(Math.max(index, 0), 0, root); root.parent = parent; }
      }
    }
    renderer.setRenderTarget(saved); renderer.autoClear = autoClear;
    uniforms.uFarShadowOn.value = 1;
  }

  /** The turn of the sun between one map and the next: the end of the tallest tree's shadow moves by half a texel. */
  const turn = (elevation: number) => .5 * texel / (TALLEST / Math.max(elevation, .18));

  return {
    uniforms, casters, camera,
    /** The sun's direction (towards it) as the casters see it: they turn their impostors to it. */
    sun: sunUniform,
    /** Casters came or went: redraw at the next update. */
    invalidate() { stale = true; },
    /** Whole subtrees of the scene that cast into the map (buildings, props, the streamed forest); drawn depth-only, alpha-tested parts as solids. */
    addCasterRoot(root: THREE.Object3D) { roots.add(root); stale = true; },
    removeCasterRoot(root: THREE.Object3D) { if (roots.delete(root)) stale = true; },
    /**
     * One frame: draws a map if one is due (at most one a frame) and sets the blend. Returns true when it did. Needs the sun's direction
     * towards it; with the sun down the map is switched off.
     */
    update(direction: THREE.Vector3) {
      if (direction.y < .02) { uniforms.uFarShadowOn.value = 0; blending = false; valid[0] = valid[1] = false; previous.set(0, 0, 0); return false; }
      backward.copy(direction).normalize();
      const moved = previous.lengthSq() > 0 ? previous.distanceTo(backward) : 0;
      step.copy(backward).sub(previous); previous.copy(backward);
      stillFor = moved < 1e-9 ? stillFor + 1 : 0;
      const fresh = () => { draw(current, backward); stale = false; blending = false; weight = 0; publish(); return true; };
      // The dev switch off: one map, redrawn each time the sun has turned half a texel at the end of the tallest shadow, as before (for A/B).
      if (!perfOn('farBlend')) {
        if (!valid[current] || stale || directions[current].distanceToSquared(backward) > turn(direction.y) ** 2) return fresh();
        blending = false; weight = 0; publish(); return false;
      }
      // The first map, a changed caster, or a sun that jumped (the clock was set): one map for the sun as it is.
      if (!valid[current] || stale || moved > .02) return fresh();
      if (!blending && stillFor > 2) { weight = 0; publish(); return false; }
      if (blending) {
        chord.copy(directions[1 - current]).sub(directions[current]); along.copy(backward).sub(directions[current]);
        const length2 = chord.lengthSq(); weight = length2 > 0 ? Math.min(1, along.dot(chord) / length2) : 1;
        // The sun stopped between the maps or turned back: neither is the sun now.
        if (along.dot(chord) < -.25 * length2 || (stillFor > 6 && weight < 1)) return fresh();
        if (weight >= 1) { current = 1 - current; blending = false; weight = 0; }
      }
      if (!blending && moved > 0) {
        // The other map, for the sun a turn ahead (or the next frame's, when it moves more than that in one).
        const reach = Math.max(turn(direction.y), moved * 1.5);
        ahead.copy(backward).addScaledVector(step, reach / Math.max(moved, 1e-12)).normalize();
        draw(1 - current, ahead); blending = true; weight = 0; publish(); return true;
      }
      publish(); return false;
    },
    dispose() { target.dispose(); target.depthTexture?.dispose(); (rootScene.overrideMaterial as THREE.Material).dispose(); },
  };
}

/**
 * GLSL: `farShadow(worldPosition, biasMetres)`, 1 in sun and 0 in the shadow of anything on the island, filtered over 2 x 2
 * texels and blended between the two maps by the sun's progress; 1 outside the map or with the sun down. Needs the five uniforms of
 * `createFarShadow`.
 */
export const farShadowGLSL = `
  uniform sampler2D uFarShadowMap;uniform mat4 uFarShadowMatrix,uFarShadowMatrixB;uniform float uFarShadowOn,uFarShadowMix;
  float farShadowTap(mat4 m,float slot,vec3 p,float biasMetres){
    vec4 c=m*vec4(p,1.);
    if(c.x<0.||c.y<0.||c.x>1.||c.y>1.)return 1.;
    float z=c.z-biasMetres/${FAR_SHADOW.depth.toFixed(1)};
    vec2 at=vec2(c.x*.5+slot*.5,c.y),texel=vec2(1./${(FAR_SHADOW.size * 2).toFixed(1)},1./${FAR_SHADOW.size.toFixed(1)}),f=fract(at/texel-.5),base=at-f*texel;
    float a=step(z,texture2D(uFarShadowMap,base).r),b=step(z,texture2D(uFarShadowMap,base+vec2(texel.x,0.)).r);
    float d=step(z,texture2D(uFarShadowMap,base+vec2(0.,texel.y)).r),e=step(z,texture2D(uFarShadowMap,base+texel).r);
    return mix(mix(a,b,f.x),mix(d,e,f.x),f.y);
  }
  float farShadow(vec3 p,float biasMetres){
    if(uFarShadowOn<.5)return 1.;
    float s=0.;
    if(uFarShadowMix<1.)s+=(1.-uFarShadowMix)*farShadowTap(uFarShadowMatrix,0.,p,biasMetres);
    if(uFarShadowMix>0.)s+=uFarShadowMix*farShadowTap(uFarShadowMatrixB,1.,p,biasMetres);
    return s;
  }
`;
