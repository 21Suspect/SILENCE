"""The trapper's cabin that replaces the old lean-to, with a porch bench for the torch."""
import math
import random

import numpy as np

from kit import Model


def stone(m, c, s, rng):
    j = rng.uniform(-.07, .07)
    m.beam((c[0], c[1] - s[1] / 2, c[2]), (c[0] + rng.uniform(-.012, .012), c[1] + s[1] / 2, c[2] + rng.uniform(-.012, .012)), s[0], s[2], "stone", up=(math.sin(j), 0, math.cos(j)), chamfer=min(s) * .22)


def cabin():
    m = Model("cabin", tex=4096, seed=7)
    rng = m.rng
    W, D = 3.3, 2.5
    FLOOR = .42
    r, pitch, courses, y0 = .125, .225, 10, .3
    top = y0 + pitch * courses
    over = .34

    def wall(a, b, y, openings=(), axis=0, fixed=0.0, radius=r):
        spans, start = [], a
        for lo, hi, bottom, roof in sorted(openings):
            if bottom - .08 < y < roof + .08:
                if lo > start + .1:
                    spans.append((start, lo))
                start = max(start, hi)
        if b > start + .1:
            spans.append((start, b))
        for p, q in spans:
            full = p == a and q == b
            A = np.array((p, y, fixed)) if axis == 0 else np.array((fixed, y, p))
            B = np.array((q, y, fixed)) if axis == 0 else np.array((fixed, y, q))
            m.log(A, B, radius * rng.uniform(.93, 1.06), "logwood", "endgrain", sides=8, segs=4 if full else 2, noise=.035)
            # Pale chinking between the courses.
            if y + pitch < top:
                A2, B2 = A + (0, pitch * .5, 0), B + (0, pitch * .5, 0)
                m.beam(A2, B2, .1, .1, "concrete", chamfer=.02)

    door = (-1.15, -.25, FLOOR, 2.42)
    front_window = (.75, 1.85, 1.2, 2.08)
    back_window = (-.5, .5, 1.25, 2.0)
    side_window = (-.55, .55, 1.25, 2.0)
    for i in range(courses):
        y = y0 + i * pitch
        wall(-W - over, W + over, y, (door, front_window), 0, D)
        wall(-W - over, W + over, y, (back_window,), 0, -D)
        ys = y + pitch * .5
        wall(-D - over, D + over, ys, (), 1, -W)
        wall(-D - over, D + over, ys, (side_window,), 1, W)
    # Stone footing: nothing here should look as though it floats.
    for x in np.arange(-W - .1, W + .3, .42):
        for z in (-D, D):
            stone(m, (x + rng.uniform(-.04, .04), .14, z), (.42, rng.uniform(.3, .4), .3), rng)
    for z in np.arange(-D, D + .1, .42):
        for x in (-W, W):
            stone(m, (x, .14, z + rng.uniform(-.04, .04)), (.3, rng.uniform(.3, .4), .42), rng)

    # Gable ends in vertical boards with a small louvred vent.
    RIDGE, RISE = top + 1.52, 1.52
    for x in (-W - .02, W + .02):
        for z in np.arange(-D, D, .17):
            h = top + (1 - abs(z + .085) / D) * RISE - .06
            m.plank((x, top - .1, z + .085), (x + rng.uniform(-.004, .004), h, z + .085), .16, .03, up=(math.copysign(1, x), 0, 0))

    # Rafters and purlins.
    eave = D + .62
    slope = RISE / D
    for x in np.arange(-W - .25, W + .3, .86):
        for sgn in (-1, 1):
            m.beam((x, RIDGE - .1, 0), (x, RIDGE - .1 - eave * slope, sgn * eave), .09, .15, "wood_dark", up=(0, 1, 0))
    for off in (.5, 1.5, 2.5):
        for sgn in (-1, 1):
            y = RIDGE - .02 - off * slope
            m.beam((-W - .5, y, sgn * off), (W + .5, y, sgn * off), .06, .08, "wood_dark", warp=.01, segs=3)
    m.log((-W - .5, RIDGE - .1, 0), (W + .5, RIDGE - .1, 0), .1, "logwood", sides=7, segs=3)

    # Tin. Rusted, overlapping sheets, one lifted by the wind and one missing.
    def roof(sign):
        a = np.array((-W - .55, RIDGE + .05, 0.0))
        b = np.array((W + .55, RIDGE + .05, 0.0))
        return a, b, np.array((0.0, -eave * slope - .02, sign * eave))
    a, b, out = roof(1)
    m.gable_roof_tin(a, b, 0, out, curl={2: .16})
    a, b, out = roof(-1)
    m.gable_roof_tin(a, b, 0, out, curl={6: .12})
    # Ridge cap.
    for x0 in np.arange(-W - .55, W + .5, .9):
        def cap(u, v, x0=x0):
            return np.array((x0 + u * .95, RIDGE + .075 - abs(v - .5) * .3, (v - .5) * .5))
        m.surface("tin", cap, 2, 6, (1, 1))

    # Floor, inside and on the porch.
    for z in np.arange(-D + .05, D + 2.2, .19):
        porch = z > D
        if porch and abs(z - (D + 1.15)) < .1:
            # A broken board near the middle of the porch.
            m.plank((-W - .1, FLOOR, z), (.3, FLOOR, z), .175, .035, warp=.006)
            m.plank((1.0, FLOOR, z), (W + .1, FLOOR, z), .175, .035, warp=.006)
            continue
        m.plank((-W - .1 + rng.uniform(0, .05), FLOOR + rng.uniform(-.003, .003), z), (W + .1 - rng.uniform(0, .05), FLOOR, z), .175, .035, warp=.006)
    for x in np.arange(-W, W + .1, .85):
        m.beam((x, FLOOR - .11, D), (x, FLOOR - .11, D + 2.25), .08, .16, "wood_dark")
    for z, _ in ((D + 2.2, 0),):
        m.beam((-W - .15, FLOOR - .1, z), (W + .15, FLOOR - .1, z), .12, .18, "wood_dark")
    # Porch piers.
    for x in (-W, -1.1, 1.1, W):
        stone(m, (x, .12, D + 2.08), (.34, .3, .34), rng)
    # Porch posts, roof beam and a shallower lean-to in tin.
    py = top - .34
    for x in (-W + .05, -1.75, .95, W - .05):
        m.log((x, FLOOR - .02, D + 2.05), (x + rng.uniform(-.03, .03), py, D + 2.05), .09, "logwood", sides=8, segs=2, caps=(False, False))
        m.collide_post(x, D + 2.05, x, D + 2.05, .1, 0, py, "porch post")
    m.log((-W - .4, py + .02, D + 2.05), (W + .4, py + .02, D + 2.05), .1, "logwood", sides=8, segs=3)
    # A ledger on the wall carries the porch rafters at their top end; they sit on the beam below.
    ledger_y = top - .02
    m.beam((-W - .3, ledger_y, D + .17), (W + .3, ledger_y, D + .17), .08, .16, "wood_dark", up=(0, 1, 0))
    rafters = list(np.arange(-W - .05, W + .2, .78))
    for x in rafters:
        m.beam((x, ledger_y + .1, D + .12), (x, py + .15, D + 2.22), .07, .12, "wood_dark")
        m.bolt((x + .037, py + .13, D + 2.05), (1, 0, 0), .011)
    run, drop = 2.25, ledger_y + .17 - (py + .2)
    n = 8
    for i in range(n):
        if i == 3:
            continue
        x0 = -W - .15 + i * (2 * W + .3) / n
        m.tin_sheet((x0, ledger_y + .175 + i % 2 * .007, D + .05), (1, 0, 0), (0, -drop, run), (2 * W + .3) / n + .05, math.hypot(drop, run), droop=.0, curl=.06 if i == 6 else 0)
    # Steps up to the porch.
    for i, (dz, y) in enumerate(((2.42, FLOOR - .14), (2.74, FLOOR - .28))):
        for w in (-.13, .13):
            m.plank((-1.45, y, D + dz + w), (.05, y, D + dz + w), .25, .05)
    # Two notched stringers bolted to the rim joist carry the treads.
    for x in (-1.38, -.02):
        m.beam((x, FLOOR - .08, D + 2.2), (x, .04, D + 3.05), .07, .24, "wood_dark", up=(0, 1, 0))
        m.bolt((x + .04, FLOOR - .1, D + 2.22), (1, 0, 0), .012)
    # Railing to one side of the steps: leans, like everything else.
    for a0, b0 in ((-W + .05, -1.75), (.95, W - .05)):
        m.log((a0, FLOOR + .86, D + 2.05), (b0, FLOOR + .9, D + 2.05), .045, "logwood", sides=6, segs=2)
        m.log((a0, FLOOR + .46, D + 2.05), (b0, FLOOR + .44, D + 2.05), .04, "logwood", sides=6, segs=2)

    # Door frame, and the door left ajar.
    for x in (-1.2, -.2):
        m.beam((x, FLOOR, D + .03), (x, 2.46, D + .03), .1, .12, "wood_dark")
    m.beam((-1.28, 2.48, D + .03), (-.12, 2.48, D + .03), .12, .12, "wood_dark")
    ang = math.radians(68)
    dx, dz = math.cos(ang), -math.sin(ang)
    hinge = np.array((-1.13, FLOOR + .03, D + .02))
    for i in range(5):
        t = (i + .5) * .172
        a_ = hinge + np.array((dx * t, 0, dz * t))
        m.plank(a_, a_ + (0, 1.94, 0), .165, .035, up=(-dz, 0, dx), warp=.004)
    for h in (.28, 1.66):
        m.plank(hinge + (dx * .02, h, dz * .02 + .03 * dx), hinge + (dx * .84, h, dz * .84 + .03 * dx), .1, .025, up=(-dz, 0, dx), mat="wood_dark")
    m.plank(hinge + (dx * .06, .32, dz * .06 + .03 * dx), hinge + (dx * .8, 1.62, dz * .8 + .03 * dx), .09, .025, up=(-dz, 0, dx), mat="wood_dark")
    for h in (.28, 1.66):
        m.box(hinge + (.03, h, 0), (.2, .06, .012), "tin")

    # Windows: dirty panes behind whatever someone nailed over them in a hurry.
    def window(lo, hi, bottom, roof, z, boards=3):
        for x in (lo, hi):
            m.beam((x, bottom, z), (x, roof, z), .07, .1, "wood_dark")
        for y in (bottom, roof):
            m.beam((lo - .03, y, z), (hi + .03, y, z), .07, .12, "wood_dark")
        m.beam(((lo + hi) / 2, bottom, z), ((lo + hi) / 2, roof, z), .03, .04, "wood_dark")
        m.beam((lo, (bottom + roof) / 2, z), (hi, (bottom + roof) / 2, z), .03, .04, "wood_dark")
        # A header log closes the wall down to the frame.
        m.beam((lo - .22, roof + .13, z - .05), (hi + .22, roof + .13, z - .05), .2, .2, "logwood", up=(0, 1, 0))
        # Sloped sill, proud of the logs.
        m.beam((lo - .1, bottom - .05, z + .05), (hi + .1, bottom - .05, z + .05), .1, .05, "wood_dark", up=(0, 1, .25))
        m.box(((lo + hi) / 2, (bottom + roof) / 2, z - .01), (hi - lo, roof - bottom, .01), "glass", chamfer=.001)
        for i in range(boards):
            y = bottom + (roof - bottom) * (i + .5) / boards
            tilt = rng.uniform(-.14, .14)
            m.plank((lo - .24, y - tilt, z + .1), (hi + .24, y + tilt, z + .1), .17, .03, mat="wood", up=(0, 0, 1))
    window(*front_window[:2], front_window[2], front_window[3], D + .03)
    close = m.at((0, 0, -D), math.pi)
    window(*back_window[:2], back_window[2], back_window[3], .03, 2)
    close()

    # The side window is in the gable wall: the same window, turned.
    close = m.at((W, 0, 0), math.pi / 2)
    window(side_window[0], side_window[1], side_window[2], side_window[3], .03, 2)
    close()

    # Fieldstone chimney on the left gable: mortar core, stones laid in running bond.
    cx, cz = -W - .46, -.55
    y, course = .02, 0
    while y < RIDGE + 1.05:
        t = min(1, y / (RIDGE - .5))
        hw = .55 * (1 - .38 * t ** 1.5)
        h = rng.uniform(.15, .27)
        m.box((cx, y + h / 2, cz), (hw * 2 - .04, h + .02, hw * 2 - .04), "concrete", chamfer=.01)
        for side in range(4):
            along = -hw
            if course % 2:
                along += rng.uniform(.08, .2)
            while along < hw - .08:
                w = min(rng.choice((.15, .2, .28, .36, .46)), hw - along)
                s_ = along + w / 2
                out = hw - .075 + rng.uniform(-.006, .006)
                c = ((cx + s_, y + h / 2, cz + out), (cx + s_, y + h / 2, cz - out), (cx + out, y + h / 2, cz + s_), (cx - out, y + h / 2, cz + s_))[side]
                size = (w - .012, h - .018, .2) if side < 2 else (.2, h - .018, w - .012)
                stone(m, c, size, rng)
                along += w
        y += h
        course += 1
    m.box((cx, y + .03, cz), (hw * 2 + .12, .08, hw * 2 + .12), "concrete", chamfer=.02)
    m.cyl((cx, y - .1, cz), (cx, y + .55, cz), .1, "tin", sides=10)
    m.hook("chimney", (cx, y + .6, cz))
    m.collide_box(cx, cz, .8, .8, 0, y)

    # Bench on the porch, where the torch has been left.
    bx0, bx1, bz, seat = .55, 2.25, D + .42, FLOOR + .45
    for w in (-.11, .11):
        m.plank((bx0, seat, bz + w), (bx1, seat, bz + w), .2, .045, warp=.003)
    for x in (bx0 + .14, bx1 - .14):
        for w in (-.13, .13):
            m.beam((x + w * .14, FLOOR, bz + w), (x, seat - .02, bz + w * .75), .07, .09, "wood_dark")
        m.beam((x, seat - .07, bz - .17), (x, seat - .07, bz + .17), .06, .09, "wood_dark")
    m.hook("bench", ((bx0 + bx1) / 2 - .25, seat + .08, bz + .02))
    m.collide_box((bx0 + bx1) / 2, bz, (bx1 - bx0) / 2, .2, FLOOR, seat + .03, tag="porch bench")

    # Firewood against the right wall, with the axe left in the block.
    for layer in range(6):
        for i in range(14 - layer):
            z = -2.3 + (i + .5 * layer) * .2
            y = .1 + layer * .17
            x0 = W + .42 + rng.uniform(-.05, .05)
            m.log((x0 - .24, y, z), (x0 + .24, y, z + rng.uniform(-.03, .03)), rng.uniform(.085, .12), "bark", sides=7, segs=1, noise=.08)
    m.collide_box(W + .42, -1.0, .3, 1.5, 0, 1.2, tag="woodpile")
    block = (W + 1.25, .36, 1.45)
    m.log((block[0], 0, block[2]), (block[0], .5, block[2]), .26, "bark", sides=10, segs=1, noise=.05)
    m.collide_post(block[0], block[2], block[0], block[2], .28, 0, .5, "chopping block")
    m.beam((block[0] + .03, .47, block[2]), (block[0] + .46, .93, block[2] + .2), .03, .05, "wood_fresh", segs=1)
    m.box((block[0] + .02, .53, block[2] - .01), (.16, .1, .018), "steel_bare", yaw=-.4, chamfer=.003)

    # Interior: a table, a stove, a bunk. Enough to read through the open door.
    tx, tz = 1.1, -.5
    m.box((tx, FLOOR + .76, tz), (1.3, .05, .8), "wood")
    for sx in (-.55, .55):
        for sz in (-.32, .32):
            m.beam((tx + sx, FLOOR, tz + sz), (tx + sx, FLOOR + .74, tz + sz), .07, .07, "wood_dark")
    m.collide_box(tx, tz, .68, .42, FLOOR, FLOOR + .8, tag="table")
    sx, sz = -2.1, -1.2
    m.lathe([(0, 0), (.3, .01), (.33, .1), (.33, .9), (.27, 1), (0, 1)], (sx, FLOOR + .18, sz), (sx, FLOOR + 1.0, sz), "steel", 12)
    m.cyl((sx, FLOOR + 1.0, sz), (sx, RIDGE + .1, sz + .5), .07, "steel", 8)
    m.collide_post(sx, sz, sx, sz, .36, FLOOR, FLOOR + 1.1, "stove")
    for z in (-2.25, -1.45):
        for x in (2.45, 3.1):
            m.beam((x, FLOOR, z), (x, FLOOR + .55, z), .07, .07, "wood_dark")
    m.box((2.78, FLOOR + .56, -1.85), (.85, .05, 1.0), "wood")
    m.box((2.78, FLOOR + .62, -1.85), (.75, .08, .92), "canvas", chamfer=.03)

    # Storm lantern on a wire hook over a porch rafter; the runtime can light it.
    lx, lz = rafters[3], D + 1.2
    raft_y = ledger_y + .1 + (py + .15 - ledger_y - .1) * (lz - D - .12) / 2.1
    m.lathe([(0, 0), (.075, .05), (.09, .2), (.055, .55), (.075, .62), (.075, .7), (0, .72)], (lx, py - .62, lz), (lx, py - .26, lz), "tin", 10)
    m.tube([(lx, py - .27, lz), (lx, raft_y - .07, lz), (lx + .05, raft_y - .02, lz), (lx + .05, raft_y + .07, lz), (lx, raft_y + .075, lz), (lx - .045, raft_y + .06, lz)], .005, "steel_bare", 5)
    m.hook("lantern", (lx, py - .45, lz))
    # The sheet missing from the porch roof lies where it came down, one corner folded under.
    def fallen(u, v):
        return np.array((-W - 1.5 + u * .86 + v * .25, .03 + .016 * math.sin(u * 6 * math.pi) + .22 * max(0.0, v - .72) ** 1.3, D + .9 + v * 2.2 - u * .3))
    m.surface("tin", fallen, 24, 5, (1.72, 4.4), wear=lambda u, v: .35 + .4 * abs(2 * u - 1) ** 2)

    # Someone wanted this read before anyone went in.
    from kit import poster_material, ROOT
    import os
    poster_material("board_quiet", os.path.join(ROOT, "assets/world-v2/art/board_quiet.png"))
    m.poster("board_quiet", (-2.25, 1.78, D + .155), (.998, .05, 0), (-.05, .998, 0), 1.3, .39)
    m.beam((-2.87, 1.74, D + .15), (-1.62, 1.84, D + .15), .4, .025, "wood", up=(0, 0, 1))
    # Walls.
    t = .15
    m.collide_box(0, -D, W + .1, t, 0, top, tag="cabin wall")
    m.collide_box(-W, 0, t, D + .1, 0, top, tag="cabin wall")
    m.collide_box(W, 0, t, D + .1, 0, top, tag="cabin wall")
    m.collide_box((-W - 1.2) / 2, D, (W - 1.2) / 2, t, 0, top, tag="cabin wall")
    m.collide_box((W - .22) / 2, D, (W + .22) / 2, t, 0, top, tag="cabin wall")
    m.collide_box(-.7, D, .5, t, 2.42, top, tag="door lintel")
    # Walkable floor and steps: each lip is under the character's step height.
    m.collide_box(0, 1.08, W + .2, D + 1.14, 0, FLOOR, tag="cabin floor")
    m.collide_box(-.7, D + 2.42, .78, .17, 0, FLOOR - .14, tag="step")
    m.collide_box(-.7, D + 2.74, .78, .17, 0, FLOOR - .28, tag="step")
    m.radius = 9
    return m


SHOTS = [((8.5, 1.7, 11.5), (0, 1.9, 1), 34), ((-9.5, 1.7, 7.5), (-.5, 2.1, 0), 36), ((.8, 1.65, 7.6), (.6, 1.1, 3), 40)]
