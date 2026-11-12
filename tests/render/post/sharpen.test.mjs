import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createEdgeAAMaterial, sharpnessFor } = await import('../../../game/render/post/sharpen.ts');

test('the edge pass patches three.js FXAA: light sub-pixel blending, then sharpening', () => {
  const m = createEdgeAAMaterial();
  assert.match(m.fragmentShader, /_SubpixelBlending = \.25/);
  assert.match(m.fragmentShader, /uniform float sharpness/);
  assert.equal(m.uniforms.sharpness.value, 0);
});

test('sharpening follows how far the browser stretches the picture, within bounds', () => {
  assert.equal(sharpnessFor(2, 2), .25, 'drawn at the screen\'s own resolution: a light touch');
  assert.ok(sharpnessFor(1.1, 2) > sharpnessFor(1.5, 2), 'more stretch, more sharpening');
  assert.ok(sharpnessFor(.5, 3) <= .7, 'capped');
  assert.equal(sharpnessFor(3, 2), .25, 'supersampled is never below the light touch');
});
