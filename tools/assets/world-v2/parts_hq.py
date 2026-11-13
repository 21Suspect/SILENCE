"""Detailed parts for tiled buildings (tiled.py): round logs with bevelled, sawn ends; masonry displaced by the scan's own
height map; corrugated iron with the real profile; split firewood; boards cut to a slope.

Every part emits metric UVs (metres_per_uv=1): tiled.py divides them by the library entry's repeat. Grain runs along v.
"""
import math

import numpy as np

import library
from kit import frame_along, norm


def _grid_normals(grid, wrap_u=False):
    """Smooth normals of a (rows, cols, 3) grid: rows run along v, cols along u."""
    if wrap_u:
        du = np.roll(grid, -1, 1) - np.roll(grid, 1, 1)
        # The seam column repeats the first: take its neighbours across the seam.
        du[:, 0] = grid[:, 1] - grid[:, -2]
        du[:, -1] = du[:, 0]
    else:
        du = np.gradient(grid, axis=1)
    dv = np.gradient(grid, axis=0)
    n = np.cross(du, dv)
    return n / np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-9)


def _grid_faces(rows, cols, flip=False):
    faces = []
    for j in range(rows - 1):
        for i in range(cols - 1):
            f = (j * cols + i, j * cols + i + 1, (j + 1) * cols + i + 1, (j + 1) * cols + i)
            faces.append(f[::-1] if flip else f)
    return faces


def round_log(m, a, b, r, mat="logwood", cap="endgrain", sides=22, seg=.28, taper=.1, sweep=.025, wobble=.03,
              caps=(True, True), bevel=.016, cut_tilt=.05):
    """A peeled log from a to b. The butt is at a (wider by `taper`), the section is never quite round, the axis bows a
    little, and each end is sawn a few degrees off square with its arris knocked off before the end grain."""
    rng = m.rng
    a, b = np.asarray(a, float), np.asarray(b, float)
    x, y, z = frame_along(a, b)
    length = float(np.linalg.norm(b - a))
    rings = max(2, int(math.ceil(length / seg))) + 1
    t = np.linspace(0, 1, rings)
    radius = r * (1 + taper * (.5 - t))
    # Out-of-round: low harmonics of the section, drifting along the log.
    harm = [(k, rng.uniform(.4, 1) * wobble / k ** .6, rng.uniform(0, 6.3), rng.uniform(-1.2, 1.2)) for k in (2, 3, 4, 5)]
    bow = np.array((rng.uniform(-1, 1), rng.uniform(-1, 1))) * sweep
    bump = [(rng.uniform(1.5, 4.5), rng.uniform(0, 6.3), rng.uniform(.004, .01)) for _ in range(3)]
    th = np.linspace(0, 2 * math.pi, sides + 1)
    grid = np.zeros((rings, sides + 1, 3))
    for i, ti in enumerate(t):
        centre = a + (b - a) * ti + (x * bow[0] + y * bow[1]) * math.sin(math.pi * ti)
        shape = 1 + sum(amp * np.cos(k * th + ph + drift * ti * length) for k, amp, ph, drift in harm)
        shape += sum(h * math.sin(f * ti * length + p) for f, p, h in bump) / r
        rr = radius[i] * shape
        d = np.outer(np.cos(th), x) + np.outer(np.sin(th), y)
        grid[i] = centre + d * rr[:, None]
    # Sawn ends a little off square.
    tilt = [np.array((rng.uniform(-1, 1), rng.uniform(-1, 1))) * cut_tilt for _ in range(2)]
    for end, i in ((0, 0), (1, rings - 1)):
        d = grid[i] - (a if end == 0 else b)
        grid[i] += np.outer(d @ x * tilt[end][0] + d @ y * tilt[end][1], z)
    circumference = 2 * math.pi * r
    off_u, off_v = rng.random() * 20, rng.random() * 20
    uu = np.broadcast_to(th / (2 * math.pi) * circumference, (rings, sides + 1)) + off_u
    vv = np.broadcast_to((t * length)[:, None], (rings, sides + 1)) + off_v
    normals = _grid_normals(grid, wrap_u=True)
    m.add(mat, grid.reshape(-1, 3), normals.reshape(-1, 3), np.stack((uu, vv), -1).reshape(-1, 2), _grid_faces(rings, sides + 1), metres_per_uv=1)
    for end, i in ((0, 0), (1, rings - 1)):
        if not caps[end]:
            continue
        sign = -1 if end == 0 else 1
        ring = grid[i, :-1]
        centre = ring.mean(axis=0)
        # Bevel: a narrow band turning from the face to the end, in the face material.
        inner = centre + (ring - centre) * (1 - bevel / r) + z * sign * bevel * .55
        band = np.stack((np.vstack((ring, ring[:1])), np.vstack((inner, inner[:1]))))
        radial = norm_rows(band[0] - centre)
        bn = np.vstack((norm_rows(radial + z * sign * .45), norm_rows(radial * .55 + z * sign)))
        bu = np.broadcast_to(th / (2 * math.pi) * circumference, (2, sides + 1)) + off_u
        bv = np.array([[0.0], [bevel]]) * np.ones((2, sides + 1)) + off_v + (0 if end == 0 else length)
        m.add(mat, band.reshape(-1, 3), bn, np.stack((bu, bv), -1).reshape(-1, 2), _grid_faces(2, sides + 1, flip=sign < 0), metres_per_uv=1, density=.6)
        # End grain: the cap's own disc, in a unit square about the log's centre.
        reach = np.linalg.norm(inner - centre, axis=1).max()
        local = np.stack(((inner - centre) @ x, (inner - centre) @ y), -1) / (2 * reach) + .5
        verts = np.vstack((centre + z * sign * bevel * .55, inner))
        uv = np.vstack(((.5, .5), local))
        nrm = np.tile(z * sign, (len(verts), 1))
        faces = [(0, 1 + j, 1 + (j + 1) % sides) if sign > 0 else (0, 1 + (j + 1) % sides, 1 + j) for j in range(sides)]
        # Unit-disc UVs with metres_per_uv = the disc's width: the macro atlas sizes the island right, and the end grain
        # (tiled.py) takes the disc whole.
        m.add(cap, verts, nrm, uv, faces, metres_per_uv=2 * reach, density=.8)
    return grid


def norm_rows(v):
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-9)


_heights = {}


def height_map(lib):
    """The scan's height (0..1) as a float array, rows top-down, sampled with wrap."""
    if lib not in _heights:
        import bpy
        img = bpy.data.images.load(library.height_path(lib), check_existing=True)
        img.colorspace_settings.name = "Non-Color"
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
        _heights[lib] = px.reshape(h, w, 4)[::-1, :, 0].copy()
    return _heights[lib]


def sample_height(hm, u, v):
    """Bilinear, wrapping; u, v in repeats (v up, as tile UVs)."""
    h, w = hm.shape
    fx = (np.asarray(u) % 1) * w - .5
    fy = (1 - np.asarray(v) % 1) * h - .5
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    ax, ay = fx - x0, fy - y0
    x0, y0, x1, y1 = x0 % w, y0 % h, (x0 + 1) % w, (y0 + 1) % h
    return (hm[y0, x0] * (1 - ax) * (1 - ay) + hm[y0, x1] * ax * (1 - ay) + hm[y1, x0] * (1 - ax) * ay + hm[y1, x1] * ax * ay)


def masonry_face(m, origin, along, up, width, height, depth, mat="stone", lib="fieldstone", step=.035, inset=(0, 0, 0, 0),
                 off=(0.0, 0.0), out=None, taper=0.0):
    """One face of a stone wall: a flat rectangle `width` x `height` (origin at its lower left, `along` and `up` unit
    vectors, facing along +out) pushed out by the scan's height map up to `depth`, so each stone in the picture stands out
    of the mortar by its real relief and casts its own shadow. `inset` (left, right, bottom, top) fades the relief to 0
    over that many metres at each edge, so faces meet clean at corners. `taper` narrows the face towards its top."""
    origin, along, up = (np.asarray(v, float) for v in (origin, along, up))
    out = norm(np.cross(along, up)) if out is None else norm(np.asarray(out, float))
    hm = height_map(lib)
    metres = library.LIBRARY[lib]["metres"]
    nu, nv = max(2, int(round(width / step))) + 1, max(2, int(round(height / step))) + 1
    s = np.linspace(0, 1, nu)
    tt = np.linspace(0, 1, nv)
    S, T = np.meshgrid(s, tt)
    shrink = 1 - taper * T
    U = (S - .5) * width * shrink + width / 2
    V = T * height
    # Heights: the scan's 0..1 relief around its own median, so mortar sits back and stones stand forward.
    H = sample_height(hm, (U + off[0]) / metres, (V + off[1]) / metres)
    H = np.clip((H - np.median(hm)) * 2.2 + .5, 0, 1)
    left, right, bottom, top = inset
    fade = np.ones_like(H)
    for dist, w in ((U - (width - width * shrink) / 2, left), ((width + width * shrink) / 2 - U, right), (V, bottom), (height - V, top)):
        if w > 0:
            fade *= np.clip(dist / w, 0, 1) ** .7
    grid = origin + U[..., None] * along + V[..., None] * up + (H * fade * depth)[..., None] * out
    normals = _grid_normals(grid)
    if (normals.reshape(-1, 3) @ out).mean() < 0:
        normals = -normals
        faces = _grid_faces(nv, nu, flip=True)
    else:
        faces = _grid_faces(nv, nu)
    uv = np.stack((U + off[0], V + off[1]), -1)
    m.add(mat, grid.reshape(-1, 3), normals.reshape(-1, 3), uv.reshape(-1, 2), faces, metres_per_uv=1)
    return grid


def masonry_block(m, centre, half, y0, y1, mat="stone", depth=.035, step=.035, taper=0.0, top=True, faces=(0, 1, 2, 3), cap_mat=None):
    """A rectangular stone mass (chimney, pier, plinth run) on the XZ plane: four displaced faces meeting at clean corners,
    and a flat cap. `half` is (hx, hz) at the bottom; `taper` narrows it towards y1."""
    cx, cz = centre
    hx, hz = half
    h = y1 - y0
    rng = m.rng
    sides = [  # origin (lower left seen from outside), along, out, width
        ((cx - hx, y0, cz + hz), (1, 0, 0), (0, 0, 1), 2 * hx),
        ((cx + hx, y0, cz - hz), (-1, 0, 0), (0, 0, -1), 2 * hx),
        ((cx + hx, y0, cz + hz), (0, 0, -1), (1, 0, 0), 2 * hz),
        ((cx - hx, y0, cz - hz), (0, 0, 1), (-1, 0, 0), 2 * hz),
    ]
    for k in faces:
        o, al, out, w = sides[k]
        o, al, out = np.asarray(o, float), np.asarray(al, float), np.asarray(out, float)
        # A tapering face leans in: its top edge sits taper * half-width in from its bottom one.
        lean = (hx if k > 1 else hz) * taper
        up = norm(np.array((0, h, 0)) - out * lean)
        height = math.hypot(h, lean)
        masonry_face(m, o, al, up, w, height, depth, mat, step=step, inset=(.05, .05, 0, .02), off=(rng.random() * 9, rng.random() * 9), out=out, taper=taper)
    if top:
        tx, tz = hx * (1 - taper), hz * (1 - taper)
        v = [(cx - tx, y1, cz - tz), (cx + tx, y1, cz - tz), (cx + tx, y1, cz + tz), (cx - tx, y1, cz + tz)]
        m.add(cap_mat or mat, v, [(0, 1, 0)] * 4, [(p[0], p[2]) for p in v], [(3, 2, 1, 0)], metres_per_uv=1, density=.5)


def corrugated(m, origin, along, down, width, length, pitch=.076, depth=.018, mat="tin", droop=0.0, curl=0.0, lift_edge=0.0,
               per_wave=6, under=True, lap=0.0):
    """A corrugated iron sheet: `along` runs across the ribs, `down` down the slope; its troughs lie on the plane through
    `origin`. The rib is a true sine of `pitch` and `depth`; `droop` sags it between supports, `curl` lifts its lower end,
    `lift_edge` peels one side up, `lap` raises its first rib onto the neighbour it overlaps. Returns `at(x, y)`: the top
    surface's position over (x across, y down) metres, for fixings."""
    rng = m.rng
    origin, along, down = np.asarray(origin, float), norm(along), norm(down)
    up = np.cross(down, along)
    if up[1] < 0:
        up = -up
    waves = max(1, int(round(width / pitch)))
    width = waves * pitch

    def lift(X, Y):
        S, T = X / width, Y / length
        rib = depth * .5 * (1 - np.cos(S * waves * 2 * math.pi))
        sag = -droop * np.sin(T * math.pi * max(1, length / 1.0)) ** 2 * .5
        bend = curl * np.clip(T - .6, 0, 1) ** 2 / .16 + lift_edge * np.clip(S - .75, 0, 1) ** 2 / .0625 * T
        over = lap * np.clip(1.4 - X / pitch, 0, 1) ** 2 if lap else 0.0
        return rib + sag + bend + over

    nu = waves * per_wave + 1
    nv = max(3, int(math.ceil(length / .35)) + 1)
    X, Y = np.meshgrid(np.linspace(0, width, nu), np.linspace(0, length, nv))
    grid = origin + X[..., None] * along + Y[..., None] * down + lift(X, Y)[..., None] * up
    normals = _grid_normals(grid)
    flip = (normals.reshape(-1, 3) @ up).mean() < 0
    if flip:
        normals = -normals
    uv = np.stack((X + rng.random() * 9, Y + rng.random() * 9), -1)
    m.add(mat, grid.reshape(-1, 3), normals.reshape(-1, 3), uv.reshape(-1, 2), _grid_faces(nv, nu, flip=flip), metres_per_uv=1)
    if under:
        # Its own underside, a millimetre down: one double-sided sheet would share the sunlit top's baked light (macro map)
        # and glow over a dark room.
        below = grid - up * .0012
        m.add(mat, below.reshape(-1, 3), -normals.reshape(-1, 3), uv.reshape(-1, 2), _grid_faces(nv, nu, flip=not flip), metres_per_uv=1, density=.7)

    def at(x, y):
        return origin + along * x + down * y + up * float(lift(np.array(x), np.array(y)))
    at.crests = [(k + .5) * pitch for k in range(waves)]
    at.up = up
    return at


def prism(m, outline, along, up, out, thickness, mat="wood", grain_up=True):
    """A flat board of any convex outline: `outline` is [(s, t)] in metres in the plane (along, up), extruded `thickness`
    towards -out. Grain runs along `up` when grain_up."""
    along, up, out = (norm(np.asarray(v, float)) for v in (along, up, out))
    pts = [np.asarray(p, float) for p in outline]
    rng = m.rng
    ou, ov = rng.random() * 9, rng.random() * 9
    front = [along * s + up * t for s, t in pts]
    back = [p - out * thickness for p in front]
    uvf = [((s if grain_up else t) + ou, (t if grain_up else s) + ov) for s, t in pts]
    n = len(pts)
    # Winding must agree with the normals: a double-sided material flips the normal of a face seen from its back.
    ccw = np.cross(front[1] - front[0], front[2] - front[0]) @ out > 0
    order = tuple(range(n)) if ccw else tuple(range(n - 1, -1, -1))
    m.add(mat, front, [out] * n, uvf, [order], metres_per_uv=1)
    m.add(mat, back, [-out] * n, uvf, [order[::-1]], metres_per_uv=1, density=.4)
    for i in range(n):
        j = (i + 1) % n
        e = front[j] - front[i]
        en = norm(np.cross(e, out))
        if en @ (front[i] - sum(front) / n) < 0:
            en = -en
        L = float(np.linalg.norm(e))
        m.add(mat, [front[i], front[j], back[j], back[i]], [en] * 4, [(ou, ov), (ou, ov + L), (ou + thickness, ov + L), (ou + thickness, ov)],
              [(0, 3, 2, 1)] if np.cross(e, -out * thickness) @ en < 0 else [(0, 1, 2, 3)], metres_per_uv=1, density=.4)


def split_outline(r, a0, a1, wob):
    """The cross-section of a split piece in its own frame (kit.frame_along about its axis): the heart, then the arc."""
    angs = np.linspace(a0, a1, len(wob))
    mid = (a0 + a1) / 2
    pts = [np.array((math.cos(mid), math.sin(mid))) * r * .06]
    pts += [np.array((math.cos(t), math.sin(t))) * r * w for t, w in zip(angs, wob)]
    return np.array(pts)


def split_piece(m, centre, axis, length, r, a0, a1, bark="bark", face="wood_fresh", cap="endgrain", sides=7, wob=None):
    """A piece of split firewood: the sector a0..a1 (radians) of a log of radius r, bark on the arc, split faces along its
    two radii, end grain on both ends cut from the same disc, so its rings line up with the arc."""
    rng = m.rng
    centre, axis = np.asarray(centre, float), norm(axis)
    x, y, _ = frame_along(centre, centre + axis)
    half = length / 2
    angs = np.linspace(a0, a1, sides + 1)
    if wob is None:
        wob = 1 + .04 * np.sin(angs * 3 + rng.random() * 6)
    ends = [centre - axis * half * (1 + rng.uniform(-.06, .06)), centre + axis * half * (1 + rng.uniform(-.06, .06))]
    arc = [[e + (x * math.cos(t) + y * math.sin(t)) * r * w for t, w in zip(angs, wob)] for e in ends]
    # Bark on the arc.
    verts = arc[0] + arc[1]
    nrm = [x * math.cos(t) + y * math.sin(t) for t in angs] * 2
    circ = r * (a1 - a0)
    ou, ov = rng.random() * 9, rng.random() * 9
    uv = [(ou + i / sides * circ, ov) for i in range(sides + 1)] + [(ou + i / sides * circ, ov + length) for i in range(sides + 1)]
    faces = [(i, i + 1, sides + 2 + i, sides + 1 + i) for i in range(sides)]
    m.add(bark, verts, nrm, uv, faces, metres_per_uv=1, density=.6)
    # Split faces: from the heart line (inset a little, the pith rarely splits clean) out to each edge of the arc.
    heart = [e + (x * math.cos((a0 + a1) / 2) + y * math.sin((a0 + a1) / 2)) * r * .06 for e in ends]
    for edge, sgn in ((0, -1), (sides, 1)):
        p = [heart[0], arc[0][edge], arc[1][edge], heart[1]]
        n_ = norm(np.cross(p[1] - p[0], p[3] - p[0])) * sgn
        if n_ @ (x * math.cos((a0 + a1) / 2) + y * math.sin((a0 + a1) / 2)) > 0:
            n_ = -n_
        w = r * .95
        ru, rv = rng.random() * 9, rng.random() * 9
        quad = [(ru, rv), (ru + w, rv), (ru + w, rv + length), (ru, rv + length)]
        f = (0, 1, 2, 3) if np.cross(p[1] - p[0], p[3] - p[0]) @ n_ > 0 else (3, 2, 1, 0)
        m.add(face, p, [n_] * 4, quad, [f], metres_per_uv=1, density=.6)
    # End grain: the same disc the log would have shown, so the rings follow the arc.
    for k, sign in ((0, -1), (1, 1)):
        pts = [heart[k]] + arc[k]
        uv = [(.5 + .5 * ((q - ends[k]) @ x) / (r * 1.06), .5 + .5 * ((q - ends[k]) @ y) / (r * 1.06)) for q in pts]
        faces = [(0, i + 1, i + 2) if sign > 0 else (0, i + 2, i + 1) for i in range(sides)]
        m.add(cap, pts, [axis * sign] * len(pts), uv, faces, metres_per_uv=2 * r * 1.06, density=.6)


def _span_profile(xs, ys, grid, upper):
    """The upper (or lower) envelope of a closed 2D outline sampled at `grid` x positions (nan outside it)."""
    out = np.full(len(grid), np.nan)
    n = len(xs)
    for i in range(n):
        x0, y0, x1, y1 = xs[i], ys[i], xs[(i + 1) % n], ys[(i + 1) % n]
        lo, hi = min(x0, x1), max(x0, x1)
        sel = (grid >= lo) & (grid <= hi)
        if not sel.any():
            continue
        y = np.full(sel.sum(), max(y0, y1) if upper else min(y0, y1)) if hi - lo < 1e-9 else y0 + (grid[sel] - x0) / (x1 - x0) * (y1 - y0)
        cur = out[sel]
        out[sel] = np.where(np.isnan(cur), y, np.maximum(cur, y) if upper else np.minimum(cur, y))
    return out


def settle_split_pile(m, along, across, bed, start, stop, layers, axis_pos, r_range, length_range, gap=(.0, .012), tries=6,
                      floor_y=None, bark="bark", face="wood_fresh", cap="endgrain", max_height=None):
    """Stack split firewood the way it settles: pieces lie with their axes along `along` ('x' or 'z'), laid side by side
    across the pile (`across`, the other horizontal axis) from `start` to `stop`, and each is dropped straight down onto
    what is already there (the skyline of the pile so far, `bed` underneath: a height or a function of the across
    position). Of a few random turns the one that comes to rest lowest is kept, which is the flat side down a stacker
    would choose. Nothing is placed in the air: every piece rests on the bed or on pieces below it.
    Returns the resting top of the pile."""
    rng = m.rng
    step = .002
    grid = np.arange(min(start, stop) - .3, max(start, stop) + .3, step)
    bed_h = np.array([bed(g) if callable(bed) else bed for g in grid], float)
    sky = bed_h.copy()
    axis = np.array((1.0, 0, 0)) if along == "x" else np.array((0, 0, 1.0))
    x_l, y_l, _ = frame_along(np.zeros(3), axis)
    # A piece's local x and y in (across, up) coordinates.
    ax_x = x_l[2] if along == "x" else x_l[0]
    ax_y = y_l[1]
    placed = 0
    for layer in range(layers):
        pos = start + rng.uniform(0, .04)
        while pos < stop:
            r = rng.uniform(*r_range)
            a = rng.uniform(1.3, 2.3)
            sides = 7
            wob0 = rng.random() * 6
            best = None
            for _ in range(tries):
                a0 = rng.uniform(0, 2 * math.pi)
                angs = np.linspace(a0, a0 + a, sides + 1)
                wob = 1 + .04 * np.sin(angs * 3 + wob0)
                o = split_outline(r, a0, a0 + a, wob)
                xs, ys = o[:, 0] * ax_x, o[:, 1] * ax_y
                w0, w1 = xs.min(), xs.max()
                cx = pos - w0
                low = _span_profile(xs + cx, ys, grid, upper=False)
                ok = ~np.isnan(low)
                if not ok.any():
                    continue
                yc = float(np.max(sky[ok] - low[ok]))
                if best is None or yc + ys.min() < best[0]:
                    best = (yc + ys.min(), yc, a0, wob, xs, ys, cx, w1 - w0)
            _, yc, a0, wob, xs, ys, cx, width = best
            if max_height is not None and yc + ys.max() > max_height:
                pos += width
                continue
            up = _span_profile(xs + cx, ys + yc, grid, upper=True)
            ok = ~np.isnan(up)
            sky[ok] = np.maximum(sky[ok], up[ok])
            length = rng.uniform(*length_range)
            centre = np.array((axis_pos + rng.uniform(-.03, .03), yc, cx)) if along == "x" else np.array((cx, yc, axis_pos + rng.uniform(-.03, .03)))
            split_piece(m, centre, axis, length, r, a0, a0 + a, bark=bark, face=face, cap=cap, sides=sides, wob=wob)
            placed += 1
            pos += width + rng.uniform(*gap)
    return placed, float(sky.max())
