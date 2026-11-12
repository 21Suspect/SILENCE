"""A timber fire lookout, with real stairs up to a cab above the canopy."""
import math

import numpy as np

from kit import Model

LEVEL = 2.4
FLIGHTS = 6
TOP = LEVEL * FLIGHTS
HALF = 2.05


def lookout():
    m = Model("lookout", tex=4096, seed=55)
    rng = m.rng
    # Four legs on concrete piers, leaning very slightly inward.
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box((sx * HALF, .25, sz * HALF), (.62, .55, .62), "concrete", chamfer=.04)
            # Steel stirrups carry each leg clear of the wet concrete.
            for side_ in (-1, 1):
                m.box((sx * HALF + side_ * .125, .72, sz * HALF), (.012, .5, .22), "steel", chamfer=.002)
                m.bolt((sx * HALF + side_ * .132, .8, sz * HALF), (side_, 0, 0), .014)
            m.beam((sx * HALF, .5, sz * HALF), (sx * HALF, TOP + 2.3, sz * HALF), .2, .2, "wood", segs=4, warp=.01)
            m.collide_post(sx * HALF, sz * HALF, sx * HALF, sz * HALF, .14, 0, TOP + 2.3, "tower leg")
    # Girts and cross bracing on all four faces, bay by bay.
    for k in range(FLIGHTS + 1):
        y = max(.8, k * LEVEL)
        for s in (-1, 1):
            # Keep the entire front ground bay open for the stair approach.
            if not (k == 0 and s == -1):
                m.beam((-HALF, y, s * (HALF + .12)), (HALF, y, s * (HALF + .12)), .16, .08, "wood", segs=2, warp=.015)
            m.beam((s * (HALF + .12), y, -HALF), (s * (HALF + .12), y, HALF), .08, .16, "wood", segs=2, warp=.015)
    # Bolted plates at every leg joint, on the faces you can see from the ground.
    for k in range(FLIGHTS + 1):
        y = max(.8, k * LEVEL)
        for sx in (-1, 1):
            for sz in (-1, 1):
                m.gusset((sx * (HALF - .02), y, sz * (HALF + .23)), (-sx, 0, 0), (0, 1 if k < FLIGHTS else -1, 0), .32, .006)
                m.gusset((sx * (HALF + .23), y, sz * (HALF - .02)), (0, 0, -sz), (0, 1 if k < FLIGHTS else -1, 0), .32, .006)
    for k in range(FLIGHTS):
        y0, y1 = max(.8, k * LEVEL), (k + 1) * LEVEL
        ym = (y0 + y1) / 2
        for s in (-1, 1):
            if not (k == 0 and s == -1):
                m.bolt((0, ym, s * (HALF + .215)), (0, 0, s), .018)
            m.bolt((s * (HALF + .215), ym, 0), (s, 0, 0), .018)
        for s in (-1, 1):
            z = s * (HALF + .19)
            if not (k == 0 and s == -1):
                m.beam((-HALF, y0, z), (HALF, y1, z), .12, .05, "wood", up=(0, 0, 1), segs=2, warp=.015)
                m.beam((HALF, y0, z + s * .05), (-HALF, y1, z + s * .05), .12, .05, "wood", up=(0, 0, 1), segs=2, warp=.015)
            if k == 2 and s == 1:
                continue
            x = s * (HALF + .19)
            m.beam((x, y0, -HALF), (x, y1, HALF), .12, .05, "wood", up=(1, 0, 0), segs=2, warp=.015)
            m.beam((x + s * .05, y0, HALF), (x + s * .05, y1, -HALF), .12, .05, "wood", up=(1, 0, 0), segs=2, warp=.015)
    # Switchback stairs. Each tread is a collider, so the player can climb them.
    risers, tread, RUN = 12, .26, 1.56
    for k in range(FLIGHTS):
        y0 = k * LEVEL
        side = -1 if k % 2 == 0 else 1
        x = side * .48
        d = 1 if k % 2 == 0 else -1
        z0 = -d * RUN
        for i in range(risers):
            y = y0 + (i + 1) * LEVEL / risers
            z = z0 + d * (i + .5) * tread
            m.plank((x - .42, y - .02, z), (x + .42, y - .02, z), .245, .04, warp=.003, segs=1)
            m.collide_box(x, z, .45, tread / 2 + .01, y - .12, y, tag="stair tread")
        z1 = z0 + d * risers * tread
        rise = LEVEL
        for sx in (-.46, .46):
            m.beam((x + sx, y0 + .02, z0), (x + sx, y0 + rise - .02, z1), .06, .2, "wood_dark", up=(0, 1, 0))
            # Handrails: rickety, but they do keep you on the stairs.
            # The last flight's rails stop short, so you can step off into the cab either side.
            last = k == FLIGHTS - 1
            end_t = (risers - 3.5) / risers if last else 1.0
            rail_end = z0 + (z1 - z0) * end_t
            m.beam((x + sx, y0 + 1.02, z0), (x + sx, y0 + rise * end_t + 1.0, rail_end), .05, .05, "wood", up=(0, 1, 0))
            m.collide_post(x + sx, z0 + d * .2, x + sx, rail_end if last else z1 - d * .1, .04, y0, y0 + rise + .9, "stair rail")
            for t in ((.08, .5, end_t) if last else (.08, .5, .92)):
                p = np.array((x + sx, y0 + rise * t, z0 + (z1 - z0) * t))
                m.beam(p, p + (0, .98, 0), .045, .045, "wood")
        # Landing at the top of the flight.
        if k < FLIGHTS - 1:
            lz = z1 + d * .38
            for i in range(5):
                z_ = lz + (i - 2) * .16
                m.plank((-.98, y0 + rise - .02, z_), (.98, y0 + rise - .02, z_), .15, .04, warp=.003, segs=1)
            m.beam((-.98, y0 + rise - .12, lz), (.98, y0 + rise - .12, lz), .1, .14, "wood_dark")
            m.collide_box(0, lz, .99, .41, y0 + rise - .14, y0 + rise, tag="stair landing")
            # Rails around the outside of the landing.
            e = lz + d * .4
            m.beam((-.98, y0 + rise + 1, e), (.98, y0 + rise + 1, e), .05, .05, "wood")
            m.beam((-.98, y0 + rise + .52, e), (.98, y0 + rise + .52, e), .04, .04, "wood")
            for px_ in (-.98, 0, .98):
                m.beam((px_, y0 + rise - .14, e), (px_, y0 + rise + 1.02, e), .06, .06, "wood")
            m.collide_post(-.98, e, .98, e, .04, y0 + rise, y0 + rise + 1.1, "landing rail")
    # Entry: bottom-of-stairs board on the ground.
    m.box((-.48, .03, -RUN - .4), (.9, .06, .7), "wood", chamfer=.01)

    # Cab floor, with the stairwell left open.
    y = TOP
    C = 2.45
    for z in np.arange(-C + .08, C, .16):
        inside_well = -RUN - .02 < z < RUN + .02
        if inside_well:
            m.plank((-C, y, z), (.02, y, z), .15, .04, warp=.003, segs=2)
            m.plank((.96, y, z), (C, y, z), .15, .04, warp=.003, segs=2)
        else:
            m.plank((-C, y, z), (C, y, z), .15, .04, warp=.003, segs=2)
    for x in (-C, -1.2, 0, 1.2, C):
        m.beam((x, y - .12, -C), (x, y - .12, C), .1, .18, "wood_dark", segs=2)
    m.collide_box(-C / 2 + .01, 0, C / 2 + .02, C, y - .14, y, tag="cab floor")
    m.collide_box(.96 + (C - .96) / 2, 0, (C - .96) / 2, C, y - .14, y, tag="cab floor")
    m.collide_box(.49, RUN + (C - RUN) / 2, .48, (C - RUN) / 2, y - .14, y, tag="cab floor")
    m.collide_box(.49, -RUN - (C - RUN) / 2, .48, (C - RUN) / 2, y - .14, y, tag="cab floor")
    # Well railing.
    for x_, a, b in ((.0, -RUN + .9, RUN), (.98, -RUN + .9, RUN)):
        m.beam((x_, y + 1, a), (x_, y + 1, b), .05, .05, "wood")
        m.beam((x_, y, a), (x_, y + 1, a), .05, .05, "wood")
        m.beam((x_, y, b), (x_, y + 1, b), .05, .05, "wood")
    m.collide_post(0, -RUN + .9, 0, RUN, .04, y, y + 1.05, "well rail")
    m.collide_post(.98, -RUN + .9, .98, RUN, .04, y, y + 1.05, "well rail")

    # Cab walls: boards to the sill, windows all round. A door opens on the catwalk.
    B = 1.85
    H0 = y + 1.0
    H1 = y + 2.25
    def side(a, b, gap=None):
        # a, b corners; boards horizontal up to the sill.
        a, b = np.asarray(a, float), np.asarray(b, float)
        L = float(np.linalg.norm(b - a))
        d_ = (b - a) / L
        for i in range(6):
            h = y + .1 + i * .165
            face = (d_[2], 0, -d_[0])
            if gap:
                m.plank(a + (0, h, 0), a + d_ * gap[0] + (0, h, 0), .155, .025, warp=.003, segs=1, up=face)
                m.plank(a + d_ * gap[1] + (0, h, 0), b + (0, h, 0), .155, .025, warp=.003, segs=1, up=face)
            else:
                m.plank(a + (0, h, 0), b + (0, h, 0), .155, .025, warp=.003, segs=1, up=face)
        m.beam(a + (0, H0, 0), b + (0, H0, 0), .08, .05, "wood_dark") if not gap else m.beam(a + d_ * gap[1] + (0, H0, 0), b + (0, H0, 0), .08, .05, "wood_dark")
        m.beam(a + (0, H1, 0), b + (0, H1, 0), .08, .1, "wood_dark")
        for t in np.arange(0, L + .01, L / 4):
            p = a + d_ * t
            if gap and gap[0] < t < gap[1]:
                continue
            m.beam(p + (0, H0, 0), p + (0, H1, 0), .06, .06, "wood_dark")
        if not gap:
            # The panes went long ago. A shard or two is still bedded in the sill.
            for t in (.11, .62):
                p = a + d_ * t * L + (0, H0 + .02, 0)
                def shard(u, v, p=p, d_=d_):
                    return p + d_ * (u - .5) * (1 - v) * .24 + np.array((0, v * .2, 0))
                m.surface("glass", shard, 1, 1, (1, 1), flip=d_[0] + d_[2] < 0)
    side((-B, 0, B), (B, 0, B))
    side((B, 0, -B), (-B, 0, -B))
    side((-B, 0, -B), (-B, 0, B))
    side((B, 0, B), (B, 0, -B), gap=(1.2, 2.2))
    for x_, z_, hx, hz in ((0, B, B, .08), (0, -B, B, .08), (-B, 0, .08, B)):
        m.collide_box(x_, z_, hx, hz, y, H1, tag="cab wall")
    m.collide_box(B, 1.38 - .1, .08, .55, y, H1, tag="cab wall")
    m.collide_box(B, -1.4, .08, .5, y, H1, tag="cab wall")
    # Hip roof in tin, with rafters, and a lightning rod.
    ROOF = H1 + 1.25
    O = B + .85
    for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        m.beam((sx * O, H1 + .02, sz * O), (0, ROOF, 0), .08, .12, "wood_dark")
        # King struts carry each hip rafter down onto the cab's corner posts.
        m.beam((sx * B, H1 - .05, sz * B), (sx * B, H1 + .46, sz * B), .1, .1, "wood_dark")
    for i, (a_, dir_) in enumerate((((-1, 1), (1, 0)), ((1, -1), (-1, 0)), ((1, 1), (0, -1)), ((-1, -1), (0, 1)))):
        strips = 9
        ax, az = a_[0] * O, a_[1] * O
        dx, dz = dir_
        for s in range(strips):
            t0, t1 = s / strips, (s + 1) / strips
            def fn(u, v, t0=t0, t1=t1, ax=ax, az=az, dx=dx, dz=dz, o=O, wave=s):
                # Triangular face: eave along t, apex at v=1.
                t = t0 + (t1 - t0) * u
                ex, ez = ax + dx * 2 * o * t, az + dz * 2 * o * t
                return np.array((ex * (1 - v), H1 + .08 + (ROOF - H1) * v + .012 * math.sin(u * math.pi * 2) * (1 - v), ez * (1 - v)))
            m.surface("tin", fn, 4, 3, (1, 2), flip=False)
    m.cyl((0, ROOF, 0), (0, ROOF + 1.5, 0), .012, "steel_bare", 6)
    # Catwalk with a railing, one section gone.
    W_ = C + .0
    for sz, a, b in ((1, -C, C), (-1, -C, C)):
        z = sz * C
        m.beam((a, y + 1.02, z), (b, y + 1.02, z), .06, .06, "wood")
        m.collide_post(a, z, b, z, .04, y, y + 1.1, "catwalk rail")
        m.beam((a, y + .55, z), (b, y + .55, z), .04, .04, "wood")
    for sx in (-1, 1):
        x = sx * C
        m.beam((x, y + 1.02, -C), (x, y + 1.02, sx * 1.0 - 0), .06, .06, "wood")
        m.collide_post(x, -C, x, C, .04, y, y + 1.1, "catwalk rail")
    for a in np.arange(-C, C + .1, .9):
        for z in (-C, C):
            m.beam((a, y, z), (a, y + 1.02, z), .06, .06, "wood")
        m.beam((-C, y, a), (-C, y + 1.02, a), .06, .06, "wood")
        m.beam((C, y, a), (C, y + 1.02, a), .06, .06, "wood")
    # Inside the cab: the fire finder on its pedestal, a shelf with a fuse.
    m.cyl((-.9, y, .4), (-.9, y + .95, .4), .09, "steel", 10)
    m.cyl((-.9, y + .95, .4), (-.9, y + 1.0, .4), .42, "brass", 18)
    m.collide_post(-.9, .4, -.9, .4, .3, y, y + 1.0, "fire finder")
    m.box((-1.5, y + .94, -1.5), (.6, .04, .34), "wood")
    m.beam((-1.75, y + .94, -1.55), (-1.75, y, -1.55), .05, .05, "wood_dark")
    m.beam((-1.25, y + .94, -1.55), (-1.25, y, -1.55), .05, .05, "wood_dark")
    # Knee braces from each leg head carry the catwalk.
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.beam((sx * HALF, y - 1.1, sz * HALF), (sx * C, y - .1, sz * C), .1, .1, "wood")
    m.hook("fuse", (-1.5, y + 1.03, -1.5))
    m.radius = 8
    return m


SHOTS = [((24, 2.2, 22), (0, 10, 0), 28), ((6, 1.7, 8), (-.3, 3.5, 0), 30), ((.2, 16.1, 2.2), (-1.0, 15.2, -1), 42)]
ASSETS = {"lookout": (lookout, SHOTS)}
