"""Fast clay previews while shaping an anatomy part.

blender --background --factory-startup --python preview.py -- <part> <voxel> <out dir>
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(__file__))
import anatomy  # noqa: E402
import sdf  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
part, voxel, out = argv[0], float(argv[1]), argv[2]
os.makedirs(out, exist_ok=True)
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj)


def to_blender(p):
    return np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=1)


def add_mesh(name, verts, quads, colour):
    mesh = bpy.data.meshes.new(name)
    v = to_blender(verts)
    mesh.vertices.add(len(v))
    mesh.vertices.foreach_set("co", v.ravel())
    mesh.loops.add(quads.size)
    mesh.loops.foreach_set("vertex_index", quads.ravel())
    mesh.polygons.add(len(quads))
    mesh.polygons.foreach_set("loop_start", np.arange(0, quads.size, 4))
    mesh.update(calc_edges=True)
    mesh.polygons.foreach_set("use_smooth", np.ones(len(quads), bool))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*colour, 1)
    bsdf.inputs["Roughness"].default_value = 0.55
    mesh.materials.append(mat)
    return obj


parts = anatomy.build_preview(part, voxel)
for name, field, colour in parts:
    verts, quads = sdf.surface_nets(field.d, field.lo, field.h)
    verts = sdf.relax(verts, quads, 1, 0.5)
    place = getattr(field, "place", None)
    if place is not None:
        verts = (place[:3, :3] @ verts.T).T + place[:3, 3]
    add_mesh(name, verts, quads, colour)
    print("PART", name, len(verts), flush=True)

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1000
scene.render.resolution_y = 1000
world = bpy.data.worlds.new("w")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.12, 0.14, 0.15, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.7
scene.world = world
key = bpy.data.objects.new("key", bpy.data.lights.new("key", "SUN"))
bpy.context.collection.objects.link(key)
key.rotation_euler = (math.radians(62), 0, math.radians(38))
key.data.energy = 3.2
key.data.angle = math.radians(8)
rim = bpy.data.objects.new("rim", bpy.data.lights.new("rim", "SUN"))
bpy.context.collection.objects.link(rim)
rim.rotation_euler = (math.radians(-65), 0, math.radians(-30))
rim.data.energy = 1.2


def shot(name, loc, target, lens):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    bpy.context.collection.objects.link(cam)
    cam.location = loc
    cam.data.lens = lens
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(out, f"{part}_{name}.png")
    bpy.ops.render.render(write_still=True)


for name, loc, target, lens in anatomy.preview_shots(part):
    shot(name, loc, target, lens)
