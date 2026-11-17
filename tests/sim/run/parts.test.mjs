import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
globalThis.location = { search: `?world-v2${process.env.WORLD_SEED ? `&seed=${process.env.WORLD_SEED}` : ''}` };
const { placeParts, partsToItems, quarterOf, PARTS, PART_SITES, HOOK_OF } = await import('../../../game/sim/run/parts.ts');
const L = await import('../../../game/sim/world/world-layout.ts');
const { initialState, applyAction } = await import('../../../game/sim/objectives/objectives.ts');
const { landSlope } = await import('../../../game/sim/world/world-landform.ts');
const { treeDensity, riverX } = await import('../../../game/sim/world/world-noise.ts');
const assets = (await import('../../../game/data/world-assets.json', { with: { type: 'json' } })).default;

const pois = L.POI_PLACEMENTS, ids = new Set(pois.map(p => p.id));
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const layoutFor = (seed, lairId = L.LAIR_ID) => placeParts(pois, { seed, lairId });
const byId = id => pois.find(p => p.id === id);

test('seven parts: fuel and three fuses for the call, bulbs, a cable and fuel for the pad', () => {
  const l = layoutFor(7741);
  assert.deepEqual(l.parts.map(p => p.part), ['call-fuel', 'call-fuse-1', 'call-fuse-2', 'call-fuse-3', 'pad-bulbs', 'pad-cable', 'pad-fuel']);
  assert.deepEqual(l.parts.map(p => p.kind), ['jerry', 'fuse', 'fuse', 'fuse', 'bulbs', 'cable', 'jerry']);
  assert.deepEqual(l.parts.map(p => p.group), ['call', 'call', 'call', 'call', 'pad', 'pad', 'pad']);
  assert.equal(PARTS.length, 7);
});

test('every layout: three or more quarters, one part in the lair, valid places and hooks, at most two to a place', () => {
  for (const seed of SEEDS) for (const lairId of ['hunter-camp', 'shrine', L.LAIR_ID]) {
    const l = layoutFor(seed, lairId);
    const quarters = new Set(l.parts.map(p => quarterOf(byId(p.poiId))));
    assert.ok(quarters.size >= 3, `seed ${seed}: quarters ${[...quarters]}`);
    assert.deepEqual([...quarters].sort(), l.quarters);
    assert.ok(l.parts.some(p => p.poiId === lairId && p.inLair), `seed ${seed}: a part in the lair`);
    assert.equal(l.parts.filter(p => p.inLair).length, l.parts.filter(p => p.poiId === lairId).length);
    const per = {};
    for (const p of l.parts) {
      const poi = byId(p.poiId);
      assert.ok(poi, `seed ${seed}: ${p.poiId} is a place`);
      assert.equal(p.asset, poi.asset);
      assert.ok(PART_SITES.includes(poi.asset) || poi.id === lairId, `${poi.id} is somewhere parts may lie`);
      per[p.poiId] = (per[p.poiId] ?? 0) + 1;
      assert.ok(per[p.poiId] <= 2, `seed ${seed}: no more than two at ${p.poiId}`);
      // A hook only where the asset has that hook; otherwise a ground spot beside the place.
      if (p.hook) {
        assert.equal(p.hook, HOOK_OF[p.kind]);
        assert.ok(Object.hasOwn(assets[p.asset].hooks, p.hook), `${p.asset} has a ${p.hook} hook`);
        assert.equal(p.ground, undefined);
      } else {
        assert.ok(p.ground && Number.isFinite(p.ground.x) && Number.isFinite(p.ground.z), `${p.part} needs a ground spot`);
        const near = Math.hypot(p.ground.x - poi.x, p.ground.z - poi.z);
        assert.ok(near < 25, `seed ${seed}: ${p.part} lies ${near.toFixed(1)} m from ${poi.id}`);
      }
    }
    // Two parts never share a hook, and bulbs and cable never claim one.
    const hooks = l.parts.filter(p => p.hook).map(p => `${p.poiId}:${p.hook}`);
    assert.equal(new Set(hooks).size, hooks.length);
    for (const p of l.parts.filter(q => q.kind === 'bulbs' || q.kind === 'cable')) assert.equal(p.hook, undefined);
    // Two ground parts at one place are not on the same spot.
    const spots = l.parts.filter(p => p.ground).map(p => `${p.ground.x.toFixed(2)},${p.ground.z.toFixed(2)}`);
    assert.equal(new Set(spots).size, spots.length);
  }
});

test('hooks are preferred: most parts that can sit on a hook do', () => {
  let hooked = 0, hookable = 0;
  for (const seed of SEEDS) for (const p of layoutFor(seed).parts.filter(q => q.kind === 'fuse')) { hookable++; if (p.hook) hooked++; }
  assert.ok(hooked / hookable > .5, `${hooked} of ${hookable} fuses on a fuse hook`);
});

test('deterministic per seed, and different seeds give different layouts', () => {
  for (const seed of [1, 7741, 99]) assert.deepEqual(layoutFor(seed), layoutFor(seed));
  assert.equal(JSON.stringify(layoutFor(5)), JSON.stringify(placeParts(structuredClone(pois), { seed: 5, lairId: L.LAIR_ID })));
  const distinct = new Set(SEEDS.map(s => JSON.stringify(layoutFor(s).parts.map(p => [p.poiId, p.hook ?? null]))));
  assert.ok(distinct.size > 150, `${distinct.size} distinct layouts in ${SEEDS.length} seeds`);
  assert.notDeepEqual(layoutFor(1), layoutFor(2));
});

test('the layout becomes the reducer\'s items, ready to start a run', () => {
  const l = layoutFor(7741), items = partsToItems(l);
  assert.deepEqual(Object.keys(items), [...PARTS.map(p => p.id), 'backpack-cabin']);
  for (const p of l.parts) {
    const item = items[p.part];
    assert.deepEqual([item.kind, item.poi, item.status, item.part, item.poiId, item.hook], [p.kind, p.asset, 'world', p.part, p.poiId, p.hook]);
    if (p.ground) assert.deepEqual(item.at, p.ground);
  }
  assert.equal(items['backpack-cabin'].poi, 'cabin');
  const s = initialState(items);
  assert.equal(s.phase, 'gather');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  // A part can be picked up from where the seed put it.
  assert.equal(applyAction(s, { type: 'pickup', player: 'p', item: 'pad-bulbs' }).state.carrying.p, 'pad-bulbs');
  // The layout does not leak into the board as coordinates.
});

test('the lair is chosen by the world seed among camp, ruin, well, shrine, graves and fold', () => {
  assert.ok(L.LAIR_CANDIDATES.includes(L.LAIR_ID), L.LAIR_ID);
  assert.ok(ids.has(L.LAIR_ID));
  assert.deepEqual([...L.LAIR_CANDIDATES], ['hunter-camp', 'ruin', 'well', 'shrine', 'graves', 'fold']);
});

test('the landing pad: flat, open, 80 to 250 m from the relay hut, on its side of the stream, and drawn as one place of its own', () => {
  const hut = byId('relay-hut'), pad = L.LANDING_PAD;
  assert.ok(Number.isFinite(pad.x) && Number.isFinite(pad.z) && Number.isFinite(pad.yaw));
  const d = Math.hypot(pad.x - hut.x, pad.z - hut.z);
  assert.ok(d >= 80 && d <= 250, `${d.toFixed(0)} m from the hut`);
  assert.ok(landSlope(pad.x, pad.z, 12) < .16, `slope ${landSlope(pad.x, pad.z, 12).toFixed(3)}`);
  let trees = treeDensity(pad.x, pad.z);
  for (let k = 0; k < 8; k++) trees += treeDensity(pad.x + Math.cos(k * .785) * 14, pad.z + Math.sin(k * .785) * 14);
  assert.ok(trees / 9 < .6, `tree density ${(trees / 9).toFixed(2)}`);
  assert.equal(Math.sign(pad.x - riverX(pad.z)), Math.sign(hut.x - riverX(hut.z)), 'no stream between the hut and the pad');
  // The pad is drawn since the renderer has the slab (world-layout.ts pushes it as 'landing-pad', after it was sited): it is clear of every other place.
  for (const p of pois) assert.ok(p.id === 'landing-pad' || Math.hypot(p.x - pad.x, p.z - pad.z) >= 45 || p.asset === 'minerock', `${p.id} is clear of the pad`);
  assert.deepEqual(pois.filter(p => /pad|heli/.test(p.id) || /pad|heli/.test(p.asset)).map(p => [p.id, p.asset, p.x, p.z]), [['landing-pad', 'helipad', pad.x, pad.z]]);
  for (const p of [...pois, ...L.SCATTER_PLACEMENTS]) assert.ok(Object.hasOwn(assets, p.asset), `${p.id}: ${p.asset}`);
});
