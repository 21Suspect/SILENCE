"""Spider-eye designs for the Listener, rendered on the built creature for comparison.

The creature's eyes were a pale emissive crescent over each black socket. These designs replace them with glossy black, unlit
eyes, more of them, as a spider has: the head, its sockets, its paint and everything else stay exactly as built. Each design is
a list of eyes in the head's own frame (anatomy.py: x to the creature's left, y up, z out of the face, metres from HEAD_CENTRE),
so the chosen one can go into head_variants.wide() as it is.

blender assets/creature-v2/silence-creature-v2.blend --background --python tools/assets/creature-v2/eye_designs.py -- <out dir> [design ...]
Designs: current (the crescents, for reference), hunter, rows, crowded. Writes <design>_<shot>.png per shot and sheet.png.
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
import anatomy as A  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "work/gfx/eyes")
CHOSEN = argv[1:] or ["current", "hunter", "rows", "crowded"]
os.makedirs(OUT, exist_ok=True)

# The Wide's sockets (head_variants.wide): centre x, y and radius of each, left then right; the right one is larger and lower.
SOCKETS = [(-0.094, 0.142, 0.056), (0.094, 0.136, 0.061)]


def socket_eye(side, scale=0.92, depth=0.125, dx=0.0, dy=0.0):
    """One big eye filling a socket: a dome whose front sits a little back from the socket's rim."""
    x, y, r = SOCKETS[side]
    return dict(kind="socket", at=(x + dx, y + dy, depth), r=r * scale, squash=0.82)


def skin_eye(x, y, r, sink=0.5, aim=(0.0, 0.0, -1.0), squash=0.85):
    """An eye set into the skin where a ray along `aim` (head frame) from in front of (x, y) meets it, sunk by `sink` of its depth."""
    return dict(kind="skin", at=(x, y), r=r, sink=sink, aim=aim, squash=squash)


DESIGNS = {
    # A jumping spider's face: two huge principal eyes filling the sockets, a smaller pair just outside them, and two tiny
    # pairs higher and further round the head, the way a jumper's back rows sit on top of its carapace.
    "hunter": [
        socket_eye(0, 0.97, 0.122), socket_eye(1, 0.97, 0.122),
        skin_eye(-0.164, 0.118, 0.024, 0.45, (0.55, 0, -1)), skin_eye(0.168, 0.11, 0.025, 0.45, (-0.55, 0, -1)),
        skin_eye(-0.112, 0.25, 0.017, 0.5, (0.25, -0.35, -1)), skin_eye(0.116, 0.246, 0.0175, 0.5, (-0.25, -0.35, -1)),
        skin_eye(-0.172, 0.222, 0.013, 0.5, (1, -0.2, -0.45)), skin_eye(0.176, 0.216, 0.0135, 0.5, (-1, -0.2, -0.45)),
    ],
    # A wolf spider's two rows: the sockets hold the large pair, a smaller pair sits close together over the nose, and four
    # small eyes run in a shallow arc across the forehead above them. Eight, symmetric, reading as a grid of black beads.
    "rows": [
        socket_eye(0, 0.8, 0.118), socket_eye(1, 0.8, 0.118),
        skin_eye(-0.027, 0.15, 0.021, 0.5), skin_eye(0.028, 0.147, 0.0215, 0.5),
        skin_eye(-0.118, 0.234, 0.018, 0.5, (0.2, -0.25, -1)), skin_eye(-0.042, 0.256, 0.019, 0.5, (0, -0.3, -1)),
        skin_eye(0.043, 0.254, 0.019, 0.5, (0, -0.3, -1)), skin_eye(0.12, 0.23, 0.018, 0.5, (-0.2, -0.25, -1)),
    ],
    # The face gone wrong: each socket crammed with a clutch of eyes of different sizes pressing against one another, a
    # different number in each, and a few more erupting from the brow and one cheek where no eye should be. Eleven in all.
    "crowded": [
        dict(kind="socket", at=(-0.104, 0.15, 0.128), r=0.033, squash=0.85), dict(kind="socket", at=(-0.07, 0.125, 0.134), r=0.022, squash=0.85),
        dict(kind="socket", at=(-0.118, 0.112, 0.136), r=0.017, squash=0.85),
        dict(kind="socket", at=(0.086, 0.148, 0.124), r=0.036, squash=0.85), dict(kind="socket", at=(0.122, 0.118, 0.13), r=0.024, squash=0.85),
        dict(kind="socket", at=(0.072, 0.106, 0.138), r=0.015, squash=0.85), dict(kind="socket", at=(0.118, 0.168, 0.136), r=0.013, squash=0.85),
        skin_eye(-0.052, 0.238, 0.021, 0.55, (0.1, -0.3, -1)), skin_eye(0.02, 0.27, 0.015, 0.55, (0, -0.35, -1)),
        skin_eye(0.072, 0.228, 0.012, 0.55, (0, -0.3, -1)), skin_eye(-0.142, 0.03, 0.016, 0.55, (0.3, 0, -1)),
    ],
}

TO_BLENDER = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def world(p):
    """Head frame to Blender world: about HEAD_CENTRE, then the sculpt's y-up, z-forward axes to Blender's z-up, -y-forward."""
    c = np.asarray(A.HEAD_CENTRE, float) + np.asarray(p, float)
    return TO_BLENDER @ Vector(c)


def direction(v):
    return (TO_BLENDER @ Vector(v)).normalized()


skin = bpy.data.objects["SILENCE v2 skin"]
old_eyes = bpy.data.objects["Eyes"]
rig = bpy.data.objects["CreatureRig"]
depsgraph = bpy.context.evaluated_depsgraph_get()
skin_eval = skin.evaluated_get(depsgraph)
to_skin = skin.matrix_world.inverted()


def seat(eye):
    """World centre, the axis the dome faces, and its radii."""
    r = eye["r"]
    if eye["kind"] == "socket":
        return world(eye["at"]), direction((0, 0, 1)), r
    x, y = eye["at"]
    aim = Vector(eye["aim"]).normalized()
    start = world((x, y, 0.0)) - direction(eye["aim"]) * 0.45
    ok, hit, normal, _ = skin_eval.ray_cast(to_skin @ start, (to_skin.to_3x3() @ direction(eye["aim"])).normalized(), distance=1.2)
    if not ok:
        raise RuntimeError(f"eye at {eye['at']} missed the skin")
    hit, normal = skin.matrix_world @ hit, (skin.matrix_world.to_3x3() @ normal).normalized()
    # Out of the skin along its own normal, leaning a little towards where the ray came from so side eyes look outward.
    facing = (normal * 0.7 - direction(aim) * 0.3).normalized()
    return hit - facing * (r * eye["squash"] * (2 * eye["sink"] - 1)), facing, r


def matte_rim():
    mat = bpy.data.materials.new("Eye rims")
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.016, 0.013, 0.012, 1)
    b.inputs["Roughness"].default_value = 0.8
    return mat


def glossy_black():
    mat = bpy.data.materials.new("Black spider eyes")
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.0035, 0.0035, 0.004, 1)
    b.inputs["Roughness"].default_value = 0.07
    b.inputs["Coat Weight"].default_value = 1.0
    b.inputs["Coat Roughness"].default_value = 0.02
    b.inputs["Emission Strength"].default_value = 0.0
    return mat


def ellipsoid(name, centre, rot, radii, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.0)
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.shade_smooth()
    obj.matrix_world = Matrix.Translation(centre) @ rot @ Matrix.Diagonal((*radii, 1))
    obj.data.materials.append(mat)
    return obj


def build(design):
    mat, rim = glossy_black(), matte_rim()
    made = []
    for i, eye in enumerate(DESIGNS[design]):
        centre, facing, r = seat(eye)
        rot = facing.to_track_quat("Z", "Y").to_matrix().to_4x4()
        made.append(ellipsoid(f"Spider eye {i}", centre, rot, (r, r, r * eye["squash"]), mat))
        if eye["kind"] == "skin":
            # A low swelling a third wider than the eye, mostly under the skin: only its dark lip shows round the lens.
            base = centre - facing * (r * eye["squash"] * 0.35)
            made.append(ellipsoid(f"Spider eye rim {i}", base, rot, (r * 1.38, r * 1.38, r * 0.55), rim))
    return made


def setup_scene():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            if any(d.type == backend for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == backend
                scene.cycles.device = "GPU"
                break
        except TypeError:
            continue
    scene.cycles.samples = 160
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 900, 1000
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world_ = bpy.data.worlds.new("Night wood")
    world_.use_nodes = True
    bg = world_.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.05, 0.065, 0.075, 1)
    bg.inputs[1].default_value = 0.35
    scene.world = world_
    return scene


def light(name, kind, loc, target, energy, **kw):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    for k, v in kw.items():
        setattr(data, k, v)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    return obj


def camera(scene, loc, target, lens):
    cam = bpy.data.objects.get("Eye camera") or bpy.data.objects.new("Eye camera", bpy.data.cameras.new("Eye camera"))
    if cam.name not in bpy.context.collection.objects:
        bpy.context.collection.objects.link(cam)
    cam.location = loc
    cam.data.lens = lens
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam


face = world((0, 0.12, 0.17))
SHOTS = {
    # Face on, close, in soft light from above and one side: the layout and sizes.
    "front": dict(cam=(0.0, -2.15, face.z + 0.04), lens=68, lights="studio"),
    # From the creature's left and a little above: how far the eyes stand out of the face, and the gloss.
    "three": dict(cam=(0.95, -1.95, face.z + 0.2), lens=70, lights="studio"),
    # As the player meets it: dark wood, the torch from the camera's hand, a few metres off.
    "torch": dict(cam=(0.35, -3.9, face.z - 0.25), lens=50, lights="torch"),
}


def render(scene, design):
    for name, s in SHOTS.items():
        for o in [o for o in bpy.data.objects if o.type == "LIGHT"]:
            bpy.data.objects.remove(o)
        if s["lights"] == "studio":
            scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.35
            light("Key", "AREA", (1.4, -2.4, face.z + 1.6), face, 260, size=1.2)
            light("Fill", "AREA", (-1.8, -2.0, face.z + 0.2), face, 40, size=2.0)
            light("Rim", "AREA", (-0.6, 0.6, face.z + 1.2), face, 120, size=0.8)
        else:
            scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.06
            torch = Vector(s["cam"]) + Vector((0.22, 0.05, -0.3))
            light("Torch", "SPOT", torch, face, 260, spot_size=math.radians(40), spot_blend=0.6, shadow_soft_size=0.02, color=(1.0, 0.94, 0.86))
        camera(scene, s["cam"], face, s["lens"])
        scene.render.filepath = os.path.join(OUT, f"{design}_{name}.png")
        bpy.ops.render.render(write_still=True)
        print("SHOT", design, name, flush=True)


def sheet(designs):
    """All shots in one image: a column per design, a row per shot."""
    tiles = [[os.path.join(OUT, f"{d}_{s}.png") for d in designs] for s in SHOTS]
    rows = []
    for row in tiles:
        imgs = []
        for path in row:
            img = bpy.data.images.load(path)
            w, h = img.size
            px = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
            imgs.append(px[::2, ::2])
            bpy.data.images.remove(img)
        rows.append(np.concatenate(imgs, axis=1))
    out = np.concatenate(rows[::-1], axis=0)
    h, w = out.shape[:2]
    img = bpy.data.images.new("sheet", w, h, alpha=True)
    img.pixels = out.ravel()
    img.filepath_raw = os.path.join(OUT, "sheet.png")
    img.file_format = "PNG"
    img.save()


scene = setup_scene()
for design in CHOSEN:
    for o in [o for o in bpy.data.objects if o.name.startswith("Spider eye")]:
        bpy.data.objects.remove(o)
    old_eyes.hide_render = design != "current"
    if design != "current":
        build(design)
    render(scene, design)
sheet(CHOSEN)
print("EYE_DESIGNS_DONE", OUT, flush=True)
