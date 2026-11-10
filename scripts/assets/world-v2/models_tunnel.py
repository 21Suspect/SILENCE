"""Where the road goes into the mountain: a 1930s concrete portal, and the rockfall that shut it."""
import math
import os

import numpy as np

import kit
from kit import Model, poster_material, ROOT
import models_poi2  # noqa: F401  (registers the aged finishes)
from models_poi2 import rubble

ART = os.path.join(ROOT, "assets/world-v2/art")
SP, R, HW, DEPTH = 2.7, 3.1, 7.7, 8.6      # springing height, arch radius, headwall height, lined length


def profile(t):
    """Inner face of the bore, t in 0..1 from the left foot over the crown to the right foot. Returns (x, y, nx, ny) with the normal pointing into the bore."""
    total = 2 * SP + math.pi * R
    s = t * total
    if s < SP:
        return -R, s, 1.0, 0.0
    if s > SP + math.pi * R:
        return R, total - s, -1.0, 0.0
    a = (s - SP) / R
    return -R * math.cos(a), SP + R * math.sin(a), math.cos(a), -math.sin(a)


def boulder(m, c, r, seed, mat="stone", squash=(1.0, .72, .9), n=(14, 9)):
    c = np.asarray(c, float)
    def fn(u, v):
        th, ph = u * math.tau, v * math.pi
        d = np.array((math.sin(ph) * math.cos(th), math.cos(ph), math.sin(ph) * math.sin(th)))
        rr = r * (1 + .2 * math.sin(3 * th + seed) * math.sin(ph) + .14 * math.sin(4 * ph + seed * 2) + .09 * math.sin(5 * th + 3 * ph + seed * 3) + .06 * math.sin(9 * th - 5 * ph + seed))
        return c + d * rr * np.asarray(squash)
    m.surface(mat, fn, n[0], n[1], (4 * r, 2.5 * r), flip=True, wear=lambda u, v: .3 + .4 * (1 - v))


def tunnel():
    for n in ("sign_tunnel", "plate_tunnel"):
        poster_material(n, os.path.join(ART, n + ".png"))
    m = Model("tunnel", tex=4096, seed=401)
    rng = m.rng
    CO = "concrete_old"
    PX = 6.6           # half width of the headwall
    T = .9
    # Headwall: two piers and the spandrel over the arch, a coping along the top.
    for s in (-1, 1):
        m.box((s * (PX + R) / 2, HW / 2 - .3, -T / 2), (PX - R, HW + .6, T), CO, chamfer=.02)
        m.collide_box(s * (PX + R) / 2, -T / 2, (PX - R) / 2, T / 2, -.4, HW, tag="tunnel headwall")
    def spandrel(u, v):
        x = (u - .5) * 2 * R
        ya = SP + math.sqrt(max(0.0, R * R - x * x))
        return np.array((x, ya + v * (HW - ya), 0.0))
    m.surface(CO, spandrel, 24, 6, (4 * R, 2 * (HW - SP)), flip=False, wear=lambda u, v: .3 + .5 * v)
    m.collide_box(0, -T / 2, R, T / 2, SP + R - .9, HW, tag="tunnel headwall")
    m.beam((-PX - .25, HW + .15, -T / 2 + .1), (PX + .25, HW + .15, -T / 2 + .1), T + .5, .34, CO, chamfer=.04)
    # Dressed stone round the opening: quoins up the jambs, voussoirs over the arch, a keystone.
    for s in (-1, 1):
        y = -.1
        k = 0
        while y < SP - .1:
            h_ = rng.uniform(.4, .52)
            deep = .62 if k % 2 == 0 else .42
            m.beam((s * (R + deep / 2), y, -.07), (s * (R + deep / 2), min(y + h_, SP) - .012, -.07), deep, .34, "stone", up=(0, 0, 1), chamfer=.035)
            y += h_
            k += 1
    NV = 17
    for i in range(NV):
        a0, a1 = math.pi * i / NV, math.pi * (i + 1) / NV
        am = (a0 + a1) / 2
        key = i == NV // 2
        deep = .78 if key else rng.uniform(.5, .6)
        rad = np.array((-math.cos(am), math.sin(am), 0))
        tan = np.array((math.sin(am), math.cos(am), 0))
        c = np.array((0, SP, -.07 + (.05 if key else 0))) + rad * (R + deep / 2)
        L = (R + deep / 2) * (a1 - a0) - .014
        m.beam(c - tan * L / 2, c + tan * L / 2, .34 + (.08 if key else 0), deep, "stone", up=rad, chamfer=.035)
    # The name of the tunnel cast into the wall over the keystone, and the closure notice bolted to a pier.
    m.poster("plate_tunnel", (0, HW - .62, .012), (1, 0, 0), (0, 1, 0), 2.6, .82, density=2)
    m.beam((-1.36, HW - .62, .0), (1.36, HW - .62, .0), .9, .03, CO, up=(0, 0, 1), chamfer=.004)
    m.box((4.75, 2.2, .02), (1.56, .7, .04), "galv", chamfer=.004)
    m.poster("sign_tunnel", (4.75, 2.2, .0425), (1, 0, 0), (0, 1, 0), 1.5, .64, density=3)
    for (x, y) in ((4.05, 2.48), (5.45, 2.48), (4.05, 1.92), (5.45, 1.92)):
        m.bolt((x, y, .042), (0, 0, 1), .012)
    # Wing walls step down along the cutting on both sides.
    for s in (-1, 1):
        a = np.array((s * (PX - .3), 0.0, .0))
        d = np.array((s * .42, 0, .907))
        hs = (6.2, 4.9, 3.6, 2.3)
        for i, h_ in enumerate(hs):
            p0, p1 = a + d * (i * 2.1), a + d * ((i + 1) * 2.1 + .02)
            m.beam(p0 + (0, h_ / 2 - .3, 0), p1 + (0, h_ / 2 - .3, 0), .62 - i * .014, h_ + .6, CO, chamfer=.02)
            m.beam(p0 + (0, h_ + .08, 0) - d * .05, p1 + (0, h_ + .08, 0) + d * .05, .82 - i * .014, .2, CO, chamfer=.03)
            m.collide_post(p0[0], p0[2], p1[0], p1[2], .36, 0, h_, "wing wall")
    # The lining: concrete with ribs, a cable run and dead lamps.
    def lining(u, v):
        # Six millimetres inside the masonry, so the lining never shares a plane with the piers or the dressed stone.
        x, y, nx, ny = profile(u)
        return np.array((x + nx * .006, y + ny * .006, .0 - v * DEPTH))
    m.surface(CO, lining, 40, 10, (2 * (2 * SP + math.pi * R), 2 * DEPTH), flip=True, density=.7, wear=lambda u, v: .4)
    for zr in (-1.6, -3.6, -5.6):
        NS = 26
        for i in range(NS):
            x0, y0, nx0, ny0 = profile(i / NS)
            x1, y1, nx1, ny1 = profile((i + 1) / NS)
            nx, ny = (nx0 + nx1) / 2, (ny0 + ny1) / 2
            m.beam((x0 + nx * .06, y0 + ny * .06, zr), (x1 + nx * .06, y1 + ny * .06, zr), .34, .16, CO, up=(nx, ny, 0), chamfer=.02)
    m.box((0, HW / 2, -DEPTH - .2), (2 * R + .4, HW, .3), "void", chamfer=.002)
    for s in (-1, 1):
        m.collide_box(s * (R + .3), -DEPTH / 2, .3, DEPTH / 2, 0, HW, tag="tunnel wall")
    m.tube([(-R + .1, 3.0, .4), (-R + .1, 3.0, -DEPTH + 2.5)], .03, "rubber", 6)
    m.tube([(-R + .13, 3.12, .4), (-R + .13, 3.1, -1.9), (-R + .5, 2.2, -2.6), (-R + .9, .4, -2.9)], .016, "rubber", 6)
    for z in (-.3, -1.0, -2.2):
        m.box((-R + .06, 3.0, z), (.1, .1, .05), "steel_bare", chamfer=.006)
    for z in (-.8, -2.8):
        m.box((0, SP + R - .14, z), (.34, .12, .7), "steel", chamfer=.012)
        m.lathe([(.12, 0), (.14, .5), (.12, 1)], (0, SP + R - .26, z - .26), (0, SP + R - .26, z + .26), "glass", 10)
        m.tube([(0, SP + R - .02, z), (0, SP + R - .09, z)], .02, "steel_bare", 6)
    # Roadway: the tarmac runs a few metres in under the fall.
    m.box((0, -.03, -DEPTH / 2 + .6), (2 * R - .02, .14, DEPTH + 1.2), "asphalt", chamfer=.004)
    m.collide_box(0, -DEPTH / 2 + .6, R, DEPTH / 2 + .6, -.2, .04, tag="tunnel road")
    for s in (-1, 1):
        m.beam((s * (R - .32), .1, 1.2), (s * (R - .32), .1, -3.4), .3, .16, CO, chamfer=.02)
    # The fall: a talus slope from the road to the crown, big blocks bedded in it, smaller stuff run out towards the mouth.
    def pile(x, z):
        t = max(0.0, min(1.0, (-2.0 - z) / 3.4))
        edge = 1 - .12 * (abs(x) / R) ** 2
        return (SP + R + .3) * (t ** .85) * edge + .12 * math.sin(x * 3.1 + z * 2.3) * t + .08 * math.sin(x * 7 - z * 5) * t
    m.surface("mine_rubble", lambda u, v: np.array(((u - .5) * (2 * R - .04), pile((u - .5) * 2 * R, -2.0 - v * 3.6) + .02, -2.0 - v * 3.6)), 22, 22, (12, 9), density=1.6)
    spots = [(-1.9, -2.5, 1.0), (.6, -2.9, 1.25), (2.2, -2.7, .85), (-.8, -3.6, 1.2), (1.7, -3.9, 1.15), (-2.3, -3.9, .9), (.2, -4.5, 1.3), (-1.5, -4.8, 1.0), (2.1, -4.9, .95), (.6, -5.4, 1.1), (-.9, -5.6, .9)]
    for i, (x, z, r) in enumerate(spots):
        y = pile(x, z) + r * .22
        boulder(m, (x, y, z), r * .62, i * 1.7 + 1, "stone" if i % 3 else "mine_rubble")
    # Blocks that came all the way out.
    out = [(-1.3, -1.1, .62), (1.5, -.6, .5), (.3, -1.5, .7), (2.4, -1.5, .42), (-2.3, .2, .38), (.9, .6, .3)]
    for i, (x, z, r) in enumerate(out):
        boulder(m, (x, r * .5, z), r, i * 2.3 + 4, "stone", n=(12, 8))
        m.collide_post(x, z, x, z, r * .9, 0, r * 1.1, "fallen rock")
    rubble(m, .2, -.6, 26, 2.6, "mine_rubble", size=(.1, .3))
    rubble(m, -.6, 1.6, 10, 2.2, "mine_rubble", size=(.07, .18))
    m.collide_box(0, -4.6, R, 2.4, 0, HW, tag="rockfall")
    m.collide_box(0, -2.6, R, .5, 0, 1.6, tag="rockfall")
    m.radius = 13
    return m


def tunnel_built():
    kit.DEPTH_DARK = (-1.2, -6.5)
    try:
        return kit.build(tunnel(), None)
    finally:
        kit.DEPTH_DARK = None


ASSETS = {"tunnel": (tunnel_built, None)}
