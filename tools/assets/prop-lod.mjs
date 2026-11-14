// Mesh levels of detail for the placed props (game/render/props/pois.ts): for each primitive of a prop's GLB, index lists over its
// own vertices that drop triangles while staying within a fixed error in metres (meshoptimizer, absolute error, normals and both
// UV sets weighted so shading and textures stay put too). The vertices, normals, UVs and materials are the prop's own: a level is only fewer triangles of it.
// The game picks the coarsest level whose error is under half a pixel at the prop's distance, so a switch cannot be seen.
//
//   node tools/assets/prop-lod.mjs            every prop over MIN_TRIANGLES
//   node tools/assets/prop-lod.mjs cabin mine  just these
//
// Writes public/world/lod/<prop>.bin and game/data/prop-lod.json. Run again after rebuilding a prop's GLB (commit them together):
// the game checks each primitive's vertex and index counts and ignores a stale file.
import fs from 'node:fs';
import path from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'game/data/world-assets.json'), 'utf8'));
const MANIFEST = path.join(ROOT, 'game/data/prop-lod.json');
/** Errors in metres for the levels: half a pixel at 1080 lines and 69 degrees at about 16, 47, 157, 470 and 1570 m. */
const ERRORS = [.01, .03, .1, .3, 1];
/** Below this a prop is cheap enough whole (2000: the scattered ones, a power pole of 2900 triangles, come by the dozen). */
const MIN_TRIANGLES = 2000;
/** A level is kept only if it has at most this share of the previous level's triangles. */
const KEEP = .8;
/** Normals weigh in at this many metres per unit of change, times the level's error: about 11 degrees of turn costs one error. */
const NORMAL_WEIGHT = 1 / .2;

function readGlb(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jsonLength = b.readUInt32LE(12), json = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8, bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + jsonLength));
  const read = index => {
    const a = json.accessors[index], view = json.bufferViews[a.bufferView], offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    if (view.byteStride && view.byteStride !== size * 4 && a.componentType === 5126) throw new Error(`${file}: interleaved attributes are not handled`);
    const Type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    return new Type(bin.buffer.slice(bin.byteOffset + offset, bin.byteOffset + offset + a.count * size * Type.BYTES_PER_ELEMENT));
  };
  return { json, read };
}

/**
 * Per vertex of every primitive, how far behind it (against its normal) the nearest surface facing the other way lies, up to
 * `reach` metres: the thickness of a sheet, a plank, a roof. A vertex may only move by a level's error where that is well under
 * it, or the two faces of a thin part pass through each other: the cabin's roof is iron sheet a few millimetres thick, and at a
 * centimetre's error its lamp-lit underside came through the top in patches (z-fighting), the roof glowing at night from 16 m.
 */
function thicknesses(source, reach) {
  const CELL = .08, cells = new Map(), key = (i, j, k) => `${i},${j},${k}`;
  const tris = [];
  source.forEach((s, prim) => {
    const P = s.positions, I = s.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2], ux = P[b] - ax, uy = P[b + 1] - ay, uz = P[b + 2] - az, vx = P[c] - ax, vy = P[c + 1] - ay, vz = P[c + 2] - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l < 1e-12) continue; nx /= l; ny /= l; nz /= l;
      const id = tris.length; tris.push([ax, ay, az, ux, uy, uz, vx, vy, vz, nx, ny, nz]);
      const lo = [Math.min(ax, P[b], P[c]), Math.min(ay, P[b + 1], P[c + 1]), Math.min(az, P[b + 2], P[c + 2])], hi = [Math.max(ax, P[b], P[c]), Math.max(ay, P[b + 1], P[c + 1]), Math.max(az, P[b + 2], P[c + 2])];
      for (let i = Math.floor(lo[0] / CELL); i <= Math.floor(hi[0] / CELL); i++) for (let j = Math.floor(lo[1] / CELL); j <= Math.floor(hi[1] / CELL); j++) for (let k = Math.floor(lo[2] / CELL); k <= Math.floor(hi[2] / CELL); k++) {
        const kk = key(i, j, k); let list = cells.get(kk); if (!list) cells.set(kk, list = []); list.push(id);
      }
    }
  });
  return source.map(s => {
    const out = new Float32Array(s.vertices).fill(Infinity), P = s.positions, N = s.normals;
    if (!N) return out;
    for (let v = 0; v < s.vertices; v++) {
      const ox = P[v * 3], oy = P[v * 3 + 1], oz = P[v * 3 + 2], dx = -N[v * 3], dy = -N[v * 3 + 1], dz = -N[v * 3 + 2];
      const seen = new Set();
      // The cells along the ray, sampled at half a cell.
      for (let t = 0; t <= reach; t += CELL * .5) {
        const kk = key(Math.floor((ox + dx * t) / CELL), Math.floor((oy + dy * t) / CELL), Math.floor((oz + dz * t) / CELL)), list = cells.get(kk);
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue; seen.add(id);
          const [ax, ay, az, ux, uy, uz, vx, vy, vz, nx, ny, nz] = tris[id];
          if (nx * dx + ny * dy + nz * dz < .3) continue; // only a face turned back towards the vertex (the other side of a sheet)
          // Moller-Trumbore.
          const px = dy * vz - dz * vy, py = dz * vx - dx * vz, pz = dx * vy - dy * vx, det = ux * px + uy * py + uz * pz;
          if (Math.abs(det) < 1e-12) continue;
          const sx = ox - ax, sy = oy - ay, sz = oz - az, inv = 1 / det, bu = (sx * px + sy * py + sz * pz) * inv;
          if (bu < 0 || bu > 1) continue;
          const qx = sy * uz - sz * uy, qy = sz * ux - sx * uz, qz = sx * uy - sy * ux, bv = (dx * qx + dy * qy + dz * qz) * inv;
          if (bv < 0 || bu + bv > 1) continue;
          const d = (vx * qx + vy * qy + vz * qz) * inv;
          if (d > 1e-5 && d < out[v]) out[v] = d;
        }
        if (out[v] <= t) break;
      }
    }
    return out;
  });
}
/** A vertex keeps its place where the surface behind it is closer than this many times the level's error. */
const THIN = 3;

await MeshoptSimplifier.ready;
MeshoptSimplifier.useExperimentalFeatures = true;
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const only = process.argv.slice(2);
fs.mkdirSync(path.join(ROOT, 'public/world/lod'), { recursive: true });

for (const [name, def] of Object.entries(assets)) {
  if (only.length && !only.includes(name)) continue;
  const file = path.join(ROOT, 'public', def.url);
  if (!fs.existsSync(file)) continue;
  const { json, read } = readGlb(file);
  // Primitives in the order three's GLTFLoader makes their meshes: scene nodes depth first, then each mesh's primitives.
  const order = [], visit = n => { const node = json.nodes[n]; if (node.mesh !== undefined) order.push(node.mesh); for (const c of node.children ?? []) visit(c); };
  for (const n of json.scenes[json.scene ?? 0].nodes) visit(n);
  const prims = order.flatMap(m => json.meshes[m].primitives).filter(p => (p.mode ?? 4) === 4 && p.indices !== undefined);
  const triangles = prims.reduce((n, p) => n + json.accessors[p.indices].count / 3, 0);
  if (triangles < MIN_TRIANGLES) { if (manifest[name]) { delete manifest[name]; fs.rmSync(path.join(ROOT, 'public/world/lod', `${name}.bin`), { force: true }); } continue; }
  const source = prims.map(p => {
    const positions = read(p.attributes.POSITION), indices = Uint32Array.from(read(p.indices)), vertices = positions.length / 3;
    // What the simplifier must also keep: the normals, and both UV sets measured in metres on the surface (texture units per
    // metre, the median over the primitive's edges), so moving a texture by a centimetre costs what moving the surface does.
    // Without the UVs, collapses let roof triangles stretch across the cabin's baked macro map into its lamp-lit interior
    // texels, and the roof glowed with the lamp from 16 m out.
    const channels = [], weights = [];
    if (p.attributes.NORMAL !== undefined) channels.push({ data: read(p.attributes.NORMAL), size: 3, weight: error => NORMAL_WEIGHT * error });
    for (const uv of ['TEXCOORD_0', 'TEXCOORD_1']) {
      if (p.attributes[uv] === undefined) continue;
      const data = read(p.attributes[uv]), ratios = [];
      for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) {
        const a = indices[t + k], b = indices[t + (k + 1) % 3];
        const metres = Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
        if (metres > 1e-4) ratios.push(Math.hypot(data[a * 2] - data[b * 2], data[a * 2 + 1] - data[b * 2 + 1]) / metres);
      }
      ratios.sort((x, y) => x - y);
      const perMetre = ratios[ratios.length >> 1] || 1;
      channels.push({ data, size: 2, weight: () => 1 / perMetre });
    }
    const stride = channels.reduce((n, c) => n + c.size, 0), attributes = new Float32Array(vertices * stride);
    for (let v = 0; v < vertices; v++) { let o = v * stride; for (const c of channels) for (let k = 0; k < c.size; k++) attributes[o++] = c.data[v * c.size + k]; }
    const normals = p.attributes.NORMAL !== undefined ? read(p.attributes.NORMAL) : undefined;
    return { positions, indices, vertices, normals, attributes, stride, weights: error => channels.flatMap(c => Array(c.size).fill(c.weight(error))) };
  });
  const thick = thicknesses(source, THIN * Math.max(...ERRORS.filter(e => e <= .1)));
  const simplify = (s, error, prim) => {
    const lock = new Uint8Array(s.vertices); let locked = 0;
    thick[prim].forEach((t, v) => { if (t < THIN * error) { lock[v] = 1; locked++; } });
    return MeshoptSimplifier.simplifyWithAttributes(s.indices, s.positions, 3, s.stride ? s.attributes : new Float32Array(s.vertices), s.stride || 1, s.stride ? s.weights(error) : [0], locked ? lock : null, 0, error, ['ErrorAbsolute'])[0];
  };
  const kept = [], payload = [];
  let at = 0, previous = triangles;
  for (const error of ERRORS) {
    const lists = source.map((s, prim) => simplify(s, error, prim)), count = lists.reduce((n, l) => n + l.length / 3, 0);
    if (count > previous * KEEP) continue;
    previous = count;
    const level = { error, triangles: count, prims: [] };
    lists.forEach((indices, i) => {
      const wide = source[i].vertices > 65535, data = wide ? indices : Uint16Array.from(indices), bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      level.prims.push({ offset: at, count: indices.length, wide });
      payload.push(bytes); at += bytes.length;
      if (at % 4) { const pad = 4 - at % 4; payload.push(Buffer.alloc(pad)); at += pad; }
    });
    kept.push(level);
  }
  // Nothing it can drop without moving a thin part: drawn whole.
  if (!kept.length) { delete manifest[name]; fs.rmSync(path.join(ROOT, 'public/world/lod', `${name}.bin`), { force: true }); continue; }
  fs.writeFileSync(path.join(ROOT, 'public/world/lod', `${name}.bin`), Buffer.concat(payload));
  manifest[name] = { url: `/world/lod/${name}.bin`, prims: source.map(s => ({ vertices: s.vertices, indices: s.indices.length })), levels: kept };
  console.log(`${name.padEnd(14)} ${String(triangles).padStart(7)} tris -> ${kept.map(l => `${l.error} m: ${l.triangles}`).join(', ')}  (${(at / 1024).toFixed(0)} KB)`);
}
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
