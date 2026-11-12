"""Four head concepts for the Listener. None of them are skulls.

Every concept keeps the original's long hanging head and neck, and the white
dot eyes. Each returns (head field, teeth field or None, eye list).
Eyes are (position, radius) in head-local space.
"""
import numpy as np

import anatomy as A
from anatomy import HEAD_CENTRE, HEAD_H, bump, egg, ridge, snap, translate
from sdf import Field, box, capsule, catmull, fbm, perlin, smoothstep

TAGS = ("mouth", "socket", "neck", "bone", "gum")
BOUNDS = ((-0.3, -0.56, -0.6), (0.3, 0.8, 0.31))


def base(h, width=1.0):
    f = Field(*BOUNDS, h, TAGS)
    if width == 1.0:
        f.union(egg, ((-0.2, -HEAD_H, -0.24), (0.2, HEAD_H, 0.22)), 0.0)
    else:
        f.union(lambda p: egg((p[0] / width, p[1], p[2])), ((-0.2 * width, -HEAD_H, -0.24), (0.2 * width, HEAD_H, 0.22)), 0.0)
    neck = [(0, 0.12, -0.085), (0, 0.32, -0.17), (0, 0.56, -0.29), (0, 0.78, -0.47)]
    f.add_tube(neck, [0.105, 0.096, 0.104, 0.14], 0.08, "neck")
    for t in np.linspace(0.0, 1, 10):
        c = np.array((0.0, 0.25 + 0.53 * t, -0.262 - 0.3 * t**1.5))
        f.add_ellipsoid(c, (0.022, 0.021, 0.028), 0.022, "bone")
    for s in (-1, 1):
        ridge(f, [(s * 0.13, 0.02, -0.06), (s * 0.098, 0.3, -0.13), (s * 0.1, 0.72, -0.34)], 0.013, 0.012, "neck")
        ridge(f, [(s * 0.075, 0.2, -0.17), (s * 0.08, 0.5, -0.3), (s * 0.09, 0.74, -0.5)], 0.01, 0.009, "neck")
    return f


def flesh(f, seed=3, brow=1.0):
    """Wasted human structure under the skin, so no concept reads as a balloon."""
    rng = np.random.default_rng(seed)
    for s in (-1, 1):
        j = rng.normal(0, 0.006, 4)
        bump(f, (s * 0.165, 0.19, 0.05 + j[0]), (0.038, 0.095, 0.08), -0.024)   # temple
        bump(f, (s * 0.124, 0.036 + j[1], 0.135), (0.05, 0.02, 0.05), 0.016, "bone")   # cheekbone
        bump(f, (s * 0.128, -0.1 + j[2], 0.1), (0.05, 0.105, 0.07), -0.04)   # hollow cheek
        bump(f, (s * 0.105, -0.285 + j[3], 0.06), (0.026, 0.055, 0.04), 0.011, "bone")   # jaw angle
        bump(f, (s * 0.075, 0.2, 0.175), (0.06, 0.014, 0.03), 0.006 * brow, "bone")   # brow bone
        ridge(f, [(s * 0.122, 0.04, 0.12), (s * 0.115, -0.09, 0.105), (s * 0.104, -0.21, 0.09), (s * 0.09, -0.33, 0.056)], 0.0065, 0.0075)
        ridge(f, [(s * 0.15, -0.02, 0.05), (s * 0.135, -0.16, 0.04), (s * 0.11, -0.3, 0.02)], 0.006, 0.006)
    # Forehead creases and the slack line under the jaw.
    for i in range(4):
        y = 0.25 + i * 0.03 + rng.normal(0, 0.004)
        ridge(f, [(-0.13, y + 0.005, 0.1), (-0.05, y - 0.006, 0.18), (0.05, y + 0.004, 0.18), (0.13, y - 0.004, 0.1)], 0.0038, -0.0028)


def finish(f, amount=1.0):
    def tissue(q):
        x, y, z = q
        slack = fbm(x * 8, y * 22, z * 8, 3) * 0.0036
        return (perlin(x * 26, y * 5.5, z * 26) * 0.0034 + fbm(x * 13, y * 13, z * 13, 3) * 0.0044 + slack) * amount

    f.displace(tissue, 0.02)
    f.place = translate(HEAD_CENTRE)
    return f


def on_face(f, pts):
    """Project rough points from in front onto the current surface."""
    return snap(f, np.asarray(pts, float))


def teeth_box(f, centre, tangent, up, half, r, tag):
    """A flat, blunt human tooth, oriented along the jawline."""
    tangent, up = np.asarray(tangent, float), np.asarray(up, float)
    tangent /= np.linalg.norm(tangent)
    up = up - tangent * up.dot(tangent)
    up /= np.linalg.norm(up)
    out = np.cross(tangent, up)
    c = np.asarray(centre, float)

    def fn(p):
        q = [p[i] - c[i] for i in range(3)]
        lx = q[0] * tangent[0] + q[1] * tangent[1] + q[2] * tangent[2]
        ly = q[0] * up[0] + q[1] * up[1] + q[2] * up[2]
        lz = q[0] * out[0] + q[1] * out[1] + q[2] * out[2]
        return box((lx, ly, lz), (0, 0, 0), half, r)

    reach = np.linalg.norm(half) + r
    f.union(fn, (c - reach, c + reach), 0.0009, tag)


# ---------------------------------------------------------------------------
# A: THE GRIN. Almost a person, until you see how far the smile goes.
# ---------------------------------------------------------------------------
def grin_curve(n=56):
    """Crescent from temple to temple, computed before any carving."""
    t = np.linspace(-1, 1, n)
    phi = t * 1.5
    w, d = 0.16, 0.176
    y = -0.175 + 0.19 * np.abs(t) ** 2.2
    return t, phi, np.stack([w * np.sin(phi), y, d * np.cos(phi)], axis=1)


def grin(h, teeth_h):
    f = base(h)
    flesh(f, 11)
    for s in (-1, 1):
        bump(f, (s * 0.108, 0.0, 0.15), (0.05, 0.034, 0.04), 0.02, "bone")   # cheeks shoved upward by the smile
    # A real, long, human nose. It makes everything else worse.
    bump(f, (0, 0.125, 0.2), (0.0105, 0.075, 0.02), 0.014, "bone")
    bump(f, (0, 0.04, 0.205), (0.021, 0.02, 0.022), 0.032)
    for s in (-1, 1):
        bump(f, (s * 0.025, 0.026, 0.195), (0.014, 0.012, 0.015), 0.016)
        f.cut_ellipsoid((s * 0.014, 0.012, 0.222), (0.0078, 0.0058, 0.02), 0.004, "socket")
    # Eyes held wide open, no lids, slightly too far apart.
    eyes = []
    for s, y in ((-1, 0.142), (1, 0.135)):
        c = (s * 0.088, y, 0.2)
        f.cut_ellipsoid(c, (0.036, 0.03, 0.09), 0.01, "socket")
        f.cut_ellipsoid((c[0], y, 0.13), (0.033, 0.028, 0.06), 0.01, "socket")
        eyes.append(((s * 0.088, y - 0.002, 0.098), 0.0088))
        for i, (dy, amp) in enumerate(((0.03, 0.003), (-0.034, 0.003))):
            ridge(f, [(s * 0.046, y + dy, 0.19), (s * 0.088, y + dy * 1.3, 0.195), (s * 0.13, y + dy, 0.14)], 0.0036, -amp)

    t, phi, curve = grin_curve()
    surface = on_face(f, curve)
    out = np.stack([np.sin(phi), np.zeros_like(phi), np.cos(phi)], axis=1)
    radii = 0.003 + 0.028 * np.cos(t * np.pi / 2) ** 0.55
    f.subtract(lambda p: _chain(p, surface, radii), (surface.min(0) - 0.04, surface.max(0) + 0.04), 0.005, "mouth")
    inner = surface - out * 0.03
    f.subtract(lambda p: _chain(p, inner, radii * 1.55), (inner.min(0) - 0.06, inner.max(0) + 0.06), 0.012, "mouth")
    # Stretched lips and the skin splitting at the ends of the smile.
    for lift in (1, -1):
        ridge(f, (surface + np.stack([np.zeros_like(t), lift * radii * 1.02, np.zeros_like(t)], axis=1) + out * 0.002)[::4].tolist(), 0.0042, 0.0034, samples=30)
    for s in (-1, 1):
        for dy, amp in ((0.0, 0.0045), (0.028, 0.0036), (0.056, 0.003)):
            ridge(f, [(s * 0.128, -0.02 + dy, 0.11), (s * 0.148, 0.02 + dy, 0.05), (s * 0.15, 0.05 + dy, -0.02)], 0.0044, -amp)
    finish(f, 1.0)

    teeth = Field((-0.2, -0.32, -0.16), (0.2, 0.05, 0.26), teeth_h, ("upper", "lower"))
    tsurface = surface - out * 0.0065
    rng = np.random.default_rng(12)
    for i in range(2, 54, 1):
        tan = tsurface[i + 1] - tsurface[i - 1]
        for sign in (1, -1):
            # Each row stops short of the bite line, leaving a dark gap between.
            height = max(0.0034, radii[i] * 0.42) * rng.uniform(0.86, 1.08)
            c = tsurface[i] + np.array((0, sign * (radii[i] * 0.16 + height + 0.0006), rng.normal(0, 0.0008)))
            teeth_box(teeth, c, tan, (0, 1, 0), (0.0046, height, 0.0034), 0.0016, "upper" if sign > 0 else "lower")
    teeth.place = translate(HEAD_CENTRE)
    return f, teeth, eyes


def _chain(p, pts, radii):
    out = None
    for i in range(len(pts) - 1):
        d = capsule(p, pts[i], pts[i + 1], radii[i], radii[i + 1])
        out = d if out is None else np.minimum(out, d)
    return out


# ---------------------------------------------------------------------------
# B: THE BLANK. Skin pulled over something that is pressing out from inside.
# ---------------------------------------------------------------------------
def blank(h, teeth_h):
    f = base(h)
    flesh(f, 22, brow=0.5)
    # Only a suggestion of a face pressing through a taut surface.
    bump(f, (0, 0.21, 0.17), (0.11, 0.05, 0.05), 0.006)
    for s in (-1, 1):
        bump(f, (s * 0.075, 0.02, 0.16), (0.05, 0.022, 0.04), 0.0105, "bone")
        bump(f, (s * 0.092, -0.12, 0.12), (0.05, 0.1, 0.06), -0.018)
        bump(f, (s * 0.15, 0.2, 0.05), (0.035, 0.1, 0.07), -0.012)
    bump(f, (0, 0.05, 0.205), (0.01, 0.026, 0.02), 0.009)
    eyes = []
    for s, y in ((-1, 0.13), (1, 0.122)):
        c = (s * 0.052, y, 0.2)
        f.cut_ellipsoid(c, (0.015, 0.015, 0.07), 0.006, "socket")
        eyes.append(((s * 0.052, y, 0.15), 0.0085))
    # A perfect, lipless circle. It does not look like it can close.
    centre = np.array((0, -0.13, 0.2))
    f.cut_ellipsoid(centre, (0.056, 0.056, 0.14), 0.005, "mouth")
    f.cut_ellipsoid(centre - (0, 0, 0.12), (0.07, 0.07, 0.08), 0.03, "mouth")
    # Skin puckers toward the hole in long tight folds.
    region = f.region((-0.2, -0.4, 0.0), (0.2, 0.12, 0.28))
    p = f.coords(region)
    dx, dy = np.asarray(p[0], float), np.asarray(p[1], float) + 0.13
    radius, angle = np.hypot(dx, dy), np.arctan2(dy, dx)
    fold = np.cos(angle * 17 + np.sin(angle * 4) * 2.6 + radius * 16) * smoothstep(0.3, 0.06, radius) * smoothstep(0.04, 0.075, radius)
    near = (np.abs(f.d[region]) < 0.03) * smoothstep(0.03, 0.08, np.asarray(p[2], float))
    f.d[region] -= np.asarray(fold * 0.0062 * near, np.float32)
    # One crude suture holding the skin shut down the middle of the forehead.
    seam = [(0, 0.38, 0.05), (0.003, 0.3, 0.15), (-0.002, 0.23, 0.185), (0.001, 0.17, 0.2)]
    ridge(f, seam, 0.004, -0.0062, samples=30)
    pts = on_face(f, catmull(seam, 13))
    for i in range(1, 12):
        a = pts[i] + np.array((-0.012, 0.004, 0.0))
        b = pts[i] + np.array((0.012, -0.004, 0.0))
        f.add_capsule(tuple(a), tuple(b), 0.0024, 0.0024, 0.004, "bone")
    finish(f, 0.8)

    # Nothing at the front of the hole. Far back, a ring of small teeth catches light.
    teeth = Field((-0.12, -0.3, -0.06), (0.12, 0.05, 0.2), teeth_h, ("upper", "lower"))
    rng = np.random.default_rng(90)
    for j in range(32):
        a = j / 32 * 2 * np.pi + rng.normal(0, 0.05)
        r = 0.066
        root = centre + np.array((np.cos(a) * r, np.sin(a) * r, -0.17))
        tip = centre + np.array((np.cos(a) * r * 0.62, np.sin(a) * r * 0.62, -0.135 + rng.normal(0, 0.006)))
        teeth.add_tube([tuple(root), tuple((root + tip) * 0.5), tuple(tip)], [0.0042, 0.003, 0.0006], 0.001, "upper" if np.sin(a) > 0 else "lower", samples=6)
    teeth.place = translate(HEAD_CENTRE)
    return f, teeth, eyes


# ---------------------------------------------------------------------------
# C: THE CLUSTER. Eight eyes and a jaw that opens like a spider's.
# ---------------------------------------------------------------------------
def cluster(h, teeth_h):
    f = base(h, 1.04)
    flesh(f, 33, brow=0.2)
    # Eight dots scattered unevenly in growths of bunched skin, spider-style.
    pits = [(-0.058, 0.082, 0.024, 0.0105), (0.05, 0.072, 0.021, 0.0095), (-0.112, 0.145, 0.017, 0.0072), (0.104, 0.122, 0.0155, 0.0068),
            (-0.03, 0.17, 0.0145, 0.0064), (0.034, 0.195, 0.0135, 0.0056), (-0.078, 0.232, 0.012, 0.005), (0.09, 0.242, 0.0105, 0.0046)]
    eyes = []
    for x, y, r, dot in pits:
        guess = on_face(f, [(x, y, 0.2)])[0]
        bump(f, tuple(guess), (r * 2.4, r * 2.4, 0.03), 0.015)
    for x, y, r, dot in pits:
        guess = on_face(f, [(x, y, 0.2)])[0]
        f.cut_ellipsoid(tuple(guess + (0, 0, 0.004)), (r, r, 0.06), 0.004, "socket")
        eyes.append((tuple(guess - (0, 0, r * 1.25)), dot))
    # The lower face splits down the middle and hangs open in two heavy halves.
    def split(p):
        d = capsule(p, (0, -0.03, 0.26), (0, -0.45, 0.1), 0.006, 0.075)
        return d

    f.subtract(split, ((-0.1, -0.5, 0.0), (0.1, 0.0, 0.3)), 0.01, "mouth")
    f.cut_ellipsoid((0, -0.22, 0.09), (0.085, 0.17, 0.1), 0.024, "mouth")
    for s in (-1, 1):
        ridge(f, [(s * 0.03, -0.04, 0.19), (s * 0.06, -0.2, 0.17), (s * 0.08, -0.33, 0.12)], 0.0075, 0.0055)
        ridge(f, [(s * 0.075, -0.08, 0.15), (s * 0.11, -0.22, 0.11), (s * 0.115, -0.32, 0.08)], 0.009, 0.0065)
    finish(f, 1.0)

    teeth = Field((-0.16, -0.5, -0.05), (0.16, 0.0, 0.26), teeth_h, ("upper", "lower"))
    rng = np.random.default_rng(404)
    for s in (-1, 1):
        # Short, hooked fangs folded inward at the tips of the halves.
        root = np.array((s * 0.073, -0.325, 0.125))
        pts = [root, root + (s * 0.002, -0.05, 0.022), root + (s * -0.026, -0.098, 0.022), root + (s * -0.06, -0.108, -0.006)]
        teeth.add_tube([tuple(p) for p in pts], [0.015, 0.0125, 0.007, 0.0008], 0.002, "lower", samples=24)
        for i in range(11):
            y = -0.06 - i * 0.026
            start = np.array((s * (0.04 + i * 0.0028), y, 0.158 - i * 0.002 + rng.normal(0, 0.003)))
            tip = start + np.array((s * -(0.024 + rng.random() * 0.03), rng.normal(-0.012, 0.008), rng.normal(0, 0.008)))
            teeth.add_tube([tuple(start), tuple((start + tip) * 0.5), tuple(tip)], [0.0052, 0.0036, 0.0006], 0.001, "upper" if y > -0.18 else "lower", samples=6)
    teeth.place = translate(HEAD_CENTRE)
    return f, teeth, eyes


# ---------------------------------------------------------------------------
# D: THE MELT. The face is sliding off, and it is still looking at you.
# ---------------------------------------------------------------------------
def melt(h, teeth_h):
    f = base(h)
    flesh(f, 44)
    # Holes dragged long and low, one further than the other.
    eyes = []
    for s, top, bottom, x in ((-1, 0.2, 0.02, 0.066), (1, 0.14, -0.1, 0.082)):
        pts = [(s * x, top, 0.165), (s * (x + 0.005), (top + bottom) * 0.55, 0.18), (s * (x - 0.004), bottom, 0.185)]
        f.cut_tube(pts, [0.026, 0.033, 0.009], 0.012, "socket", samples=18)
        inner = [(s * x, top - 0.01, 0.14), (s * (x + 0.005), (top + bottom) * 0.55, 0.13), (s * x, bottom + 0.03, 0.14)]
        f.cut_tube(inner, [0.028, 0.03, 0.012], 0.014, "socket", samples=14)
        eyes.append(((s * x, top - 0.014, 0.112), 0.0098))
    # Mouth dragged open and sideways, chin sliding off to the left.
    mouth_pts = [(-0.018, -0.075, 0.2), (-0.01, -0.17, 0.19), (0.012, -0.27, 0.18), (0.03, -0.335, 0.15)]
    f.cut_tube(mouth_pts, [0.024, 0.066, 0.058, 0.014], 0.012, "mouth", samples=20)
    inner = [(-0.018, -0.12, 0.1), (0.0, -0.22, 0.1), (0.02, -0.3, 0.08)]
    f.cut_tube(inner, [0.05, 0.075, 0.03], 0.024, "mouth", samples=14)
    # Heavy folds of slack skin sliding down the cheeks and piling on the chin.
    rng = np.random.default_rng(7)
    for s in (-1, 1):
        for i in range(5):
            y = 0.05 - i * 0.065 - (0.04 if s > 0 else 0)
            a = (s * 0.075, y + 0.015, 0.2)
            b = (s * 0.125, y - 0.02, 0.15)
            c = (s * 0.17, y - 0.05 - rng.random() * 0.02, 0.06)
            ridge(f, [a, b, c], 0.008, 0.0065 - 0.0005 * i)
            ridge(f, [(s * 0.075, y - 0.012, 0.2), (s * 0.125, y - 0.047, 0.15), (s * 0.17, y - 0.08, 0.06)], 0.0048, -0.0042)
    for i in range(3):
        ridge(f, [(-0.1, -0.345 - i * 0.022, 0.1), (0.01, -0.355 - i * 0.022, 0.13), (0.12, -0.335 - i * 0.022, 0.1)], 0.0085, 0.007)
    finish(f, 1.0)
    # Drips of skin hanging from the upper lip across the opening.
    drips = ((-0.04, -0.125, 0.205, -0.22), (0.0, -0.11, 0.21, -0.27), (0.03, -0.14, 0.2, -0.235))
    for x, y0, z, y1 in drips:
        f.add_tube([(x, y0, z), (x + 0.003, (y0 + y1) * 0.55, z - 0.006), (x - 0.002, y1, z - 0.008)], [0.008, 0.003, 0.002], 0.008, samples=9)

    teeth = Field((-0.13, -0.42, -0.02), (0.13, 0.06, 0.26), teeth_h, ("upper", "lower"))
    rng = np.random.default_rng(77)
    for i in range(10):
        if rng.random() < 0.28:
            continue   # missing teeth
        x = -0.056 + i * 0.012 + rng.normal(0, 0.003)
        root = np.array((x, -0.098 - abs(x) * 0.2, 0.18))
        tip = root + np.array((rng.normal(0, 0.005), -rng.uniform(0.04, 0.09), 0.012))
        teeth.add_tube([tuple(root), tuple((root + tip) * 0.5), tuple(tip)], [0.0072, 0.0056, 0.0012], 0.001, "upper", samples=7)
    for i in range(8):
        if rng.random() < 0.35:
            continue
        x = -0.03 + i * 0.012 + rng.normal(0, 0.003)
        root = np.array((x, -0.306 + x * 0.3, 0.135))
        tip = root + np.array((rng.normal(0, 0.005), rng.uniform(0.03, 0.06), 0.012))
        teeth.add_tube([tuple(root), tuple((root + tip) * 0.5), tuple(tip)], [0.0066, 0.005, 0.001], 0.001, "lower", samples=7)
    teeth.place = translate(HEAD_CENTRE)
    return f, teeth, eyes


def torus_z(p, c, R, tube):
    q = np.sqrt((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2) - R
    return np.sqrt(q * q + (p[2] - c[2]) ** 2) - tube


# ---------------------------------------------------------------------------
# E: THE WIDE. Analog horror: eyes held open forever above a huge square grin.
# ---------------------------------------------------------------------------
def paint_black(f, centre, rx, ry, rough=0.012):
    """Soak a ragged-edged patch of the skin in black, with no change to shape."""
    cx, cy = centre
    region = tuple(slice(0, n) for n in f.n)
    p = f.coords(region)
    x, y = np.asarray(p[0], float) - cx, np.asarray(p[1], float) - cy
    edge = (np.sqrt((x / rx) ** 2 + (y / ry) ** 2) - 1.0) * min(rx, ry)
    wobble = (perlin(x * 90, y * 90, np.zeros_like(x) + cx * 40) * 0.7 + perlin(x * 210, y * 210, np.zeros_like(x) + cx * 90) * 0.5) * rough
    mask = np.where(np.asarray(p[2], float) > 0.02, edge + wobble, 1.0)
    f.tags["socket"] = np.minimum(f.tags["socket"], np.broadcast_to(np.asarray(mask, np.float32), f.d.shape).copy())


def wide_mouth(x):
    """Height of The Wide's bite line and half the mouth's height, across x."""
    t = np.arcsin(np.clip(np.asarray(x, float) / 0.16, -1, 1)) / 1.42
    t = np.clip(t, -1, 1)
    return -0.16 + 0.118 * np.abs(t) ** 2.0, 0.008 + 0.08 * np.cos(t * np.pi / 2) ** 0.85


def wide(h, teeth_h):
    f = base(h, 1.12)
    flesh(f, 55, brow=0.0)
    rings = []
    for s, y, R in ((-1, 0.142, 0.056), (1, 0.136, 0.061)):
        c = np.array((s * 0.094, y, 0.2))
        f.cut_ellipsoid(tuple(c), (R, R * 0.94, 0.1), 0.007, "socket")
        f.cut_ellipsoid((c[0], y, 0.13), (R * 0.9, R * 0.86, 0.07), 0.012, "socket")
        rings.append(((c[0], y, 0.104), R * 0.62))
    bump(f, (0, 0.05, 0.205), (0.016, 0.022, 0.02), 0.014)
    for s in (-1, 1):
        f.cut_ellipsoid((s * 0.011, 0.034, 0.222), (0.006, 0.0055, 0.022), 0.003, "socket")

    # A crescent of open mouth that runs almost from ear to ear.
    n = 64
    t = np.linspace(-1, 1, n)
    phi = t * 1.42
    curve = np.stack([0.16 * np.sin(phi), -0.16 + 0.118 * np.abs(t) ** 2.0, 0.176 * np.cos(phi)], axis=1)
    surface = on_face(f, curve)
    out = np.stack([np.sin(phi), np.zeros_like(phi), np.cos(phi)], axis=1)
    half = 0.008 + 0.08 * np.cos(t * np.pi / 2) ** 0.85
    f.subtract(lambda p: _chain(p, surface, half), (surface.min(0) - 0.1, surface.max(0) + 0.1), 0.005, "mouth")
    inner = surface - out * 0.04
    f.subtract(lambda p: _chain(p, inner, half * 1.25), (inner.min(0) - 0.12, inner.max(0) + 0.12), 0.012, "mouth")
    for s in (-1, 1):
        for dy in (0.0, 0.026, 0.05):
            ridge(f, [(s * 0.122, -0.05 + dy, 0.12), (s * 0.15, -0.0 + dy, 0.06), (s * 0.158, 0.03 + dy, -0.01)], 0.0044, -0.0042)
    finish(f, 1.0)
    # Black soaking out around each eye, wider than the socket itself.
    for (c, y, _z), R in rings:
        paint_black(f, (c, y), R * 1.7, R * 1.55, 0.012)

    # Gums run the full length of both lips, so every tooth has flesh to sit in.
    for sign in (1, -1):
        line = surface - out * 0.019 + np.stack([np.zeros(n), sign * half * 1.03, np.zeros(n)], axis=1)
        gum = (0.0035 + 0.0065 * np.cos(t * np.pi / 2) ** 0.7)
        f.union(lambda p, line=line, gum=gum: _chain(p, line, gum), (line.min(0) - 0.03, line.max(0) + 0.03), 0.006, "gum")

    teeth = Field((-0.22, -0.34, -0.2), (0.22, 0.06, 0.26), teeth_h, ("upper", "lower"))
    rng = np.random.default_rng(66)
    count = 19
    for sign, row in ((1, 0.92), (-1, 0.8)):
        for k in range(count):
            u = (k + 0.5) / count + rng.normal(0, 0.006)
            i = int(np.clip(u, 0, 1) * (n - 1))
            tall = max(0.012, half[i] * row) * rng.uniform(0.74, 1.1)
            bury = 0.014
            root = surface[i] - out[i] * 0.014 + np.array((0, sign * (half[i] + bury * 0.5), 0))
            tall += bury
            centre = root - np.array((0, sign * tall * 0.5, 0)) + rng.normal(0, 0.0012, 3)
            flat = np.array((np.cos(phi[i]), 0.0, -np.sin(phi[i])))
            # Crooked: leaning, turned, and overlapping their neighbours.
            lean = rng.normal(0, 0.13)
            twist = rng.normal(0, 0.2)
            up = np.array((flat[0] * lean, 1.0, flat[2] * lean))
            flat2 = flat * np.cos(twist) + out[i] * np.sin(twist)
            width = 0.0145 * (0.55 + 0.45 * np.cos((2 * np.clip(u, 0, 1) - 1) * np.pi / 2) ** 0.7) * rng.uniform(0.86, 1.14)
            teeth_box(teeth, centre, flat2, up, (width, tall * 0.5, 0.0052), 0.0028, "upper" if sign > 0 else "lower")
    teeth.place = translate(HEAD_CENTRE)

    # Only the white is left of each eye: a ragged ring around pure black.
    pale = Field((-0.2, 0.05, 0.07), (0.2, 0.24, 0.14), 0.0009, ())
    rng = np.random.default_rng(71)
    for centre, R in rings:
        angles = np.linspace(-0.55, np.pi + 0.55, 44)
        jitter = rng.normal(0, 0.0014, 44)
        pts = [(centre[0] + np.cos(a) * (R * 1.3 + j), centre[1] + np.sin(a) * (R * 1.22 + j), centre[2]) for a, j in zip(angles, jitter)]
        # Heaviest at the crown, tapering to a fine point at both tips.
        rr = [max(0.0009, 0.0125 * np.sin(np.clip((a + 0.55) / (np.pi + 1.1), 0, 1) * np.pi) ** 1.5 + rng.normal(0, 0.0005)) for a in angles]
        pale.add_tube(pts, rr, 0.0015, samples=88)
    pale.place = translate(HEAD_CENTRE)
    f.extras = [(pale, 3.0)]
    return f, teeth, []


# ---------------------------------------------------------------------------
# F: THE VOID. The face has been erased. Only two pale arcs are left.
# ---------------------------------------------------------------------------
def void_face(h, teeth_h):
    f = base(h)
    flesh(f, 66, brow=0.0)
    # Human ears. On a head with no face they are the worst part.
    for s in (-1, 1):
        f.add_tube([(s * 0.17, 0.11, 0.0), (s * 0.198, 0.09, -0.02), (s * 0.196, 0.03, -0.02), (s * 0.172, -0.012, 0.0)], [0.009, 0.012, 0.01, 0.009], 0.012)
        f.add_ellipsoid((s * 0.176, 0.05, -0.008), (0.012, 0.05, 0.03), 0.016)
        f.cut_ellipsoid((s * 0.19, 0.056, 0.002), (0.011, 0.034, 0.018), 0.008)
    # The whole face is one smooth matte shape that takes every bit of light.
    f.cut_ellipsoid((0, -0.03, 0.27), (0.154, 0.335, 0.095), 0.03)
    finish(f, 0.35)
    region = tuple(slice(0, n) for n in f.n)
    p = f.coords(region)
    # An exact mask rather than a cut: nothing inside this outline survives.
    edge = (np.sqrt((np.asarray(p[0], float) / 0.15) ** 2 + ((np.asarray(p[1], float) + 0.035) / 0.335) ** 2) - 1.0) * 0.15
    wobble = perlin(np.asarray(p[0], float) * 26, np.asarray(p[1], float) * 26, np.zeros_like(np.asarray(p[0], float)) + 3.3) * 0.016
    mask = np.where(np.asarray(p[2], float) > 0.0, edge + wobble, 1.0)
    f.tags["socket"] = np.minimum(f.tags["socket"], np.broadcast_to(np.asarray(mask, np.float32), f.d.shape).copy())

    arcs = Field((-0.16, 0.05, 0.1), (0.16, 0.27, 0.27), 0.0009, ())
    rng = np.random.default_rng(13)
    for s, cy, w in ((-1, 0.128, 0.062), (1, 0.135, 0.065)):
        # The same single arch, pulled out sideways: wide, flat and thin.
        cx = s * 0.082
        angles = np.linspace(-0.2, np.pi + 0.2, 34)
        rough = [(cx + np.cos(a) * w + rng.normal(0, 0.0008), cy + np.sin(a) * w * 0.47 + rng.normal(0, 0.0008), 0.22) for a in angles]
        pts = on_face(f, rough) + np.array((0, 0, 0.005))
        radii = [0.0012 + 0.0052 * np.sin(np.clip((a + 0.2) / (np.pi + 0.4), 0, 1) * np.pi) ** 0.6 + rng.normal(0, 0.00035) for a in angles]
        arcs.add_tube(pts.tolist(), radii, 0.0015, samples=66)
    arcs.place = translate(HEAD_CENTRE)
    f.extras = [(arcs, 6.0)]
    return f, None, []


CONCEPTS = {"grin": grin, "blank": blank, "cluster": cluster, "melt": melt, "wide": wide, "void": void_face}
