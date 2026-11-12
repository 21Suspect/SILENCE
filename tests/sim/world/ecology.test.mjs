import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.location ??= { search: '' };   // the rebuilt world, as the game opens
const W = await import('../../../game/sim/world/world.ts');
const P = await import('../../../game/sim/world/placement.ts');
const E = await import('../../../game/sim/world/ecology.ts');

const geography = { heightAt: W.heightAt, exclusion: W.vegetationExclusion, biomeAt: W.biomeAt, riverX: W.riverX, riverPresence: W.riverPresence, roadZ: W.roadZ, radius: W.WORLD_RADIUS };
const layout = P.naturalLayout(geography);
const ecology = () => E.createEcology({ heightAt: W.heightAt, exclusion: W.vegetationExclusion, biomeAt: W.biomeAt, layoutCell: (x, z) => layout.cell(x, z), radius: W.WORLD_RADIUS });
// A stretch of the forest west of the main trail, the "canopy" graphics station.
const CELLS = []; for (let cz = 2; cz < 10; cz++) for (let cx = -12; cx < -4; cx++) CELLS.push([cx, cz]);

test('the same cell grows the same plants, whatever was grown before it', () => {
  const a = ecology(), b = ecology();
  for (const [cx, cz] of CELLS.slice(0, 12)) a.grow(cx, cz);
  for (const [cx, cz] of CELLS.slice(0, 6)) assert.deepEqual(b.grow(cx, cz), a.grow(cx, cz));
});

test('no plant stands inside a trunk, rock, stump or fallen log', () => {
  const eco = ecology(), plants = CELLS.flatMap(([cx, cz]) => eco.grow(cx, cz));
  const near = new Set(); for (let x = -3; x <= -1; x++) for (let z = 0; z <= 2; z++) near.add(layout.cell(x, z));
  const trees = [], rocks = [], logs = [];
  for (const c of near) { trees.push(...c.trees); rocks.push(...c.rubble); logs.push(...c.deadfall); }
  assert.ok(plants.length > 500 && trees.length > 20);
  for (const p of plants) {
    for (const t of trees) assert.ok(Math.hypot(p.x - t.x, p.z - t.z) >= .62 * t.width + .15 - 1e-9, `${p.flora} inside a trunk`);
    for (const r of rocks) assert.ok(Math.hypot(p.x - r.x, p.z - r.z) >= r.size * 1.15 - 1e-9, `${p.flora} inside a rock`);
    for (const d of logs) {
      const dx = Math.sin(d.yaw) * d.size * .5, dz = Math.cos(d.yaw) * d.size * .5, ax = d.x - dx, az = d.z - dz, l = d.size * d.size;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * 2 * dx + (p.z - az) * 2 * dz) / l));
      assert.ok(Math.hypot(p.x - ax - 2 * dx * t, p.z - az - 2 * dz * t) >= d.variant + .08 - 1e-9, `${p.flora} inside a log`);
    }
  }
});

test('plants grow in colonies with bare ground between, not as an even sprinkle, and no one plant takes the floor', () => {
  const eco = ecology(), plants = CELLS.flatMap(([cx, cz]) => eco.grow(cx, cz));
  const counts = {}; for (const p of plants) counts[p.flora] = (counts[p.flora] ?? 0) + 1;
  const tall = plants.filter(p => p.flora !== 'celandine'), top = Math.max(...Object.entries(counts).filter(([f]) => f !== 'celandine').map(([, n]) => n));
  assert.ok(top / tall.length < .7, `one plant is ${Math.round(top / tall.length * 100)}% of the floor`);
  // Clumping: each plant's count in 3.2 m squares (a colony's size) varies far more than a uniform sprinkle would
  // (variance over mean: 1 for random, below 1 for an even spread).
  const side = 3.2, squares = (8 * 6.4 / side) ** 2, cellOf = p => `${Math.floor(p.x / side)},${Math.floor(p.z / side)}`;
  for (const flora of ['fern', 'shrub', 'celandine']) {
    const own = plants.filter(p => p.flora === flora), grid = new Map();
    for (const p of own) grid.set(cellOf(p), (grid.get(cellOf(p)) ?? 0) + 1);
    const mean = own.length / squares, values = [...grid.values()];
    const variance = (values.reduce((s, v) => s + (v - mean) ** 2, 0) + (squares - values.length) * mean * mean) / squares;
    assert.ok(variance / mean > 1.5, `${flora}: dispersion ${(variance / mean).toFixed(2)}, spread evenly`);
  }
  // Bare ground: 2 m squares with no fern, shrub, tussock or herb.
  const bareSquares = (8 * 6.4 / 2) ** 2, values = new Set(tall.map(p => `${Math.floor(p.x / 2)},${Math.floor(p.z / 2)}`));
  assert.ok((bareSquares - values.size) / bareSquares > .15, `bare ground ${Math.round((bareSquares - values.size) / bareSquares * 100)}%: none between the plants`);
});

test('the twin of the ground shader noise stays in range and is continuous', () => {
  let last = E.surfaceNoise(10, 3);
  for (let i = 1; i < 400; i++) {
    const v = E.surfaceNoise(10 + i * .01, 3);
    assert.ok(v >= 0 && v <= 1);
    assert.ok(Math.abs(v - last) < .05);
    last = v;
  }
});
