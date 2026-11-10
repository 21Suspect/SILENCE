"""Independent review of what was actually exported: reads the GLBs, not the authoring code.

blender --background --factory-startup --python review.py -- [asset ...]
Writes assets/world-v2/review/<asset>.jpg (six-view sheet, game eye height) and <asset>.json
(audit: parts, floating parts, ground contact, triangles, file size).
"""
import json
import math
import os
import subprocess
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
OUT = os.path.join(ROOT, "assets/world-v2/review")
GLB = os.path.join(ROOT, "public/world")
os.makedirs(OUT, exist_ok=True)
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
COMPANIONS = {"mine": ["minerock"], "tunnel": ["tunnelrock"]}
FRONT_ONLY = {"mine": 15.0, "tunnel": 22.0}
FRAME = {"hut": 11.0, "fuse": .55, "stump_axe": 1.25, "cans": .6, "shovel": 1.0}
# Game coordinates (x, y up, z). BODY: frame the views on this box instead of the whole bounds (a hut with 13 m of cable
# is still a hut). CLOSE: where the sixth, close view stands and what it looks at.
BODY = {"hut": ((0, 0, .3), 3.4, 3.2), "pole": ((0, 0, 0), 1.3, 10.0), "mast": ((0, 0, 0), 4.5, 37)}
CLOSE = {"tunnel": ((1.5, 1.65, 13.0), (0, 2.6, 0)), "pumphouse": ((.55, 1.6, 3.6), (.45, 1.2, -.6)), "hut": ((1.3, 1.6, 6.4), (-.2, 1.35, 1.7)), "cabin": ((2.2, 1.65, 7.4), (.9, 1.5, 2.5)), "chapel": ((6.5, 1.65, 7.5), (2.5, 1.9, 2.0)),
         "lookout": ((5.5, 1.65, 6.5), (0, 2.2, 0)), "mast": ((6, 1.65, 7), (0, 2.5, 0)), "pole": ((1.8, 1.65, 2.6), (0, 1.5, 0)),
         "logstack": ((-1.5, 1.65, 12.5), (-3.5, 1.4, 6.5)), "camp": ((1.5, 1.6, 4.2), (-.5, .5, -.4)), "roadbridge": ((-17, -1.2, 14), (-6, -2.2, 0))}
names = argv or sorted(f[:-4] for f in os.listdir(GLB) if f.endswith(".glb") and f[:-4] not in ("minerock", "tunnelrock"))
CONTACT = .02   # metres: closer than this counts as touching


def setup():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    p = bpy.context.preferences.addons["cycles"].preferences
    p.compute_device_type = "METAL"
    p.get_devices()
    for d in p.devices:
        d.use = d.type == "METAL"
    scene.cycles.device = "GPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 4
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.resolution_x, scene.render.resolution_y = 900, 620
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 88
    w = bpy.data.worlds.new("sky")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (.5, .57, .62, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = .75
    scene.world = w


def loose_parts(obj):
    """Exported vertices are split by UV and normal: merge by position first."""
    me = obj.data
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = (np.array(obj.matrix_world.to_3x3()) @ co.reshape(-1, 3).T).T + np.array(obj.matrix_world.translation)
    keys = np.round(co / 1e-4).astype(np.int64)
    _, uid = np.unique(keys, axis=0, return_inverse=True)
    uid = uid.ravel()
    parent = np.arange(uid.max() + 1)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    tris = np.empty(len(me.loop_triangles) * 3, int)
    me.loop_triangles.foreach_get("vertices", tris)
    tris = tris.reshape(-1, 3)
    for a, b, c in uid[tris]:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra
        parent[rc] = ra
    root = np.array([find(i) for i in range(len(parent))])
    part_of_vertex = root[uid]
    _, part_ids = np.unique(part_of_vertex, return_inverse=True)
    part_ids = part_ids.ravel()
    parts = []
    tri_part = part_ids[tris[:, 0]]
    order = np.argsort(tri_part)
    bounds = np.flatnonzero(np.diff(tri_part[order])) + 1
    for group in np.split(order, bounds):
        t = tris[group]
        used, inverse = np.unique(t, return_inverse=True)
        v = co[used]
        parts.append(dict(v=v, t=inverse.reshape(-1, 3), lo=v.min(0), hi=v.max(0)))
    return parts


def audit(obj):
    parts = loose_parts(obj)
    n = len(parts)
    lo = np.array([p["lo"] for p in parts])
    hi = np.array([p["hi"] for p in parts])
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    trees = {}

    def tree(i):
        if i not in trees:
            trees[i] = BVHTree.FromPolygons([tuple(v) for v in parts[i]["v"]], [tuple(int(x) for x in t) for t in parts[i]["t"]], all_triangles=True)
        return trees[i]
    for i in range(n):
        touching = np.all(lo[i] - CONTACT <= hi, axis=1) & np.all(hi[i] + CONTACT >= lo, axis=1)
        touching[:i + 1] = False
        for j in np.flatnonzero(touching):
            if find(i) == find(int(j)):
                continue
            joined = bool(tree(i).overlap(tree(int(j))))
            if not joined:
                # Both ways round: a small part in the middle of a long plain one is near none of the long one's corners.
                for a, b in ((i, int(j)), (int(j), i)):
                    t = tree(b)
                    samples = np.concatenate([parts[a]["v"], parts[a]["v"][parts[a]["t"]].mean(axis=1)])
                    for v in samples:
                        hit = t.find_nearest(tuple(v))
                        if hit[3] is not None and hit[3] <= CONTACT:
                            joined = True
                            break
                    if joined:
                        break
            if joined:
                parent[find(int(j))] = find(i)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    # In Blender coordinates z is up; report in game coordinates (x, y up, -blender y).
    floaters = []
    grounded = 0
    for members in groups.values():
        bottom = float(lo[members][:, 2].min())
        if bottom <= .06:
            grounded += 1
            continue
        a, b = lo[members].min(0), hi[members].max(0)
        floaters.append(dict(parts=len(members), centre=[round(float((a[0] + b[0]) / 2), 2), round(float((a[2] + b[2]) / 2), 2), round(float(-(a[1] + b[1]) / 2), 2)], size=[round(float(v), 2) for v in (b - a)], lowest=round(bottom, 2)))
    floaters.sort(key=lambda f: -max(f["size"]))
    return dict(looseParts=n, connectedGroups=len(groups), groupsOnGround=grounded, floatingGroups=len(floaters), floating=floaters[:12])


def render(obj, name):
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector([min(c[i] for c in corners) for i in range(3)])
    hi = Vector([max(c[i] for c in corners) for i in range(3)])
    size = hi - lo
    centre = (lo + hi) / 2
    R = max(size.x, size.y) / 2
    H = size.z
    if name in BODY:
        c, R, H = BODY[name]
        centre = Vector((c[0], -c[2], c[1] + H / 2))
    bpy.ops.mesh.primitive_plane_add(size=max(400, R * 12), location=(0, 0, -.005))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("ground")
    gm.use_nodes = True
    bs = gm.node_tree.nodes["Principled BSDF"]
    bs.inputs["Base Color"].default_value = (.07, .075, .045, 1)
    bs.inputs["Roughness"].default_value = 1
    ground.data.materials.append(gm)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(55), 0, math.radians(32))
    sun.data.energy = 2.6
    sun.data.angle = math.radians(10)
    scene = bpy.context.scene
    eye = 1.65 if H > 1.2 else max(.5, H * 1.5)
    target_z = H * .46 if H > 3.2 else min(H * .5, 1.6)
    dist = FRAME.get(name) or max(R * 2.5, H * 1.45, .3)
    frames = []
    views = [(40, eye), (130, eye), (220, eye), (310, eye), (70, max(eye, R * 1.4 + H * .9)), (20, eye)]
    if name in FRONT_ONLY:
        # Set into a hillside: every view is from the open side.
        centre = Vector((0, -2, 0))
        dist = FRONT_ONLY[name]
        target_z = 2.0
        views = [(238, eye), (262, eye), (285, eye), (305, eye), (270, 9.0), (272, eye)]
    tmp = tempfile.mkdtemp()
    for i, (az, z) in enumerate(views):
        d = (dist * .55 if name in FRAME else max(dist * .42, R * 1.25, 1.2)) if i == 5 else dist
        if i == 5:
            target_z = min(eye, H * .5)
        a = math.radians(az)
        cam = bpy.data.objects.new("c", bpy.data.cameras.new("c"))
        bpy.context.collection.objects.link(cam)
        cam.location = (centre.x + math.cos(a) * d, centre.y + math.sin(a) * d, z)
        look = Vector((centre.x, centre.y, target_z))
        cam.data.lens = 28 if H >= 12 else 34
        if i == 5 and name in CLOSE:
            (cx, cy, cz), (tx, ty, tz) = CLOSE[name]
            cam.location, look = (cx, -cz, cy), Vector((tx, -tz, ty))
            cam.data.lens = 30
        cam.data.clip_end = 2000
        cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam
        path = os.path.join(tmp, f"{i}.jpg")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        frames.append(path)
        bpy.data.objects.remove(cam)
    out = os.path.join(OUT, name + ".jpg")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "1", "-i", os.path.join(tmp, "%d.jpg"), "-vf", "tile=3x2:padding=3", "-frames:v", "1", "-q:v", "3", out], check=True)
    bpy.data.objects.remove(ground)
    bpy.data.objects.remove(sun)
    return dict(sizeMetres=[round(size.x, 2), round(size.z, 2), round(size.y, 2)])


setup()
for name in names:
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bpy.ops.import_scene.gltf(filepath=os.path.join(GLB, name + ".glb"))
    obj = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
    for extra in COMPANIONS.get(name, []):
        bpy.ops.import_scene.gltf(filepath=os.path.join(GLB, extra + ".glb"))
    bpy.context.view_layer.update()
    report = audit(obj)
    report.update(render(obj, name))
    obj.data.calc_loop_triangles()
    report["triangles"] = len(obj.data.loop_triangles)
    report["fileMB"] = round(os.path.getsize(os.path.join(GLB, name + ".glb")) / 1e6, 2)
    with open(os.path.join(OUT, name + ".json"), "w") as f:
        json.dump(report, f, indent=1)
    print("REVIEW", name, "parts", report["looseParts"], "floating", report["floatingGroups"], flush=True)
