import * as THREE from 'three';
import { perfOn } from '../../core/perf-flags';

/**
 * A lighter shadow filter for foliage: leaf, needle and grass cards cover most of the screen in the forest and are the
 * largest fragment cost (hiding the crowns alone saved 2.3 ms of a 12 ms frame at 1920x1080, work/perf). three's PCF_SOFT
 * takes 16 depth compares per fragment for the sun (and the torch); on a card with a ragged alpha edge a softer penumbra
 * cannot be seen, so foliage takes the bilinear 2x2 (four compares). Interleaved A/B at 1920x1080: -0.2 to -0.35 ms at the
 * canopy station, -0.2 at dusk and under the torch, less at spawn.
 *
 * Dropping the sky's specular reflection on the cards as well was measured too: no gain beyond noise, and the leaves lost the
 * soft grey sheen that keeps a crown seen from below from going a saturated dark green. It stays.
 *
 * `foliageLiteSwitch` is a uniform (1 the 2x2, 0 three's filter), so the two can be measured without a recompile.
 */
export const foliageLiteSwitch = { value: perfOn('foliageLite') ? 1 : 0 };

const shadowChunk = (() => {
  const source = THREE.ShaderChunk.shadowmap_pars_fragment;
  const opened = source.replace('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )', `#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
      if ( uFoliageLite > .5 ) {
        vec2 liteTexel = vec2( 1. ) / shadowMapSize, liteF = fract( shadowCoord.xy * shadowMapSize + .5 ), liteUv = shadowCoord.xy - liteF * liteTexel;
        shadow = mix( mix( texture2DCompare( shadowMap, liteUv, shadowCoord.z ), texture2DCompare( shadowMap, liteUv + vec2( liteTexel.x, 0. ), shadowCoord.z ), liteF.x ),
          mix( texture2DCompare( shadowMap, liteUv + vec2( 0., liteTexel.y ), shadowCoord.z ), texture2DCompare( shadowMap, liteUv + liteTexel, shadowCoord.z ), liteF.x ), liteF.y );
      } else {`);
  const patched = opened.replace(/(\) \* \( 1\.0 \/ 9\.0 \);)(\s*#elif defined\( SHADOWMAP_TYPE_VSM \))/, '$1\n      }$2');
  if (opened === source || patched === opened) throw new Error('three.js shadow chunk changed: foliage shadow filter not patched');
  return patched;
})();

/** Applies the lighter path to a MeshStandardMaterial's shader in onBeforeCompile. */
export function foliageLite(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uFoliageLite = foliageLiteSwitch;
  shader.fragmentShader = `uniform float uFoliageLite;\n${shader.fragmentShader}`.replace('#include <shadowmap_pars_fragment>', shadowChunk);
}
