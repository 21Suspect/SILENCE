import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The props' mesh levels (tools/assets/prop-lod.mjs, read by game/render/props/pois.ts) are made from each prop's GLB: a GLB
// rebuilt without remaking its levels is drawn whole with a warning in the game. Here it fails, so it is caught before it ships.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'game/data/prop-lod.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'game/data/world-assets.json'), 'utf8'));

/** Each triangle primitive's vertex and index counts, in the order three's GLTFLoader makes their meshes. */
function primitives(file) {
  const b = fs.readFileSync(file), json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const order = [], visit = n => { const node = json.nodes[n]; if (node.mesh !== undefined) order.push(node.mesh); for (const c of node.children ?? []) visit(c); };
  for (const n of json.scenes[json.scene ?? 0].nodes) visit(n);
  return order.flatMap(m => json.meshes[m].primitives).filter(p => (p.mode ?? 4) === 4 && p.indices !== undefined)
    .map(p => ({ vertices: json.accessors[p.attributes.POSITION].count, indices: json.accessors[p.indices].count }));
}

test('every prop with mesh levels still matches its GLB, primitive for primitive', () => {
  for (const [name, lod] of Object.entries(manifest)) {
    assert.ok(assets[name], `${name} has mesh levels but is not in world-assets.json`);
    assert.deepEqual(primitives(path.join(ROOT, 'public', assets[name].url)), lod.prims, `${name}: rebuilt since its levels were made (node tools/assets/prop-lod.mjs ${name})`);
  }
});

test('each level is fewer triangles over the same vertices, within its file', () => {
  for (const [name, lod] of Object.entries(manifest)) {
    const bin = fs.readFileSync(path.join(ROOT, 'public', lod.url)), data = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    let previous = lod.prims.reduce((n, p) => n + p.indices / 3, 0), error = 0;
    for (const level of lod.levels) {
      assert.ok(level.error > error, `${name}: levels go from fine to coarse`); error = level.error;
      assert.ok(level.triangles < previous, `${name} ${level.error} m: fewer triangles than the level before`); previous = level.triangles;
      level.prims.forEach((at, i) => {
        assert.equal(at.count % 3, 0);
        assert.ok(at.offset % (at.wide ? 4 : 2) === 0 && at.offset + at.count * (at.wide ? 4 : 2) <= bin.byteLength, `${name}: primitive ${i} lies inside its file`);
        const indices = at.wide ? new Uint32Array(data, at.offset, at.count) : new Uint16Array(data, at.offset, at.count);
        let max = 0; for (const v of indices) if (v > max) max = v;
        assert.ok(at.count === 0 || max < lod.prims[i].vertices, `${name}: primitive ${i} indexes only its own vertices`);
      });
    }
  }
});
