"""The landing pad and its parts: the helicopter's way out (docs/game-design.md, "Four ways out").

helipad: a 12 m concrete slab in a clearing, its ring and H painted on top (art_pad.py), eight edge lights standing empty (the
bulbs are a part the player brings), a conduit joining them to a junction box with the switch, a windsock and a keep-out board.
Hooks: light0..light7 (where a fitted bulb sits; the game lights them), switch (the lever), cable_in (where the cable from the
pad's generator plugs in), sock (the windsock's top, for the game to stir it).
bulbs: a box of spare bulbs. cable_coil: a coil of rubber cable with its plug: both small parts, carried in the pack.
"""
import math
import os

import numpy as np

from kit import ROOT, Model, poster_material, norm

ART = os.path.join(ROOT, "assets/world-v2/art")

SLAB, TOP = 6.0, .18          # half the slab's side, and its top above the ground
LIGHT_R = 6.45                # edge lights stand just off the slab
LIGHTS = [(LIGHT_R * math.cos(a), LIGHT_R * math.sin(a)) for a in np.arange(8) * math.pi / 4]
LIGHTS = [(x / max(abs(x), abs(z)) * LIGHT_R if max(abs(x), abs(z)) else x, z / max(abs(x), abs(z)) * LIGHT_R) for x, z in LIGHTS]
BOX = np.array((7.3, 0, 1.6))  # the junction box, on the east side


def helipad():
    poster_material("helipad_top", os.path.join(ART, "helipad_top.png"))
    poster_material("board_keepout", os.path.join(ART, "board_keepout.png"))
    m = Model("helipad", tex=2048, seed=501)
    # The slab, cast in one, set a little into the ground, its top painted.
    m.box((0, TOP / 2 - .06, 0), (SLAB * 2, TOP + .12, SLAB * 2), "concrete", chamfer=.03)
    m.poster("helipad_top", (0, TOP + .002, 0), (1, 0, 0), (0, 0, -1), SLAB * 2 - .06, SLAB * 2 - .06, density=1.0)
    m.collide_box(0, 0, SLAB, SLAB, -.1, TOP, tag="landing pad")
    # Edge lights: a short steel post, a cage over an empty socket. Fitted, a bulb sits at the hook.
    for i, (x, z) in enumerate(LIGHTS):
        m.cyl((x, -.05, z), (x, .36, z), .028, "steel", 10)
        m.cyl((x, .34, z), (x, .4, z), .055, "olive", 14)                         # housing
        m.cyl((x, .4, z), (x, .43, z), .018, "brass", 10)                          # the socket, waiting for a bulb
        for a in np.arange(4) * math.pi / 2 + math.pi / 4:
            m.tube([(x + math.cos(a) * .05, .4, z + math.sin(a) * .05), (x + math.cos(a) * .045, .5, z + math.sin(a) * .045), (x, .53, z)], .0035, "steel", 5)
        m.cyl((x, .52, z), (x, .535, z), .012, "steel", 8)
        m.hook(f"light{i}", (x, .45, z))
        m.collide_post(x, z, x, z, .06, 0, .55, "pad light")
    # Conduit: a steel pipe on short stakes round the slab, from light to light and out to the junction box.
    ring = LIGHTS + [LIGHTS[0]]
    for (ax, az), (bx, bz) in zip(ring, ring[1:]):
        m.tube([(ax, .04, az), (bx, .04, bz)], .012, "galv", 6)
    for x, z in LIGHTS:
        m.tube([(x, .04, z), (x, .1, z)], .012, "galv", 6)
    east = LIGHTS[0]
    m.tube([(east[0], .04, east[1]), (BOX[0], .04, east[1] + .3), (BOX[0], .04, BOX[2]), (BOX[0], .35, BOX[2])], .014, "galv", 6)
    for t in np.linspace(.08, .92, 18):
        a, b = ring[int(t * 8)], ring[int(t * 8) + 1]
        f = t * 8 % 1
        p = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
        m.box((p[0], .02, p[1]), (.03, .06, .03), "steel_bare", chamfer=.004)
    # Junction box on a post: the lever switches the ring on; the cable from the generator plugs in underneath.
    m.cyl(BOX + np.array((0, -.1, -.12)), BOX + np.array((0, 1.0, -.12)), .035, "galv", 10)
    m.box(BOX + np.array((0, .78, 0)), (.32, .42, .16), "olive", chamfer=.012)
    m.box(BOX + np.array((0, .78, .082)), (.28, .36, .01), "olive", chamfer=.004)
    lever = BOX + np.array((.1, .82, .1))
    m.cyl(lever - np.array((0, 0, .02)), lever + np.array((0, 0, .015)), .02, "steel_bare", 10)
    m.beam(lever + np.array((0, 0, .015)), lever + np.array((0, .1, .04)), .014, .014, "red", chamfer=.003)
    m.cyl(BOX + np.array((-.08, .57, .0)), BOX + np.array((-.08, .52, .0)), .022, "rubber", 10)    # the socket for the cable
    m.hook("switch", lever + np.array((0, .1, .04)))
    m.hook("cable_in", BOX + np.array((-.08, .5, 0)))
    m.collide_post(BOX[0], BOX[2] - .12, BOX[0], BOX[2] - .12, .1, 0, 1.0, "pad switch")
    # Windsock: a pole with a ring at its head, the sock hanging half full off it.
    pole = np.array((-7.6, 0, -6.4))
    m.cyl(pole + np.array((0, -.2, 0)), pole + np.array((0, 5.2, 0)), .045, "white_mast", 12)
    for k in range(3):
        m.tube([pole + np.array((0, .3 + k * 1.6, 0)), pole + np.array((math.cos(k * 2.1) * .9, -.05, math.sin(k * 2.1) * .9))], .004, "steel_bare", 4)
    head = pole + np.array((0, 5.1, 0))
    wind = norm(np.array((.85, -.35, .4)))
    m.tube([head + np.array((.25 * math.cos(a), 0, .25 * math.sin(a))) for a in np.linspace(0, 2 * math.pi, 17)], .01, "steel", 5)
    m.lathe([(.25, 0), (.24, .15), (.2, .45), (.15, .75), (.11, 1)], head, head + wind * 1.8, "canvas_orange", 16)
    m.hook("sock", head)
    m.collide_post(pole[0], pole[2], pole[0], pole[2], .08, 0, 5.2, "windsock")
    # A keep-out board at the path's end of the clearing.
    sign = np.array((0, 0, 8.2))
    for x in (-.45, .45):
        m.beam(sign + np.array((x, -.2, 0)), sign + np.array((x, 1.5, 0)), .07, .07, "wood_dark")
    m.box(sign + np.array((0, 1.15, .045)), (1.1, .62, .025), "white_paint", chamfer=.005)
    m.poster("board_keepout", sign + np.array((0, 1.15, .059)), (1, 0, 0), (0, 1, 0), 1.0, .54)
    m.collide_box(sign[0], sign[2], .55, .06, 0, 1.5, tag="sign")
    m.radius = 11
    return m


def bulbs():
    """A cardboard box of spare lamp bulbs, the lid folded back, three bulbs in their sleeves."""
    m = Model("bulbs", tex=1024, seed=502)
    W, D, H = .2, .14, .1
    m.box((0, H / 2, 0), (W, H, D), "paper_label", chamfer=.004)
    m.box((0, H + .002, -D / 2 - .05), (W, .004, .1), "paper_label", chamfer=.002)       # the open lid, laid back
    for i, x in enumerate((-.06, 0, .06)):
        base = np.array((x, H - .02, .0))
        m.cyl(base, base + np.array((0, .03, 0)), .011, "brass", 12)
        m.lathe([(.008, 0), (.018, .25), (.03, .6), (.028, .85), (.015, .97), (0, 1)], base + np.array((0, .03, 0)), base + np.array((0, .095, 0)), "glass", 18)
    m.radius = .2
    return m


def cable_coil():
    """Twenty metres of rubber cable, coiled and tied, its plug hanging off."""
    m = Model("cable_coil", tex=1024, seed=503)
    turns, R, r = 7, .17, .011
    pts = []
    for t in np.linspace(0, turns * 2 * math.pi, turns * 24):
        k = t / (turns * 2 * math.pi)
        pts.append(np.array((math.cos(t) * (R + .012 * math.sin(t * 3.3)), .012 + k * .05 + .008 * math.sin(t * 1.7), math.sin(t) * (R + .012 * math.sin(t * 3.3)))))
    m.tube(pts, r, "rubber", 8)
    end = pts[-1]
    tail = [end, end + np.array((.06, -.01, .03)), end + np.array((.13, -.04, .05)), end + np.array((.18, -.05, .04))]
    m.tube(tail, r, "rubber", 8)
    plug = tail[-1]
    m.box(plug + np.array((.035, .0, 0)), (.06, .035, .035), "rubber", chamfer=.006)
    for z in (-.008, .008):
        m.cyl(plug + np.array((.065, 0, z)), plug + np.array((.085, 0, z)), .0025, "brass", 6)
    for a in (0, 2.1, 4.2):   # ties
        c = np.array((math.cos(a) * R, .04, math.sin(a) * R))
        m.lash(c, np.array((-math.sin(a), 0, math.cos(a))), r * 2.6, turns=3, width=.012, mat="canvas")
    m.radius = .3
    return m


ASSETS = {"helipad": (helipad, None), "bulbs": (bulbs, None), "cable_coil": (cable_coil, None)}
