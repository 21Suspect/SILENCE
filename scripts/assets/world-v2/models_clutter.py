"""Everyday things that make the basin look lived in, and a few that make it look wrong.

Every object is built the way the real one was built: boards nailed to rails, handles
socketed into heads, tin rolled over wire. Hero props stay under 8k, background under 2.5k.
"""
import math
import os

import numpy as np

from kit import Model, poster_material, ROOT

ART = os.path.join(ROOT, "assets/world-v2/art")


PRIVY_DW = 2 * .62 - .12


def door_privy():
    """The privy door: seven boards on three ledges and two braces, a crescent sawn through the top. Hinge edge on the origin."""
    m = Model("door_privy", tex=1024, seed=202)
    DW, DB, DT = PRIVY_DW, .16, 1.93
    n = 7
    for i in range(n):
        x = (i + .5) * DW / n
        m.plank((x, DB, 0), (x, DT - m.rng.uniform(0, .012), 0), DW / n - .004, .022, up=(0, 0, 1), warp=.002, segs=1)
    for y in (DB + .2, 1.05, DT - .2):
        m.plank((.03, y, -.022), (DW - .03, y, -.022), .1, .022, up=(0, 0, -1), mat="wood_dark", warp=.001, segs=1)
        for i in range(n):
            m.nail(((i + .5) * DW / n, y + (.02 if i % 2 else -.02), .011), (0, 0, 1), .005)
    for y0, y1 in ((DB + .26, .99), (1.11, DT - .26)):
        m.plank((.08, y0, -.022), (DW - .08, y1, -.022), .09, .022, up=(0, 0, -1), mat="wood_dark", warp=.001, segs=1)
    # Strap hinges: the strap is bolted along the ledge line, its knuckle turns on a pin driven into the post.
    for y in (DB + .2, DT - .2):
        m.box((.2, y, .013), (.44, .045, .005), "steel", chamfer=.0015)
        m.cyl((-.012, y - .04, .012), (-.012, y + .04, .012), .011, "steel", 8)
        m.box((-.04, y, .004), (.06, .07, .005), "steel", chamfer=.0015)
        for x in (.06, .2, .36):
            m.bolt((x, y, .0155), (0, 0, 1), .006, "steel_bare")
    # A turned wooden pull, and the hook that used to hold it shut.
    m.cyl((DW - .1, 1.05, .011), (DW - .1, 1.05, .05), .016, "wood_dark", 8)
    m.tube([(DW - .03, 1.2, .013), (DW - .03, 1.2, .03), (DW + .0, 1.17, .03), (DW + .015, 1.1, .03), (DW + .01, 1.06, .03)], .0035, "steel_bare", 5)
    # The crescent sawn through the top of the door.
    cx, cy, ro = DW / 2, DT - .33, .075
    cv, cn, cuv, cf = [], [], [], []
    K = 12
    for k in range(K + 1):
        t = -1.25 + 2.5 * k / K
        outer = (cx - .02 + math.cos(t) * ro, cy + math.sin(t) * ro)
        inner = (cx + .022 + math.cos(t * .8) * ro * .78, cy + math.sin(t) * ro * .96)
        if inner[0] > outer[0]:
            inner = outer
        cv += [(outer[0], outer[1], .0138), (inner[0], inner[1], .0138)]
        cn += [(0, 0, 1)] * 2
        cuv += [(outer[0], outer[1]), (inner[0], inner[1])]
        if k:
            cf.append((2 * k - 2, 2 * k - 1, 2 * k + 1, 2 * k))
    m.add("void", cv, cn, cuv, cf, metres_per_uv=1)
    m.radius = 1.2
    return m


def outhouse():
    """Board-and-batten privy on timber skids. The door is a ledged-and-braced one, hung on two strap hinges and left open."""
    m = Model("outhouse", tex=2048, seed=201)
    W, D, H = .62, .72, 2.1
    DROP = .3
    top_at = lambda z: H - DROP * (D - z) / (2 * D)
    # Two skids on the ground, a floor frame on them, four corner posts and a plate all round under the roof.
    for x in (-W, W):
        m.beam((x, .05, -D - .12), (x, .05, D + .12), .12, .1, "wood_dark", chamfer=.012)
    for z in (-D, D):
        m.beam((-W - .04, .14, z), (W + .04, .14, z), .08, .08, "wood_dark")
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.beam((sx * W, .1, sz * D), (sx * W, top_at(sz * D), sz * D), .08, .08, "wood_dark")
    for z in (-D, D):
        m.beam((-W - .04, top_at(z), z), (W + .04, top_at(z), z), .08, .09, "wood_dark")
    for x in (-W, W):
        m.beam((x, top_at(D), D), (x, top_at(-D), -D), .08, .09, "wood_dark")
    # Floor boards.
    for x in np.arange(-W + .07, W, .15):
        m.plank((x, .19, -D + .03), (x, .19, D - .03), .145, .022, warp=.002, segs=1)
    # Boards stand outside the frame and run right up under the tin: no daylight at the eaves.
    OUT = .052
    def side_boards(a, b, normal, h0):
        a, b = np.asarray(a, float), np.asarray(b, float)
        L = float(np.linalg.norm(b - a))
        n = int(round(L / .152))
        for i in range(n):
            p = a + (b - a) * (i + .5) / n
            m.plank((p[0], .09 - m.rng.uniform(0, .02), p[2]), (p[0], h0(p), p[2]), L / n - .004, .02, up=normal, warp=.003, segs=1)
            for y in (.5, 1.5):
                m.nail((p[0] + normal[0] * .01, y + m.rng.uniform(-.012, .012), p[2] + normal[2] * .01), normal, .005)
    roof_under = lambda p: top_at(p[2]) + .075
    side_boards((-W - OUT, 0, -D - .04), (-W - OUT, 0, D + .04), (-1, 0, 0), roof_under)
    side_boards((W + OUT, 0, -D - .04), (W + OUT, 0, D + .04), (1, 0, 0), roof_under)
    side_boards((-W - .04, 0, -D - OUT), (W + .04, 0, -D - OUT), (0, 0, -1), lambda p: top_at(-D) + .06)
    # The rails the boards are nailed to, let in between the posts.
    for y in (.5, 1.5):
        for x in (-W, W):
            m.beam((x, y, -D + .04), (x, y, D - .04), .07, .06, "wood_dark")
        m.beam((-W + .04, y, -D), (W - .04, y, -D), .07, .06, "wood_dark", up=(0, 0, 1))
    # Front: a head board over the doorway and a narrow board down each jamb.
    m.plank((-W - .06, top_at(D) - .03, D + OUT), (W + .06, top_at(D) - .03, D + OUT), .2, .02, up=(0, 0, 1), warp=.002, segs=1)
    for sx in (-1, 1):
        m.plank((sx * (W + .01), .09, D + OUT), (sx * (W + .01), top_at(D) - .13, D + OUT), .1, .02, up=(0, 0, 1), warp=.002, segs=1)
    # The door is a separate, hinged model (door_privy below): the game opens and shuts it.
    m.door("door_privy", (-W + .06, 0, D + OUT + .022), 0.0, -1.9, width=PRIVY_DW, height=1.93, thickness=.03, start=.4)
    # Seat: a boxed bench across the back with a hinged lid board and the hole.
    m.box((0, .2 + .21, -D + .27), (2 * W - .08, .42, .5), "wood", chamfer=.01)
    m.plank((-W + .04, .635, -D + .27), (W - .04, .635, -D + .27), .52, .025, mat="wood", warp=.001, segs=1)
    m.cyl((0, .645, -D + .3), (0, .65, -D + .3), .12, "void", 18)
    # Tin on two purlins that bear on the plates, nailed through the crests.
    for z in (-D + .08, D - .08):
        m.beam((-W - .2, top_at(z) + .07, z), (W + .2, top_at(z) + .07, z), .06, .05, "wood_dark")
    slope = np.array((0, -DROP / (2 * D), -1.0))
    for i in range(3):
        x0 = -W - .24 + i * .52
        m.tin_sheet((x0, top_at(D + .22) + .108 + i % 2 * .006, D + .22), (1, 0, 0), slope * 1.9, .56, 1.94, waves=3)
        for z in (-D + .08, D - .08):
            for dx in (.09, .28, .47):
                m.nail((x0 + dx, top_at(z) + .122, z), (0, 1, 0), .008, "steel_bare")
    m.collide_box(0, -D, W + .06, .05, 0, H, tag="outhouse wall")
    m.collide_box(-W, 0, .05, D + .06, 0, H, tag="outhouse wall")
    m.collide_box(W, 0, .05, D + .06, 0, H, tag="outhouse wall")
    m.collide_box(0, -D + .27, W, .27, 0, .65, tag="outhouse seat")
    # The open door has no collider: it would widen the footprint the game seats the whole privy on.
    m.radius = 2
    return m


def picnic_table():
    m = Model("picnic_table", tex=1024, seed=202)
    L, TOP, SEAT = .92, .76, .46
    for i in range(5):
        z = (i - 2) * .145
        m.plank((-L, TOP, z), (L, TOP, z + m.rng.uniform(-.004, .004)), .14, .04, warp=.004, segs=2)
    for s in (-1, 1):
        for i in range(2):
            z = s * (.5 + i * .13)
            m.plank((-L, SEAT, z), (L, SEAT, z), .125, .04, warp=.004, segs=2)
    for x in (-.65, .65):
        # A frames: two legs bolted through the seat bearer and the top cleat.
        for s in (-1, 1):
            m.beam((x + s * .0, .0, s * .78), (x, TOP - .02, s * .12), .1, .04, "wood", up=(1, 0, 0), chamfer=.006)
            m.bolt((x + .02, SEAT - .05, s * .46), (1, 0, 0), .012)
            m.bolt((x + .02, TOP - .08, s * .19), (1, 0, 0), .012)
        m.beam((x + .04, SEAT - .06, -.82), (x + .04, SEAT - .06, .82), .04, .1, "wood_dark")
        m.beam((x - .04, TOP - .03, -.34), (x - .04, TOP - .03, .34), .04, .08, "wood_dark")
    # Something carved into it, a rusted can on top.
    m.lathe([(0, 0), (.037, .02), (.037, .96), (.041, 1)], (.3, TOP + .02, .1), (.3, TOP + .13, .1), "steel_bare", 12, wear=.5)
    m.collide_box(0, 0, L, .85, 0, TOP + .03, tag="picnic table")
    m.radius = 2
    return m


def sawhorse():
    m = Model("sawhorse", tex=1024, seed=203)
    H, L = .92, .65
    for x in (-L, L):
        for s in (-1, 1):
            m.beam((x + s * .02, 0, s * .36), (x, H, s * .02), .09, .04, "wood_fresh", up=(1, 0, 0), chamfer=.006)
            m.bolt((x + .017, H - .1, s * .06), (1, 0, 0), .009)
    m.beam((-L - .1, H - .04, 0), (L + .1, H - .04, 0), .08, .08, "wood_dark", chamfer=.006)
    for x in (-L, L):
        m.beam((x - .03, H * .5, -.2), (x - .03, H * .5, .2), .03, .08, "wood_dark")
    # A log half cut through, the bucksaw still in it.
    m.log((-1.25, H + .13, .02), (1.25, H + .13, -.03), .13, "bark", "endgrain", sides=10, segs=3)
    x0 = .2
    m.tube([(x0 - .45, H + .34, .02), (x0 + .45, H + .34, .02)], .012, "wood_dark", 6)
    for s in (-1, 1):
        m.beam((x0 + s * .45, H + .16, .02), (x0 + s * .45, H + .55, .02), .022, .03, "wood_dark", chamfer=.004)
    m.beam((x0 - .45, H + .16, .02), (x0 + .45, H + .16, .02), .03, .002, "steel_bare", up=(0, 0, 1), chamfer=.0005)
    m.tube([(x0 - .45, H + .52, .02), (x0 + .45, H + .52, .02)], .003, "steel_bare", 4)
    m.collide_box(0, 0, L + .12, .38, 0, H + .28, tag="sawhorse")
    m.radius = 1.6
    return m


def pallet():
    m = Model("pallet", tex=1024, seed=204)
    S = .6
    for x in (-S + .06, 0, S - .06):
        m.beam((x, .075, -S), (x, .075, S), .09, .095, "wood_clean", chamfer=.006)
    for i in range(7):
        z = -S + .07 + i * (2 * S - .14) / 6
        if i == 4:
            m.plank((-S, .13, z), (.05, .13, z), .135, .022, mat="wood_clean", segs=1, warp=.003)
            continue
        m.plank((-S, .13, z), (S, .13, z), .135, .022, mat="wood_clean", segs=1, warp=.003)
        for x in (-S + .06, S - .06):
            m.bolt((x, .1405, z), (0, 1, 0), .0055, "steel")
    for z in (-S + .06, S - .06):
        m.plank((-S, .018, z), (S, .018, z), .1, .02, mat="wood_clean", segs=1, warp=.002)
    m.collide_box(0, 0, S, S, 0, .15, tag="pallet")
    m.radius = 1
    return m


def wheelbarrow():
    m = Model("wheelbarrow", tex=1024, seed=205)
    # Hardwood handles carry everything: the wheel at one end, the tray bolted on top, the legs below.
    for s in (-1, 1):
        m.beam((s * .3, .56, -.85), (s * .16, .33, .62), .05, .05, "wood_dark", chamfer=.012)
        m.beam((s * .27, .44, -.3), (s * .29, .0, -.36), .05, .03, "steel", chamfer=.006)
        m.tube([(s * .3, .56, -.95), (s * .3, .56, -.85)], .022, "rubber", 8)
    m.beam((-.23, .39, .2), (.23, .39, .2), .05, .05, "wood_dark")
    m.beam((-.3, .49, -.32), (.3, .49, -.32), .05, .05, "wood_dark")
    # Wheel: spoked steel rim in a solid tyre.
    ax = np.array((0, .22, .62))
    def tyre(u, v):
        th, ph = u * 6.283, v * 6.283
        R = .19 + .03 * math.cos(ph)
        return np.array((.03 * math.sin(ph), ax[1] + math.sin(th) * R, ax[2] + math.cos(th) * R))
    m.surface("tyre", tyre, 24, 6, (2.4, .4))
    m.cyl((-.045, ax[1], ax[2]), (.045, ax[1], ax[2]), .022, "steel_bare", 10)
    for a in np.arange(0, 6.28, 1.047):
        m.tube([(0, ax[1], ax[2]), (0, ax[1] + math.sin(a) * .16, ax[2] + math.cos(a) * .16)], .007, "steel_bare", 5)
    for s in (-1, 1):
        m.beam((s * .07, ax[1], ax[2]), (s * .16, .33, .36), .012, .03, "steel_bare", chamfer=.003)
    # Pressed tin tray, rolled at the rim, full of rainwater stain and leaves.
    def tray(u, v):
        th = u * 6.283
        # A rounded rectangle whose walls flare upward from the floor.
        c, s = math.cos(th), math.sin(th)
        rx, rz = .4, .52
        edge = (abs(c) ** 4 + abs(s) ** 4) ** .25
        floor = min(1.0, v / .35)
        wall = max(0.0, (v - .35) / .65)
        x = c / edge * rx * (floor * .72 + wall * .28)
        z = s / edge * rz * (floor * .74 + wall * .26) - .05
        y = .53 + wall * .3
        return np.array((x, y, z))
    m.surface("tin", tray, 36, 10, (3.2, 1.6), wear=lambda u, v: (1 - v) ** 2 * .7)
    def rim(u, v):
        th = u * 6.283
        c, s = math.cos(th), math.sin(th)
        edge = (abs(c) ** 4 + abs(s) ** 4) ** .25
        ph = v * 6.283
        return np.array((c / edge * (.4 + .012 * math.cos(ph)), .83 + .012 * math.sin(ph), s / edge * (.52 + .012 * math.cos(ph)) - .05))
    m.surface("tin", rim, 36, 4, (3.2, .2))
    # Tub held down by four steel straps, bolted through the cross-bars and the tub wall.
    for z, y0 in ((.2, .39), (-.32, .49)):
        for s_ in (-1, 1):
            m.beam((s_ * .19, y0 + .02, z), (s_ * .335, .518, z), .032, .005, "steel_bare", up=(0, 0, 1), chamfer=.001)
            m.beam((s_ * .335, .518, z), (s_ * .362, .66, z), .032, .005, "steel_bare", up=(0, 0, 1), chamfer=.001)
            m.bolt((s_ * .362, .645, z), (s_, 0, 0), .01)
            m.bolt((s_ * .19, y0 + .022, z), (0, 1, 0), .01)
    m.collide_box(0, -.05, .42, .95, 0, .85, tag="wheelbarrow")
    m.radius = 1.5
    return m


def shovel():
    """A round-point digging shovel, about chest height stood on end."""
    m = Model("shovel", tex=1024, seed=206)
    Y = .045
    a = np.array((0, Y, -.62))     # top of the shaft
    b = np.array((0, Y + .004, .38))
    m.lathe([(.0, 0), (.0205, .015), (.0195, .5), (.018, .95), (.015, 1)], b, a, "wood_dark", 10)
    # Forged socket running up the shaft, split at the back and pinned by two rivets.
    m.lathe([(.032, 0), (.027, .3), (.022, .96), (.0205, 1)], b + (0, 0, .03), b + (0, 0, -.19), "steel", 12, wear=.3)
    for z_ in (-.05, -.13):
        m.bolt(b + (.026, 0, z_), (1, 0, 0), .0065)
        m.bolt(b + (-.026, 0, z_), (-1, 0, 0), .0065)
    # Wooden D-grip: two split cheeks riveted to the shaft, closed by a turned cross bar.
    for sx in (-1, 1):
        pts = [a + (sx * .012, 0, .05), a + (sx * .04, 0, -.05), a + (sx * .072, 0, -.13)]
        for p0, p1 in zip(pts, pts[1:]):
            m.beam(p0, p1, .03, .018, "wood_dark", up=(0, 1, 0), chamfer=.004)
        m.bolt(a + (sx * .018, .011, .03), (0, 1, 0), .005, "steel_bare")
    m.lathe([(.015, 0), (.0185, .1), (.0185, .9), (.015, 1)], a + (-.082, 0, -.14), a + (.082, 0, -.14), "wood", 10)
    # Blade: dished, round at the point, turned over at the shoulders for a boot.
    Z0, LEN, HALF = .39, .29, .118
    def outline(t):
        return 1 - .08 * t - .72 * max(0.0, (t - .55) / .45) ** 2.1
    def blade(u, v, lift=0.0):
        t = v
        w = HALF * outline(t)
        x = (u - .5) * 2 * w
        dish = -.034 * (1 - (2 * u - 1) ** 2) * (1 - .55 * t)
        curl = .022 * t ** 2
        return np.array((x, Y + .03 + dish + curl + lift, Z0 + t * LEN + .006 * (1 - (2 * u - 1) ** 2) * t))
    m.surface("steel_bare", blade, 14, 14, (.5, .6), wear=lambda u, v: .28 + .3 * (1 - v) ** 2 * (1 - abs(2 * u - 1)))
    m.surface("steel_bare", lambda u, v: blade(u, v, -.0035), 14, 14, (.5, .6), flip=True, wear=lambda u, v: .45)
    # Turned-over tread, across the top of the blade.
    for sx in (-1, 1):
        m.beam((sx * .022, Y + .021, Z0 + .002), (sx * HALF, Y + .03, Z0 + .002), .024, .007, "steel_bare", up=(0, 1, 0), chamfer=.002)
    # Bright where it has been in the ground.
    m.surface("chrome", lambda u, v: blade(u, .93 + v * .07, .0004), 14, 2, (.5, .05), wear=lambda u, v: .14)
    m.radius = 1
    return m


def bucket():
    m = Model("bucket", tex=1024, seed=207)
    R0, R1, H = .13, .165, .27
    m.lathe([(0, 0), (R0 - .01, 0), (R0, .02), (R1 - .002, .94), (R1 + .004, .97), (R1 + .004, 1), (R1 - .005, 1), (R0 + .002, .05), (0, .05)], (0, 0, 0), (0, H, 0), "galv", 28, wear=.1)
    for y_ in (.7,):
        r_ = R0 + (R1 - R0) * y_
        m.lathe([(r_, 0), (r_ + .003, .5), (r_, 1)], (0, y_ * H - .004, 0), (0, y_ * H + .004, 0), "galv", 28, density=.4, wear=.2)
    for s in (-1, 1):
        m.lathe([(0, 0), (.018, .1), (.018, 1)], (s * (R1 + .002), H - .02, 0), (s * (R1 + .012), H - .02, 0), "steel_bare", 8, density=.4)
    arc = [np.array((-(R1 + .012) * math.cos(a), H - .02 + (R1 + .02) * .95 * math.sin(a), 0)) for a in np.linspace(0, 3.1416, 12)]
    m.tube(arc, .0045, "steel_bare", 5)
    m.lathe([(.012, 0), (.016, .1), (.016, .9), (.012, 1)], (-.055, H - .02 + (R1 + .02) * .95, 0), (.055, H - .02 + (R1 + .02) * .95, 0), "wood_dark", 8, density=.4)
    # Dead leaves and black water.
    m.cyl((0, H * .3, 0), (0, H * .32, 0), R0 + (R1 - R0) * .31, "void", 18)
    m.collide_post(0, 0, 0, 0, .17, 0, H, "bucket")
    return m


def cans():
    m = Model("cans", tex=512, seed=208)
    rng = m.rng
    # Food tins left at a camp: rolled rims, pressed ribs, a lid cut most of the way round and bent back.
    spots = [(.0, 0, 1, .12, True), (.28, .1, 1, .3, False), (-.22, .24, 0, .62, False), (.14, -.32, 0, .4, True), (-.34, -.16, 1, .78, False)]
    for x, z, upright, wear, opened in spots:
        r, h = rng.uniform(.04, .052), rng.uniform(.1, .125)
        a = rng.random() * 6.28
        if upright:
            p0, p1 = np.array((x, 0, z)), np.array((x, h, z))
        else:
            d = np.array((math.cos(a), 0, math.sin(a))) * h
            p0, p1 = np.array((x, r + .004, z)), np.array((x, r + .004, z)) + d
        ribs = []
        for t in (.26, .4, .54, .68):
            ribs += [(r, t - .025), (r - .0022, t), (r, t + .025)]
        top = [(r, .955), (r + .0028, .97), (r + .0028, 1), (r - .0022, 1), (r - .0035, .955)]
        lid = [] if opened else [(0, .955)]
        m.lathe([(0, .03), (r - .006, .03), (r - .004, 0), (r + .0026, 0), (r + .0026, .03), (r, .05)] + ribs + top + lid, p0, p1, "tin", 18, wear=wear)
        if opened:
            axis = (p1 - p0) / np.linalg.norm(p1 - p0)
            side = np.cross(axis, (0, 0, 1) if abs(axis[2]) < .9 else (1, 0, 0))
            side /= np.linalg.norm(side)
            other = np.cross(axis, side)
            hinge = p1 - axis * .003 + side * (r - .003)
            def lid_(u, v, hinge=hinge, side=side, other=other, axis=axis, r=r):
                th, q = u * 6.283, v
                edge = r * .94 * (1 + .025 * math.sin(th * 11) + .015 * math.sin(th * 23))
                lx, ly = -(math.cos(th) * edge * q + r * .94), math.sin(th) * edge * q
                # Bent up and back from the uncut part of the rim.
                lean = 1.2
                return hinge + side * (lx * math.cos(lean)) + axis * (-lx * math.sin(lean)) + other * ly
            m.surface("tin", lid_, 18, 2, (.5, .5), wear=lambda u, v: wear)
        if wear < .5:
            # What is left of the paper label.
            start, span, t0, t1 = rng.uniform(0, 6.28), rng.uniform(1.8, 3.4), rng.uniform(.12, .22), rng.uniform(.74, .86)
            axis = (p1 - p0) / np.linalg.norm(p1 - p0)
            e1 = np.cross(axis, (0, 0, 1) if abs(axis[2]) < .9 else (1, 0, 0))
            e1 /= np.linalg.norm(e1)
            e2 = np.cross(axis, e1)
            def label(u, v, p0=p0, axis=axis, e1=e1, e2=e2, r=r, h=h, start=start, span=span, t0=t0, t1=t1):
                th = start + u * span
                t = t0 + (t1 - t0) * v + .02 * math.sin(u * 19)
                return p0 + axis * (t * h) + (e1 * math.cos(th) + e2 * math.sin(th)) * (r + .0012)
            m.surface("canvas_orange", label, 12, 2, (.3, .2), wear=lambda u, v: .55)
    m.radius = .7
    return m


def bottles():
    m = Model("bottles", tex=512, seed=209)
    prof = [(0, 0), (.032, .0), (.034, .04), (.034, .55), (.026, .68), (.012, .78), (.0115, .94), (.014, .96), (.014, 1), (.009, 1)]
    # One standing, the others emptied and dropped.
    m.lathe(prof, (0, 0, 0), (0, .25, 0), "bottle_green", 12)
    for x, z, a in ((.22, .09, 1.0), (-.19, .16, 3.1), (.05, -.26, 5.0)):
        d = np.array((math.cos(a) * .25, 0, math.sin(a) * .25))
        m.lathe(prof, (x, .034, z), np.array((x, .034, z)) + d, "bottle_brown" if a > 2 else "bottle_green", 12)
    return m


def canline():
    """A trip line strung with tins: somebody out here was trying to hear it coming."""
    m = Model("canline", tex=1024, seed=210)
    L, H = 3.4, 1.05
    for s in (-1, 1):
        m.log((s * L, -.1, 0), (s * L + s * .03, H + .16, 0), .036, "logwood", sides=7, segs=1, caps=(False, True))
        m.lash((s * L, H, 0), (0, 1, 0), .036, turns=3, width=.012)
        m.collide_post(s * L, 0, s * L, 0, .05, 0, H + .1, "stake")
    def wire_y(x):
        return H - .17 * (1 - (x / L) ** 2)
    m.density = .4
    m.tube([(x, wire_y(x), 0) for x in np.linspace(-L, L, 22)], .0068, "canvas", 5)
    m.density = 1
    rng = m.rng
    for x in np.arange(-L + .45, L - .3, .62):
        x_ = x + rng.uniform(-.09, .09)
        drop = rng.uniform(.06, .14)
        y = wire_y(x_)
        z_ = rng.uniform(-.015, .015)
        m.tube([(x_, y, 0), (x_ + .004, y - drop, z_)], .0042, "canvas", 4)
        r, h = rng.uniform(.035, .045), rng.uniform(.085, .11)
        tilt = rng.uniform(-.1, .1)
        m.lathe([(0, 1), (r, 1), (r + .001, .96), (r + .001, .04), (r - .002, 0), (.0, 0)], (x_ + tilt * .02, y - drop, z_), (x_ - tilt * .02, y - drop - h, z_), "tin", 10, wear=.5)
    m.radius = 4
    return m


def totem():
    """Bound sticks, hung at head height on a crossbar, turning slowly. Nobody says who made them."""
    m = Model("totem", tex=1024, seed=211)
    H = 2.75
    for s in (-1, 1):
        m.log((s * .9, -.1, 0), (s * .72, H + .15, 0), .06, "logwood", sides=8, segs=2)
        m.collide_post(s * .9, 0, s * .9, 0, .08, 0, H, "post")
    m.log((-1.05, H, .0), (1.05, H + .05, 0), .05, "logwood", sides=8, segs=2)
    m.lash((-.74, H + .01, 0), (1, 0, 0), .055, turns=4, width=.012)
    m.lash((.74, H + .04, 0), (1, 0, 0), .055, turns=4, width=.012)
    rng = m.rng
    # The figure: limbs of bundled twig, tied where a person would have joints.
    top = np.array((0, H - .03, 0))
    m.tube([top + (0, .02, 0), top + (0, -.46, 0)], .009, "canvas", 6)
    m.lash(top + (0, .012, 0), (1, 0, 0), .055, turns=3, width=.014)
    neck = top + (0, -.46, 0)
    def bundle(a, b, count, spread):
        a, b = np.asarray(a, float), np.asarray(b, float)
        for _ in range(count):
            o0 = np.array((rng.uniform(-spread, spread), 0, rng.uniform(-spread, spread)))
            o1 = np.array((rng.uniform(-spread, spread), rng.uniform(-.03, .03), rng.uniform(-spread, spread)))
            m.log(a + o0, b + o1, rng.uniform(.006, .011), "logwood", sides=5, segs=1, noise=.1, caps=(False, False))
    head_low = neck + (0, -.28, 0)
    bundle(neck, head_low, 11, .05)
    m.lash(neck + (0, -.04, 0), (0, 1, 0), .058, turns=3, width=.01)
    m.lash(head_low + (0, .03, 0), (0, 1, 0), .056, turns=3, width=.01)
    shoulder = head_low + (0, -.03, 0)
    hip = shoulder + (0, -.72, 0)
    bundle(shoulder, hip, 16, .07)
    m.lash(shoulder + (0, -.05, 0), (0, 1, 0), .08, turns=3, width=.01)
    m.lash(hip + (0, .06, 0), (0, 1, 0), .075, turns=3, width=.01)
    for s in (-1, 1):
        elbow = shoulder + (s * .34, -.2, .04)
        wrist = elbow + (s * .1, -.44, -.05)
        bundle(shoulder + (0, -.1, 0), elbow, 6, .02)
        bundle(elbow, wrist, 5, .018)
        m.lash(elbow, (s * .6, -.5, .1), .03, turns=2, width=.009)
        for k in range(3):
            m.log(wrist, wrist + (s * rng.uniform(.02, .08), -rng.uniform(.14, .24), rng.uniform(-.05, .05)), .004, "logwood", sides=4, segs=1, caps=(False, False))
        knee = hip + (s * .13, -.36, .03)
        foot = knee + (s * .03, -.4, 0)
        bundle(hip + (0, .03, 0), knee, 7, .024)
        bundle(knee, foot, 5, .02)
        m.lash(knee, (0, 1, .1), .036, turns=2, width=.009)
    # A tin with two holes punched in it, for a face. It clinks.
    c = neck + (0, -.19, .09)
    m.lathe([(0, 0), (.06, .02), (.06, .98), (0, 1)], c + (0, -.09, 0), c + (0, .09, 0), "tin", 14, wear=.55)
    for s in (-1, 1):
        m.cyl(c + (s * .022, .02, .054), c + (s * .022, .02, .0622), .012, "void", 8)
    m.radius = 2
    return m


def trailmarker():
    poster_material("sign_trail", os.path.join(ART, "sign_trail.png"))
    m = Model("trailmarker", tex=512, seed=212)
    m.log((.0, -.15, 0), (.035, 1.32, 0), .05, "logwood", sides=13, segs=3, noise=.05, taper=.18)
    m.poster("sign_trail", (.015, 1.08, .0525), (1, 0, 0), (0, 1, 0), .085, .17, density=5)
    m.collide_post(0, 0, 0, 0, .06, 0, 1.3, "waymark")
    m.radius = .7
    return m


def cairn():
    """Flat stones piled by someone wanting to find the way back. Each sits on the one below."""
    m = Model("cairn", tex=1024, seed=213)
    rng = m.rng
    y = .0
    width = .62
    for layer in range(7):
        h = rng.uniform(.07, .11)
        off = (rng.uniform(-.03, .03), rng.uniform(-.03, .03))
        def stone(u, v, off=off, y=y, h=h, width=width, phase=rng.random() * 9, squash=rng.uniform(.62, .95), tip=rng.uniform(-.09, .09)):
            th, ph = u * 6.283, v * 3.1416
            lobes = 1 + .16 * math.sin(th * 2 + phase) + .09 * math.sin(th * 3 + phase * 2.3) + .045 * math.sin(th * 7 + phase * .7) + .024 * math.sin(th * 13 + phase)
            # Flat-bedded: nearly level top and bottom, with the bulk carried to the edge.
            c = math.cos(ph)
            lift = .5 - .5 * math.copysign(abs(c) ** .55, c)
            round_ = math.sin(ph) ** .62
            px, pz = math.cos(th) * round_ * width * .5 * lobes, math.sin(th) * round_ * width * .5 * squash * lobes
            return np.array((off[0] + px, y + h * lift * (1 + .12 * math.sin(th * 3 + phase)) + tip * px, off[1] + pz))
        m.surface("stone", stone, 20, 8, (1.6, .6), flip=True, wear=lambda u, v: .3)
        y += h * .9
        width *= rng.uniform(.74, .86)
    m.collide_post(0, 0, 0, 0, .3, 0, y, "cairn")
    m.radius = .8
    return m


def mailbox():
    m = Model("mailbox", tex=512, seed=214)
    m.beam((0, -.15, 0), (0, 1.02, 0), .09, .09, "wood_dark", chamfer=.012)
    m.beam((-.03, 1.03, -.26), (-.03, 1.03, .28), .1, .03, "wood", chamfer=.006)
    # The arched box in one rolled sheet, its door hanging down.
    L, W = .46, .085
    def box_arch(u, v):
        th = u * math.pi
        x = math.cos(th) * W
        y = 1.05 + (math.sin(th) * W * .95 if True else 0) + .07
        z = -.22 + v * L
        return np.array((x - .03, y, z))
    m.surface("olive", box_arch, 14, 3, (1.2, 1.0), flip=True, wear=lambda u, v: v * .4)
    for s in (-1, 1):
        m.box((s * W - .03, 1.085, .01), (.004, .07, L), "olive", chamfer=.001)
    m.box((-.03, 1.052, .01), (2 * W, .004, L), "olive", chamfer=.001)
    m.box((-.03, 1.09, -.22), (2 * W, .14, .004), "olive", chamfer=.001)
    m.box((-.03, 1.03, .285), (2 * W - .01, .15, .004), "olive", chamfer=.001)
    m.cyl((-.03, 1.05, .25), (-.03, 1.05, .29), .003, "steel_bare", 5)
    m.box((W - .03 + .01, 1.16, -.05), (.003, .12, .035), "red", chamfer=.0008)
    m.collide_post(0, 0, 0, 0, .07, 0, 1.2, "mailbox")
    m.radius = .7
    return m


RAIL_Y, RAIL_HALF, RAIL_RIB = .62, .155, .042


def _rail_profile(v):
    """A W-beam, in section: two ribs towards the road with a valley between them."""
    t = v * 2 - 1
    return (t * RAIL_HALF, RAIL_RIB * math.sin(math.pi * t) ** 2)


def _rail_sheet(m, line, nu, mirror=False, lap=0.0):
    """Both faces of one panel. line(u) gives its (x, y, z) reference point."""
    def at(u, v, back):
        x, y, z = line(u)
        dy, dz = _rail_profile(v)
        return np.array((x, y + dy, z + dz + lap - (.0035 if back else 0)))
    length = abs(line(1)[0] - line(0)[0])
    wear = lambda u, v: .06 + .2 * (1 - v) ** 3
    m.surface("galv", lambda u, v: at(u, v, False), nu, 10, (length * 1.5, .6), flip=mirror, wear=wear)
    m.surface("galv", lambda u, v: at(u, v, True), nu, 10, (length * 1.5, .6), flip=not mirror, wear=wear)


def _rail_post(m, x, top, z=0.0):
    """A driven steel post carried behind the beam on a timber spacer block."""
    m.beam((x, -.38, z - .19), (x, top, z - .19), .105, .145, "galv", chamfer=.006, up=(0, 0, 1))
    m.box((x, RAIL_Y if top > .6 else top - .13, z - .068), (.1, .2, .15), "wood_dark", chamfer=.008)
    m.bolt((x, RAIL_Y if top > .6 else top - .13, z + .008), (0, 0, 1), .014, "steel_bare")
    m.collide_post(x, z - .19, x, z - .19, .09, 0, top, "guard post")


def guardrail():
    """7.8 m of W-beam, two lapped panels on four posts. Lengths butt end to end along the road."""
    m = Model("guardrail", tex=1024, seed=215)
    L = 3.9
    for x in (-2.925, -.975, .975, 2.925):
        _rail_post(m, x, .74)
    # The panels lap at the middle, the road-side one running on over the other.
    # Each length also runs on 12 cm past its last post-bay, so it laps the next one and the join stays closed round a bend.
    _rail_sheet(m, lambda u: (-L - .12 + (L + .28) * u, RAIL_Y, 0.0), 4)
    _rail_sheet(m, lambda u: (-.16 + (L + .28) * u, RAIL_Y, 0.0), 4, lap=.0045)
    for x in (-.08, .08):
        for dy in (-.11, -.05, .05, .11):
            m.bolt((x, RAIL_Y + dy, .0045 + _rail_profile(.5 + dy / (2 * RAIL_HALF))[1]), (0, 0, 1), .0085, "steel_bare")
    m.collide_box(0, -.0, L, .07, .4, .78, tag="guard rail")
    m.radius = 4.6
    return m


def _guard_end(name, mirror):
    """The last length: the rail swings away from the road and is carried down into the ground, so it has no end to hit."""
    m = Model(name, tex=1024, seed=216 + int(mirror))
    L, sgn = 3.9, -1 if mirror else 1
    def bend(u):
        t = min(1.0, max(0.0, (u - .55) / .45))
        ramp = t * t * (3 - 2 * t)
        return RAIL_Y - 1.02 * ramp, -.62 * t ** 1.6
    def line(u):
        y, z = bend(u)
        return (sgn * (-L + 2 * L * u), y, z)
    _rail_sheet(m, line, 22, mirror=mirror)
    for x in (-2.925, -.975):
        _rail_post(m, sgn * x, .74)
    # Posts get shorter as the rail comes down to meet them.
    for x in (.975, 2.0):
        u = (x + L) / (2 * L)
        y, z = bend(u)
        _rail_post(m, sgn * x, max(.2, y + .13), z)
    m.collide_box(sgn * -1.3, 0, 2.6, .07, .4, .78, tag="guard rail")
    m.radius = 4.6
    return m


def guardrail_end():
    return _guard_end("guardrail_end", False)


def guardrail_endr():
    return _guard_end("guardrail_endr", True)


def fence():
    m = Model("fence", tex=1024, seed=216)
    L = 2.0
    rng = m.rng
    for x in (-L, L):
        lean = rng.uniform(-.04, .04)
        m.log((x, -.15, 0), (x + lean, 1.25, .02), .07, "logwood", sides=8, segs=1, noise=.06)
        m.collide_post(x, 0, x, 0, .09, 0, 1.25, "fence post")
    m.log((-L - .35, 1.05, .08), (L + .4, 1.0, .07), .05, "logwood", sides=7, segs=2, noise=.05)
    m.log((-L - .3, .68, .08), (L + .32, .61, .08), .05, "logwood", sides=7, segs=2, noise=.05)
    # The bottom rail has dropped at one end.
    m.log((-L - .28, .3, .07), (L - .2, .04, .13), .045, "logwood", sides=7, segs=2, noise=.05)
    for x, y in ((-L, 1.05), (L, 1.01), (-L, .68), (L, .615), (-L, .29)):
        m.lash((x, y, .04), (0, 1, 0), .075, turns=3, width=.012)
    m.collide_box(0, .08, L, .05, 0, 1.1, tag="fence rail")
    m.radius = 3
    return m


def chair():
    """A kitchen chair knocked on its back. Its frame is mortised, one rung is out."""
    m = Model("chair", tex=1024, seed=217)
    # Authored lying on its back: seat vertical, back legs on the ground.
    W = .19
    def p(x, y, z):
        return np.array((x, z + .42 - .0, -y + .05 - .0)) if False else np.array((x, .04 + z * .0 + (y if False else 0.0) + z, y))
    # Local chair coordinates (x across, y up the chair, z front) mapped so the back lies on the ground.
    def to_world(x, y, z):
        return np.array((x, .03 + z + .22, -y + .4))
    for s in (-1, 1):
        m.beam(to_world(s * W, 0, -.2), to_world(s * W, .9, -.25), .042, .042, "wood_dark", chamfer=.006, up=(0, 1, 0))
        m.beam(to_world(s * W, 0, .2), to_world(s * W, .43, .2), .042, .042, "wood_dark", chamfer=.006, up=(0, 1, 0))
        m.beam(to_world(s * W, .22, -.2), to_world(s * W, .22, .2), .028, .028, "wood_dark", chamfer=.004, up=(0, 1, 0))
        m.bolt(to_world(s * (W + .021), .22, .2), (s, 0, 0), .006, "wood_clean")
        m.bolt(to_world(s * (W + .021), .22, -.2), (s, 0, 0), .006, "wood_clean")
    for i in range(5):
        x = -W + .04 + i * (2 * W - .08) / 4
        z_ = .2 - .02 * i * 0
        m.plank(to_world(-W - .02, .45, x * 1.12), to_world(W + .02, .45, x * 1.12), .1, .026, up=(0, 0, -1), mat="wood", warp=.002, segs=1)
    for y_, tall in ((.6, .07), (.74, .07), (.87, .1)):
        back_z = -.2 - .05 * y_ / .9
        m.beam(to_world(-W, y_, back_z), to_world(W, y_, back_z), tall, .022, "wood", chamfer=.005, up=(0, 1, 0))
    m.beam(to_world(-W, .22, .0), to_world(W, .22, .0), .02, .02, "wood_dark", chamfer=.004, up=(0, 1, 0))
    m.collide_box(0, -.1, .25, .5, 0, .5, tag="chair")
    m.radius = 1
    return m


def toolbox():
    m = Model("toolbox", tex=512, seed=218)
    L, W, H = .26, .11, .17
    m.box((0, H / 2 + .005, 0), (2 * L, H, 2 * W), "red", chamfer=.008)
    # A folded tray lid on a piano hinge, two latches and a handle on stirrups.
    m.box((0, H + .022, 0), (2 * L + .008, .034, 2 * W + .008), "red", chamfer=.007)
    m.box((0, H + .046, 0), (2 * L - .05, .016, 2 * W - .05), "red", chamfer=.006)
    m.beam((-L, H + .01, -W - .002), (L, H + .01, -W - .002), .012, .01, "steel_bare", up=(0, 1, 0), chamfer=.002)
    for s in (-1, 1):
        m.box((s * .14, H - .01, W + .003), (.03, .05, .006), "steel_bare", chamfer=.002)
        m.tube([(s * .08, H + .05, 0), (s * .08, H + .11, 0)], .005, "steel_bare", 5)
    m.tube([(-.08, H + .11, 0), (.08, H + .11, 0)], .011, "rubber", 8)
    # A wrench left on the lid, a screwdriver by it.
    m.beam((-.16, H + .067, -.02), (.0, H + .067, .03), .014, .005, "steel_bare", up=(0, 1, 0), chamfer=.0012)
    m.collide_box(0, 0, L + .01, W + .01, 0, H + .1, tag="toolbox")
    return m


def firewood():
    m = Model("firewood", tex=1024, seed=219)
    rng = m.rng
    # Split rounds racked between two end stakes, a sheet of rusted tin laid over the top.
    for layer in range(5):
        for i in range(10 - layer):
            x = -.85 + (i + .5 * layer) * .18
            y = .08 + layer * .135
            r = rng.uniform(.062, .1)
            z0 = rng.uniform(-.31, -.2)
            m.log((x, y, z0), (x + rng.uniform(-.02, .02), y, z0 + rng.uniform(.42, .58)), r, "bark", "endgrain", sides=9, segs=1, noise=.13)
    for s in (-1, 1):
        m.log((s * .98, -.1, 0), (s * 1.0, .85, 0), .04, "logwood", sides=7, segs=1)
    def cover(u, v):
        return np.array(((u - .5) * 2.1, .735 + .05 * math.sin(u * 3.14) + .012 * math.sin(v * 6.283 * 9), (v - .5) * .78))
    m.surface("tin", cover, 8, 28, (3.6, 1.3), wear=lambda u, v: .25 + .5 * (2 * abs(u - .5)) ** 3)
    for x_ in (-.98, 1.0):
        m.bolt((x_, .755, 0), (0, 1, 0), .012, "steel")
    for x in (-.55, .4):
        m.lathe([(.0, 1), (.08, .95), (.1, .3), (.08, 0)], (x, .76, .0), (x, .9, 0), "stone", 7, density=.5)
    m.collide_box(0, 0, 1.05, .32, 0, .9, tag="firewood")
    m.radius = 1.5
    return m


def stump_axe():
    """A felling axe left sunk in the chopping stump: forged wedge head, hung on a curved ash haft."""
    m = Model("stump_axe", tex=1024, seed=220)
    h = .62
    def smooth(x, lo, hi):
        t = min(1.0, max(0.0, (x - lo) / (hi - lo)))
        return t * t * (3 - 2 * t)

    ROOTS = [(.5, .42, .36), (1.75, .3, .3), (2.9, .46, .4), (4.05, .26, .3), (5.2, .4, .36)]
    def wall(u, v):
        th = -2 * math.pi * u
        y = -.22 + (h + .22) * v
        fall = (1 - smooth(y, -.04, .36)) ** 2
        lobe = 0.0
        for at, size, width in ROOTS:
            d = (th - (-at) + math.pi) % (2 * math.pi) - math.pi
            lobe = max(lobe, size * math.exp(-(d / width) ** 2))
        bumps = (.012 * math.sin(th * 5 + 1) + .008 * math.sin(th * 11 + y * 4)) * (1 - smooth(v, .86, 1))
        r = .3 + bumps + fall * (.05 + lobe)
        return np.array((math.cos(th) * r, y, math.sin(th) * r))
    m.surface("bark", wall, 44, 8, (3.2, 1.8), wear=lambda u, v: .22 + .5 * (1 - v) ** 2, metres_per_uv=.5)
    # The sawn top, cut clean.
    m.log((0, h - .05, 0), (0, h, 0), .302, "bark", "endgrain", sides=28, segs=1, noise=0, taper=0, caps=(False, True))

    def unit(v):
        v = np.array(v, float)
        return v / np.linalg.norm(v)

    # H runs up the haft from the head, B from the eye out to the cutting edge, T through the cheeks.
    az, lift = .32, math.radians(42)
    H = np.array((math.cos(lift) * math.cos(az), math.sin(lift), math.cos(lift) * math.sin(az)))
    B = unit(np.array((0, -1, 0)) + H * H[1])
    T = unit(np.cross(H, B))
    REACH = .152
    bite = np.array((-.075, h - .036, -.02))     # where the middle of the edge has got to, inside the wood
    C = bite - B * REACH

    POLL = -.058
    def thickness(b):
        """Half the head's width at distance b from the eye: cheeks swell round the eye, then run down to a bevel."""
        pts = np.array([POLL, -.036, -.018, .018, .05, .082, .132, REACH])
        val = np.array([.026, .0295, .0315, .0315, .0225, .0125, .0048, .0007])
        return (np.interp(b - .006, pts, val) + np.interp(b, pts, val) + np.interp(b + .006, pts, val)) / 3

    def head(u, v):
        """u from the poll to the edge, v round the section, seam on the top rim."""
        cap = smooth(u, 0, .05)
        s = max(0.0, (u - .05) / .95)
        b = POLL + (REACH - POLL) * s
        ear = .013 * math.exp(-(b / .023) ** 2)
        k = max(0.0, (b - .04) / (REACH - .04))
        up = .0415 + ear + .040 * k ** 1.9
        dn = .0415 + ear + .058 * k ** 1.55
        th = math.pi / 2 - 2 * math.pi * v
        cs, sn = math.cos(th), math.sin(th)
        n = 6.0
        ax, ay = math.copysign(abs(cs) ** (2 / n), cs), math.copysign(abs(sn) ** (2 / n), sn)
        # The edge is a shallow arc, not a straight cut.
        along = ay * (up if ay > 0 else dn)
        arc = -.013 * (along / .09) ** 2 * s ** 5
        return C + B * (b + arc) + H * along * cap + T * thickness(b) * ax * cap

    m.surface("steel_bare", lambda u, v: head(u * .9, v), 14, 20, (.42, .3), wear=lambda u, v: .1 + .2 * (1 - u) ** 2, metres_per_uv=.25, density=2.2)
    # The last 1.5 cm is ground bright; nothing else on the head has been cared for.
    m.surface("chrome", lambda u, v: head(.9 + u * .1, v), 3, 20, (.05, .3), wear=lambda u, v: .1, metres_per_uv=.2, density=2.2)

    # Haft: oval, swelled at the shoulder, waisted, with the bow and the fawn-foot kick of a hand-shaped handle.
    LEN = .885
    TIP = -.052
    def spine(s):
        bow = .017 * math.sin(math.pi * min(1.0, s / .86)) - .024 * smooth(s, .86, 1.0)
        return C + H * (TIP + LEN * s) + B * bow

    def haft_section(s):
        pts = [0, .035, .11, .3, .62, .84, .95, 1]
        wid = [.0215, .0222, .0268, .0212, .0198, .0242, .0322, .031]
        thk = [.0142, .0148, .0176, .0146, .0142, .0168, .0186, .018]
        return np.interp(s, pts, wid), np.interp(s, pts, thk)

    def haft(u, v):
        """u round the section, v up the handle, so the grain runs the length of it."""
        close = smooth(v, 0, .012) * (1 - smooth(v, .992, 1))
        hb, ht = haft_section(v)
        phi = 2 * math.pi * u
        return spine(v) + (B * hb * math.cos(phi) + T * ht * math.sin(phi)) * max(close, .001)

    # Pale at the head, dark and polished where hands have held it.
    m.surface("wood_fresh", haft, 10, 28, (.2, 1.78), wear=lambda u, v: .16 + .5 * smooth(v, .55, .92), metres_per_uv=.5, density=1.6)

    # Seated by a wooden wedge driven down the eye, with a steel cross-wedge over it.
    top = C + H * TIP
    m.beam(top - B * .0185 - H * .001, top + B * .0185 - H * .001, .0052, .004, "wood_dark", up=tuple(H), chamfer=.0008)
    m.beam(top - T * .0115 - H * .002, top + T * .0115 - H * .002, .0044, .0034, "steel_bare", up=tuple(H), chamfer=.0008)

    # Where the bit went in: the grain has opened along the cut.
    run = unit(np.cross(B, (0, 1, 0)) * -1 if np.linalg.norm(np.cross(B, (0, 1, 0))) > .01 else T)
    entry = bite + (0, h + .002 - bite[1], 0)
    def split(sign, length, wide):
        start = entry + T * 0 + H * np.array((1, 0, 1)) * sign * 0
        path = [start + np.array((T[0], 0, T[2])) * sign * .004 + np.array((H[0], 0, H[2])) * sign * .08 * t + np.array((-H[2], 0, H[0])) * sign * .012 * t * t for t in (0, .5, 1, 1.5, length / .08)]
        for i in range(len(path) - 1):
            w = wide * (1 - i / (len(path) - 1))
            m.beam(path[i], path[i + 1], w, .004, "char", up=(0, 1, 0), chamfer=.0005)
    split(1, .17, .0055)
    split(-1, .12, .005)
    # The groove the edge cut, either side of the steel.
    m.beam(entry - np.array((H[0], 0, H[2])) * .09, entry + np.array((H[0], 0, H[2])) * .075, .012, .004, "char", up=(0, 1, 0), chamfer=.0006)

    # A few long splinters where it was last used.
    rng = np.random.default_rng(220)
    for i in range(3):
        a, r = rng.uniform(.4, 2.6), rng.uniform(.1, .24)
        size = rng.uniform(.012, .02)
        m.box((math.cos(a) * r, h + .004, math.sin(a) * r), (size * 4.2, .005, size), "wood_fresh", yaw=rng.uniform(0, 3.14), chamfer=.001)
    m.collide_post(0, 0, 0, 0, .34, 0, h, "stump")
    m.radius = 1.1
    return m


def antler_post():
    m = Model("antler_post", tex=1024, seed=221)
    H = 1.9
    m.log((0, -.2, 0), (.03, H, 0), .08, "logwood", sides=9, segs=2, noise=.05, taper=.12)
    def beam(side):
        pts = [np.array((.0, H - .22, .07)), np.array((side * .2, H - .08, .13)), np.array((side * .34, H + .2, .11)), np.array((side * .29, H + .46, .03))]
        radii = (.021, .017, .013, .004)
        for i in range(3):
            m.lathe([(radii[i], 0), (radii[i + 1], 1)], pts[i], pts[i + 1], "ceramic", 7, wear=.75)
        m.lathe([(.016, 0), (.029, .25), (.029, .7), (.02, 1)], pts[0] - (pts[1] - pts[0]) * .05, pts[0] + (pts[1] - pts[0]) * .14, "ceramic", 9, wear=.9)
        for t, tl, dz in ((1, .2, .12), (2, .24, .1), (2, .15, -.08)):
            base = pts[t] * .6 + pts[min(t + 1, 3)] * .4
            m.lathe([(.012, 0), (.006, .7), (0.0, 1)], base, base + (side * .06, tl, dz), "ceramic", 6, wear=.75)
    beam(1)
    beam(-1)
    m.box((.0, H - .22, .082), (.13, .1, .02), "ceramic", chamfer=.012)
    m.bolt((0, H - .22, .094), (0, 0, 1), .01, "steel_bare")
    m.collide_post(0, 0, 0, 0, .09, 0, H, "antler post")
    m.radius = 1
    return m


ASSETS = {n: (f, None) for n, f in dict(
    outhouse=outhouse, door_privy=door_privy, picnic_table=picnic_table, sawhorse=sawhorse, pallet=pallet, wheelbarrow=wheelbarrow, shovel=shovel,
    bucket=bucket, cans=cans, bottles=bottles, canline=canline, totem=totem, trailmarker=trailmarker, cairn=cairn, mailbox=mailbox,
    guardrail=guardrail, guardrail_end=guardrail_end, guardrail_endr=guardrail_endr, fence=fence, chair=chair, toolbox=toolbox, firewood=firewood, stump_axe=stump_axe, antler_post=antler_post,
).items()}
