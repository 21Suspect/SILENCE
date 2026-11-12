import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
globalThis.location = { search: '?world-v2' };
const { waterDepthAt, wadeSpeedFactor, canWadeTo, limitWading, WADE_LIMIT } = await import('../../../game/sim/world/water-depth.ts');
const { SPAWN, POI_PLACEMENTS, placeLocal } = await import('../../../game/sim/world/world-layout.ts');
const { riverX } = await import('../../../game/sim/world/world-noise.ts');
const { coastZ, LAKE_CENTER } = await import('../../../game/sim/world/coastal-geography.ts');

test('dry land has no depth; the lake, the sea and the river have', () => {
  assert.equal(waterDepthAt(SPAWN.x, SPAWN.z), 0);
  const cabin = POI_PLACEMENTS.find(p => p.id === 'cabin'); assert.equal(waterDepthAt(cabin.x, cabin.z), 0);
  assert.ok(waterDepthAt(LAKE_CENTER.x, 100) > 1.5, `the lake is ${waterDepthAt(LAKE_CENTER.x, 100)} m deep in the middle`);
  assert.ok(waterDepthAt(0, coastZ(0) - 120) > 1.5, 'the sea beyond the beach is deep');
  let best = 0; for (let d = -3; d <= 3; d += .25) best = Math.max(best, waterDepthAt(riverX(-200) + d, -200));
  assert.ok(best > .3 && best < 1.2, `the river is ${best.toFixed(2)} m deep at the middle: wadeable`);
  for (const [x, z] of [[0, 0], [1e5, 1e5], [-3000, 400], [0, -5000]]) { const d = waterDepthAt(x, z); assert.ok(Number.isFinite(d) && d >= 0); }
});
test('the sea gets no shallower going out from the beach', () => {
  let last = 0;
  for (let out = 0; out <= 300; out += 10) { const d = waterDepthAt(0, coastZ(0) - out); assert.ok(d >= last - .15, `shallower at ${out} m out: ${d.toFixed(2)} after ${last.toFixed(2)}`); last = Math.max(last, d); }
  assert.ok(last > 1.5);
});
test('speed falls off with depth: ankle barely, knee clearly, waist about a third', () => {
  assert.equal(wadeSpeedFactor(0), 1);
  assert.ok(wadeSpeedFactor(.2) > .9 && wadeSpeedFactor(.2) < 1);
  assert.ok(wadeSpeedFactor(.5) < .75 && wadeSpeedFactor(.5) > .55);
  assert.ok(Math.abs(wadeSpeedFactor(1) - 1 / 3) < .06, `waist deep: ${wadeSpeedFactor(1).toFixed(2)}`);
  let last = 1; for (let d = 0; d <= 3; d += .05) { const f = wadeSpeedFactor(d); assert.ok(f <= last + 1e-9 && f >= .25); last = f; }
});
test('a walker cannot go further into water deeper than the limit, but can always walk out of it', () => {
  assert.ok(canWadeTo(0, WADE_LIMIT) && !canWadeTo(.5, WADE_LIMIT + .2) && canWadeTo(2, 1.9) && !canWadeTo(2, 2.1));
  // Walking straight out to sea from the beach stops at the limit; walking back is always possible.
  let x = 0, z = coastZ(0) + 20; const at = (px, pz) => waterDepthAt(px, pz);
  for (let i = 0; i < 4000; i++) { const next = limitWading(x, z, x, z - .1); x = next.x; z = next.z; }
  assert.ok(at(x, z) <= WADE_LIMIT + .15 && at(x, z) > .6, `the walk out to sea ended in ${at(x, z).toFixed(2)} m of water`);
  // A player put in deep water (a spawn, a teleport) can still walk back to the shore.
  let px = 0, pz = coastZ(0) - 150; const start = at(px, pz);
  for (let i = 0; i < 3000; i++) { const next = limitWading(px, pz, px, pz + .1); px = next.x; pz = next.z; }
  assert.ok(at(px, pz) < start && at(px, pz) < 1, `walked back to ${at(px, pz).toFixed(2)} m from ${start.toFixed(2)} m`);
});
test('each ford is shallow: no deeper than a knee all the way across', async () => {
  const { FORDS } = await import('../../../game/sim/world/world-layout.ts');
  for (const f of FORDS) { let worst = 0; for (let k = -8; k <= 8; k += .5) worst = Math.max(worst, waterDepthAt(f.x + f.dx * k, f.z + f.dz * k)); assert.ok(worst <= .55, `${f.id} is ${worst.toFixed(2)} m deep`); }
});
