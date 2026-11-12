import * as THREE from 'three';

/**
 * three.js runs the full surface lighting for every light in the scene on every pixel, and reads that light's shadow map,
 * even when the light is contributing nothing: the sun at night (intensity 0, and a 16-tap shadow lookup per pixel), a
 * street-lamp slot with no lamp assigned, a torch that is switched off, a spot light whose cone does not reach the pixel.
 * This adds one test to the built-in loop, so a light with no colour to give is skipped. The picture is identical: a
 * skipped light would have added exactly zero. It must run before the first material is compiled.
 */
export function guardUnlitLights() {
  const lit = 'dot( directLight.color, vec3( 1.0 ) ) > 0.0';
  let source = THREE.ShaderChunk.lights_fragment_begin;
  const shadows = source.split('( directLight.visible && receiveShadow )').length - 1, calls = source.split('RE_Direct( directLight,').length - 1;
  source = source.replaceAll('( directLight.visible && receiveShadow )', `( directLight.visible && receiveShadow && ${lit} )`);
  source = source.replaceAll('RE_Direct( directLight,', `if ( directLight.visible && ${lit} ) RE_Direct( directLight,`);
  // A different three.js release may word the loop differently: say so instead of silently doing nothing.
  if (shadows < 3 || calls < 3) console.warn(`SILENCE: the unlit-light guard matched ${shadows} shadow reads and ${calls} lighting calls (expected 3 of each); lights may cost more than they should.`);
  THREE.ShaderChunk.lights_fragment_begin = source;
  return { shadows, calls };
}
