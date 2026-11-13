"""Inventory icons, rendered from the items' own models: a three-quarter view on a transparent background, softly lit.

    blender --background --factory-startup --python tools/assets/ui/item-icons.py -- [name ...]

Writes public/ui/items/<name>.png (256 x 256), used by game/ui/inventory.ts through objectives-runtime.ts (ITEM_ICON).
"""
import math
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
OUT = os.path.join(ROOT, "public/ui/items")
ITEMS = {"fuse": "public/world/fuse.glb", "jerry": "public/world/jerrycan.glb", "backpack": "public/world/backpack.glb"}


def render(name, path):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, path))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    centre, size = (lo + hi) / 2, max((hi - lo).length, 1e-3)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("icon")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (.5, .52, .55, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = .6
    scene.world = world
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = size * 1.02
    direction = Vector((math.cos(math.radians(-35)), math.sin(math.radians(-35)), .62)).normalized()
    cam.location = centre + direction * size * 3
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    for energy, angle, rot in ((3.2, 8, (50, 10, -30)), (1.2, 20, (70, 0, 140))):
        sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
        sun.data.energy, sun.data.angle = energy, math.radians(angle)
        sun.rotation_euler = tuple(math.radians(v) for v in rot)
        scene.collection.objects.link(sun)
    scene.render.filepath = os.path.join(OUT, f"{name}.png")
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    bpy.ops.render.render(write_still=True)
    print("ICON", name, scene.render.filepath)


argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
os.makedirs(OUT, exist_ok=True)
for name in argv or list(ITEMS):
    if os.path.exists(os.path.join(ROOT, ITEMS[name])):
        render(name, ITEMS[name])
    else:
        print("ICON skipped (no model yet)", name)
