import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
const { creatureSkinShader, CREATURE_LAYERS } = await import('../../../game/render/creature/creature-skin.ts');

const count = (text, part) => text.split(part).length - 1;

test("the skin's edits find every chunk they hook onto in three.js's standard shader, once", () => {
  const { vertexShader, fragmentShader } = THREE.ShaderLib.physical;
  const patched = creatureSkinShader(vertexShader, fragmentShader);
  for (const chunk of ['#include <skinnormal_vertex>']) assert.equal(count(patched.vertexShader, chunk), 1, chunk);
  for (const chunk of ['#include <common>', '#include <map_fragment>', '#include <roughnessmap_fragment>', '#include <normal_fragment_maps>'])
    assert.equal(count(patched.fragmentShader, chunk), 1, `${chunk} kept, and only once`);
  // The varyings are declared on both sides and written in the vertex shader.
  for (const v of ['vCreaturePos', 'vCreatureNormal', 'vCreatureBasisX', 'vCreatureBasisY', 'vCreatureBasisZ']) {
    assert.ok(patched.vertexShader.includes(`${v}=`), `${v} is written`);
    assert.ok(patched.fragmentShader.includes(v), `${v} is read`);
  }
  // Nothing in a branch may take a derivative (D3D X3595): the reads in the layer function take explicit gradients.
  const layer = patched.fragmentShader.slice(patched.fragmentShader.indexOf('void creatureLayer'), patched.fragmentShader.indexOf('#include <map_fragment>'));
  assert.ok(!/\btexture2D\(|\btexture\(/.test(layer), 'layer reads use textureGrad');
});

test('a three.js without a hooked chunk is reported, not drawn wrong', () => {
  assert.throws(() => creatureSkinShader('void main(){}', THREE.ShaderLib.physical.fragmentShader), /skinnormal_vertex/);
});

test('every layer has both packed maps, and the attribution names each source', () => {
  const root = new URL('../../../public/creature/layers/', import.meta.url);
  const attribution = JSON.parse(fs.readFileSync(new URL('attribution.json', root), 'utf8'));
  assert.deepEqual(attribution.layers.map(l => l.layer), [...CREATURE_LAYERS]);
  for (const layer of CREATURE_LAYERS) for (const kind of ['a', 'b']) {
    const bytes = fs.readFileSync(new URL(`${layer}-${kind}.jpg`, root));
    assert.equal(bytes.readUInt16BE(0), 0xffd8, `${layer}-${kind}.jpg is a JPEG`);
  }
  for (const l of attribution.layers) assert.ok(l.provider && l.license, `${l.layer} says where it is from and under what license`);
});

test('both skin atlases have their tissue mask beside the GLB', () => {
  for (const name of ['skin-face-mask.png', 'skin-mask.png']) {
    const bytes = fs.readFileSync(new URL(`../../../public/creature/${name}`, import.meta.url));
    assert.equal(bytes.readUInt32BE(0), 0x89504e47, `${name} is a PNG`);
  }
});
