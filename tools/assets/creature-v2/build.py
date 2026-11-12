"""Production build of the SILENCE creature v2.

Sculpt fields -> decimated game mesh -> atlas -> texel-exact PBR bake -> rig -> GLB.
blender --background --factory-startup --python build.py -- [--tex 4096] [--fast]
"""
import json
import math
import os
import sys
import time

import bpy
import bmesh
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import anatomy as A  # noqa: E402
import head_variants as H  # noqa: E402
import sdf  # noqa: E402
import texturing  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FAST = "--fast" in argv
TEX = int(argv[argv.index("--tex") + 1]) if "--tex" in argv else (2048 if FAST else 4096)
OUT_GLB = os.path.join(ROOT, "public/creature/silence-creature-v2.glb")
SOURCE = os.path.join(ROOT, "assets/creature-v2")
os.makedirs(SOURCE, exist_ok=True)
Q = 2.0 if FAST else 1.0
started = time.time()


def log(*a):
    print(f"[{time.time() - started:6.1f}s]", *a, flush=True)


for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj)


def to_blender(p):
    return np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=1)


def from_blender(p):
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], axis=1)


_wide = {}


def wide_head(q):
    """The Wide: built once per quality so the teeth stay matched to the head."""
    if q not in _wide:
        _wide[q] = H.wide(0.0015 * q, 0.0008 * q)
    return _wide[q]


# --- part list -------------------------------------------------------------
def part_list():
    parts = [
        dict(name="head", make=lambda q: wide_head(q)[0], budget=18500, density=2.5, kind="head", wide=True),
        dict(name="teeth", make=lambda q: wide_head(q)[1], budget=7000, density=2.0, kind="teeth", wide=True),
        dict(name="torso", make=lambda q: A.torso_field(0.004 * q), budget=26000, density=1.15, kind="torso"),
    ]
    for s in (-1, 1):
        label = "L" if s < 0 else "R"
        parts.append(dict(name="hand_" + label, make=(lambda s: lambda q: A.hand_field(s, 0.0011 * q))(s), budget=6500, density=2.2, kind="hand", side=s))
    budgets = (1900, 1500, 1100, 550)
    names = ("femur", "tibia", "meta", "tarsus")
    for leg in A.legs():
        joints = leg["joints"]
        normal = A.unit(np.cross(joints[1] - joints[0], joints[3] - joints[0]))
        for kind in range(4):
            a, b = joints[kind], joints[kind + 1]
            length = float(np.linalg.norm(b - a))
            seed = 900 + leg["index"] * 10 + kind + (leg["side"] > 0) * 5
            place = A.bone_frame(a, b, normal, leg["pole"])

            def make(q, kind=kind, length=length, seed=seed, place=place):
                f = A.segment_field(kind, length, 0.0028 * q, seed)
                f.place = place
                return f

            parts.append(dict(name=f"{names[kind]}_{leg['label']}", make=make, budget=budgets[kind], density=1.0, kind="leg", segment=kind, leg=leg))
    return parts


# --- meshing ---------------------------------------------------------------
def new_object(name, verts, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(verts))
    mesh.vertices.foreach_set("co", verts.ravel())
    mesh.loops.add(faces.size)
    mesh.loops.foreach_set("vertex_index", faces.ravel())
    n = faces.shape[1]
    mesh.polygons.add(len(faces))
    mesh.polygons.foreach_set("loop_start", np.arange(0, faces.size, n))
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def arrays(mesh):
    v = np.empty(len(mesh.vertices) * 3, np.float64)
    mesh.vertices.foreach_get("co", v)
    return v.reshape(-1, 3)


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def decimate(obj, budget):
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    select_only(obj)
    mod = obj.modifiers.new("d", "DECIMATE")
    mod.ratio = min(1.0, budget / max(tris, 1))
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod = obj.modifiers.new("t", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=mod.name)


parts = part_list()
objects = []
for index, part in enumerate(parts):
    field = A.close_edges(part["make"](Q))
    verts, quads = sdf.surface_nets(field.d, field.lo, field.h)
    verts = sdf.relax(verts, quads, 1, 0.5)
    place = getattr(field, "place", np.eye(4))
    part["place"] = place
    world = (place[:3, :3] @ verts.T).T + place[:3, 3]
    obj = new_object(part["name"], to_blender(world), quads)
    decimate(obj, part["budget"])
    obj.data.attributes.new("part", "INT", "FACE").data.foreach_set("value", np.full(len(obj.data.polygons), index, np.int32))
    objects.append(obj)
    log("mesh", part["name"], len(obj.data.polygons))
    del field, verts, quads, world

# Spider bristles: thin dark spikes that break the silhouette, skinned rigidly.
def bristles():
    rng = np.random.default_rng(3011)
    counts = (42, 54, 44, 12)
    verts, faces, weights = [], [], {}
    names = ("femur", "tibia", "meta", "tarsus")
    for leg in A.legs():
        j = leg["joints"]
        normal = A.unit(np.cross(j[1] - j[0], j[3] - j[0]))
        for kind in range(4):
            a, b = j[kind], j[kind + 1]
            length = float(np.linalg.norm(b - a))
            place = A.bone_frame(a, b, normal, leg["pole"])
            centre, radius, _, _ = A.segment_profile(kind, length)
            name = f"{names[kind]}_{leg['label']}"
            ids = weights.setdefault(name, [])
            for _ in range(counts[kind]):
                t = rng.uniform(A.FEMUR_SPLIT / length + 0.04 if kind == 0 else 0.03, 0.98)
                i = int(t * 29)
                angle = rng.uniform(-np.pi, np.pi)
                r = radius[i] * 0.94
                base = np.array((centre[i, 0] + np.cos(angle) * r, t * length, np.sin(angle) * r * 0.74))
                out = np.array((np.cos(angle), 0.0, np.sin(angle) * 0.8))
                lean = A.unit(out + np.array((rng.normal(0, 0.25), rng.uniform(0.45, 1.25), rng.normal(0, 0.25))))
                size = rng.uniform(0.05, 0.17) * (1.15 - t * 0.5) * (0.65 if kind >= 2 else 1.0)
                side = A.unit(np.cross(lean, np.array((0.3, 0.2, 1.0))))
                side2 = np.cross(lean, side)
                width = 0.0026 * (1.0 if kind < 2 else 0.8)
                ring = [base + (side * np.cos(q) + side2 * np.sin(q)) * width - lean * 0.006 for q in (0, 2.09, 4.19)]
                tip = base + lean * size + rng.normal(0, 0.004, 3)
                n = len(verts)
                for v in (*ring, tip):
                    verts.append(place[:3, :3] @ v + place[:3, 3])
                ids.extend(range(n, n + 4))
                faces.extend([(n, n + 1, n + 3), (n + 1, n + 2, n + 3), (n + 2, n, n + 3)])
    obj = new_object("Bristles", to_blender(np.array(verts)), np.array(faces, np.int32))
    for name, ids in weights.items():
        obj.vertex_groups.new(name=name).add(ids, 1.0, "REPLACE")
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


hairs = bristles()

# Tiny white dots: their own emissive material.
# The Wide has no eyeballs: a crescent of white over each pit of black.
field = A.close_edges(wide_head(Q)[0].extras[0][0])
verts, quads = sdf.surface_nets(field.d, field.lo, field.h)
place = field.place
eyes = new_object("Eyes", to_blender((place[:3, :3] @ verts.T).T + place[:3, 3]), quads)
decimate(eyes, 1400)
del field


# --- atlas -----------------------------------------------------------------
def smart_uv(obj, density):
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh = obj.data
    uv = np.empty(len(mesh.loops) * 2, np.float64)
    mesh.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    faces = np.empty(len(mesh.loops), np.int32)
    mesh.loops.foreach_get("vertex_index", faces)
    faces = faces.reshape(-1, 3)
    v = arrays(mesh)[faces]
    area3 = np.linalg.norm(np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0]), axis=1).sum()
    t = uv.reshape(-1, 3, 2)
    a, b = t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]
    area_uv = np.abs(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]).sum()
    uv *= density * math.sqrt(area3 / max(area_uv, 1e-9))
    mesh.uv_layers.active.data.foreach_set("uv", uv.ravel())


for part, obj in zip(parts, objects):
    smart_uv(obj, part["density"])
log("uv islands done")


# --- rig -------------------------------------------------------------------
def build_bones():
    bones = []

    def add(name, a, b, parent):
        bones.append(dict(name=name, a=[float(v) for v in a], b=[float(v) for v in b], parent=parent))

    add("thorax", (0, 1.9, -0.6), (0, 1.92, 0.45), None)
    add("abd0", (0, 1.85, -0.95), (0, 1.83, -1.5), "thorax")
    add("abd1", (0, 1.83, -1.5), (0, 1.72, -2.1), "abd0")
    add("neck0", (0, 2.015, 0.33), (0, 1.795, 0.51), "thorax")
    add("neck1", (0, 1.795, 0.51), (0, 1.555, 0.63), "neck0")
    add("neck2", (0, 1.555, 0.63), (0, 1.355, 0.715), "neck1")
    add("head", (0, 1.355, 0.715), (0, 0.85, 0.85), "neck2")
    add("jaw", (0, 1.2, 0.79), (0, 0.94, 0.9), "head")
    for s in (-1, 1):
        label = "L" if s < 0 else "R"
        arm = A.ARMS[s]
        hand = A.hand_matrix(s)
        add("upperarm_" + label, arm["shoulder"], arm["elbow"], "thorax")
        add("forearm_" + label, arm["elbow"], arm["wrist"], "upperarm_" + label)
        tip = hand[:3, :3] @ np.array((0, -0.16, 0)) + hand[:3, 3]
        add("hand_" + label, arm["wrist"], tip, "forearm_" + label)
        for f, joints in enumerate(A.hand_layout(s)):
            world = [(hand[:3, :3] @ j + hand[:3, 3]) for j in joints]
            parent = "hand_" + label
            for j in range(3):
                name = f"finger_{label}{f}_{j}"
                add(name, world[j], world[j + 1], parent)
                parent = name
    names = ("femur", "tibia", "meta", "tarsus")
    for leg in A.legs():
        parent = "thorax"
        for kind in range(4):
            name = f"{names[kind]}_{leg['label']}"
            add(name, leg["joints"][kind], leg["joints"][kind + 1], parent)
            parent = name
    return bones


bones = build_bones()


def segdist(p, a, b):
    d = b - a
    t = np.clip(((p - a) @ d) / max(d @ d, 1e-9), 0, 1)
    return np.linalg.norm(p - a - d[None] * t[:, None], axis=1), t


def smooth(a, b, v):
    return sdf.smoothstep(a, b, v)


def assign(obj, weights):
    """weights: {bone name: per-vertex array}. Keeps the 4 strongest, normalised."""
    names = list(weights)
    w = np.stack([weights[n] for n in names], axis=1)
    order = np.argsort(-w, axis=1)
    cut = np.take_along_axis(w, order, axis=1)
    cut[:, 4:] = 0
    restored = np.zeros_like(w)
    np.put_along_axis(restored, order, cut, axis=1)
    restored /= np.maximum(restored.sum(axis=1, keepdims=True), 1e-9)
    for j, name in enumerate(names):
        group = obj.vertex_groups.new(name=name)
        idx = np.nonzero(restored[:, j] > 1e-3)[0]
        for i in idx:
            group.add([int(i)], float(restored[i, j]), "REPLACE")


NECK_Y = np.array((0.68, 0.44, 0.22)) + A.HEAD_CENTRE[1]


def neck_hats(y):
    n0 = smooth(1.53, 1.82, y)
    n1 = smooth(1.34, 1.6, y) * (1 - n0)
    n2 = 1 - n0 - n1
    return n0, n1, n2


for part, obj in zip(parts, objects):
    p = from_blender(arrays(obj.data))
    kind = part["kind"]
    if kind == "leg":
        assign(obj, {part["name"]: np.ones(len(p))})
    elif kind == "teeth":
        bite, _ = H.wide_mouth(p[:, 0])
        jaw = (p[:, 1] - A.HEAD_CENTRE[1] < bite).astype(float)
        assign(obj, {"head": 1 - jaw, "jaw": jaw})
    elif kind == "head":
        q = p - A.HEAD_CENTRE
        e = np.sqrt((q[:, 0] / 0.25) ** 2 + ((q[:, 1] - 0.0) / 0.46) ** 2 + (q[:, 2] / 0.25) ** 2)  # wide enough to keep the ears on the skull
        skull = smooth(1.12, 0.94, e)
        skull = np.maximum(skull, (q[:, 1] < 0.0).astype(float))
        bite, _ = H.wide_mouth(q[:, 0])
        jaw = smooth(0.05, -0.06, q[:, 1] - bite) * smooth(-0.08, 0.0, q[:, 2])
        n0, n1, n2 = neck_hats(p[:, 1])
        assign(obj, {"head": skull * (1 - jaw), "jaw": skull * jaw, "neck0": (1 - skull) * n0, "neck1": (1 - skull) * n1, "neck2": (1 - skull) * n2})
    elif kind == "hand":
        s = part["side"]
        label = "L" if s < 0 else "R"
        place = part["place"]
        local = (place[:3, :3].T @ (p - place[:3, 3]).T).T
        groups = {}
        dist = {}
        d, _ = segdist(local, np.array((0, 0.05, 0.0)), np.array((0, -0.14, 0.0)))
        dist["hand_" + label] = d - 0.05
        for f, joints in enumerate(A.hand_layout(s)):
            for j in range(3):
                d, _ = segdist(local, joints[j], joints[j + 1])
                dist[f"finger_{label}{f}_{j}"] = d
        names = list(dist)
        D = np.stack([dist[n] for n in names], axis=1)
        low = D.min(axis=1, keepdims=True)
        W = np.exp(-(D - low) * 130)
        forearm = smooth(0.02, 0.1, local[:, 1])
        assign(obj, {**{n: W[:, i] * (1 - forearm) for i, n in enumerate(names)}, "forearm_" + label: forearm * W.sum(axis=1)})
    elif kind == "torso":
        weights = {b["name"]: np.zeros(len(p)) for b in bones if b["name"] in ("thorax", "abd0", "abd1", "neck0", "neck1", "neck2")}
        z = p[:, 2]
        a1 = smooth(-1.6, -1.95, z)
        a0 = smooth(-0.92, -1.25, z) * (1 - a1)
        thor = 1 - a0 - a1
        weights["abd0"] = a0
        weights["abd1"] = a1
        weights["thorax"] = thor
        # Neck root: same falloff as the head mesh's neck sleeve.
        neck = np.zeros(len(p))
        d, _ = segdist(p, np.array((0, 2.1, 0.22)), np.array((0, 1.56, 0.63)))
        neck = smooth(0.19, 0.13, d) * smooth(0.38, 0.5, z)
        n0, n1, n2 = neck_hats(p[:, 1])
        for name, hat in (("neck0", n0), ("neck1", n1), ("neck2", n2)):
            weights[name] = neck * hat
        weights["thorax"] = weights["thorax"] * (1 - neck)
        # Each femur's first stretch is part of this skin and bends smoothly.
        names = ("femur",)
        best = np.full(len(p), 9.0)
        for leg in A.legs():
            hip, knee = leg["joints"][0], leg["joints"][1]
            direction = A.unit(knee - hip)
            y = (p - hip) @ direction
            radial = np.linalg.norm(p - hip - direction[None] * y[:, None], axis=1)
            w = smooth(-0.14, 0.2, y) * smooth(0.36, 0.26, radial)
            name = "femur_" + leg["label"]
            weights[name] = w
        fem = np.stack([weights["femur_" + l["label"]] for l in A.legs()], axis=1)
        rem = np.clip(1 - fem.sum(axis=1), 0, 1)
        for key in ("thorax", "abd0", "abd1", "neck0", "neck1", "neck2"):
            weights[key] = weights[key] * rem
        for s in (-1, 1):
            label = "L" if s < 0 else "R"
            arm = A.ARMS[s]
            upper, tu = segdist(p, arm["shoulder"], arm["elbow"])
            lower, tl = segdist(p, arm["elbow"], arm["wrist"])
            near = (p[:, 1] < 1.86) & (np.minimum(upper, lower) < 0.17) & (np.abs(p[:, 0]) > 0.14)
            on_upper = smooth(0.06, 0.2, tu) * near * (upper <= lower)
            fore = near * ((lower < upper) * 1.0)
            elbow_blend = np.exp(-((np.linalg.norm(p - arm["elbow"], axis=1) / 0.1) ** 2))
            fore_w = fore * (1 - elbow_blend * 0.5) + (upper <= lower) * near * elbow_blend * 0.5
            weights["upperarm_" + label] = on_upper * (1 - elbow_blend * 0.5) + fore * elbow_blend * 0.5
            weights["forearm_" + label] = fore_w
        arm_total = sum(weights[f"{n}_{l}"] for n in ("upperarm", "forearm") for l in "LR")
        rem = np.clip(1 - arm_total, 0, 1)
        for key in list(weights):
            if not key.startswith(("upperarm", "forearm")):
                weights[key] = weights[key] * rem
        assign(obj, weights)
    log("weights", part["name"])

# Join everything sharing the atlas and pack it.
bpy.ops.object.select_all(action="DESELECT")
for obj in objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
bpy.ops.object.join()
skin = bpy.context.object
skin.name = "SILENCE v2 skin"
select_only(skin)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.pack_islands(scale=True, rotate=True, margin_method="ADD", margin=0.0035, shape_method="CONVEX")
bpy.ops.object.mode_set(mode="OBJECT")
mesh = skin.data
mesh.validate(clean_customdata=False)
mesh.update()
log("atlas packed; triangles", len(mesh.polygons))

for poly in mesh.polygons:
    poly.use_smooth = True
mesh.update()
for poly in eyes.data.polygons:
    poly.use_smooth = True

# --- bake ------------------------------------------------------------------
face_vertices = np.empty(len(mesh.loops), np.int32)
mesh.loops.foreach_get("vertex_index", face_vertices)
face_vertices = face_vertices.reshape(-1, 3)
uv = np.empty(len(mesh.loops) * 2, np.float64)
mesh.uv_layers.active.data.foreach_get("uv", uv)
uv = uv.reshape(-1, 3, 2)
normals = np.empty(len(mesh.loops) * 3, np.float64)
mesh.corner_normals.foreach_get("vector", normals)
normals = from_blender(normals.reshape(-1, 3)).reshape(-1, 3, 3)
positions = from_blender(arrays(mesh))[face_vertices]
part_ids = np.empty(len(mesh.polygons), np.int32)
mesh.attributes["part"].data.foreach_get("value", part_ids)
coverage = 0.0
a, b = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
log("atlas coverage", float(np.abs(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]).sum() * 0.5))

colour = np.zeros((TEX, TEX, 3), np.float32)
normal_map = np.zeros((TEX, TEX, 3), np.float32)
normal_map[..., 2] = 1
rough = np.full((TEX, TEX), 0.8, np.float32)
written = np.zeros((TEX, TEX), bool)

for index, part in enumerate(parts):
    tris = np.nonzero(part_ids == index)[0]
    field = part["make"](Q)
    place = part["place"]
    p_local = ((place[:3, :3].T @ (positions[tris].reshape(-1, 3) - place[:3, 3]).T).T).reshape(-1, 3, 3)
    n_local = ((place[:3, :3].T @ normals[tris].reshape(-1, 3).T).T).reshape(-1, 3, 3)
    texturing.bake_part(part, field, uv[tris], p_local, n_local, TEX, colour, normal_map, rough, written)
    log("baked", part["name"], int(written.sum()))
    del field

log("dilating")
colour, normal_map, rough = texturing.dilate(colour, normal_map, rough, written, 24)


def image(name, rgb, srgb):
    img = bpy.data.images.new(name, TEX, TEX, alpha=False, float_buffer=False)
    if not srgb:
        img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((TEX, TEX, 4), np.float32)
    rgba[..., :3] = rgb
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    img.filepath_raw = os.path.join(SOURCE, name + ".png")
    img.file_format = "PNG"
    img.save()
    img.pack()
    return img


albedo_img = image("skin-color", texturing.linear_to_srgb(colour), True)
normal_img = image("skin-normal", normal_map, False)
rough_rgb = np.zeros((TEX, TEX, 3), np.float32)
rough_rgb[..., 1] = rough
rough_img = image("skin-rough", rough_rgb, False)
log("textures saved")

# --- materials -------------------------------------------------------------
mat = bpy.data.materials.new("Skin v2")
mat.use_nodes = True
nodes, links = mat.node_tree.nodes, mat.node_tree.links
bsdf = nodes["Principled BSDF"]
a = nodes.new("ShaderNodeTexImage")
a.image = albedo_img
links.new(a.outputs["Color"], bsdf.inputs["Base Color"])
n = nodes.new("ShaderNodeTexImage")
n.image = normal_img
nm = nodes.new("ShaderNodeNormalMap")
links.new(n.outputs["Color"], nm.inputs["Color"])
links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
r = nodes.new("ShaderNodeTexImage")
r.image = rough_img
sep = nodes.new("ShaderNodeSeparateColor")
links.new(r.outputs["Color"], sep.inputs["Color"])
links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
bsdf.inputs["Metallic"].default_value = 0.0
mesh.materials.clear()
mesh.materials.append(mat)

eye_mat = bpy.data.materials.new("Dead white eyes")
eye_mat.use_nodes = True
e = eye_mat.node_tree.nodes["Principled BSDF"]
e.inputs["Base Color"].default_value = (1, 1, 1, 1)
e.inputs["Emission Color"].default_value = (1, 1, 1, 1)
e.inputs["Emission Strength"].default_value = 4.0
eyes.data.materials.append(eye_mat)

# --- armature --------------------------------------------------------------
arm_data = bpy.data.armatures.new("SILENCE v2 anatomy")
rig = bpy.data.objects.new("CreatureRig", arm_data)
bpy.context.collection.objects.link(rig)
select_only(rig)
bpy.ops.object.mode_set(mode="EDIT")
for b in bones:
    edit = arm_data.edit_bones.new(b["name"])
    edit.head = to_blender(np.array([b["a"]]))[0]
    edit.tail = to_blender(np.array([b["b"]]))[0]
for b in bones:
    if b["parent"]:
        arm_data.edit_bones[b["name"]].parent = arm_data.edit_bones[b["parent"]]
bpy.ops.object.mode_set(mode="OBJECT")
for obj in (skin, eyes):
    obj.parent = rig
    obj.modifiers.new("Skeleton", "ARMATURE").object = rig
hair_mat = bpy.data.materials.new("Bristles")
hair_mat.use_nodes = True
h = hair_mat.node_tree.nodes["Principled BSDF"]
h.inputs["Base Color"].default_value = (0.012, 0.011, 0.011, 1)
h.inputs["Roughness"].default_value = 0.62
hairs.data.materials.append(hair_mat)
hairs.parent = rig
hairs.modifiers.new("Skeleton", "ARMATURE").object = rig
g = eyes.vertex_groups.new(name="head")
g.add(list(range(len(eyes.data.vertices))), 1.0, "REPLACE")

# Sanity: every skin vertex must be weighted.
groups = np.array([len(v.groups) for v in skin.data.vertices])
log("unweighted vertices", int((groups == 0).sum()))

bpy.ops.object.select_all(action="DESELECT")
for obj in (rig, skin, eyes, hairs):
    obj.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format="GLB", use_selection=True, export_apply=False, export_animations=False,
    export_yup=True, export_normals=True, export_texcoords=True, export_materials="EXPORT",
    export_image_format="WEBP", export_image_quality=90,
)
log("exported", os.path.getsize(OUT_GLB) / 1e6, "MB")

hand_frames = {("L" if s < 0 else "R"): [[float(v) for v in A.hand_matrix(s)[:3, i]] for i in range(4)] for s in (-1, 1)}
layout = dict(
    hands=hand_frames,
    segments=[float(v) for v in A.SEGMENT_LENGTHS],
    legBend=float(A.LEG_BEND),
    legs=[dict(label=l["label"], side=int(l["side"]), index=int(l["index"]), hip=[float(v) for v in l["hip"]], foot=[float(v) for v in l["foot"]], pole=[float(v) for v in l["pole"]], joints=[[float(c) for c in j] for j in l["joints"]]) for l in A.legs()],
    bones=bones,
    triangles=len(mesh.polygons),
)
with open(os.path.join(SOURCE, "rig.json"), "w") as f:
    json.dump(layout, f, indent=1)
with open(os.path.join(ROOT, "game/data/spider-rig.json"), "w") as f:
    json.dump(layout, f)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SOURCE, "silence-creature-v2.blend"), compress=True)
log("CREATURE_V2_COMPLETE", len(mesh.polygons), "triangles", len(bones), "bones")
