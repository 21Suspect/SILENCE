"""A hunters' camp someone left in a hurry, and the logging yard."""
import math

import numpy as np

from kit import Model


def folds(u, v, seed):
    return .01 * math.sin(u * 26 + v * 6 + seed) + .008 * math.sin(v * 19 - u * 9 + seed * 2) + .014 * math.sin(u * 9 + seed * 3) * math.sin(v * 7)


def tent(m, length, width, height, mat):
    """Canvas over a ridge pole: sags between supports, staked out on guy lines."""
    seed = m.rng.random() * 9
    for sign in (-1, 1):
        def fn(u, v, sign=sign):
            z = (u - .5) * length
            sag_ridge = .08 * math.sin(u * math.pi)
            belly = .1 * math.sin(v * math.pi) * (.7 + .3 * math.sin(u * 7 + seed))
            y = (height - sag_ridge) * (1 - v) - belly + folds(u, v, seed)
            wall = v > .86
            x = sign * width / 2 * min(v, .86) / .86
            if wall:
                y = max(0.0, (1 - v) / .14 * ((height - sag_ridge) * .14))
            return np.array((x, max(.015, y), z))
        m.surface(mat, fn, 26, 16, (length * 2, 3), flip=sign > 0, wear=lambda u, v: v ** 3 * .9)
    def back(u, v):
        x = (u - .5) * width * (1 - v)
        return np.array((x, height * v + .01, -length / 2 + .03 * math.sin(v * 3)))
    m.surface(mat, back, 8, 8, (2.4, 2.4), flip=True, wear=lambda u, v: (1 - v) ** 2 * .9)
    # Door flaps, tied back to either side with a band of canvas.
    for s in (-1, 1):
        def flap(u, v, s=s):
            # A triangle of cloth gathered towards the front pole.
            x = s * width / 2 * (1 - v) * (.95 - .55 * u)
            z = length / 2 + .03 + .08 * u * math.sin(v * math.pi)
            ripple = .018 * math.sin(v * 14 + u * 3) * u
            return np.array((x + ripple * s, height * v + .01, z + ripple))
        m.surface(mat, flap, 6, 10, (1.2, 2.4), flip=s < 0, wear=lambda u, v: (1 - v) ** 2 * .7)
        m.lathe([(0, 0), (.035, .2), (.035, .8), (0, 1)], (s * width * .24, height * .42, length / 2 + .02), (s * width * .24 + s * .05, height * .42 + .1, length / 2 + .06), mat, 8)
    m.density = .6
    for z in (length / 2, -length / 2):
        m.log((0, 0, z), (0, height + .06, z), .022, "wood", sides=6, segs=1, caps=(False, True))
    m.log((0, height - .01, -length / 2), (0, height - .01, length / 2), .022, "wood", sides=6, segs=2)
    m.density = 1
    # Stakes and guy lines: the tent is held down by something.
    for sx in (-1, 1):
        for z in (-length / 2 + .15, 0, length / 2 - .15):
            base = np.array((sx * width / 2, .03, z))
            stake = np.array((sx * (width / 2 + .32), .0, z))
            m.lathe([(.016, 0), (.016, .8), (.03, .85), (.03, 1)], stake, stake + (sx * .06, .24, 0), "wood", 6, density=.4)
            m.wire(base + (0, .28, 0), stake + (sx * .05, .22, 0), .004, .0032, "canvas", 3)
    for sz in (-1, 1):
        stake = np.array((0, 0, sz * (length / 2 + .8)))
        m.lathe([(.018, 0), (.018, .8), (.033, .85), (.033, 1)], stake, stake + (0, .28, sz * .07), "wood", 6, density=.4)
        m.wire((0, height + .02, sz * length / 2), stake + (0, .26, sz * .06), .008, .0035, "canvas", 4)


def torn_down_tent(m, length, width, mat):
    """A tarp thrown over the stores and weighted with stones, its hem pulled out by something since."""
    seed = m.rng.random() * 9
    def box_under(x, z):
        # A crate and a sack lie under the sheet; it drapes over their hard corners.
        h = 0.0
        ax, az = abs(x - .25), abs(z + .2)
        if ax < .42 and az < .34:
            h = .62
        else:
            d = max(ax - .42, az - .34, 0)
            h = max(0.0, .62 - d * 2.1)
        sack = .36 * math.exp(-(((x + .55) / .36) ** 2 + ((z - .5) / .5) ** 2))
        return max(h, sack)
    def fn(u, v):
        x = (u - .5) * width * 1.5
        z = (v - .5) * length * 1.05
        h = box_under(x, z)
        hard = .05 * abs(math.sin(u * 15 + v * 4 + seed)) + .03 * abs(math.sin(v * 21 - u * 9))
        pull = max(0.0, 1 - min(u, 1 - u, v, 1 - v) / .1)
        return np.array((x + .04 * math.sin(v * 13) * pull, max(.012, h + hard * (1 - pull) + .012), z + .04 * math.sin(u * 11) * pull))
    m.surface(mat, fn, 40, 40, (width * 3, length * 2.2), wear=lambda u, v: .75 if min(u, 1 - u, v, 1 - v) < .14 else .35)
    # Eyelets at the hem, cords to pegs, stones along one side.
    for p, q in (((-.72, .03, -.9), (-1.1, .0, -1.15)), ((.72, .03, -.95), (1.05, .0, -1.25)), ((.8, .03, .95), (1.3, .0, 1.05))):
        m.wire(p, q, .01, .004, "canvas", 4)
        q = np.asarray(q, float)
        m.lathe([(.015, 0), (.015, .8), (.028, .85), (.028, 1)], q, q + (0, .2, 0), "wood", 6, density=.4)
    rng = m.rng
    for i in range(6):
        p = np.array(((-.62 + i * .24) * width * .85, .07, -length * .5 - rng.uniform(-.02, .05)))
        s_ = rng.uniform(.09, .16)
        m.beam(p - (0, s_ * .5, 0), p + (0, s_ * .5, 0), s_ * 1.5, s_ * 1.2, "stone", chamfer=s_ * .3)


def collapsed_tent(m, length, width, height, mat):
    """The second tent: its back pole has snapped and the canvas has come down over whatever was inside."""
    seed = m.rng.random() * 9
    ridge = lambda u: height * (.1 + .9 * u ** 1.7)
    for sign in (-1, 1):
        def fn(u, v, sign=sign):
            z = (u - .5) * length
            top = ridge(u)
            down = 1 - u
            belly = .1 * math.sin(v * math.pi) * (.4 + .6 * u)
            crease = .07 * down * abs(math.sin(v * 7 + u * 11 + seed)) * math.sin(v * math.pi) + .035 * down * math.sin(u * 23 + v * 5)
            y = top * (1 - v) - belly + crease + folds(u, v, seed)
            x = sign * width / 2 * v * (1 + .3 * down) + .05 * down * math.sin(u * 9 + seed)
            return np.array((x, max(.015, y), z))
        m.surface(mat, fn, 30, 16, (length * 2, 3), flip=sign > 0, wear=lambda u, v: .35 + v ** 2 * .55)
    # Front pole and ridge still up at this end; the ridge pole runs down to the ground at the other.
    m.density = .6
    m.log((0, 0, length / 2), (0, height + .06, length / 2), .022, "wood", sides=6, segs=1, caps=(False, True))
    m.log((0, height - .01, length / 2), (0, ridge(0) - .02, -length / 2), .022, "wood", sides=6, segs=2)
    # The back pole, snapped: one half under the canvas edge, one half thrown clear.
    m.log((.1, .03, -length / 2 - .1), (.15, .3, -length / 2 + .05), .022, "wood", sides=6, segs=1)
    m.log((.9, .03, -length / 2 - .5), (1.7, .04, -length / 2 + .2), .022, "wood", sides=6, segs=1)
    m.density = 1
    for s in (-1, 1):
        def flap(u, v, s=s):
            x = s * width / 2 * (1 - v) * (.95 - .5 * u)
            z = length / 2 + .03 + .08 * u * math.sin(v * math.pi)
            ripple = .018 * math.sin(v * 14 + u * 3) * u
            return np.array((x + ripple * s, height * v + .01, z + ripple))
        m.surface(mat, flap, 6, 10, (1.2, 2.4), flip=s < 0, wear=lambda u, v: (1 - v) ** 2 * .7)
    # Stakes and lines hold the front half; at the back the pegs have pulled and the lines lie slack.
    for sx in (-1, 1):
        for z, slack in ((length / 2 - .15, False), (0, False), (-length / 2 + .2, True)):
            hem = np.array((sx * width / 2 * (1 + .3 * (.5 - z / length)), .04, z))
            stake = hem + np.array((sx * .34, -.04, 0))
            if slack:
                m.wire(hem + (0, .02, 0), stake + (sx * .2, .02, .3), -.004, .0032, "canvas", 4)
                m.lathe([(.016, 0), (.016, .8), (.03, .85), (.03, 1)], stake + (sx * .2, .02, .3), stake + (sx * .42, .04, .36), "wood", 6, density=.4)
            else:
                m.lathe([(.016, 0), (.016, .8), (.03, .85), (.03, 1)], stake, stake + (sx * .06, .24, 0), "wood", 6, density=.4)
                m.wire(hem + (0, .2 + .12 * (z > 0), 0), stake + (sx * .05, .22, 0), .004, .0032, "canvas", 3)
    stake = np.array((0, 0, length / 2 + .8))
    m.lathe([(.018, 0), (.018, .8), (.033, .85), (.033, 1)], stake, stake + (0, .28, .07), "wood", 6, density=.4)
    m.wire((0, height + .02, length / 2), stake + (0, .26, .06), .008, .0035, "canvas", 4)


def fire_pit(m):
    rng = m.rng
    for i in range(13):
        a = i / 13 * 6.28 + rng.uniform(-.09, .09)
        r = rng.uniform(.56, .7)
        c = np.array((math.cos(a) * r, .07, math.sin(a) * r))
        h = rng.uniform(.14, .28)
        m.beam(c - (0, h * .5, 0), c + (0, h * .5, 0), rng.uniform(.18, .34), rng.uniform(.16, .26), "stone", up=(math.cos(a), 0, math.sin(a)), chamfer=.05)
    m.lathe([(0, 0), (.58, 0), (.46, .55), (.12, 1), (0, 1)], (0, .02, 0), (0, .1, 0), "ash", 18)
    # Charred ends collapsed into the middle, as a fire leaves them.
    for a, tilt in ((.4, .22), (1.2, .1), (2.3, .3), (3.4, .08), (4.6, .18), (5.5, .12)):
        L = rng.uniform(.3, .48)
        m.log((math.cos(a) * L, .09, math.sin(a) * L), (math.cos(a + .4) * .07, .1 + tilt, math.sin(a + .4) * .07), rng.uniform(.035, .06), "char", "char", sides=12, segs=3, noise=.18)
    # A tripod with a blackened pot over the fire.
    for a in (.5, 2.6, 4.7):
        m.log((math.cos(a) * .72, 0, math.sin(a) * .72), (0, 1.32, 0), .018, "wood", sides=6, segs=1)
    m.tube([(0, 1.3, 0), (0, .62, 0)], .004, "steel_bare", 4)
    m.lathe([(0, 0), (.14, .05), (.18, .35), (.17, .95), (.19, 1), (.175, 1), (.16, .35), (.13, .1), (0, .1)], (0, .36, 0), (0, .6, 0), "soot_iron", 28)
    for i in range(34):
        a, r = rng.random() * math.tau, rng.random() ** .5 * .48
        x, z = math.cos(a) * r, math.sin(a) * r
        m.log((x, .065, z), (x + .035, .08, z + .025), rng.uniform(.009, .025), "char", "ash", sides=6, segs=1)


def camp():
    m = Model("camp", tex=2048, seed=101)
    rng = m.rng
    fire_pit(m)
    m.collide_post(0, 0, 0, 0, .75, 0, .2, "fire ring")
    # Log seats drawn up around the fire.
    for a, r in ((1.0, 1.55), (2.6, 1.6), (5.2, 1.55)):
        c = np.array((math.cos(a) * r, .22, math.sin(a) * r))
        d = np.array((math.sin(a) * .7, 0, -math.cos(a) * .7))
        m.log(c - d, c + d, .21, "bark", "endgrain", sides=10, segs=2)
        m.collide_post(*(c - d)[[0, 2]], *(c + d)[[0, 2]], .23, 0, .44, "log seat")
    close = m.at((-2.5, 0, -1.8), .55)
    tent(m, 2.5, 2.0, 1.4, "canvas")
    m.collide_box(0, 0, 1.0, 1.28, 0, 1.3, tag="tent")
    close()
    close = m.at((2.6, 0, -2.3), -.7)
    collapsed_tent(m, 2.6, 2.0, 1.35, "tarp")
    m.collide_box(0, .5, .9, .8, 0, 1.1, tag="tent")
    close()
    # Cooler with handles and latches.
    close = m.at((2.05, 0, 1.8), .3)
    m.box((0, .24, 0), (.74, .44, .42), "cooler", chamfer=.04)
    m.box((0, .49, 0), (.78, .07, .46), "white_mast", chamfer=.025)
    for s in (-1, 1):
        m.tube([(s * .39, .34, -.08), (s * .44, .36, 0), (s * .39, .34, .08)], .009, "steel_bare", 5)
        m.box((s * .2, .43, .22), (.05, .1, .02), "chrome", chamfer=.004)
    close()
    m.collide_box(2.05, 1.8, .4, .24, 0, .52, yaw=.3, tag="cooler")
    # Rolled sleeping bag, strapped, dropped beside the fire.
    close = m.at((-1.25, 0, 1.55), 1.2)
    m.lathe([(0, 0), (.2, .02), (.23, .09), (.23, .91), (.2, .98), (0, 1)], (0, .22, -.42), (0, .22, .42), "canvas", 14)
    for z in (-.2, .2):
        m.lathe([(.235, 0), (.24, .5), (.235, 1)], (0, .22, z - .02), (0, .22, z + .02), "wood_dark", 14)
    close()
    # A line between two braced posts, a shirt pegged to it.
    for p, brace in (((3.6, .1), (.8, .2)), ((3.55, 2.6), (.8, -.2))):
        m.log((p[0], -.1, p[1]), (p[0] + .02, 2.05, p[1]), .05, "logwood", sides=8, segs=1)
        m.log((p[0] + brace[0], 0, p[1] + brace[1]), (p[0] + .03, 1.2, p[1]), .03, "logwood", sides=6, segs=1)
        m.collide_post(p[0], p[1], p[0], p[1], .07, 0, 2, "line post")
    m.density = .5
    m.wire((3.62, 1.98, .1), (3.57, 1.98, 2.6), .1, .004, "steel_bare", 12)
    m.density = 1
    def shirt(u, v):
        z = .95 + u * .62
        return np.array((3.595 + .018 * math.sin(v * 7 + u * 5), 1.88 - v * .74, z + (u - .5) * v * .16 + .012 * math.sin(v * 11)))
    m.surface("canvas", shirt, 10, 12, (1.3, 1.5), wear=lambda u, v: .3 + v * .6)
    for z in (1.0, 1.5):
        m.box((3.595, 1.885, z), (.02, .07, .025), "wood", chamfer=.003)
    # What was left: a tin cup by the fire, a boot on its side.
    m.lathe([(0, 0), (.04, .02), (.042, .95), (.046, 1)], (.95, .0, .5), (.95, .09, .5), "steel_bare", 12, wear=.4)
    m.tube([(.99, .07, .5), (1.03, .05, .5), (.99, .02, .5)], .005, "steel_bare", 5)
    close = m.at((-.9, 0, .55), 2.1)
    m.loft("char", [(-.13, .01, .01, .06, 3), (-.12, .05, .055, .06, 3), (.06, .05, .055, .06, 3), (.14, .04, .045, .05, 3), (.15, .005, .005, .05, 3)], 12)
    m.loft("char", [(-.13, .01, .01, .16, 3), (-.12, .048, .09, .16, 3), (-.02, .046, .09, .17, 3), (-.0, .01, .01, .17, 3)], 12)
    close()
    # Jerry can on a crate by the standing tent.
    m.box((-1.15, .16, -3.2), (.72, .32, .5), "wood", chamfer=.02)
    m.collide_box(-1.15, -3.2, .38, .27, 0, .34, tag="crate")
    m.hook("jerrycan", (-1.15, .32, -3.2))
    m.hook("lantern", (1.0, .44, -.9))
    m.radius = 7
    return m


def stack(m, sx, sz, yaw, L, rows):
    """Trunks settle into the hollows of the row below, chained between tall stakes."""
    rng = m.rng
    close = m.at((sx, 0, sz), yaw)
    R = .27
    y = .24
    for row in range(rows):
        n = rows - row + 2
        for i in range(n):
            x = (i - (n - 1) / 2) * R * 2.0
            r = rng.uniform(.265, .305)      # every trunk bears on its neighbours: none hangs in the stack
            off = rng.uniform(-.55, .55)
            # No two trunks alike: some still in bark, some peeled and silvered, each with its own stretch of grain,
            # girth and taper, and the odd one with a stub where a limb was lopped.
            peeled = rng.random() < .38
            m.log((x, y, -L / 2 + off), (x + rng.uniform(-.03, .03), y, L / 2 + off), r, "logwood" if peeled else "bark", "endgrain", sides=11, segs=6, noise=rng.uniform(.03, .08), taper=rng.uniform(.03, .22), grain=rng.uniform(.6, 1.7))
            if rng.random() < .3:
                kz = rng.uniform(-L / 2 + off + .6, L / 2 + off - .6)
                ka = rng.uniform(.3, 2.8)
                kd = np.array((math.cos(ka), math.sin(ka), 0))
                m.log(np.array((x, y, kz)) + kd * r * .7, np.array((x, y, kz)) + kd * (r + rng.uniform(.05, .16)), rng.uniform(.035, .06), "logwood" if peeled else "bark", "endgrain", sides=7, segs=1, noise=.05)
        y += R * 1.73
    half = (rows + 2) * R + .1
    for z in (-L * .3, L * .3):
        m.log((-half, .1, z), (half, .1, z), .11, "logwood", sides=8, segs=1)
        for s in (-1, 1):
            m.log((s * half, -.1, z), (s * (half + .05), y * .92, z), .08, "logwood", sides=8, segs=1)
        m.wire((-half, y * .9, z), (half, y * .9, z), .02, .012, "steel_bare", 6)
    m.collide_box(0, 0, half, L / 2, 0, y, tag="log stack")
    close()


def logstack():
    m = Model("logstack", tex=4096, seed=111)
    stack(m, -5.5, -2.5, .1, 8.6, 5)
    stack(m, 5.2, -5.5, -.25, 7.4, 4)
    stack(m, 2.5, 6.5, .9, 6.8, 3)
    # Open-sided shed with a workbench.
    close = m.at((-3.5, 0, 6.5), 2.5)
    W, D, H = 3.1, 2.1, 2.8
    for sx in (-1, 0, 1):
        for sz in (-1, 1):
            h = H + sz * -.35
            m.log((sx * W, -.1, sz * D), (sx * W, h + .08, sz * D), .09, "logwood", sides=8, segs=2)
            m.collide_post(sx * W, sz * D, sx * W, sz * D, .1, 0, h, "shed post")
    for sz in (-1, 1):
        h = H + sz * -.35
        m.log((-W - .3, h, sz * D), (W + .3, h, sz * D), .1, "logwood", sides=8, segs=3)
    ridge_at = lambda z: H + .08 - z * .35 / D
    for x in np.arange(-W, W + .1, .78):
        m.beam((x, ridge_at(-D - .4) + .08, -D - .4), (x, ridge_at(D + .4) + .08, D + .4), .07, .12, "wood_dark")
    # One sheet has torn free and lies against the post, bent over itself.
    def fallen(u, v):
        return np.array((-W + 1.2 + (u - .5) * .9, .04 + max(0.0, math.sin(v * 2.6)) * .55, D + .6 + v * 1.7 + .03 * math.sin(u * 37)))
    m.surface("tin", fallen, 12, 8, (1.8, 3), wear=lambda u, v: .55)
    for i in range(7):
        if i == 2:
            continue
        x = -W - .35 + i * (2 * W + .7) / 7
        y0 = ridge_at(-D - .55) + .152
        y1 = ridge_at(D + .55) + .152
        m.tin_sheet((x, y0 + i % 2 * .004, -D - .55), (1, 0, 0), (0, y1 - y0, 2 * D + 1.1), (2 * W + .7) / 7 + .05, math.hypot(y1 - y0, 2 * D + 1.1), droop=.012, curl=.25 if i == 5 else 0)
    # Back wall: even boards, each long enough to be nailed to the posts.
    for i in range(12):
        h = .25 + i * .205
        m.plank((-W - .08, h, -D - .1 - (i % 2) * .018), (W + .08, h, -D - .1 - (i % 2) * .018), .245, .025, up=(0, 0, 1))
        for x in (-W, 0, W):
            m.bolt((x, h, -D - .085), (0, 0, 1), .009)
    m.collide_box(0, -D, W, .1, 0, 2.3, tag="shed wall")
    m.box((1.0, .92, -D + .45), (2.4, .07, .72), "wood", chamfer=.02)
    for x in (-.1, 2.1):
        for z in (-D + .15, -D + .75):
            m.beam((x, 0, z), (x, .9, z), .08, .08, "wood_dark")
    m.beam((-.1, .3, -D + .15), (2.1, .3, -D + .15), .06, .1, "wood_dark")
    m.collide_box(1.0, -D + .45, 1.22, .37, 0, .98, tag="workbench")
    m.box((.2, 1.02, -D + .45), (.16, .14, .14), "steel", chamfer=.012)
    m.hook("fuse", (1.2, 1.0, -D + .42))
    m.lathe([(0, 0), (.42, .05), (.42, .95), (0, 1)], (-1.6, 1.3, -D - .08), (-1.6, 1.3, -D - .06), "steel_bare", 32)
    close()
    # Drums, a reel of steel cable.
    for (x, z) in ((.6, 1.5), (1.25, 1.1), (.85, .7)):
        m.lathe([(0, 0), (.27, .002), (.29, .02), (.29, .32), (.3, .34), (.29, .36), (.29, .64), (.3, .66), (.29, .68), (.29, .98), (.27, 1), (0, 1)], (x, 0, z), (x, .89, z), "tin_red", 24, wear=.2)
        m.collide_post(x, z, x, z, .3, 0, .9, "drum")
    m.lathe([(0, 0), (.8, 0), (.82, .05), (.82, .1), (.42, .12), (.42, .88), (.82, .9), (.82, .95), (.8, 1), (0, 1)], (-1.2, .82, -6.6), (-.2, .82, -6.3), "wood_dark", 26)
    m.lathe([(.43, 0), (.68, .05), (.72, .5), (.68, .95), (.43, 1)], (-1.12, .82, -6.58), (-.28, .82, -6.32), "steel_bare", 26)
    m.collide_box(-.7, -6.45, .55, .85, 0, 1.6, yaw=.3, tag="cable reel")
    m.radius = 13
    return m


ASSETS = {"camp": (camp, None), "logstack": (logstack, None)}
