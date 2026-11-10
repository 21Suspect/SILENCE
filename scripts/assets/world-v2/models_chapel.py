"""A white clapboard chapel and its small, crowded graveyard."""
import math

import numpy as np

from kit import Model


def chapel():
    m = Model("chapel", tex=4096, seed=121)
    rng = m.rng
    W, L, H = 2.8, 5.2, 3.6
    RISE = 2.3
    FLOOR = .42
    # Fieldstone footing.
    for x, z, hx, hz in ((0, -L, W, .12), (0, L, W, .12), (-W, 0, .12, L), (W, 0, .12, L)):
        m.box((x, .16, z), (2 * hx + .1, .42, 2 * hz + .1), "stone", chamfer=.05)
    # Clapboards, with openings for arched windows and the door.
    def boards(a, b, normal, gaps):
        a, b = np.asarray(a, float), np.asarray(b, float)
        L_ = float(np.linalg.norm(b - a))
        d = (b - a) / L_
        y = .32
        while y < H:
            start = 0.0
            for lo, hi, bottom, roof in sorted(gaps):
                if bottom < y < roof:
                    # The glazing has a pointed head, not a rectangular cutout.
                    # Cut at the board's top edge; the 10 cm frame hides the tiny stair-step.
                    if roof == 3.0 and y + .09 > 2.5:
                        inset = min(.5, max(0.0, y + .09 - 2.5))
                        lo, hi = lo + inset, hi - inset
                    if lo > start + .05:
                        m.plank(a + d * start + (0, y, 0), a + d * lo + (0, y, 0), .18, .02, mat="white_paint", up=np.array(normal) + (0, .08, 0), warp=.003, segs=1)
                    start = hi
            if L_ > start + .05:
                m.plank(a + d * start + (0, y, 0), b + (0, y, 0), .18, .02, mat="white_paint", up=np.array(normal) + (0, .08, 0), warp=.003, segs=1)
            y += .155
    win = lambda c: (c - .5, c + .5, 1.3, 3.0)
    boards((W + .02, 0, L), (W + .02, 0, -L), (1, 0, 0), [win(L - z) for z in (2.8, -.0, -2.8)])
    boards((-W - .02, 0, -L), (-W - .02, 0, L), (-1, 0, 0), [win(L + z) for z in (2.8, -.0, -2.8)])
    boards((-W, 0, L + .02), (W, 0, L + .02), (0, 0, 1), [(W - .75, W + .75, FLOOR, 2.75)])
    boards((W, 0, -L - .02), (-W, 0, -L - .02), (0, 0, -1), [])
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.beam((sx * W, .3, sz * L), (sx * W, H, sz * L), .16, .16, "white_paint")
    # Gables and the roof, shingled in tin.
    for z, n in ((L + .02, 1), (-L - .02, -1)):
        y = H
        while y < H + RISE:
            hw = W * (1 - (y - H) / RISE)
            if hw > .05:
                m.plank((-hw, y, z), (hw, y, z), .18, .02, mat="white_paint", up=(0, .08, n), warp=.003, segs=1)
            y += .155
    for z in np.arange(-L - .3, L + .4, 1.05):
        for s in (-1, 1):
            m.beam((0, H + RISE, z), (s * (W + .5), H - .5 * RISE / W, z), .09, .15, "wood_dark")
    m.log((0, H + RISE, -L - .4), (0, H + RISE, L + .4), .08, "logwood", sides=7, segs=2)
    O = W + .55
    n_ = 12
    for s in (-1, 1):
        for i in range(n_):
            if s == 1 and i == 4:
                continue
            z = -L - .45 + i * (2 * L + .9) / n_
            m.tin_sheet((0, H + RISE + .05 + i % 2 * .01, z), (0, 0, 1), (s * O, -O * RISE / W, 0), (2 * L + .9) / n_ + .05, math.hypot(O, O * RISE / W), droop=.015, curl=.35 if i == 8 and s == -1 else 0, mat="tin")
    # Door and steps; floor; pews just visible inside.
    for z in np.arange(-L + .1, L + .1, .2):
        m.plank((-W + .1, FLOOR, z), (W - .1, FLOOR, z), .19, .03, mat="wood_dark", warp=.004, segs=2)
    # A boarded ceiling closes the roof space from inside.
    for x_ in np.arange(-W + .1, W, .3):
        m.plank((x_, H - .02, -L + .1), (x_, H - .02, L - .1), .29, .02, mat="wood_dark", warp=.002, segs=1)
    for x in (-.8, .8):
        m.beam((x, FLOOR, L + .08), (x, 2.82, L + .08), .12, .12, "white_paint")
    m.beam((-.9, 2.86, L + .08), (.9, 2.86, L + .08), .12, .16, "white_paint")
    # Two leaves, each its own hinged model: one stands wide, the other has swung most of the way shut.
    m.door("door_chapel", (-.74, FLOOR + .02, L + .05), 0.0, -1.7, width=.73, height=2.34, thickness=.035, start=.8)
    m.door("door_chapel_r", (.74, FLOOR + .02, L + .05), math.pi, 1.7, width=.73, height=2.34, thickness=.035, start=.3)
    for i in range(2):
        y = FLOOR - .14 * (i + 1)
        m.box((0, y - .03, L + .32 + i * .3), (1.9, .1, .3), "stone", chamfer=.03)
    m.collide_box(0, L + .32, .95, .15, 0, FLOOR - .14, tag="step")
    m.collide_box(0, L + .62, .95, .15, 0, FLOOR - .28, tag="step")
    m.collide_box(0, 0, W, L, 0, FLOOR, tag="chapel floor")
    for z in np.arange(-3.2, 3.6, 1.15):
        for s in (-1, 1):
            m.plank((s * .5, FLOOR + .45, z), (s * 2.3, FLOOR + .45, z), .3, .04, mat="wood_dark", warp=.002, segs=1)
            m.plank((s * .5, FLOOR + .8, z - .15), (s * 2.3, FLOOR + .8, z - .15), .24, .03, mat="wood_dark", up=(0, 0, 1), warp=.002, segs=1)
            for x in (s * .55, s * 2.25):
                # Pew ends are one board: floor to back-rail, carrying seat and back.
                m.beam((x, FLOOR, z - .1), (x, FLOOR + .92, z - .14), .05, .36, "wood_dark")
            m.collide_box(s * 1.4, z - .03, .92, .2, FLOOR, FLOOR + .85, tag="pew")
    # Pointed windows: black glass behind a painted frame, some smashed out.
    def window(x_, z):
        s = 1 if x_ > 0 else -1
        pts = [(-.5, 1.3), (.5, 1.3), (.5, 2.5), (0, 3.0), (-.5, 2.5)]
        for a, b in zip(pts, pts[1:] + pts[:1]):
            m.beam((x_ + s * .05, a[1], z + a[0]), (x_ + s * .05, b[1], z + b[0]), .1, .1, "white_paint", up=(1, 0, 0))
        def glass(u, v, z=z, x_=x_):
            w = .5 * (1 if v < .706 else max(.01, 1 - (v - .706) / .294))
            return np.array((x_, 1.3 + v * 1.7, z + (u - .5) * 2 * w))
        m.surface("glass" if abs(z) < 3 else "void", glass, 2, 10, (1, 1), flip=x_ < 0)
        # Timber glazing bars and a tracery fork in the head.
        m.beam((x_ + s * .03, 1.3, z), (x_ + s * .03, 2.56, z), .03, .03, "white_paint", up=(1, 0, 0))
        for y_ in (1.7, 2.1, 2.5):
            m.beam((x_ + s * .03, y_, z - .5), (x_ + s * .03, y_, z + .5), .025, .03, "white_paint", up=(1, 0, 0))
        m.beam((x_ + s * .03, 2.5, z), (x_ + s * .03, 2.84, z - .17), .025, .03, "white_paint", up=(1, 0, 0))
        m.beam((x_ + s * .03, 2.5, z), (x_ + s * .03, 2.84, z + .17), .025, .03, "white_paint", up=(1, 0, 0))
    for z in (2.8, 0.0, -2.8):
        window(W + .02, z)
        window(-W - .02, z)
    # Belfry over the door: a small square tower with louvres and a leaning cross.
    cz = L - 1.0
    bh = H + RISE - .4
    bw = .85
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.beam((sx * bw, bh, cz + sz * bw), (sx * bw, bh + 2.0, cz + sz * bw), .14, .14, "white_paint")
    for s in (-1, 1):
        for i in range(7):
            y = bh + .15 + i * .26
            m.plank((-bw, y + .05, cz + s * bw), (bw, y - .05, cz + s * bw), .24, .02, mat="white_paint", up=(0, .55, s), segs=1, warp=.002)
            m.plank((s * bw, y + .05, cz - bw), (s * bw, y - .05, cz + bw), .24, .02, mat="white_paint", up=(s, .55, 0), segs=1, warp=.002)
    B = bw + .2
    for s in (-1, 1):
        m.beam((-B, bh + 2.0, cz + s * bw), (B, bh + 2.0, cz + s * bw), .14, .12, "white_paint")
        m.beam((s * bw, bh + 2.0, cz - B), (s * bw, bh + 2.0, cz + B), .12, .14, "white_paint")
    for (ax, az), (bx, bz) in (((-B, B), (B, B)), ((B, B), (B, -B)), ((B, -B), (-B, -B)), ((-B, -B), (-B, B))):
        def fn(u, v, ax=ax, az=az, bx=bx, bz=bz):
            ex, ez = ax + (bx - ax) * u, az + (bz - az) * u
            return np.array((ex * (1 - v), bh + 2.05 + v * 1.7, cz + ez * (1 - v)))
        m.surface("tin", fn, 2, 5, (2, 3), flip=False)
    top = bh + 3.72
    m.beam((0, top - .05, cz), (.09, top + 1.1, cz), .07, .07, "steel")
    m.beam((-.34, top + .68, cz), (.46, top + .78, cz), .07, .07, "steel")
    m.hook("bell", (0, bh + 1.1, cz))
    # Walls as colliders, with the doorway open.
    t = .12
    m.collide_box(0, -L, W, t, 0, H + 1, tag="chapel wall")
    m.collide_box(-W, 0, t, L, 0, H + 1, tag="chapel wall")
    m.collide_box(W, 0, t, L, 0, H + 1, tag="chapel wall")
    m.collide_box(-(W + .8) / 2, L, (W - .8) / 2, t, 0, H + 1, tag="chapel wall")
    m.collide_box((W + .8) / 2, L, (W - .8) / 2, t, 0, H + 1, tag="chapel wall")
    # The graveyard: small stones, crowded and leaning, and a rusted fence.
    def headstone(x, z, tall, yaw):
        """One slab extruded from a single outline, in one of several real shapes."""
        close = m.at((x, 0, z), yaw)
        w, t = rng.uniform(.24, .36), rng.uniform(.05, .08)
        kind = rng.randrange(4)
        lean = rng.uniform(-.12, .12)
        def outline(a):
            # a runs 0..1 across the top from the left shoulder to the right shoulder.
            xx = -w + 2 * w * a
            if kind == 0:   # round
                yy = tall - w + math.sqrt(max(0, w * w - xx * xx))
            elif kind == 1:   # gothic point
                yy = tall - w * 1.2 + (1 - abs(xx) / w) * w * 1.2
            elif kind == 2:   # shouldered
                yy = tall - .1 if abs(xx) > w * .6 else tall - .1 + math.sqrt(max(0, (w * .6) ** 2 - xx * xx)) * .7
            else:   # broken off at an angle
                yy = tall * (.72 + .28 * a) + .03 * math.sin(a * 23)
            return xx, yy
        N = 14
        tops = [outline(i / N) for i in range(N + 1)]
        ring = [(tops[0][0], -.2)] + tops + [(tops[-1][0], -.2)]
        n_ = len(ring)
        for s_ in (-1, 1):
            verts = [(p[0] + lean * max(0, p[1]) / tall, p[1], s_ * t) for p in ring]
            face = [tuple(range(n_ - 1, -1, -1))] if s_ > 0 else [tuple(range(n_))]
            m.add("stone", verts, [(0, 0, s_)] * n_, [(p[0] * 2, p[1] * 2) for p in ring], face)
        # The rim, as one continuous strip around the outline.
        verts, norms, uvs, faces = [], [], [], []
        run = 0.0
        for i, p in enumerate(ring):
            q = ring[min(n_ - 1, i + 1)]
            o = ring[max(0, i - 1)]
            d = (q[0] - o[0], q[1] - o[1])
            ll = math.hypot(*d) or 1
            nn = (d[1] / ll, -d[0] / ll, 0)
            for z_ in (-t, t):
                verts.append((p[0] + lean * max(0, p[1]) / tall, p[1], z_))
                norms.append((-nn[0], -nn[1], 0))
                uvs.append((run * 2, z_ * 2))
            if i < n_ - 1:
                run += math.dist(p, q)
                faces.append((i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2))
        m.add("stone", verts, norms, uvs, faces, wear=.2)
        m.collide_post(0, 0, 0, 0, w, 0, tall, "headstone")
        close()
    def cross(x, z, yaw):
        close = m.at((x, 0, z), yaw)
        lean = rng.uniform(-.12, .12)
        m.beam((0, -.1, 0), (lean, 1.0, 0), .08, .06, "wood", up=(0, 0, 1), chamfer=.006)
        m.beam((-.26 + lean * .7, .68, .035), (.26 + lean * .7, .7, .035), .08, .05, "wood", up=(0, 1, 0), chamfer=.006)
        m.collide_post(0, 0, 0, 0, .07, 0, 1.0, "grave marker")
        close()
    for row in range(3):
        for i in range(6):
            x = -6.8 - row * 1.9 + rng.uniform(-.55, .55)
            z = -4.5 + i * 1.8 + rng.uniform(-.75, .75)
            if rng.random() < .75:
                headstone(x, z, rng.uniform(.6, 1.05), math.pi / 2 + rng.uniform(-.3, .3))
            else:
                cross(x, z, math.pi / 2 + rng.uniform(-.4, .4))
    fx0, fx1, fz0, fz1 = -12.4, -5.2, -6.4, 6.4
    m.density = .5
    def fence(a, b):
        a, b = np.asarray(a, float), np.asarray(b, float)
        L_ = float(np.linalg.norm(b - a))
        d = (b - a) / L_
        for y in (.16, .92):
            m.tube([a + (0, y, 0), b + (0, y, 0)], .012, "steel_bare", 4)
        for t_ in np.arange(0, L_, .14):
            p = a + d * t_
            m.tube([p, p + (0, 1.08, 0)], .0075, "steel_bare", 4)
        m.collide_post(a[0], a[2], b[0], b[2], .04, 0, 1.1, "iron fence")
    fence((fx0, 0, fz0), (fx0, 0, -.8))
    fence((fx0, 0, .8), (fx0, 0, fz1))
    fence((fx0, 0, fz1), (fx1, 0, fz1))
    # A gate left open, and posts that give the iron something to hang from.
    fence((fx0, 0, .8), (fx0 - 1.25, 0, 1.75))
    for z_ in (fz0, -.8, .8, fz1):
        m.beam((fx0, 0, z_), (fx0, 1.3, z_), .09, .09, "stone", chamfer=.012)
    fence((fx1, 0, fz0), (fx0, 0, fz0))
    m.density = 1
    m.hook("fuse", (1.4, FLOOR + .5, -4.0))
    m.radius = 14
    return m


def door_chapel():
    """One leaf of the chapel door: four dark boards, ledged, long strap hinges and an iron ring. Hinge edge on the origin."""
    m = Model("door_chapel", tex=1024, seed=75)
    rng = m.rng
    W_, H_, T_ = .73, 2.34, .035
    n = 4
    for i in range(n):
        x = (i + .5) * W_ / n
        m.beam((x, rng.uniform(0, .01), 0), (x, H_ - rng.uniform(0, .012), 0), W_ / n - .004, T_, "wood_dark", up=(0, 0, 1), chamfer=.004)
    zi = -T_ / 2 - .014
    for y in (.32, 1.2, 2.05):
        m.beam((.03, y, zi), (W_ - .03, y, zi), .12, .028, "wood_dark", up=(0, 0, 1), chamfer=.004)
        for i in range(n):
            m.nail(((i + .5) * W_ / n, y, T_ / 2 + .001), (0, 0, 1))
    m.beam((.07, .4, zi), (W_ - .07, 1.12, zi), .09, .026, "wood_dark", up=(0, 0, 1), chamfer=.004)
    zo = T_ / 2 + .005
    for y in (.32, 2.05):
        m.beam((.0, y, zo), (.6, y, zo), .05, .008, "soot_iron", up=(0, 0, 1), chamfer=.002)
        m.lathe([(.017, 0), (.017, 1)], (.0, y - .06, zo + .008), (.0, y + .06, zo + .008), "soot_iron", 8)
        for dx in (.1, .32, .54):
            m.bolt((dx, y, zo + .004), (0, 0, 1), .008, "soot_iron")
    # An iron ring on a plate, both faces.
    for z, s_ in ((zo, 1), (-T_ / 2 - .004, -1)):
        hx = W_ - .1
        m.box((hx, 1.1, z + s_ * .002), (.07, .07, .008), "soot_iron", chamfer=.002)
        m.tube([(hx + math.cos(t) * .045, 1.06 + math.sin(t) * .045, z + s_ * .018) for t in np.linspace(0, math.tau, 11)], .007, "soot_iron", 5)
        m.tube([(hx, 1.1, z), (hx, 1.105, z + s_ * .02)], .008, "soot_iron", 5)
    m.radius = 1.3
    return m


ASSETS = {"chapel": (chapel, [((9, 1.7, 15), (0, 3.2, 0), 34), ((-15, 1.7, 7), (-6, 1.0, 0), 34)])}
ASSETS["door_chapel"] = (door_chapel, None)


def door_chapel_r():
    from models_poi2 import mirror_z
    return mirror_z(door_chapel(), "door_chapel_r")


ASSETS["door_chapel_r"] = (door_chapel_r, None)
