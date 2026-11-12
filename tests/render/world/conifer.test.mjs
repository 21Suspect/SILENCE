import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildConifer, TRUNK_RINGS, TRUNK_SEGMENTS } = await import('../../../game/render/world/conifer.ts');

test('a seed always grows the same tree, and different seeds grow different trees', () => {
  const a = buildConifer('spruce', 3), b = buildConifer('spruce', 3), c = buildConifer('spruce', 4);
  assert.deepEqual([...a.crown.attributes.position.array.slice(0, 600)], [...b.crown.attributes.position.array.slice(0, 600)]);
  assert.notEqual(a.crown.index.count, c.crown.index.count);
});

test('the trunk keeps the ring layout the forest samples the ground and the bark from', () => {
  for (const species of ['pine', 'spruce']) {
    const { trunk, farTrunk } = buildConifer(species, 1);
    for (const g of [trunk, farTrunk]) {
      const p = g.attributes.position, root = g.attributes.rootIndex;
      // The first ring sits at the foot and runs round the trunk in TRUNK_SEGMENTS steps, root index 0..15.
      for (let i = 0; i < TRUNK_SEGMENTS; i++) { assert.ok(Math.abs(p.getY(i) + .08) < 1e-6); assert.equal(root.getX(i), i); }
      const ringTop = (TRUNK_RINGS.length - 1) * (TRUNK_SEGMENTS + 1);
      assert.ok(Math.abs(p.getY(ringTop) - (TRUNK_RINGS.at(-1) - .08)) < 1e-6);
      for (const name of ['uv', 'color', 'rootIndex', 'streamDetail', 'normal']) assert.ok(g.getAttribute(name), name);
    }
  }
});

test('crowns stay within budget, keep their cards on the atlas, and light outward', () => {
  for (const species of ['pine', 'spruce']) for (let seed = 1; seed <= 4; seed++) {
    const t = buildConifer(species, seed), near = t.crown.index.count / 3, far = t.farCrown.index.count / 3;
    assert.ok(near > 6000 && near < 30000, `${species} ${seed}: ${near} crown triangles`);
    assert.ok(far < near * .25, 'the distant crown is not much lighter');
    const uv = t.crown.attributes.uv.array;
    for (let i = 0; i < uv.length; i++) assert.ok(uv[i] >= 0 && uv[i] <= 1);
    assert.ok(species === 'pine' ? t.crownBase > 14 : t.crownBase < 7, `${species} crown base ${t.crownBase}`);
    const crownLod = t.farCrown.attributes.crownLod.array;
    assert.ok(crownLod.every(v => v === 1));
  }
});
