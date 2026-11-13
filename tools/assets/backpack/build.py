"""The backpack hidden in the cabin: a free model made ready for the game.

    blender --background --factory-startup --python tools/assets/backpack/build.py -- <source model> [height metres]

Imports the source (glTF/GLB, FBX or OBJ), joins it into one mesh, stands it on y = 0 centred on its footprint, scales it to
`height` (default 0.46 m, a day pack), then bakes it onto a TRIANGLES copy with fresh UVs (colour, normal, roughness, occlusion
at BAKE texels) and writes public/world/backpack.glb with WebP textures. The game places it at the cabin's `backpack` hook (objectives-runtime.ts).
The source and its licence are recorded in public/world/backpack-attribution.json by hand.
"""
import math
import os
import sys

import bpy

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
OUT = os.path.join(ROOT, "public/world/backpack.glb")
TRIANGLES = 24000
BAKE = 2048

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
source = os.path.abspath(args[0])
height = float(args[1]) if len(args) > 1 else .46

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
ext = os.path.splitext(source)[1].lower()
if ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=source)
elif ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=source)
elif ext == ".obj":
    bpy.ops.wm.obj_import(filepath=source)
else:
    raise SystemExit(f"unsupported source {source}")

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
# Parent transforms (a glTF's root node, an FBX's unit scale) go into the vertices before joining.
for o in meshes:
    if o.parent:
        mat = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mat
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
for o in list(bpy.data.objects):
    if o is not obj:
        bpy.data.objects.remove(o)

# Blender is Z up: stand it on z = 0, centred, at the wanted height.
from mathutils import Vector
corners = [Vector(c) for c in obj.bound_box]
lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
scale = height / max(hi.z - lo.z, 1e-6)
obj.location = (-(lo.x + hi.x) / 2 * scale, -(lo.y + hi.y) / 2 * scale, -lo.z * scale)
obj.scale = (scale, scale, scale)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# A scan's texture atlas is hundreds of small islands: decimating the scan itself tears its seams (dark cracks all over the
# canvas). So the scan stays as the source, and a decimated copy with fresh UVs gets its colour, normals and roughness baked
# from it at BAKE texels.
high = obj
high.name = "backpack_high"
tris = sum(len(p.vertices) - 2 for p in high.data.polygons)
bpy.ops.object.select_all(action="DESELECT")
high.select_set(True)
bpy.context.view_layer.objects.active = high
bpy.ops.object.duplicate()
low = bpy.context.view_layer.objects.active
low.name = "backpack"
# The scan arrives split along its texture seams (each island its own vertices): weld it into one surface first, or the
# decimation works island by island and the new unwrap shatters into thousands of specks.
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=.0008)
bpy.ops.object.mode_set(mode="OBJECT")
mod = low.modifiers.new("decimate", "DECIMATE")
mod.ratio = min(1.0, TRIANGLES / tris)
bpy.ops.object.modifier_apply(modifier=mod.name)
while low.data.uv_layers:
    low.data.uv_layers.remove(low.data.uv_layers[0])
low.data.uv_layers.new(name="uv")
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(70), island_margin=.003, area_weight=.6)
bpy.ops.uv.pack_islands(margin=.004, rotate=True)
bpy.ops.object.mode_set(mode="OBJECT")
low.data.materials.clear()
print("BACKPACK triangles", tris, "->", sum(len(p.vertices) - 2 for p in low.data.polygons), "size", [round((hi - lo)[i] * scale, 3) for i in range(3)])

scene = bpy.context.scene
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"
prefs.get_devices()
for d in prefs.devices:
    d.use = d.type == "METAL"
scene.cycles.device = "GPU"
scene.render.bake.use_selected_to_active = True
scene.render.bake.cage_extrusion = .025
scene.render.bake.max_ray_distance = .06
scene.render.bake.margin = 8
bake_mat = bpy.data.materials.new("bake target")
bake_mat.use_nodes = True
low.data.materials.append(bake_mat)


def bake(kind, colour, from_high=True, **extra):
    img = bpy.data.images.new(f"backpack_{kind}", BAKE, BAKE, alpha=False, float_buffer=not colour)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    node = bake_mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    bake_mat.node_tree.nodes.active = node
    bpy.ops.object.select_all(action="DESELECT")
    if from_high:
        high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.bake(type=kind, **extra)
    print("BACKPACK baked", kind)
    return img


scene.cycles.samples = 16
albedo = bake("DIFFUSE", True, pass_filter={"COLOR"})
normal = bake("NORMAL", False, normal_space="TANGENT")
rough = bake("ROUGHNESS", False)
scene.cycles.samples = 64
scene.render.bake.use_selected_to_active = False
ao_world = bpy.data.worlds.new("ao")
scene.world = ao_world
ao_world.light_settings.distance = .08
high.hide_render = True
ao = bake("AO", False, from_high=False)

# The game material: baked colour, normal, and occlusion/roughness packed as glTF's ORM.
import numpy as np
px = lambda img: np.array(img.pixels[:], np.float32).reshape(BAKE, BAKE, 4)
orm_px = np.ones((BAKE, BAKE, 4), np.float32)
orm_px[..., 0] = .35 + .65 * px(ao)[..., 0]
orm_px[..., 1] = px(rough)[..., 0]
orm_px[..., 2] = 0
orm = bpy.data.images.new("backpack_orm", BAKE, BAKE, alpha=False, float_buffer=True)
orm.colorspace_settings.name = "Non-Color"
orm.pixels.foreach_set(orm_px.ravel())
mat = bpy.data.materials.new("backpack")
mat.use_nodes = True
tree = mat.node_tree
bsdf = tree.nodes["Principled BSDF"]
t_col, t_nrm, t_orm = (tree.nodes.new("ShaderNodeTexImage") for _ in range(3))
t_col.image, t_nrm.image, t_orm.image = albedo, normal, orm
tree.links.new(t_col.outputs[0], bsdf.inputs["Base Color"])
nm = tree.nodes.new("ShaderNodeNormalMap")
tree.links.new(t_nrm.outputs[0], nm.inputs["Color"])
tree.links.new(nm.outputs[0], bsdf.inputs["Normal"])
sep = tree.nodes.new("ShaderNodeSeparateColor")
tree.links.new(t_orm.outputs[0], sep.inputs[0])
tree.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
bsdf.inputs["Metallic"].default_value = 0
gltf = tree.nodes.new("ShaderNodeGroup")
group = bpy.data.node_groups.get("glTF Material Output") or bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
if "Occlusion" not in [s.name for s in group.interface.items_tree]:
    group.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
gltf.node_tree = group
tree.links.new(sep.outputs["Red"], gltf.inputs["Occlusion"])
low.data.materials.clear()
low.data.materials.append(mat)

bpy.data.objects.remove(high)
bpy.ops.object.select_all(action="DESELECT")
low.select_set(True)
bpy.context.view_layer.objects.active = low
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_yup=True, export_image_format="WEBP",
                          export_image_quality=90, export_apply=True)
print("BACKPACK exported", OUT, round(os.path.getsize(OUT) / 1e6, 2), "MB")
