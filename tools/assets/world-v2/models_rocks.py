"""Outcrops and the hillside the mine is cut into, sculpted as signed distance fields.

Rock forms from dipping strata and vertical joints, not from noise alone: a low mesh
carries the silhouette and a normal map baked from the full-resolution surface carries the rest.
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../creature-v2"))
import sdf  # noqa: E402

import kit  # noqa: E402


def _rotated_box(c, half, yaw, tilt, radius):
    cy, sy, ct, st = math.cos(yaw), math.sin(yaw), math.cos(tilt), math.sin(tilt)

    def fn(p):
        x, y, z = p[0] - c[0], p[1] - c[1], p[2] - c[2]
        u = x * cy - z * sy
        w = x * sy + z * cy
        v = y * ct - u * st
        u2 = y * st + u * ct
        qx, qy, qz = np.abs(u2) - (half[0] - radius), np.abs(v) - (half[1] - radius), np.abs(w) - (half[2] - radius)
        outside = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2)
        return outside + np.minimum(np.maximum(np.maximum(qx, qy), qz), 0) - radius
    r = max(half) * 1.7
    return fn, (np.subtract(c, r), np.add(c, r))


def cleave(field, seed, centre, radius, count=26, depth=(.72, 1.02)):
    """Fracture planes shear the body into hard facets, the way rock actually breaks."""
    rng = np.random.RandomState(seed + 500)
    x, y, z = field.coords(tuple(slice(0, n) for n in field.n))
    cx, cy, cz = centre
    for _ in range(count):
        n = rng.normal(size=3)
        n[1] = abs(n[1]) * .7 - .08    # mostly side and upper faces; slight undercuts allowed
        n /= np.linalg.norm(n)
        off = rng.uniform(*depth) * radius * np.array((1.0, .72, 1.0)).dot(np.abs(n))
        plane = (x - cx) * n[0] + (y - cy) * n[1] + (z - cz) * n[2] - off
        # Each fracture only reaches so far, so the body is not one convex gem.
        keep = rng.normal(size=3)
        keep /= np.linalg.norm(keep)
        patch_ = sdf.smoothstep(radius * .55, radius * .95, np.abs((x - cx) * keep[0] + (y - cy) * keep[1] + (z - cz) * keep[2]) * rng.uniform(.6, 1.3))
        field.d[:] = np.maximum(field.d, plane + patch_ * radius * 1.4)


def weather(field, seed, amp=1.0, band=1.3, dip=.28, azimuth=.7):
    """Ledges along irregular beds, joints that end and offset, and a little roughness."""
    nx, ny, nz = math.sin(dip) * math.cos(azimuth), math.cos(dip), math.sin(dip) * math.sin(azimuth)
    s = seed * 17.3
    rng = np.random.RandomState(seed + 91)
    sets = []
    for _ in range(3):
        a_, t_ = rng.uniform(0, 3.14), rng.uniform(-.3, .3)
        sets.append((math.cos(a_) * math.cos(t_), math.sin(t_), math.sin(a_) * math.cos(t_), rng.uniform(.55, 1.5), rng.uniform(0, 9)))

    def fn(p):
        x, y, z = p
        warp = sdf.fbm(x * .12 + s, y * .14, z * .12 - s, 3) * 1.6
        h_ = x * nx + y * ny + z * nz + warp * 1.4
        bed = (h_ + np.sin(h_ * .9 + s) * .7 + np.sin(h_ * 2.3 - s) * .22) * .62
        phase = bed - np.floor(bed)
        ledge = sdf.smoothstep(.0, .1, phase) * (1 - sdf.smoothstep(.85, 1.0, phase))
        strength = sdf.smoothstep(-.2, .3, sdf.fbm(x * .19 - s, y * .27 + s, z * .19, 2))
        ledges = (.5 - ledge) * .2 * strength
        cracks = 0.0
        for jx, jy, jz, freq, ph in sets:
            coord = (x * jx + y * jy + z * jz + warp * .55) * freq + ph
            line = np.abs(coord - np.round(coord))
            # A joint opens along only part of its length, then pinches shut.
            extent = sdf.smoothstep(.0, .35, sdf.fbm(x * .3 + ph, y * .3, z * .3 - ph, 2))
            cracks = cracks + (1 - sdf.smoothstep(.0, .035, line)) * .2 * extent
        broad = sdf.fbm(x * .3 + s, y * .36, z * .3 - s, 2) * .32
        fine = sdf.fbm(x * 1.7, y * 2.0, z * 1.7, 3) * .05
        return (broad + fine + ledges + cracks) * amp
    field.displace(fn, band)


def talus(field, rng, centre, r0, r1, count, s0=.14, s1=.5, band=None):
    """Angular fallen pieces at the foot, sharp-cornered, never pebbles of toothpaste."""
    for i in range(count):
        a = rng.uniform(0, 6.28)
        r = rng.uniform(r0, r1)
        s = rng.uniform(s0, s1)
        c = (centre[0] + math.cos(a) * r, s * .3, centre[2] + math.sin(a) * r)
        fn, bounds = _rotated_box(c, (s * rng.uniform(.8, 1.3), s * rng.uniform(.55, .9), s * rng.uniform(.8, 1.3)), rng.uniform(0, 3.14), rng.uniform(-.4, .4), s * .08)
        field.union(fn, bounds, k=.03)


def close(field):
    d = field.d
    d[0, :, :] = d[-1, :, :] = d[:, 0, :] = d[:, -1, :] = d[:, :, 0] = d[:, :, -1] = .3


def largest(verts, quads):
    """Keeps only the main body: stray fragments of surface are not rocks."""
    parent = np.arange(len(verts))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for q in quads:
        root = find(q[0])
        for i in q[1:]:
            parent[find(i)] = root
    roots = np.array([find(i) for i in range(len(verts))])
    used = roots[quads[:, 0]]
    values, counts = np.unique(used, return_counts=True)
    keep = values[counts.argmax()]
    q = quads[used == keep]
    idx, inverse = np.unique(q, return_inverse=True)
    return verts[idx], inverse.reshape(q.shape)


def meshes(f, step):
    close(f)
    hv, hq = largest(*sdf.surface_nets(f.d, f.lo, f.h))
    hv = sdf.relax(hv, hq, 1, .5)
    low = f.d[::step, ::step, ::step].copy()
    low[0, :, :] = low[-1, :, :] = low[:, 0, :] = low[:, -1, :] = low[:, :, 0] = low[:, :, -1] = .3
    lv, lq = largest(*sdf.surface_nets(low, f.lo, f.h * step))
    lv = sdf.relax(lv, lq, 3, .55)
    return hv, hq, lv, lq


def outcrop(name, seed):
    rng = np.random.RandomState(seed)
    size = rng.uniform(3.6, 5.6)
    h = .06
    f = sdf.Field((-size * 1.7 - 2, -1.3, -size * 1.7 - 2), (size * 1.7 + 2, size * 1.15 + 2, size * 1.7 + 2), h)
    n = 2 + seed % 3
    for i in range(n):
        a = i / n * 6.28 + rng.uniform(-.8, .8)
        r = rng.uniform(.05, .75) * size
        c = (math.cos(a) * r, rng.uniform(-.25, .15) * size, math.sin(a) * r)
        half = (rng.uniform(.7, 1.2) * size, rng.uniform(.4, .8) * size, rng.uniform(.45, .9) * size)
        fn, bounds = _rotated_box(c, half, rng.uniform(0, 3.14), rng.uniform(-.3, .3), .25)
        f.union(fn, bounds, k=.5)
    cleave(f, seed, (0, size * .1, 0), size * 1.15)
    weather(f, seed, dip=rng.uniform(.12, .42), azimuth=rng.uniform(0, 6), band=1.0)
    talus(f, rng, (0, 0, 0), size * .95, size * 1.45, 9, .34, .72)
    f.d[:, :int(1.0 / h), :] = np.minimum(f.d[:, :int(1.0 / h), :], .3)
    hv, hq, lv, lq = meshes(f, 5)
    col = [dict(kind="capsule", ax=0, az=0, bx=0, bz=0, radius=size * .95, minY=-1, maxY=size * .9, tag="rock")]
    return kit.build_rock(name, hv, hq, lv, lq, 2048, None, col, radius=size * 1.8)


def minerock():
    """Bedrock where the adit was driven; the hillside itself is terrain and buries everything behind."""
    h = .085
    f = sdf.Field((-12, -1.6, -14), (12, 9, 3.2), h)
    def face(p):
        """Horseshoe wall in plan, open to the yard. The terrain climbs past its top edge and buries everything behind."""
        x, y, z = p
        front = 1.0 + .05 * x ** 2
        taper = sdf.smoothstep(7.0, 13.0, np.abs(x))
        top = 5.3 * (1 - taper) + .35 + .17 * np.maximum(front - z, 0) * np.exp(-(x / 3.2) ** 2)
        ridge = sdf.fbm(x * .55 + 3.1, y * .55, z * .55 - 1.7, 3) * .75
        return np.maximum(np.maximum(z - front + ridge, y - top + ridge * .55), -(z + 13.0)) * .72
    f.d[:] = np.minimum(f.d, np.asarray(face(f.coords(tuple(slice(0, n) for n in f.n))), f.d.dtype))
    cleave(f, 9, (0, 2.2, -5), 12.0, count=46, depth=(.8, 1.05))
    weather(f, 9, 1.0, 1.2, dip=.22, azimuth=2.0)
    # A squared heading with ragged rock around it; the timber set carries the opening.
    def bore(p):
        x, y, z = p
        ragged = sdf.fbm(x * 1.4, y * 1.4, z * 1.4, 3) * .16 * sdf.smoothstep(-2.5, 1.5, z)
        qx, qy, qz = np.abs(x) - 1.6, np.abs(y - 1.2) - 1.95, np.abs(z + 3.4) - 6.6
        return np.maximum(np.maximum(qx, qy), qz) + ragged
    f.subtract(bore, ((-2.6, -1.6, -10.5), (2.6, 3.8, 3.8)), k=.1)
    rng = np.random.RandomState(4)
    f.d[:, :int(1.3 / h), :] = np.minimum(f.d[:, :int(1.3 / h), :], .4)
    hv, hq, lv, lq = meshes(f, 3)
    col = [
        dict(kind="box", x=-4.2, z=-5.4, halfX=2.6, halfZ=6.4, yaw=0, minY=-1, maxY=9, tag="rock"),
        dict(kind="box", x=4.2, z=-5.4, halfX=2.6, halfZ=6.4, yaw=0, minY=-1, maxY=9, tag="rock"),
        dict(kind="box", x=0, z=-10.8, halfX=3, halfZ=.8, yaw=0, minY=-1, maxY=9, tag="rock"),
        dict(kind="box", x=0, z=-4.5, halfX=3, halfZ=5.8, yaw=0, minY=3.15, maxY=9, tag="rock"),
    ]
    kit.DEPTH_DARK = (-1.0, -6.5)
    try:
        return kit.build_rock("minerock", hv, hq, lv, lq, 2048, None, col, radius=13)
    finally:
        kit.DEPTH_DARK = None


def tunnelrock():
    """The rock the road tunnel is driven into: a face behind and above the portal, its flanks dying into the hillside."""
    h = .1
    f = sdf.Field((-14.5, -1.6, -14), (14.5, 12.0, 5.5), h)
    def face(p):
        x, y, z = p
        ax = np.abs(x)
        front = -1.25 + .012 * x ** 2 + .09 * np.maximum(ax - 6.6, 0) ** 2
        taper = sdf.smoothstep(8.5, 13.6, ax)
        top = 10.4 * (1 - taper) + .35 + .12 * np.maximum(front - z, 0) * np.exp(-(x / 5.0) ** 2)
        ridge = sdf.fbm(x * .5 + 7.3, y * .5, z * .5 - 2.9, 3) * .8
        return np.maximum(np.maximum(z - front + ridge, y - top + ridge * .55), -(z + 13.0)) * .72
    f.d[:] = np.minimum(f.d, np.asarray(face(f.coords(tuple(slice(0, n) for n in f.n))), f.d.dtype))
    cleave(f, 17, (0, 4.5, -5), 14.0, count=56, depth=(.8, 1.05))
    weather(f, 17, 1.0, 1.2, dip=.3, azimuth=.9)
    # The bore. The concrete lining stands inside it, so it only has to be bigger than the lining and smaller than the headwall.
    def bore(p):
        x, y, z = p
        return np.maximum(np.maximum(np.abs(x) - 3.45, np.abs(y - 2.3) - 4.05), np.abs(z + 4.4) - 5.7)
    f.subtract(bore, ((-4.2, -1.6, -10.6), (4.2, 6.9, 1.8)), k=.1)
    f.d[:, :int(1.3 / h), :] = np.minimum(f.d[:, :int(1.3 / h), :], .4)
    hv, hq, lv, lq = meshes(f, 3)
    col = [
        dict(kind="box", x=-8.4, z=-6.8, halfX=4.9, halfZ=6.0, yaw=0, minY=-1, maxY=11, tag="rock"),
        dict(kind="box", x=8.4, z=-6.8, halfX=4.9, halfZ=6.0, yaw=0, minY=-1, maxY=11, tag="rock"),
        dict(kind="box", x=0, z=-11.6, halfX=3.5, halfZ=1.4, yaw=0, minY=-1, maxY=11, tag="rock"),
        dict(kind="box", x=0, z=-5.6, halfX=3.5, halfZ=4.6, yaw=0, minY=6.4, maxY=11, tag="rock"),
    ]
    return kit.build_rock("tunnelrock", hv, hq, lv, lq, 4096, None, col, radius=18)


def rock_builder(i, c):
    return lambda: outcrop(f"rock_{c}", 11 + i * 7)


ASSETS = {"minerock": (minerock, None), "tunnelrock": (tunnelrock, None)}
for i, c in enumerate("abcd"):
    ASSETS[f"rock_{c}"] = (rock_builder(i, c), None)
