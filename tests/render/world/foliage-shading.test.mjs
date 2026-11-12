import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { foliageLite } = await import('../../../game/render/world/foliage-shading.ts');

test('foliage gets the 2x2 shadow filter behind a uniform, with the rest of three\'s chunk intact', () => {
  const shader = { uniforms: {}, fragmentShader: '#include <shadowmap_pars_fragment>\nvoid main(){}' };
  foliageLite(shader);
  assert.ok(shader.uniforms.uFoliageLite, 'the switch is bound');
  assert.match(shader.fragmentShader, /if \( uFoliageLite > \.5 \)/);
  assert.match(shader.fragmentShader, /SHADOWMAP_TYPE_VSM/, 'the other filters are still there');
  const code = shader.fragmentShader.replace(/\/\/.*$/gm, '');
  assert.equal((code.match(/\{/g) ?? []).length, (code.match(/\}/g) ?? []).length, 'braces balance');
});
