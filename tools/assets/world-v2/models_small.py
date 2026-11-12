"""Small props, signs and everyday clutter: the pieces that make a place look used."""
import math
import os

import numpy as np

from kit import Model, poster_material, ROOT

ART = os.path.join(ROOT, "assets/world-v2/art")


def noticeboard():
    for n in ("poster_missing", "poster_closed", "trail_map"):
        poster_material(n, os.path.join(ART, n + ".png"))
    m = Model("noticeboard", tex=2048, seed=61)
    for x in (-1.25, 1.25):
        m.log((x, -.1, 0), (x, 2.82, 0), .085, "logwood", sides=9, segs=2)
        m.collide_post(x, 0, x, 0, .1, 0, 2.7, "notice post")
    # Plywood backing with boards lapped over it: no daylight, and fixed to both posts.
    # Rear: real vertical boards on two battens, nailed through.
    for x_ in np.arange(-1.17, 1.2, .195):
        m.plank((x_, .93, -.03), (x_, 2.34, -.03), .19, .02, up=(0, 0, -1), warp=.003, segs=1)
    for y_ in (1.15, 2.1):
        m.beam((-1.3, y_, -.05), (1.3, y_, -.05), .08, .03, "wood_dark", up=(0, 1, 0))
    for y in np.arange(.95, 2.3, .16):
        m.plank((-1.3, y, .01), (1.3, y, .01), .17, .022, up=(0, 0, 1), warp=.002)
        for x in (-1.25, 1.25):
            m.bolt((x, y, .023), (0, 0, 1), .008)
    m.collide_box(0, .02, 1.25, .05, .9, 2.35, tag="noticeboard")
    for y in (.91, 2.35):
        m.beam((-1.34, y, .03), (1.34, y, .03), .08, .08, "wood_dark", up=(0, 0, 1))
    # Roof with a ridge beam, rafters notched over the posts and boards nailed on battens.
    RIDGE, EAVE, OUT = 3.02, 2.62, .72
    m.beam((-1.7, RIDGE - .06, 0), (1.7, RIDGE - .06, 0), .09, .13, "wood_dark")
    for x in (-1.25, 0, 1.25):
        for s in (-1, 1):
            m.beam((x, RIDGE - .05, 0), (x, EAVE - .03, s * OUT), .06, .1, "wood_dark")
    for x in (-1.25, 1.25):
        m.beam((x, 2.82, -.08), (x, 2.98, -.02), .05, .06, "wood_dark", up=(1, 0, 0))
        m.beam((x, 2.82, .08), (x, 2.98, .02), .05, .06, "wood_dark", up=(1, 0, 0))
    for s in (-1, 1):
        for t in (.2, .75):
            m.beam((-1.68, RIDGE - (RIDGE - EAVE) * t + .03, s * OUT * t), (1.68, RIDGE - (RIDGE - EAVE) * t + .03, s * OUT * t), .05, .03, "wood_dark")
        for i in range(11):
            x = -1.66 + i * .332
            m.plank((x, RIDGE + .0, s * .0), (x + m.rng.uniform(-.01, .01), EAVE + .02, s * (OUT + .04)), .325, .022, up=(0, .9, s * .4), mat="wood_dark", segs=1)
    m.poster("trail_map", (-.42, 1.62, .027), (1, 0, 0), (0, 1, 0), 1.18, 1.18)
    m.poster("poster_missing", (.55, 1.72, .029), (.998, .05, 0), (-.05, .998, 0), .56, .77)
    m.poster("poster_closed", (.96, 1.36, .032), (.995, -.09, 0), (.09, .995, 0), .4, .55)
    for x, y in ((-.98, 2.18), (.14, 2.18), (-.98, 1.06), (.14, 1.06), (.3, 2.1), (.82, 2.08), (.28, 1.36), (.82, 1.34)):
        m.bolt((x, y, .03), (0, 0, 1), .005, "steel_bare")
    m.radius = 2
    return m


def roadsign():
    poster_material("sign_road", os.path.join(ART, "sign_road.png"))
    m = Model("roadsign", tex=1024, seed=62)
    m.cyl((0, -.15, -.03), (.012, 2.42, -.03), .03, "galv", 10)
    # Plate with a rolled edge, on a strut, clamped to the post.
    m.box((0, 2.06, .0), (.8, .6, .012), "galv", chamfer=.004)
    m.poster("sign_road", (0, 2.06, .008), (1, 0, 0), (0, 1, 0), .76, .56, density=4)
    # Channel stiffeners and a concrete collar where the post goes in.
    for y in (1.88, 2.24):
        m.beam((-.36, y, -.012), (.36, y, -.012), .05, .02, "galv", up=(0, 0, 1), chamfer=.004)
    m.lathe([(.0, 1), (.09, 1), (.12, .6), (.14, 0)], (0, .08, -.03), (0, -.08, -.03), "concrete", 12)
    m.beam((0, 1.74, -.012), (0, 2.38, -.012), .04, .014, "steel", up=(0, 0, 1), chamfer=.003)
    for y in (1.85, 2.27):
        m.tube([(-.05, y, -.03), (.0, y, -.075), (.05, y, -.03)], .005, "steel_bare", 5)
        m.bolt((0, y, .006), (0, 0, 1), .009)
    for i in range(4):
        a = m.rng.uniform(-.28, .28)
        b = m.rng.uniform(1.85, 2.3)
        m.cyl((a, b, .007), (a, b, .0092), .006, "void", 6)
    m.collide_post(0, -.03, 0, -.03, .05, 0, 2.3, "sign post")
    return m


def pole():
    m = Model("pole", tex=1024, seed=63)
    H = 9.6
    m.log((0, -.4, 0), (.07, H, .03), .15, "logwood", sides=10, segs=4, noise=.02, taper=.3, caps=(False, True))
    top = lambda y: (.07 * (y + .4) / (H + .4), y, .03 * (y + .4) / (H + .4))
    arm_y = H - .55
    cx, _, cz = top(arm_y)
    m.beam((cx - 1.15, arm_y, cz + .14), (cx + 1.15, arm_y, cz + .14), .1, .12, "wood_dark")
    m.bolt((cx, arm_y, cz + .2), (0, 0, 1), .018)
    for x in (-.65, .65):
        m.beam((cx + np.sign(x) * .05, arm_y - .9, cz + .15), (cx + x, arm_y - .05, cz + .205), .05, .01, "galv", up=(0, 0, 1))
        m.bolt((cx + x, arm_y - .05, cz + .21), (0, 0, 1), .012)
    wires = {}
    for name, x in (("wire_l", -1.0), ("wire_c", 0.0), ("wire_r", 1.0)):
        m.cyl((cx + x, arm_y + .05, cz + .14), (cx + x, arm_y + .22, cz + .14), .012, "galv", 6)
        m.lathe([(.01, 0), (.05, .1), (.03, .3), (.06, .45), (.03, .65), (.05, .8), (.02, 1)], (cx + x, arm_y + .2, cz + .14), (cx + x, arm_y + .45, cz + .14), "ceramic", 12)
        m.hook(name, (cx + x, arm_y + .46, cz + .14))
    # Transformer, bolted on two hanger straps and wired up.
    tz = cz - .4
    m.lathe([(0, 0), (.22, .03), (.235, .08), (.24, .1), (.25, .18), (.24, .26), (.25, .34), (.24, .42), (.25, .5), (.24, .58), (.25, .66), (.24, .74), (.24, .92), (.2, 1), (0, 1)], (cx, H - 2.65, tz), (cx, H - 1.55, tz), "steel", 18)
    for x_ in (-.1, .1):
        m.lathe([(.03, 0), (.038, .15), (.024, .3), (.036, .45), (.022, .6), (.03, .8), (.012, 1)], (cx + x_, H - 1.53, tz), (cx + x_, H - 1.25, tz), "ceramic", 10)
        m.tube([(cx + x_, H - 1.25, tz), (cx + x_ + np.sign(x_) * .3, arm_y - .1, cz + .05), (cx + np.sign(x_) * 1.0, arm_y + .1, cz + .14)], .005, "steel_bare", 5)
    for y in (H - 2.45, H - 1.75):
        m.beam((cx, y, cz - .12), (cx, y, tz + .22), .16, .03, "steel", up=(0, 1, 0))
    m.tube([(cx + .12, H - 1.55, tz), (cx + .55, arm_y - .1, cz), (cx + 1.0, arm_y + .1, cz + .14)], .006, "steel_bare", 5)
    # Staggered steps for lineman's boots, a tag at eye height, and the ground wire.
    for i in range(14):
        s = 1 if i % 2 else -1
        y = 2.6 + i * .42
        m.cyl((*top(y)[:1], y, top(y)[2]), (top(y)[0] + s * .24, y + .03, top(y)[2]), .012, "steel_bare", 6)
    m.box((top(1.6)[0], 1.6, top(1.6)[2] + .15), (.09, .05, .004), "galv", chamfer=.001)
    m.tube([(top(H - 2)[0], H - 2.0, top(H - 2)[2] + .13), (0, 3.0, .14), (0, 0, .15)], .005, "steel_bare", 5)
    m.collide_post(0, 0, 0, 0, .17, 0, H, "utility pole")
    m.radius = 2
    return m


def deerstand():
    m = Model("deerstand", tex=1024, seed=64)
    FL = 3.1
    def leg(sx, sz, y):
        t = (y + .1) / (FL + 1.85)
        return np.array((sx * (1.05 - .37 * t), y, sz * (1.05 - .37 * t)))
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.log(leg(sx, sz, -.1), leg(sx, sz, FL + 1.75), .06, "logwood", sides=8, segs=3)
            m.collide_post(sx * 1.0, sz * 1.0, sx * .7, sz * .7, .08, 0, FL, "stand leg")
    for y in (1.0, 2.0):
        for s in (-1, 1):
            a, b = leg(-1, s, y), leg(1, s, y)
            m.beam(a, b, .05, .05, "wood_dark", up=(0, 1, 0))
            m.lash(a, (0, 1, 0), .07)
            m.lash(b, (0, 1, 0), .07)
            a, b = leg(s, -1, y), leg(s, 1, y)
            m.beam(a, b, .05, .05, "wood_dark", up=(0, 1, 0))
    # Cross bracing on the back and both sides, bolted where the pieces meet.
    for (p, q, r_, s_) in ((leg(-1, -1, .2), leg(1, -1, FL - .1), leg(1, -1, .2), leg(-1, -1, FL - .1)), (leg(-1, -1, .2), leg(-1, 1, FL - .1), leg(-1, 1, .2), leg(-1, -1, FL - .1)), (leg(1, -1, .2), leg(1, 1, FL - .1), leg(1, 1, .2), leg(1, -1, FL - .1))):
        m.beam(p, q, .06, .025, "wood_dark", up=(0, 0, 1) if abs(p[2] - q[2]) < .05 else (1, 0, 0))
        m.beam(r_, s_, .06, .025, "wood_dark", up=(0, 0, 1) if abs(p[2] - q[2]) < .05 else (1, 0, 0))
    for s in (-1, 1):
        a, b = leg(-1, s, FL - .08), leg(1, s, FL - .08)
        m.beam(a, b, .06, .1, "wood_dark")
    for x in np.arange(-.77, .8, .155):
        m.plank((x, FL + .01, -.82), (x, FL + .01, .82), .15, .03, warp=.004, segs=2)
    for s in (-1, 1):
        m.beam((s * .79, FL - .08, -.82), (s * .79, FL - .08, .82), .06, .1, "wood_dark")
    for i in range(5):
        y_ = FL + .13 + i * .17
        m.plank((-.84, y_, -.78), (.84, y_, -.78), .165, .02, up=(0, 0, 1), warp=.004, segs=1)
        m.plank((-.84, y_, .78), (-.3, y_, .78), .165, .02, up=(0, 0, 1), warp=.004, segs=1)
        m.plank((.3, y_, .78), (.84, y_, .78), .165, .02, up=(0, 0, 1), warp=.004, segs=1)
    for x in (-.78, .78):
        for i in range(5):
            y_ = FL + .13 + i * .17
            m.plank((x, y_, -.84), (x, y_, .84), .165, .02, up=(1, 0, 0), warp=.004, segs=1)
    for sx in (-.8, .8):
        for sz in (-.8, .8):
            m.beam((sx, FL, sz), (sx * .9, FL + 1.68, sz * .9), .05, .05, "wood_dark")
    # Roof on purlins, carried by the leg tops.
    for z in (-.7, .7):
        y = FL + 1.72 - z * .11
        m.beam((-.8, y, z), (.8, y, z), .05, .07, "wood_dark")
    for i in range(7):
        m.tin_sheet((-.9 + i * .3, FL + 1.88, -1.05), (1, 0, 0), (0, -.23, 2.1), .31, 2.11, waves=2, droop=.0, curl=0)
    # Ladder lashed at the head; its rails carry on above the deck as handholds.
    for s in (-.2, .2):
        m.log((s, -.08, 1.45), (s, FL + .95, .54), .03, "logwood", sides=7, segs=2)
    for i in range(10):
        t = (i + .6) / 10.4
        y = t * (FL + .3)
        z = 1.45 + (.54 - 1.45) * (y + .08) / (FL + 1.03)
        m.log((-.24, y, z), (.24, y, z), .02, "logwood", sides=6, segs=1)
    y_l, z_l = FL + .02, 1.45 + (.54 - 1.45) * (FL + .1) / (FL + 1.03)
    for s in (-.2, .2):
        m.lash((s, y_l, z_l - .01), (0, 1, 0), .036, turns=5, width=.014)
    m.beam((-.32, y_l, z_l - .03), (.32, y_l, z_l - .03), .05, .05, "wood_dark")
    m.collide_box(0, 0, .82, .82, FL - .12, FL + .03, tag="stand floor")
    m.collide_box(0, -.78, .84, .05, FL, FL + .95, tag="stand wall")
    for x_ in (-.78, .78):
        m.collide_box(x_, 0, .05, .84, FL, FL + .95, tag="stand wall")
    m.ladder((0, 0, 1.45), (0, FL + .03, z_l), (0, FL + .03, .3))
    m.hook("fuse", (0, FL + .1, 0))
    m.radius = 2
    return m


def jerrycan():
    """Pressed steel: two embossed halves welded round the edge, three handles, a cam-locked cap."""
    m = Model("jerrycan", tex=1024, seed=65)
    W, H, D = .17, .46, .085
    m.box((0, H / 2 + .012, 0), (W * 2 - .004, H, D * 2 - .012), "can_olive", chamfer=.032)
    def ridge(dist, width):
        return max(0.0, 1 - (dist / width) ** 2)
    for s in (-1, 1):
        def panel(u, v, s=s):
            x = (u - .5) * 2 * (W - .018)
            y = .03 + v * (H - .03)
            a = (x / .125 - (y - .247) / .185) / 2
            b = (x / .125 + (y - .247) / .185) / 2
            # Two diagonal pressings and a rectangular rim, as raised beads in the sheet.
            x_lines = min(abs(a) * .16, abs(b) * .16)
            inside = abs(x) < .135 and abs(y - .247) < .195
            rim = min(abs(abs(x) - .135), abs(abs(y - .247) - .195))
            h = .007 * max(ridge(x_lines, .018) if inside else 0.0, ridge(rim, .012))
            bulge = .004 * (1 - (x / W) ** 2) * (1 - ((y - .24) / .24) ** 2)
            return np.array((x, y, s * (D - .003 + h + bulge)))
        m.surface("can_olive", panel, 26, 34, (.7, .9), flip=s < 0, wear=lambda u, v: (1 - v) ** 4 * .55)
    # The weld runs right around the can between the two halves.
    corners = [(-W, .03), (-W + .02, .012), (W - .02, .012), (W, .03), (W, H - .01), (W - .03, H + .012), (-W + .03, H + .012), (-W, H - .01), (-W, .03)]
    m.tube([(x, y, 0) for x, y in corners], .0055, "can_olive", 6, wear=.5)
    # Three parallel handles welded on across the top.
    for x in (-.115, -.055, .005):
        pts = [(x, H + .004, -.05), (x, H + .05, -.045), (x, H + .056, 0), (x, H + .05, .045), (x, H + .004, .05)]
        m.tube(pts, .0065, "can_olive", 6, wear=.35)
    # Short collar, a flat cap on a hinge, and the cam lever that locks it.
    cx = .1
    m.lathe([(.034, 0), (.034, .5), (.038, .55), (.038, 1)], (cx, H + .008, 0), (cx, H + .036, 0), "can_olive", 16)
    m.lathe([(0, 1), (.04, .9), (.042, .2), (.04, 0)], (cx, H + .036, 0), (cx, H + .052, 0), "can_olive", 16, wear=.3)
    m.cyl((cx + .036, H + .05, -.03), (cx + .036, H + .05, .03), .006, "steel_bare", 6)
    m.tube([(cx - .036, H + .044, 0), (cx - .05, H + .062, 0), (cx - .005, H + .07, 0), (cx + .03, H + .06, 0)], .0055, "steel_bare", 6)
    m.collide_box(0, 0, W + .01, D + .01, 0, H + .1, tag="jerry can")
    return m


def fuse():
    """A mine-grade cartridge fuse: printed ceramic barrel, brass caps, drilled blades."""
    poster_material("label_fuse", os.path.join(ART, "label_fuse.png"))
    m = Model("fuse", tex=1024, seed=66)
    L = .085
    m.lathe([(0, 0), (.019, .0), (.019, .1), (.0175, .13), (.0175, .87), (.019, .9), (.019, 1), (0, 1)], (0, 0, -L), (0, 0, L), "ceramic", 22)
    def label(u, v):
        th = -1.9 + u * 4.6
        return np.array((math.cos(th) * .0179, math.sin(th) * .0179, (v - .5) * .118))
    m.surface("label_fuse", label, 14, 1, (1, 1), metres_per_uv=.13, density=6, flip=True)
    for s in (-1, 1):
        m.lathe([(.0195, 0), (.0205, .1), (.0205, .9), (.0195, 1)], (0, 0, s * (L - .02)), (0, 0, s * L), "brass", 22, wear=.3)
        for a in (0, 2.1, 4.2):
            m.bolt((math.cos(a) * .0205, math.sin(a) * .0205, s * (L - .01)), (math.cos(a), math.sin(a), 0), .0028, "brass")
        m.beam((0, 0, s * L), (0, 0, s * (L + .034)), .024, .004, "brass", up=(0, 1, 0), chamfer=.001)
        m.cyl((0, -.0025, s * (L + .022)), (0, .0025, s * (L + .022)), .0058, "void", 12)
    return m


def crate():
    """Nailed softwood stores crate. Its lid sits on the rim and is held by two cleats inside."""
    m = Model("crate", tex=1024, seed=67)
    S = .34
    TOP = .698
    rng = m.rng
    y = .1
    i = 0
    while y < TOP - .06:
        h = rng.uniform(.14, .18)
        for s in (-1, 1):
            m.plank((-S - .01, y + h / 2 - .01, s * S), (S + .01, y + h / 2 - .01, s * S), h - .006, .022, up=(0, 0, 1), warp=.002, segs=1, mat="wood_clean")
            m.plank((s * S, y + h / 2 - .01, -S - .01), (s * S, y + h / 2 - .01, S + .01), h - .006, .022, up=(1, 0, 0), warp=.002, segs=1, mat="wood_clean")
        y += h
    # Corner battens stop at the rim; nails hold every board to them.
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.beam((sx * (S + .02), .02, sz * (S + .02)), (sx * (S + .02), TOP, sz * (S + .02)), .05, .05, "wood_dark")
            for y_ in np.arange(.15, TOP - .05, .16):
                m.bolt((sx * (S + .045), y_, sz * (S + .02)), (sx, 0, 0), .0045, "steel")
                m.bolt((sx * (S + .02), y_ + .03, sz * (S + .045)), (0, 0, sz), .0045, "steel")
    # Lid boards seat on the rim, closed down over two cleats, with nail heads along each cleat.
    for x_ in (-.2, .2):
        m.beam((x_, TOP - .02, -S + .03), (x_, TOP - .02, S - .03), .05, .03, "wood_dark", up=(0, 1, 0))
    for i in range(5):
        z_ = -S * .82 + i * S * .41
        m.plank((-S - .035, TOP + .012, z_), (S + .035, TOP + .012, z_ + rng.uniform(-.005, .005)), S * .39, .022, up=(0, 1, 0), warp=.002, segs=1, mat="wood_clean")
        for x_ in (-.2, .2):
            m.bolt((x_, TOP + .023, z_), (0, 1, 0), .0045, "steel")
    # One hasp on the front; skids underneath.
    m.box((0, TOP - .05, S + .018), (.05, .12, .004), "steel_bare", chamfer=.001)
    for s in (-1, 1):
        m.box((0, .05, s * .2), (2 * S, .1, .07), "wood_dark", chamfer=.008)
    m.collide_box(0, 0, S + .04, S + .04, 0, TOP + .03, tag="crate")
    return m


def drum():
    """Struck more than once, standing a long time: dents, a weld seam, rust that grows from the rolled hoops."""
    poster_material("stencil_drum", os.path.join(ART, "stencil_drum.png"))
    m = Model("drum", tex=1024, seed=68)
    R, H = .29, .89
    dents = ((1.1, .28, .05, .24, .1), (3.9, .62, .035, .18, .08), (5.4, .86, .02, .14, .05))
    prof = [(R - .03, .0), (R - .004, .02), (R, .03), (R, .325), (R + .012, .335), (R + .012, .345), (R, .355), (R, .645), (R + .012, .655), (R + .012, .665), (R, .675), (R, .97), (R + .008, .98), (R + .006, 1.0)]
    def body(u, v):
        k = v * (len(prof) - 1)
        i = min(int(k), len(prof) - 2)
        a, b = prof[i], prof[i + 1]
        r, t = a[0] + (b[0] - a[0]) * (k - i), a[1] + (b[1] - a[1]) * (k - i)
        th = u * 2 * math.pi
        push = sum(depth * math.exp(-(math.atan2(math.sin(th - c), math.cos(th - c)) / wa) ** 2 - ((t - tc) / wt) ** 2) for c, tc, depth, wa, wt in dents)
        return np.array((math.cos(th) * (r - push), t * H, math.sin(th) * (r - push)))
    def rust(u, v):
        k = v * (len(prof) - 1)
        i = min(int(k), len(prof) - 2)
        t = prof[i][1]
        near_hoop = max(1 - abs(t - .34) / .05, 1 - abs(t - .66) / .05, 1 - abs(t - .98) / .05, 1 - t / .1, 0)
        side = .5 + .5 * math.sin(u * 6.283 + 1.1)     # worse on the side that stood against the weather
        return min(1.0, near_hoop * (.45 + .4 * side) + .04)
    m.surface("drum_red", body, 40, 26, (3.6, 1.8), flip=True, wear=rust)
    m.beam((math.cos(2.4) * (R + .002), .03, math.sin(2.4) * (R + .002)), (math.cos(2.4) * (R + .002), H - .03, math.sin(2.4) * (R + .002)), .012, .006, "drum_red", up=(math.cos(2.4), 0, math.sin(2.4)), chamfer=.002)
    def stencil(u, v):
        th = .9 - u * .85
        return np.array((math.cos(th) * (R + .001), .4 + v * .23, math.sin(th) * (R + .001)))
    m.surface("stencil_drum", stencil, 10, 1, (1, 1), metres_per_uv=.3, density=3)
    tris, v, n, uv = [], [(0, H - .014, 0)], [(0, 1, 0)], [(.5, .5)]
    for i in range(32):
        a = i / 32 * 6.28318
        v.append((math.cos(a) * (R + .002), H - .014, math.sin(a) * (R + .002)))
        n.append((0, 1, 0))
        uv.append((.5 + .5 * math.cos(a), .5 + .5 * math.sin(a)))
        tris.append((0, 1 + (i + 1) % 32, 1 + i))
    m.add("drum_red", v, n, uv, tris, metres_per_uv=2 * R, wear=.45)
    for x, z, r in ((.14, .06, .032), (-.15, -.05, .02)):
        m.lathe([(0, 1), (r, 1), (r * 1.25, .7), (r * 1.25, .0)], (x, H + .002, z), (x, H - .014, z), "steel_bare", 10)
    m.collide_post(0, 0, 0, 0, .3, 0, .9, "drum")
    return m


def tire():
    """A dumped truck tyre lying flat: deep lugs, a shouldered sidewall, packed with old soil."""
    m = Model("tire", tex=1024, seed=69)
    rows = [(.075, .215), (.083, .235), (.1, .262), (.112, .3), (.116, .312), (.112, .324), (.118, .342), (.112, .362), (.096, .375), (.05, .38), (.0, .38)]
    sections = [(-w, r) for w, r in rows] + [(w, r) for w, r in reversed(rows[:-1])]
    n = len(sections) - 1
    LUGS = 20
    def fn(u, v):
        j = int(round(v * n))
        wx, r = sections[j]
        th = u * 2 * math.pi
        if abs(wx) < .1 and r > .37:
            # Three samples per lug: two up on the block, one down in the groove, staggered across the centre line.
            k = (int(round(u * LUGS * 3)) + (2 if wx > 0 else 0)) % 3
            r += .018 if k != 2 else 0
        # A slow oval: tyres left flat take a set.
        r *= 1 + .025 * math.cos(2 * th + 1)
        return np.array((math.cos(th) * r, .125 + wx, math.sin(th) * r))
    m.surface("tyre", fn, LUGS * 3, n, (9, 1.6))
    return m


SHOT = None
ASSETS = {
    "noticeboard": (noticeboard, None), "roadsign": (roadsign, None), "pole": (pole, None),
    "deerstand": (deerstand, None), "jerrycan": (jerrycan, None), "fuse": (fuse, None),
    "crate": (crate, None), "drum": (drum, None), "tire": (tire, None),
}
