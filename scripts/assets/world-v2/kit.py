"""Prop-building kit for the SILENCE world: parts, weathered materials, atlas bake, GLB.

A Model is authored in game coordinates (metres, Y up, ground at Y=0). Every part
carries explicit normals, a real-scale tiling UV and a random seed. The result is
baked from layered Cycles materials into a single PBR atlas, so a prop costs one
draw call, never tiles, and needs no shader work at runtime.
"""
import math
import os
import random
import time

import bpy
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
SOURCE = os.path.join(ROOT, "assets/world-v2")
OUT = os.path.join(ROOT, "public/world")
TEX = os.path.join(ROOT, "public/textures")
started = time.time()


def log(*a):
    print(f"[{time.time() - started:6.1f}s]", *a, flush=True)


def norm(v):
    v = np.asarray(v, float)
    return v / max(np.linalg.norm(v), 1e-9)


def to_blender(p):
    p = np.asarray(p, float)
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], axis=-1)


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], float)


def frame_along(a, b, up=(0, 1, 0)):
    """Orthonormal (x, y, z) where z runs a->b and y stays as close to `up` as it can."""
    z = norm(np.asarray(b, float) - np.asarray(a, float))
    u = np.asarray(up, float)
    if abs(z.dot(norm(u))) > 0.97:
        u = np.array((1.0, 0, 0))
    x = norm(np.cross(u, z))
    y = np.cross(z, x)
    return x, y, z


def _sheet_wear(rng):
    """Rust starts where a sheet ends, in runs of uneven length, and no two sheets agree."""
    a, b, c, depth = rng.uniform(5, 13), rng.uniform(0, 6), rng.uniform(13, 29), rng.uniform(.3, .9)
    def wear(u, v):
        runs = .5 + .5 * math.sin(u * a * 6.28 + b) * math.sin(u * c * 6.28 + b * 2)
        return min(1.0, max(0.0, (v - (1 - depth * runs)) / max(depth * runs, .05))) ** 2 * .8
    return wear


class Model:
    def __init__(self, name, tex=2048, seed=1):
        self.name, self.tex = name, tex
        self.rng = random.Random(seed)
        self.parts = {}
        self.colliders, self.hooks, self.ladders = [], {}, []
        self.radius = 1.0
        self.xf = None
        self.density = 1.0   # texels relative to the rest; drop for hidden undersides

    # -- transforms: a nested assembly can be authored in its own local frame ---
    def at(self, origin, yaw=0.0):
        """Author subsequent parts relative to this frame. Returns a closing callable."""
        prev = self.xf
        self.xf = (np.asarray(origin, float), rot_y(yaw), yaw)

        def close():
            self.xf = prev
        return close

    def _p(self, p):
        p = np.asarray(p, float)
        if self.xf is None:
            return p
        return p @ self.xf[1].T + self.xf[0]

    def _d(self, d):
        d = np.asarray(d, float)
        return d if self.xf is None else d @ self.xf[1].T

    # -- raw geometry -----------------------------------------------------------
    def add(self, mat, verts, normals, uvs, faces, seed=None, metres_per_uv=0.5, density=1.0, wear=0.0):
        """Every call is one atlas island: its tiling UVs are metric, so the island
        keeps real-world proportions and the grain stays unbroken along a board."""
        verts, normals = self._p(np.asarray(verts, float)), self._d(np.asarray(normals, float))
        bucket = self.parts.setdefault(mat, dict(v=[], n=[], uv=[], s=[], f=[], w=[], count=0, islands=[]))
        base = bucket["count"]
        bucket["islands"].append((base, len(verts), metres_per_uv, density * self.density))
        bucket["v"].append(verts)
        bucket["n"].append(normals)
        bucket["uv"].append(np.asarray(uvs, float))
        bucket["s"].append(np.full(len(verts), self.rng.random() if seed is None else seed))
        bucket["w"].append(np.broadcast_to(np.asarray(wear, float), (len(verts),)).copy())
        bucket["f"].extend([tuple(i + base for i in face) for face in faces])
        bucket["count"] += len(verts)

    def sweep(self, mat, path, width, height, up=(0, 1, 0), chamfer=0.006, grain=0.5, caps=True, cap_mat=None):
        """A board or beam along a polyline. Each flat face owns its corners, so chamfers
        shade as rounded edges while the faces stay perfectly flat."""
        path = [np.asarray(p, float) for p in path]
        n = len(path)
        hw, hh = width / 2, height / 2
        c = min(chamfer, hw * 0.45, hh * 0.45)
        # Ring: top, right, bottom, left, two corners each.
        ring = [(-hw + c, hh), (hw - c, hh), (hw, hh - c), (hw, -hh + c), (hw - c, -hh), (-hw + c, -hh), (-hw, -hh + c), (-hw, hh - c)]
        rnorm = [(0, 1), (0, 1), (1, 0), (1, 0), (0, -1), (0, -1), (-1, 0), (-1, 0)]
        # Each board takes its own crop and a slightly different stretch of the scan. The scan is 0.5 m wide
        # (texture-attribution.json), so the big enlargement is not done here: the material swaps between two
        # lookups at unrelated scales instead, which is what stops knots lining up from board to board.
        if mat in ("wood", "wood_dark", "wood_clean", "wood_fresh", "white_paint", "logwood"):
            grain *= self.rng.uniform(.85, 1.3)
        off_u, off_v = self.rng.random() * 9, self.rng.random() * 9
        ring.append(ring[0])
        rnorm.append(rnorm[0])
        u_along = [0.0]
        for i in range(1, 9):
            u_along.append(u_along[-1] + math.dist(ring[i - 1], ring[i]))
        verts, normals, uvs, faces = [], [], [], []
        dist = 0.0
        for k, p in enumerate(path):
            a = path[max(0, k - 1)]
            b = path[min(n - 1, k + 1)]
            x, y, z = frame_along(a, b, up)
            if k:
                dist += float(np.linalg.norm(p - path[k - 1]))
            for j in range(9):
                verts.append(p + x * ring[j][0] + y * ring[j][1])
                normals.append(x * rnorm[j][0] + y * rnorm[j][1])
                uvs.append((u_along[j] / grain + off_u, dist / grain + off_v))
        for k in range(n - 1):
            for j in range(8):
                j2 = j + 1
                faces.append((k * 9 + j2, k * 9 + j, (k + 1) * 9 + j, (k + 1) * 9 + j2))
        self.add(mat, verts, normals, uvs, faces, metres_per_uv=grain)
        if caps:
            for end, sign in ((0, -1), (n - 1, 1)):
                a, b = (path[0], path[1]) if end == 0 else (path[-2], path[-1])
                x, y, z = frame_along(a, b, up)
                cv = [path[end] + x * q[0] + y * q[1] for q in ring[:8]]
                cn = [z * sign] * 8
                cu = [(q[0] / grain + off_v, q[1] / grain + off_u) for q in ring[:8]]
                face = list(range(7, -1, -1)) if sign > 0 else list(range(8))
                self.add(cap_mat or mat, cv, cn, cu, [tuple(face)], metres_per_uv=grain, density=.7)

    def beam(self, a, b, w, h=None, mat="wood", up=(0, 1, 0), chamfer=0.008, segs=1, warp=0.0, grain=0.5):
        h = w if h is None else h
        a, b = np.asarray(a, float), np.asarray(b, float)
        path = []
        x, y, _ = frame_along(a, b, up)
        wa, wb = self.rng.uniform(-1, 1) * warp, self.rng.uniform(-1, 1) * warp
        for i in range(segs + 1):
            t = i / segs
            bend = math.sin(math.pi * t)
            path.append(a + (b - a) * t + x * wa * bend + y * wb * bend)
        self.sweep(mat, path, w, h, up, chamfer, grain)

    def plank(self, a, b, w=0.16, t=0.024, mat="wood", up=(0, 1, 0), warp=0.008, segs=3):
        self.beam(a, b, w, t, mat, up, 0.004, segs, warp)

    def box(self, centre, size, mat="wood", yaw=0.0, chamfer=0.01, up_axis=1):
        c = np.asarray(centre, float)
        sx, sy, sz = size
        # Longest horizontal axis becomes the grain axis.
        r = rot_y(yaw)
        if sy >= max(sx, sz):
            self.beam(c - np.array((0, sy / 2, 0)), c + np.array((0, sy / 2, 0)), sx, sz, mat, r @ np.array((0, 0, 1.0)), chamfer)
        elif sx >= sz:
            d = r @ np.array((sx / 2, 0, 0))
            self.beam(c - d, c + d, sz, sy, mat, (0, 1, 0), chamfer)
        else:
            d = r @ np.array((0, 0, sz / 2))
            self.beam(c - d, c + d, sx, sy, mat, (0, 1, 0), chamfer)

    def log(self, a, b, r, mat="bark", cap="endgrain", sides=9, segs=5, noise=0.05, taper=0.0, caps=(True, True), grain=1.0):
        a, b = np.asarray(a, float), np.asarray(b, float)
        x, y, z = frame_along(a, b)
        length = float(np.linalg.norm(b - a))
        phase = self.rng.random() * 50
        verts, normals, uvs, faces = [], [], [], []
        bend = np.array((self.rng.uniform(-1, 1), self.rng.uniform(-1, 1))) * r * 0.25
        ends = []
        off_v, off_u = self.rng.random() * 9, self.rng.random() * 9
        for i in range(segs + 1):
            t = i / segs
            rad = r * (1 - taper * t)
            mid = a + (b - a) * t + (x * bend[0] + y * bend[1]) * math.sin(math.pi * t)
            ring = []
            for j in range(sides + 1):
                th = 2 * math.pi * (j % sides) / sides
                bump = 1 + noise * (math.sin(th * 3 + phase) * 0.5 + math.sin(th * 5 + phase * 1.7 + t * 6) * 0.5 + math.sin(t * 9 + phase) * 0.4)
                d = x * math.cos(th) + y * math.sin(th)
                verts.append(mid + d * rad * bump)
                normals.append(d)
                uvs.append((j / sides * 2 * math.pi * r / grain * 2 + off_u, t * length / grain * 2 + off_v))
                ring.append(verts[-1])
            ends.append((mid, ring[:-1], rad))
        for i in range(segs):
            for j in range(sides):
                s = sides + 1
                faces.append((i * s + j, i * s + j + 1, (i + 1) * s + j + 1, (i + 1) * s + j))
        self.add(mat, verts, normals, uvs, faces, metres_per_uv=grain / 2)
        for idx, (mid, ring, rad) in ((0, ends[0]), (1, ends[-1])):
            if not caps[idx]:
                continue
            sign = -1 if idx == 0 else 1
            cv = [mid] + ring
            cn = [z * sign] * len(cv)
            cu = [(0.5, 0.5)] + [(0.5 + 0.5 * math.cos(2 * math.pi * j / sides), 0.5 + 0.5 * math.sin(2 * math.pi * j / sides)) for j in range(sides)]
            tri = []
            for j in range(sides):
                p, q = 1 + j, 1 + (j + 1) % sides
                tri.append((0, p, q) if sign > 0 else (0, q, p))
            self.add(cap, cv, cn, cu, tri, metres_per_uv=2 * rad, density=.8)

    def lathe(self, profile, a, b, mat, sides=14, flat=False, density=1.0, wear=0.0):
        """profile: (radius, t) with t in 0..1 along a->b."""
        a, b = np.asarray(a, float), np.asarray(b, float)
        x, y, z = frame_along(a, b)
        L = float(np.linalg.norm(b - a))
        P = [(float(r), float(t)) for r, t in profile]
        verts, normals, uvs, faces = [], [], [], []
        arclen = [0.0]
        for i in range(1, len(P)):
            arclen.append(arclen[-1] + math.hypot(P[i][0] - P[i - 1][0], (P[i][1] - P[i - 1][1]) * L))
        for i, (r, t) in enumerate(P):
            p0, p1 = P[max(0, i - 1)], P[min(len(P) - 1, i + 1)]
            dr, dt = p1[0] - p0[0], (p1[1] - p0[1]) * L
            l = math.hypot(dr, dt) or 1
            nr, nz = dt / l, -dr / l
            for j in range(sides + 1):
                th = 2 * math.pi * (j % sides) / sides
                d = x * math.cos(th) + y * math.sin(th)
                verts.append(a + (b - a) * t + d * r)
                normals.append(d * nr + z * nz)
                uvs.append((j / sides * 2 * math.pi * max(r, 0.02) * 2, arclen[i] * 2))
        s = sides + 1
        for i in range(len(P) - 1):
            for j in range(sides):
                faces.append((i * s + j, i * s + j + 1, (i + 1) * s + j + 1, (i + 1) * s + j))
        self.add(mat, verts, normals, uvs, faces, metres_per_uv=.5, density=density, wear=wear)

    def cyl(self, a, b, r, mat, sides=12, r2=None):
        r2 = r if r2 is None else r2
        e = min(r * 0.12, 0.012)
        self.lathe([(0, 0), (r - e, 0), (r, 0.0 + e / max(math.dist(a, b), 1e-3)), (r2, 1 - e / max(math.dist(a, b), 1e-3)), (r2 - e, 1), (0, 1)], a, b, mat, sides)

    def tube(self, points, r, mat, sides=8, wear=0.0):
        """Round pipe through points. Its frame is carried along the path, so bends cannot twist."""
        points = [np.asarray(p, float) for p in points]
        # Round off corners, so a bent pipe bends instead of kinking.
        if len(points) > 2:
            soft = [points[0]]
            for k in range(1, len(points) - 1):
                p, a, b = points[k], points[k - 1], points[k + 1]
                da, db = norm(a - p), norm(b - p)
                reach = min(r * 3.5, np.linalg.norm(a - p) * .45, np.linalg.norm(b - p) * .45)
                start, end = p + da * reach, p + db * reach
                for t in np.linspace(0, 1, 5):
                    soft.append((1 - t) ** 2 * start + 2 * t * (1 - t) * p + t ** 2 * end)
            soft.append(points[-1])
            points = soft
        verts, normals, uvs, faces, wears = [], [], [], [], []
        dist = 0.0
        tangent = norm(points[1] - points[0])
        x = norm(np.cross((0.0, 1.0, 0.0) if abs(tangent[1]) < .9 else (1.0, 0.0, 0.0), tangent))
        for k, p in enumerate(points):
            a, b = points[max(0, k - 1)], points[min(len(points) - 1, k + 1)]
            new = norm(b - a)
            x = norm(x - new * x.dot(new))
            y = np.cross(new, x)
            if k:
                dist += float(np.linalg.norm(p - points[k - 1]))
            for j in range(sides + 1):
                th = 2 * math.pi * (j % sides) / sides
                d = x * math.cos(th) + y * math.sin(th)
                verts.append(p + d * r)
                normals.append(d)
                uvs.append((j / sides * 2 * math.pi * r * 2, dist * 2))
        s = sides + 1
        for k in range(len(points) - 1):
            for j in range(sides):
                faces.append((k * s + j, k * s + j + 1, (k + 1) * s + j + 1, (k + 1) * s + j))
        self.add(mat, verts, normals, uvs, faces, wear=wear)

    def wire(self, a, b, sag, r, mat="steel", segs=10):
        a, b = np.asarray(a, float), np.asarray(b, float)
        pts = []
        for i in range(segs + 1):
            t = i / segs
            pts.append(a + (b - a) * t - np.array((0, sag * 4 * t * (1 - t), 0)))
        self.tube(pts, r, mat, 4)

    def surface(self, mat, fn, nu, nv, uv_scale=(1, 1), flip=False, wear=None, metres_per_uv=.5, density=1.0):
        """Parametric sheet: fn(u, v) -> position, for canvas, tin and the like."""
        grid = np.array([[fn(i / nu, j / nv) for i in range(nu + 1)] for j in range(nv + 1)], float)
        du = np.gradient(grid, axis=1)
        dv = np.gradient(grid, axis=0)
        n = np.cross(du, dv)
        # A row that closes to a point has no tangent of its own: it takes the average facing of the ring next to it.
        for row, near in ((0, 1), (nv, nv - 1)):
            if np.linalg.norm(n[row], axis=1).max() < 1e-7 or np.linalg.norm(grid[row] - grid[row].mean(axis=0), axis=1).max() < 1e-6:
                n[row] = n[near].mean(axis=0)
        n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-9)
        if flip:
            n = -n
        verts, normals, uvs, faces = [], [], [], []
        for j in range(nv + 1):
            for i in range(nu + 1):
                verts.append(grid[j, i])
                normals.append(n[j, i])
                uvs.append((i / nu * uv_scale[0], j / nv * uv_scale[1]))
        s = nu + 1
        for j in range(nv):
            for i in range(nu):
                face = (j * s + i, j * s + i + 1, (j + 1) * s + i + 1, (j + 1) * s + i)
                faces.append(face[::-1] if flip else face)
        w = 0.0 if wear is None else [wear(i / nu, j / nv) for j in range(nv + 1) for i in range(nu + 1)]
        self.add(mat, verts, normals, uvs, faces, wear=w, metres_per_uv=metres_per_uv, density=density)

    def tin_sheet(self, origin, along, down, width, length, waves=6, droop=0.0, curl=0.0, mat="tin"):
        """A corrugated sheet. `along` runs across the ribs, `down` runs down the slope."""
        origin, along, down = np.asarray(origin, float), norm(along), norm(down)
        up = np.cross(down, along)
        if up[1] < 0:
            up = -up
        phase = self.rng.random() * 6

        def fn(u, v):
            x, y = u * width, v * length
            rib = 0.016 * math.sin(u * waves * 2 * math.pi)
            sag = droop * math.sin(v * math.pi) * math.sin(u * math.pi) * -1
            lift = curl * max(0.0, v - 0.55) ** 2 * (1 + 0.5 * math.sin(u * 3 + phase))
            return origin + along * x + down * y + up * (rib + sag + lift)
        self.surface(mat, fn, waves * 4, 4, (width * 2, length * 2), flip=np.cross(along, down)[1] < 0, wear=_sheet_wear(self.rng))

    def gable_roof_tin(self, a, b, ridge_up, eave_out, panel=0.92, droop=0.012, skip=(), curl=None):
        """Sheets laid from a ridge point (a) to b along the ridge."""
        a, b = np.asarray(a, float), np.asarray(b, float)
        along = norm(b - a)
        length = float(np.linalg.norm(b - a))
        count = int(math.ceil(length / panel))
        down = np.asarray(eave_out, float)
        slope = float(np.linalg.norm(down))
        for i in range(count):
            if i in skip:
                continue
            p = a + along * (i * length / count)
            jitter = self.rng.uniform(-0.012, 0.012)
            c = (curl or {}).get(i, 0.0)
            self.tin_sheet(p + np.array((0, 0.01 + i % 2 * 0.012, 0)), along, down, length / count + 0.05, slope + jitter, droop=droop, curl=c)

    def lash(self, p, axis, r, turns=4, width=.016, mat="canvas"):
        """Rope wound round a joint: pale, tight, and obviously holding it together."""
        p, axis = np.asarray(p, float), norm(axis)
        for i in range(turns):
            c = p + axis * (i - (turns - 1) / 2) * width * 1.05
            self.lathe([(r, 0), (r + width * .45, .5), (r, 1)], c - axis * width * .55, c + axis * width * .55, mat, 10, density=.45)

    def bolt(self, p, normal, r=.014, mat="steel_bare"):
        """A hex head with washer, proud of the surface it fastens."""
        p, n = np.asarray(p, float), norm(normal)
        self.lathe([(0, 0), (r * 1.6, 0), (r * 1.6, .25), (r, .3), (r, 1), (0, 1)], p, p + n * r * 1.2, mat, 6, density=.5)

    def nail(self, p, normal, r=.005, mat="steel"):
        """A nail or screw head: six triangles, just proud of the wood. Use `bolt` only where a head should stand up."""
        p, n = np.asarray(p, float), norm(normal)
        x, y, _ = frame_along(p, p + n)
        c = p + n * r * .35
        vs = [c] + [p + n * r * .12 + (x * math.cos(a) + y * math.sin(a)) * r for a in np.arange(6) * math.pi / 3]
        ns = [n] + [norm(n + (x * math.cos(a) + y * math.sin(a)) * .8) for a in np.arange(6) * math.pi / 3]
        uv = [(.5, .5)] + [(.5 + .5 * math.cos(a), .5 + .5 * math.sin(a)) for a in np.arange(6) * math.pi / 3]
        self.add(mat, vs, ns, uv, [(0, 1 + i, 1 + (i + 1) % 6) for i in range(6)], metres_per_uv=2 * r, density=.6, wear=.6)

    def gusset(self, p, u, v, size=.16, t=.01, mat="steel"):
        """A triangular steel plate lapping two members, bolted through each."""
        p, u, v = np.asarray(p, float), norm(u), norm(v)
        n = norm(np.cross(u, v))
        tri = [p - u * .04 - v * .04, p + u * size, p + v * size]
        vs = [q + n * t for q in tri] + [q - n * t for q in tri]
        ns = [n] * 3 + [-n] * 3
        self.add(mat, vs, ns, [(0, 0), (size * 2, 0), (0, size * 2)] * 2, [(0, 1, 2), (5, 4, 3)], density=.8)
        self.bolt(p + u * size * .55 + v * size * .12 + n * t, n, .012)
        self.bolt(p + v * size * .55 + u * size * .12 + n * t, n, .012)

    def poster(self, mat, centre, along, up, w, h, density=2.5):
        """A flat printed sheet carrying a whole image."""
        c, a, u = np.asarray(centre, float), np.asarray(along, float), np.asarray(up, float)
        n = np.cross(a, u)
        v = [c - a * w / 2 - u * h / 2, c + a * w / 2 - u * h / 2, c + a * w / 2 + u * h / 2, c - a * w / 2 + u * h / 2]
        self.add(mat, v, [n] * 4, [(0, 0), (1, 0), (1, 1), (0, 1)], [(0, 1, 2, 3)], metres_per_uv=max(w, h), density=density)

    def loft(self, mat, sections, around=20):
        """Closed skin through (z, half_x, half_y, centre_y, squareness) stations."""
        grid = []
        for z, hx, hy, cy, n in sections:
            ring = []
            for j in range(around + 1):
                th = 2 * math.pi * j / around
                cx_, sy = math.cos(th), math.sin(th)
                ring.append((math.copysign(abs(cx_) ** (2 / n), cx_) * hx, cy + math.copysign(abs(sy) ** (2 / n), sy) * hy, z))
            grid.append(ring)
        grid = np.array(grid, float)
        du = np.gradient(grid, axis=1)
        dv = np.gradient(grid, axis=0) if len(sections) > 1 else None
        n_ = np.cross(dv, du)
        n_ /= np.maximum(np.linalg.norm(n_, axis=2, keepdims=True), 1e-9)
        # Seam columns must agree.
        avg = n_[:, 0] + n_[:, -1]
        avg /= np.maximum(np.linalg.norm(avg, axis=1, keepdims=True), 1e-9)
        n_[:, 0] = n_[:, -1] = avg
        verts, normals, uvs, faces = [], [], [], []
        arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(grid[len(grid) // 2], axis=0), axis=1))])
        along = np.concatenate([[0], np.cumsum(np.abs(np.diff(grid[:, 0, 2])))])
        for k in range(len(sections)):
            for j in range(around + 1):
                verts.append(grid[k, j])
                normals.append(n_[k, j])
                uvs.append((arc[j] * 2, along[k] * 2))
        s = around + 1
        for k in range(len(sections) - 1):
            for j in range(around):
                faces.append((k * s + j + 1, k * s + j, (k + 1) * s + j, (k + 1) * s + j + 1))
        self.add(mat, verts, normals, uvs, faces, metres_per_uv=.5)

    # -- gameplay ---------------------------------------------------------------
    def collide_box(self, x, z, hx, hz, y0, y1, yaw=0.0, tag="prop"):
        """Yaw is measured with solidContact's convention (see game/collision.ts)."""
        p = self._p(np.array((x, 0.0, z)))
        extra = self.xf[2] if self.xf else 0.0
        base = float(self.xf[0][1]) if self.xf else 0.0
        self.colliders.append(dict(kind="box", x=float(p[0]), z=float(p[2]), halfX=hx, halfZ=hz, yaw=yaw + extra, minY=y0 + base, maxY=y1 + base, tag=tag))

    def collide_post(self, ax, az, bx, bz, r, y0, y1, tag="post"):
        a, b = self._p(np.array((ax, 0.0, az))), self._p(np.array((bx, 0.0, bz)))
        base = float(self.xf[0][1]) if self.xf else 0.0
        self.colliders.append(dict(kind="capsule", ax=float(a[0]), az=float(a[2]), bx=float(b[0]), bz=float(b[2]), radius=r, minY=y0 + base, maxY=y1 + base, tag=tag))

    def ladder(self, bottom, top, exit_, width=.5):
        """Climbable span. `exit_` is where the player stands after topping out."""
        self.ladders.append(dict(bottom=[round(float(v), 3) for v in self._p(np.asarray(bottom, float))], top=[round(float(v), 3) for v in self._p(np.asarray(top, float))], exit=[round(float(v), 3) for v in self._p(np.asarray(exit_, float))], width=width))

    def hook(self, name, p):
        self.hooks[name] = [round(float(v), 3) for v in self._p(np.asarray(p, float))]


# ----------------------------------------------------------------------------
# Weathered materials
# ----------------------------------------------------------------------------
_images = {}
DEPTH_DARK = None


def _image(name, srgb):
    key = (name, srgb)
    if key not in _images:
        img = bpy.data.images.load(name if os.path.isabs(name) else os.path.join(TEX, name), check_existing=True)
        img = img.copy() if False else img
        img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
        _images[key] = img
    return _images[key]


class G:
    """Tiny node-graph helper."""

    def __init__(self, tree):
        self.t, self.n, self.l = tree, tree.nodes, tree.links

    def node(self, kind, **props):
        n = self.n.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.l.new(a, b)

    def val(self, v):
        n = self.node("ShaderNodeValue")
        n.outputs[0].default_value = v
        return n.outputs[0]

    def rgb(self, c):
        n = self.node("ShaderNodeRGB")
        n.outputs[0].default_value = (*c, 1)
        return n.outputs[0]

    def math(self, op, a, b=None, clamp=False):
        n = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        self._in(n.inputs[0], a)
        if b is not None:
            self._in(n.inputs[1], b)
        return n.outputs[0]

    def _in(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.link(v, sock)
        else:
            sock.default_value = v

    def mix(self, fac, a, b, blend="MIX"):
        n = self.node("ShaderNodeMix", data_type="RGBA", blend_type=blend, clamp_factor=True)
        self._in(n.inputs[0], fac)
        for sock_i, v in ((6, a), (7, b)):
            if isinstance(v, tuple):
                n.inputs[sock_i].default_value = (*v, 1)
            else:
                self._in(n.inputs[sock_i], v)
        return n.outputs[2]

    def mixf(self, fac, a, b):
        n = self.node("ShaderNodeMix", data_type="FLOAT", clamp_factor=True)
        self._in(n.inputs[0], fac)
        self._in(n.inputs[2], a)
        self._in(n.inputs[3], b)
        return n.outputs[0]

    def ramp(self, v, lo, hi):
        n = self.node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP")
        self._in(n.inputs[0], v)
        n.inputs[1].default_value = lo
        n.inputs[2].default_value = hi
        return n.outputs[0]

    def noise(self, vector, scale, detail=5.0, rough=0.55, distortion=0.0):
        n = self.node("ShaderNodeTexNoise")
        self.link(vector, n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        n.inputs["Distortion"].default_value = distortion
        return n.outputs["Fac"]

    def stretch(self, vector, sx, sy, sz):
        n = self.node("ShaderNodeVectorMath", operation="MULTIPLY")
        self.link(vector, n.inputs[0])
        n.inputs[1].default_value = (sx, sy, sz)
        return n.outputs[0]

    def ao(self, distance, inside=False, samples=8):
        n = self.node("ShaderNodeAmbientOcclusion", samples=samples, inside=inside, only_local=False)
        n.inputs["Distance"].default_value = distance
        return n.outputs["AO"]

    def bump(self, height, strength, distance=0.02, normal=None):
        n = self.node("ShaderNodeBump")
        self.link(height, n.inputs["Height"])
        n.inputs["Strength"].default_value = strength
        n.inputs["Distance"].default_value = distance
        if normal is not None:
            self.link(normal, n.inputs["Normal"])
        return n.outputs["Normal"]


RECIPES = {
    # Scanned timber, weathered towards silver-grey.
    "wood": dict(tex="wood", tint=(1.0, 0.95, 0.86), desat=0.55, vary=0.45, uv=1.0, moss=0.55, streak=0.5, edge=(0.46, 0.43, 0.37)),
    "wood_dark": dict(tex="wood", tint=(0.55, 0.49, 0.42), desat=0.3, vary=0.4, uv=1.0, moss=0.4, streak=0.6, edge=(0.3, 0.27, 0.23)),
    "wood_fresh": dict(tex="wood", tint=(0.9, 0.78, 0.62), desat=0.0, vary=0.3, uv=1.0, moss=0.2, streak=0.3, edge=(0.6, 0.52, 0.4)),
    "logwood": dict(tex="wood", tint=(0.92, 0.84, 0.72), desat=0.45, vary=0.5, uv=1.0, moss=.7, streak=0.5, edge=(0.42, 0.38, 0.31)),
    "galv": dict(proc="metal", age=.3, paint=(.36, .37, .36), metal=.2, rough=.55, bump=.05),
    "bark": dict(tex="bark", tint=(0.72, 0.68, 0.62), desat=0.1, vary=0.35, uv=1.0, moss=.45, streak=0.2, edge=None),
    "stone": dict(tex="rock", tint=(0.8, 0.8, 0.76), desat=0.3, vary=0.5, uv=0.8, moss=1.0, streak=0.3, edge=(0.42, 0.42, 0.4)),
    "tin": dict(proc="metal", age=0.5, seam=.04, edgew=.1, paint=(0.3, 0.32, 0.32), metal=0.15, rough=0.72, bump=0.12),
    "tin_red": dict(proc="metal", age=0.5, paint=(0.2, 0.05, 0.035), metal=0.0, rough=0.62, bump=0.12),
    "steel": dict(proc="metal", age=0.34, paint=(0.075, 0.085, 0.07), metal=0.1, rough=0.55, bump=0.05),
    "steel_bare": dict(proc="metal", age=0.52, paint=(0.24, 0.24, 0.225), metal=0.25, rough=0.5, bump=0.04),
    "olive": dict(proc="metal", age=0.34, paint=(0.1, 0.12, 0.05), metal=0.0, rough=0.55, bump=0.03),
    "truck": dict(proc="metal", age=0.62, paint=(0.13, 0.2, 0.2), metal=0.0, rough=0.5, bump=0.08, moss=.6),
    "drum_red": dict(proc="metal", age=.28, seam=.1, edgew=.25, paint=(0.2, 0.05, 0.035), metal=0.0, rough=0.62, bump=0.12),
    "can_olive": dict(proc="metal", age=.14, seam=.05, edgew=.3, paint=(0.1, 0.12, 0.05), metal=0.0, rough=0.55, bump=0.03),
    "cooler": dict(proc="metal", age=.62, seam=.5, paint=(.2, .05, .03), metal=0.0, rough=.7, bump=.05),
    "red": dict(proc="metal", age=0.42, paint=(0.34, 0.035, 0.02), metal=0.0, rough=0.5, bump=0.03),
    "yellow": dict(proc="metal", age=0.42, paint=(0.55, 0.36, 0.03), metal=0.0, rough=0.5, bump=0.03),
    "white_mast": dict(proc="metal", age=0.26, paint=(0.55, 0.53, 0.47), metal=0.0, rough=0.6, bump=0.03),
    "chrome": dict(proc="metal", age=0.5, paint=(0.5, 0.5, 0.48), metal=0.3, rough=0.4, bump=0.02),
    "white_paint": dict(tex="wood", tint=(0.68, 0.64, 0.58), desat=0.5, vary=0.3, uv=1.0, moss=0.8, streak=0.8, edge=None, peel=(0.72, 0.7, 0.62)),
    "concrete": dict(proc="concrete", moss=.5),
    "block": dict(proc="concrete", blocks=True, moss=.6),
    "rock": dict(proc="rockbox"),
    "mine_rubble": dict(tex="rock", tint=(.58, .55, .5), desat=.95, vary=.32, uv=2.2, moss=0, streak=0, edge=None),
    "canvas": dict(proc="cloth", colour=(0.21, 0.23, 0.13)),
    "canvas_orange": dict(proc="cloth", colour=(0.2, 0.1, 0.05)),
    "wood_clean": dict(tex="wood", tint=(1.0, 0.95, 0.86), desat=0.5, vary=0.55, uv=1.0, moss=0.12, streak=0.25, edge=(0.46, 0.43, 0.37)),
    "tarp": dict(proc="cloth", colour=(0.05, 0.11, 0.19)),
    "rubber": dict(proc="flat", colour=(0.016, 0.016, 0.016), rough=0.88),
    "tyre": dict(proc="tyre"),
    "glass": dict(proc="flat", colour=(0.012, 0.016, 0.016), rough=0.12, grime=True),
    "bottle_green": dict(proc="flat", colour=(0.03, 0.09, 0.04), rough=0.2, grime=True),
    "bottle_brown": dict(proc="flat", colour=(0.09, 0.04, 0.015), rough=0.2, grime=True),
    "asphalt": dict(proc="asphalt"),
    "void": dict(proc="flat", colour=(0.0005, 0.0005, 0.0005), rough=0.95),
    "ceramic": dict(proc="flat", colour=(0.62, 0.58, 0.48), rough=0.32, grime=True),
    "brass": dict(proc="flat", colour=(0.42, 0.3, 0.12), rough=0.42, metal=0.45, grime=True),
    "char": dict(proc="char"),
    "soot_iron": dict(proc="metal", age=.3, paint=(.065, .057, .045), metal=.35, rough=.67),
    "ash": dict(proc="ash"),
    "endgrain": dict(proc="endgrain"),
}


def poster_material(name, image_path):
    """Printed paper or painted boards: an image laid over the UV square of a part."""
    RECIPES[name] = dict(proc="image", image=image_path)


def build_material(name):
    r = RECIPES[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = False
    g = G(mat.node_tree)
    bsdf = g.n["Principled BSDF"]
    geo = g.node("ShaderNodeNewGeometry")
    pos = geo.outputs["Position"]
    uvn = g.node("ShaderNodeUVMap", uv_map="tile")
    seed = g.node("ShaderNodeVertexColor", layer_name="seed").outputs["Color"]
    up = g.node("ShaderNodeSeparateXYZ")
    g.link(geo.outputs["Normal"], up.inputs[0])
    up_z = up.outputs["Z"]
    height = g.node("ShaderNodeSeparateXYZ")
    g.link(pos, height.inputs[0])
    z = height.outputs["Z"]
    crevice = g.ao(0.22)
    # An arris is where the rounded-off normal leaves the true one. Unlike an inward occlusion probe this
    # does not light up thin sheet, or a face that has another part buried just behind it.
    bev = g.node("ShaderNodeBevel", samples=6)
    bev.inputs["Radius"].default_value = .009
    bdot = g.node("ShaderNodeVectorMath", operation="DOT_PRODUCT")
    g.link(bev.outputs[0], bdot.inputs[0])
    g.link(geo.outputs["Normal"], bdot.inputs[1])
    edge = g.ramp(g.math("SUBTRACT", 1.0, bdot.outputs["Value"]), .004, .12)
    proc = r.get("proc")
    metal_out = None
    normal_out = None

    if proc in (None, "image") and "tex" in r:
        files = dict(wood=("wood-diff.jpg", "wood-normal.jpg", "wood-rough.jpg"), bark=("bark-diff.jpg", "bark-normal.jpg", "bark-rough.jpg"), rock=("rock-diff.jpg", "rock-normal.jpg", "rock-rough.jpg"))[r["tex"]]
        # Every part already starts somewhere else in the scan (its UV offset). Two lookups at unrelated
        # scales, swapped by a slow mask, stop the scan's own knots coming round again along one board.
        own_uv = g.node("ShaderNodeVectorMath", operation="ADD")
        g.link(pos, own_uv.inputs[0])
        g.link(_grey(g, g.math("MULTIPLY", seed_red(g, seed), 53.0)), own_uv.inputs[1])
        swap = g.ramp(g.noise(own_uv.outputs[0], 1.7, 3, .5), .44, .56)

        def lookup(scale, shift):
            mp = g.node("ShaderNodeMapping")
            g.link(uvn.outputs[0], mp.inputs["Vector"])
            mp.inputs["Scale"].default_value = (r["uv"] * scale[0], r["uv"] * scale[1], 1)
            mp.inputs["Location"].default_value = (shift[0], shift[1], 0)
            out = []
            for f, srgb in zip(files, (True, False, False)):
                t = g.node("ShaderNodeTexImage", image=_image(f, srgb))
                g.link(mp.outputs[0], t.inputs[0])
                out.append(t.outputs[0])
            return out
        a_, b_ = lookup((.62, .58), (0, 0)), lookup((.43, .37), (.37, .61))
        diff_c, nrm_c, rgh_c = (g.mix(swap, x, y) for x, y in zip(a_, b_))
        rgh_sep = g.node("ShaderNodeSeparateColor")
        g.link(rgh_c, rgh_sep.inputs[0])
        nm = g.node("ShaderNodeNormalMap", uv_map="tile")
        nm.inputs["Strength"].default_value = 1.1
        g.link(nrm_c, nm.inputs["Color"])
        normal_out = nm.outputs[0]
        hsv = g.node("ShaderNodeHueSaturation")
        hsv.inputs["Saturation"].default_value = 1 - r["desat"]
        g.link(diff_c, hsv.inputs["Color"])
        vary = g.math("ADD", g.math("MULTIPLY", g.math("SUBTRACT", seed_red(g, seed), 0.5), r["vary"]), 1.0)
        base = g.mix(1.0, hsv.outputs[0], r["tint"], "MULTIPLY")
        base = g.mix(1.0, base, _grey(g, vary), "MULTIPLY")
        rough = g.math("MULTIPLY", rgh_sep.outputs[0], 1.05)
        if r.get("peel"):
            broad = g.noise(pos, .55, 3, .5)
            flake = g.noise(pos, 19, 7, .62)
            low = g.ramp(z, 1.6, .2)
            weather = g.math("ADD", g.math("ADD", g.math("MULTIPLY", g.math("SUBTRACT", broad, .5), 1.1), g.math("MULTIPLY", low, .3)), g.math("MULTIPLY", g.math("SUBTRACT", flake, .5), .5))
            wear = g.ramp(g.math("ADD", weather, g.math("MULTIPLY", edge, .25)), .2, .26)
            base = g.mix(g.math("SUBTRACT", 1.0, wear), base, r["peel"])
            rough = g.mixf(g.math("SUBTRACT", 1.0, wear), rough, 0.55)
            normal_out = g.bump(g.math("MULTIPLY", wear, 1.0), 0.5, 0.004, normal_out)
        if r.get("edge"):
            base = g.mix(g.math("MULTIPLY", edge, 0.3), base, r["edge"])
    elif proc == "metal":
        age = r.get("age", .4)
        fine, mid = g.noise(pos, 62, 6, .62), g.noise(pos, 13, 6, .58)
        broad = g.noise(pos, 1.3, 3, .5)
        wear_attr = seed_green(g, seed)
        hard_edge = edge
        seam = g.math("SUBTRACT", 1.0, crevice)
        low = g.ramp(z, 1.0, .06)
        # Rust needs a cause: an edge, a seam, a low point, or wherever the model says water sits. Noise only
        # roughens the outline of what those start; on its own it never reaches the threshold, so sound
        # paint stays sound instead of breaking out in blotches.
        cause = g.math("ADD", g.math("MULTIPLY", hard_edge, r.get("edgew", .5)), g.math("MULTIPLY", seam, r.get("seam", .3)))
        cause = g.math("ADD", cause, g.math("MULTIPLY", low, .2))
        cause = g.math("ADD", cause, g.math("MULTIPLY", wear_attr, .72))
        breakup = g.math("ADD", .68, g.math("MULTIPLY", mid, .64))
        score = g.math("ADD", g.math("MULTIPLY", cause, breakup), age * .34)
        score = g.math("ADD", score, g.math("MULTIPLY", g.math("SUBTRACT", broad, .5), .2))
        score = g.math("ADD", score, g.math("MULTIPLY", g.math("SUBTRACT", fine, .5), .14))
        rustmask = g.ramp(score, .5, .57)
        # A few pinholes, and only in the patches that are already going.
        pin = g.math("MULTIPLY", g.ramp(fine, .78, .81), g.ramp(g.math("ADD", broad, age * .3), .6, .75))
        rustmask = g.math("MAXIMUM", rustmask, pin)
        halo = g.math("MULTIPLY", g.ramp(score, .43, .5), .32)
        tone = g.noise(pos, 28, 5, .62)
        rust = g.mix(g.ramp(tone, .3, .7), (.062, .034, .022), (.15, .072, .036))
        # Sun chalks the paint on what faces the sky; a soft dirt film gathers lower down.
        chalk = g.math("MULTIPLY", g.ramp(up_z, .2, .9), .22)
        paint = g.mix(chalk, r["paint"], tuple(min(1, c * 1.35 + .05) for c in r["paint"]))
        paint = g.mix(g.math("MULTIPLY", g.ramp(broad, .36, .66), .22), paint, tuple(c * .78 for c in r["paint"]))
        # Rust bleeds a brown stain into the paint round it; faint run-off streaks below.
        paint = g.mix(halo, paint, (.2, .1, .055), "MULTIPLY")
        run = g.math("MULTIPLY", g.ramp(g.noise(g.stretch(pos, 32, 32, .9), 1.0, 4, .5), .56, .8), .2 * min(1, age * 1.6))
        paint = g.mix(run, paint, (.16, .09, .05), "MULTIPLY")
        chip = g.math("MULTIPLY", g.ramp(g.math("ADD", g.math("MULTIPLY", hard_edge, .8), g.math("MULTIPLY", fine, .5)), .72, .8), min(1.0, .35 + age))
        paint = g.mix(chip, paint, (.1, .085, .075))
        base = g.mix(rustmask, paint, rust)
        rough = g.mixf(rustmask, r["rough"], .88)
        metal_out = g.mixf(rustmask, r["metal"], 0.0)
        pits = g.noise(pos, 110, 4, .7)
        normal_out = g.bump(g.math("ADD", g.math("MULTIPLY", rustmask, .55), g.math("MULTIPLY", pits, g.math("MULTIPLY", rustmask, .45))), .9, .005)
    elif proc == "asphalt":
        # A unique metre-space pavement bake: no small rock photograph tiled
        # into a grid over the entire deck. Aggregate, wear and damp areas
        # are independent continuous fields at physical scales.
        broad = g.noise(pos, .19, 4, .58, .35)
        patches = g.noise(pos, .67, 4, .62, .45)
        grit = g.noise(pos, 78, 3, .65)
        chips = g.ramp(g.noise(pos, 43, 3, .58), .56, .7)
        base = g.mix(broad, (.048, .051, .05), (.087, .09, .086))
        base = g.mix(g.math("MULTIPLY", chips, .42), base, (.21, .207, .19))
        base = g.mix(g.math("MULTIPLY", g.ramp(patches, .52, .77), .4), base, (.025, .03, .028))
        # Fine uneven cracks without a repeating tile, mostly weathered shut.
        cells = g.node("ShaderNodeTexVoronoi", feature="DISTANCE_TO_EDGE")
        g.link(g.stretch(pos, .7, .7, .7), cells.inputs["Vector"])
        cells.inputs["Scale"].default_value = 1
        fissure = g.math("SUBTRACT", 1, g.ramp(cells.outputs["Distance"], .001, .008))
        fissure = g.math("MULTIPLY", fissure, g.ramp(g.noise(pos, .45, 3), .52, .68))
        base = g.mix(g.math("MULTIPLY", fissure, .48), base, (.018, .02, .017))
        rough = g.mixf(g.ramp(patches, .5, .78), .91, .73)
        relief = g.math("SUBTRACT", g.math("ADD", grit, g.math("MULTIPLY", chips, .35)), g.math("MULTIPLY", fissure, .8))
        normal_out = g.bump(relief, .45, .003)
    elif proc == "concrete":
        fine = g.noise(pos, 80, 5, .7)
        base = g.mix(g.ramp(g.noise(pos, 3, 5, .55), .3, .7), (.2, .195, .175), (.27, .262, .235))
        base = g.mix(g.math("MULTIPLY", g.ramp(fine, .58, .74), .2), base, (.1, .1, .095))
        rough = .94
        h_ = fine
        if r.get("blocks"):
            # Coursing comes from world position, so every wall bonds the same way.
            sep = g.node("ShaderNodeSeparateXYZ")
            g.link(geo.outputs["Normal"], sep.inputs[0])
            ax = g.math("ABSOLUTE", sep.outputs["X"])
            ay = g.math("ABSOLUTE", sep.outputs["Y"])
            pos_sep = g.node("ShaderNodeSeparateXYZ")
            g.link(pos, pos_sep.inputs[0])
            along = g.math("ADD", g.math("MULTIPLY", pos_sep.outputs["X"], ay), g.math("MULTIPLY", pos_sep.outputs["Y"], ax))
            uvb = g.node("ShaderNodeCombineXYZ")
            g.link(along, uvb.inputs[0])
            g.link(pos_sep.outputs["Z"], uvb.inputs[1])
            brick = g.node("ShaderNodeTexBrick")
            g.link(uvb.outputs[0], brick.inputs["Vector"])
            brick.inputs["Color1"].default_value = (.82, .82, .82, 1)
            brick.inputs["Color2"].default_value = (1, 1, 1, 1)
            brick.inputs["Mortar"].default_value = (0, 0, 0, 1)
            brick.inputs["Scale"].default_value = 1
            brick.inputs["Mortar Size"].default_value = .009
            brick.inputs["Brick Width"].default_value = .4
            brick.inputs["Row Height"].default_value = .2
            mortar = brick.outputs["Fac"]
            per_block = g.ramp(brick.outputs["Color"], .0, 1.0)
            base = g.mix(g.math("MULTIPLY", mortar, .9), base, (.075, .072, .062))
            h_ = g.math("SUBTRACT", g.math("MULTIPLY", fine, .5), g.math("MULTIPLY", mortar, 2.2))
        # Rain stains hang from wherever water runs off; splash darkens the foot of the wall.
        stain = g.ramp(g.noise(g.stretch(pos, 26, 26, .55), 1.0, 5, .55), .5, .74)
        wear_attr = seed_green(g, seed)
        base = g.mix(g.math("MULTIPLY", stain, g.math("ADD", .25, g.math("MULTIPLY", wear_attr, .6))), base, (.16, .15, .13), "MULTIPLY")
        tide = g.ramp(g.math("ADD", z, g.math("ADD", g.math("MULTIPLY", g.math("SUBTRACT", g.noise(pos, .9, 4, .55), .5), 1.5), g.math("MULTIPLY", g.math("SUBTRACT", g.noise(pos, 6, 4, .6), .5), .35))), .75, .1)
        base = g.mix(g.math("MULTIPLY", tide, .7), base, (.1, .105, .07), "MULTIPLY")
        normal_out = g.bump(h_, .6, .008)
    elif proc == "cloth":
        # Multiscale woven fibres, dirt, faded patches. Avoid undersampled wave
        # bands: these alias into the conspicuous corrugations on a baked atlas.
        fibres = g.noise(uvn.outputs[0], 85, 2, .55)
        flecks = g.noise(pos, 72, 3, .65)
        fade = g.noise(pos, 2.2, 5, .65)
        damp = g.noise(pos, 10, 5, .65)
        base = g.mix(g.ramp(fade, .25, .75), tuple(c * .5 for c in r["colour"]), tuple(c * 1.65 for c in r["colour"]))
        base = g.mix(g.math("MULTIPLY", g.ramp(damp, .48, .72), .65), base, (.075, .065, .042))
        base = g.mix(g.math("MULTIPLY", fibres, .2), base, (.3, .27, .19))
        rough = g.mixf(fade, .78, .98)
        normal_out = g.bump(g.math("ADD", fibres, g.math("MULTIPLY", flecks, .45)), .35, .0007)
    elif proc == "char":
        grain = g.noise(g.stretch(pos, 35, 35, 9), 1, 5, .7)
        cracks = g.ramp(grain, .48, .58)
        dust = g.noise(pos, 65, 3, .7)
        base = g.mix(cracks, (.009, .008, .006), (.065, .052, .038))
        base = g.mix(g.math("MULTIPLY", g.ramp(dust, .56, .72), .65), base, (.21, .19, .16))
        rough = .95
        normal_out = g.bump(grain, .7, .012)
    elif proc == "ash":
        coarse = g.noise(pos, 13, 5, .7)
        fine = g.noise(pos, 100, 3, .65)
        base = g.mix(g.ramp(coarse, .3, .68), (.035, .029, .023), (.25, .235, .21))
        base = g.mix(g.math("MULTIPLY", g.ramp(fine, .56, .7), .6), base, (.43, .4, .35))
        rough = .98
        normal_out = g.bump(g.math("ADD", coarse, g.math("MULTIPLY", fine, .3)), .7, .008)
    elif proc == "flat":
        base = g.rgb(r["colour"])
        rough = r["rough"]
        if r.get("metal"):
            metal_out = g.val(r["metal"])
        if r.get("grime"):
            film = g.noise(pos, 22, 6, 0.6)
            base = g.mix(g.math("MULTIPLY", g.ramp(film, 0.5, 0.82), 0.28), base, (0.08, 0.07, 0.055))
            rough = g.mixf(g.ramp(film, 0.45, 0.82), r["rough"], 0.55)
    elif proc == "tyre":
        # Sun-greyed rubber, soil packed into every groove, dust on what faces up.
        base = g.mix(g.ramp(g.noise(pos, 5, 5, .55), .3, .7), (.04, .04, .038), (.075, .074, .07))
        base = g.mix(g.ramp(g.math("ADD", up_z, g.math("MULTIPLY", g.math("SUBTRACT", g.noise(pos, 19, 5, .6), .5), .9)), .35, .95), base, (.17, .15, .12))
        base = g.mix(g.math("MULTIPLY", g.math("SUBTRACT", 1.0, g.ao(.05, samples=6)), 1.4), base, (.11, .08, .05))
        cracks = g.ramp(g.noise(g.stretch(pos, 90, 90, 14), 1.0, 3, .5), .63, .66)
        base = g.mix(g.math("MULTIPLY", cracks, .6), base, (.012, .012, .012))
        rough = .93
        normal_out = g.bump(g.math("SUBTRACT", g.noise(pos, 80, 4, .6), g.math("MULTIPLY", cracks, 1.6)), .4, .004)
    elif proc == "rockbox":
        obj_ = g.node("ShaderNodeTexCoord").outputs["Object"]
        d1 = g.node("ShaderNodeTexImage", image=_image("rock-diff.jpg", True), projection="BOX", projection_blend=.4)
        g.link(g.stretch(obj_, .23, .23, .23), d1.inputs[0])
        d2 = g.node("ShaderNodeTexImage", image=_image("rock-diff.jpg", True), projection="BOX", projection_blend=.4)
        g.link(g.stretch(obj_, .57, .49, .61), d2.inputs[0])
        warp = g.noise(pos, .55, 5, .55)
        blend = g.ramp(g.noise(pos, 1.1, 5, .6, .6), .38, .62)
        rockc = g.mix(blend, d1.outputs[0], d2.outputs[0])
        base = g.mix(g.ramp(warp, .34, .66), g.mix(1.0, rockc, (.6, .6, .57), "MULTIPLY"), g.mix(1.0, rockc, (.98, .95, .86), "MULTIPLY"))
        rough = .95
        grey = g.node("ShaderNodeSeparateColor")
        g.link(rockc, grey.inputs[0])
        fine_b = g.noise(pos, 24, 6, .62)
        normal_out = g.bump(g.math("ADD", grey.outputs[0], g.math("MULTIPLY", fine_b, .5)), .8, .04)
        # Water darkens the rock in vertical lines below every ledge.
        wet = g.ramp(g.noise(g.stretch(pos, 7, 7, .35), 1.0, 5, .55), .52, .74)
        base = g.mix(g.math("MULTIPLY", wet, .7), base, (.32, .32, .3), "MULTIPLY")
        r = dict(r, moss=.85)
    elif proc == "endgrain":
        ring = g.node("ShaderNodeTexWave", wave_type="RINGS", rings_direction="SPHERICAL", wave_profile="SAW")
        offs = g.node("ShaderNodeVectorMath", operation="SUBTRACT")
        g.link(uvn.outputs[0], offs.inputs[0])
        offs.inputs[1].default_value = (0.565, 0.455, 0)
        g.link(offs.outputs[0], ring.inputs["Vector"])
        ring.inputs["Scale"].default_value = 8.5
        ring.inputs["Distortion"].default_value = 4.2
        ring.inputs["Detail"].default_value = 4
        ring.inputs["Detail Scale"].default_value = 1.4
        base = g.mix(g.ramp(ring.outputs["Fac"], 0.3, 0.85), (0.33, 0.26, 0.18), (0.135, 0.1, 0.066))
        # Drying checks radiate from the pith, the saw leaves shallow arcs.
        radial = g.node("ShaderNodeSeparateXYZ")
        g.link(offs.outputs[0], radial.inputs[0])
        angle = g.math("ARCTAN2", radial.outputs["Y"], radial.outputs["X"])
        # The sine crosses zero twice round the end, and the noise walks each crack off a straight line.
        check_wander = g.noise(uvn.outputs[0], 7, 4, .55)
        check = g.ramp(g.math("ABSOLUTE", g.math("SINE", g.math("ADD", angle, g.math("MULTIPLY", check_wander, 2.6)))), .03, .0)
        base = g.mix(g.math("MULTIPLY", check, .8), base, (.03, .02, .012))
        rough = 0.92
        normal_out = g.bump(g.math("SUBTRACT", ring.outputs["Fac"], g.math("MULTIPLY", check, 1.5)), 0.5, 0.006)
    elif proc == "image":
        tex = g.node("ShaderNodeTexImage", image=_image(r["image"], True))
        g.link(uvn.outputs[0], tex.inputs[0])
        grime = g.noise(pos, 18, 6, 0.6)
        base = g.mix(g.math("MULTIPLY", g.ramp(grime, 0.45, 0.75), 0.45), tex.outputs[0], (0.08, 0.075, 0.05), "MULTIPLY")
        # Printing fades and flakes in uneven patches, with rust bleeding down from above.
        fade = g.ramp(g.noise(pos, 2.2, 5, .55), .34, .7)
        base = g.mix(g.math("MULTIPLY", fade, .22), base, (.5, .47, .4))
        run = g.ramp(g.noise(g.stretch(pos, 40, 40, 1.4), 1.0, 4, .5), .56, .8)
        base = g.mix(g.math("MULTIPLY", run, .5), base, (.34, .17, .08), "MULTIPLY")
        rough = 0.9

    if isinstance(base, tuple):
        base = g.rgb(base)
    r = dict(r)
    if DEPTH_DARK:
        # Inside a tunnel no sky reaches: the bake carries the darkness the runtime lighting cannot.
        ygame = g.math("MULTIPLY", height.outputs["Y"], -1.0)
        dark = g.ramp(ygame, DEPTH_DARK[0], DEPTH_DARK[1])
        base = g.mix(g.math("MULTIPLY", dark, .985), base, (.0, .0, .0))
    # Damp, dark vertical streaks wherever rain has run.
    if r.get("streak"):
        own = g.node("ShaderNodeVectorMath", operation="ADD")
        g.link(pos, own.inputs[0])
        g.link(_grey(g, g.math("MULTIPLY", seed_red(g, seed), 37.0)), own.inputs[1])
        s = g.ramp(g.noise(g.stretch(own.outputs[0], 16, 16, 0.75), 1.0, 5, 0.55), 0.6, 0.8)
        base = g.mix(g.math("MULTIPLY", s, r["streak"] * .65), base, (0.16, 0.15, 0.12), "MULTIPLY")
    # Grime in every crevice, far more than a clean AO would give.
    base = g.mix(g.math("MULTIPLY", g.math("SUBTRACT", 1.0, crevice), 0.5), base, (0.12, 0.105, 0.085), "MULTIPLY")
    # Moss: on up-facing timber and stone, thickest near the ground, in patches.
    moss_amount = r.get("moss", 0.0)
    if moss_amount:
        patch = g.noise(pos, 2.6, 7, 0.62, 0.4)
        ground = g.ramp(z, 3.2, 0.1)
        facing = g.ramp(up_z, 0.25, 0.8)
        m = g.math("MULTIPLY", facing, g.math("ADD", g.math("MULTIPLY", ground, 0.35), 0.65))
        cov = g.ramp(g.math("ADD", patch, g.math("MULTIPLY", g.math("SUBTRACT", m, 0.5), 0.35)), 0.57, 0.8)
        cov = g.math("MULTIPLY", g.math("MULTIPLY", cov, m), moss_amount)
        tone = g.noise(pos, 24, 6, 0.65)
        moss = g.mix(g.ramp(tone, 0.35, 0.68), (0.04, 0.06, 0.012), (0.17, 0.21, 0.05))
        base = g.mix(cov, base, moss)
        rough = g.mixf(cov, rough, 1.0)
        fuzz = g.noise(pos, 130, 4, 0.7)
        h = g.math("MULTIPLY", g.math("ADD", g.math("MULTIPLY", fuzz, 0.3), 0.7), cov)
        normal_out = g.bump(h, 0.9, 0.018, normal_out)

    g.link(base, bsdf.inputs["Base Color"])
    g._in(bsdf.inputs["Roughness"], rough)
    if metal_out is not None:
        g.link(metal_out, bsdf.inputs["Metallic"])
    else:
        bsdf.inputs["Metallic"].default_value = 0.0
    if normal_out is not None:
        g.link(normal_out, bsdf.inputs["Normal"])
    mat["has_metal"] = metal_out is not None
    return mat, metal_out


def seed_green(g, seed):
    sep = g.node("ShaderNodeSeparateColor")
    g.link(seed, sep.inputs[0])
    return sep.outputs[1]


def seed_red(g, seed):
    sep = g.node("ShaderNodeSeparateColor")
    g.link(seed, sep.inputs[0])
    return sep.outputs[0]


def _grey(g, v):
    n = g.node("ShaderNodeCombineColor")
    for i in range(3):
        g.link(v, n.inputs[i])
    return n.outputs[0]


# ----------------------------------------------------------------------------
# Scene, atlas, bake, export
# ----------------------------------------------------------------------------
def setup_cycles(samples=24):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "METAL"
    scene.cycles.device = "GPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.margin = 10
    scene.render.bake.use_clear = True
    scene.cycles.max_bounces = 2
    scene.cycles.diffuse_bounces = 1


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for block in (bpy.data.meshes, bpy.data.materials):
        for item in list(block):
            block.remove(item)
    for img in list(bpy.data.images):
        if img.users == 0 or img.name.startswith(("bake_", "atlas_")):
            bpy.data.images.remove(img)
    _images.clear()


def assemble(model):
    names = sorted(model.parts)
    V, N, UV, S, W, F, MI = [], [], [], [], [], [], []
    base = 0
    for mi, name in enumerate(names):
        b = model.parts[name]
        V += b["v"]
        N += b["n"]
        UV += b["uv"]
        S += b["s"]
        W += b["w"]
        for face in b["f"]:
            F.append(face)
            MI.append(mi)
        # faces already index within the bucket: rebase below.
        F[-len(b["f"]):] = [tuple(i + base for i in f) for f in F[-len(b["f"]):]]
        base += b["count"]
    V = to_blender(np.concatenate(V))
    N = to_blender(np.concatenate(N))
    UV = np.concatenate(UV)
    S = np.concatenate(S)
    W = np.concatenate(W)
    mesh = bpy.data.meshes.new(model.name)
    mesh.from_pydata(V.tolist(), [], F)
    mesh.update()
    mesh.polygons.foreach_set("material_index", MI)
    mesh.polygons.foreach_set("use_smooth", np.ones(len(F), bool))
    mesh.normals_split_custom_set_from_vertices(N.tolist())
    tile = mesh.uv_layers.new(name="tile")
    loops = np.zeros(len(mesh.loops), int)
    mesh.loops.foreach_get("vertex_index", loops)
    tile.data.foreach_set("uv", UV[loops].ravel())
    seed = mesh.color_attributes.new("seed", "FLOAT_COLOR", "POINT")
    rgba = np.ones((len(S), 4), np.float32)
    rgba[:, 0] = S
    rgba[:, 1] = W
    rgba[:, 2] = S
    seed.data.foreach_set("color", rgba.ravel())
    obj = bpy.data.objects.new(model.name, mesh)
    bpy.context.collection.objects.link(obj)
    metals = {}
    for name in names:
        mat, metal = build_material(name)
        mesh.materials.append(mat)
        metals[mat.name] = metal
    log(model.name, "triangles", sum(len(p.vertices) - 2 for p in mesh.polygons), "materials", len(names))
    return obj, metals


def pack_atlas(islands, size, margin=3):
    """Shelf-pack metric rectangles at the highest uniform texel density that fits."""
    order = sorted(range(len(islands)), key=lambda i: -min(islands[i][0], islands[i][1]))

    def attempt(scale):
        x = y = shelf = 0.0
        placed = {}
        for i in order:
            w, h = islands[i]
            w, h = max(w, h) * scale + 2 * margin, min(w, h) * scale + 2 * margin
            if x + w > size:
                x, y, shelf = 0.0, y + shelf, 0.0
            if w > size or y + h > size:
                return None
            placed[i] = (x + margin, y + margin)
            x += w
            shelf = max(shelf, h)
        return placed
    lo, hi = 1.0, 8000.0
    best = attempt(lo)
    for _ in range(26):
        mid = (lo * hi) ** .5
        got = attempt(mid)
        if got is not None:
            lo, best = mid, got
        else:
            hi = mid
    return best, lo


def atlas_uv(obj, model):
    names = sorted(model.parts)
    islands, spans = [], []
    base = 0
    uvs = []
    for name in names:
        b = model.parts[name]
        tile = np.concatenate(b["uv"])
        uvs.append(tile)
        for start, count, k, density in b["islands"]:
            part = tile[start:start + count] * k
            lo = part.min(axis=0)
            size = part.max(axis=0) - lo
            spans.append((base + start, count, k, lo, density))
            islands.append((max(size[0], 1e-3) * density, max(size[1], 1e-3) * density))
        base += b["count"]
    placed, scale = pack_atlas(islands, model.tex)
    tile = np.concatenate(uvs)
    out = np.zeros_like(tile)
    for i, (start, count, k, lo, density) in enumerate(spans):
        local = (tile[start:start + count] * k - lo) * density * scale
        w, h = islands[i]
        if w * scale >= h * scale:
            uv = local
        else:
            uv = local[:, ::-1]
        out[start:start + count] = (uv + placed[i]) / model.tex
    atlas = obj.data.uv_layers.new(name="atlas")
    obj.data.uv_layers.active = atlas
    loops = np.zeros(len(obj.data.loops), int)
    obj.data.loops.foreach_get("vertex_index", loops)
    atlas.data.foreach_set("uv", out[loops].ravel())
    log(model.name, "islands", len(islands), "texels per metre", round(scale, 1))


def _bake_target(name, size, colour=False):
    img = bpy.data.images.new(f"bake_{name}", size, size, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    return img


def _set_targets(obj, img):
    for mat in obj.data.materials:
        tree = mat.node_tree
        node = tree.nodes.get("bake_target") or tree.nodes.new("ShaderNodeTexImage")
        node.name = "bake_target"
        node.image = img
        tree.nodes.active = node


def _pixels(img, size):
    arr = np.empty(size * size * 4, np.float32)
    img.pixels.foreach_get(arr)
    return arr.reshape(size, size, 4)


def _save(name, arr):
    """arr is linear or data; `name` ends with _albedo for sRGB encoding."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False)
    data = arr.copy()
    if name.endswith("albedo"):
        data[..., :3] = np.where(data[..., :3] <= 0.0031308, data[..., :3] * 12.92, 1.055 * np.maximum(data[..., :3], 1e-5) ** (1 / 2.4) - 0.055)
    data[..., 3] = 1
    img.pixels.foreach_set(np.clip(data, 0, 1).ravel())
    img.filepath_raw = os.path.join(SOURCE, name + ".png")
    img.file_format = "PNG"
    img.save()
    return img


def bake_model(obj, metals, size, samples=24, high=None):
    scene = bpy.context.scene
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bake = bpy.ops.object.bake
    # Base colour.
    img = _bake_target("albedo", size)
    _set_targets(obj, img)
    scene.cycles.samples = samples
    bake(type="DIFFUSE", pass_filter={"COLOR"}, margin=10)
    albedo = _pixels(img, size)
    # Roughness.
    scene.cycles.samples = max(8, samples // 2)
    img = _bake_target("rough", size)
    _set_targets(obj, img)
    bake(type="ROUGHNESS", margin=10)
    rough = _pixels(img, size)
    # Tangent-space normal.
    img = _bake_target("normal", size)
    _set_targets(obj, img)
    if high is None:
        bake(type="NORMAL", normal_space="TANGENT", margin=10)
    else:
        high.hide_render = False
        high.hide_set(False)
        high.select_set(True)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bake(type="NORMAL", normal_space="TANGENT", margin=10, use_selected_to_active=True, cage_extrusion=.35, max_ray_distance=.8)
        high.select_set(False)
        high.hide_render = True
        high.hide_set(True)
    normal = _pixels(img, size)
    # Metal, by driving emission from each material's metal value.
    metal_arr = np.zeros((size, size, 4), np.float32)
    if any(m is not None for m in metals.values()):
        img = _bake_target("metal", size)
        _set_targets(obj, img)
        saved = []
        for mat in obj.data.materials:
            tree = mat.node_tree
            out = tree.nodes["Material Output"]
            old = out.inputs["Surface"].links[0].from_socket
            em = tree.nodes.new("ShaderNodeEmission")
            em.inputs["Strength"].default_value = 1
            source = metals[mat.name]
            if source is not None:
                tree.links.new(source, em.inputs["Color"])
            else:
                em.inputs["Color"].default_value = (0, 0, 0, 1)
            tree.links.new(em.outputs[0], out.inputs["Surface"])
            saved.append((tree, old, out))
        bake(type="EMIT", margin=10)
        for tree, old, out in saved:
            tree.links.new(old, out.inputs["Surface"])
        metal_arr = _pixels(img, size)
    # Ambient occlusion, with a temporary ground plane for contact shadow.
    bpy.ops.mesh.primitive_plane_add(size=120, location=(0, 0, -0.005))
    ground = bpy.context.active_object
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    scene.cycles.samples = samples * 2
    img = _bake_target("ao", size)
    _set_targets(obj, img)
    scene.world = scene.world or bpy.data.worlds.new("bake")
    scene.world.light_settings.distance = 4.0
    bake(type="AO", margin=10)
    ao = _pixels(img, size)[..., 0]
    bpy.data.objects.remove(ground)
    # Compose.
    a = albedo.copy()
    a[..., :3] *= (0.58 + 0.42 * ao)[..., None]
    orm = np.ones((size, size, 4), np.float32)
    orm[..., 0] = ao
    orm[..., 1] = rough[..., 0]
    orm[..., 2] = metal_arr[..., 0]
    name = obj.name
    return _save(f"atlas_{name}_albedo", a), _save(f"atlas_{name}_normal", normal), _save(f"atlas_{name}_orm", orm)


def finalise(obj, albedo, normal, orm):
    mat = bpy.data.materials.new(f"{obj.name} baked")
    mat.use_nodes = True
    mat.use_backface_culling = False
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    uv = tree.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "atlas"
    a = tree.nodes.new("ShaderNodeTexImage")
    a.image = albedo
    albedo.colorspace_settings.name = "sRGB"
    tree.links.new(uv.outputs[0], a.inputs[0])
    tree.links.new(a.outputs[0], bsdf.inputs["Base Color"])
    n = tree.nodes.new("ShaderNodeTexImage")
    n.image = normal
    normal.colorspace_settings.name = "Non-Color"
    tree.links.new(uv.outputs[0], n.inputs[0])
    nm = tree.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "atlas"
    tree.links.new(n.outputs[0], nm.inputs["Color"])
    tree.links.new(nm.outputs[0], bsdf.inputs["Normal"])
    r = tree.nodes.new("ShaderNodeTexImage")
    r.image = orm
    orm.colorspace_settings.name = "Non-Color"
    tree.links.new(uv.outputs[0], r.inputs[0])
    sep = tree.nodes.new("ShaderNodeSeparateColor")
    tree.links.new(r.outputs[0], sep.inputs[0])
    tree.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    tree.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj.data.uv_layers.remove(obj.data.uv_layers["tile"])
    obj.data.uv_layers.active = obj.data.uv_layers["atlas"]
    if "seed" in obj.data.color_attributes:
        obj.data.color_attributes.remove(obj.data.color_attributes["seed"])


def export(obj, quality=82):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(OUT, obj.name + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False, export_animations=False, export_yup=True, export_normals=True, export_texcoords=True, export_materials="EXPORT", export_image_format="WEBP", export_image_quality=quality, export_vertex_color="NONE" if False else "MATERIAL")
    log(obj.name, "exported", round(os.path.getsize(path) / 1e6, 2), "MB")


def preview(obj, name, shots, res=(1280, 860), samples=64):
    """Quick lit look before anything goes in the game."""
    scene = bpy.context.scene
    bpy.ops.mesh.primitive_plane_add(size=300, location=(0, 0, -0.01))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("ground")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.055, 0.035, 1)
    gm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1
    ground.data.materials.append(gm)
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(58), 0, math.radians(38))
    sun.data.energy = 2.2
    sun.data.angle = math.radians(8)
    w = bpy.data.worlds.new("sky")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.62, 0.68, 1)
    w.node_tree.nodes["Background"].inputs[1].default_value = 0.65
    scene.world = w
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.cycles.samples = samples
    scene.cycles.max_bounces = 4
    scene.cycles.use_denoising = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    os.makedirs(os.path.join(SOURCE, "previews"), exist_ok=True)
    from mathutils import Vector
    cams = []
    for i, (loc, target, lens) in enumerate(shots):
        cam = bpy.data.objects.new(f"cam{i}", bpy.data.cameras.new(f"cam{i}"))
        bpy.context.collection.objects.link(cam)
        cam.location = tuple(to_blender(np.array(loc)))
        cam.data.lens = lens
        cam.data.clip_end = 900
        cam.rotation_euler = (Vector(tuple(to_blender(np.array(target)))) - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam
        scene.render.filepath = os.path.join(SOURCE, "previews", f"{name}_{i}.jpg")
        scene.render.image_settings.file_format = "JPEG"
        scene.render.image_settings.quality = 90
        bpy.ops.render.render(write_still=True)
        cams.append(cam)
    for o in cams + [ground, sun]:
        bpy.data.objects.remove(o)


def _sdf_object(name, verts, quads):
    mesh = bpy.data.meshes.new(name)
    v = to_blender(verts)
    mesh.vertices.add(len(v))
    mesh.vertices.foreach_set("co", v.ravel())
    mesh.loops.add(quads.size)
    mesh.loops.foreach_set("vertex_index", quads.ravel())
    mesh.polygons.add(len(quads))
    mesh.polygons.foreach_set("loop_start", np.arange(0, quads.size, 4))
    mesh.update(calc_edges=True)
    mesh.polygons.foreach_set("use_smooth", np.ones(len(mesh.polygons), bool))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def build_rock(name, high_v, high_q, low_v, low_q, tex=2048, shots=None, colliders=(), hooks=None, radius=8):
    """An organic SDF surface: clean low mesh for the shape, normals baked from the full surface."""
    clear_scene()
    setup_cycles()
    obj = _sdf_object(name, low_v, low_q)
    high = _sdf_object(name + "_high", high_v, high_q)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mesh = obj.data
    seed = mesh.color_attributes.new("seed", "FLOAT_COLOR", "POINT")
    seed.data.foreach_set("color", np.full(len(mesh.vertices) * 4, .5, np.float32))
    mesh.uv_layers.new(name="tile")
    atlas = mesh.uv_layers.new(name="atlas")
    mesh.uv_layers.active = atlas
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=.003, area_weight=.8)
    bpy.ops.uv.pack_islands(margin=.004, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    mat, metal = build_material("rock")
    mesh.materials.append(mat)
    high.data.materials.append(mat)
    log(name, "triangles", sum(len(p.vertices) - 2 for p in mesh.polygons))
    high.hide_render = True
    high.hide_set(True)
    albedo, normal, orm = bake_model(obj, {mat.name: metal}, tex, 18, high=high)
    bpy.data.objects.remove(high)
    finalise(obj, albedo, normal, orm)
    export(obj)
    if shots:
        preview(obj, name, shots)
    return dict(url=f"/world/{name}.glb", radius=radius, colliders=list(colliders), hooks=hooks or {})


def build(model, shots=None, samples=20):
    """Author -> atlas -> bake -> GLB. Returns the asset's JSON entry."""
    clear_scene()
    setup_cycles()
    obj, metals = assemble(model)
    atlas_uv(obj, model)
    albedo, normal, orm = bake_model(obj, metals, model.tex, samples)
    log(model.name, "baked")
    finalise(obj, albedo, normal, orm)
    export(obj)
    if shots and os.environ.get("SILENCE_ASSET_PREVIEW", "1") != "0":
        preview(obj, model.name, shots)
    return dict(url=f"/world/{model.name}.glb", radius=model.radius, colliders=model.colliders, hooks=model.hooks, ladders=model.ladders)
