"""The helicopter that comes for you at dawn (docs/game-design.md, "Four ways out": the helicopter).

A light utility helicopter in the shape of a Bell 206 JetRanger (Wikipedia's specification and photographs): a 9.5 m fuselage
with a rounded glazed nose, a four-seat cabin, the engine cowling behind the mast, a tapering tail boom with a stabiliser and a
swept fin, skids on two arched cross tubes, a two-bladed 10.16 m main rotor about 2.9 m up and a 1.65 m tail rotor on the left of
the fin. Painted as a civil rescue machine, white over red, long out in the weather.

Three assets, because both rotors turn: the body (its nose to +z, skids on the ground at y=0), the main rotor (about its mast,
y up, through the origin) and the tail rotor (about its own axle, along x, through the origin). Hooks on the body: rotor (the
hub), tail_rotor (its hub), door_left / door_right (where a player boards), beacon (the red light on the fin).
"""
import math

import numpy as np

from kit import Model

NOSE_Z = 4.0                       # the nose is 4 m ahead of the origin; distances below are from the nose, aft (dn)
# Fuselage stations: distance from the nose (m), half width, half height, centre height, squareness (superellipse exponent).
STATIONS = [
    (0.00, .06, .06, 1.08, 2.0),
    (0.18, .38, .36, 1.12, 2.1),
    (0.50, .58, .58, 1.2, 2.3),
    (1.00, .655, .72, 1.28, 2.5),
    (1.70, .67, .76, 1.31, 2.8),
    (2.90, .67, .76, 1.31, 2.8),
    (3.40, .63, .70, 1.34, 2.6),
    (3.90, .48, .52, 1.46, 2.3),
    (4.50, .29, .3, 1.56, 2.1),
    (5.40, .2, .21, 1.62, 2.0),
    (7.80, .14, .145, 1.7, 2.0),
    (9.08, .11, .115, 1.74, 2.0),
    (9.20, .02, .02, 1.74, 2.0),
]
MAST_DN = 2.62
HUB_Y = 2.88
TAIL_DN = 8.95


def _station(dn):
    """The fuselage's section at dn: linear between stations (they are close enough that the skin reads smooth)."""
    s = STATIONS
    for a, b in zip(s, s[1:]):
        if a[0] <= dn <= b[0]:
            t = (dn - a[0]) / (b[0] - a[0])
            return tuple(a[i] + (b[i] - a[i]) * t for i in range(1, 5))
    return s[-1][1:]


def hull(dn, th, lift=0.0):
    """A point on the skin: dn aft of the nose, th round the section (0 to the right, pi/2 up), `lift` metres proud of it."""
    hx, hy, cy, n = _station(dn)
    c, s = math.cos(th), math.sin(th)
    x = math.copysign(abs(c) ** (2 / n), c) * (hx + lift)
    y = cy + math.copysign(abs(s) ** (2 / n), s) * (hy + lift)
    return np.array((x, y, NOSE_Z - dn))


def patch(m, mat, dn0, dn1, th0, th1, lift=0.0, nu=16, nv=10, flip=False, density=1.0):
    """A piece of the skin between two stations and two angles: paint regions, windows, panels. With u running aft and v round
    the section (right, up, left), the surface's own normal already points out of the hull."""
    m.surface(mat, lambda u, v: hull(dn0 + (dn1 - dn0) * u, th0 + (th1 - th0) * v, lift), nu, nv,
              ((dn1 - dn0) * 2, abs(th1 - th0) * .7 * 2), flip=flip, density=density)


def fin(m, root_le, tip_le, root_chord, tip_chord, thick, mat):
    """A tapered, swept fin: an aerofoil section (chord aft of the leading edge) lofted from root to tip."""
    def f(u, v):
        th = u * 2 * math.pi
        c = root_chord + (tip_chord - root_chord) * v
        le = root_le + (tip_le - root_le) * v
        along = (1 - math.cos(th)) / 2           # 0 at the leading edge, 1 at the trailing edge
        half = thick * (1 - .8 * v) * math.sin(th) * (1 - along * .7)
        return np.array((half, le[1], le[2] - along * c))
    m.surface(mat, f, 20, 8, (1.2, 1.5))


def body():
    m = Model("helicopter", tex=2048, seed=601)   # 2048 over 9.5 m is enough for a machine seen at the pad's edge
    tau = 2 * math.pi
    # --- Skin: white above the belt line, red below; the belt line dips toward the nose. The skin is closed: the nose and tail
    # caps are the stations' near-zero sections, and the paint pieces share their edges exactly.
    belt = math.radians(-12)
    # The nose curves fast: it gets four times the rows of the boom, or its facets bulge through the windscreen laid over it.
    for dn0, dn1, nu in ((0.0, 1.6, 56), (1.6, 9.2, 76)):
        patch(m, "white_mast", dn0, dn1, belt, math.pi - belt, nu=nu, nv=36)
        patch(m, "red", dn0, dn1, math.pi - belt, tau + belt, nu=nu, nv=30)
    # A dark stripe along the belt line.
    for side, th in ((1, belt), (-1, math.pi - belt)):
        patch(m, "steel", .3, 8.6, th - .035, th + .035, lift=.004, nu=60, nv=2)
    # --- Glazing: each window is a dark panel on the skin (the cabin behind it) with glass just over it.
    windows = [
        (.16, 1.3, math.radians(24), math.radians(156)),    # the windscreen, wrapping the nose top
        (.55, 1.05, math.radians(-26), math.radians(2)),    # small chin windows by the pedals
        (.55, 1.05, math.radians(178), math.radians(206)),
        (1.4, 2.15, math.radians(8), math.radians(62)),     # front door windows
        (1.4, 2.15, math.radians(118), math.radians(172)),
        (2.3, 3.05, math.radians(10), math.radians(60)),    # rear door windows
        (2.3, 3.05, math.radians(120), math.radians(170)),
    ]
    for dn0, dn1, th0, th1 in windows:
        # Laid 1.5 cm proud with fine rows, so no facet of the hull under it shows through.
        patch(m, "void", dn0, dn1, th0, th1, lift=.015, nu=28, nv=20)
        patch(m, "glass", dn0 + .01, dn1 - .01, th0 + .01, th1 - .01, lift=.021, nu=28, nv=20)
    # Door seams: thin dark lines in the skin round the four doors.
    for th0, th1 in ((math.radians(-25), math.radians(68)), (math.radians(112), math.radians(205))):
        for dn in (1.3, 2.22, 3.15):
            m.tube([hull(dn, th0 + (th1 - th0) * t, .004) for t in np.linspace(0, 1, 9)], .006, "steel", 4)
        for th in (th0, th1):
            m.tube([hull(dn, th, .004) for dn in np.linspace(1.3, 3.15, 9)], .006, "steel", 4)
    # Door handles.
    for th in (math.radians(-8), math.radians(188)):
        for dn in (2.05, 2.95):
            p = hull(dn, th, .011)   # the handle's back is let into the skin
            m.box(p, (.03, .03, .12), "chrome", chamfer=.008)
    # --- Engine cowling on the roof behind the mast, its intake grilles and the exhaust stack.
    roof = hull(2.6, math.pi / 2)[1]
    cowl = [(dn, hx, hy, roof + hy * .55, n) for dn, hx, hy, n in ((1.95, .05, .05, 2), (2.15, .4, .26, 2.6), (3.0, .44, .3, 2.8), (3.9, .38, .27, 2.6), (4.35, .2, .16, 2.2), (4.55, .04, .04, 2))]
    m.loft("white_mast", [(NOSE_Z - dn, hx, hy, cy, n) for dn, hx, hy, cy, n in cowl], 24)
    # Intake grilles on the cowling's flanks, at its widest (the centre height of its section), set into the skin.
    for s in (-1, 1):
        for k in range(5):
            dn = 3.0 + k * .12
            half = .44 + (.38 - .44) * (dn - 3.0) / .9
            cy = roof + (.3 + (.27 - .3) * (dn - 3.0) / .9) * .55
            m.box((s * (half + .002), cy, NOSE_Z - dn), (.012, .16, .07), "steel", chamfer=.004)
    stack = np.array((0, roof + .44, NOSE_Z - 4.05))
    m.lathe([(.11, 0), (.12, .4), (.11, 1)], stack + np.array((0, -.12, 0)), stack + np.array((0, .1, -.12)), "soot_iron", 16)
    # --- Mast, swashplate and the hub's stub (the rotor itself is its own asset).
    mast_base = np.array((0, roof + .3, NOSE_Z - MAST_DN))
    m.cyl(mast_base, np.array((0, HUB_Y - .1, NOSE_Z - MAST_DN)), .07, "steel_bare", 16)
    m.cyl(np.array((0, roof + .42, NOSE_Z - MAST_DN)), np.array((0, roof + .48, NOSE_Z - MAST_DN)), .2, "steel", 20)
    for a in (0, 2.1, 4.2):
        p = np.array((math.cos(a) * .17, roof + .48, NOSE_Z - MAST_DN + math.sin(a) * .17))
        m.tube([p, p + np.array((0, .26, 0))], .012, "chrome", 6)
    # --- Skids: two tubes on arched cross tubes, turned up in front, with a step at each door.
    for s in (-1, 1):
        x = s * .95
        skid = [np.array((x, .32, NOSE_Z - .75)), np.array((x, .12, NOSE_Z - .98)), np.array((x, .07, NOSE_Z - 1.25)), np.array((x, .07, NOSE_Z - 3.55))]
        m.tube(skid, .04, "steel", 10)
        m.cyl(np.array((x, .07, NOSE_Z - 3.55)), np.array((x, .07, NOSE_Z - 3.6)), .042, "rubber", 10)
        for dn in (2.05, 2.95):
            m.box((x * .93, .26, NOSE_Z - dn), (.18, .03, .3), "steel_bare", chamfer=.006)
            m.tube([np.array((x, .1, NOSE_Z - dn)), np.array((x * .93, .26, NOSE_Z - dn))], .018, "steel", 6)
    for dn in (1.55, 3.05):
        belly = hull(dn, -math.pi / 2)[1]
        cross = [np.array((s * .95, .1, NOSE_Z - dn)) for s in (-1,)] + [np.array((-.75, belly - .05, NOSE_Z - dn)), np.array((0, belly + .04, NOSE_Z - dn)), np.array((.75, belly - .05, NOSE_Z - dn)), np.array((.95, .1, NOSE_Z - dn))]
        m.tube(cross, .045, "steel", 10)
    # --- Tail: a stabiliser across the boom with small end plates, the swept fin above and below, the tail rotor's gearbox.
    st = hull(7.0, 0)
    for s in (-1, 1):
        m.box((s * .55, st[1] - .02, st[2]), (.95, .05, .42), "white_mast", chamfer=.02)
        m.box((s * 1.02, st[1] + .02, st[2] - .02), (.03, .34, .36), "red", chamfer=.01)
    # The fin: swept back above the boom and a smaller one below it, both rooted inside the boom.
    top_y = hull(TAIL_DN - .2, math.pi / 2)[1]
    fin(m, np.array((0, top_y - .06, NOSE_Z - TAIL_DN + .25)), np.array((0, 2.75, NOSE_Z - TAIL_DN - .3)), .8, .38, .05, "red")
    bottom_y = hull(TAIL_DN - .2, -math.pi / 2)[1]
    low_tip = np.array((0, 1.12, NOSE_Z - TAIL_DN - .28))
    fin(m, np.array((0, bottom_y + .06, NOSE_Z - TAIL_DN + .15)), low_tip + np.array((0, 0, .1)), .55, .28, .04, "red")
    m.tube([low_tip, low_tip + np.array((0, -.02, -.18))], .012, "steel", 5)   # the tail skid
    gear = np.array((-.15, hull(TAIL_DN, math.pi / 2)[1] - .02, NOSE_Z - TAIL_DN))
    m.cyl(np.array((0, gear[1], gear[2])), gear, .09, "steel", 14)
    m.cyl(gear, gear + np.array((-.08, 0, 0)), .03, "steel_bare", 10)
    beacon = np.array((0, 2.78, NOSE_Z - TAIL_DN - .36))
    m.cyl(beacon - np.array((0, .03, 0)), beacon + np.array((0, .03, 0)), .03, "red", 10)
    # --- Small things: a landing light under the nose and an antenna under the boom. Nothing stands on the glazing: a pitot tube
    # and a roof antenna there read as a rod stuck through the windscreen.
    m.cyl(hull(.6, -math.pi / 2, -.03), hull(.6, -math.pi / 2, .05), .07, "chrome", 14)
    for p in (hull(5.6, -math.pi / 2, -.01),):
        m.tube([p, p + np.array((0, -.35, -.25))], .006, "steel", 4)
    # --- Hooks and collision.
    m.hook("rotor", (0, HUB_Y, NOSE_Z - MAST_DN))
    m.hook("tail_rotor", gear + np.array((-.1, 0, 0)))
    m.hook("door_left", hull(2.2, math.pi, .3) * np.array((1, 0, 1)) + np.array((0, .3, 0)))
    m.hook("door_right", hull(2.2, 0, .3) * np.array((1, 0, 1)) + np.array((0, .3, 0)))
    m.hook("beacon", beacon)
    m.collide_box(0, NOSE_Z - 2.0, .75, 2.0, 0, 2.1, tag="helicopter")
    m.collide_box(0, NOSE_Z - 6.4, .3, 2.8, 1.3, 2.0, tag="helicopter boom")
    m.radius = 7
    return m


def rotor():
    """The main rotor: a two-bladed teetering hub on the mast top, blades 5.08 m long with a slight droop at rest."""
    m = Model("helicopter_rotor", tex=2048, seed=602)
    m.cyl((0, -.12, 0), (0, .12, 0), .085, "steel_bare", 18)
    m.box((0, .02, 0), (.62, .1, .16), "steel", chamfer=.02)
    for s in (-1, 1):
        root = np.array((s * .3, .02, 0))
        m.box(root + np.array((s * .08, 0, 0)), (.22, .08, .14), "steel_bare", chamfer=.015)
        tip_x = s * 5.08

        def blade(u, v, s=s, tip_x=tip_x):
            # u along the span, v round the aerofoil (a thin symmetric section, chord .33, trailing edge behind).
            x = s * .42 + (tip_x - s * .42) * u
            th = v * 2 * math.pi
            chord, thick = .33, .036
            z = (math.cos(th) * .5) * chord
            y = math.sin(th) * thick * .5 * (1 - abs(math.cos(th)) ** 3) - .06 * u ** 2   # the droop of a blade at rest
            return np.array((x, .02 + y, -z * s * .0 + z))

        m.surface("steel", blade, 40, 10, (10, .7), flip=s < 0)
        m.box((tip_x - s * .06, .02 - .06, 0), (.12, .03, .33), "white_mast", chamfer=.01)   # painted tips
    m.radius = 5.2
    return m


def tail_rotor():
    """The tail rotor about its axle (x): two blades of .82 m on a small hub."""
    m = Model("helicopter_tail_rotor", tex=1024, seed=603)
    m.cyl((-.06, 0, 0), (.06, 0, 0), .05, "steel_bare", 14)
    for s in (-1, 1):
        def blade(u, v, s=s):
            r = .06 + .76 * u
            th = v * 2 * math.pi
            return np.array((math.sin(th) * .012, s * r, math.cos(th) * .07))
        m.surface("steel", blade, 12, 8, (2, .3))
        m.box((0, s * .79, 0), (.026, .06, .14), "red", chamfer=.004)
    m.radius = .9
    return m


ASSETS = {"helicopter": (body, None), "helicopter_rotor": (rotor, None), "helicopter_tail_rotor": (tail_rotor, None)}
