"""Bake CC0 Poly Haven cliff scans into flat rock-face maps for the mountains' surface (game/render/world/mountain-surface.ts).

  blender --background --factory-startup --python tools/assets/mountain/bake_faces.py -- <scans dir> <out dir> [size]

<scans dir> holds each scan as Poly Haven's 2K glTF download (<name>/<name>.gltf with its textures). Each is turned so its mean
face points straight at an orthographic camera and rendered three times (Cycles, emission only, so no light of Blender's own
gets in): its albedo (diffuse x ambient occlusion), its normal (the scan's normal map on its geometry, in the face's frame) and
its height. pack_faces.py then makes them tile and packs them like the other mountain layers.

Why: a photograph of fractured rock reads as fractured rock at any scale (rock is self-similar), so these real faces, laid at
several sizes, give the mountains the broken, weathered surface no noise drew. The scans' own textures are UV atlases and do
not tile; their rendered faces do, after pack_faces.py.
"""
import bpy, sys, os, math
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
SCANS, OUT = argv[0], argv[1]
SIZE = int(argv[2]) if len(argv) > 2 else 2048
NAMES = ['mountainside', 'rock_face_01', 'rock_face_02', 'namaqualand_cliff_01', 'namaqualand_cliff_02']
os.makedirs(OUT, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.samples = 8
    s.cycles.use_denoising = False
    s.render.resolution_x = s.render.resolution_y = SIZE
    s.render.film_transparent = True
    s.render.image_settings.file_format = 'PNG'
    s.render.image_settings.color_mode = 'RGBA'
    s.render.image_settings.color_depth = '16'
    s.world = bpy.data.worlds.new('none')
    s.world.color = (0, 0, 0)
    return s


def mean_normal(obj):
    m = obj.data
    n = Vector((0, 0, 0))
    for p in m.polygons:
        n += p.normal * p.area
    return n.normalized()


def emission_material(name, build):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for node in list(nt.nodes):
        nt.nodes.remove(node)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    build(nt, em)
    return mat


for name in NAMES:
    scene = reset()
    bpy.ops.import_scene.gltf(filepath=os.path.join(SCANS, name, f'{name}.gltf'))
    meshes = [o for o in scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    src = obj.active_material
    tex = {n.image.name: n.image for n in src.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image}
    def find(key):
        for k, im in tex.items():
            if key in k:
                return im
        return None
    diff, nor, arm = find('diff'), find('nor_gl'), find('arm')
    # Turn the face to look up (+Z), the camera looking down at it.
    q = mean_normal(obj).rotation_difference(Vector((0, 0, 1)))
    obj.matrix_world = q.to_matrix().to_4x4() @ obj.matrix_world
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    xs = [v.co.x for v in obj.data.vertices]; ys = [v.co.y for v in obj.data.vertices]; zs = [v.co.z for v in obj.data.vertices]
    # The middle 70% of the shorter side: the scans' edges are ragged.
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = min(max(xs) - min(xs), max(ys) - min(ys)) * .7
    cam_data = bpy.data.cameras.new('cam'); cam_data.type = 'ORTHO'; cam_data.ortho_scale = span
    cam_data.clip_start = .01; cam_data.clip_end = 1000
    cam = bpy.data.objects.new('cam', cam_data); scene.collection.objects.link(cam)
    cam.location = (cx, cy, max(zs) + 10); cam.rotation_euler = (0, 0, 0)
    scene.camera = cam
    z0, z1 = min(zs), max(zs)
    # Height: measured only inside the camera's square, so its range is the visible part's.
    inside = [v.co.z for v in obj.data.vertices if abs(v.co.x - cx) < span / 2 and abs(v.co.y - cy) < span / 2]
    z0, z1 = min(inside), max(inside)

    def albedo(nt, em):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = diff
        if arm:
            a = nt.nodes.new('ShaderNodeTexImage'); a.image = arm; a.image.colorspace_settings.name = 'Non-Color'
            sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(a.outputs[0], sep.inputs[0])
            pw = nt.nodes.new('ShaderNodeMath'); pw.operation = 'POWER'; pw.inputs[1].default_value = .6; nt.links.new(sep.outputs[0], pw.inputs[0])
            mul = nt.nodes.new('ShaderNodeMixRGB'); mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1
            nt.links.new(t.outputs[0], mul.inputs[1]); nt.links.new(pw.outputs[0], mul.inputs[2]); nt.links.new(mul.outputs[0], em.inputs[0])
        else:
            nt.links.new(t.outputs[0], em.inputs[0])

    def normal(nt, em):
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = nor; t.image.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(t.outputs[0], nm.inputs[1])
        sc = nt.nodes.new('ShaderNodeVectorMath'); sc.operation = 'MULTIPLY_ADD'
        sc.inputs[1].default_value = (.5, .5, .5); sc.inputs[2].default_value = (.5, .5, .5)
        nt.links.new(nm.outputs[0], sc.inputs[0]); nt.links.new(sc.outputs[0], em.inputs[0])

    def height(nt, em):
        g = nt.nodes.new('ShaderNodeNewGeometry')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(g.outputs['Position'], sep.inputs[0])
        mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs[1].default_value = z0; mr.inputs[2].default_value = z1
        nt.links.new(sep.outputs[2], mr.inputs[0]); nt.links.new(mr.outputs[0], em.inputs[0])

    def roughness(nt, em):
        if arm:
            a = nt.nodes.new('ShaderNodeTexImage'); a.image = arm; a.image.colorspace_settings.name = 'Non-Color'
            sep = nt.nodes.new('ShaderNodeSeparateColor'); nt.links.new(a.outputs[0], sep.inputs[0]); nt.links.new(sep.outputs[1], em.inputs[0])
        else:
            em.inputs[0].default_value = (.85, .85, .85, 1)

    for pass_name, build, view in [('albedo', albedo, 'Standard'), ('normal', normal, 'Raw'), ('height', height, 'Raw'), ('rough', roughness, 'Raw')]:
        scene.view_settings.view_transform = view
        obj.data.materials.clear(); obj.data.materials.append(emission_material(pass_name, build))
        scene.render.filepath = os.path.join(OUT, f'{name}-{pass_name}.png')
        bpy.ops.render.render(write_still=True)
    with open(os.path.join(OUT, f'{name}.txt'), 'w') as f:
        f.write(f'{span} {z1 - z0}\n')
    print('BAKED', name, 'width', round(span, 2), 'm, relief', round(z1 - z0, 2), 'm')
