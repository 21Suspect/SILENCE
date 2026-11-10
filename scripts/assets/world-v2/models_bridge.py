"""The road bridge over the stream: the one piece of real engineering anyone ever paid for out here."""
import numpy as np

from kit import Model


def roadbridge():
    """Origin is the middle of the deck surface; the deck runs along local X, 28 m between abutments."""
    m = Model("roadbridge", tex=4096, seed=301)
    L, W = 16.2, 4.3
    DROP = 16.0
    # Steel stringers carry a concrete slab.
    for z in (-3.4, -1.7, 0, 1.7, 3.4):
        m.beam((-L, -.52, z), (L, -.52, z), .14, .54, "steel", chamfer=.012, segs=3)
        for y in (-.27, -.77):
            m.beam((-L, y, z), (L, y, z), .3, .03, "steel", up=(0, 1, 0), chamfer=.006, segs=3)
    for x in np.arange(-L + 1, L, 3.0):
        m.beam((x, -.52, -3.45), (x, -.52, 3.45), .08, .3, "steel", chamfer=.008)
    m.box((0, -.13, 0), (2 * L + .1, .26, 2 * W + .1), "concrete", chamfer=.03)
    # Worn asphalt, cracked along the joints, with rusty expansion plates between the spans.
    m.density = 1.5
    m.box((0, -.005, 0), (2 * L, .02, 2 * W - .55), "asphalt", chamfer=.004)
    m.density = 1
    for x in (-4.7, 4.7):
        m.box((x, .004, 0), (.14, .012, 2 * W - .5), "steel_bare", chamfer=.002)
    # Two concrete piers on the banks, footings buried in the bed.
    for x in (-6.2, 6.2):
        for z in (-3.1, 0, 3.1):
            m.beam((x, -DROP, z), (x, -.8, z), .55, .55, "concrete", chamfer=.03)
            m.box((x, -DROP - .1, z), (1.25, .35, 1.25), "concrete", chamfer=.05)
            m.collide_post(x, z, x, z, .39, -DROP, -.8, "bridge pier")
        m.box((x, -.88, 0), (.68, .32, 7.4), "concrete", chamfer=.03)
    # Cast abutments at each lip of the gorge, with wing walls running back along it to hold the road fill.
    for s_ in (-1, 1):
        wall_x = s_ * 15.35
        m.box((wall_x + s_ * .35, -DROP / 2, 0), (.9, DROP, 2 * W + 1.1), "concrete", chamfer=.03)
        m.box((wall_x - s_ * .22, -.62, 0), (.44, .3, 2 * W + .6), "concrete", chamfer=.03)   # the seat the girders bear on
        for side in (-1, 1):
            # Three lifts of formwork, each shorter than the last, stepped down as the rock comes up to meet them.
            for lift, (y0, top, length) in enumerate(((-DROP, -2.3, 5.2), (-2.3, -1.15, 4.2), (-1.15, -.02, 3.2))):
                m.box((wall_x + s_ * (.8 + length / 2), (y0 + top) / 2, side * (W + .4)), (length + .02, top - y0, .55), "concrete", chamfer=.018)
            m.collide_box(wall_x + s_ * 2.4, side * (W + .4), 1.6, .3, -DROP, 0, tag="bridge wing wall")
        m.collide_box(wall_x + s_ * .35, 0, .45, W + .55, -DROP, -.3, tag="bridge abutment")
    # Steel guard rail on galvanised posts, run on past each end of the deck.
    for z, sign in ((-W + .08, -1), (W - .08, 1)):
        for x in np.arange(-L - 2.8, L + 2.9, 2.8):
            m.beam((x, -.22, z), (x, .86, z), .09, .07, "galv", chamfer=.008, up=(0, 0, 1))
            m.bolt((x, .62, z + sign * .045), (0, 0, sign), .012)
            m.collide_post(x, z, x, z, .06, -.3, .9, "bridge post")
        # Same metric UV scale and lapped 3.9 m sheets as the approach barriers.
        # Give the thin rail more atlas space than hidden concrete undersides.
        start, stop, panel = -L - 2.9, L + 2.9, 3.9
        for j, x0 in enumerate(np.arange(start, stop, panel)):
            length = min(panel + .12, stop - x0)
            lap = (j % 2) * .0045
            def rail(u, v, x0=x0, length=length, lap=lap, z=z, sign=sign, back=0.0):
                t = 2 * v - 1
                return np.array((x0 + length * u, .62 + t * .155, z + sign * (.036 + .042 * np.sin(np.pi * t) ** 2 + lap - back)))
            for back in (False, True):
                m.surface("galv", lambda u, v, r=rail, back=back: r(u, v, back=.0035 if back else 0), 4, 10,
                          (length * 1.5, .6), flip=(sign > 0 if back else sign < 0),
                          wear=lambda u, v: .06 + .2 * (1 - v) ** 3, density=3)
            if j:
                for dy in (-.11, -.05, .05, .11):
                    m.bolt((x0 + .05, .62 + dy, z + sign * (.045 + .042 * np.sin(np.pi * dy / .155) ** 2)), (0, 0, sign), .0085, "steel_bare")
    # Deck is one walkable surface; the rails keep you on it.
    m.collide_box(0, 0, L + .05, W, -.4, 0, tag="road bridge deck")
    m.collide_post(-L - 2.8, -W + .08, L + 2.8, -W + .08, .08, .1, .9, "bridge rail")
    m.collide_post(-L - 2.8, W - .08, L + 2.8, W - .08, .08, .1, .9, "bridge rail")
    m.radius = 20
    return m


ASSETS = {"roadbridge": (roadbridge, None)}
