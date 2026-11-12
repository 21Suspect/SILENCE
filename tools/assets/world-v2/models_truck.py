"""A 1950s stepside pickup left at the trailhead, sunk onto its rims.

Front is +Z. Everything here is fastened to the ladder frame or to a panel that is.
"""
import math

import numpy as np

from kit import Model

F_AXLE, R_AXLE = 1.5, -1.45
WHEEL_R = .37
BODY = "truck"


def tyre(m, x, z, flat, side):
    """Square-shouldered section with real tread blocks and a sagging contact patch."""
    y = WHEEL_R * (1 - flat * .3)
    section = [(.0, .02), (.12, .1), (.135, .23), (.125, .36), (.09, .375)]
    def fn(u, v):
        th = u * 2 * math.pi
        # v walks the section from the bead on one side, over the crown, to the other.
        s = v * 2
        if s < 1:
            k = s * (len(section) - 1)
            i = min(int(k), len(section) - 2)
            a, b = section[i], section[i + 1]
            wx, r = a[0] + (b[0] - a[0]) * (k - i), a[1] + (b[1] - a[1]) * (k - i)
            wx = -wx
        else:
            k = (2 - s) * (len(section) - 1)
            i = min(int(k), len(section) - 2)
            a, b = section[i], section[i + 1]
            wx, r = a[0] + (b[0] - a[0]) * (k - i), a[1] + (b[1] - a[1]) * (k - i)
        crown = abs(wx) < .1 and r > .33
        tread = .014 if crown and (int(u * 40) % 2 == 0) else 0.0
        rad = .19 + r * .49 + tread
        yy = y + math.sin(th) * rad
        if yy < .015:
            yy = .015 + (yy - .015) * .12
        return np.array((x + wx, yy, z + math.cos(th) * rad))
    m.surface("tyre", fn, 40, 11, (7, 1.6))
    # Steel wheel, hubcap, lug nuts.
    m.lathe([(.0, 0), (.1, .05), (.13, .3), (.2, .4), (.205, 1)], (x + side * .075, y, z), (x - side * .06, y, z), "steel", 18)
    m.lathe([(0, 0), (.075, .25), (.085, 1)], (x + side * .1, y, z), (x + side * .07, y, z), "chrome", 14)
    for k in range(5):
        a = k * 2 * math.pi / 5
        m.bolt((x + side * .082, y + math.sin(a) * .115, z + math.cos(a) * .115), (side, 0, 0), .011)
    return y


def fender(m, side, axle, front, back, top, crown=.13):
    """One continuous skin from the body side, over the wheel, down to the opening."""
    open_r = .54
    def fn(u, v):
        z = back + (front - back) * u
        dist = z - axle
        # Fender rises over the wheel and falls away at both ends, like stamped steel.
        rise = math.exp(-(dist / .85) ** 2)
        y_top = top - .3 * (1 - rise)
        inner, outer = side * .6, side * 1.0
        if v < .55:
            t = v / .55
            x = inner + (outer - inner) * math.sin(t * math.pi / 2)
            y = y_top + crown * math.cos(t * math.pi / 2) * rise - .02 * t
        else:
            t = (v - .55) / .45
            x = outer + side * .01 * math.sin(t * math.pi)
            edge = .5 + math.sqrt(max(0, open_r ** 2 - dist ** 2)) if abs(dist) < open_r else .5
            y = y_top + (edge - y_top) * t
        return np.array((x, y, z))
    m.surface(BODY, fn, 28, 12, (3.2, 1.8), flip=side > 0, wear=lambda u, v: v ** 3 * .85)


def pickup():
    m = Model("pickup", tex=2048, seed=81)
    # Rolling chassis: frame rails, crossmembers, leaf springs, driveline.
    for x in (-.42, .42):
        m.beam((x, .47, -2.45), (x, .47, 2.35), .07, .14, "steel")
        for z in (F_AXLE, R_AXLE):
            for i in range(3):
                L = .62 - i * .14
                m.beam((x, .33 - i * .018, z - L), (x, .33 - i * .018, z + L), .06, .018, "steel", up=(0, 1, 0), chamfer=.003)
            m.beam((x, .33, z - .02), (x, .47, z - .02), .07, .05, "steel")
    for z in (-2.3, -.5, 1.0, 2.25):
        m.beam((-.42, .47, z), (.42, .47, z), .06, .1, "steel")
    wheels = ((-.8, F_AXLE, .9, -1), (.8, F_AXLE, .5, 1), (-.8, R_AXLE, .4, -1), (.8, R_AXLE, .95, 1))
    ys = [tyre(m, *w) for w in wheels]
    for (x, z, _, side), y in zip(wheels, ys):
        m.tube([(x - side * .05, y, z), (side * .42 * .3, .33, z)], .032, "steel", 8)
    m.tube([(0, .36, -1.4), (0, .4, .4), (0, .46, 1.0)], .036, "steel", 8)

    # Cab tub: lower body as a clean box-section skin, floor to belt line.
    S = 7.0
    m.loft(BODY, [(-.44, .02, .02, .9, S), (-.42, .8, .46, .9, S), (-.3, .84, .47, .9, S), (.56, .84, .47, .9, S), (.92, .76, .44, .92, S), (.95, .02, .02, .92, S)], 32)

    # Greenhouse: real pillars, roof and glass, with the interior behind it.
    BELT = 1.32
    ROOF = 1.93
    pillars = {
        "a": lambda s: ((s * .78, BELT, .78), (s * .68, ROOF - .05, .34)),
        "c": lambda s: ((s * .8, BELT, -.38), (s * .72, ROOF - .05, -.34)),
    }
    for s in (-1, 1):
        a, b = pillars["a"](s)
        m.beam(a, b, .075, .1, BODY, up=(s, .1, 0), chamfer=.02)
        a, b = pillars["c"](s)
        m.beam(a, b, .22, .1, BODY, up=(s, .1, 0), chamfer=.025)
        # Door window frame along the belt and the head.
        m.beam((s * .8, BELT + .02, -.3), (s * .78, BELT + .02, .78), .05, .08, BODY, up=(s, 0, 0), chamfer=.012)
        m.beam((s * .72, ROOF - .07, -.3), (s * .69, ROOF - .07, .38), .05, .08, BODY, up=(s, 0, 0), chamfer=.012)
        # Door shut lines and hardware are on the tub skin, not hovering off it.
        for a, b in (((s * .846, .55, -.28), (s * .846, BELT - .02, -.28)), ((s * .846, .55, .62), (s * .846, BELT - .02, .62)), ((s * .846, .55, -.28), (s * .846, .55, .62))):
            m.beam(a, b, .01, .012, "void", up=(s, 0, 0), chamfer=.001)
        m.cyl((s * .845, 1.2, -.14), (s * .87, 1.2, -.14), .012, "chrome", 8)
        m.cyl((s * .87, 1.2, -.2), (s * .87, 1.2, -.04), .012, "chrome", 8)
        for z in (-.2, .28):
            m.box((s * .85, 1.05, z + .34), (.02, .14, .05), "chrome", chamfer=.004)   # exposed hinges
        # Fender bolts along the cowl seam.
        for z in (.72, .78, .84):
            m.bolt((s * .845, 1.05, z), (s, 0, 0), .007, "steel_bare")
        # Mirror on a stay clamped to the A-pillar.
        m.tube([(s * .76, 1.5, .62), (s * .96, 1.56, .63)], .009, "chrome", 6)
        m.box((s * 1.0, 1.6, .63), (.05, .17, .13), "chrome", chamfer=.02)
    # Glass: driver side is smashed so you can see in; panes sit inside the frames.
    def pane(p0, p1, p2, p3, mat="glass"):
        pts = [np.asarray(q, float) for q in (p0, p1, p2, p3)]
        def fn(u, v):
            return pts[0] * (1 - u) * (1 - v) + pts[1] * u * (1 - v) + pts[2] * u * v + pts[3] * (1 - u) * v
        m.surface(mat, fn, 1, 1, (1, 1))
    pane((.77, BELT, -.29), (.77, BELT, .76), (.68, ROOF - .07, .36), (.71, ROOF - .07, -.29))
    # A jagged fringe of glass left in the broken frame.
    for i in range(7):
        z0 = -.28 + i * .15
        h = BELT + .03 + m.rng.uniform(.04, .17)
        pane((-.78, BELT + .01, z0), (-.78, BELT + .01, z0 + .15), (-.77, BELT + .03, z0 + .15), (-.77, h, z0 + .06))
    # Windshield: two flat panes with a centre bar and a wiper.
    pane((-.73, BELT + .02, .77), (-.02, BELT + .02, .77), (-.02, ROOF - .07, .38), (-.65, ROOF - .07, .38))
    pane((.02, BELT + .02, .77), (.73, BELT + .02, .77), (.65, ROOF - .07, .38), (.02, ROOF - .07, .38))
    m.beam((0, BELT, .78), (0, ROOF - .06, .38), .035, .04, BODY, up=(0, .6, .8), chamfer=.01)
    m.beam((-.72, BELT + .01, .79), (.72, BELT + .01, .79), .05, .06, BODY, up=(0, 1, 0), chamfer=.012)
    m.beam((-.64, ROOF - .06, .37), (.64, ROOF - .06, .37), .05, .07, BODY, up=(0, 1, 0), chamfer=.012)
    m.tube([(-.42, BELT + .02, .8), (-.2, BELT + .3, .68)], .005, "steel_bare", 5)
    # Rear wall: a single stamped panel from belt to roof, its window in a rubber seal.
    def rear(u, v):
        y = BELT + v * (ROOF - BELT - .04)
        return np.array(((u - .5) * (1.6 - v * .16), y, -.385 - .01 * v))
    m.surface(BODY, rear, 8, 6, (3.2, 1.2), flip=True)
    pane((.46, BELT + .17, -.402), (-.46, BELT + .17, -.402), (-.44, ROOF - .17, -.405), (.44, ROOF - .17, -.405))
    corners = [(.48, BELT + .15), (-.48, BELT + .15), (-.46, ROOF - .15), (.46, ROOF - .15)]
    for i in range(4):
        (ax, ay), (bx, by) = corners[i], corners[(i + 1) % 4]
        m.beam((ax, ay, -.405), (bx, by, -.405), .035, .018, "rubber", up=(0, 0, 1), chamfer=.005)
    # Roof: a single crowned stamping, seated on the pillars and frame rails.
    def roof(u, v):
        x = (u - .5) * 1.5
        z = -.44 + v * .86
        crown = .085 * (1 - (2 * u - 1) ** 2) * (1 - .55 * (2 * v - 1) ** 2)
        edge = max(0, abs(2 * v - 1) - .75) * .2 + max(0, abs(2 * u - 1) - .82) * .3
        return np.array((x, ROOF - .05 + crown - edge, z))
    m.surface(BODY, roof, 18, 12, (3, 1.8), wear=lambda u, v: (abs(2 * u - 1) ** 6 + abs(2 * v - 1) ** 6) * .7)
    # Cab interior for the smashed window: bench seat, dash, a steering wheel.
    m.box((0, .98, -.14), (1.42, .28, .5), "canvas", chamfer=.06)
    m.box((0, 1.4, -.33), (1.4, .62, .14), "canvas", chamfer=.05)
    m.box((0, 1.24, .62), (1.5, .24, .22), "steel", chamfer=.03)
    def wheel_ring(u, v):
        th, ph = u * 2 * math.pi, v * 2 * math.pi
        R = .19 + .014 * math.cos(ph)
        c = np.array((-.38, 1.32, .34)) + np.array((math.cos(th) * R, math.sin(th) * R * .8, -math.sin(th) * R * .55)) + np.array((0, .014 * math.sin(ph) * .55, .014 * math.sin(ph) * .8))
        return c
    m.surface("rubber", wheel_ring, 20, 5, (2.4, .3))
    m.tube([(-.38, 1.32, .34), (-.38, 1.0, .6)], .02, "steel", 6)
    m.box((0, .68, .1), (1.5, .06, 1.1), "void", chamfer=.005)

    # Hood: one crowned skin between the fenders, hinged along a chrome spine.
    def hood(u, v):
        x = (u - .5) * 1.18
        z = .94 + v * 1.4
        y = 1.33 - .24 * v ** 1.6 + .13 * (1 - (2 * u - 1) ** 2) - .04 * abs(2 * u - 1) ** 3
        return np.array((x, y, z))
    m.surface(BODY, hood, 18, 16, (2.4, 2.8), wear=lambda u, v: (abs(2 * u - 1) ** 5) * .6)
    m.beam((0, 1.47, .94), (0, 1.25, 2.36), .03, .018, "chrome", up=(0, 1, .16), chamfer=.005)
    # The nose: a body-colour panel with a recessed grille of chrome bars.
    m.box((0, .92, 2.36), (1.12, .72, .04), BODY, chamfer=.03)
    m.box((0, .95, 2.385), (.82, .5, .012), "void", chamfer=.002)
    for x in np.arange(-.38, .4, .085):
        m.beam((x, .72, 2.4), (x, 1.19, 2.4), .022, .022, "chrome", up=(0, 0, 1), chamfer=.004)
    for y in (.71, 1.2):
        m.beam((-.42, y, 2.405), (.42, y, 2.405), .04, .025, "chrome", up=(0, 1, 0), chamfer=.005)
    # Fenders front and back, running boards tying them together.
    for s in (-1, 1):
        fender(m, s, F_AXLE, 2.42, .8, 1.12)
        fender(m, s, R_AXLE, -.72, -2.18, 1.04, .1)
        m.beam((s * .95, .52, -.74), (s * .95, .52, .88), .28, .03, BODY, up=(0, 1, 0), chamfer=.008)
        # Inner wheel wells close the view through the fenders.
        for axle, half in ((F_AXLE, .62), (R_AXLE, .62)):
            def well(u, v, axle=axle, half=half, s=s):
                th = 3.3 * u - .08
                return np.array((s * (.68 + v * .3), .52 + math.sin(th) * .54, axle + math.cos(th) * .54))
            m.surface("void", well, 14, 2, (2, .5), flip=s < 0)
        for z in (-.4, .5):
            m.beam((s * .42, .47, z), (s * .95, .5, z), .05, .06, "steel")
        # Headlamp: a bucket on the fender with a real bowl and lens.
        p = np.array((s * .74, 1.1, 2.18))
        m.lathe([(.03, 0), (.12, .3), (.15, .85), (.155, 1)], p + (0, 0, -.14), p + (0, 0, .12), "chrome", 18)
        m.lathe([(.145, 0), (.13, .4), (0, 1)], p + (0, 0, .12), p + (0, 0, .165), "glass" if s > 0 else "void", 18)
        m.tube([p + (0, -.13, -.02), p + (0, -.2, -.02)], .018, "chrome", 6)
    # Bumper on two brackets from the frame ends.
    m.beam((-1.02, .67, 2.58), (1.02, .67, 2.58), .1, .14, "chrome", up=(0, 0, 1), chamfer=.03, segs=2)
    for x in (-.42, .42):
        m.beam((x, .55, 2.3), (x, .66, 2.56), .05, .06, "steel")
    m.box((0, .68, 2.635), (.3, .15, .008), "yellow", chamfer=.002)

    # Stepside bed: narrow box, plank floor, wheels outside it.
    BW = .68
    for s in (-1, 1):
        m.beam((s * BW, .86, -2.4), (s * BW, .86, -.5), .5, .03, BODY, up=(1, 0, 0), chamfer=.01)
        m.beam((s * BW, 1.12, -2.4), (s * BW, 1.12, -.5), .05, .05, BODY, up=(0, 1, 0), chamfer=.015)
        for z in (-2.3, -1.45, -.6):
            m.box((s * (BW + .02), .88, z), (.04, .5, .07), BODY, chamfer=.008)
    m.beam((-BW, .86, -.48), (BW, .86, -.48), .5, .03, BODY, up=(0, 0, 1), chamfer=.01)
    for x in np.arange(-BW + .08, BW, .15):
        m.plank((x, .63, -2.42), (x + m.rng.uniform(-.008, .008), .63, -.5), .14, .03, warp=.005)
    for z in (-2.1, -1.2, -.7):
        m.beam((-BW, .59, z), (BW, .59, z), .05, .06, "steel")
    # Tailgate fallen open on its hinges, held up by two chains.
    gate = np.array((-BW + .02, .63, -2.43)), np.array((BW - .02, .63, -2.43))
    open_a = np.array((0, -.34, -.34))
    m.beam(gate[0] + open_a / 2, gate[1] + open_a / 2, .46, .03, BODY, up=(0, -.71, .71), chamfer=.01)
    for s in (-1, 1):
        m.cyl((s * (BW - .04), .63, -2.45), (s * (BW + .03), .63, -2.45), .016, "steel_bare", 8)
        m.wire((s * (BW - .03), .98, -2.42), (s * (BW - .03), .33, -2.75), .02, .006, "steel_bare", 5)
    # A tarp over something the size of a person. Nobody moved it.
    def tarp(u, v):
        x, z = (u - .5) * 1.28, -2.3 + v * 1.72
        lump = .3 * math.exp(-((u - .46) / .24) ** 2 - ((v - .55) / .36) ** 2) + .12 * math.exp(-((u - .46) / .13) ** 2 - ((v - .85) / .09) ** 2)
        fold = .016 * math.sin(u * 19 + v * 6) + .012 * math.sin(u * 7 - v * 17) + .03 * abs(math.sin(v * 9)) * abs(2 * u - 1)
        y = .66 + lump + fold
        return np.array((x, y, z))
    m.surface("canvas", tarp, 30, 26, (2.6, 3.4), wear=lambda u, v: .55)
    # Tail lamps on the bed side.
    for s in (-1, 1):
        m.lathe([(0, 0), (.05, .2), (.05, 1)], (s * (BW + .03), 1.0, -2.41), (s * (BW + .03), 1.0, -2.46), "red", 12)
    m.collide_box(0, 0, 1.05, 2.72, 0, 1.95, tag="pickup")
    m.hook("glovebox", (.45, 1.1, .5))
    m.radius = 4
    return m


SHOTS = None
ASSETS = {"pickup": (pickup, SHOTS)}
