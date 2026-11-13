"""The trapper's cabin, rebuilt for the shared material library (tiled.py): round peeled logs chinked with lime mortar,
a fieldstone footing and chimney with a fireplace, a corrugated iron roof on pole rafters, a porch with its own tin roof,
and a lived-in room. Front is +z; the door, the bench (where the torch lies) and the chimney stay where the game expects them.
"""
import math

import numpy as np

import parts_hq as hq
from kit import Model

W, D = 3.3, 2.5                 # wall centre lines: x = +-W (gables), z = +-D (eaves)
FLOOR = .42
R, PITCH = .12, .225            # log radius and course height
Y0 = .32                        # first front/back course
COURSES = 12                    # front/back: the top one is the plate the rafters sit on
SIDE0 = Y0 - PITCH / 2          # side walls start half a course down, as a sill half sunk in the footing
SIDE_COURSES = 12
PLATE = Y0 + (COURSES - 1) * PITCH          # 2.795
PLATE_TOP = PLATE + R                       # 2.915
SLOPE = .62                                 # about 32 degrees
RAFTER_R = .055
AXIS_AT_PLATE = PLATE_TOP + RAFTER_R        # rafter axis where it crosses the plate
RIDGE_AXIS = AXIS_AT_PLATE + D * SLOPE      # 4.52
FRONT_EAVE, BACK_EAVE, VERGE = .15, .55, .42
DOOR = (-1.15, -.25)                        # door x range; courses 1..10 cut
DOOR_HEAD = 2.62
OVER = .3                                   # log ends past the corner


def rafter_axis(z):
    return RIDGE_AXIS - abs(z) * SLOPE


def roof_top(z):
    """Underside of the tin: rafter, then a batten."""
    return rafter_axis(z) + RAFTER_R + .025


def front_courses():
    return [Y0 + i * PITCH for i in range(COURSES)]


def side_courses():
    return [SIDE0 + j * PITCH for j in range(SIDE_COURSES)]


def spans(a, b, cuts):
    """The parts of a..b left after removing each (lo, hi) in cuts."""
    out, start = [], a
    for lo, hi in sorted(cuts):
        if lo > start + .05:
            out.append((start, lo))
        start = max(start, hi)
    if b > start + .05:
        out.append((start, b))
    return out


def wall(m, axis, fixed, levels, length, openings):
    """One wall of logs. axis 0 runs along x at z=fixed, axis 1 along z at x=fixed. `openings` is [(lo, hi, first, last)]
    in the wall's own coordinate, cutting courses first..last. Returns the spans of each course (for the chinking)."""
    rng = m.rng
    out = []
    for k, y in enumerate(levels):
        cuts = [(lo, hi) for lo, hi, first, last in openings if first <= k <= last]
        a = -length - OVER + rng.uniform(-.04, .04)
        b = length + OVER + rng.uniform(-.04, .04)
        row = []
        for p, q in spans(a, b, cuts):
            P = (p, y, fixed) if axis == 0 else (fixed, y, p)
            Q = (q, y, fixed) if axis == 0 else (fixed, y, q)
            # Butt and top alternate course by course, as they were laid to keep the wall level.
            if k % 2:
                P, Q = Q, P
            hq.round_log(m, P, Q, R * rng.uniform(.94, 1.06), "logwood", taper=.12 if (q - p) > 3 else .05)
            row.append((p, q))
        out.append(row)
    return out


def chinking(m, axis, fixed, levels, rows, inner):
    """Lime mortar in the joint between each pair of courses, on both faces, stopping short of the crossing walls."""
    for k in range(len(levels) - 1):
        ym = (levels[k] + levels[k + 1]) / 2
        for p0, q0 in rows[k]:
            for p1, q1 in rows[k + 1]:
                p, q = max(p0, p1, -inner), min(q0, q1, inner)
                if q - p < .08:
                    continue
                for side in (1, -1):
                    def at(s, y, d, side=side):
                        return (s, y, fixed + side * d) if axis == 0 else (fixed + side * d, y, s)
                    n = max(2, int((q - p) / .4)) + 1
                    verts, normals, uvs = [], [], []
                    for i in range(n):
                        s = p + (q - p) * i / (n - 1)
                        jig = m.rng.uniform(-.004, .004)
                        for y, d in ((ym + .052, .096), (ym + jig, .081 + jig), (ym - .052, .096)):
                            verts.append(at(s, y, d))
                            normals.append((0, 0, side) if axis == 0 else (side, 0, 0))
                            uvs.append((s, y))
                    faces = []
                    for i in range(n - 1):
                        for j in range(2):
                            f = (i * 3 + j, i * 3 + j + 1, (i + 1) * 3 + j + 1, (i + 1) * 3 + j)
                            # Wound to face out of the wall: the material is double-sided and flips the normal on a back face.
                            faces.append(f[::-1] if (side > 0) == (axis == 1) else f)
                    m.add("mortar", verts, normals, uvs, faces, metres_per_uv=1, density=.6)


def window(m, lo, hi, bottom, top, boards=(), broken=False):
    """A window in a wall whose centre plane is local z=0, outside +z: bucks through the wall, casing, a sloped sill, a
    four-pane sash. `boards` are (height, tilt) of planks nailed across the outside."""
    rng = m.rng
    depth = 2 * R
    for x in (lo + .025, hi - .025):
        m.beam((x, bottom, 0), (x, top, 0), .05, depth, "wood_dark", up=(1, 0, 0))
    for y in (bottom + .025, top - .025):
        m.beam((lo, y, 0), (hi, y, 0), depth, .05, "wood_dark")
    # Casing on the outside face, proud of the logs.
    z = R + .01
    for x in (lo - .04, hi + .04):
        m.plank((x, bottom - .05, z), (x, top + .1, z), .11, .025, mat="wood", up=(0, 0, 1), warp=.002)
    m.plank((lo - .1, top + .07, z + .003), (hi + .1, top + .07, z + .003), .14, .028, mat="wood", up=(0, 0, 1), warp=.002)
    m.beam((lo - .12, bottom - .02, R - .01), (hi + .12, bottom - .02, R - .01), .14, .04, "wood_dark", up=(0, 1, .3))
    # Sash: frame, a cross of glazing bars, four panes.
    zs = .03
    ix0, ix1, iy0, iy1 = lo + .05, hi - .05, bottom + .05, top - .05
    for x in (ix0 + .025, ix1 - .025):
        m.beam((x, iy0, zs), (x, iy1, zs), .05, .045, "wood_dark", up=(0, 0, 1))
    for y in (iy0 + .03, iy1 - .025):
        m.beam((ix0, y, zs), (ix1, y, zs), .055 if y < (iy0 + iy1) / 2 else .045, .045, "wood_dark", up=(0, 0, 1))
    cx, cy = (ix0 + ix1) / 2, (iy0 + iy1) / 2
    m.beam((cx, iy0, zs), (cx, iy1, zs), .028, .035, "wood_dark", up=(0, 0, 1))
    m.beam((ix0, cy, zs), (ix1, cy, zs), .028, .035, "wood_dark", up=(0, 0, 1))
    panes = [(ix0 + .05, cx - .014, iy0 + .055, cy - .014), (cx + .014, ix1 - .05, iy0 + .055, cy - .014),
             (ix0 + .05, cx - .014, cy + .014, iy1 - .05), (cx + .014, ix1 - .05, cy + .014, iy1 - .05)]
    for i, (a, b, c, d) in enumerate(panes):
        if broken and i == 1:
            # A shard left in the corner of a broken pane.
            m.add("glass", [(a, c, zs), (a + .12, c, zs), (a, c + .16, zs)], [(0, 0, 1)] * 3, [(0, 0), (1, 0), (0, 1)], [(0, 1, 2)])
            continue
        m.box(((a + b) / 2, (c + d) / 2, zs), (b - a, d - c, .004), "glass", chamfer=.0005)
    for h, tilt in boards:
        y = bottom + (top - bottom) * h
        # On the casing (its face at R + .0225), nailed through into the logs.
        m.plank((lo - .2, y - tilt, R + .0365), (hi + .2, y + tilt, R + .0365), rng.uniform(.15, .19), .028, mat="wood", up=(0, 0, 1), warp=0)
        for x, t in ((lo - .1, -1), (hi + .1, 1)):
            m.nail((x, y + tilt * t * (1 + .2 / (hi - lo + .4)) * (hi - lo + .2) / (hi - lo + .4), R + .0505), (0, 0, 1), r=.006, mat="iron")


def cabin():
    m = Model("cabin", tex=2048, seed=7, tiled=True)
    rng = m.rng
    fronts, sides = front_courses(), side_courses()

    # -- footing: fieldstone under every wall, sunk a little, standing out of the ground by its own relief --------------
    hq.masonry_block(m, (0, 0), (W + .22, D + .22), -.15, .22, "stone", depth=.04, top=False)

    # -- walls --------------------------------------------------------------------------------------------------------
    front_window, back_window, side_window, fire = (.75, 1.85), (-.5, .5), (-.55, .55), (-1.0, -.1)
    rows_f = wall(m, 0, D, fronts, W, [(*DOOR, 1, 10), (*front_window, 4, 8)])
    rows_b = wall(m, 0, -D, fronts, W, [(*back_window, 4, 8)])
    rows_r = wall(m, 1, W, sides, D, [(*side_window, 5, 8)])
    rows_l = wall(m, 1, -W, sides, D, [(*fire, 1, 4)])
    chinking(m, 0, D, fronts, rows_f, W - .1)
    chinking(m, 0, -D, fronts, rows_b, W - .1)
    chinking(m, 1, W, sides, rows_r, D - .1)
    chinking(m, 1, -W, sides, rows_l, D - .1)

    # Rough openings run from the top of the course below the cut to the bottom of the course above it.
    f_lo, f_hi = fronts[3] + R, fronts[9] - R
    s_lo, s_hi = sides[4] + R, sides[9] - R
    close = m.at((0, 0, D), 0.0)
    window(m, *front_window, f_lo, f_hi, boards=((.3, .03), (.62, -.05)))
    close()
    close = m.at((0, 0, -D), math.pi)
    window(m, *back_window, f_lo, f_hi, boards=((.25, .02), (.55, -.02), (.82, .03)))
    close()
    close = m.at((W, 0, 0), math.pi / 2)
    window(m, *side_window, s_lo, s_hi, broken=True)
    close()

    # -- door: bucks through the wall, casing, a worn threshold; the leaf is its own hinged model ----------------------
    head = fronts[11] - R
    for x in (DOOR[0] + .025, DOOR[1] - .025):
        m.beam((x, FLOOR - .02, D), (x, head, D), .05, 2 * R + .01, "wood_dark", up=(1, 0, 0))
    m.beam((DOOR[0], DOOR_HEAD + .025, D), (DOOR[1], DOOR_HEAD + .025, D), 2 * R + .01, .05, "wood_dark")
    m.plank((DOOR[0] + .05, DOOR_HEAD + (head - DOOR_HEAD) / 2 + .025, D + R - .02), (DOOR[1] - .05, DOOR_HEAD + (head - DOOR_HEAD) / 2 + .025, D + R - .02), head - DOOR_HEAD - .04, .03, mat="wood", up=(0, 0, 1), warp=0)
    m.beam((DOOR[0] - .02, FLOOR - .01, D), (DOOR[1] + .02, FLOOR - .01, D), 2 * R + .08, .04, "wood_dark", grain=.5)
    for x in (DOOR[0] - .055, DOOR[1] + .055):
        m.plank((x, FLOOR - .05, D + R + .012), (x, head + .06, D + R + .012), .11, .025, mat="wood", up=(0, 0, 1), warp=.002)
    m.plank((DOOR[0] - .13, head + .05, D + R + .016), (DOOR[1] + .13, head + .05, D + R + .016), .14, .028, mat="wood", up=(0, 0, 1), warp=.002)
    m.door("door_plank", (DOOR[0] + .01, FLOOR + .02, D), 0.0, 1.75, width=.88, height=2.18, thickness=.035, start=.3)

    # -- floor ----------------------------------------------------------------------------------------------------------
    v = [(-W + .02, FLOOR, -D + .02), (W - .02, FLOOR, -D + .02), (W - .02, FLOOR, D - .02), (-W + .02, FLOOR, D - .02)]
    m.add("floor", v, [(0, 1, 0)] * 4, [(p[0] + .37, p[2] + .11) for p in v], [(3, 2, 1, 0)], metres_per_uv=1)
    for x in np.arange(-W + .45, W - .3, .8):
        m.beam((x, FLOOR - .12, -D + .1), (x, FLOOR - .12, D - .1), .08, .2, "wood_dark")

    # -- roof frame: ridge and purlin logs through the gables, pole rafters, sawn battens --------------------------------
    span = W + VERGE + .08
    for zc, rr in ((0.0, .13), (1.25, .11), (-1.25, .11)):
        y = rafter_axis(zc) - RAFTER_R - rr + .01
        hq.round_log(m, (-span, y, zc), (span, y, zc), rr, "logwood", taper=.06, sweep=.02)
    xs = [-W - VERGE + .03] + list(np.linspace(-W + .05, W - .05, 9)) + [W + VERGE - .03]
    for x in xs:
        for sgn, eave in ((1, FRONT_EAVE), (-1, BACK_EAVE)):
            z1 = sgn * (D + eave + .02)
            a = (x + rng.uniform(-.02, .02), rafter_axis(0) + .02, -sgn * .04)
            b = (x + rng.uniform(-.02, .02), rafter_axis(z1), z1)
            hq.round_log(m, a, b, RAFTER_R * rng.uniform(.9, 1.1), "logwood", taper=.15, sweep=.015, wobble=.04, caps=(False, True))
    battens = []
    for sgn, eave in ((1, FRONT_EAVE), (-1, BACK_EAVE)):
        for d in np.arange(.08, D + eave, .5):
            z = sgn * min(d, D + eave - .03)
            y = rafter_axis(z) + RAFTER_R + .0125
            m.beam((-W - VERGE - .02, y, z), (W + VERGE + .02, y, z), .07, .025, "wood_dark", up=(0, 1, sgn * SLOPE), warp=.006, segs=4)
            battens.append(z)
    # Barge boards along the verges cover the battens' ends and the edge of the iron.
    for x in (-W - VERGE - .04, W + VERGE + .04):
        for sgn, eave in ((1, FRONT_EAVE), (-1, BACK_EAVE)):
            z1 = sgn * (D + eave + .03)
            m.plank((x, roof_top(0) - .03, 0), (x, roof_top(z1) - .03, z1), .19, .03, mat="wood_dark", up=(math.copysign(1, x), 0, 0), warp=.004, segs=4)

    # -- tin: one sheet per run, ridge to eave, each lapping its neighbour by a rib; screws on the crests at each batten --
    for sgn, eave in ((1, FRONT_EAVE), (-1, BACK_EAVE)):
        run = D + eave + .06
        slope_len = (run + .03) * math.hypot(1, SLOPE)
        down = np.array((0, -SLOPE, sgn * 1.0)) / math.hypot(1, SLOPE)
        x0 = -W - VERGE - .06
        width_all = 2 * (W + VERGE + .06)
        n = int(math.ceil(width_all / .76))
        step = width_all / n
        for i in range(n):
            x = x0 + i * step - (.076 if i else 0)
            o = np.array((x, roof_top(-sgn * .03) + .0005, -sgn * .03))
            curl = .07 if (sgn > 0 and i == 6) else 0.0
            lift = .05 if (sgn < 0 and i == 2) else 0.0
            at = hq.corrugated(m, o, (1, 0, 0), down, step + (.076 if i else 0), slope_len, mat="tin", curl=curl, lift_edge=lift, lap=.0025 if i else 0.0)
            for z in battens:
                if np.sign(z) != sgn:
                    continue
                t = (abs(z) + .03) * math.hypot(1, SLOPE)
                for c in at.crests[1::3]:
                    p = at(c, t)
                    m.nail(p, at.up, r=.008, mat="iron")
    # Ridge cap: bent along the roof's own pitch, resting on the crests either side.
    for xi in np.arange(-W - VERGE - .05, W + VERGE, .9):
        def cap(u, v, xi=xi):
            z = (v - .5) * .5
            roll = .012 * max(0.0, 1 - abs(z) / .06) ** 2
            return np.array((xi + u * .95, roof_top(z) + .018 + .0015 + roll + (round(xi * 10) % 2) * .0015, z))
        m.surface("tin", cap, 3, 8, (1.9, 1.0), flip=True, metres_per_uv=.5)

    # -- gables: boards cut to the roof, battens over the joints --------------------------------------------------------
    for sx in (-1, 1):
        x = sx * (W + .055)
        z = -D - .1
        while z < D + .1:
            w = rng.uniform(.17, .22)
            z1 = min(z + w, D + .1)
            def ytop(zz):
                return rafter_axis(zz) - RAFTER_R - .01
            outline = [(z, sides[-1] + .02), (z1, sides[-1] + .02), (z1, ytop(z1)), (z, ytop(z))]
            if z < 0 < z1:
                outline.insert(3, (0.0, ytop(0)))
            # Plane: along +z (or -z on the left so the board faces out), up +y.
            pts = [(s * sx, t) for s, t in outline] if sx > 0 else [(-s, t) for s, t in outline]
            close = m.at((x + sx * rng.uniform(-.004, .004), 0, 0), 0.0)
            hq.prism(m, pts if sx > 0 else pts, (0, 0, 1) if sx > 0 else (0, 0, -1), (0, 1, 0), (sx, 0, 0), .024, "wood")
            close()
            if z1 < D + .1:
                yb = min(ytop(z1), ytop(z1)) - .02
                m.beam((x + sx * .02, sides[-1] + .05, z1), (x + sx * .02, yb, z1), .05, .022, "wood", up=(sx, 0, 0), chamfer=.004)
            z = z1

    # -- chimney: a broad base against the left gable, stepping in to a stack clear of the verge --------------------------
    cz = -.55
    base_x0, base_x1 = -W - 1.05, -W - .08
    hq.masonry_block(m, ((base_x0 + base_x1) / 2, cz), ((base_x1 - base_x0) / 2, .56), -.15, 2.05, "stone", depth=.045, cap_mat="stone")
    stack_x0, stack_x1 = -W - 1.0, -W - .44
    top = rafter_axis(0) + 1.0
    hq.masonry_block(m, ((stack_x0 + stack_x1) / 2, cz), ((stack_x1 - stack_x0) / 2, .31), 2.05, top, "stone", depth=.04, taper=.04, cap_mat="stone")
    m.box(((stack_x0 + stack_x1) / 2, top + .05, cz), (.74, .1, .7), "rock", chamfer=.03)
    m.cyl(((stack_x0 + stack_x1) / 2, top + .05, cz), ((stack_x0 + stack_x1) / 2, top + .42, cz), .1, "iron_black", sides=14)
    m.hook("chimney", ((stack_x0 + stack_x1) / 2, top + .45, cz))
    m.collide_box((base_x0 + base_x1) / 2, cz, (base_x1 - base_x0) / 2 + .05, .6, 0, top)

    # Fireplace: the opening in the wall, a sooted firebox in the base, a hearth stone in front, a mantel log over it.
    fx_in, fx_back = -W + R, -W - .62
    f_top = sides[5] - R
    for zz, nz in ((fire[0], 1), (fire[1], -1)):
        hq.masonry_face(m, (fx_back, FLOOR, zz), (1, 0, 0), (0, 1, 0), fx_in - fx_back, f_top - FLOOR, .025, "stone_soot",
                        off=(rng.random() * 5, 0), out=(0, 0, nz))
    hq.masonry_face(m, (fx_back, FLOOR, fire[1]), (0, 0, -1), (0, 1, 0), fire[1] - fire[0], f_top - FLOOR, .03, "stone_soot", out=(1, 0, 0))
    v = [(fx_back, f_top, fire[0]), (fx_in, f_top, fire[0]), (fx_in, f_top, fire[1]), (fx_back, f_top, fire[1])]
    m.add("stone_soot", v, [(0, -1, 0)] * 4, [(p[0], p[2]) for p in v], [(0, 1, 2, 3)], metres_per_uv=1, density=.4)
    v = [(fx_back, FLOOR + .01, fire[0]), (fx_in, FLOOR + .01, fire[0]), (fx_in, FLOOR + .01, fire[1]), (fx_back, FLOOR + .01, fire[1])]
    m.add("stone_soot", v, [(0, 1, 0)] * 4, [(p[0], p[2]) for p in v], [(3, 2, 1, 0)], metres_per_uv=1, density=.5)
    m.box((-W + .5, FLOOR + .025, (fire[0] + fire[1]) / 2), (.78, .05, 1.25), "rock", chamfer=.012)
    m.box((-W + .15, f_top + .09, (fire[0] + fire[1]) / 2), (.16, .18, 1.25), "rock", chamfer=.02)
    hq.round_log(m, (-W + .2, f_top + .31, fire[0] - .3), (-W + .2, f_top + .31, fire[1] + .3), .09, "wood_dark", taper=.04)
    # Three charred ends in the grate, settled on the firebox floor.
    hq.settle_split_pile(m, "z", "x", FLOOR + .01, -W - .45, -W - .1, 2, -.55, (.06, .08), (.36, .44), bark="char", face="char", cap="char", max_height=FLOOR + .2)

    # -- porch: deck boards on joists, a beam on stone piers, braced posts, its own tin roof ----------------------------
    pz = D + 2.15
    for x in (-W - .05, -1.1, 1.1, W + .05):
        hq.masonry_block(m, (x, pz), (.2, .2), -.1, FLOOR - .25, "stone", depth=.03, step=.025, cap_mat="stone")
    hq.round_log(m, (-W - .3, FLOOR - .14, pz), (W + .3, FLOOR - .14, pz), .1, "logwood", taper=.08)
    for x in np.arange(-W, W + .1, .825):
        m.beam((x, FLOOR - .11, D + R + .02), (x, FLOOR - .11, pz + .06), .06, .17, "wood_dark")
    z = D + R + .02
    row = 0
    while z < pz + .12:
        w = rng.uniform(.13, .16)
        zc = z + w / 2
        joint = -W + .825 * rng.randrange(2, 7)
        pieces = [(-W - .14, joint - .003), (joint + .003, W + .14)]
        if row == 7:
            pieces = [(-W - .14, -.7), (.15, joint - .003), (joint + .003, W + .14)]    # a board broken through near the middle
        for a_, b_ in pieces:
            m.plank((a_, FLOOR - .016, zc), (b_, FLOOR - .016, zc), w - .009, .032, mat="wood", warp=0, segs=4)
            for x in np.arange(-W, W + .1, .825):
                if a_ + .03 < x < b_ - .03:
                    for dz in (-w * .25, w * .25):
                        m.nail((x + .01, FLOOR, zc + dz), (0, 1, 0), r=.004, mat="iron")
        z += w
        row += 1
    # Beam low enough to keep 2 m of head room on the porch; the roof falls from just under the main eave to it.
    py = FLOOR + 2.0 + .085
    posts = (-W - .05, -1.75, .95, W + .05)
    for x in posts:
        hq.round_log(m, (x, FLOOR - .02, pz), (x + rng.uniform(-.025, .025), py - .06, pz + rng.uniform(-.02, .02)), .085, "logwood", taper=.08, caps=(False, False))
        m.collide_post(x, pz, x, pz, .1, 0, py, "porch post")
        for s in ((-1, 1) if x not in (posts[0], posts[-1]) else ((1,) if x < 0 else (-1,))):
            m.beam((x + s * .05, py - .55, pz), (x + s * .5, py - .1, pz), .07, .07, "wood_dark", up=(0, 0, 1))
            m.nail((x + s * .47, py - .12, pz + .036), (0, 0, 1), r=.007, mat="iron")
    hq.round_log(m, (-W - .45, py, pz), (W + .45, py, pz), .085, "logwood", taper=.07)
    z_hi = D + R + .04
    hi = roof_top(D + FRONT_EAVE) - .07 - .025 - .05        # porch rafter axis at the wall: its iron laps under the main eave
    lo = py + .085 + .05                                    # and at the beam
    fall = (hi - lo) / (pz - z_hi)
    porch_axis = lambda z: hi - (z - z_hi) * fall
    m.beam((-W - .2, hi - .05 - .08, z_hi), (W + .2, hi - .05 - .08, z_hi), .08, .16, "wood_dark", up=(0, 1, 0))
    rafters = list(np.linspace(-W - .2, W + .2, 9))
    for x in rafters:
        m.beam((x, hi, z_hi - .02), (x, porch_axis(pz + .35), pz + .35), .06, .1, "wood_dark")
    run = pz + .4 - z_hi
    plen = math.hypot(run, porch_axis(z_hi) - porch_axis(pz + .4))
    pdown = np.array((0, porch_axis(pz + .4) - porch_axis(z_hi), run)) / plen
    for d in (.25, 1.2, 2.1):
        zz = z_hi + d * run / plen
        y = porch_axis(zz) + .05 + .0125
        m.beam((-W - .3, y, zz), (W + .3, y, zz), .07, .025, "wood_dark", up=(0, 1, fall), warp=.004, segs=3)
    n = 9
    for i in range(n):
        if i == 3:
            continue                                   # the sheet that came down (it lies in front)
        x = -W - .3 + i * (2 * W + .6) / n
        o = np.array((x, porch_axis(z_hi) + .05 + .025 + .004 + (i % 2) * .006, z_hi - .03))
        hq.corrugated(m, o, (1, 0, 0), pdown, (2 * W + .6) / n + .08, plen + .03, mat="tin", droop=.003, curl=.05 if i == 7 else 0.0)

    # Steps up to the porch, on two stringers.
    for i, (dz, y) in enumerate(((2.45, FLOOR - .15), (2.77, FLOOR - .29))):
        for w in (-.075, .075):
            m.plank((-1.5, y, D + dz + w), (.1, y, D + dz + w), .145, .045, mat="wood", warp=.003)
    for x in (-1.42, .02):
        m.beam((x, FLOOR - .1, D + 2.2), (x, .02, D + 3.05), .06, .24, "wood_dark", up=(0, 1, 0))
    # Railings each side of the steps.
    for a0, b0 in ((posts[0], posts[1]), (posts[2], posts[3])):
        hq.round_log(m, (a0, FLOOR + .9, pz), (b0, FLOOR + .93, pz), .045, "logwood", taper=.1, sweep=.01)
        hq.round_log(m, (a0, FLOOR + .45, pz), (b0, FLOOR + .43, pz), .04, "logwood", taper=.1, sweep=.01)

    # Bench on the porch, where the torch has been left.
    bx0, bx1, bz, seat = .55, 2.25, D + .5, FLOOR + .45
    for w in (-.11, .11):
        m.plank((bx0, seat, bz + w), (bx1, seat, bz + w), .2, .045, mat="wood", warp=.003)
    for x in (bx0 + .14, bx1 - .14):
        for w in (-.13, .13):
            m.beam((x + w * .14, FLOOR, bz + w), (x, seat - .02, bz + w * .75), .07, .09, "wood_dark")
        m.beam((x, seat - .07, bz - .17), (x, seat - .07, bz + .17), .06, .09, "wood_dark")
    m.hook("bench", ((bx0 + bx1) / 2 - .25, seat + .08, bz + .02))
    m.collide_box((bx0 + bx1) / 2, bz, (bx1 - bx0) / 2, .2, FLOOR, seat + .03, tag="porch bench")

    # Storm lantern on a wire from a porch rafter; the runtime can light it.
    lx, lz = rafters[5], D + .6
    ly = porch_axis(lz) - .05
    m.lathe([(0, 0), (.075, .05), (.09, .2), (.055, .55), (.075, .62), (.075, .7), (0, .72)], (lx, ly - .78, lz), (lx, ly - .42, lz), "tin", 14)
    m.tube([(lx - .06, ly - .55, lz), (lx - .03, ly - .42, lz), (lx, ly - .36, lz), (lx + .03, ly - .42, lz), (lx + .06, ly - .55, lz)], .005, "iron", 5)
    m.tube([(lx, ly - .37, lz), (lx, ly - .08, lz), (lx + .04, ly - .02, lz), (lx + .04, ly + .05, lz)], .006, "iron", 6)
    m.hook("lantern", (lx, ly - .61, lz))

    # -- firewood: split pieces dropped onto two poles along the right gable, a chopping block with the axe in it --------
    # Every piece is settled (parts_hq.settle_split_pile): it comes to rest on the poles or on the pieces below it.
    pile_x = W + .62
    for x in (pile_x - .14, pile_x + .14):
        hq.round_log(m, (x, .045, -2.4), (x, .045, .6), .045, "bark", cap="endgrain", taper=.05, wobble=.01, sweep=.005)
    rails_top = .045 + .045 - .004
    hq.settle_split_pile(m, "x", "z", rails_top, -2.32, .52, 7, pile_x, (.075, .115), (.42, .5), max_height=1.15)
    m.collide_box(W + .6, -.9, .32, 1.5, 0, 1.15, tag="woodpile")
    block = (W + 1.35, 1.5)
    hq.round_log(m, (block[0], -.02, block[1]), (block[0], .5, block[1]), .27, "bark", taper=.0, wobble=.02, caps=(False, True), bevel=.01)
    m.collide_post(block[0], block[1], block[0], block[1], .28, 0, .5, "chopping block")
    m.beam((block[0] + .03, .47, block[1]), (block[0] + .46, .93, block[1] + .2), .032, .045, "wood_fresh", segs=1)
    m.box((block[0] + .02, .53, block[1] - .01), (.17, .1, .016), "iron", yaw=-.4, chamfer=.003)
    # Splits and offcuts round the block, lying on the ground on their flat sides.
    for zc in (block[1] - .55, block[1] + .5):
        hq.settle_split_pile(m, "z", "x", 0.0, block[0] - .5, block[0] - .2, 1, zc, (.06, .1), (.3, .42), gap=(.08, .25))
    hq.settle_split_pile(m, "x", "z", 0.0, block[1] - .15, block[1] + .15, 1, block[0] + .55, (.06, .09), (.3, .4), gap=(.1, .2))

    # The sheet missing from the porch roof lies where it came down, one end folded under.
    o = np.array((-W - 1.6, .04, D + .9))
    hq.corrugated(m, o, (.96, 0, -.28), (.28, 0, .96), .86, 2.2, mat="tin", curl=.2)

    # -- inside: a log bed along the back wall, a table and stools, shelves, a wood box, a lantern from the ridge --------
    # A real single bed: 2 m of frame for a 1.9 m mattress, against the wall's log crowns.
    hx0, hx1 = 1.12, 3.14
    z0, z1 = -D + R + .03, -D + R + .93
    for x, h in ((hx0, .95), (hx1, .62)):
        for z in (z0, z1):
            hq.round_log(m, (x, FLOOR, z), (x, FLOOR + h, z), .055, "logwood", taper=.06, wobble=.02, caps=(False, True), bevel=.01)
    rail = FLOOR + .36
    for z in (z0, z1):
        hq.round_log(m, (hx0, rail, z), (hx1, rail, z), .045, "logwood", taper=.05, sweep=.006, caps=(False, False))
    for x, top in ((hx0, FLOOR + .86), (hx1, FLOOR + .56)):
        for y in (rail, top):
            hq.round_log(m, (x, y, z0), (x, y, z1), .04, "logwood", taper=.05, sweep=.004, caps=(False, False))
    slat = rail + .045 + .011
    for x in np.arange(hx0 + .1, hx1 - .05, .15):
        m.plank((x, slat, z0 + .01), (x, slat, z1 - .01), .1, .022, mat="wood", up=(0, 1, 0), warp=0)
    base = slat + .011
    mx0, mx1, mz0, mz1 = hx0 + .06, hx1 - .06, z0 + .04, z1 - .04

    def mattress_top(x, z):
        e = min(x - mx0, mx1 - x, z - mz0, mz1 - z)
        return base + .13 * min(1.0, max(e, 0) / .06) ** .5

    def mattress_y(x, z):
        """The mattress's real top, quilting included (the blanket and pillow lie on this)."""
        u, v = (x - mx0) / (mx1 - mx0), (z - mz0) / (mz1 - mz0)
        top = mattress_top(x, z)
        return top + .004 * math.sin(u * 23) * math.sin(v * 9) * (top > base + .12)

    def mattress(u, v):
        x, z = mx0 + u * (mx1 - mx0), mz0 + v * (mz1 - mz0)
        return np.array((x, mattress_y(x, z), z))
    # Surfaces whose u runs +x and v +z face down unless flipped; the bake reads which way a part faces.
    m.surface("canvas", mattress, 40, 16, (mx1 - mx0, mz1 - mz0), flip=True, metres_per_uv=1)

    def pillow(u, v):
        x, z = mx0 + .05 + u * .36, mz0 + .1 + v * (mz1 - mz0 - .2)
        e = min(u, 1 - u, v, 1 - v)
        return np.array((x, mattress_y(x, z) + .001 + .11 * min(1.0, e * 4) ** .7, z))
    m.surface("canvas", pillow, 10, 14, (.36, mz1 - mz0 - .2), flip=True, metres_per_uv=1)
    # A wool blanket thrown over the foot two-thirds of the bed: across the mattress, over the side rail, hanging down outside it.
    rail_top = rail + .045
    # Across the mattress, over the slat ends, round the side rail's outer flank, then straight down.
    drape = [(mz0 - .01, None), (mz1, base + .002), (z1 - .005, base + .003), (z1 + .031, rail + .035), (z1 + .049, rail - .02), (z1 + .051, rail - .2)]

    def drape_at(s_, x):
        pts = [(z, mattress_y(x, min(max(z, mz0), mz1)) + .002 if y is None else y) for z, y in drape]
        lengths = [0.0]
        for (za, ya), (zb, yb) in zip(pts, pts[1:]):
            lengths.append(lengths[-1] + math.hypot(zb - za, yb - ya))
        s_ *= lengths[-1]
        for k in range(len(pts) - 1):
            if s_ <= lengths[k + 1] or k == len(pts) - 2:
                t = (s_ - lengths[k]) / max(lengths[k + 1] - lengths[k], 1e-9)
                za, ya = pts[k]
                zb, yb = pts[k + 1]
                z = za + (zb - za) * t
                y = mattress_y(x, z) + .002 if k == 0 else ya + (yb - ya) * t
                return z, y

    def blanket(u, v):
        x = mx0 + .5 + u * (mx1 - mx0 - .48)
        z, y = drape_at(v, x)
        fold = .012 * max(0.0, math.sin(u * 13 + v * 4)) * max(0.0, math.sin(u * 5 - 1))
        return np.array((x, y + fold * (z < mz1), z + fold * .5 * (z > z1)))
    m.surface("blanket", blanket, 26, 24, (mx1 - mx0 - .48, 1.2), flip=True, metres_per_uv=1)
    m.collide_box((hx0 + hx1) / 2, (z0 + z1) / 2, (hx1 - hx0) / 2 + .06, (z1 - z0) / 2 + .06, FLOOR, FLOOR + .7, tag="bed")

    # A hurricane lantern hung on a wire from the ridge log over the table, lit day and night. Its light is baked into the cabin
    # (tiled.py, lamps): a real light would shine through the log walls onto the ground outside, and a shadowed one costs every
    # pixel on screen. The game scales the bake by the lantern's brightness (prop-materials.ts).
    lx, lz, ly = .78, 0.0, FLOOR + 2.0
    ridge_bottom = rafter_axis(0) - RAFTER_R - .13 + .01 - .13
    # Fount: profile heights are fractions of its 85 mm.
    m.lathe([(0, 0), (.068, .0), (.075, .24), (.075, .7), (.05, .94), (.03, 1), (0, 1)], (lx, ly, lz), (lx, ly + .085, lz), "tin", 18)
    m.lathe([(.03, 0), (.055, .2), (.065, .5), (.055, .8), (.03, 1), (0, 1)], (lx, ly + .085, lz), (lx, ly + .26, lz), "lamp_glow", 18)
    m.lathe([(0, 0), (.06, 0), (.065, .3), (.035, .7), (.02, 1), (0, 1)], (lx, ly + .26, lz), (lx, ly + .34, lz), "tin", 16)
    for k in range(4):
        a = k * math.pi / 2 + .4
        ox, oz = math.cos(a), math.sin(a)
        m.tube([(lx + ox * .07, ly + .075, lz + oz * .07), (lx + ox * .075, ly + .17, lz + oz * .075), (lx + ox * .066, ly + .27, lz + oz * .066)], .0035, "iron", 5)
    m.tube([(lx - .072, ly + .27, lz), (lx - .06, ly + .4, lz), (lx, ly + .44, lz), (lx + .06, ly + .4, lz), (lx + .072, ly + .27, lz)], .0035, "iron", 5)
    m.tube([(lx, ly + .435, lz), (lx, ridge_bottom + .01, lz)], .0025, "iron", 4)
    m.lamps = [dict(at=(lx, ly + .17, lz), radius=.025)]
    m.hook("lamp", (lx, ly + .17, lz))

    tx, tz = 1.0, -.6
    m.plank((tx - .7, FLOOR + .76, tz - .2), (tx + .7, FLOOR + .76, tz - .2), .2, .045, mat="wood", warp=.002)
    m.plank((tx - .7, FLOOR + .762, tz), (tx + .7, FLOOR + .762, tz), .2, .045, mat="wood", warp=.002)
    m.plank((tx - .7, FLOOR + .758, tz + .2), (tx + .7, FLOOR + .758, tz + .2), .2, .045, mat="wood", warp=.002)
    for sx in (-.58, .58):
        for sz in (-.24, .24):
            hq.round_log(m, (tx + sx, FLOOR, tz + sz), (tx + sx * 1.02, FLOOR + .74, tz + sz), .04, "logwood", caps=(False, False))
        m.beam((tx + sx, FLOOR + .66, tz - .27), (tx + sx, FLOOR + .66, tz + .27), .05, .08, "wood_dark")
    m.collide_box(tx, tz, .72, .32, FLOOR, FLOOR + .8, tag="table")
    for sx, sz in ((-.3, .6), (.55, .55)):
        hq.round_log(m, (tx + sx, FLOOR, tz + sz), (tx + sx, FLOOR + .44, tz + sz), .17, "bark", taper=0, caps=(False, True), bevel=.008)
    # On the table: a tin plate, a cup, a hurricane lamp.
    m.lathe([(0, 0), (.1, .002), (.12, .02), (.125, .025)], (tx - .25, FLOOR + .785, tz + .05), (tx - .25, FLOOR + .81, tz + .05), "tin", 18)
    m.lathe([(0, 0), (.04, 0), (.042, 1), (.038, 1)], (tx + .05, FLOOR + .785, tz - .1), (tx + .05, FLOOR + .875, tz - .1), "iron", 14)
    m.lathe([(0, 0), (.07, .0), (.075, .08), (.05, .14), (.06, .3), (.04, .33), (.0, .34)], (tx + .4, FLOOR + .785, tz + .05), (tx + .4, FLOOR + 1.08, tz + .05), "tin", 14)

    # Shelves between the back window and the bunk.
    sz = -D + R + .11
    for y in (FLOOR + 1.25, FLOOR + 1.65):
        m.plank((1.0, y, sz), (2.0, y, sz), .22, .03, mat="wood", warp=0)
        for x in (1.12, 1.88):
            # A bracket: an arm under the shelf and a strut back to the wall.
            m.beam((x, y - .035, -D + R - .01), (x, y - .035, sz + .09), .04, .04, "wood_dark", up=(0, 1, 0))
            m.beam((x, y - .05, sz + .05), (x, y - .26, -D + R + .0), .035, .035, "wood_dark", up=(1, 0, 0))
        for i in range(rng.randrange(3, 6)):
            x = 1.1 + rng.random() * .8
            h = rng.uniform(.09, .16)
            rr = rng.uniform(.035, .05)
            m.lathe([(0, 0), (rr, 0), (rr, 1), (rr * .8, 1)], (x, y + .015, sz + rng.uniform(-.04, .04)), (x, y + .015 + h, sz), "tin" if i % 2 else "iron", 12)

    # A wood box by the fireplace, half full.
    wx, wz = -W + .45, .55
    for zz in (wz - .3, wz + .3):
        m.plank((wx - .25, FLOOR + .2, zz), (wx + .25, FLOOR + .2, zz), .4, .025, mat="wood_dark", up=(0, 0, 1), warp=0)
    for xx in (wx - .25, wx + .25):
        m.plank((xx, FLOOR + .2, wz - .3), (xx, FLOOR + .2, wz + .3), .4, .025, mat="wood_dark", up=(1, 0, 0), warp=0)
    hq.settle_split_pile(m, "x", "z", FLOOR, wz - .27, wz + .26, 3, wx, (.055, .085), (.38, .44), max_height=FLOOR + .36)
    m.collide_box(wx, wz, .28, .33, FLOOR, FLOOR + .42, tag="wood box")

    # -- colliders ------------------------------------------------------------------------------------------------------
    t = .16
    m.collide_box(0, -D, W + .1, t, 0, PLATE_TOP, tag="cabin wall")
    m.collide_box(-W, 0, t, D + .1, 0, PLATE_TOP, tag="cabin wall")
    m.collide_box(W, 0, t, D + .1, 0, PLATE_TOP, tag="cabin wall")
    m.collide_box((-W + DOOR[0]) / 2, D, (DOOR[0] + W) / 2, t, 0, PLATE_TOP, tag="cabin wall")
    m.collide_box((W + DOOR[1]) / 2, D, (W - DOOR[1]) / 2, t, 0, PLATE_TOP, tag="cabin wall")
    m.collide_box((DOOR[0] + DOOR[1]) / 2, D, (DOOR[1] - DOOR[0]) / 2, t, DOOR_HEAD, PLATE_TOP, tag="door lintel")
    m.collide_box(0, 1.08, W + .2, D + 1.14, 0, FLOOR, tag="cabin floor")
    m.collide_box(-.7, D + 2.45, .8, .15, 0, FLOOR - .15, tag="step")
    m.collide_box(-.7, D + 2.77, .8, .15, 0, FLOOR - .29, tag="step")
    m.radius = 9
    return m


SHOTS = [((8.5, 1.7, 11.5), (0, 1.9, 1), 34), ((-9.5, 1.7, 7.5), (-.5, 2.1, 0), 36), ((.8, 1.65, 7.6), (.6, 1.1, 3), 40)]
