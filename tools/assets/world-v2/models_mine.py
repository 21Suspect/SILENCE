"""Timber sets, rails and an ore cart in the mouth of the adit. The rock is models_rocks.minerock."""
import math

import numpy as np

from kit import Model, poster_material, ROOT
import os
import kit


def cart(m, x, z):
    """Steel tub on an angle frame, flanged wheels sitting on the rails."""
    close = m.at((x, 0, z), -.03)
    RAIL = .155
    for sz in (-.36, .36):
        for s in (-.48, .48):
            m.lathe([(0, 0), (.15, .02), (.15, .25), (.13, .3), (.13, 1), (0, 1)], (s - s * .12, RAIL + .13, sz), (s + s * .1, RAIL + .13, sz), "steel_bare", 16)
        m.cyl((-.55, RAIL + .13, sz), (.55, RAIL + .13, sz), .025, "steel", 8)
        for s in (-.3, .3):
            m.box((s, RAIL + .22, sz), (.09, .16, .12), "steel", chamfer=.012)
    for s in (-.38, .38):
        m.beam((s, RAIL + .3, -.72), (s, RAIL + .3, .72), .06, .08, "steel")
    for z_ in (-.6, 0, .6):
        m.beam((-.4, RAIL + .34, z_), (.4, RAIL + .34, z_), .05, .05, "steel")
    Y0 = RAIL + .36
    # Tub with sloped sides: four riveted plates and a floor.
    def plate(a, b, c_, d):
        pts = [np.asarray(q, float) for q in (a, b, c_, d)]
        def fn(u, v):
            return pts[0] * (1 - u) * (1 - v) + pts[1] * u * (1 - v) + pts[2] * u * v + pts[3] * (1 - u) * v
        m.surface("steel_bare", fn, 2, 2, (2, 1.2), wear=lambda u, v: (1 - v) ** 2 * .7)
    wb, wt, lb, lt, H = .4, .52, .58, .68, .62
    plate((-wb, Y0, lb), (wb, Y0, lb), (wt, Y0 + H, lt), (-wt, Y0 + H, lt))
    plate((wb, Y0, -lb), (-wb, Y0, -lb), (-wt, Y0 + H, -lt), (wt, Y0 + H, -lt))
    plate((wb, Y0, lb), (wb, Y0, -lb), (wt, Y0 + H, -lt), (wt, Y0 + H, lt))
    plate((-wb, Y0, -lb), (-wb, Y0, lb), (-wt, Y0 + H, lt), (-wt, Y0 + H, -lt))
    plate((-wb, Y0 + .01, lb), (wb, Y0 + .01, lb), (wb, Y0 + .01, -lb), (-wb, Y0 + .01, -lb))
    for s in (-1, 1):
        m.beam((s * (wt + .01), Y0 + H, -lt), (s * (wt + .01), Y0 + H, lt), .05, .03, "steel")
        m.beam((-wt, Y0 + H, s * (lt + .01)), (wt, Y0 + H, s * (lt + .01)), .05, .03, "steel")
        for t in (-.4, 0, .4):
            m.bolt((s * (wt + .02), Y0 + H - .08, t), (s, .16, 0), .01)
    # Ore load: a heap inside the tub, with loose lumps bedded into it.
    rng = m.rng
    m.lathe([(.0, 0), (.36, .0), (.42, .4), (.3, .8), (0, 1)], (0, Y0 + .3, 0), (0, Y0 + .9, 0), "stone", 12)
    for i in range(16):
        a, r = rng.random() * 6.28, rng.random() ** .5
        c = np.array((math.cos(a) * r * .3, Y0 + H * rng.uniform(.82, 1.08), math.sin(a) * r * .32))
        s = rng.uniform(.1, .2)
        j = rng.random() * 6
        m.beam(c - (0, s * .55, 0), c + (0, s * .55, 0), s * rng.uniform(1, 1.6), s * rng.uniform(.9, 1.5), "stone", up=(math.sin(j), 0, math.cos(j)), chamfer=s * .25)
    m.beam((0, RAIL + .3, .72), (0, RAIL + .3, .95), .08, .05, "steel")
    close()
    m.collide_box(x, z, .58, .78, 0, 1.3, tag="mine cart")


def mine():
    poster_material("sign_mine", os.path.join(ROOT, "assets/world-v2/art/sign_mine.png"))
    m = Model("mine", tex=2048, seed=91)
    rng = m.rng
    W, H = 1.42, 2.72
    zs = [1.1, -.7, -2.5, -4.3, -6.1]
    # Timber sets: post, post, cap, each cut into the next and wedged against the rock.
    for i, z in enumerate(zs):
        lean = rng.uniform(-.04, .04)
        sag = -.05 if i == 1 else 0
        for s in (-1, 1):
            m.log((s * W, -.12, z), (s * (W - .08 + lean), H - .02, z), .15, "logwood", sides=10, segs=2, noise=.05)
            m.box((s * W, .1, z), (.42, .24, .42), "stone", chamfer=.06)
            m.collide_post(s * W, z, s * W, z, .16, 0, H, "mine timber")
        m.log((-W - .34, H + sag, z), (W + .34, H - sag, z), .17, "logwood", sides=10, segs=3, noise=.05)
        for s in (-1, 1):
            m.beam((s * (W - .2), H - .3, z + .02), (s * (W - .03), H - .12, z + .02), .1, .22, "wood_dark", up=(0, 0, 1))
    m.beam((-1.9, H + .34, 1.28), (1.9, H + .34, 1.28), .22, .28, "logwood", up=(0, 1, 0))
    # Timber offcuts and broken stone from driving the drift, tipped either side of the mouth.
    for i in range(12):
        s_ = rng.choice((-1, 1))
        p = np.array((s_ * rng.uniform(2.1, 4.6), .1, rng.uniform(.4, 4.2)))
        L_ = rng.uniform(.5, 1.5)
        a_ = rng.uniform(0, 6.28)
        m.log(p, p + (math.cos(a_) * L_, rng.uniform(-.02, .12), math.sin(a_) * L_), rng.uniform(.05, .11), "logwood", sides=7, segs=1)
    for i in range(18):
        s_ = rng.choice((-1, 1))
        c = np.array((s_ * rng.uniform(1.9, 5.2), .06, rng.uniform(-.2, 4.2)))
        h_ = rng.uniform(.1, .34)
        j = rng.random() * 6
        m.beam(c - (0, h_ * .5, 0), c + (0, h_ * .5, 0), h_ * rng.uniform(1.2, 2), h_ * rng.uniform(1, 1.6), "stone", up=(math.sin(j), 0, math.cos(j)), chamfer=h_ * .18)
    # Lagging sits behind the sets, overlapping, so the rock never shows through.
    for k in range(len(zs) - 1):
        z0, z1 = zs[k] + .1, zs[k + 1] - .1
        for x in np.arange(-1.34, 1.42, .225):
            m.plank((x, H + .2, z0), (x + rng.uniform(-.02, .02), H + .2, z1), .24, .05, warp=.012, up=(0, 1, 0), mat="wood_dark")
        for s in (-1, 1):
            for y in np.arange(.12, H, .29):
                m.plank((s * (W + .14), y, z0), (s * (W + .14), y + rng.uniform(-.02, .02), z1), .32, .05, up=(1, 0, 0), warp=.012, mat="wood_dark")
    # A continuous talus mound supports the loose stones and snapped timbers.
    # Independent random heights left individual stones suspended in mid-air.
    def rubble_height(x, z):
        across = max(0.0, 1 - (x / 1.6) ** 2)
        along = max(0.0, 1 - ((z + 6.9) / 1.5) ** 2)
        return .015 + 1.15 * across * along + .065 * math.sin(x * 12 + z * 5) * across * along
    m.surface("mine_rubble", lambda u, v: np.array(((u - .5) * 3.1, rubble_height((u - .5) * 3.1, -5.4 - v * 3), -5.4 - v * 3)), 20, 20, (6, 6), density=2.5)
    for i in range(14):
        x = rng.uniform(-1.2, 1.2)
        s = rng.uniform(.25, .6)
        j = rng.random() * 6
        z = -6.1 - rng.random() * 1.7
        c = np.array((x, rubble_height(x, z) + s * .12, z))
        # Uneven, tilted boulders, not identical upright cylinders.
        axis = np.array((math.sin(j) * .27, 1, math.cos(j) * .22))
        m.lathe([(0, 0), (s * .43, .08), (s * .66, .32), (s * .56, .67), (s * .3, .92), (0, 1)], c - axis * s * .45, c + axis * s * .55, "mine_rubble", 16, density=2)
    m.log((-1.0, .2, -5.6), (.7, 1.1, -6.6), .13, "logwood", sides=9, segs=2)
    m.log((1.1, .15, -5.2), (-.2, .9, -6.4), .12, "logwood", sides=9, segs=2)
    m.collide_box(0, -6.5, 1.5, .9, 0, 3, tag="collapse")
    # Rails on ties: worn bright on top, spiked down, ending where someone stopped.
    for z in np.arange(-5.8, 7.6, .62):
        y_ = .05
        m.beam((-.78 + rng.uniform(-.05, .05), y_, z), (.78 + rng.uniform(-.05, .05), y_, z + rng.uniform(-.05, .05)), .18, .1, "wood_dark", segs=1)
        for s in (-.48, .48):
            m.bolt((s + .06, y_ + .05, z), (0, 1, 0), .012)
            m.bolt((s - .06, y_ + .05, z), (0, 1, 0), .012)
    for s in (-.48, .48):
        pts = [np.array((s + math.sin(z * .4) * .012, .15, z)) for z in np.arange(-5.8, 7.6, .9)]
        m.sweep("steel_bare", pts, .05, .1, chamfer=.008)
    # A timber buffer where the track ends, braced back into the ground.
    for s in (-.48, .48):
        m.beam((s, .0, 7.55), (s, .95, 7.5), .16, .16, "wood_dark")
        m.beam((s, .0, 8.3), (s, .85, 7.6), .1, .12, "wood_dark")
    m.beam((-.75, .82, 7.45), (.75, .82, 7.45), .18, .2, "wood_dark")
    m.collide_box(0, 7.6, .8, .2, 0, 1.0, tag="track buffer")
    cart(m, 0, 3.2)
    # A post with a warning board; the cart's lamp hook and a crate of stores.
    m.log((-2.9, -.1, 2.5), (-2.88, 2.2, 2.52), .07, "logwood", sides=8, segs=1)
    m.collide_post(-2.9, 2.5, -2.9, 2.5, .09, 0, 2.2, "sign post")
    for i in range(4):
        m.plank((-3.65, 1.34 + i * .15, 2.58), (-2.15, 1.34 + i * .15, 2.58), .15, .025, up=(0, 0, 1), mat="wood")
    m.poster("sign_mine", (-2.9, 1.565, 2.598), (1, 0, 0), (0, 1, 0), 1.42, .55)
    for x_ in (-3.55, -2.25):
        m.bolt((x_, 1.6, 2.6), (0, 0, 1), .01)
    m.box((1.0, .32, -1.6), (.62, .62, .5), "wood", chamfer=.02)
    m.collide_box(1.0, -1.6, .33, .27, 0, .65, tag="crate")
    m.hook("fuse", (1.0, .68, -1.6))
    m.hook("depths", (0, 1.4, -5.0))
    m.radius = 9
    return m


def mine_built():
    kit.DEPTH_DARK = (-1.0, -6.0)
    try:
        return kit.build(mine(), None)
    finally:
        kit.DEPTH_DARK = None


ASSETS = {"mine": (mine_built, None)}
