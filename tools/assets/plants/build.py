"""
Forest-floor plants for SILENCE: CC0 photoscans from Poly Haven, cut down for instancing.

  python3 tools/assets/plants/build.py fetch            # downloads the 1K glTFs and alpha maps into work/gfx/plants (git-ignored)
  blender --background --factory-startup --python tools/assets/plants/build.py [-- name ...]   # builds public/plantassets/<name>/

Each output is one GLB holding every variant of a plant as its own mesh (lowest point at y = 0, root at the origin), with the
scan's 1K colour, normal and AO/roughness maps, plus the scan's alpha map beside it as alpha.png (the game uses it as an alpha
map: the colour JPEGs carry none). Scans that hold several plants in one mesh (shrub_01, shrub_04) are split into plants by
the gaps between them. Each variant is decimated to a budget that suits how often it is drawn; a lighter far copy is made in
the game (undergrowth.ts, gridSimplify). Attribution: public/plantassets/attribution.json.
"""
import json, os, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
CACHE = os.path.join(ROOT, 'work/gfx/plants')
OUT = os.path.join(ROOT, 'public/plantassets')
# name -> source, variants kept (substring of the node name; None = all), split into n plants, triangles per variant, alpha key.
PLANTS = {
    'grass_medium_01': dict(keep=['small_a', 'small_b', 'mid_a', 'mid_b', 'mid_c', 'tall_a', 'tall_b', 'tall_c'], budget=900, alpha='Alpha'),
    'celandine_01': dict(budget=900, alpha='Alpha'),
    'shrub_04': dict(split=5, budget=1500, alpha='Alpha'),
    'shrub_01': dict(split=5, budget=1800, alpha='Alpha'),
}

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'silence-game-asset-download'})) as r: return r.read()

def fetch():
    for a, spec in PLANTS.items():
        d = os.path.join(CACHE, a); os.makedirs(d, exist_ok=True)
        files = json.loads(get(f'https://api.polyhaven.com/files/{a}')); info = json.loads(get(f'https://api.polyhaven.com/info/{a}'))
        g = files['gltf']['1k']['gltf']
        open(os.path.join(d, f'{a}.gltf'), 'wb').write(get(g['url']))
        for rel, inc in g.get('include', {}).items():
            os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True); open(os.path.join(d, rel), 'wb').write(get(inc['url']))
        alpha = files[spec['alpha']]['1k']['png']
        open(os.path.join(d, f"{spec['alpha']}_1k.png"), 'wb').write(get(alpha['url']))
        json.dump(files, open(os.path.join(d, 'files.json'), 'w'))
        json.dump({'authors': list(info.get('authors', {}))}, open(os.path.join(d, 'info.json'), 'w'))
        print('fetched', a)

def split_plants(bpy, bmesh, o, count):
    """Splits a mesh holding a row of plants into `count` objects at the widest gaps between its loose parts."""
    from mathutils import Vector
    bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table()
    seen, parts = set(), []
    for v in bm.verts:
        if v.index in seen: continue
        stack, part = [v], []
        seen.add(v.index)
        while stack:
            u = stack.pop(); part.append(u.index)
            for e in u.link_edges:
                w = e.other_vert(u)
                if w.index not in seen: seen.add(w.index); stack.append(w)
        xs = [bm.verts[i].co.x for i in part]; parts.append((min(xs), max(xs), part))
    parts.sort(key=lambda p: p[0])
    # Gaps along the row between the running extent of the parts so far and the next part.
    gaps, reach = [], parts[0][1]
    for i in range(1, len(parts)):
        gaps.append((parts[i][0] - reach, i)); reach = max(reach, parts[i][1])
    cuts = sorted(i for _, i in sorted(gaps, reverse=True)[:count - 1])
    groups, start = [], 0
    for c in cuts + [len(parts)]: groups.append([i for p in parts[start:c] for i in p[2]]); start = c
    bm.free()
    objects = []
    for n, group in enumerate(groups):
        keep = set(group)
        copy = o.copy(); copy.data = o.data.copy(); bpy.context.scene.collection.objects.link(copy)
        b = bmesh.new(); b.from_mesh(copy.data); b.verts.ensure_lookup_table()
        bmesh.ops.delete(b, geom=[v for v in b.verts if v.index not in keep], context='VERTS')
        b.to_mesh(copy.data); b.free(); copy.name = f'{o.name}_{chr(97 + n)}'
        objects.append(copy)
    bpy.data.objects.remove(o)
    return objects

def build(only):
    import bpy, bmesh
    from mathutils import Vector, Matrix
    credits = []
    for a, spec in PLANTS.items():
        if only and a not in only: continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=os.path.join(CACHE, a, f'{a}.gltf'))
        for o in list(bpy.context.scene.objects):
            if o.type != 'MESH': continue
            o.parent = None
            for other in bpy.context.scene.objects: other.select_set(other == o)
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        for o in list(bpy.context.scene.objects):
            if o.type != 'MESH': bpy.data.objects.remove(o)
        if spec.get('keep'):
            for o in meshes:
                if not any(k in o.name for k in spec['keep']): bpy.data.objects.remove(o)
            meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        if spec.get('split'):
            meshes = split_plants(bpy, bmesh, meshes[0], spec['split'])
            # A stray leaf or stem lying apart from the row comes out as a "plant" of its own: dropped.
            largest = max(len(o.data.polygons) for o in meshes)
            for o in [o for o in meshes if len(o.data.polygons) < largest * .05]: meshes.remove(o); bpy.data.objects.remove(o)
        for o in meshes:
            for other in bpy.context.scene.objects: other.select_set(other == o)
            bpy.context.view_layer.objects.active = o
            # Root at the origin: the middle of the lowest few millimetres of the plant, where its stems meet the ground.
            zs = [v.co.z for v in o.data.vertices]; low = min(zs)
            base = [v.co for v in o.data.vertices if v.co.z < low + .015]
            root = sum(base, Vector()) / len(base)
            o.data.transform(Matrix.Translation(Vector((-root.x, -root.y, -low)))); o.location = (0, 0, 0)
            bm = bmesh.new(); bm.from_mesh(o.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
            bm.to_mesh(o.data); bm.free()
            tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
            if tris > spec['budget']:
                m = o.modifiers.new('decimate', 'DECIMATE'); m.ratio = spec['budget'] / tris; m.use_collapse_triangulate = True
                bpy.ops.object.modifier_apply(modifier=m.name)
            m = o.modifiers.new('triangulate', 'TRIANGULATE'); bpy.ops.object.modifier_apply(modifier=m.name)
            o.name = o.name.replace('_LOD0', '')
        x = 0.
        for o in sorted(bpy.context.scene.objects, key=lambda o: o.name):
            o.location.x = x; x += max(o.dimensions.x, .2) + .2
        d = os.path.join(OUT, a); os.makedirs(d, exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=os.path.join(d, f'{a}.glb'), export_format='GLB', export_apply=True, export_yup=True, export_image_format='JPEG', export_jpeg_quality=90)
        src = os.path.join(CACHE, a, f"{spec['alpha']}_1k.png")
        open(os.path.join(d, 'alpha.png'), 'wb').write(open(src, 'rb').read())
        files = json.load(open(os.path.join(CACHE, a, 'files.json'))); info = json.load(open(os.path.join(CACHE, a, 'info.json')))
        credits.append({'asset': a, 'authors': info['authors'], 'source': f'https://polyhaven.com/a/{a}', 'license': 'CC0-1.0', 'license_url': 'https://polyhaven.com/license',
                        'files': {'model': files['gltf']['1k']['gltf']['url'], 'alpha': files[spec['alpha']]['1k']['png']['url']},
                        'variants': {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.context.scene.objects}})
        print('built', a, credits[-1]['variants'])
    path = os.path.join(OUT, 'attribution.json')
    attribution = json.load(open(path))
    built = {c['asset']: c for c in credits}
    attribution['assets'] = [built.pop(x['asset'], x) for x in attribution['assets']] + list(built.values())
    json.dump(attribution, open(path, 'w'), indent=2)

if __name__ == '__main__':
    if 'fetch' in sys.argv: fetch()
    else: build(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
