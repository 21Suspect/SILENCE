#!/usr/bin/env python3
"""
Packs the Black Alder trees (Quixel Megascans via Fab, extracted from the Unreal project) into what the game streams:
public/world/alder/<Tree>_L<lod>.glb, tex/*.webp and manifest.json.

    python3 tools/assets/alder/build.py --src ~/Downloads/alder-extract [--out public/world/alder]

--src is the folder holding trees/*.gltf (+ .bin) and web_textures/. The extract is not part of the repository.

What it does to each source mesh:
  * welds it. The source is unindexed (three vertices a triangle); welded on position, normal and uv it is a third to a half of that.
  * drops everything the game does not read (tangents, colours, second uv sets) and stores normals as 8-bit (KHR_mesh_quantization).
  * keeps one primitive a material, sorted by name, so the game builds its own materials from the names: Tileable, Trunk_01 and
    Trunk_02 (bark), Decoration (moss cards), TwoSided_Summer (leaves).
  * ships only the source LODs the game uses, four distance slots a tree (see SLOTS): the first, the finest the budget allows, is
    loaded on demand and drawn only on the few nearest trees.
Per tree it also measures what collision and the creature's climbing need: height, how far the crown reaches, where the live crown
starts, the bark radius at 1.5 m, and the trunk's axis and radius every half metre (the bark contact is rebuilt from them).
"""
import argparse, json, os, struct
import numpy as np
from PIL import Image

BARK = ('Tileable', 'Trunk_01', 'Trunk_02')
LEAVES = ('TwoSided_Summer',)
PROFILE_STEP = .5


def read_gltf(path):
    g = json.load(open(path))
    base = os.path.dirname(path)
    blobs = [open(os.path.join(base, b['uri']), 'rb').read() for b in g['buffers']]

    def accessor(i):
        a = g['accessors'][i]; v = g['bufferViews'][a['bufferView']]
        dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        off = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        out = np.frombuffer(blobs[v['buffer']], dtype=dt, count=a['count'] * n, offset=off)
        return out.reshape(-1, n) if n > 1 else out

    prims = {}
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            name = g['materials'][p['material']]['name']
            att = p['attributes']
            prims.setdefault(name, []).append((accessor(att['POSITION']), accessor(att['NORMAL']), accessor(att['TEXCOORD_0']), accessor(p['indices']).astype(np.int64)))
    return prims


def weld(prims):
    """-> positions (V,3) f32, normals (V,3) int8, uvs (V,2) f32, {material: index array}, the vertices shared by the whole mesh."""
    rows, ranges, base = [], {}, 0
    for name in sorted(prims):
        for pos, nrm, uv, idx in prims[name]:
            n8 = np.clip(np.round(nrm * 127), -127, 127).astype(np.int8)
            used = np.unique(idx)
            remap = np.full(pos.shape[0], -1, np.int64); remap[used] = np.arange(used.size)
            row = np.concatenate([np.ascontiguousarray(pos[used]).view(np.uint32), n8[used].view(np.uint8).astype(np.uint32),
                                  np.ascontiguousarray(uv[used]).view(np.uint32)], axis=1)
            rows.append(row); ranges.setdefault(name, []).append((base, remap[idx])); base += used.size
    table = np.ascontiguousarray(np.concatenate(rows))
    void = table.view(np.dtype((np.void, table.dtype.itemsize * table.shape[1]))).ravel()
    _, first, inverse = np.unique(void, return_index=True, return_inverse=True)
    inverse = inverse.ravel()
    u = table[first]
    pos = np.ascontiguousarray(u[:, 0:3]).view(np.float32)
    nrm = np.ascontiguousarray(u[:, 3:6].astype(np.uint8)).view(np.int8)
    uv = np.ascontiguousarray(u[:, 6:8]).view(np.float32)
    index = {name: np.concatenate([inverse[b + local] for b, local in parts]) for name, parts in ranges.items()}
    return pos, nrm, uv, index


def write_glb(path, pos, nrm, uv, index):
    names = sorted(index)
    big = pos.shape[0] > 65535
    chunks, views, accessors = [], [], []

    def add(data, target=None, stride=None):
        pad = (-sum(len(c) for c in chunks)) % 4
        if pad: chunks.append(b'\0' * pad)
        offset = sum(len(c) for c in chunks)
        chunks.append(data)
        v = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(data)}
        if target: v['target'] = target
        if stride: v['byteStride'] = stride
        views.append(v); return len(views) - 1

    count = pos.shape[0]
    accessors.append({'bufferView': add(pos.astype('<f4').tobytes(), 34962), 'componentType': 5126, 'count': count, 'type': 'VEC3',
                      'min': pos.min(0).tolist(), 'max': pos.max(0).tolist()})
    padded = np.zeros((count, 4), np.int8); padded[:, :3] = nrm
    accessors.append({'bufferView': add(padded.tobytes(), 34962, 4), 'componentType': 5120, 'normalized': True, 'count': count, 'type': 'VEC3'})
    accessors.append({'bufferView': add(uv.astype('<f4').tobytes(), 34962), 'componentType': 5126, 'count': count, 'type': 'VEC2'})
    prims = []
    for i, name in enumerate(names):
        idx = index[name].astype('<u4' if big else '<u2')
        accessors.append({'bufferView': add(idx.tobytes(), 34963), 'componentType': 5125 if big else 5123, 'count': int(idx.size), 'type': 'SCALAR'})
        prims.append({'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2}, 'indices': 3 + i, 'material': i, 'mode': 4})
    blob = b''.join(chunks); blob += b'\0' * ((-len(blob)) % 4)
    doc = {'asset': {'version': '2.0', 'generator': 'tools/assets/alder/build.py'}, 'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
           'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}], 'meshes': [{'primitives': prims}], 'materials': [{'name': n} for n in names],
           'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}]}
    js = json.dumps(doc, separators=(',', ':')).encode(); js += b' ' * ((-len(js)) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(blob), 0x004E4942)); f.write(blob)
    return os.path.getsize(path)


def measure(pos, index):
    """Height, crown reach and base, bark radius and the trunk's axis, from a welded mesh."""
    def verts(names):
        parts = [index[n] for n in index if n in names]
        return np.unique(np.concatenate(parts)) if parts else np.zeros(0, np.int64)
    bark_idx, leaf_idx = verts(BARK), verts(LEAVES)
    top = float(pos[:, 1].max())
    reach = float(np.hypot(pos[:, 0], pos[:, 2]).max())
    leaves = pos[leaf_idx] if leaf_idx.size else pos
    crown_base = float(np.percentile(leaves[:, 1], 2))
    wood = pos[bark_idx]
    axis, radius = [], []
    centre = None
    profile_top = min(top * .85, max(crown_base + 4, 12))
    y = 0.0
    while y <= profile_top + 1e-6:
        sel = wood[(wood[:, 1] >= y - PROFILE_STEP * .6) & (wood[:, 1] < y + PROFILE_STEP * .6)]
        if centre is None:
            near = sel[np.hypot(sel[:, 0], sel[:, 2]) < 1.5] if sel.size else sel
            centre = near[:, [0, 2]].mean(0) if near.size else np.zeros(2)
        r_prev = radius[-1] if radius else .6
        d = np.hypot(sel[:, 0] - centre[0], sel[:, 2] - centre[1]) if sel.size else np.zeros(0)
        keep = sel[d < max(r_prev * 1.7, .35)] if sel.size else sel
        r = r_prev
        if keep.shape[0] >= 6:
            for _ in range(3):
                centre = keep[:, [0, 2]].mean(0)
                d = np.hypot(keep[:, 0] - centre[0], keep[:, 2] - centre[1])
                trimmed = keep[d < max(np.median(d) * 1.6, .1)]
                if trimmed.shape[0] < 6: break
                keep = trimmed
            r = float(np.median(np.hypot(keep[:, 0] - centre[0], keep[:, 2] - centre[1])))
        axis.append([round(float(centre[0]), 3), round(float(centre[1]), 3)]); radius.append(round(r, 3))
        y += PROFILE_STEP
    bole = radius[min(len(radius) - 1, int(round(1.5 / PROFILE_STEP)))]
    return {'height': round(top, 2), 'reach': round(reach, 2), 'crownBase': round(crown_base, 2), 'boleRadius': round(bole, 3),
            'profileStep': PROFILE_STEP, 'axis': axis, 'radius': radius}


def textures(src, out):
    os.makedirs(os.path.join(out, 'tex'), exist_ok=True)
    total = 0
    for f in sorted(os.listdir(os.path.join(src, 'web_textures'))):
        if 'Winter' in f: continue
        name, _ = os.path.splitext(f)
        img = Image.open(os.path.join(src, 'web_textures', f))
        # Video memory: the bark and leaf colour keep 2048, the shared bark normals too; every other normal and the moss are
        # 1024 (they are seen as detail on top of a colour that stays sharp).
        small = name.endswith('normal') and not name.startswith('Tileable') or name.startswith('Decoration')
        if small and img.width > 1024: img = img.resize((1024, 1024), Image.LANCZOS)
        dst = os.path.join(out, 'tex', name + '.webp')
        if name.endswith('normal'): img.convert('RGB').save(dst, 'WEBP', quality=90, method=6)
        elif img.mode == 'RGBA': img.save(dst, 'WEBP', quality=88, alpha_quality=100, method=6)
        else: img.convert('RGB').save(dst, 'WEBP', quality=88, method=6)
        total += os.path.getsize(dst)
    return total


def source_tris(path):
    g = json.load(open(path))
    return sum(g['accessors'][p['indices']]['count'] // 3 for m in g['meshes'] for p in m['primitives'])


# What each distance slot may hold, in source LODs, best first, and the most triangles it may spend. The game draws slot 0 within a few
# metres (and for only the nearest trees), slot 1 out to about 20 m, slot 2 to about 45 m, slot 3 to the edge of the fog. The old
# procedural forest spent 15 to 30 thousand triangles on a tree up close and 3 to 6 thousand far away; these limits keep the alders near that.
SLOTS = (((0, 1, 2, 3), 230_000), ((3, 4, 5), 60_000), ((4, 5), 16_000), ((5, 4, 3), None))


def plan(tris):
    """-> the source LOD for each of the four slots, never finer further out."""
    out = []
    for lods, limit in SLOTS:
        pick = next((l for l in lods if l in tris and (limit is None or tris[l] <= limit)), None)
        if pick is None: pick = max(tris) if limit is not None else max(tris)
        out.append(pick)
    for i in range(1, 4): out[i] = max(out[i], out[i - 1])
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--src', required=True); ap.add_argument('--out', default='public/world/alder')
    ap.add_argument('--only', help='comma separated tree names, for quick runs')
    ap.add_argument('--textures-only', action='store_true')
    a = ap.parse_args()
    src = os.path.expanduser(a.src); out = a.out; os.makedirs(out, exist_ok=True)
    if a.textures_only:
        print(f'textures {textures(src, out) / 1e6:.1f} MB'); return
    folder = os.path.join(src, 'trees')
    names = sorted({f[len('BlackAlder_'):f.index('_LOD')] for f in os.listdir(folder) if f.endswith('.gltf')})
    if not a.only:
        for f in os.listdir(out):
            if f.endswith('.glb'): os.remove(os.path.join(out, f))
    manifest, total = [], 0
    for name in names:
        if a.only and name not in a.only.split(','): continue
        path = lambda lod: os.path.join(folder, f'BlackAlder_{name}_LOD{lod}.gltf')
        tris = {lod: source_tris(path(lod)) for lod in range(7) if os.path.exists(path(lod))}
        slots = plan(tris)
        entry = {'name': name, 'slots': slots, 'lods': {}}
        for lod in sorted(set(slots)):
            pos, nrm, uv, index = weld(read_gltf(path(lod)))
            size = write_glb(os.path.join(out, f'{name}_L{lod}.glb'), pos, nrm, uv, index)
            n = sum(int(i.size) // 3 for i in index.values())
            entry['lods'][str(lod)] = {'file': f'{name}_L{lod}.glb', 'tris': n, 'verts': int(pos.shape[0]), 'bytes': size, 'materials': sorted(index)}
            total += size
            print(f'{name} L{lod}: {n} tris, {pos.shape[0]} verts, {size / 1e6:.2f} MB', flush=True)
            if lod == slots[1]: entry.update(measure(pos, index))
        print(f'{name} slots {slots}', flush=True)
        manifest.append(entry)
    tex = 0 if a.only else textures(src, out)
    json.dump({'textures': 'tex/', 'trees': manifest}, open(os.path.join(out, 'manifest.json'), 'w'), separators=(',', ':'))
    print(f'meshes {total / 1e6:.1f} MB, textures {tex / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
