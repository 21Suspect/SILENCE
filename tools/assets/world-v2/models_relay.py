"""Relay station: lattice mast with guy wires, concrete hut, diesel generator."""
import math

import numpy as np

from kit import Model, poster_material, rot_y, ROOT
import os

ART = os.path.join(ROOT, "assets/world-v2/art")


def mast():
    m = Model("mast", tex=2048, seed=21)
    H, sections = 34.0, 17
    R0, R1 = .95, .34
    def leg(i, y):
        t = y / H
        r = R0 + (R1 - R0) * t
        a = i * 2 * math.pi / 3 + .5
        return np.array((math.cos(a) * r, y, math.sin(a) * r))
    # Concrete plinth with bolted feet.
    m.box((0, .15, 0), (3.1, .34, 3.1), "concrete", chamfer=.03)
    m.collide_box(0, 0, 1.55, 1.55, 0, .3, tag="mast plinth")
    for i in range(3):
        p = leg(i, .32)
        m.cyl(p - (0, .02, 0), p + (0, .1, 0), .14, "steel", 10)
        m.box(p + (0, .012, 0), (.44, .03, .44), "steel", chamfer=.006)
        for dx_, dz_ in ((-.17, -.17), (.17, -.17), (-.17, .17), (.17, .17)):
            m.cyl(p + (dx_, .02, dz_), p + (dx_, .1, dz_), .014, "steel_bare", 6)
        m.collide_post(p[0], p[2], p[0], p[2], .1, 0, H, "mast leg")
    for s in range(sections):
        y0, y1 = s * 2.0, (s + 1) * 2.0
        y0 = max(y0, .3)
        band = "red" if (s // 2) % 2 else "white_mast"
        m.density = .7
        for i in range(3):
            m.tube([leg(i, y0), leg(i, y1)], .055 - .022 * y1 / H, band, 6)
        m.density = .35
        for i in range(3):
            a, b = leg(i, y0), leg((i + 1) % 3, y0)
            m.tube([a, b], .018, band, 4)
            top_a = leg((i + 1) % 3, y1)
            m.tube([a, top_a], .017, band, 4)
            m.tube([b, leg(i, y1)], .017, band, 4)
        m.density = 1
    # Ladder up one leg, cable tray up another.
    m.density = .4
    for s in range(sections * 6):
        y = .4 + s * .32
        if y > H:
            break
        p = leg(0, y)
        d = np.array((math.cos(.5), 0, math.sin(.5)))
        t = np.array((-d[2], 0, d[0]))
        m.tube([p + d * .28 - t * .18, p + d * .28 + t * .18], .011, "steel_bare", 4)
    p0, p1 = leg(0, .4), leg(0, H)
    d = np.array((math.cos(.5), 0, math.sin(.5)))
    t = np.array((-d[2], 0, d[0]))
    m.tube([p0 + d * .28 - t * .18, p1 + d * .28 - t * .18], .014, "steel_bare", 4)
    m.tube([p0 + d * .28 + t * .18, p1 + d * .28 + t * .18], .014, "steel_bare", 4)
    # Bundled coax drooping from the mast.
    pts = [leg(1, y) + (.06, 0, .05) for y in np.arange(.3, H - 2, 2.0)]
    m.tube(pts, .02, "rubber", 6)
    # Stand-off brackets hold the ladder clear of the leg, every metre and a half.
    for y in np.arange(1.0, H, 1.5):
        pl = leg(0, y)
        m.tube([pl, pl + d * .28 - t * .18], .012, "steel", 4)
        m.tube([pl, pl + d * .28 + t * .18], .012, "steel", 4)
    m.density = 1
    # Maintenance platform, antennas and the aircraft light.
    for y in (20.0,):
        for a in np.arange(0, 2 * math.pi, .35):
            r = .92
            p0_ = np.array((math.cos(a) * r, y, math.sin(a) * r))
            p1_ = np.array((math.cos(a + .35) * r, y, math.sin(a + .35) * r))
            m.tube([p0_, p1_], .02, "steel", 4)
            m.tube([p0_ * (1, 0, 1) + (0, y + 1.0, 0), p1_ * (1, 0, 1) + (0, y + 1.0, 0)], .016, "steel", 4)
            m.tube([p0_, p0_ + (0, 1.0, 0)], .014, "steel", 4)
        for x in np.arange(-.85, .9, .17):
            m.beam((x, y, -math.sqrt(max(.01, .9 - x * x))), (x, y, math.sqrt(max(.01, .9 - x * x))), .12, .025, "steel", chamfer=.003)
    for i, (y, which, d_) in enumerate(((31.5, 1, .9), (27.0, 2, 1.1), (23.5, 1, .8))):
        # Each dish is clamped to a tower leg.
        ang = which * 2 * math.pi / 3 + .5
        out = np.array((math.cos(ang), 0, math.sin(ang)))
        c = leg(which, y) + out * .32
        m.lathe([(0, 0), (d_ * .3, .0), (d_ * .68, .12), (d_ * .78, .3), (d_ * .8, 1), (d_ * .84, 1.0), (d_ * .84, 1.06)], c, c + out * .38, "galv", 24, wear=.1)
        m.lathe([(d_ * .8, 0), (d_ * .78, .5), (0, 1)], c + out * .38, c + out * .45, "white_mast", 24)
        m.tube([c - out * .34, c + out * .05], .05, "steel", 8)
        # Feed arm out to the horn at the focus.
        m.tube([c + out * .4, c + out * .9], .018, "steel", 6)
        m.lathe([(.02, 0), (.09, 1)], c + out * .9, c + out * .78, "steel", 10)
        for h_ in (-.18, .18):
            m.box(c - out * .32 + (0, h_, 0), (.18, .05, .18), "steel", chamfer=.012)
    # The ladder is climbable up to the service platform.
    lad = d * 1.23
    m.ladder((lad[0], 0, lad[2]), (lad[0], 20.02, lad[2]), (d[0] * .55, 20.02, d[2] * .55), .36)
    m.collide_box(0, 0, .72, .72, 19.88, 20.02, tag="mast platform")
    for k in range(8):
        a_ = k * math.pi / 4
        m.collide_post(math.cos(a_) * .92, math.sin(a_) * .92, math.cos(a_ + math.pi / 4) * .92, math.sin(a_ + math.pi / 4) * .92, .03, 20.0, 21.0, "platform rail")
    m.cyl((0, H - .08, 0), (0, H + .04, 0), .48, "steel", 14)
    m.tube([np.array((0, H, 0)), np.array((0, H + 3.2, 0))], .03, "steel_bare", 6)
    for h in (H + .3, H + 1.0):
        m.tube([np.array((-.8, h, 0)), np.array((.8, h, 0))], .012, "steel_bare", 4)
    m.lathe([(0, 0), (.09, .05), (.1, .5), (.07, .9), (0, 1)], (0, H + 3.2, 0), (0, H + 3.55, 0), "red", 10)
    m.hook("beacon", (0, H + 3.4, 0))
    # Guy wires to anchor blocks.
    for i in range(3):
        a = i * 2 * math.pi / 3 + 1.55
        anchor = np.array((math.cos(a) * 15.5, .72, math.sin(a) * 15.5))
        m.box((anchor[0], .3, anchor[2]), (1.1, .78, 1.1), "concrete", yaw=-a, chamfer=.04)
        m.collide_box(float(anchor[0]), float(anchor[2]), .58, .58, 0, .72, yaw=-a, tag="guy anchor")
        for h, off in ((14.0, .08), (28.0, -.08)):
            top = leg(i, h)
            j = (i + 0) % 3
            m.density = .22
            m.wire(top, anchor + (off, 0, off), .12, .007, "steel_bare", 8)
            m.density = 1
        m.cyl(anchor - (0, .05, 0), anchor + (0, .22, 0), .05, "steel", 8)
        m.tube([anchor + (0, .22, 0), anchor + (0, .32, 0)], .02, "steel_bare", 6)
        def eye(u, v, c=anchor):
            th, ph = u * 2 * math.pi, v * 2 * math.pi
            R_ = .065 + .012 * math.cos(ph)
            return c + (0, .4, 0) + np.array((math.cos(th) * R_, math.sin(th) * R_, .012 * math.sin(ph)))
        m.surface("steel_bare", eye, 12, 4, (.8, .2))
    m.radius = 20
    return m


def hut():
    poster_material("sign_voltage", os.path.join(ART, "sign_voltage.png"))
    m = Model("hut", tex=2048, seed=33)
    W, D, H = 2.2, 1.7, 2.75
    t = .1
    # Block walls with real thickness; the door stands open on the dark inside.
    def wall_x(z, gaps=()):
        x = -W
        for a, b in sorted(gaps):
            m.box(((x + a) / 2, H / 2, z), (a - x, H, 2 * t), "block", chamfer=.008)
            x = b
        m.box(((x + W) / 2, H / 2, z), (W - x, H, 2 * t), "block", chamfer=.008)
    wall_x(-D)
    wall_x(D, ((-1.35, -.45), (.2, 1.1)))
    m.box((-.9, 2.5, D), (.9, .5, 2 * t), "block", chamfer=.008)
    m.box((.65, .5, D), (.9, 1.0, 2 * t), "block", chamfer=.008)
    m.box((.65, 2.4, D), (.9, .7, 2 * t), "block", chamfer=.008)
    for x in (-W, W):
        m.box((x, H / 2, 0), (2 * t, H, 2 * D - 2 * t), "block", chamfer=.008)
    m.box((0, H + .08, 0), (2 * W + .5, .16, 2 * D + .5), "concrete", chamfer=.02)
    # A parapet cast on the slab, so nothing here has a shadow gap.
    for z in (-D - .22, D + .22):
        m.box((0, H + .21, z), (2 * W + .5, .22, .1), "concrete", chamfer=.01)
    for x in (-W - .22, W + .22):
        m.box((x, H + .21, 0), (.1, .22, 2 * D + .5), "concrete", chamfer=.01)
    m.box((0, .06, D + .7), (1.4, .12, .9), "concrete", chamfer=.02)
    m.collide_box(0, D + .7, .7, .45, 0, .12, tag="door slab")
    m.box((0, .05, 0), (2 * W, .1, 2 * D), "concrete", chamfer=.01)
    # Barred window, its glass filthy: the runtime glows this from behind.
    for x in np.arange(.27, 1.08, .16):
        m.cyl((x, 1.0, D + .1), (x, 2.05, D + .1), .012, "steel", 6)
    for y in (1.04, 2.0):
        m.beam((.18, y, D + .1), (1.12, y, D + .1), .05, .01, "steel", up=(0, 0, 1))
        for x in (.18, 1.12):
            m.bolt((x, y, D + .105), (0, 0, 1), .01)
    m.box((.65, 1.52, D - .02), (.9, 1.05, .02), "glass", chamfer=.002)
    m.hook("window", (.65, 1.52, D - .2))
    # Steel door hanging open, frame, hazard sign.
    for x in (-1.37, -.43):
        m.beam((x, 0, D + .08), (x, 2.27, D + .08), .05, .08, "steel")
    m.beam((-1.4, 2.28, D + .08), (-.4, 2.28, D + .08), .05, .08, "steel")
    # The leaf is a separate, hinged model; a fixed steel panel fills the frame above it.
    m.beam((-1.345, 2.2, D + .08), (-.455, 2.2, D + .08), .11, .03, "olive", up=(0, 0, 1), chamfer=.004)
    m.door("door_steel", (-1.335, .03, D + .105), 0.0, -1.9, width=.84, height=2.1, thickness=.045, start=.45)
    m.poster("sign_voltage", (-1.72, 1.62, D + .105), (1, 0, 0), (0, 1, 0), .46, .34)
    # Fuse box on the outside wall: three sockets, cover swung open.
    fx, fy, fz = 1.72, 1.42, D + .17
    m.box((fx, fy, fz), (.52, .72, .14), "steel", chamfer=.012)
    m.box((fx, fy, fz + .072), (.44, .62, .012), "void", chamfer=.002)
    for i in range(3):
        px = fx - .13 + i * .13
        m.cyl((px, fy - .14, fz + .08), (px, fy + .14, fz + .08), .028, "ceramic", 8)
    # Lid hinged on the box's right edge, standing open.
    a2 = math.radians(112)
    hxb, hzb = fx + .26, fz + .08
    lid = np.array((hxb + math.cos(a2) * .25, fy, hzb + math.sin(a2) * .25))
    m.beam(lid - (0, .35, 0), lid + (0, .35, 0), .5, .012, "steel", up=(math.sin(a2), 0, -math.cos(a2)), chamfer=.003)
    for dy in (-.25, .25):
        m.cyl((hxb, fy + dy - .03, hzb), (hxb, fy + dy + .03, hzb), .012, "steel_bare", 6)
    m.hook("fusebox", (fx, fy, fz + .25))
    # Conduit from the box up and along the wall.
    m.tube([(fx, fy + .36, fz), (fx, H - .3, fz), (fx - .9, H - .3, fz), (-1.9, H - .3, fz), (-1.9, H + .3, fz + .1)], .022, "steel_bare", 6)
    for x in np.arange(-1.7, fx, .9):
        m.beam((x, H - .3, D + .1), (x, H - .3, fz + .03), .03, .05, "steel", chamfer=.004)
    # Inside: a radio rack and desk seen through the door.
    m.box((-1.3, 1.05, -D + .35), (.82, 2.0, .5), "steel", chamfer=.012)
    for i in range(6):
        m.box((-1.3, .45 + i * .3, -D + .61), (.72, .22, .02), "olive", chamfer=.004)
    m.hook("radio", (-1.3, 1.25, -D + .85))
    m.collide_box(-1.3, -D + .35, .42, .27, 0, 2.05, tag="radio rack")
    m.box((.8, .76, -D + .5), (1.5, .05, .72), "wood_dark")
    for x in (.15, 1.45):
        for z in (-D + .22, -D + .78):
            m.cyl((x, .08, z), (x, .74, z), .02, "steel", 6)
    m.collide_box(.8, -D + .5, .77, .38, 0, .8, tag="desk")
    # Roof vent and a wall-mounted air box.
    m.cyl((.8, H + .15, -.3), (.8, H + .9, -.3), .1, "tin", 10)
    m.lathe([(0, 0), (.2, .1), (.16, .6), (0, 1)], (.8, H + .92, -.3), (.8, H + 1.15, -.3), "tin", 10)
    # Cable run, lying across the ground toward the mast.
    delta = np.array((-10.0, 0, 6.0)) @ rot_y(.4)
    start = np.array((-W - .05, .12, .4))
    pts = [start + (delta - start) * s * .92 + np.array((math.sin(s * 19) * .12, .02 + .04 * math.sin(s * 11) ** 2, math.cos(s * 13) * .14)) for s in np.linspace(0, 1, 14)]
    m.density = .4
    m.tube([start + (0, 1.3, 0), start + (-.06, .15, 0)] + pts, .03, "rubber", 8)
    m.cyl(start + (.06, 1.3, 0), start + (-.05, 1.3, 0), .05, "steel", 10)
    # Electricity meter with its conduit on the back wall, and a scupper that has stained the block below it.
    m.box((-1.1, 1.5, -D - .14), (.34, .5, .14), "steel", chamfer=.015)
    m.cyl((-1.1, 1.58, -D - .21), (-1.1, 1.58, -D - .225), .1, "ceramic", 16)
    m.tube([(-1.1, 1.25, -D - .14), (-1.1, .4, -D - .14), (-1.1, .08, -D - .14)], .022, "galv", 8)
    m.box((1.6, H + .02, -D - .25), (.16, .05, .2), "galv", chamfer=.006)
    # Rear vent grille and a downpipe take the roof's water.
    for y in np.arange(1.9, 2.42, .07):
        m.box((.4, y, -D - .11), (.8, .03, .02), "galv", chamfer=.002)
    m.tube([(W + .16, H + .05, -D + .3), (W + .16, .12, -D + .3), (W + .42, .05, -D + .3)], .04, "galv", 10)
    m.density = 1
    # Walls.
    for x, z, hx_, hz_ in ((0, -D, W + .1, t), (-W, 0, t, D + .1), (W, 0, t, D + .1), (-1.77, D, .42 + .1, t), (.3, D, .75, t)):
        m.collide_box(x, z, hx_, hz_, 0, H, tag="hut wall")
    m.collide_box(1.65, D, .55, t, 0, H, tag="hut wall")
    m.collide_box(-.9, D, .5, t, 2.25, H, tag="hut lintel")
    m.collide_box(0, 0, W, D, 0, .1, tag="hut floor")
    m.radius = 4
    return m


def generator():
    """A skid-mounted diesel set. Everything is cast with, bolted to, or piped into something."""
    m = Model("generator", tex=1024, seed=41)
    L, W_ = .98, .4
    for z in (-W_, W_):
        m.beam((-L - .05, .08, z), (L + .05, .08, z), .08, .15, "steel")
    for x in (-L + .08, -.2, .55, L - .08):
        m.beam((x, .1, -W_), (x, .1, W_), .08, .1, "steel")
    # Fuel tank is the base between the rails.
    m.box((.1, .28, 0), (1.6, .26, .72), "steel", chamfer=.025)
    m.cyl((.62, .41, .18), (.62, .47, .18), .05, "steel_bare", 12)
    # Crankcase and cylinder are one casting: fins are ribs on a solid core.
    m.box((-.3, .62, 0), (.74, .46, .5), "olive", chamfer=.03)
    m.box((-.3, 1.0, 0), (.58, .34, .34), "olive", chamfer=.02)
    for y in np.arange(.86, 1.15, .04):
        m.box((-.3, y, 0), (.68, .016, .46), "olive", chamfer=.003)
    m.box((-.3, 1.2, 0), (.62, .09, .38), "olive", chamfer=.018)
    for x in (-.5, -.1):
        for z in (-.12, .12):
            m.bolt((x, 1.246, z), (0, 1, 0), .014)
    # Flywheel bell, spoked hand-crank wheel on the shaft, then the alternator.
    m.lathe([(.26, 0), (.31, .4), (.31, 1)], (.07, .68, 0), (.22, .68, 0), "olive", 22)
    m.lathe([(0, 0), (.25, .02), (.27, .12), (.27, .86), (.22, 1), (0, 1)], (.22, .68, 0), (.88, .68, 0), "olive", 24)
    for a in np.arange(0, 2 * math.pi, math.pi / 4):
        p0 = np.array((.34, .68 + math.sin(a) * .262, math.cos(a) * .262))
        p1 = np.array((.76, .68 + math.sin(a) * .262, math.cos(a) * .262))
        m.tube([p0, p1], .012, "steel", 5)
    for z in (-.2, .2):
        m.box((.55, .385, z), (.5, .12, .1), "steel", chamfer=.01)
    # Radiator stands on the skid: finned core, top tank with its cap, shroud back to the block, two hoses.
    m.box((-.88, .69, 0), (.09, .66, .66), "steel", chamfer=.012)
    m.box((-.88, 1.07, 0), (.12, .12, .68), "olive", chamfer=.02)
    m.cyl((-.88, 1.13, .2), (-.88, 1.17, .2), .035, "steel_bare", 10)
    for z_ in np.arange(-.3, .31, .022):
        m.box((-.931, .69, z_), (.014, .6, .012), "galv", chamfer=.002)
    m.box((-.78, .72, 0), (.2, .62, .55), "steel", chamfer=.02)
    for s_ in (-1, 1):
        m.beam((-.88, .08, s_ * .3), (-.88, .4, s_ * .3), .08, .06, "steel")
        m.beam((-.88, 1.06, s_ * .28), (-.54, 1.06, s_ * .2), .03, .03, "steel")
    m.tube([(-.82, 1.04, .14), (-.72, 1.16, .14), (-.6, 1.16, .14)], .03, "rubber", 8)
    m.tube([(-.82, .42, -.14), (-.72, .36, -.14), (-.66, .42, -.14)], .03, "rubber", 8)
    for x_ in (-.74, -.66):
        m.lathe([(.033, 0), (.036, .5), (.033, 1)], (x_, 1.16, .125), (x_, 1.16, .155), "steel_bare", 8, density=.4)
    # Air cleaner on a bracket, ducted to the head.
    m.lathe([(0, 0), (.1, .03), (.11, .15), (.11, .85), (.1, .97), (0, 1)], (-.3, 1.3, .34), (-.3, 1.55, .34), "steel", 16)
    # An L-bracket bolted to the head carries the canister.
    m.beam((-.3, 1.27, .34), (-.3, 1.27, .16), .1, .014, "steel", up=(0, 1, 0))
    m.beam((-.3, 1.28, .19), (-.3, 1.15, .19), .1, .014, "steel", up=(0, 0, 1))
    m.bolt((-.3, 1.2, .2), (0, 0, 1), .012)
    m.tube([(-.3, 1.28, .2), (-.3, 1.32, .3)], .03, "rubber", 8)
    # Exhaust: flanged at the head, across to the muffler, up through a rain flap.
    m.cyl((-.3, 1.0, -.15), (-.3, 1.0, -.26), .06, "steel", 12)
    m.tube([(-.3, 1.0, -.26), (-.3, 1.06, -.42), (.0, 1.3, -.42), (.12, 1.32, -.42)], .024, "steel_bare", 10)
    m.lathe([(.03, 0), (.08, .08), (.08, .92), (.03, 1)], (.1, 1.32, -.42), (.76, 1.32, -.42), "steel_bare", 14)
    # Short stack, cut at an angle, under a hinged rain flap.
    m.tube([(.76, 1.32, -.42), (.9, 1.32, -.42), (.9, 1.62, -.42)], .026, "steel_bare", 10)
    for x_ in (.3, .6):
        m.beam((x_, .94, -.37), (x_, 1.26, -.42), .04, .012, "steel", up=(1, 0, 0))
    m.beam((.87, 1.635, -.42), (.95, 1.665, -.42), .07, .006, "steel", up=(-.35, 1, 0), chamfer=.002)
    m.cyl((.87, 1.635, -.45), (.87, 1.635, -.39), .006, "steel_bare", 6)
    # Control box on one solid bracket, cabled to the alternator.
    m.box((.58, 1.2, 0), (.46, .34, .16), "steel", chamfer=.012)
    m.box((.58, .98, 0), (.3, .12, .12), "steel", chamfer=.01)
    m.cyl((.46, 1.26, .08), (.46, 1.26, .092), .05, "ceramic", 14)
    for i, x in enumerate((.6, .68, .76)):
        m.cyl((x, 1.13, .08), (x, 1.13, .1), .012, "red" if i == 0 else "steel_bare", 8)
    m.box((.68, 1.27, .082), (.16, .05, .004), "yellow", chamfer=.001)
    m.tube([(.36, 1.08, .05), (.32, .98, .1), (.34, .92, .12)], .013, "rubber", 6)
    # Hand-start: crank wheel on the shaft, with the pull cord and its handle hanging ready.
    # Recoil starter: a domed, slotted cowl bolted to the crankcase, the cord led out to a T-handle.
    m.lathe([(0, 1), (.09, .98), (.15, .8), (.17, .4), (.17, 0)], (-.5, .62, -.33), (-.5, .62, -.25), "olive", 22)
    for a_ in np.arange(0, 6.28, 1.047):
        m.bolt((-.5 + math.cos(a_) * .15, .62 + math.sin(a_) * .15, -.32), (0, 0, -1), .008)
    m.tube([(-.5, .47, -.31), (-.5, .42, -.36), (-.5, .36, -.4)], .004, "steel_bare", 4)
    m.tube([(-.56, .34, -.4), (-.44, .34, -.4)], .016, "rubber", 8)
    m.hook("pullcord", (-.5, .36, -.42))
    m.hook("exhaust", (.9, 1.9, -.42))
    m.collide_box(0, 0, L + .1, W_ + .1, 0, 1.45, tag="generator")
    m.radius = 2
    return m


SHOT_M = [((22, 1.7, 18), (0, 12, 0), 26), ((5, 1.7, 7), (0, 7, 0), 30)]
SHOT_H = [((4.2, 1.7, 7.5), (0, 1.3, 0), 34), ((-4.5, 1.7, 5.5), (-.5, 1.3, 1), 36)]
SHOT_G = [((2.3, 1.2, 2.6), (0, .8, 0), 40), ((-2.4, 1.3, -1.8), (0, .8, 0), 40)]
ASSETS = {"mast": (mast, SHOT_M), "hut": (hut, SHOT_H), "generator": (generator, SHOT_G)}
