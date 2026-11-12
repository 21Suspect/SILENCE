"""
Nature scatter for SILENCE: CC0 photogrammetry from Poly Haven's pine forest collection, cut down for instancing.

  python3 tools/assets/nature/build.py fetch          # downloads the 1K glTFs into work/gfx/ph/models (git-ignored)
  blender --background --factory-startup --python tools/assets/nature/build.py   # builds public/world/nature/*.glb
  blender ... --python tools/assets/nature/build.py -- pebbles_01 pebbles_02        # builds only the named outputs

Each set is split into its pieces (one variant per piece), every variant is put on the ground at the origin (lowest point at
y = 0, centred), decimated to a budget that suits how close and how often it is seen, and exported as one GLB per asset with
the scans' own 1K textures (colour, normal, AO/roughness). Attribution: public/world/nature/attribution.json.
"""
import json, os, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
CACHE = os.path.join(ROOT, 'work/gfx/ph/models')
OUT = os.path.join(ROOT, 'public/world/nature')
# Asset -> triangles per variant.
BUDGET = {
    'rock_moss_set_02': 900,                             # grey boulders and stones (set 01 is an ochre sandstone: unused)
    'dry_branches_medium_01': 700,                       # fallen branches
    'tree_stump_01': 2400, 'tree_stump_02': 2400,
    'dead_tree_trunk': 3000,                             # fallen trunk
}
# Cheap cuts of the same scans: output -> (source asset, triangles per variant). Exported without textures; the game gives
# them the source set's material (the UVs are kept), so a dense layer of pebbles costs geometry only.
CUTS = {'pebbles_02': ('rock_moss_set_02', 70)}

def fetch():
    agent = {'User-Agent': 'silence-game-asset-download'}
    def get(url):
        with urllib.request.urlopen(urllib.request.Request(url, headers=agent)) as r: return r.read()
    for a in BUDGET:
        files = json.loads(get(f'https://api.polyhaven.com/files/{a}'))['gltf']['1k']['gltf']
        info = json.loads(get(f'https://api.polyhaven.com/info/{a}'))
        d = os.path.join(CACHE, a); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, f'{a}.gltf'), 'wb').write(get(files['url']))
        for rel, inc in files.get('include', {}).items():
            os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
            open(os.path.join(d, rel), 'wb').write(get(inc['url']))
        json.dump({'asset': a, 'authors': list(info.get('authors', {})), 'license': 'CC0-1.0', 'source': f'https://polyhaven.com/a/{a}', 'files': files}, open(os.path.join(d, 'source.json'), 'w'), indent=1)
        print('fetched', a)

def build():
    import bpy, bmesh
    from mathutils import Vector
    os.makedirs(OUT, exist_ok=True)
    credits = []
    jobs = [(a, a, budget) for a, budget in BUDGET.items()] + [(out, a, budget) for out, (a, budget) in CUTS.items()]
    only = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if only: jobs = [j for j in jobs if j[0] in only]
    for out, a, budget in jobs:
        cut = out != a
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=os.path.join(CACHE, a, f'{a}.gltf'))
        meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
        for o in list(bpy.context.scene.objects):
            if o.type != 'MESH': continue
            bpy.context.view_layer.objects.active = o
            for other in bpy.context.scene.objects: other.select_set(other == o)
            # Bake the import transform in, then sit the piece on the ground at the origin.
            o.parent = None
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
            lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
            hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
            shift = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
            o.data.transform(__import__('mathutils').Matrix.Translation(-shift)); o.location = (0, 0, 0)
            # glTF import splits a vertex wherever a UV seam runs through it. Collapsing such a mesh moves the two halves of a
            # seam apart and tears holes and loose flaps into it, so the halves are welded first (the UVs live on the
            # face corners and survive). The scan's custom normals do not survive a collapse either: smooth shading it is,
            # the normal map carries the detail.
            bm = bmesh.new(); bm.from_mesh(o.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5 * max(o.dimensions))
            bm.to_mesh(o.data); bm.free()
            if o.data.has_custom_normals: bpy.ops.mesh.customdata_custom_splitnormals_clear()
            bpy.ops.object.shade_smooth()
            tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
            if budget and tris > budget:
                m = o.modifiers.new('decimate', 'DECIMATE'); m.ratio = budget / tris; m.use_collapse_triangulate = True
                bpy.ops.object.modifier_apply(modifier=m.name)
            m = o.modifiers.new('triangulate', 'TRIANGULATE'); bpy.ops.object.modifier_apply(modifier=m.name)
            o.name = o.name.replace('_LOD0', '')
        for o in list(bpy.context.scene.objects):
            if o.type != 'MESH': bpy.data.objects.remove(o)
        # Space the variants out along x so the GLB opens readably in a viewer; the game reads each mesh at its own origin.
        x = 0.
        for o in sorted([o for o in bpy.context.scene.objects], key=lambda o: o.name):
            o.location.x = x; x += max(o.dimensions.x, .2) + .3
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'{out}.glb'), export_format='GLB', export_apply=True, export_yup=True, export_image_format='JPEG', export_jpeg_quality=90,
                                  **({'export_materials': 'NONE'} if cut else {}))
        if cut:
            print('built', out, 'from', a, [(o.name, sum(len(p.vertices) - 2 for p in o.data.polygons)) for o in bpy.context.scene.objects]); continue
        src = json.load(open(os.path.join(CACHE, a, 'source.json')))
        credits.append({'asset': a, 'authors': src['authors'], 'license': 'CC0-1.0', 'license_url': 'https://polyhaven.com/license', 'source': src['source'],
                        'variants': sorted(o.name for o in bpy.context.scene.objects), 'triangles_per_variant': budget or 'as published'})
        print('built', a, [(o.name, sum(len(p.vertices) - 2 for p in o.data.polygons)) for o in bpy.context.scene.objects])
    if only: return
    json.dump({'provider': 'Poly Haven', 'license': 'CC0-1.0', 'license_url': 'https://polyhaven.com/license', 'built_by': 'tools/assets/nature/build.py', 'assets': credits}, open(os.path.join(OUT, 'attribution.json'), 'w'), indent=1)

if __name__ == '__main__':
    if 'fetch' in sys.argv: fetch()
    else: build()
