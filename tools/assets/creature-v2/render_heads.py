"""Render head concepts in moody, tagged clay.

blender --background --factory-startup --python render_heads.py -- <out dir> <voxel> [concept ...]
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(__file__))
import anatomy as A  # noqa: E402
import head_variants as H  # noqa: E402
import sdf  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
out, voxel = argv[0], float(argv[1])
chosen = argv[2:] or list(H.CONCEPTS)
os.makedirs(out, exist_ok=True)


def to_blender(p):
    return np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=1)


def add(name, field, colour_fn, emission=None):
    A.close_edges(field)
    verts, quads = sdf.surface_nets(field.d, field.lo, field.h)
    verts = sdf.relax(verts, quads, 1, 0.5)
    colours = colour_fn(field, verts) if colour_fn else None
    world = verts + field.place[:3, 3]
    mesh = bpy.data.meshes.new(name)
    v = to_blender(world)
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
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.46
    if colours is not None:
        attr = mesh.color_attributes.new("c", "FLOAT_COLOR", "POINT")
        rgba = np.ones((len(colours), 4), np.float32)
        rgba[:, :3] = colours
        attr.data.foreach_set("color", rgba.ravel())
        node = nodes.new("ShaderNodeVertexColor")
        node.layer_name = "c"
        links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    if emission:
        bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
        bsdf.inputs["Emission Color"].default_value = (1, 1, 1, 1)
        bsdf.inputs["Emission Strength"].default_value = emission
    mesh.materials.append(mat)
    return obj


PALE = np.array((0.5, 0.47, 0.39))


def skin_colour(field, verts):
    mouth = field.sample(field.tags["mouth"], verts)
    socket = field.sample(field.tags["socket"], verts)
    bone = field.sample(field.tags["bone"], verts)
    normal = field.gradient(field.d, verts, field.h * 1.5)
    ao = np.zeros(len(verts), np.float32)
    weight = 0.0
    for d in (0.006, 0.016, 0.04):
        ao += np.clip(field.sample(field.d, verts + normal * d) / d, 0, 1) / d
        weight += 1 / d
    ao /= weight
    c = np.tile(PALE, (len(verts), 1)).astype(np.float32)
    mottling = sdf.fbm(verts[:, 0] * 9, verts[:, 1] * 9, verts[:, 2] * 9, 4) * 1.4 + 0.5
    c *= (0.72 + 0.42 * mottling)[:, None]
    c = c * (1 - sdf.smoothstep(0.012, 0.0, bone)[:, None] * 0.0) + sdf.smoothstep(0.012, 0.0, bone)[:, None] * c * 0.18
    gum = np.array((0.11, 0.022, 0.02))
    in_mouth = sdf.smoothstep(0.01, -0.004, mouth)[:, None]
    deep = sdf.smoothstep(0.17, 0.08, verts[:, 2])[:, None]
    c = c * (1 - in_mouth) + in_mouth * (gum * (1 - deep) + np.array((0.012, 0.003, 0.003)) * deep)
    if "gum" in field.tags:
        in_gum = sdf.smoothstep(0.006, -0.002, field.sample(field.tags["gum"], verts))[:, None]
        c = c * (1 - in_gum) + in_gum * np.array((0.07, 0.016, 0.016))
    in_socket = sdf.smoothstep(0.012, -0.002, socket)[:, None]
    c = c * (1 - in_socket) + in_socket * 0.002
    c *= (0.32 + 0.68 * ao)[:, None]
    return c


def tooth_colour(field, verts):
    return np.tile(np.array((0.62, 0.54, 0.36)), (len(verts), 1)).astype(np.float32) * (0.82 + 0.3 * (sdf.fbm(verts[:, 0] * 90, verts[:, 1] * 22, verts[:, 2] * 90, 3)[:, None] + 0.5))


def shot(scene, name, loc, target, lens):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    bpy.context.collection.objects.link(cam)
    cam.location = loc
    cam.data.lens = lens
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(out, name + ".png")
    bpy.ops.render.render(write_still=True)


for concept in chosen:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    head, teeth, eyes = H.CONCEPTS[concept](voxel, min(voxel * 0.45, 0.0011))
    add("head", head, skin_colour)
    if teeth is not None:
        add("teeth", teeth, tooth_colour)
    if eyes:
        lo = np.min([np.array(p) - r * 2 for p, r in eyes], axis=0) - 0.01
        hi = np.max([np.array(p) + r * 2 for p, r in eyes], axis=0) + 0.01
        dots = sdf.Field(lo, hi, 0.0009, ())
        for p, r in eyes:
            dots.add_ellipsoid(p, (r, r, r), 0.0005)
        dots.place = A.translate(A.HEAD_CENTRE)
        add("eyes", dots, None, 6.0)
    for i, (extra, glow) in enumerate(getattr(head, "extras", [])):
        add(f"extra{i}", extra, None, glow)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1000
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.05, 0.07, 0.08, 1)
    bg.inputs[1].default_value = 0.42
    scene.world = world
    key = bpy.data.objects.new("key", bpy.data.lights.new("key", "SUN"))
    bpy.context.collection.objects.link(key)
    key.rotation_euler = (math.radians(62), 0, math.radians(-42))
    key.data.energy = 3.4
    key.data.angle = math.radians(14)
    fill = bpy.data.objects.new("fill", bpy.data.lights.new("fill", "SUN"))
    bpy.context.collection.objects.link(fill)
    fill.rotation_euler = (math.radians(75), 0, math.radians(55))
    fill.data.energy = 0.3
    # Viewed from about a person's eye height, as a player would see it.
    shot(scene, f"{concept}_front", (0.0, -2.75, 1.48), (0, -0.8, 1.16), 78)
    shot(scene, f"{concept}_three", (1.25, -2.42, 1.4), (0, -0.8, 1.16), 78)
    print("CONCEPT", concept, flush=True)
