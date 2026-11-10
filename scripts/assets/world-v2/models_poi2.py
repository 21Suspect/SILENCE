"""Second batch of places: things a walker comes across between the big sites."""
import math
import os

import numpy as np

from kit import Model, poster_material, ROOT, RECIPES

# Older, dirtier versions of the kit's finishes: these places have stood open for decades.
RECIPES["block_old"] = dict(proc="concrete", blocks=True, moss=1.0, streak=1.0)
RECIPES["concrete_old"] = dict(proc="concrete", moss=.9, streak=.9)
RECIPES["olive_old"] = dict(proc="metal", age=.62, seam=.3, edgew=.6, paint=(0.1, 0.12, 0.05), metal=0.0, rough=0.6, bump=0.05, streak=.6)
RECIPES["red_old"] = dict(proc="metal", age=.6, seam=.2, edgew=.6, paint=(0.34, 0.035, 0.02), metal=0.0, rough=0.55, bump=0.04)
RECIPES["white_old"] = dict(proc="metal", age=.58, seam=.2, edgew=.6, paint=(0.55, 0.53, 0.47), metal=0.0, rough=0.6, bump=0.04)
RECIPES["tin_old"] = dict(proc="metal", age=0.66, seam=.3, edgew=.3, paint=(0.3, 0.32, 0.32), metal=0.15, rough=0.75, bump=0.12, streak=.5)

ART = os.path.join(ROOT, "assets/world-v2/art")


def stone_ring(m, r_in, r_out, y0, courses, per, h=.24, mat="stone", gap=None, seed_twist=0.0):
    """Fieldstone laid in courses round a circle, joints staggered. `gap` = (angle, width) leaves a breach."""
    rng = m.rng
    y = y0
    for c in range(courses):
        hh = h * rng.uniform(.85, 1.12)
        off = (c % 2) * math.pi / per + seed_twist
        a = off
        while a < off + math.tau - .01:
            span = math.tau / per * rng.uniform(.55, 1.45)
            span = min(span, off + math.tau - a)
            mid = a + span / 2
            if gap and abs((mid - gap[0] + math.pi) % math.tau - math.pi) < gap[1] * (1 - c * .18):
                a += span
                continue
            ri = r_in + rng.uniform(-.015, .02)
            ro = r_out + rng.uniform(-.03, .035)
            rm = (ri + ro) / 2
            L = rm * span - rng.uniform(.012, .028)
            t = np.array((-math.sin(mid), 0, math.cos(mid)))
            c0 = np.array((math.cos(mid) * rm, y + hh / 2, math.sin(mid) * rm))
            sk = rng.uniform(-.03, .03)
            rad = np.array((math.cos(mid), 0, math.sin(mid)))
            h2 = hh * rng.choice((.8, 1, 1, 1.18))
            m.beam(c0 - t * L / 2 + rad * sk + (0, (h2 - hh) / 2, 0), c0 + t * L / 2 - rad * sk + (0, (h2 - hh) / 2, 0), ro - ri, h2 - rng.uniform(.002, .01), mat, up=(0, 1, 0), chamfer=min(h2 * .3, rng.uniform(.03, .06)))
            a += span
        y += hh
    return y


def well():
    """A dug well with a windlass under a small roof. The rope still goes down."""
    m = Model("well", tex=2048, seed=211)
    rng = m.rng
    top = stone_ring(m, .5, .8, -.12, 4, 11)
    # Capstones: wider, flatter, overhanging.
    stone_ring(m, .46, .86, top - .01, 1, 8, h=.11)
    rim = top + .1
    # The shaft: black a little way down.
    m.lathe([(.52, 0), (.52, 1)], (0, rim - .02, 0), (0, -.1, 0), "stone", 16, density=.5)
    m.lathe([(0, 0), (.53, 0)], (0, .08, 0), (0, .081, 0), "void", 16)
    m.collide_post(0, 0, 0, 0, .86, 0, rim, "well")
    # Two posts let into the ground against the wall, braced, carrying the windlass and the roof.
    H = 2.3
    for s in (-1, 1):
        m.log((s * .93, -.15, 0), (s * .93, H, 0), .075, "logwood", sides=8, segs=2)
        m.log((s * .95, .0, .62), (s * .93, 1.0, .03), .04, "logwood", sides=6, segs=1)
        m.log((s * .95, .0, -.62), (s * .93, 1.0, -.03), .04, "logwood", sides=6, segs=1)
        m.collide_post(s * .93, 0, s * .93, 0, .09, 0, H, "well post")
        # Iron strap where the axle passes through the post.
        m.lathe([(.082, 0), (.086, .5), (.082, 1)], (s * .93, 1.4, 0), (s * .93, 1.52, 0), "steel", 10)
    # Axle, rope drum, crank.
    m.log((-1.02, 1.46, 0), (1.06, 1.46, 0), .055, "wood_dark", "endgrain", sides=10, segs=2, noise=.01)
    m.lathe([(.06, 0), (.085, .06), (.09, .5), (.085, .94), (.06, 1)], (-.3, 1.46, 0), (.3, 1.46, 0), "canvas", 14)
    for x in (-.32, .32):
        m.lathe([(.056, 0), (.12, .1), (.12, .9), (.056, 1)], (x - .012, 1.46, 0), (x + .012, 1.46, 0), "wood_dark", 12)
    m.tube([(1.05, 1.46, 0), (1.15, 1.46, 0), (1.15, 1.2, .1), (1.34, 1.2, .1)], .013, "steel_bare", 6, wear=.5)
    m.lathe([(.02, 0), (.024, .5), (.02, 1)], (1.2, 1.2, .1), (1.34, 1.2, .1), "wood_dark", 8)
    # Rope: off the drum and straight down the shaft.
    m.tube([(.06, 1.54, .02), (.075, 1.38, .08), (.05, 1.15, .06), (.07, .85, .04), (.05, .5, .06), (.06, .12, .05)], .017, "canvas", 6)
    # Roof: ridge between the posts, short rafters, boards with one slipped.
    m.beam((-1.15, H + .02, 0), (1.15, H + .02, 0), .07, .1, "wood_dark")
    for x in (-.93, 0, .93):
        for s in (-1, 1):
            m.beam((x, H + .06, 0), (x, H - .36, s * .62), .05, .07, "wood_dark")
    for s in (-1, 1):
        for i in range(5):
            if s == 1 and i == 3:
                continue    # one board is gone; it lies in the grass
            t0 = i / 5
            y = H + .1 - t0 * .5
            z = s * (t0 * .74 + .02)
            m.plank((-1.12 + rng.uniform(-.05, .04), y, z), (1.12 + rng.uniform(-.04, .05), y + rng.uniform(-.006, .006), z), .2, .022, "wood", up=(0, .83, s * .56))
            for x in (-.93, 0, .93):
                m.nail((x, y + .004, z + s * .03), (0, .83, s * .56))
    m.plank((-1.5, .02, .95), (-1.2, .03, -1.05), .2, .022, "wood", warp=.02)
    # A worn slab to stand on, and a tin dipper left on the rim.
    m.beam((-.5, .03, 1.12), (.45, .03, 1.16), .5, .1, "stone", chamfer=.04)
    m.lathe([(0, 0), (.055, .03), (.06, .95), (.064, 1), (.058, 1), (.052, .08), (0, .08)], (.35, rim + .0, .58), (.35, rim + .1, .58), "steel_bare", 12, wear=.5)
    m.tube([(.41, rim + .08, .58), (.56, rim + .09, .6)], .006, "steel_bare", 5)
    m.radius = 2.2
    return m


def stone_line(m, a, b, y, h, t, mat="stone", lo=.26, hi=.58, keep=None, chamfer=(.018, .04)):
    """One course of blocks from a to b (x, z pairs), bottom at y. `keep(s, y)` decides which stones exist (s in 0..1)."""
    rng = m.rng
    a, b = np.asarray(a, float), np.asarray(b, float)
    L = float(np.linalg.norm(b - a))
    d = (b - a) / L
    s = 0.0
    while s < L - .02:
        n = min(rng.uniform(lo, hi) * rng.choice((.6, 1, 1, 1.5)), L - s)
        if L - s - n < lo * .6:
            n = L - s
        mid = s + n / 2
        if keep is None or keep(mid / L, y):
            hh = h * rng.choice((.72, .9, 1.0, 1.0, 1.12, 1.3)) - rng.uniform(.0, .01)
            off = rng.uniform(-.03, .035)
            skew = rng.uniform(-.035, .035)
            p0 = a + d * (s + .006)
            p1 = a + d * (s + n - .006)
            nx, nz = -d[1], d[0]
            dy = rng.uniform(-.012, .012)
            m.beam((p0[0] + nx * (off + skew), y + hh / 2 + dy, p0[1] + nz * (off + skew)), (p1[0] + nx * (off - skew), y + hh / 2 - dy, p1[1] + nz * (off - skew)), t + rng.uniform(-.05, .05), hh, mat, up=(0, 1, 0), chamfer=min(hh * .32, rng.uniform(*chamfer) * 1.5))
        s += n


def stone_wall(m, a, b, top, t=.4, h=.2, y0=-.1, mat="stone", lo=.26, hi=.58, stagger=.16):
    """Dry-laid wall from a to b. `top(s)` gives its ragged height along the run."""
    rng = m.rng
    y, c = y0, 0
    peak = max(top(i / 20) for i in range(21))
    while y < peak:
        hh = h * rng.uniform(.85, 1.15)
        a2, b2 = np.asarray(a, float), np.asarray(b, float)
        d = (b2 - a2) / np.linalg.norm(b2 - a2)
        shift = (c % 2) * stagger
        stone_line(m, a2 - d * shift, b2 + d * (stagger - shift), y, hh, t, mat, lo=lo, hi=hi, keep=lambda s, yy, hh=hh: yy + hh * .5 < top(min(1, max(0, s))))
        y += hh
        c += 1


def rubble(m, cx, cz, n, spread, mat="stone", size=(.12, .3)):
    """Stones that came off a wall and stayed where they fell."""
    rng = m.rng
    for _ in range(n):
        a, r = rng.random() * math.tau, rng.random() ** .6 * spread
        s_ = rng.uniform(*size)
        x, z = cx + math.cos(a) * r, cz + math.sin(a) * r
        t = rng.random() * math.tau
        d = np.array((math.cos(t), 0, math.sin(t))) * s_ * .7
        c = np.array((x, s_ * .3, z))
        m.beam(c - d, c + d, s_ * rng.uniform(.7, 1.1), s_ * rng.uniform(.5, .8), mat, chamfer=s_ * .22)


def chimney(m, cx, cz, hx, hz, mat="stone"):
    """Fieldstone hearth and stack, firebox facing +x. Returns the top height."""
    rng = m.rng
    t = .24
    y, c = -.12, 0
    H_BASE, H_TOP = 1.55, 4.5
    while y < H_TOP:
        hh = rng.uniform(.17, .24)
        if y < H_BASE:
            ex, ez = hx, hz
        else:
            k = min(1, (y - H_BASE) / .5)
            ex, ez = hx - .12 * k, hz - .48 * k
        ragged = y > H_TOP - .75
        keep_front = (lambda s, yy, ez=ez: not (yy < 1.0 and abs((s - .5) * 2 * ez) < .46)) if y < 1.0 else None
        drop = (lambda s, yy: yy < H_TOP - .75 + .62 * s) if ragged else None
        lo = dict(lo=.24, hi=.5)
        # Corners interlock: long sides run through on even courses, short sides on odd.
        if c % 2 == 0:
            stone_line(m, (cx + ex - t / 2, cz - ez), (cx + ex - t / 2, cz + ez), y, hh, t, mat, keep=keep_front or drop, **lo)
            stone_line(m, (cx - ex + t / 2, cz - ez), (cx - ex + t / 2, cz + ez), y, hh, t, mat, keep=drop, **lo)
            stone_line(m, (cx - ex + t, cz - ez + t / 2), (cx + ex - t, cz - ez + t / 2), y, hh, t, mat, keep=drop, **lo)
            stone_line(m, (cx - ex + t, cz + ez - t / 2), (cx + ex - t, cz + ez - t / 2), y, hh, t, mat, keep=drop, **lo)
        else:
            stone_line(m, (cx + ex - t / 2, cz - ez + t), (cx + ex - t / 2, cz + ez - t), y, hh, t, mat, keep=keep_front or drop, **lo)
            stone_line(m, (cx - ex + t / 2, cz - ez + t), (cx - ex + t / 2, cz + ez - t), y, hh, t, mat, keep=drop, **lo)
            stone_line(m, (cx - ex, cz - ez + t / 2), (cx + ex, cz - ez + t / 2), y, hh, t, mat, keep=drop, **lo)
            stone_line(m, (cx - ex, cz + ez - t / 2), (cx + ex, cz + ez - t / 2), y, hh, t, mat, keep=drop, **lo)
        y += hh
        c += 1
    # A solid core behind the face stones, so open joints show stone and not daylight.
    m.density = .3
    m.box((cx, H_BASE / 2 - .06, cz), ((hx - .05) * 2, H_BASE + .1, (hz - .05) * 2), mat, chamfer=.01)
    m.box((cx, (H_BASE + H_TOP - .45) / 2, cz), ((hx - .17) * 2, H_TOP - .45 - H_BASE, (hz - .53) * 2), mat, chamfer=.01)
    m.density = 1
    # The firebox: black with soot, a stone lintel over it.
    m.box((cx + hx - .12, .5, cz), (.2, 1.0, .9), "void", chamfer=.002)
    m.beam((cx + hx - t / 2, 1.09, cz - .66), (cx + hx - t / 2, 1.09, cz + .66), t + .05, .2, "char", chamfer=.03)
    # Soot licked up the face above the opening.
    def soot(u, v):
        w = .52 * (1 - v * .55) * (1 + .12 * math.sin(v * 9))
        return np.array((cx + hx + .012 - (.02 if v > .6 else 0) * 0, 1.2 + v * 1.25, cz + (u - .5) * 2 * w))
    m.surface("char", soot, 6, 8, (2, 2.5), wear=lambda u, v: .3 + v * .6)
    return H_TOP


def ruin():
    """A homestead that burned. The chimney stands; the rest came down round the bed and the stove."""
    m = Model("ruin", tex=4096, seed=231)
    rng = m.rng
    X, Z = 3.0, 2.4
    chimney(m, -X + .2, 0, .58, .95)
    m.collide_box(-X + .2, 0, .6, .97, 0, 4.5, tag="chimney")
    # Hearth slab and what is left in the grate.
    m.beam((-X + 1.12, .03, -.8), (-X + 1.12, .03, .8), .62, .12, "stone", chamfer=.03)
    m.lathe([(0, 0), (.34, 0), (.26, .6), (.06, 1), (0, 1)], (-X + .95, .09, 0), (-X + .95, .2, 0), "ash", 14)
    for a_ in (.3, 1.4, 2.6):
        m.log((-X + .95 + math.cos(a_) * .3, .12, math.sin(a_) * .3), (-X + .9, .2, .02), .035, "char", "char", sides=8, segs=2, noise=.2)
    # Foundation: low fieldstone footings, broken down in places, a gap where the door was.
    def top(base, seed):
        return lambda s: base + .16 * math.sin(s * 7 + seed) + .1 * math.sin(s * 17 + seed * 2)
    stone_wall(m, (-X + .85, -Z), (X, -Z), top(.42, 1.0))
    stone_wall(m, (X, -Z), (X, Z), top(.36, 2.2))
    stone_wall(m, (X, Z), (1.5, Z), top(.4, 3.1))
    stone_wall(m, (.35, Z), (-X + .85, Z), top(.45, 4.0))
    stone_wall(m, (-X + .1, Z), (-X + .1, 1.0), top(.34, 5.0), t=.36)
    stone_wall(m, (-X + .1, -1.0), (-X + .1, -Z), top(.38, 6.0), t=.36)
    for (cx_, cz_, hx_, hz_) in ((.95, -Z, 2.1, .22), (X, 0, .22, Z), (2.25, Z, .78, .22), (-1.0, Z, 1.2, .22), (-X + .1, 1.7, .2, .7), (-X + .1, -1.7, .2, .7)):
        m.collide_box(cx_, cz_, hx_, hz_, 0, .5, tag="foundation")
    # A worn stone at the door.
    m.beam((.45, .02, Z + .42), (1.4, .02, Z + .45), .46, .1, "stone", chamfer=.035)
    rubble(m, X + .5, -1.2, 7, .7)
    rubble(m, -X - .7, .9, 6, .6)
    rubble(m, -1.6, -Z - .5, 5, .6)
    # What the fire left standing: corner posts burned to stubs, a sill still on the footing.
    for (x, z, h_) in ((X - .02, -Z + .02, 1.95), (X - .02, Z - .02, .95), (-X + .9, Z - .02, 1.35)):
        m.beam((x, .28, z), (x + rng.uniform(-.05, .05), h_, z + rng.uniform(-.04, .04)), .17, .17, "char", up=(0, 0, 1), chamfer=.03)
        m.collide_post(x, z, x, z, .1, 0, h_, "burned post")
    m.beam((.2, .52, -Z), (X - .1, .47, -Z), .16, .15, "char", chamfer=.03, segs=2, warp=.02)
    # Rafters and joists where they fell.
    fallen = (((-1.9, .08, -1.5), (1.4, .12, -.5), .075), ((-.6, .09, 1.7), (2.3, .5, -2.3), .07), ((1.9, .07, 1.6), (.2, .1, .1), .065), ((-2.1, .07, 1.2), (-.3, .09, 1.9), .06), ((2.4, .08, .4), (2.7, .09, -1.6), .07))
    for a_, b_, r in fallen:
        m.log(a_, b_, r, "char", "char", sides=8, segs=4, noise=.16, taper=.25)
    # One rafter still leans where it dropped against the stack.
    m.log((.3, .07, -1.1), (-X + .85, 1.72, -.5), .075, "char", "char", sides=8, segs=4, noise=.14, taper=.2)
    m.collide_post(.3, -1.1, -X + .85, -.5, .1, 0, 1.2, "fallen rafter")
    # Roof tin, buckled by heat.
    def sheet(ox, oz, yaw, lift, seed):
        def fn(u, v):
            x, z = (u - .5) * .9, (v - .5) * 2.0
            y = .05 + lift * (v ** 2) + .05 * math.sin(v * 5 + seed) + .016 * math.sin(u * 37) + .05 * math.sin(u * 3 + seed) * v
            c, s_ = math.cos(yaw), math.sin(yaw)
            return np.array((ox + x * c + z * s_, y, oz - x * s_ + z * c))
        m.surface("tin", fn, 14, 10, (1.8, 4), wear=lambda u, v: .8)
    sheet(1.0, 1.0, .5, .12, 1.0)
    sheet(-.5, -.8, 2.2, .3, 4.0)
    sheet(4.1, 1.7, 1.2, .08, 2.0)
    # Iron bedstead, its mattress long gone.
    close = m.at((1.75, 0, -1.25), .12)
    for z, h_ in ((-.95, .95), (.95, .62)):
        m.tube([(-.42, 0, z), (-.42, h_, z), (.42, h_, z), (.42, 0, z)], .016, "steel_bare", 6, wear=.7)
        for x in (-.2, 0, .2):
            m.tube([(x, .34, z), (x, h_, z)], .008, "steel_bare", 5, wear=.7)
        m.tube([(-.42, .34, z), (.42, .34, z)], .012, "steel_bare", 5, wear=.7)
    for x in (-.42, .42):
        m.beam((x, .34, -.95), (x, .34, .95), .035, .035, "steel_bare", chamfer=.004)
    for i in range(7):
        z = -.8 + i * .27
        m.tube([(-.42, .345, z), (0, .31 - .02 * (i % 2), z), (.42, .345, z)], .004, "steel_bare", 4, wear=.8)
    m.collide_box(0, 0, .45, .97, 0, .4, tag="bedstead")
    close()
    # The stove, split and on its side by the hearth.
    close = m.at((-1.35, 0, 1.05), .5)
    m.box((0, .27, 0), (.72, .5, .5), "soot_iron", chamfer=.03)
    m.box((0, .535, 0), (.78, .04, .56), "soot_iron", chamfer=.012)
    for x in (-.3, .3):
        for z in (-.2, .2):
            m.lathe([(.03, 0), (.022, 1)], (x, .0, z), (x, .04, z), "soot_iron", 8)
    for x in (-.17, .19):
        m.lathe([(0, 0), (.1, 0), (.1, 1), (.02, 1)], (x, .555, 0), (x, .567, 0), "steel_bare", 12, wear=.6)
    m.box((.2, .25, .255), (.26, .2, .014), "steel_bare", chamfer=.004)
    m.tube([(.24, .25, .27), (.3, .25, .3), (.34, .25, .27)], .006, "steel_bare", 5)
    m.lathe([(.065, 0), (.065, 1)], (-.24, .55, -.08), (-.24, .92, -.08), "soot_iron", 10)
    m.collide_box(0, 0, .38, .27, 0, .56, tag="stove")
    close()
    # The flue section that went with it lies a step away, and a kettle no one came back for.
    m.lathe([(.065, 0), (.07, .5), (.065, 1)], (-.9, .07, 1.75), (-.25, .07, 1.5), "soot_iron", 10)
    m.lathe([(0, 0), (.09, .03), (.115, .4), (.09, .85), (.05, 1), (0, 1)], (-X + 1.2, .09, .55), (-X + 1.2, .25, .55), "soot_iron", 14)
    m.tube([(-X + 1.11, .2, .55), (-X + 1.2, .34, .55), (-X + 1.29, .2, .55)], .006, "steel_bare", 5)
    m.tube([(-X + 1.3, .16, .55), (-X + 1.4, .24, .55)], .012, "soot_iron", 6)
    m.radius = 5.5
    return m


def gate():
    """The road is shut here: a counterweighted boom, padlocked, with blocks either side so nobody drives round."""
    poster_material("sign_roadclosed", os.path.join(ART, "sign_roadclosed.png"))
    m = Model("gate", tex=2048, seed=241)
    PX, RX, Y = -4.3, 4.3, 1.02
    # Pivot: twin channel posts in a concrete footing, a pin through both and the boom.
    m.box((PX, .0, 0), (.62, .3, .62), "concrete", chamfer=.03)
    for z in (-.1, .1):
        m.beam((PX, .1, z), (PX, 1.3, z), .11, .05, "steel", up=(0, 0, 1), chamfer=.006)
    m.box((PX, 1.31, 0), (.16, .03, .3), "steel", chamfer=.006)
    m.cyl((PX, Y, -.16), (PX, Y, .16), .02, "steel_bare", 8)
    for z in (-.165, .165):
        m.bolt((PX, Y, z), (0, 0, 1 if z > 0 else -1), .03)
    m.collide_post(PX, 0, PX, 0, .2, 0, 1.3, "gate post")
    # Boom: a top tube in red and white bands, a lighter rail under it, uprights between. The paint is going.
    x = PX - 1.05
    i = 0
    while x < RX + .25:
        n = min(.62, RX + .25 - x)
        m.lathe([(.062, 0), (.062, 1)], (x, Y, 0), (x + n, Y, 0), "red_old" if i % 2 == 0 else "white_old", 12, wear=.5)
        x += n
        i += 1
    for xe, s in ((PX - 1.05, -1), (RX + .25, 1)):
        m.lathe([(.062, 0), (.055, .6), (0, 1)], (xe, Y, 0), (xe + s * .015, Y, 0), "steel_bare", 12)
    m.tube([(PX + .35, Y - .42, 0), (RX - .3, Y - .42, 0)], .03, "white_old", 8, wear=.5)
    for xs in np.linspace(PX + .35, RX - .3, 8):
        m.tube([(xs, Y - .42, 0), (xs, Y - .03, 0)], .018, "white_old", 6, wear=.5)
    # Counterweight slung under the short arm.
    m.box((PX - .78, Y - .3, 0), (.5, .42, .4), "concrete_old", chamfer=.03)
    for xs in (PX - .95, PX - .61):
        m.tube([(xs, Y - .47, .175), (xs, Y + .055, .06), (xs, Y + .055, -.06), (xs, Y - .47, -.175)], .008, "steel_bare", 5, wear=.5)
    # Rest post: a cradle the boom drops into, a hasp and a padlock through it.
    m.box((RX, .0, 0), (.5, .3, .5), "concrete", chamfer=.03)
    m.beam((RX, .1, 0), (RX, Y - .06, 0), .1, .1, "steel", up=(0, 0, 1), chamfer=.006)
    m.box((RX, Y - .065, 0), (.12, .02, .2), "steel", chamfer=.004)
    for z in (-.085, .085):
        m.beam((RX, Y - .06, z), (RX, Y + .12, z), .1, .016, "steel", up=(1, 0, 0), chamfer=.004)
    m.tube([(RX, Y + .09, -.1), (RX, Y + .09, .1)], .008, "steel_bare", 5)
    m.box((RX, Y + .03, .125), (.05, .06, .025), "brass", chamfer=.006)
    m.tube([(RX - .016, Y + .06, .125), (RX - .016, Y + .1, .125), (RX + .016, Y + .1, .125), (RX + .016, Y + .06, .125)], .005, "steel_bare", 5)
    # A length of chain wrapped round boom and post for good measure.
    pts = [(RX - .12 + .03 * math.sin(k * 1.3), Y - .02 - .19 * math.sin(k / 9 * math.pi), .075 * math.cos(k * 2.1)) for k in range(10)]
    m.tube(pts, .007, "steel_bare", 5, wear=.6)
    m.collide_post(RX, 0, RX, 0, .16, 0, 1.2, "gate post")
    m.collide_box((PX - 1.05 + RX + .25) / 2, 0, (RX + .25 - PX + 1.05) / 2, .07, Y - .46, Y + .07, tag="boom")
    # The sign, clamped under the boom, readable from both sides.
    for s in (1, -1):
        m.poster("sign_roadclosed", (0, Y - .2, s * .05), (s, 0, 0), (0, 1, 0), 1.5, .65, density=3)
    m.box((0, Y - .2, 0), (1.56, .7, .09), "galv", chamfer=.004)
    for xs in (-.45, .45):
        for s in (1, -1):
            m.bolt((xs * 1.5, Y - .0, s * .048), (0, 0, s), .012)
            m.bolt((xs * 1.5, Y - .42, s * .048), (0, 0, s), .012)
    # Red reflectors.
    for xs in (-2.6, 2.6):
        for s in (1, -1):
            m.lathe([(0, 0), (.045, 0), (.04, 1), (0, 1)], (xs, Y, s * .05), (xs, Y, s * .058), "red", 12)
    # Blocks on the verges.
    for bx, bz, yaw in ((PX - 1.75, .15, .12), (RX + .75, -.1, -.1)):
        close = m.at((bx, 0, bz), yaw)
        m.box((0, .2, 0), (.62, .4, 1.7), "concrete_old", chamfer=.05)
        m.box((0, .6, 0), (.36, .52, 1.66), "concrete_old", chamfer=.06)
        for zz in (-.5, .5):
            m.tube([(0, .84, zz - .09), (0, .93, zz - .05), (0, .93, zz + .05), (0, .84, zz + .09)], .012, "steel_bare", 6, wear=.6)
        m.collide_box(0, 0, .31, .86, 0, .86, tag="road block")
        close()
    m.radius = 7
    return m


def busstop():
    """A halt on a route nobody runs any more. Somebody waited; their case is still on the bench."""
    poster_material("timetable", os.path.join(ART, "timetable.png"))
    m = Model("busstop", tex=2048, seed=251)
    rng = m.rng
    W, D = 1.65, .8
    HF, HB = 2.42, 2.1
    m.box((0, .05, .1), (W * 2 + .5, .16, D * 2 + .9), "concrete_old", chamfer=.02)
    m.collide_box(0, .1, W + .25, D + .45, -.1, .13, tag="slab")
    for sx in (-1, 1):
        for sz, h_ in ((-1, HB), (1, HF)):
            m.beam((sx * W, .12, sz * D), (sx * W, h_, sz * D), .1, .1, "wood_dark", up=(0, 0, 1), chamfer=.008)
            m.box((sx * W, .15, sz * D), (.14, .06, .14), "steel", chamfer=.008)
    # Plates, rafters and a tin roof falling to the back.
    m.beam((-W - .2, HF + .04, D), (W + .2, HF + .04, D), .09, .1, "wood_dark")
    m.beam((-W - .2, HB + .04, -D), (W + .2, HB + .04, -D), .09, .1, "wood_dark")
    slope = (HF - HB) / (2 * D)
    ry = lambda z: (HF + HB) / 2 + .13 + z * slope
    for x in (-W, -W / 3, W / 3, W):
        m.beam((x, ry(D + .35), D + .35), (x, ry(-D - .25), -D - .25), .05, .09, "wood_dark")
    n = 4
    wide = (2 * W + .5) / n
    length = math.hypot(2 * D + .7, (2 * D + .7) * slope)
    for i in range(n):
        x0 = -W - .25 + i * wide
        m.tin_sheet((x0, ry(D + .4) + .055 + i % 2 * .01, D + .4), (1, 0, 0), (0, -(2 * D + .7) * slope, -(2 * D + .7)), wide + .05, length, droop=.01, curl=.12 if i == 3 else 0, mat="tin_old")
    # Back and side walls: painted boards, the paint coming off in sheets.
    for i in range(10):
        y = .26 + i * .19
        m.plank((-W - .04 + rng.uniform(-.03, .02), y, -D - .06 - (i % 2) * .006), (W + .04 + rng.uniform(-.02, .03), y + rng.uniform(-.004, .004), -D - .06 - (i % 2) * .006), .18, .024, "wood_dark" if i in (0, 6) else "wood", up=(0, 0, 1), warp=.007)
        for x in (-W, W):
            m.nail((x, y, -D - .072), (0, 0, -1))
    m.collide_box(0, -D - .05, W + .05, .06, 0, HB, tag="shelter wall")
    for sx in (-1, 1):
        for i in range(10):
            y = .26 + i * .19
            # The top boards on the side by the road end have been kicked out.
            if sx == 1 and i in (4, 5):
                # Kicked out: a splintered stub still nailed to the back post, the rest on the ground.
                m.plank((sx * (W + .06), y, -D - .04), (sx * (W + .09), y - .03, -D + .3 + (i - 4) * .12), .18, .024, "wood", up=(1, 0, 0), warp=.0)
                m.plank((sx * (W + .5 + (i - 4) * .22), .02, -D + .2), (sx * (W + .75 + (i - 4) * .1), .025, D - .1), .18, .024, "wood", warp=.01)
                continue
            m.plank((sx * (W + .06), y, -D - .04 + rng.uniform(-.02, .02)), (sx * (W + .06), y + rng.uniform(-.004, .004), D + .04 + rng.uniform(-.02, .02)), .18, .024, "wood_dark" if i in (0, 3) else "wood", up=(1, 0, 0), warp=.007)
            for z in (-D, D):
                m.nail((sx * (W + .072), y, z), (sx, 0, 0))
        m.collide_box(sx * (W + .05), 0, .06, D + .05, 0, HB, tag="shelter wall")
    # Bench on brackets along the back.
    for x in (-1.2, 0, 1.2):
        m.beam((x, .12, -D + .42), (x, .44, -D + .42), .07, .07, "wood_dark", up=(0, 0, 1), chamfer=.006)
        m.beam((x, .41, -D + .02), (x, .41, -D + .5), .06, .07, "wood_dark", chamfer=.006)
    for z in (-D + .14, -D + .32, -D + .49):
        m.plank((-1.45, .46, z), (1.45, .46, z), .16, .03, "wood", warp=.004)
    m.collide_box(0, -D + .3, 1.45, .28, 0, .48, tag="bench")
    # Timetable in a frame on the back wall.
    m.box((.85, 1.5, -D - .04), (.56, .74, .02), "wood_dark", chamfer=.004)
    m.poster("timetable", (.85, 1.5, -D - .028), (1, 0, 0), (0, 1, 0), .46, .64)
    for (a_, b_) in (((.58, 1.14, -D - .025), (1.12, 1.14, -D - .025)), ((.58, 1.86, -D - .025), (1.12, 1.86, -D - .025))):
        m.beam(a_, b_, .03, .02, "wood", up=(0, 0, 1), chamfer=.003)
    for x in (.585, 1.115):
        m.beam((x, 1.14, -D - .025), (x, 1.86, -D - .025), .03, .02, "wood", up=(0, 0, 1), chamfer=.003)
    # A case on the bench, and a hat.
    close = m.at((-.7, .475, -D + .3), .2)
    m.box((0, .095, 0), (.58, .19, .38), "canvas_orange", chamfer=.025)
    for x in (-.29, .29):
        for z in (-.19, .19):
            m.box((x * .97, .095, z * .96), (.03, .2, .03), "brass", chamfer=.006)
    m.tube([(-.09, .1, .2), (-.07, .1, .245), (.07, .1, .245), (.09, .1, .2)], .009, "wood_dark", 6)
    for x in (-.18, .18):
        m.box((x, .12, .195), (.04, .03, .012), "brass", chamfer=.004)
    close()
    m.lathe([(0, 0), (.15, .04), (.16, .1), (.085, .16), (.08, .8), (.06, 1), (0, 1)], (.3, .475, -D + .3), (.3, .59, -D + .3), "canvas", 16)
    # The stop flag on its pole at the kerb.
    m.cyl((W + .55, -.15, D + .5), (W + .55, 2.5, D + .5), .028, "galv", 10)
    m.lathe([(.0, 1), (.08, 1), (.11, .5), (.12, 0)], (W + .55, .06, D + .5), (W + .55, -.06, D + .5), "concrete", 12)
    m.box((W + .55, 2.25, D + .5), (.02, .42, .42), "white_mast", chamfer=.004)
    m.box((W + .55, 2.25, D + .5), (.026, .12, .43), "red", chamfer=.003)
    for y in (2.12, 2.38):
        m.tube([(W + .52, y, D + .47), (W + .59, y, D + .5), (W + .52, y, D + .53)], .005, "steel_bare", 5)
    m.collide_post(W + .55, D + .5, W + .55, D + .5, .05, 0, 2.5, "stop pole")
    m.radius = 3.4
    return m


def antlers(m, origin, yaw=0.0, scale=1.0):
    """A deer's skull plate and antlers nailed up, facing +z of the given frame."""
    close = m.at(origin, yaw)
    k = scale
    def side_(side):
        pts = [np.array((.0, 0, .07)) * k, np.array((side * .2, .14, .13)) * k, np.array((side * .34, .42, .11)) * k, np.array((side * .29, .68, .03)) * k]
        radii = (.021 * k, .017 * k, .013 * k, .004 * k)
        for i in range(3):
            m.lathe([(radii[i], 0), (radii[i + 1], 1)], pts[i], pts[i + 1], "ceramic", 7, wear=.75)
        m.lathe([(.016 * k, 0), (.029 * k, .25), (.029 * k, .7), (.02 * k, 1)], pts[0] - (pts[1] - pts[0]) * .05, pts[0] + (pts[1] - pts[0]) * .14, "ceramic", 9, wear=.9)
        for t, tl, dz in ((1, .2, .12), (2, .24, .1), (2, .15, -.08)):
            base = pts[t] * .6 + pts[min(t + 1, 3)] * .4
            m.lathe([(.012 * k, 0), (.006 * k, .7), (0.0, 1)], base, base + np.array((side * .06, tl, dz)) * k, "ceramic", 6, wear=.75)
    side_(1)
    side_(-1)
    m.box((.0, 0, .082 * k), (.13 * k, .1 * k, .02 * k), "ceramic", chamfer=.012 * k)
    m.bolt((0, 0, .094 * k), (0, 0, 1), .01, "steel_bare")
    close()


def twig_man(m, top, size=1.0, yaw=0.0, drop=.22):
    """A figure of lashed sticks hanging on a cord from `top`."""
    rng = m.rng
    top = np.asarray(top, float)
    d = np.array((math.cos(yaw), 0, math.sin(yaw)))
    k = size
    hc = top - np.array((0, drop + .05 * k, 0))
    m.tube([top, top - (0, drop * .5, 0) + d * .004, hc + (0, .05 * k, 0)], .006, "canvas", 5)
    ring = [hc + d * math.cos(a) * .05 * k + np.array((0, math.sin(a) * .05 * k, 0)) for a in np.linspace(math.pi / 2, math.pi / 2 + math.tau, 9)]
    m.tube(ring, .013 * k, "bark", 6)
    neck = hc - (0, .05 * k, 0)
    hip = neck - np.array((0, .34 * k, 0)) + d * rng.uniform(-.02, .02) * k
    for j in (-1, 0, 1):
        m.log(neck + (0, .02 * k, 0) + d * j * .012 * k, hip + d * j * .02 * k, .014 * k, "bark", "endgrain", sides=5, segs=2, noise=.12)
    sh = neck - (0, .07 * k, 0)
    m.log(sh - d * .22 * k - (0, rng.uniform(.0, .06) * k, 0), sh + d * .22 * k - (0, rng.uniform(.0, .06) * k, 0), .016 * k, "bark", "endgrain", sides=6, segs=2, noise=.12)
    for s_ in (-1, 1):
        m.log(hip + (0, .03 * k, 0), hip + d * s_ * rng.uniform(.1, .15) * k - (0, .3 * k, 0), .015 * k, "bark", "endgrain", sides=6, segs=2, noise=.12)
    m.lash(sh, (0, 1, 0), .034 * k, turns=5, width=.011)
    m.lash(hip, (0, 1, 0), .034 * k, turns=4, width=.011)
    rag(m, hip + (0, .02 * k, 0), d, .2 * k, width=.12 * k, seed=float(top[0] * 7 + top[2]), mat="canvas_orange")
    return hip


def rag(m, p, along, length, width=.09, seed=0.0, mat="canvas"):
    """A torn strip knotted to a cord at p."""
    p, along = np.asarray(p, float), np.asarray(along, float)
    def fn(u, v):
        twist = .5 * math.sin(v * 3 + seed)
        side = along * math.cos(twist) + np.cross(along, (0, 1, 0)) * math.sin(twist)
        w = width * (1 - .35 * v)
        return p + side * (u - .5) * w + np.array((0, .012 - v * length, 0)) + np.cross(along, (0, 1, 0)) * .02 * math.sin(v * 6 + seed) * v
    m.surface(mat, fn, 3, 8, (.3, length * 2), wear=lambda u, v: .4 + v * .5)


def menhir(m, x, z, h, a, b, yaw, lean, seed):
    """A standing stone: a rough slab, wider than it is thick, with a broken crown."""
    c, s_ = math.cos(yaw), math.sin(yaw)
    def fn(u, v):
        th = u * math.tau
        t = v ** .8
        crown = max(0.0, 1 - ((t - .0) / 1.0) ** 5)
        k = (1 - .32 * t) * crown ** .5 * (1 + .1 * math.sin(th * 2 + seed + t * 2) + .07 * math.sin(th * 3 + seed * 2 + t * 5) + .04 * math.sin(th * 5 + t * 9 + seed))
        lx, lz = math.cos(th) * a * k, math.sin(th) * b * k
        y = -.2 + (h + .2) * t * (1 + .06 * math.cos(th + seed) * t)
        return np.array((x + lx * c - lz * s_ + lean[0] * t * h, y, z + lx * s_ + lz * c + lean[1] * t * h))
    m.surface("stone", fn, 14, 10, (4 * (a + b), 2 * h), flip=True, wear=lambda u, v: v * .5)


def graves():
    """Six graves in a fenced plot, and a seventh pegged out and waiting."""
    m = Model("graves", tex=2048, seed=261)
    rng = m.rng
    X, Z = 3.2, 2.4
    # Fence: posts and two rails, a taller pair with a lintel for the way in.
    posts = []
    for x in np.linspace(-X, X, 5):
        posts += [(x, -Z)]
    for z in np.linspace(-Z, Z, 4)[1:]:
        posts += [(X, z)]
    for x in (1.6, .62, -.62, -1.6, -X):
        posts += [(x, Z)]
    for z in np.linspace(Z, -Z, 4)[1:-1]:
        posts += [(-X, z)]
    for i, (x, z) in enumerate(posts):
        nx, nz = posts[(i + 1) % len(posts)]
        gate_post = z == Z and abs(x) < .7
        h_ = 2.05 if gate_post else rng.uniform(.9, 1.0)
        lean = (rng.uniform(-.03, .03), rng.uniform(-.03, .03))
        m.log((x, -.15, z), (x + lean[0], h_, z + lean[1]), .06 if gate_post else .048, "logwood", sides=8, segs=1, noise=.05)
        m.collide_post(x, z, x, z, .07, 0, h_, "plot post")
        if z == Z and x == .62:
            continue   # the gateway
        broken = i == 2
        for k, y in enumerate((.78, .42)):
            if broken and k == 0:
                # This rail has dropped at one end and lies against the next post.
                m.log((x, y, z + .05), (nx - .25, .05, nz + .3), .032, "logwood", sides=6, segs=2, noise=.06)
                continue
            m.log((x - (nx - x) * .04, y + rng.uniform(-.015, .015), z - (nz - z) * .04 + (.05 if z in (-Z, Z) else 0)), (nx + (nx - x) * .04, y + rng.uniform(-.015, .015), nz + (nz - z) * .04 + (.05 if nz in (-Z, Z) else 0)), .032, "logwood", sides=6, segs=2, noise=.05)
            m.lash((x, y, z), (0, 1, 0), .052, turns=2, width=.012)
        m.collide_box((x + nx) / 2, (z + nz) / 2, abs(nx - x) / 2 + .02, abs(nz - z) / 2 + .02, 0, .85, tag="plot rail")
    m.log((-.78, 1.96, Z), (.78, 1.93, Z), .045, "logwood", sides=7, segs=1, noise=.05)
    for x in (-.62, .62):
        m.lash((x, 1.95, Z), (0, 1, 0), .065, turns=3, width=.014)
    m.lash((0, 1.97, Z), (0, 1, 0), .05, turns=4, width=.012)
    # The gate leaf: pickets on two ledges, off its bottom hinge and dragging.
    close = m.at((-.62, 0, Z), 1.42)
    for y_ in (.3, .82):
        m.beam((.05, y_ - .03, .05), (1.1, y_ - .09, .05), .07, .03, "wood", up=(0, 0, 1), chamfer=.004)
    for j in range(6):
        x_ = .12 + j * .19
        m.beam((x_, .05 - j * .012, .075), (x_, 1.02 - j * .012 + (.05 if j % 2 else 0), .075), .075, .022, "wood" if j != 2 else "wood_dark", up=(0, 0, 1), chamfer=.004)
    m.beam((.1, .3, .03), (1.05, .76, .03), .06, .022, "wood", up=(0, 0, 1), chamfer=.004)
    m.tube([(.0, .8, .0), (.06, .8, .05)], .008, "steel_bare", 5)
    close()
    m.beam((0, 1.98, Z), (0, 2.42, Z), .05, .03, "wood", up=(0, 0, 1), chamfer=.004)
    m.beam((-.14, 2.29, Z), (.14, 2.29, Z), .05, .03, "wood", up=(0, 0, 1), chamfer=.004)
    # Graves: a kerb of field stones round each, a marker at the head.
    def kerb(cx, cz, w=.42, l=.95):
        for (a_, b_) in (((cx - w, cz - l), (cx + w, cz - l)), ((cx + w, cz - l), (cx + w, cz + l)), ((cx + w, cz + l), (cx - w, cz + l)), ((cx - w, cz + l), (cx - w, cz - l))):
            a2, b2 = np.asarray(a_), np.asarray(b_)
            n = int(np.linalg.norm(b2 - a2) / .19)
            for j in range(n):
                q = a2 + (b2 - a2) * (j + .5) / n + (rng.uniform(-.02, .02), rng.uniform(-.02, .02))
                s_ = rng.uniform(.1, .17)
                t = rng.random() * math.tau
                d = np.array((math.cos(t), 0, math.sin(t))) * s_ * .55
                c = np.array((q[0], s_ * .28, q[1]))
                m.beam(c - d, c + d, s_ * .8, s_ * .7, "stone", chamfer=s_ * .24)
    def cross(x, z, h_, lean=0.0, arm_drop=0.0, mat="wood"):
        topp = (x + lean * h_, h_, z + lean * .3 * h_)
        m.beam((x, -.12, z), topp, .085, .04, mat, up=(0, 0, 1), chamfer=.005)
        ay = h_ * .7
        ax = x + lean * ay
        az = z + lean * .3 * ay
        m.beam((ax - .3, ay + arm_drop, az + .028), (ax + .3, ay - arm_drop, az + .028), .08, .035, mat, up=(0, 0, 1), chamfer=.005)
        m.nail((ax, ay, az + .044), (0, 0, 1))
        if not arm_drop:
            m.nail((ax + .02, ay + .025, az + .044), (0, 0, 1))
        m.collide_post(x, z, x, z, .06, 0, h_, "grave marker")
    spots = [(-2.05, -1.1), (0, -1.1), (2.05, -1.1), (-2.05, 1.15), (2.05, 1.15)]
    for i, (gx, gz) in enumerate(spots):
        kerb(gx, gz - .0)
    cross(-2.05, -2.0, 1.15)
    cross(0, -2.0, 1.3, lean=.1, mat="wood_dark")
    cross(2.05, .22, 1.05, arm_drop=.09)
    cross(-2.05, .25, .95, lean=-.06, mat="white_paint")
    # One proper headstone, sunk and tilted.
    m.beam((2.0, -.15, -2.02), (2.07, .78, -2.08), .5, .11, "stone", up=(0, 0, 1), chamfer=.04)
    m.beam((1.72, .04, -1.98), (2.36, .04, -1.98), .2, .1, "stone", chamfer=.03)
    m.collide_box(2.03, -2.04, .27, .08, 0, .78, tag="headstone")
    # Things left at the graves.
    m.lathe([(0, 0), (.04, .02), (.045, .7), (.03, .85), (.032, 1)], (-2.05, 0, -1.7), (-2.05, .16, -1.7), "bottle_green", 12)
    for a_ in (.2, 1.5, 2.9, 4.4):
        m.tube([(-2.05, .1, -1.7), (-2.05 + math.cos(a_) * .03, .25, -1.7 + math.sin(a_) * .03), (-2.05 + math.cos(a_) * .09, .33, -1.7 + math.sin(a_) * .09)], .0035, "bark", 4)
    m.lathe([(0, 0), (.05, .02), (.05, .12), (.04, .16), (.04, .8), (.05, .84), (.02, 1), (0, 1)], (.3, 0, -1.72), (.3, .24, -1.72), "soot_iron", 10)
    m.tube([(.26, .2, -1.72), (.3, .31, -1.72), (.34, .2, -1.72)], .004, "steel_bare", 4)
    # The seventh plot: four pegs and a line, no kerb, no name.
    pegs = [(-.42, .25), (.42, .25), (.42, 2.0), (-.42, 2.0)]
    for i, (x, z) in enumerate(pegs):
        m.lathe([(.014, 0), (.016, .8), (.026, .85), (.026, 1)], (x, -.05, z), (x + .02, .26, z), "wood_fresh", 6)
        nx, nz = pegs[(i + 1) % 4]
        m.wire((x + .015, .2, z), (nx + .015, .2, nz), .015, .003, "canvas", 4)
    m.radius = 4.6
    return m


def shrine():
    """Somebody keeps a place for it: a ring of stones, an altar, figures hung where the wind can turn them."""
    m = Model("shrine", tex=2048, seed=271)
    rng = m.rng
    R = 3.3
    stones = []
    for i in range(7):
        a = i / 7 * math.tau + rng.uniform(-.1, .1) + .45
        r = R + rng.uniform(-.25, .25)
        h_ = rng.uniform(.75, 1.55)
        x, z = math.cos(a) * r, math.sin(a) * r
        w = rng.uniform(.2, .3)
        menhir(m, x, z, h_, w * rng.uniform(1.0, 1.5), w * rng.uniform(.55, .8), a + rng.uniform(-.5, .5), (rng.uniform(-.1, .1), rng.uniform(-.1, .1)), rng.random() * 9)
        m.collide_post(x, z, x, z, w, 0, h_, "standing stone")
        stones.append((x, h_, z))
    # Altar: a slab on two stones, black where things were burned on it.
    for x in (-.5, .5):
        m.beam((x, -.05, -.22), (x, -.05 + .5, -.2), .5, .3, "stone", up=(1, 0, 0), chamfer=.06)
    m.beam((-.82, .53, -.2), (.84, .55, -.22), .74, .15, "stone", chamfer=.045)
    m.collide_box(0, -.2, .84, .38, 0, .62, tag="altar")
    m.lathe([(0, 0), (.34, 0), (.24, .6), (.06, 1), (0, 1)], (.08, .62, -.24), (.08, .68, -.24), "ash", 14)
    for a_ in (.2, 1.3, 2.4, 3.9, 5.1):
        m.log((.08 + math.cos(a_) * .26, .65, -.24 + math.sin(a_) * .26), (.08 + math.cos(a_ + .5) * .04, .7, -.24 + math.sin(a_ + .5) * .04), .022, "char", "char", sides=7, segs=2, noise=.2)
    m.lathe([(0, 0), (.08, .1), (.19, .6), (.215, 1), (.2, 1), (.175, .65), (.06, .25), (0, .25)], (-.5, .615, -.14), (-.5, .75, -.14), "ceramic", 16, wear=.6)
    for (x, z, h_) in ((.56, .02, .16), (.66, -.34, .09), (.44, -.46, .2), (-.14, -.44, .12)):
        m.lathe([(.034, 0), (.036, .1), (.03, .9), (.012, 1), (0, 1)], (x, .615, z), (x, .615 + h_, z), "ceramic", 9, wear=.3)
        m.lathe([(0, 0), (.05, 0), (.045, 1), (0, 1)], (x, .612, z), (x, .622, z), "ceramic", 9, wear=.5)
    # Long bones laid side by side along the front edge.
    for i in range(5):
        x = -.28 + i * .11
        m.lathe([(.022, 0), (.014, .15), (.011, .5), (.014, .85), (.024, 1)], (x, .635, .0), (x + .03, .635, .3), "ceramic", 7, wear=.5)
    # The pole behind it, antlers at the top, a crossbar for the figures.
    P = np.array((0, 0, -1.25))
    m.log(P + (0, -.25, 0), P + (0.04, 3.5, 0), .075, "logwood", sides=9, segs=3, noise=.05, taper=.2)
    m.collide_post(P[0], P[2], P[0], P[2], .09, 0, 3.4, "pole")
    antlers(m, P + (0.04, 3.2, .0), 0, 1.25)
    bar_y = 2.55
    m.log(P + (-1.05, bar_y - .04, .07), P + (1.05, bar_y + .05, .07), .04, "logwood", sides=7, segs=2, noise=.06)
    m.lash(P + (.03, bar_y, .04), (0, 1, 0), .09, turns=5, width=.016)
    for x, size, drop, yaw in ((-.9, 1.7, .3, .3), (-.36, 1.25, .75, 1.2), (.45, 1.55, .2, -.4), (.95, 1.15, .9, .9)):
        twig_man(m, P + (x, bar_y - .04 + (x + 1.05) / 2.1 * .09 - .03, .07), size, yaw, drop)
    # Cords from the pole out to two of the stones, hung with rags.
    for (sx, sy, sz) in (stones[1], stones[4]):
        a_ = P + np.array((0.04, 3.0, 0))
        b_ = np.array((sx, sy - .08, sz))
        m.wire(a_, b_, .5, .007, "canvas", 12)
        m.lash(b_, (0, 1, 0), .13, turns=2, width=.012)
        along = (b_ - a_) / np.linalg.norm(b_ - a_)
        for t in (.3, .5, .68, .84):
            q = a_ + (b_ - a_) * t - np.array((0, .5 * 4 * t * (1 - t), 0))
            rag(m, q, along, rng.uniform(.3, .65), width=rng.uniform(.1, .2), seed=t * 9 + sx, mat="canvas" if rng.random() < .6 else "canvas_orange")
    m.lash(P + (.04, 3.0, 0), (0, 1, 0), .075, turns=3, width=.014)
    m.radius = 4.4
    return m


def effigy():
    """Three branches lashed at the top and something hanging from them. There are more of these the closer you get."""
    m = Model("effigy", tex=1024, seed=281)
    rng = m.rng
    apex = np.array((0, 1.95, 0))
    for a in (.4, 2.5, 4.6):
        foot = np.array((math.cos(a) * .85, -.15, math.sin(a) * .85))
        over = apex + (apex - foot) * .14
        mid = (foot + over) / 2 + np.array((rng.uniform(-.05, .05), 0, rng.uniform(-.05, .05)))
        m.log(foot, mid, .04, "bark", "endgrain", sides=7, segs=3, noise=.08, taper=.18)
        m.log(mid, over, .033, "bark", "endgrain", sides=7, segs=3, noise=.08, taper=.3)
        # A stone kicked against each foot to stop it walking.
        s_ = rng.uniform(.14, .2)
        c = foot * 1.12 + np.array((0, .15 + s_ * .25, 0))
        m.beam(c - (s_ * .5, 0, 0), c + (s_ * .5, 0, 0), s_ * .9, s_ * .6, "stone", chamfer=s_ * .22)
    m.lash(apex - (0, .02, 0), (0, 1, 0), .075, turns=7, width=.02)
    hip = twig_man(m, apex - (0, .1, 0), 1.9, .3, .22)
    # Bones on cords below it, to knock together when the wind gets in.
    for j, (dx, dz, L) in enumerate(((-.07, .02, .24), (.0, -.05, .32), (.08, .03, .2), (.03, .08, .28))):
        top = hip + np.array((dx * .4, -.02, dz * .4))
        end = hip + np.array((dx, -.2 - j * .03, dz))
        m.tube([top, end], .004, "canvas", 4)
        m.lathe([(.02, 0), (.012, .15), (.009, .5), (.012, .85), (.022, 1)], end + (0, .01, 0), end - (0, L, 0), "ceramic", 7, wear=.5)
    m.collide_post(0, 0, 0, 0, .3, 0, 1.2, "effigy")
    m.radius = 1.4
    return m


def wall_run(m, L, gap=None, seed=0.0):
    """Dry stone wall along x with upright copes. `gap` = (centre, half width) where it has come down."""
    rng = m.rng
    def top(s):
        x = (s - .5) * L
        base = .82 + .05 * math.sin(s * 9 + seed) + .03 * math.sin(s * 23 + seed * 3)
        if gap:
            d = abs(x - gap[0]) / gap[1]
            if d < 1.6:
                base = min(base, .16 + .66 * max(0.0, d - .35) ** 1.3)
        return base
    stone_wall(m, (-L / 2, 0), (L / 2, 0), top, t=.5, h=.14, y0=-.1, lo=.18, hi=.44, stagger=.07)
    # Core, so the joints are dark and not daylight.
    m.density = .25
    for i in range(8):
        s = (i + .5) / 8
        hh = top(s) - .06
        if hh > .12:
            m.box(((s - .5) * L, hh / 2 - .05, 0), (L / 8 + .02, hh, .4), "stone", chamfer=.01)
    m.density = 1
    # Copes on edge, leaning on each other.
    x = -L / 2 + .06
    while x < L / 2 - .05:
        w = rng.uniform(.06, .11)
        s = (x + L / 2) / L
        if not gap or abs(x - gap[0]) > gap[1] * 1.5:
            y = top(s) - .04
            hh = rng.uniform(.15, .22)
            m.beam((x, y, 0), (x + .34 * hh + rng.uniform(-.02, .02), y + hh, rng.uniform(-.015, .015)), .44 + rng.uniform(-.06, .04), w, "stone", up=(1, 0, 0), chamfer=.028)
        x += w * 1.05 + rng.uniform(.0, .012)
    for xx in np.linspace(-L / 2 + .3, L / 2 - .3, 5):
        rubble(m, xx, rng.choice((-.34, .34)), 2, .12, size=(.1, .2))
    if gap:
        rubble(m, gap[0], .6, 16, .9, size=(.14, .36))
        rubble(m, gap[0] + .2, -.45, 5, .5, size=(.14, .3))
        m.collide_box(-L / 4 - gap[0] / 2 - gap[1] / 2 + gap[0] / 2, 0, max(.1, (gap[0] - gap[1] + L / 2) / 2), .27, 0, .95, tag="stone wall")
        m.collide_box((gap[0] + gap[1] + L / 2) / 2, 0, max(.1, (L / 2 - gap[0] - gap[1]) / 2), .27, 0, .95, tag="stone wall")
    else:
        m.collide_box(0, 0, L / 2, .27, 0, 1.05, tag="stone wall")


def wall():
    m = Model("wall", tex=1024, seed=291)
    wall_run(m, 4.0, seed=1.0)
    m.radius = 2.4
    return m


def wall_gap():
    m = Model("wall_gap", tex=1024, seed=292)
    wall_run(m, 4.0, gap=(.3, .75), seed=4.0)
    m.radius = 2.6
    return m


def handwheel(m, c, axis, r=.15, mat="red"):
    """A valve wheel on a stem: rim, four spokes, hub."""
    c, axis = np.asarray(c, float), np.asarray(axis, float)
    axis = axis / np.linalg.norm(axis)
    u = np.cross(axis, (0, 1, 0))
    if np.linalg.norm(u) < 1e-6:
        u = np.array((1.0, 0, 0))
    u = u / np.linalg.norm(u)
    v = np.cross(axis, u)
    m.tube([c + (u * math.cos(t) + v * math.sin(t)) * r for t in np.linspace(0, math.tau, 13)], .012, mat, 6, wear=.5)
    for t in (0, math.pi / 2):
        d = u * math.cos(t) + v * math.sin(t)
        m.tube([c - d * r, c + d * r], .008, mat, 5, wear=.5)
    m.lathe([(.03, 0), (.03, 1)], c - axis * .02, c + axis * .02, "steel_bare", 8)


def mirror_z(m, name):
    """The same leaf for a hinge on the other jamb: mirrored front to back, so its outside face is still outside."""
    m.name = name
    for b in m.parts.values():
        for v in b["v"]:
            v[:, 2] *= -1
        for n in b["n"]:
            n[:, 2] *= -1
        b["f"] = [tuple(reversed(f)) for f in b["f"]]
    return m


def door_steel_r():
    return mirror_z(door_steel(), "door_steel_r")


def door_steel():
    """A plate door for the pump house: hinge edge on the origin, leaf along +x."""
    m = Model("door_steel", tex=1024, seed=305)
    W, H, T = .84, 2.1, .045
    m.box((W / 2, H / 2, 0), (W, H, T), "olive_old", chamfer=.006)
    for z, s_ in ((T / 2 + .004, 1), (-T / 2 - .004, -1)):
        for y in (.32, H - .32):
            m.beam((.03, y, z), (W - .03, y, z), .07, .012, "olive_old", up=(0, 0, s_), chamfer=.003)
        # Pull handle and lock plate on the free edge, the same on both faces.
        hx = W - .1
        m.tube([(hx, .98, z), (hx, .98, z + s_ * .055), (hx, 1.16, z + s_ * .055), (hx, 1.16, z)], .01, "steel_bare", 6, wear=.6)
        m.box((hx, 1.07, z + s_ * .003), (.07, .26, .012), "steel_bare", chamfer=.003)
        m.box((hx - .0, .86, z + s_ * .004), (.05, .08, .014), "brass", chamfer=.004)
    # Hinge knuckles on the outside face at the hinge edge, and their leaves screwed to the door.
    for y in (.3, 1.05, 1.8):
        m.lathe([(.017, 0), (.017, 1)], (.0, y - .06, T / 2 + .012), (.0, y + .06, T / 2 + .012), "steel_bare", 8)
        m.box((.06, y, T / 2 + .005), (.12, .09, .01), "steel_bare", chamfer=.002)
        for dx in (.04, .09):
            m.bolt((dx, y, T / 2 + .01), (0, 0, 1), .006)
    # Where the bar went in beside the lock: bright scrapes and a torn hasp staple.
    m.box((W - .012, 1.3, T / 2 + .004), (.03, .2, .01), "steel_bare", chamfer=.002)
    m.tube([(W - .03, 1.42, T / 2), (W - .03, 1.42, T / 2 + .03), (W - .03, 1.47, T / 2 + .02)], .005, "steel_bare", 5)
    m.radius = 1.2
    return m


def door_plank():
    """A ledged and braced board door: hinge edge on the origin, leaf along +x. Outside face is +z."""
    m = Model("door_plank", tex=1024, seed=306)
    rng = m.rng
    W, H, T = .86, 2.06, .03
    n = 5
    bw = W / n
    for i in range(n):
        x = (i + .5) * bw
        m.beam((x, .0 + rng.uniform(0, .012), 0), (x, H - rng.uniform(0, .012), 0), bw - .004, T, "wood_dark" if i == 3 else "wood", up=(0, 0, 1), chamfer=.004)
    # Ledges and a brace on the inside face, clenched nails through each board.
    zi = -T / 2 - .014
    for y in (.3, 1.05, 1.78):
        m.beam((.03, y, zi), (W - .03, y, zi), .11, .028, "wood_dark", up=(0, 0, 1), chamfer=.004)
        for i in range(n):
            m.nail(((i + .5) * bw, y, T / 2 + .001), (0, 0, 1))
    m.beam((.07, .37, zi), (W - .07, .98, zi), .09, .026, "wood_dark", up=(0, 0, 1), chamfer=.004)
    m.beam((.07, 1.12, zi), (W - .07, 1.71, zi), .09, .026, "wood_dark", up=(0, 0, 1), chamfer=.004)
    # Strap hinges on the outside, knuckles on the hinge edge.
    zo = T / 2 + .005
    for y in (.3, 1.78):
        m.beam((.0, y, zo), (.56, y, zo), .045, .008, "soot_iron", up=(0, 0, 1), chamfer=.002)
        m.lathe([(.016, 0), (.016, 1)], (.0, y - .05, zo + .008), (.0, y + .05, zo + .008), "soot_iron", 8)
        for dx in (.1, .3, .5):
            m.bolt((dx, y, zo + .004), (0, 0, 1), .007, "soot_iron")
    # Thumb latch and a pull, both faces.
    for z, s_ in ((zo, 1), (-T / 2 - .004, -1)):
        hx = W - .09
        m.tube([(hx, 1.0, z), (hx, 1.0, z + s_ * .05), (hx, 1.15, z + s_ * .05), (hx, 1.15, z)], .009, "soot_iron", 6)
        m.box((hx, 1.075, z + s_ * .002), (.05, .22, .008), "soot_iron", chamfer=.002)
    m.radius = 1.2
    return m


def pumphouse():
    """A block-built pump house on the old water main. The door has been levered open; there is room to stand inside."""
    poster_material("sign_water", os.path.join(ART, "sign_water.png"))
    m = Model("pumphouse", tex=4096, seed=301)
    rng = m.rng
    W, D, H, T = 1.7, 1.4, 2.5, .2
    DX0, DX1, FL, DH = .08, 1.0, .08, 2.22
    BL, CO = "block_old", "concrete_old"
    # Floor slab runs out under the door as an apron.
    m.box((0, FL / 2 - .03, 0), (2 * W - .02, FL + .06, 2 * D - .02), CO, chamfer=.004)
    m.box((.5, FL / 2 - .05, D + .62), (1.9, FL + .06, 1.25), CO, chamfer=.02)
    m.collide_box(0, 0, W, D, -.2, FL, tag="pump house floor")
    m.collide_box(.5, D + .62, .95, .62, -.2, FL - .02, tag="apron")
    # Walls: each its own collider, the doorway left open.
    m.box((0, H / 2 - .05, -D + T / 2), (2 * W, H + .1, T), BL, chamfer=.004)
    m.collide_box(0, -D + T / 2, W, T / 2, 0, H, tag="pump house wall")
    for sx in (-1, 1):
        m.box((sx * (W - T / 2), H / 2 - .05, 0), (T, H + .1, 2 * D - 2 * T + .002), BL, chamfer=.004)
        m.collide_box(sx * (W - T / 2), 0, T / 2, D, 0, H, tag="pump house wall")
    m.box(((-W + DX0) / 2, H / 2 - .05, D - T / 2), (DX0 + W, H + .1, T), BL, chamfer=.004)
    m.collide_box((-W + DX0) / 2, D - T / 2, (DX0 + W) / 2, T / 2, 0, H, tag="pump house wall")
    m.box(((W + DX1) / 2, H / 2 - .05, D - T / 2), (W - DX1, H + .1, T), BL, chamfer=.004)
    m.collide_box((W + DX1) / 2, D - T / 2, (W - DX1) / 2, T / 2, 0, H, tag="pump house wall")
    m.box(((DX0 + DX1) / 2, (DH + H) / 2, D - T / 2), (DX1 - DX0, H - DH, T), CO, chamfer=.004)
    m.collide_box((DX0 + DX1) / 2, D - T / 2, (DX1 - DX0) / 2, T / 2, DH, H, tag="door lintel")
    # Roof slab, a crack of daylight nowhere: it is black inside until your eyes adjust.
    m.box((0, H + .07, 0), (2 * W + .36, .15, 2 * D + .36), CO, chamfer=.02)
    m.collide_box(0, 0, W + .18, D + .18, H, H + .15, tag="pump house roof")
    # Steel frame in the opening. The leaf itself is a separate, hinged model.
    for x in (DX0 + .02, DX1 - .02):
        m.beam((x, FL, D - .02), (x, DH, D - .02), .04, .12, "steel", up=(0, 0, 1), chamfer=.004)
    m.beam((DX0, DH - .02, D - .02), (DX1, DH - .02, D - .02), .12, .04, "steel", up=(0, 1, 0), chamfer=.004)
    m.door("door_steel_r", (DX1 - .04, FL + .012, D + .045), math.pi, 1.85, width=.84, height=2.1, thickness=.045, start=.55)
    # The hasp it was locked with, torn off and left on the apron with the padlock still through it.
    m.box((.25, FL - .014, D + .5), (.16, .012, .04), "steel_bare", chamfer=.003)
    m.box((.35, FL - .006, D + .52), (.05, .03, .06), "brass", chamfer=.006)
    # Sign, lamp over the door, a switch box and its conduit.
    m.box((-.85, 1.6, D + .006), (.66, .46, .012), "galv", chamfer=.003)
    m.poster("sign_water", (-.85, 1.6, D + .0135), (1, 0, 0), (0, 1, 0), .62, .42, density=3)
    for (x, y) in ((-1.13, 1.78), (-.57, 1.78), (-1.13, 1.42), (-.57, 1.42)):
        m.bolt((x, y, D + .012), (0, 0, 1), .007)
    lx, ly = (DX0 + DX1) / 2, DH + .16
    m.box((lx, ly + .03, D + .05), (.1, .08, .1), "steel", chamfer=.008)
    m.lathe([(.035, 0), (.05, .3), (.05, .8), (.03, 1), (0, 1)], (lx, ly, D + .1), (lx, ly, D + .24), "glass", 10)
    for t in (0, 1.57, 3.14, 4.71):
        m.tube([(lx + math.cos(t) * .055, ly + math.sin(t) * .055, D + .1), (lx + math.cos(t) * .055, ly + math.sin(t) * .055, D + .25), (lx, ly, D + .27)], .003, "steel_bare", 4)
    m.box((1.38, 1.3, D + .05), (.26, .36, .1), "steel", chamfer=.008)
    m.tube([(1.38, 1.48, D + .03), (1.38, H - .06, D + .03), (lx + .08, H - .06, D + .03), (lx + .05, ly + .07, D + .04)], .011, "galv", 6)
    m.tube([(1.38, 1.12, D + .03), (1.38, .0, D + .03)], .011, "galv", 6)
    for y in (.5, 1.9):
        m.box((1.38, y, D + .012), (.06, .02, .024), "steel_bare", chamfer=.003)
    # Louvred vent high on one side.
    m.box((-W - .012, 2.05, -.3), (.03, .44, .64), "steel", chamfer=.004)
    for i in range(5):
        y = 1.89 + i * .08
        m.beam((-W - .03, y, -.59), (-W - .03, y, -.01), .07, .008, "steel_bare", up=(.6, .8, 0), chamfer=.002)
    # The main: from the pump, out through the wall, a gate valve, down into the ground.
    py, pz = .6, -.45
    m.tube([(.75, py, pz), (W + .95, py, pz), (W + .95, -.25, pz)], .085, "steel_bare", 12, wear=.55)
    for x in (W + .012, W + .3, W + .62, W - T - .012):
        m.lathe([(.085, 0), (.13, .02), (.13, .98), (.085, 1)], (x - .018, py, pz), (x + .018, py, pz), "steel", 12)
    m.lathe([(.09, 0), (.12, .15), (.12, .85), (.09, 1)], (W + .33, py, pz), (W + .59, py, pz), "olive_old", 12)
    m.lathe([(.06, 0), (.045, .4), (.02, .5), (.02, 1)], (W + .46, py + .1, pz), (W + .46, py + .5, pz), "olive_old", 10)
    handwheel(m, (W + .46, py + .5, pz), (0, 1, 0), .16, "red_old")
    m.collide_post(W + .2, pz, W + .95, pz, .12, 0, py + .55, "water main")
    # Inside: the pump set on its plinth against the back wall, the suction pipe going down through the floor.
    m.box((.35, FL + .11, -.62), (1.5, .22, .85), CO, chamfer=.02)
    m.lathe([(0, 0), (.2, .02), (.22, .1), (.22, .9), (.2, .98), (0, 1)], (-.2, py, pz), (.42, py, pz), "olive_old", 18)
    for xx in np.linspace(-.12, .34, 7):
        m.lathe([(.22, 0), (.245, .3), (.245, .7), (.22, 1)], (xx - .012, py, pz), (xx + .012, py, pz), "olive_old", 18)
    m.box((.1, FL + .28, pz), (.5, .14, .36), "steel", chamfer=.01)
    m.lathe([(0, 0), (.16, .0), (.24, .25), (.24, .75), (.16, 1), (0, 1)], (.5, py, pz), (.78, py, pz), "steel_bare", 16, wear=.5)
    m.box((.64, FL + .28, pz), (.3, .14, .3), "steel", chamfer=.01)
    m.tube([(.64, py + .2, pz), (.64, py + .5, pz), (.64, py + .5, pz + .45), (.64, FL - .1, pz + .45)], .06, "steel_bare", 10, wear=.5)
    m.lathe([(.062, 0), (.1, .02), (.1, .98), (.062, 1)], (.64, py + .3, pz), (.64, py + .34, pz), "steel", 10)
    m.collide_box(.35, -.62, .76, .43, 0, 1.25, tag="pump set")
    # Starter panel on the back wall with its conduit, and a pressure gauge on the delivery pipe.
    m.box((-1.0, 1.45, -D + T + .06), (.5, .7, .12), "steel", chamfer=.008)
    for (bx, by) in ((-1.12, 1.6), (-.88, 1.6)):
        m.lathe([(0, 0), (.03, 0), (.03, 1), (0, 1)], (bx, by, -D + T + .12), (bx, by, -D + T + .135), "red_old" if bx < -1 else "olive_old", 10)
    m.box((-1.0, 1.28, -D + T + .125), (.06, .14, .02), "steel_bare", chamfer=.004)
    m.tube([(-1.0, 1.1, -D + T + .04), (-1.0, .5, -D + T + .04), (-.2, .5, -D + T + .04), (-.1, py - .1, pz - .1)], .012, "galv", 6)
    m.tube([(1.0, py + .08, pz), (1.0, py + .22, pz)], .008, "brass", 6)
    m.lathe([(0, 0), (.05, 0), (.05, 1), (0, 1)], (1.0, py + .27, pz - .012), (1.0, py + .27, pz + .012), "brass", 14)
    # A shelf on the side wall: an oil can and a rag. An upturned crate to sit on.
    m.plank((-W + T + .13, 1.2, -.75), (-W + T + .13, 1.2, .45), .24, .025, "wood", warp=.004)
    for z in (-.6, .3):
        m.beam((-W + T + .02, 1.185, z), (-W + T + .24, 1.185, z), .03, .03, "steel", chamfer=.003)
        m.beam((-W + T + .02, .98, z), (-W + T + .22, 1.17, z), .02, .02, "steel", chamfer=.003)
    m.lathe([(0, 0), (.05, .02), (.05, .7), (.012, .9), (.008, 1)], (-W + T + .13, 1.213, -.3), (-W + T + .13, 1.36, -.3), "olive_old", 10)
    m.box((-W + T + .13, 1.22, .15), (.16, .02, .2), "canvas", chamfer=.008)
    m.box((-1.0, FL + .16, .75), (.46, .32, .36), "wood", chamfer=.01, yaw=.3)
    m.collide_box(-1.0, .75, .23, .18, 0, FL + .33, yaw=.3, tag="crate")
    # A second, smaller line outside with a tap, and a drain under it.
    m.tube([(W - .05, 1.0, .5), (W + .16, 1.0, .5), (W + .16, .72, .5), (W + .26, .7, .5)], .02, "galv", 8)
    m.lathe([(.012, 0), (.012, 1)], (W + .16, 1.0, .5), (W + .16, 1.07, .5), "brass", 6)
    handwheel(m, (W + .16, 1.06, .5), (0, 1, 0), .045, "brass")
    m.lathe([(.022, 0), (.03, .4), (.03, 1)], (W + .2, .705, .5), (W + .285, .695, .5), "brass", 8)
    m.box((W + .3, .03, .5), (.5, .1, .5), CO, chamfer=.02)
    m.box((W + .3, .085, .5), (.3, .012, .3), "steel_bare", chamfer=.002)
    m.radius = 3.6
    return m


def watertower():
    """A stave tank on a timber trestle, from when the line ran steam. The gauge board says it is not empty."""
    m = Model("watertower", tex=4096, seed=311)
    rng = m.rng
    TOP = 5.05
    off = lambda y: 1.95 - .45 * (y / TOP)
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.box((sx * 1.95, .0, sz * 1.95), (.56, .3, .56), "concrete", chamfer=.03)
            m.log((sx * 1.95, .1, sz * 1.95), (sx * 1.5, TOP, sz * 1.5), .13, "logwood", sides=10, segs=4, noise=.03, taper=.12)
            m.collide_post(sx * 1.95, sz * 1.95, sx * 1.6, sz * 1.6, .17, 0, TOP, "tower leg")
            m.box((sx * 1.93, .2, sz * 1.93), (.3, .1, .3), "steel", chamfer=.01)
    # Girts and cross braces, bolted on outside the legs.
    levels = (.35, 1.9, 3.5, TOP - .12)
    for y in levels[1:3]:
        o = off(y) + .1
        for s in (-1, 1):
            m.beam((-o - .25, y, s * o), (o + .25, y, s * o), .16, .07, "wood_dark", up=(0, 0, 1), chamfer=.008)
            m.beam((s * (o + .07), y - .16, -o - .25), (s * (o + .07), y - .16, o + .25), .16, .07, "wood_dark", up=(1, 0, 0), chamfer=.008)
            for e in (-1, 1):
                m.bolt((e * (o - .1), y, s * (o + .037)), (0, 0, s), .016)
                m.bolt((s * (o + .107), y - .16, e * (o - .1)), (s, 0, 0), .016)
    for b in range(3):
        y0, y1 = levels[b] + .1, levels[b + 1] - .1
        o0, o1 = off(y0) + .12, off(y1) + .12
        for s in (-1, 1):
            for k, flip in enumerate((1, -1)):
                if b == 0 and s == 1 and k == 1:
                    continue   # one low brace has been taken for firewood
                if b == 1 and s == -1 and k == 0:
                    # Snapped: half still bolted on, the other half hanging by its top bolt.
                    m.plank((-flip * o0, y0, s * (o0 + out)), (-flip * o0 * .2, (y0 + y1) / 2 - .1, s * ((o0 + o1) / 2 + out)), .15, .04, "wood", up=(0, 0, 1), warp=.0, segs=1)
                    m.plank((flip * o1, y1, s * (o1 + out)), (flip * o1 * .9, y1 - .85, s * (o1 + out + .03)), .15, .04, "wood", up=(0, 0, 1), warp=.0, segs=1)
                    m.plank((s * (o0 + .07 + out), y0, -flip * o0), (s * (o1 + .07 + out), y1, flip * o1), .15, .04, "wood", up=(1, 0, 0), warp=.006, segs=2)
                    continue
                out = .045 * k
                m.plank((-flip * o0, y0, s * (o0 + out)), (flip * o1, y1, s * (o1 + out)), .15, .04, "wood", up=(0, 0, 1), warp=.006, segs=2)
                m.plank((s * (o0 + .07 + out), y0, -flip * o0), (s * (o1 + .07 + out), y1, flip * o1), .15, .04, "wood", up=(1, 0, 0), warp=.006, segs=2)
    # Bearers, joists, deck.
    for s in (-1, 1):
        m.beam((-2.25, TOP + .1, s * 1.5), (2.25, TOP + .1, s * 1.5), .22, .24, "wood_dark", chamfer=.012)
    for x in np.linspace(-1.95, 1.95, 6):
        m.beam((x, TOP + .3, -2.2), (x, TOP + .3, 2.2), .1, .17, "wood_dark", chamfer=.008)
    DECK = TOP + .41
    for i, z in enumerate(np.linspace(-2.1, 2.1, 15)):
        m.plank((-2.2 + rng.uniform(-.06, .04), DECK, z), (2.2 + rng.uniform(-.04, .06), DECK, z), .285, .045, "wood", warp=.006)
    BASE = DECK + .023
    # The tank: staves, hoops with their lugs, a tin cone on top.
    R, TH, N = 1.6, 2.45, 30
    for i in range(N):
        a = i / N * math.tau
        d = np.array((math.cos(a), 0, math.sin(a)))
        h_ = TH + rng.uniform(-.02, .02)
        m.beam(d * R + (0, BASE, 0), d * R + (0, BASE + h_, 0), 2 * math.pi * R / N - .004, .05, "wood_dark" if i % 7 == 3 else "wood", up=d, chamfer=.006)
    for j, y in enumerate((BASE + .18, BASE + .75, BASE + 1.4, BASE + 2.15)):
        m.lathe([(R + .03, 0), (R + .052, .12), (R + .055, .5), (R + .052, .88), (R + .03, 1)], (0, y - .045, 0), (0, y + .045, 0), "galv", 30, wear=.7)
        a = .6 + j * 1.3
        d = np.array((math.cos(a), 0, math.sin(a)))
        t = np.array((-math.sin(a), 0, math.cos(a)))
        m.beam(d * (R + .075) + (0, y, 0) - t * .12, d * (R + .075) + (0, y, 0) + t * .12, .09, .05, "steel", up=d, chamfer=.008)
        m.bolt(d * (R + .1) + (0, y, 0) - t * .06, d, .016)
        m.bolt(d * (R + .1) + (0, y, 0) + t * .06, d, .016)
    m.density = .3
    m.lathe([(0, 0), (R - .03, 0)], (0, BASE + TH - .05, 0), (0, BASE + TH - .049, 0), "void", 24)
    m.density = 1
    m.lathe([(R + .22, 0), (R + .2, .02), (.14, .96), (.0, 1)], (0, BASE + TH - .04, 0), (0, BASE + TH + .82, 0), "tin_old", 30, wear=.5)
    for i in range(10):
        a = i / 10 * math.tau + .2
        d = np.array((math.cos(a), 0, math.sin(a)))
        m.beam(d * (R + .2) + (0, BASE + TH - .012, 0), d * .15 + (0, BASE + TH + .8, 0), .05, .014, "tin_old", up=(0, 1, 0), chamfer=.004)
    m.lathe([(.05, 0), (.07, .5), (.0, 1)], (0, BASE + TH + .76, 0), (0, BASE + TH + 1.0, 0), "steel_bare", 8)
    # Outlet: down through the deck, a valve at hand height, out to a spout beyond the legs.
    m.tube([(.0, BASE - .02, .0), (.0, 1.35, .0), (2.75, 1.25, .0), (2.85, .95, .0)], .06, "steel_bare", 10, wear=.55)
    m.lathe([(.062, 0), (.1, .02), (.1, .98), (.062, 1)], (0, BASE - .5, 0), (0, BASE - .46, 0), "steel", 10)
    m.lathe([(.065, 0), (.095, .15), (.095, .85), (.065, 1)], (.0, 1.75, 0), (.0, 2.05, 0), "olive", 12)
    m.lathe([(.04, 0), (.02, .3), (.02, 1)], (.07, 1.9, 0), (.4, 1.9, 0), "olive", 8)
    handwheel(m, (.4, 1.9, 0), (1, 0, 0), .15)
    # The pipe is strapped to a girt where it passes.
    o = off(1.9) + .1
    m.tube([(o - .0, 1.9, .12), (o + .06, 1.33, .1), (o + .06, 1.24, 0), (o + .06, 1.33, -.1), (o, 1.9, -.12)], .008, "steel_bare", 5)
    for yb in (3.5, 4.6):
        m.tube([(-.1, yb, -.5), (-.07, yb, -.07), (.0, yb, .075), (.07, yb, -.07), (.1, yb, -.5)], .01, "steel_bare", 5)
        m.beam((-1.6, yb, -.5), (1.6, yb, -.5), .06, .1, "wood_dark", chamfer=.006)
    m.collide_post(0, 0, 2.8, 0, .08, 0, 1.4, "outlet pipe")
    m.collide_post(0, 0, 0, 0, .1, 0, 5, "outlet pipe")
    # Gauge board down the side of the tank: a weight on a wire over a pulley shows the level.
    gz = R + .03
    m.plank((.0, BASE + .15, gz + .02), (.0, BASE + TH - .1, gz + .02), .2, .025, "white_paint", up=(0, 0, 1), warp=0)
    for i in range(9):
        y = BASE + .3 + i * .24
        m.box((.0 - .04 + (i % 2) * .02, y, gz + .034), (.1 - (i % 2) * .04, .014, .004), "void", chamfer=.001)
    m.lathe([(.04, 0), (.05, .5), (.04, 1)], (.14, BASE + TH + .0, gz + .02), (.14, BASE + TH, gz + .05), "steel_bare", 10)
    m.tube([(.14, BASE + TH + .04, gz + .035), (.14, BASE + 1.5, gz + .045)], .0025, "steel_bare", 4)
    m.box((.14, BASE + 1.45, gz + .045), (.06, .1, .03), "red", chamfer=.006)
    m.tube([(.14, BASE + TH + .02, gz + .02), (.14, BASE + TH + .02, gz - .05)], .008, "steel_bare", 5)
    m.radius = 4.6
    return m


def bench():
    """A rest on a long path: a split log on two stumps with a rail to lean on. Somebody has cut tally marks in the seat."""
    m = Model("bench", tex=1024, seed=331)
    rng = m.rng
    for x in (-.62, .62):
        m.log((x, -.12, 0), (x + rng.uniform(-.02, .02), .4, rng.uniform(-.02, .02)), .17, "bark", "endgrain", sides=10, segs=2, noise=.06)
    # Seat: a trunk split down its length, flat side up.
    def seat(u, v):
        x = (u - .5) * 1.9
        a = math.pi + v * math.pi
        r = .19 * (1 + .05 * math.sin(u * 9))
        return np.array((x, .41 + .16 + math.sin(a) * r * .85, math.cos(a) * r + .01 * math.sin(u * 14)))
    m.surface("bark", seat, 12, 8, (3.8, 1.2), wear=lambda u, v: .3)
    m.beam((-.95, .565, 0), (.95, .57, 0), .37, .02, "logwood", chamfer=.004, segs=3, warp=.004)
    for x in (-.95, .95):
        m.lathe([(0, 0), (.185, 0)], (x, .46, 0), (x + math.copysign(.002, x), .46, 0), "endgrain", 10)
    # Back rail on two leaning posts let into the ground behind the stumps.
    for x in (-.7, .7):
        m.log((x, -.15, -.26), (x + rng.uniform(-.02, .02), .98, -.36), .04, "logwood", sides=7, segs=1, noise=.05)
        m.lash((x, .9, -.352), (0, 1, 0), .05, turns=3, width=.012)
    m.log((-.95, .9, -.39), (.95, .92, -.4), .036, "logwood", sides=7, segs=2, noise=.05)
    # Tally marks: five, five, and three.
    for g, n_ in ((-.5, 5), (-.2, 5), (.1, 3)):
        for i in range(n_ - (1 if n_ == 5 else 0)):
            m.box((g + i * .035, .581, .04), (.008, .003, .09), "void", chamfer=.001)
        if n_ == 5:
            m.box((g + .05, .5815, .04), (.16, .003, .008), "void", chamfer=.001, yaw=.5)
    m.collide_box(0, 0, .95, .2, 0, .58, tag="bench")
    m.collide_post(-.7, -.38, .7, -.38, .05, 0, .95, "bench rail")
    m.radius = 1.4
    return m


def streetlight():
    """A sodium lamp on a galvanised column, the kind a county puts up at a junction and never comes back to."""
    m = Model("streetlight", tex=1024, seed=321)
    H = 6.4
    m.box((0, -.02, 0), (.6, .34, .6), "concrete_old", chamfer=.03)
    m.box((0, .165, 0), (.34, .025, .34), "steel_bare", chamfer=.004)
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.lathe([(.018, 0), (.018, 1)], (sx * .125, .17, sz * .125), (sx * .125, .215, sz * .125), "steel_bare", 6)
    m.lathe([(.1, 0), (.095, .02), (.085, .2), (.062, .97), (.058, 1)], (0, .17, 0), (0, H, 0), "galv", 12, wear=.35)
    # Access hatch near the foot, its cover hanging by one screw.
    m.box((0, .95, -.088), (.11, .34, .012), "steel_bare", chamfer=.003)
    m.box((.03, .86, -.1), (.11, .3, .008), "galv", yaw=.3, chamfer=.003)
    # Swan-neck arm out over the road and the lamp head on the end of it.
    m.tube([(0, H - .12, 0), (0, H + .2, .12), (0, H + .3, .6), (0, H + .24, 1.05)], .03, "galv", 8, wear=.35)
    m.lathe([(.06, 0), (.064, .5), (.06, 1)], (0, H - .16, 0), (0, H - .02, 0), "steel_bare", 10)
    m.loft("olive_old", [(.86, .02, .02, H + .24, 3), (.9, .09, .05, H + .24, 4), (1.2, .13, .065, H + .225, 4), (1.5, .11, .055, H + .215, 4), (1.56, .02, .02, H + .21, 3)], 14)
    m.box((0, H + .165, 1.24), (.2, .016, .46), "ceramic", chamfer=.004)
    # A band clamp with a route marker, and what is left of a notice taped round the column.
    m.lathe([(.088, 0), (.092, .5), (.088, 1)], (0, 1.9, 0), (0, 1.96, 0), "steel_bare", 12)
    m.box((0, 2.14, .086), (.16, .22, .008), "white_old", chamfer=.003)
    m.collide_post(0, 0, 0, 0, .13, 0, H, "lamp column")
    m.hook("lamp", (0, H + .15, 1.24))
    m.radius = 2
    return m


ASSETS = {n: (f, None) for n, f in dict(streetlight=streetlight, bench=bench, well=well, ruin=ruin, gate=gate, busstop=busstop, graves=graves, shrine=shrine, effigy=effigy, wall=wall, wall_gap=wall_gap, pumphouse=pumphouse, watertower=watertower, door_steel=door_steel, door_steel_r=door_steel_r, door_plank=door_plank).items()}
