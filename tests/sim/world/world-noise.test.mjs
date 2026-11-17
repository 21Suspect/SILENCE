import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { noise, hash, smooth } = await import('../../../game/sim/world/world-noise.ts');

// The formula noise() had before its lattice corners were cached: the cache must give the very same bits.
const mix = (a, b, t) => a + (b - a) * t;
const plain = (x, z) => { const ix = Math.floor(x), iz = Math.floor(z), u = smooth(x - ix, 0, 1), v = smooth(z - iz, 0, 1); return mix(mix(hash(ix, iz), hash(ix + 1, iz), u), mix(hash(ix, iz + 1), hash(ix + 1, iz + 1), u), v); };

test('cached lattice corners give exactly the values the plain formula gives, however the cells are visited', () => {
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 20000; i++) {
    // Terrain-like sweeps (neighbours sharing corners), scattered points, negative and large coordinates.
    const x = i % 3 === 0 ? (i % 200) * .37 - 30 : (rnd() - .5) * 4000, z = i % 3 === 0 ? Math.floor(i / 200) * .41 : (rnd() - .5) * 4000;
    assert.equal(noise(x, z), plain(x, z), `noise(${x}, ${z})`);
  }
});

test('corners that collide in the table, and coordinates past 32-bit integers, still read their own values', () => {
  // Two lattice points far apart share slots in a 65536-entry table sooner or later: alternate between many and compare each time.
  for (let round = 0; round < 3; round++) for (let k = 0; k < 70000; k += 7) assert.equal(noise(k + .5, -k * 3 + .25), plain(k + .5, -k * 3 + .25));
  for (const x of [2 ** 31 + .5, -(2 ** 31) - 1.5, 1e12 + .3, -0, Number.MIN_VALUE]) assert.equal(noise(x, 3.7), plain(x, 3.7));
  assert.ok(Number.isNaN(noise(NaN, 1)));
});
