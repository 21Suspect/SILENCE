import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { buildBroadleaf } = await import('../../../game/render/world/broadleaf.ts');
const { TRUNK_RINGS, TRUNK_SEGMENTS } = await import('../../../game/render/world/tree-parts.ts');

test('a seed always grows the same broadleaf, and different seeds grow different trees', () => {
  for (const species of ['oak', 'birch']) {
    const a = buildBroadleaf(species, 2), b = buildBroadleaf(species, 2), c = buildBroadleaf(species, 3);
    assert.deepEqual([...a.crown.attributes.position.array.slice(0, 600)], [...b.crown.attributes.position.array.slice(0, 600)]);
    assert.notEqual(a.crown.index.count, c.crown.index.count);
  }
});

test('the trunk keeps the ring layout, and its bark texels stay square up the taper', () => {
  for (const species of ['oak', 'birch']) {
    const { trunk, farTrunk } = buildBroadleaf(species, 1);
    for (const g of [trunk, farTrunk]) {
      const p = g.attributes.position, root = g.attributes.rootIndex, uv = g.attributes.uv;
      for (let i = 0; i < TRUNK_SEGMENTS; i++) { assert.ok(Math.abs(p.getY(i) + .08) < 1e-6); assert.equal(root.getX(i), i); }
      const ringTop = (TRUNK_RINGS.length - 1) * (TRUNK_SEGMENTS + 1);
      assert.ok(Math.abs(p.getY(ringTop) - (TRUNK_RINGS.at(-1) - .08)) < 1e-6);
      for (const name of ['uv', 'color', 'rootIndex', 'streamDetail', 'normal']) assert.ok(g.getAttribute(name), name);
      // Texels square within 15%: texture distance per model unit round the trunk (averaged over the two rings of a step,
      // as the radius may halve within one at an oak's fork) equals that along it.
      const row = TRUNK_SEGMENTS + 1, chord = k => Math.hypot(p.getX(k + 1) - p.getX(k), p.getZ(k + 1) - p.getZ(k)) / (uv.getX(k + 1) - uv.getX(k));
      for (let r = 4; r < TRUNK_RINGS.length - 3; r++) {
        const i = r * row, j = (r + 1) * row;
        const around = (chord(i) + chord(j)) / 2;
        const up = Math.hypot(p.getX(j) - p.getX(i), p.getY(j) - p.getY(i), p.getZ(j) - p.getZ(i)) / (uv.getY(j) - uv.getY(i));
        assert.ok(Math.abs(around / up - 1) < .15, `${species} ring ${r}: ${(around / up).toFixed(2)}`);
      }
    }
  }
});

test('broadleaf crowns stay within budget, on the atlas, above the crown base', () => {
  for (const species of ['oak', 'birch']) for (let seed = 1; seed <= 4; seed++) {
    const t = buildBroadleaf(species, seed), near = t.crown.index.count / 3, far = t.farCrown.index.count / 3;
    assert.ok(near > 1500 && near < 20000, `${species} ${seed}: ${near} crown triangles`);
    assert.ok(far < near * .25, 'the distant crown is not much lighter');
    assert.ok(t.trunk.index.count / 3 < 16000, `${species} ${seed}: ${t.trunk.index.count / 3} trunk triangles`);
    const uv = t.crown.attributes.uv.array;
    for (let i = 0; i < uv.length; i++) assert.ok(uv[i] >= 0 && uv[i] <= 1);
    assert.ok(species === 'oak' ? t.crownBase > 5 && t.crownBase < 12 : t.crownBase > 7 && t.crownBase < 14, `${species} crown base ${t.crownBase}`);
    assert.ok(species === 'oak' ? t.boleRadius > .6 : t.boleRadius < .4, `${species} bole ${t.boleRadius}`);
    assert.ok(t.farCrown.attributes.crownLod.array.every(v => v === 1));
  }
});
