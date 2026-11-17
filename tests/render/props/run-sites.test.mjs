import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
globalThis.location ??= { search: '' }; // the rebuilt world, as in the browser
const layout = await import('../../../game/sim/world/world-layout.ts');
const { heightAt } = await import('../../../game/sim/world/world.ts');
const sites = await import('../../../game/render/props/run-sites.ts');
const { placeLocal, POI_PLACEMENTS, LANDING_PAD } = layout;

test('the landing pad is a place of its own, and its ground is level under the whole 12 m slab', () => {
  const pad = POI_PLACEMENTS.find(p => p.id === 'landing-pad');
  assert.ok(pad, 'the layout places it'); assert.equal(pad.asset, 'helipad');
  assert.deepEqual([pad.x, pad.z, pad.yaw], [LANDING_PAD.x, LANDING_PAD.z, LANDING_PAD.yaw]);
  let low = Infinity, high = -Infinity;
  for (let i = -6; i <= 6; i += 1.5) for (let j = -6; j <= 6; j += 1.5) { const [x, z] = placeLocal(pad, i, j), h = heightAt(x, z); low = Math.min(low, h); high = Math.max(high, h); }
  assert.ok(high - low < .12, `flat under the slab: ${(high - low).toFixed(3)} m between its lowest and highest corner`);
});

test('the pad\'s generator faces its junction box; the crates and the board stand where the run needs them', () => {
  const placements = sites.runPlacements(), by = id => placements.find(p => p.id === id);
  assert.deepEqual(placements.map(p => p.id).sort(), ['cabin-board', 'pad-crate', 'pad-generator', 'relay-crate']);
  const gen = by('pad-generator'), end = placeLocal(gen, 1.1, 0), box = placeLocal(LANDING_PAD, 7.22, 1.6);
  assert.ok(Math.hypot(end[0] - box[0], end[1] - box[1]) < Math.hypot(gen.x - box[0], gen.z - box[1]) - 1, 'its cable end is the end nearer the box');
  const away = Math.hypot(gen.x - box[0], gen.z - box[1]); assert.ok(away > 2.5 && away < 7, `a few metres from the box: ${away.toFixed(1)}`);
  const cabin = POI_PLACEMENTS.find(p => p.id === 'cabin'), board = by('cabin-board');
  assert.ok(Math.hypot(board.x - cabin.x, board.z - cabin.z) < 9, 'the board is beside the cabin');
  assert.ok(Math.hypot(by('relay-crate').x - POI_PLACEMENTS.find(p => p.id === 'relay-hut').x, by('relay-crate').z - POI_PLACEMENTS.find(p => p.id === 'relay-hut').z) < 6, 'the relay crate is at the hut');
});

test('the chest stands inside the cabin, on its floor', () => {
  const chest = sites.chestSite(heightAt), cabin = POI_PLACEMENTS.find(p => p.id === 'cabin');
  assert.ok(chest);
  const c = Math.cos(cabin.yaw), s = Math.sin(cabin.yaw), dx = chest.x - cabin.x, dz = chest.z - cabin.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
  assert.ok(Math.abs(lx) < 3.1 && Math.abs(lz) < 2.4, `within the room: ${lx.toFixed(2)}, ${lz.toFixed(2)}`);
  assert.ok(chest.y > heightAt(cabin.x, cabin.z) - .5 && chest.y < heightAt(cabin.x, cabin.z) + 1.5, 'on the floor, a little above the ground');
});
