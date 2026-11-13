"""The road bridge over the stream, rebuilt for the shared material library (tiled.py): the one piece of real engineering anyone
ever paid for out here, built in the sixties and left to the weather since.

A cast concrete deck with raised edge beams rides on four riveted steel plate girders (stiffened, spliced, cross-braced), which
bear on steel bearings over two-column concrete piers in the banks and on board-marked concrete abutments at each lip of the
gorge, whose wing walls are faced in fieldstone. Drains run out through the edge beams and down. The road itself is not part of
the model up close: the game draws it over the deck with the ground's own road (terrain.ts), so it runs on from the approaches
without a seam; the deck's own concrete shows only at its edges and from afar. Steel expansion joints cross the road at both ends.

Origin is the middle of the deck surface; the deck runs along local X. What the game relies on stays where it was: the deck's
top at y = 0 and its collider, the rail beam's face 4.2 m out (world-layout.ts BRIDGE_RAIL, where the approach rails take over
2.9 m past each end of the deck), the piers in the banks at x = +-6.2 and the abutments at the gorge's lips.
"""
import numpy as np

import parts_hq as hq
from kit import Model

L = 16.2                # half the deck's length (world-layout.ts BRIDGE_HALF_SPAN)
RAIL = 4.2              # the rail beam's face, out from the middle (world-layout.ts BRIDGE_RAIL)
INNER = 4.1             # the carriageway between the edge beams (the game's road strip covers +-4.1)
EDGE = .62              # width of each edge beam
KERB = .16              # its top stands this far over the deck
SLAB = .3               # deck slab thickness
DROP = 16.0             # footings this far down, buried in the bed and the banks
GIRDERS = (-3.15, -1.05, 1.05, 3.15)
FLANGE_T, FLANGE_W, BOTTOM_W, WEB_T, DEPTH = .03, .34, .38, .016, 1.06
G_TOP = -SLAB                          # the girders' top flange meets the slab's underside
G_BOTTOM = G_TOP - DEPTH               # the underside of their bottom flange
BEARING = .09
CAP_TOP = G_BOTTOM - BEARING           # piers' and abutments' bearing seats
PIERS = (-6.2, 6.2)
ABUT_FACE, ABUT_BACK = 14.25, 15.75    # an abutment's face to the gorge and its back, |x|
GIRDER_END = 15.15


def girder(m, z, rng):
    """One riveted plate girder from abutment to abutment: flanges, web, stiffener pairs every 1.5 m, two bolted splices."""
    x0, x1 = -GIRDER_END, GIRDER_END
    yt, yb = G_TOP - FLANGE_T / 2, G_BOTTOM + FLANGE_T / 2
    m.box((0, yt, z), (x1 - x0, FLANGE_T, FLANGE_W), "girder", chamfer=.004)
    m.box((0, yb, z), (x1 - x0, FLANGE_T + .006, BOTTOM_W), "girder", chamfer=.004)
    web_h = DEPTH - 2 * FLANGE_T
    m.box((0, (G_TOP + G_BOTTOM) / 2, z), (x1 - x0, web_h, WEB_T), "girder", chamfer=.002)
    for x in np.arange(x0 + .4, x1 - .2, 1.5):
        for side in (-1, 1):
            # A stiffener stands on the web from flange to flange; the plates are 12 mm, set back from the flanges' edges.
            m.box((x, (G_TOP + G_BOTTOM) / 2, z + side * (WEB_T / 2 + .055)), (.014, web_h, .11), "girder", chamfer=.002)
    for xs in (-3.1, 3.1):
        for side in (-1, 1):
            zf = z + side * (WEB_T / 2 + .006)
            m.box((xs, (G_TOP + G_BOTTOM) / 2, zf), (.62, web_h * .86, .012), "girder", chamfer=.002)
            for bx in np.arange(xs - .26, xs + .27, .13):
                for by in np.linspace(G_BOTTOM + .14, G_TOP - .14, 7):
                    m.bolt((bx, by, zf + side * .006), (0, 0, side), .013, "steel_bare")
        m.box((xs, yb - .02, z), (.62, .012, BOTTOM_W * .92), "girder", chamfer=.002)
    # Rivet heads along the flanges, where the flange angles were riveted to the web in the old way.
    for x in np.arange(x0 + .2, x1, .3):
        for side in (-1, 1):
            for y in (G_TOP - FLANGE_T - .04, G_BOTTOM + FLANGE_T + .04):
                m.nail((x, y, z + side * WEB_T / 2), (0, 0, side), .012, "girder")


def cross_frames(m):
    """Diaphragms over the supports and K-frames every 3 m between neighbouring girders, so the deck is braced sideways."""
    web_h = DEPTH - 2 * FLANGE_T
    for a, b in zip(GIRDERS, GIRDERS[1:]):
        za, zb = a + WEB_T / 2, b - WEB_T / 2
        mid = (za + zb) / 2
        for x in (-14.85, PIERS[0], PIERS[1], 14.85):
            m.box((x, (G_TOP + G_BOTTOM) / 2, mid), (.012, web_h * .8, zb - za), "girder", chamfer=.002)
            m.box((x, G_BOTTOM + FLANGE_T + .05, mid), (.16, .1, zb - za), "girder", chamfer=.004)
        for x in np.arange(-12.4, 12.5, 3.1):
            if min(abs(x - p) for p in PIERS) < .6:
                continue
            top, bot = G_TOP - FLANGE_T - .06, G_BOTTOM + FLANGE_T + .06
            m.beam((x, top, za), (x, top, zb), .07, .07, "girder", chamfer=.004)
            m.beam((x, bot, za), (x, bot, zb), .07, .07, "girder", chamfer=.004)
            m.beam((x, bot, za), (x, top, mid), .06, .06, "girder", chamfer=.004)
            m.beam((x, top, mid), (x, bot, zb), .06, .06, "girder", chamfer=.004)


def bearing(m, x, z):
    """A steel rocker bearing: a sole plate under the girder, the rocker, a masonry plate on the seat."""
    m.box((x, G_BOTTOM - .015, z), (.5, .03, .44), "steel_bare", chamfer=.004)
    m.box((x, G_BOTTOM - .045, z), (.3, .03, .36), "girder", chamfer=.008)
    m.box((x, CAP_TOP + .015, z), (.56, .03, .5), "steel_bare", chamfer=.004)
    for dx in (-.22, .22):
        for dz in (-.19, .19):
            m.bolt((x + dx, CAP_TOP + .03, z + dz), (0, 1, 0), .016, "steel_bare")


def pier(m, x, rng):
    """Two round columns under a cap beam, footings buried in the bank."""
    cap_h = 1.0
    m.box((x, CAP_TOP - cap_h / 2, 0), (1.0, cap_h, 8.4), "concrete_cast", chamfer=.05)
    for z in (-2.3, 2.3):
        m.cyl((x, -DROP + .4, z), (x, CAP_TOP - cap_h, z), .48, "concrete_cast", sides=28)
        m.box((x, -DROP + .2, z), (1.6, .4, 1.6), "concrete_cast", chamfer=.05)
        m.collide_post(x, z, x, z, .5, -DROP, CAP_TOP - cap_h, "bridge pier")
    m.collide_box(x, 0, .5, 4.2, CAP_TOP - cap_h, CAP_TOP, tag="bridge pier cap")
    for z in GIRDERS:
        bearing(m, x, z)


def abutment(m, s, rng):
    """At one lip of the gorge: the seat the girders bear on, the back wall behind their ends, and fieldstone wing walls."""
    face, back = s * ABUT_FACE, s * ABUT_BACK
    mid = (face + back) / 2
    width = 2 * 4.99   # the old abutment's width, which the banks and the wing walls' footprint were shaped to
    # The seat block: from the footing to the bearing seat.
    m.box((mid, (CAP_TOP - DROP) / 2, 0), (ABUT_BACK - ABUT_FACE, CAP_TOP + DROP, width), "concrete_cast", chamfer=.04)
    # The back wall rises behind the girders' ends to carry the deck's end and hold the road fill.
    wall = s * (GIRDER_END + .25), s * ABUT_BACK
    m.box(((wall[0] + wall[1]) / 2, (CAP_TOP + (-SLAB)) / 2, 0), (abs(wall[1] - wall[0]), -SLAB - CAP_TOP, width), "concrete_cast", chamfer=.03)
    for z in GIRDERS:
        bearing(m, s * (GIRDER_END - .35), z)
    m.collide_box(mid, 0, (ABUT_BACK - ABUT_FACE) / 2, width / 2, -DROP, -SLAB, tag="bridge abutment")
    # Wing walls: fieldstone faced, stepped down in three lifts as the bank comes up to meet them.
    for side in (-1, 1):
        zc = side * (width / 2 - .27)
        x_in = s * ABUT_BACK
        # Only the faces anyone can see get stones: the outer one and the end towards the gorge. Low lifts are mostly buried.
        faces = (0 if side > 0 else 1, 2 if s > 0 else 3)
        for y0, top, length, step in ((-DROP, -2.4, 5.4, .08), (-2.4, -1.2, 4.3, .05), (-1.2, -.02, 3.2, .04)):
            cx = x_in + s * length / 2
            hq.masonry_block(m, (cx, zc), (length / 2, .27), y0, top, "stone", depth=.045, step=step, faces=faces, cap_mat="concrete_cast")
        m.collide_box(x_in + s * 2.7, zc, 2.7, .27, -DROP, 0, tag="bridge wing wall")


def deck(m, rng):
    """The slab between the edge beams, the edge beams with their drip noses, drains, and the expansion joints."""
    m.box((0, -SLAB / 2, 0), (2 * L + .1, SLAB, 2 * INNER), "concrete_deck", chamfer=.01)
    for side in (-1, 1):
        zc = side * (INNER + EDGE / 2)
        depth = SLAB + KERB + .3
        m.box((0, KERB - depth / 2, zc), (2 * L + .1, depth, EDGE), "concrete_deck", chamfer=.03)
        # The drip nose under the beam's outer edge throws rain clear of the girders.
        m.box((0, KERB - depth - .04, zc + side * (EDGE / 2 - .06)), (2 * L + .1, .08, .1), "concrete_deck", chamfer=.012)
        # Drains: a cast scupper through the beam every 6 m, its pipe turned down past the girders.
        for x in np.arange(-L + 3.5, L - 2, 6.1):
            m.box((x, .02, side * (INNER + .02)), (.34, .06, .05), "steel_bare", chamfer=.008)
            pz = side * (INNER + EDGE + .09)
            m.cyl((x, -.05, side * (INNER + EDGE)), (x, -.05, pz), .065, "girder", sides=12)
            m.cyl((x, -.05, pz), (x, G_BOTTOM - .25, pz), .065, "girder", sides=12)
            for y in (-.2, -.5):
                m.box((x, y, side * (INNER + EDGE + .035)), (.05, .05, .1), "steel_bare", chamfer=.006)
    # Expansion joints at each end of the deck: a steel plate across the carriageway, bolted down, the gap under it.
    for s in (-1, 1):
        x = s * (GIRDER_END + .3)
        m.box((x, .022, 0), (.32, .014, 2 * INNER), "steel_bare", chamfer=.003)
        for z in np.arange(-INNER + .3, INNER, .55):
            for dx in (-.11, .11):
                m.bolt((x + dx, .03, z), (0, 1, 0), .012, "steel_bare")


def rails(m):
    """The steel W-beam guard rail, as on the approaches (ribs towards the road, posts behind it on spacer blocks), its face on the
    line RAIL out from the middle, run on past each end of the deck to where the approach rail takes over. Posts stand on the
    edge beams; past the deck they go down into the fill."""
    for sign in (-1, 1):
        zb = sign * RAIL
        toward = -sign
        for x in np.arange(-L - 2.8, L + 2.9, 2.8):
            base = KERB if abs(x) <= L else -.3
            m.beam((x, base, zb + sign * .12), (x, .74, zb + sign * .12), .105, .145, "galv", chamfer=.006, up=(0, 0, 1))
            m.box((x, .62, zb + sign * .035), (.1, .2, .05), "wood_dark", chamfer=.006)
            m.bolt((x, .62, zb + sign * .008), (0, 0, toward), .014, "steel_bare")
            if abs(x) <= L:
                m.box((x, base + .01, zb + sign * .12), (.24, .02, .2), "steel_bare", chamfer=.004)
            m.collide_post(x, zb + sign * .12, x, zb + sign * .12, .09, -.3, .74, "bridge post")
        start, stop, panel = -L - 2.9, L + 2.9, 3.9
        for j, x0 in enumerate(np.arange(start, stop, panel)):
            length = min(panel + .12, stop - x0)
            lap = (j % 2) * .0045

            def rail(u, v, x0=x0, length=length, lap=lap, zb=zb, toward=toward, back=0.0):
                t = 2 * v - 1
                return np.array((x0 + length * u, .62 + t * .155, zb + toward * (.042 * np.sin(np.pi * t) ** 2 + lap - back)))
            # The sheet's own normal is +z: the face towards the road is flipped where the road lies towards -z, the back the other way.
            for back in (False, True):
                m.surface("galv", lambda u, v, r=rail, back=back: r(u, v, back=.0035 if back else 0), 4, 10,
                          (length * 1.5, .6), flip=(toward > 0 if back else toward < 0), density=3)
            if j:
                for dy in (-.11, -.05, .05, .11):
                    m.bolt((x0 + .05, .62 + dy, zb + toward * (.0045 + .042 * np.sin(np.pi * dy / .155) ** 2)), (0, 0, toward), .0085, "steel_bare")


def roadbridge():
    m = Model("roadbridge", tex=2048, seed=301, tiled=True)
    rng = m.rng
    deck(m, rng)
    for z in GIRDERS:
        girder(m, z, rng)
    cross_frames(m)
    for x in PIERS:
        pier(m, x, rng)
    for s in (-1, 1):
        abutment(m, s, rng)
    rails(m)
    # Deck is one walkable surface; the rails keep you on it.
    m.collide_box(0, 0, L + .05, INNER + EDGE, -.4, 0, tag="road bridge deck")
    m.collide_post(-L - 2.8, -RAIL, L + 2.8, -RAIL, .08, .1, .9, "bridge rail")
    m.collide_post(-L - 2.8, RAIL, L + 2.8, RAIL, .08, .1, .9, "bridge rail")
    m.radius = 22
    return m


SHOTS = [((-10, 1.7, 1.5), (10, .4, -1), 50), ((0, -3.5, 22), (0, -1.5, 0), 40), ((2.5, -4.5, 4.5), (0, -1.0, 0), 70),
         ((22, 2.5, 9), (12, -2, 3), 45)]
ASSETS = {"roadbridge": (roadbridge, SHOTS)}
