import * as THREE from 'three';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

/**
 * The last pass to the screen: FXAA, then contrast-adaptive sharpening.
 *
 * FXAA as three ships it blends every pixel that differs from its neighbours by a few percent ("sub-pixel blending" 1.0), which
 * on top of 4x MSAA and alpha-to-coverage took 27 to 34% of the fine contrast out of every texture (bark, ground, rock;
 * work/gfx/research/texture-audit.md) while the geometric edges it exists for were already resolved. At .25 it still settles
 * the odd crawling specular edge and leaves texture detail alone.
 *
 * The sharpening is AMD's contrast-adaptive sharpening (FidelityFX CAS, 2019): each pixel is pushed away from its four
 * neighbours by an amount that shrinks where the neighbourhood is already near black or white, so edges do not ring and noise
 * is not amplified. It matters most when the picture is drawn below the screen's resolution and the browser stretches it (the
 * default 1080 rows on a Retina panel is a 1.8 to 2.1x stretch), so its strength follows that stretch.
 */
export function createEdgeAAMaterial() {
  const fragmentShader = FXAAShader.fragmentShader
    .replace('float _SubpixelBlending = 1.0;', 'float _SubpixelBlending = .25;')
    .replace(/void main\(\) \{\s*gl_FragColor = ApplyFXAA\( tDiffuse, resolution\.xy, vUv \);\s*\}/, `uniform float sharpness;
      void main() {
        vec4 c = ApplyFXAA( tDiffuse, resolution.xy, vUv );
        if ( sharpness > 0. ) {
          vec3 n = texture( tDiffuse, vUv + vec2( 0., resolution.y ) ).rgb, s = texture( tDiffuse, vUv - vec2( 0., resolution.y ) ).rgb;
          vec3 e = texture( tDiffuse, vUv + vec2( resolution.x, 0. ) ).rgb, w = texture( tDiffuse, vUv - vec2( resolution.x, 0. ) ).rgb;
          vec3 lo = min( c.rgb, min( min( n, s ), min( e, w ) ) ), hi = max( c.rgb, max( max( n, s ), max( e, w ) ) );
          // How far the neighbourhood is from clipping, per channel: no push where it would cross black or white.
          vec3 amp = sqrt( clamp( min( lo, 1. - hi ) / max( hi, 1e-4 ), 0., 1. ) );
          vec3 k = amp * ( -1. / mix( 8., 5., sharpness ) );
          c.rgb = clamp( ( c.rgb + ( n + s + e + w ) * k ) / ( 1. + 4. * k ), 0., 1. );
        }
        gl_FragColor = c;
      }`);
  if (!fragmentShader.includes('uniform float sharpness')) throw new Error('three.js FXAAShader changed: edge pass not patched');
  const material = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(FXAAShader.uniforms), sharpness: { value: 0 } },
    vertexShader: FXAAShader.vertexShader, fragmentShader, depthTest: false, depthWrite: false,
  });
  material.name = 'Edge AA and sharpening';
  return material;
}

/** CAS strength (0..1) for a picture drawn at `renderRatio` device pixels per CSS pixel on a `deviceRatio` screen. */
export function sharpnessFor(renderRatio: number, deviceRatio: number) {
  const stretch = Math.max(1, deviceRatio / Math.max(.1, renderRatio));
  return Math.min(.7, .25 + .45 * (stretch - 1));
}
