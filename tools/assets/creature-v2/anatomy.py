"""Anatomy of the SILENCE creature, rebuilt from the original Listener design.

Same creature: long egg head hanging from the crown under the thorax, recessed
maw of needle teeth, thorned legs rising to high knees, dorsal spines, two
vestigial arms at the front. Now longer, eight-legged and properly connected.

Conventions: game space, +Y up, facing +Z, metres. The head and hands use finer
voxels in their own local frames and carry a rigid ``place`` matrix.

Facial features are made by pushing and pulling one continuous surface (bump),
never by bolting shapes on, so nothing can float or leave a gap.
"""
import numpy as np

from sdf import Field, catmull, ellipsoid, fbm, perlin, smoothstep

HEAD_CENTRE = np.array((0.0, 1.235, 0.8))
HEAD_H = 0.395


def translate(t):
    m = np.eye(4)
    m[:3, 3] = t
    return m


def bump(f, c, r, amp, tag=None):
    """Inflate (amp > 0) or deflate the surface under a soft gaussian."""
    c, r = np.asarray(c, float), np.asarray(r, float)
    region = f.region(c - r * 3, c + r * 3)
    if region is None:
        return
    p = f.coords(region)
    g = np.exp(-sum(((p[i] - c[i]) / r[i]) ** 2 for i in range(3)))
    f.d[region] -= np.asarray(amp * g, np.float32)
    if tag:
        f.tags[tag][region] = np.minimum(f.tags[tag][region], np.asarray(1.0 - g, np.float32) * 0.05)


def snap(f, points):
    """Project points onto the current surface."""
    q = np.asarray(points, float).copy()
    for _ in range(8):
        d = f.sample(f.d, q)[:, None]
        q -= f.gradient(f.d, q, f.h * 1.5) * np.clip(d, -0.05, 0.05)
    return q


def ridge(f, points, sigma, amp, tag=None, samples=24):
    """Raise (or sink) a continuous soft cord that fades out at both ends."""
    from sdf import capsule

    c = snap(f, catmull(points, samples))
    lo, hi = c.min(0) - sigma * 3, c.max(0) + sigma * 3
    region = f.region(lo, hi)
    if region is None:
        return
    p = f.coords(region)
    best = None
    dist = None
    for i in range(samples - 1):
        d = capsule(p, c[i], c[i + 1], 0.0)
        t = (i + 0.5) / (samples - 1)
        fade = np.clip(min(t, 1 - t) / 0.16, 0, 1)
        g = np.exp(-((d / sigma) ** 2)) * fade * fade * (3 - 2 * fade)
        best = g if best is None else np.maximum(best, g)
        dist = d if dist is None else np.minimum(dist, d)
    f.d[region] -= np.asarray(best * amp, np.float32)
    if tag:
        f.tags[tag][region] = np.minimum(f.tags[tag][region], np.asarray(dist - sigma, np.float32))


_T = np.linspace(0, 1, 256)
# Chin to crown: the original long oval, narrowed. Depth is split front/back so
# there is a real cranium behind and a jaw that recedes into the throat.
_W = catmull([0.012, 0.088, 0.128, 0.158, 0.176, 0.158, 0.006], 256)
_DF = catmull([0.03, 0.126, 0.16, 0.186, 0.2, 0.17, 0.006], 256)
_DB = catmull([0.012, 0.074, 0.11, 0.17, 0.218, 0.19, 0.006], 256)


_ENDS = np.sqrt(np.clip(1 - np.abs(2 * _T - 1) ** 22, 0, 1))
_W = np.maximum(catmull([0.04, 0.088, 0.128, 0.158, 0.176, 0.158, 0.05], 256), 0.03) * _ENDS + 1e-4
_DF = np.maximum(catmull([0.05, 0.126, 0.16, 0.186, 0.2, 0.17, 0.05], 256), 0.03) * _ENDS + 1e-4
_DB = np.maximum(catmull([0.03, 0.074, 0.11, 0.17, 0.218, 0.19, 0.05], 256), 0.03) * _ENDS + 1e-4


def egg(p):
    t = np.clip((p[1] + HEAD_H) / (2 * HEAD_H), 0, 1)
    w, df, db = np.interp(t, _T, _W), np.interp(t, _T, _DF), np.interp(t, _T, _DB)
    d = db + (df - db) * smoothstep(-0.05, 0.05, p[2])
    q = np.sqrt((p[0] / w) ** 2 + (p[2] / d) ** 2)
    out = (q - 1) * np.minimum(w, d)
    return np.where(np.abs(p[1]) > HEAD_H, 1.0, out)


MOUTH_Y = -0.176
MOUTH_A, MOUTH_B = 0.086, 0.158
EYE_X, EYE_Y = 0.071, 0.142


def head_field(h):
    tags = ("mouth", "socket", "neck", "bone")
    f = Field((-0.3, -0.56, -0.6), (0.3, 0.8, 0.31), h, tags)
    f.union(egg, ((-0.2, -HEAD_H, -0.24), (0.2, HEAD_H, 0.22)), 0.0)

    # The neck leaves the back of the skull and rises to the shoulders.
    neck = [(0, 0.12, -0.085), (0, 0.32, -0.17), (0, 0.56, -0.29), (0, 0.78, -0.47)]
    f.add_tube(neck, [0.105, 0.096, 0.104, 0.14], 0.08, "neck")
    for t in np.linspace(0.0, 1, 10):
        c = np.array((0.0, 0.25 + 0.53 * t, -0.262 - 0.3 * t**1.5))
        f.add_ellipsoid(c, (0.022, 0.021, 0.028), 0.022, "bone")

    # Skull pushing through thin skin.
    for s in (-1, 1):
        bump(f, (s * 0.172, 0.18, 0.05), (0.04, 0.1, 0.09), -0.026)    # temple
        bump(f, (s * 0.128, 0.058, 0.13), (0.046, 0.019, 0.055), 0.016, "bone")  # cheekbone
        bump(f, (s * 0.128, -0.09, 0.098), (0.046, 0.115, 0.07), -0.038)   # gaunt hollow
        bump(f, (s * 0.108, -0.28, 0.05), (0.024, 0.06, 0.04), 0.009, "bone")   # jaw angle
            # Tendons dragged down the cheek by a mouth open too far.
        ridge(f, [(s * 0.122, 0.05, 0.128), (s * 0.116, -0.08, 0.11), (s * 0.108, -0.2, 0.095), (s * 0.094, -0.33, 0.058)], 0.0065, 0.0085)
        ridge(f, [(s * 0.098, 0.03, 0.156), (s * 0.104, -0.09, 0.124), (s * 0.099, -0.2, 0.116), (s * 0.08, -0.325, 0.082)], 0.0048, 0.006)
        # Skin creases falling from the inner orbit past the nose.
        ridge(f, [(s * 0.034, 0.1, 0.19), (s * 0.058, 0.0, 0.178), (s * 0.09, -0.07, 0.15)], 0.0046, -0.0058)
    for s in (-1, 1):
        ridge(f, [(s * 0.13, 0.02, -0.06), (s * 0.098, 0.3, -0.13), (s * 0.1, 0.72, -0.34)], 0.013, 0.012, "neck")
        ridge(f, [(s * 0.03, -0.3, 0.0), (s * 0.05, 0.02, -0.06), (s * 0.06, 0.36, -0.08), (s * 0.08, 0.72, -0.26)], 0.0075, 0.007, "neck")
        ridge(f, [(s * 0.075, 0.2, -0.17), (s * 0.08, 0.5, -0.3), (s * 0.09, 0.74, -0.5)], 0.01, 0.009, "neck")
    bump(f, (0, 0.3, 0.14), (0.11, 0.045, 0.05), -0.006)   # low sloped forehead
    bump(f, (0, 0.135, 0.2), (0.0125, 0.058, 0.02), 0.0085, "bone")   # nasal bridge
    bump(f, (0, -0.362, 0.07), (0.03, 0.022, 0.03), 0.009, "bone")   # chin
    # Root threads hanging under the jaw, as on the original.
    rng = np.random.default_rng(55)
    for j in range(6):
        x = (j - 2.5) * 0.024 + rng.normal(0, 0.004)
        top = (x, -0.348 + abs(x) * 0.6, 0.05 + rng.normal(0, 0.008))
        low = -0.42 - rng.uniform(0.0, 0.1)
        f.add_tube([top, (x + rng.normal(0, 0.012), (top[1] + low) * 0.5, top[2] + rng.normal(0, 0.01)), (x + rng.normal(0, 0.018), low, top[2] + rng.normal(0, 0.014))], [0.0062, 0.0034, 0.0008], 0.01, samples=10)

    # Wide gaping orbits, bare of any lid. The right one sits a little lower
    # and larger: symmetry reads as a mask, this reads as a face gone wrong.
    for s, sx, sy in ((-1, 1.0, 1.0), (1, 1.1, 1.08)):
        y = EYE_Y - (0.007 if s > 0 else 0.0)
        f.cut_ellipsoid((s * EYE_X, y, 0.2), (0.053 * sx, 0.05 * sy, 0.1), 0.012, "socket")
        f.cut_ellipsoid((s * EYE_X, y - 0.004, 0.13), (0.044 * sx, 0.042 * sy, 0.075), 0.018, "socket")
    # The nose is gone: an inverted-heart hole in the bone with a torn septum.
    for s in (-1, 1):
        f.cut_ellipsoid((s * 0.0155, 0.052, 0.215), (0.0125, 0.032, 0.05), 0.008, "socket")
    bump(f, (0, 0.052, 0.178), (0.0035, 0.022, 0.018), 0.008)

    # The maw: a tall, narrow silent scream, deep enough to swallow light.
    f.cut_ellipsoid((0, MOUTH_Y, 0.21), (MOUTH_A, MOUTH_B, 0.13), 0.016, "mouth")
    f.cut_ellipsoid((0, MOUTH_Y, 0.135), (0.074, 0.132, 0.105), 0.024, "mouth")
    # Back wall of the throat, so the maw is a pit rather than a hole.
    f.add_ellipsoid((0, MOUTH_Y + 0.01, -0.012), (0.1, 0.17, 0.05), 0.03)
    f.add_ellipsoid((0, MOUTH_Y + 0.02, 0.0), (0.06, 0.1, 0.03), 0.02, "mouth")
    # Gum shelves behind the lips, top and bottom. Teeth root into these.
    bump(f, (0, MOUTH_Y + MOUTH_B - 0.02, 0.1), (0.066, 0.016, 0.03), 0.015)
    bump(f, (0, MOUTH_Y - MOUTH_B + 0.016, 0.125), (0.062, 0.012, 0.022), 0.012)

    # Thin lip around the opening, with irregular strain lines radiating out.
    region = f.region((-0.16, -0.42, 0.02), (0.16, 0.08, 0.28))
    p = f.coords(region)
    ex = np.asarray(p[0], float) / MOUTH_A
    ey = (np.asarray(p[1], float) - MOUTH_Y) / MOUTH_B
    q = np.sqrt(ex**2 + ey**2)
    ring = np.abs(q - 1.0) * MOUTH_A
    angle = np.arctan2(ey, ex)
    fade = smoothstep(0.03, 0.08, np.asarray(p[2], float))
    near = (np.abs(f.d[region]) < 0.04) * fade
    strain = fbm(np.cos(angle) * 7.0, np.sin(angle) * 7.0, np.zeros_like(angle) + 0.3, 3)
    lip = np.exp(-((ring / 0.0062) ** 2)) * 0.0042
    streak = np.exp(-(((q - 1.28) / 0.28) ** 2)) * strain * 0.0065
    f.d[region] -= np.asarray((lip + streak) * near, np.float32)

    def tissue(q):
        x, y, z = q
        return perlin(x * 26, y * 5.5, z * 26) * 0.0024 + fbm(x * 13, y * 13, z * 13, 3) * 0.0026

    f.displace(tissue, 0.02)
    f.place = translate(HEAD_CENTRE)
    return f


def mouth_rim(a, inset=0.0):
    x = (MOUTH_A - inset) * np.cos(a)
    y = MOUTH_Y + (MOUTH_B - inset) * np.sin(a)
    t = np.clip((y + HEAD_H) / (2 * HEAD_H), 0, 1)
    w, d = float(np.interp(t, _T, _W)), float(np.interp(t, _T, _DF))
    z = d * np.sqrt(max(0.05, 1 - (x / w) ** 2))
    return np.array((x, y, z))


def teeth_field(h):
    """Needles hanging from the top of the maw and standing up from the bottom.

    Roots sit in the gums right behind the lips so both rows are on show, and
    every tooth is clipped to the mouth opening so none can reach through skin.
    """
    f = Field((-0.13, -0.4, -0.03), (0.13, 0.08, 0.26), h, ("upper", "lower"))
    rng = np.random.default_rng(4410)
    rows = ((14, 0.003, 0.016, 1.0), (11, 0.012, 0.042, 0.84), (8, 0.022, 0.078, 0.66))
    for count, inset, depth, scale in rows:
        for jaw_side in (1, -1):
            for i in range(count):
                u = (i + 0.5 + rng.uniform(-0.28, 0.28)) / count
                span = np.radians(30) + u * np.radians(120)
                a = span * jaw_side
                root = mouth_rim(a, inset)
                root[2] -= depth
                centre_bias = 1 - abs(u - 0.5) * 1.5
                lower_scale = 0.92 if jaw_side < 0 else 1.0
                length = (0.034 + 0.06 * centre_bias * lower_scale + 0.03 * rng.random() ** 2) * scale
                if rng.random() < 0.16:
                    length *= 1.45
                lean_forward = (0.012 if jaw_side > 0 else 0.022) * scale
                tip = root + np.array((rng.normal(-root[0] * 0.25, 0.004), -jaw_side * length, lean_forward + rng.normal(0, 0.005)))
                mid = root + (tip - root) * 0.42 + rng.normal(0, 0.0016, 3)
                wide = (0.0058 + 0.0024 * rng.random()) * (0.8 + 0.2 * scale)
                base = root + np.array((0, jaw_side * 0.01, -0.004))
                f.add_tube([tuple(base), tuple(mid), tuple(tip)], [wide * 1.15, wide, wide * 0.08], 0.0014, "upper" if jaw_side > 0 else "lower", samples=8)
    region = tuple(slice(0, n) for n in f.n)
    p = f.coords(region)
    ex = np.asarray(p[0], float) / MOUTH_A
    ey = (np.asarray(p[1], float) - MOUTH_Y) / MOUTH_B
    f.d = np.maximum(f.d, np.asarray((np.sqrt(ex**2 + ey**2) - 1.02) * MOUTH_A, np.float32))
    f.place = translate(HEAD_CENTRE)
    return f


def eye_positions():
    # One small dot hanging in the dark of each socket, both locked dead ahead.
    return [(-EYE_X, EYE_Y, 0.098), (EYE_X, EYE_Y - 0.007, 0.098)]


def eye_field(h):
    f = Field((-0.11, 0.1, 0.07), (0.11, 0.18, 0.13), h, ())
    for c in eye_positions():
        f.add_ellipsoid(c, (0.0105, 0.0105, 0.0105), 0.001)
    f.place = translate(HEAD_CENTRE)
    return f


# --- proportions shared by the sculpt, the rig and the runtime ------------
SEGMENT_LENGTHS = (1.75, 1.7, 1.45, 0.42)
LEG_BEND = np.radians(26.0)
LEG_BASE_Z = (0.42, 0.08, -0.28, -0.64)
LEG_HIP_X = (0.84, 0.96, 1.0, 0.92)
LEG_HIP_Y = (2.46, 2.82, 2.78, 2.42)
LEG_HIP_Z = (0.82, 0.12, -0.62, -1.32)
LEG_FOOT_X = (2.35, 2.78, 2.78, 2.42)
LEG_FOOT_Z = (2.38, 0.8, -1.1, -3.05)


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def two_bone(a, b, pole, l1, l2):
    a, b, pole = map(lambda v: np.asarray(v, float), (a, b, pole))
    axis = b - a
    d = np.linalg.norm(axis)
    axis /= d
    side = pole - a
    side -= axis * side.dot(axis)
    side = unit(side)
    d = np.clip(d, abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4)
    along = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    return a + axis * along + side * np.sqrt(max(0.0, l1 * l1 - along * along))


def solve_leg(hip, foot, pole):
    """Hip to toe through four segments, planar in the pole's plane."""
    l1, l2, l3, l4 = SEGMENT_LENGTHS
    hip, foot = np.asarray(hip, float), np.asarray(foot, float)
    toward = hip - foot
    toward[1] = 0
    toward = unit(toward)
    tarsal = foot + unit(np.array((0.0, 0.62, 0.0)) + toward * 0.78) * l4
    combined = np.sqrt(l2 * l2 + l3 * l3 + 2 * l2 * l3 * np.cos(LEG_BEND))
    knee = two_bone(hip, tarsal, pole, l1, combined)
    ankle = two_bone(knee, tarsal, pole, l2, l3)
    return hip, knee, ankle, tarsal, foot


def legs():
    out = []
    for s in (-1, 1):
        for i in range(4):
            hip = np.array((s * LEG_HIP_X[i], LEG_HIP_Y[i], LEG_HIP_Z[i]))
            base = np.array((s * 0.24, 1.94, LEG_BASE_Z[i]))
            foot = np.array((s * LEG_FOOT_X[i], 0.035, LEG_FOOT_Z[i]))
            pole = np.array((s * 3.4, 5.0, foot[2] * 0.55))
            joints = solve_leg(hip, foot, pole)
            out.append(dict(label=("L" if s < 0 else "R") + str(i), side=s, index=i, base=base, hip=hip, foot=foot, pole=pole, joints=joints))
    return out


def bone_frame(a, b, plane_normal, pole):
    y = unit(np.asarray(b) - np.asarray(a))
    x = np.cross(y, plane_normal)
    x = unit(x)
    if x.dot(np.asarray(pole) - np.asarray(a)) < 0:
        x = -x
    z = np.cross(x, y)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, a
    return m


_RADII = {
    0: ((0.0, 0.134), (0.08, 0.128), (0.3, 0.104), (0.72, 0.082), (0.9, 0.092), (1.0, 0.116)),
    1: ((0.0, 0.116), (0.1, 0.092), (0.4, 0.074), (0.82, 0.056), (0.94, 0.06), (1.0, 0.07)),
    2: ((0.0, 0.07), (0.08, 0.056), (0.5, 0.043), (0.9, 0.032), (1.0, 0.04)),
    3: ((0.0, 0.04), (0.2, 0.03), (0.62, 0.02), (0.9, 0.008), (1.0, 0.0015)),
}


FEMUR_SPLIT = 0.42


def segment_profile(kind, length):
    table = _RADII[kind]
    ts = np.array([t for t, _ in table])
    rs = np.array([r for _, r in table])
    stations = np.linspace(0, 1, 30)
    radius = np.interp(stations, ts, rs)
    bow = {0: 0.05, 1: 0.03, 2: 0.012, 3: -0.05}[kind]
    centre = np.stack([bow * np.sin(np.pi * stations) ** 1.2, stations * length, np.zeros_like(stations)], axis=1)
    return centre, radius, bow, rs


def core_sdf(p, centre, radius):
    from sdf import capsule

    squash = 1.0 / 0.74
    out = None
    q = (p[0], p[1], p[2] * squash)
    for i in range(len(centre) - 1):
        d = capsule(q, centre[i], centre[i + 1], radius[i], radius[i + 1])
        out = d if out is None else np.minimum(out, d)
    return out


def segment_field(kind, length, h, seed):
    """One rigid leg segment along +Y.

    The femur starts past FEMUR_SPLIT: its root belongs to the torso's skin and
    is weighted smoothly, so there is no joint to see at the hip. Further joints
    are spheres centred on the joint, so they stay closed at every angle.
    """
    rng = np.random.default_rng(seed)
    start = FEMUR_SPLIT - 0.32 if kind == 0 else -0.2
    f = Field((-0.34, start, -0.3), (0.62 if kind < 2 else 0.4, length + 0.2, 0.3), h, ("bone", "tendon"))
    centre, radius, bow, rs = segment_profile(kind, length)
    if kind == 0:
        keep = centre[:, 1] >= FEMUR_SPLIT - 0.14
        centre_used, radius_used = centre[keep].copy(), radius[keep].copy()
        radius_used *= 0.8 + 0.2 * smoothstep(FEMUR_SPLIT - 0.14, FEMUR_SPLIT + 0.08, centre_used[:, 1])
    else:
        centre_used, radius_used = centre, radius

    # The femur shell sits a hair proud of its torso-side root, avoiding z-fighting.
    inflate = 0.0
    f.union(lambda p: core_sdf(p, centre_used, radius_used + inflate), (centre_used.min(0) - radius.max() - 0.05, centre_used.max(0) + radius.max() + 0.05), 0.0)
    if kind > 0:
        f.add_ellipsoid((0, 0, 0), (rs[0], rs[0], rs[0]), 0.03, "bone")
    if kind < 3:
        f.add_ellipsoid((0, length, 0), (rs[-1], rs[-1], rs[-1]), 0.03, "bone")

    # Tendons run the full length and sink back into the joints.
    t0 = (FEMUR_SPLIT / length + 0.02) if kind == 0 else 0.08
    if kind < 3:
        for side in (-1, 1):
            for offset, sigma, amp in ((0.72, 0.016, 0.014), (0.34, 0.01, 0.009)):
                pts = [(bow * np.sin(np.pi * t) * 1.2 - 0.05 * radius[int(t * 29)] * side, t * length, side * radius[int(t * 29)] * 0.74 * offset) for t in np.linspace(t0, 0.94, 6)]
                ridge(f, pts, sigma * (1.0 if kind == 0 else 0.72), amp * (1.0 if kind == 0 else 0.72), "tendon")

    def thorn(a, b, r0, k=0.03, samples=10, tag="bone"):
        a, b = np.asarray(a), np.asarray(b)
        # Thorns hook, split and break at irregular angles.
        mid = a + (b - a) * 0.55 + rng.normal(0, 0.02, 3) + np.array((0.0, (b - a)[1] * 0.2, 0.0))
        f.add_tube([tuple(a), tuple(mid), tuple(b)], [r0, r0 * 0.34, 0.0011], k, tag, samples=samples)

    def surface(t, angle):
        i = int(np.clip(t * 29, 0, 29))
        r = radius[i]
        return np.array((centre[i, 0] + np.cos(angle) * r * 0.9, centre[i, 1], np.sin(angle) * r * 0.66))

    if kind == 0:
        # Sparse and unequal: a few long hooks and a scatter of small ones.
        spots = sorted(rng.uniform(FEMUR_SPLIT / length + 0.05, 0.93, 11))
        for j, t in enumerate(spots):
            a = surface(t, rng.uniform(-1.0, 1.0))
            big = rng.random() < 0.3
            size = rng.uniform(0.24, 0.44) if big else rng.uniform(0.05, 0.14)
            thorn(a, a + unit(np.array((1.0, -rng.uniform(0.2, 0.75), rng.normal(0, 0.28)))) * size, 0.034 if big else 0.016, 0.02)
        thorn((0.05, length - 0.1, 0.0), (0.42, length + 0.16, rng.normal(0, 0.05)), 0.066, 0.05, 12)   # knee spur
        for j in range(3):   # torn strips of skin hanging under the femur
            t = FEMUR_SPLIT / length + 0.08 + j * 0.18 + rng.uniform(-0.03, 0.03)
            a = surface(t, np.pi + rng.uniform(-0.4, 0.4))
            b = a + np.array((-rng.uniform(0.2, 0.46), rng.normal(0, 0.06), rng.normal(0, 0.05)))
            f.add_tube([tuple(a), tuple((a + b) * 0.5 + rng.normal(0, 0.012, 3)), tuple(b)], [0.028, 0.01, 0.0012], 0.024, "tendon", samples=12)
    elif kind == 1:
        spots = sorted(rng.uniform(0.12, 0.9, 9))
        for j, t in enumerate(spots):
            a = surface(t, rng.uniform(-1.4, 1.4))
            big = rng.random() < 0.3
            size = (rng.uniform(0.16, 0.3) if big else rng.uniform(0.04, 0.1)) * (1 - t * 0.4)
            direction = unit(np.array((0.7, 0.7 * rng.uniform(0.3, 1.0), np.sign(np.sin(j * 2.4)) * rng.uniform(0.1, 0.7))))
            thorn(a, a + direction * size, (0.026 if big else 0.012) * (1 - t * 0.4), 0.014)
    elif kind == 2:
        spots = sorted(rng.uniform(0.08, 0.92, 10))
        for j, t in enumerate(spots):
            a = surface(t, rng.uniform(-1.6, 1.6))
            size = rng.uniform(0.04, 0.13) * (1 - t * 0.5)
            direction = unit(np.array((0.6, 0.7, np.sign(np.sin(j * 1.9)) * 0.5)))
            thorn(a, a + direction * size, 0.012, 0.012)
    else:
        for j in range(3):
            t = 0.3 + j * 0.15
            a = surface(t, np.pi * rng.uniform(-0.2, 0.2))
            thorn(a, a + unit(np.array((0.6, 0.7, 0.2))) * 0.05, 0.009, 0.008)

    def skin(q):
        x, y, z = q
        return perlin(x * 30, y * 8, z * 30) * 0.0034 + fbm(x * 15, y * 15, z * 15, 3) * 0.0034

    f.displace(skin, 0.02)
    return f


def rib_point(z, theta, side, offset=0.0):
    cz, rz = -0.16, 0.88
    t = np.clip((z - cz) / rz, -1, 1)
    scale = np.sqrt(1 - t * t)
    return (side * (0.36 * scale + offset) * np.sin(theta), 1.86 + (0.28 * scale + offset) * np.cos(theta), z)


ARMS = {
    s: dict(
        shoulder=np.array((s * 0.32, 1.9, 0.43)),
        upper=np.array((s * 0.47, 1.5, 0.31)),
        elbow=np.array((s * 0.505, 1.06, 0.27)),
        fore=np.array((s * 0.41, 0.8, 0.49)),
        wrist=np.array((s * 0.31, 0.6, 0.67)),
    )
    for s in (-1, 1)
}


def torso_field(h):
    """Thorax, abdomen, hip stumps, shoulder girdle, arms and the neck root."""
    f = Field((-1.9, 0.48, -2.35), (1.9, 3.55, 1.4), h, ("bone", "tendon", "armL", "armR", "core"))
    f.add_ellipsoid((0, 1.86, -0.16), (0.355, 0.275, 0.875), 0.0, "core")
    f.add_ellipsoid((0, 1.9, 0.42), (0.4, 0.21, 0.3), 0.11, "core")
    # Sunken waist then a long, deflated abdomen that droops at the end.
    f.add_tube([(0, 1.82, -0.9), (0, 1.8, -1.14), (0, 1.84, -1.5), (0, 1.8, -1.9), (0, 1.67, -2.12)], [0.2, 0.17, 0.29, 0.27, 0.14], 0.09, "core")
    for s, t in ((-1, 0.0), (1, 0.0), (-1, 1.0), (1, 1.0)):
        a = np.array((s * 0.05, 1.62 - t * 0.02, -2.18 - t * 0.02))
        f.add_tube([tuple(a), tuple(a + np.array((s * 0.03, -0.05, -0.08 + t * 0.03))), tuple(a + np.array((s * 0.07, -0.13, -0.15 + t * 0.06)))], [0.032, 0.017, 0.002], 0.024, "bone", samples=9)

    for i in range(13):   # ribs under the skin
        z = 0.36 - i * 0.098
        for s in (-1, 1):
            pts = [rib_point(z - t * 0.16, 0.2 + t * 2.7, s, 0.0) for t in np.linspace(0, 1, 7)]
            f.add_tube(pts, [0.016, 0.024, 0.026, 0.026, 0.022, 0.018, 0.012], 0.03, "bone", samples=24)
    f.add_tube([(0, 1.59, 0.5), (0, 1.57, 0.1), (0, 1.57, -0.3)], [0.03, 0.036, 0.024], 0.05, "bone")   # sternum

    # Ribs give way to the hips: each stump erupts through the upper back and
    # carries straight on into the first stretch of the femur as one skin.
    for leg in legs():
        hip, knee, ankle, tarsal, foot = leg["joints"]
        f.add_tube([tuple(leg["base"]), tuple((leg["base"] + hip) * 0.5 + np.array((0, 0.02, 0))), tuple(hip)], [0.22, 0.175, 0.15], 0.12, "core")
        frame = bone_frame(hip, knee, unit(np.cross(knee - hip, tarsal - hip)), leg["pole"])
        centre, radius, _, _ = segment_profile(0, float(np.linalg.norm(knee - hip)))
        count = int(np.searchsorted(centre[:, 1], FEMUR_SPLIT + 0.14)) + 1
        chain, rr = centre[:count].copy(), radius[:count].copy()
        rr *= 1.0 - 0.2 * smoothstep(FEMUR_SPLIT - 0.08, FEMUR_SPLIT + 0.14, chain[:, 1])

        def root(p, frame=frame, chain=chain, rr=rr):
            # World to bone-local without materialising more than the region.
            xyz = [p[i] - frame[i, 3] for i in range(3)]
            q = [sum(frame[j, i] * xyz[j] for j in range(3)) for i in range(3)]
            return core_sdf(q, chain, rr)

        mid = chain[-1]
        reach = np.linalg.norm(mid) + 0.25
        f.union(root, (hip - reach, hip + reach), 0.09, "core")
        for offset in (-0.12, 0.12):
            a = leg["base"] + np.array((0, 0.1, offset))
            ridge(f, [a, (a + hip) * 0.5 + np.array((0, 0.05, offset * 0.6)), hip + np.array((0, 0.03, offset * 0.5))], 0.03, 0.022, "tendon")

    # Scapulae and spinal keel.
    for s in (-1, 1):
        f.add_tube([(s * 0.08, 2.06, -0.55), (s * 0.27, 2.14, -0.2), (s * 0.37, 2.07, 0.25), (s * 0.22, 1.94, 0.52)], [0.03, 0.08, 0.1, 0.04], 0.08, "bone", samples=20)
    keel = [(0, 2.13, 0.5), (0, 2.16, 0.0), (0, 2.14, -0.6), (0, 2.02, -1.0), (0, 2.08, -1.5), (0, 1.96, -2.0)]
    rng = np.random.default_rng(1188)
    for t in np.linspace(0, 1, 26):
        c = catmull(keel, 200)[int(t * 199)]
        f.add_ellipsoid(c, (0.038, 0.03, 0.036), 0.03, "bone")
    for j in range(15):   # broken vertebral spines, the original's dorsal ridge
        t = 0.02 + j * 0.0665
        c = catmull(keel, 200)[int(t * 199)]
        h_tip = rng.uniform(0.16, 0.42) * (1 - abs(t - 0.32) * 0.7)
        tip = c + np.array((rng.normal(0, 0.05), h_tip, -0.16 * h_tip / 0.3 + rng.normal(0, 0.02)))
        mid = (c + tip) * 0.5 + rng.normal(0, 0.012, 3)
        f.add_tube([tuple(c - np.array((0, 0.03, 0))), tuple(mid), tuple(tip)], [0.06, 0.03, 0.0015], 0.04, "bone", samples=10)

    for s in (-1, 1):
        # Clavicle and pectoral cords that give the chest a human reading.
        ridge(f, [(s * 0.04, 1.75, 0.68), (s * 0.2, 1.8, 0.62), (s * 0.36, 1.88, 0.5)], 0.02, 0.022, "bone")
        ridge(f, [(s * 0.05, 1.59, 0.42), (s * 0.2, 1.67, 0.55), (s * 0.35, 1.8, 0.56)], 0.03, 0.016, "tendon")
        ridge(f, [(s * 0.16, 2.05, 0.3), (s * 0.13, 1.93, 0.46), (s * 0.08, 1.8, 0.58)], 0.03, 0.016, "tendon")

    # Neck root: sits just inside the head mesh's neck sleeve.
    f.add_tube([(0, 2.03, 0.28), (0, 1.8, 0.51), (0, 1.56, 0.63)], [0.13, 0.098, 0.088], 0.1, "core")

    # Arms hang at the front on either side of the head.
    for s in (-1, 1):
        arm = ARMS[s]
        tag = "armL" if s < 0 else "armR"
        pts = [arm["shoulder"], arm["upper"], arm["elbow"], arm["fore"], arm["wrist"]]
        f.add_tube([tuple(p) for p in pts], [0.086, 0.056, 0.05, 0.04, 0.03], 0.05, tag, samples=36)
        f.add_ellipsoid(arm["shoulder"], (0.125, 0.12, 0.13), 0.08, ("core",))
        f.add_ellipsoid(arm["elbow"] + np.array((s * 0.012, -0.012, -0.03)), (0.056, 0.064, 0.056), 0.03, ("bone", tag))
        for off in (-0.022, 0.022):
            d = unit(arm["wrist"] - arm["elbow"])
            side = unit(np.cross(d, np.array((0, 0, 1)))) * off
            f.add_tube([tuple(arm["elbow"] + side), tuple(arm["fore"] + side * 1.3 + np.array((0, 0, 0.01))), tuple(arm["wrist"] + side * 0.7)], [0.021, 0.018, 0.013], 0.014, ("bone", tag), samples=14)

    def skin(q):
        x, y, z = q
        return perlin(x * 20, y * 26, z * 12) * 0.0048 + fbm(x * 11, y * 11, z * 11, 3) * 0.0064

    f.displace(skin, 0.03)
    # Long folds on the deflated abdomen.
    def folds(q):
        x, y, z = q
        slack = smoothstep(-1.05, -1.5, z)
        wrinkle = fbm(x * 4 + np.sin(z * 3) * 0.4, y * 4, z * 0.8, 4)
        return wrinkle * 0.03 * slack

    f.displace(folds, 0.04)
    return f


def hand_layout(s):
    """Joints in the hand's local frame: wrist at origin, fingers toward -Y."""
    # The hand frame's +X points outward, so the thumb side is mirrored here.
    m = -s
    fingers = []
    for i, (x, fan, lengths) in enumerate((
        (-0.052, -0.2, (0.112, 0.09, 0.07)),
        (-0.0175, -0.065, (0.13, 0.104, 0.08)),
        (0.0175, 0.06, (0.124, 0.098, 0.076)),
        (0.052, 0.19, (0.098, 0.078, 0.06)),
    )):
        base = np.array((m * x, -0.172 + abs(x) * 0.34, 0.0))
        direction = unit(np.array((m * np.sin(fan), -np.cos(fan), 0.09)))
        curl = 0.09
        joints = [base]
        d = direction.copy()
        for l in lengths:
            d = unit(d + np.array((0, 0, curl)))
            joints.append(joints[-1] + d * l)
            curl += 0.13
        fingers.append(joints)
    base = np.array((m * -0.07, -0.05, 0.012))
    d = unit(np.array((m * -0.62, -0.72, 0.28)))
    joints = [base, base + d * 0.085, base + d * 0.152 + np.array((0, 0, 0.012)), base + d * 0.205 + np.array((0, -0.004, 0.03))]
    fingers.append(joints)
    return fingers


def hand_matrix(s):
    arm = ARMS[s]
    y = -unit(arm["wrist"] - arm["fore"] + np.array((-s * 0.02, -0.08, 0.02)))
    z = unit(np.array((-s * 0.72, 0.0, -0.7)))
    x = unit(np.cross(y, z))
    z = np.cross(x, y)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, arm["wrist"]
    return m


def hand_field(s, h):
    """Long, clearly separate fingers with knuckles and dark nails."""
    f = Field((-0.3, -0.56, -0.1), (0.3, 0.17, 0.2), h, ("bone", "nail"))
    f.add_tube([(0, 0.14, 0), (0, 0.075, 0), (0, 0.01, 0), (0, -0.05, 0)], [0.022, 0.033, 0.04, 0.05], 0.02)
    fingers = hand_layout(s)
    f.add_ellipsoid((0, -0.092, 0.002), (0.075, 0.098, 0.019), 0.018)
    for i, joints in enumerate(fingers):
        r0 = 0.0145 if i < 4 else 0.016
        if i < 4:
            f.add_tube([(joints[0][0] * 0.3, -0.02, 0.006), tuple(joints[0])], [0.011, r0], 0.012, "bone", samples=8)
        radii = [r0, r0 * 0.86, r0 * 0.74, r0 * 0.62]
        for j in range(3):
            f.add_capsule(tuple(joints[j]), tuple(joints[j + 1]), radii[j], radii[j + 1], 0.006)
            f.add_ellipsoid(tuple(joints[j]), (radii[j] * 1.22,) * 3, 0.007, "bone")
        d = unit(joints[3] - joints[2])
        f.add_tube([tuple(joints[3] - d * 0.012), tuple(joints[3] + d * 0.024 + np.array((0, 0, -0.002))), tuple(joints[3] + d * 0.062 + np.array((0, 0, 0.01)))], [radii[3] * 0.94, radii[3] * 0.76, 0.0011], 0.003, "nail", samples=8)

    def skin(q):
        x, y, z = q
        return perlin(x * 90, y * 90, z * 90) * 0.0006

    f.displace(skin, 0.008)
    f.place = hand_matrix(s)
    return f


# --- previews --------------------------------------------------------------
def close_edges(f):
    """Closing the volume at the grid boundary keeps every mesh watertight."""
    f.d[[0, -1], :, :] = 1
    f.d[:, [0, -1], :] = 1
    f.d[:, :, [0, -1]] = 1
    return f


SKIN = (0.58, 0.54, 0.47)


def build_preview(part, voxel):
    head = [("head", head_field(voxel), SKIN), ("teeth", teeth_field(min(voxel * 0.5, 0.0012)), (0.8, 0.75, 0.58)), ("eyes", eye_field(min(voxel * 0.5, 0.001)), (1.0, 1.0, 1.0))]
    if part == "head":
        return head
    parts = list(head) if part == "body" else []
    parts.append(("torso", torso_field(voxel * 2.5), SKIN))
    for s in (-1, 1):
        parts.append((f"hand{s}", hand_field(s, min(voxel, 0.0026)), SKIN))
    for leg in legs():
        hip, knee, ankle, tarsal, foot = leg["joints"]
        normal = unit(np.cross(knee - hip, tarsal - hip))
        chain = [hip, knee, ankle, tarsal, foot]
        for kind in range(4):
            a, b = chain[kind], chain[kind + 1]
            field = segment_field(kind, float(np.linalg.norm(b - a)), voxel * 2, 900 + leg["index"] * 10 + kind + (leg["side"] > 0) * 5)
            field.place = bone_frame(a, b, normal, leg["pole"])
            parts.append((f"{leg['label']}_{kind}", field, SKIN))
    return [(n, close_edges(f), c) for n, f, c in parts]


def preview_shots(part):
    # Blender space: x, -z, y.
    z = 1.2
    if part == "head":
        return [
            ("front", (0.0, -2.2, z), (0, -0.8, z), 62),
            ("three", (1.0, -2.0, z + 0.12), (0, -0.8, z), 62),
            ("side", (1.6, -0.75, z + 0.15), (0, -0.72, z + 0.15), 55),
            ("low", (0.25, -1.75, 0.68), (0, -0.8, 1.15), 55),
            ("above", (0.12, -2.0, 1.68), (0, -0.82, 1.08), 58),
        ]
    if part == "body":
        return [
            ("front", (0.4, -9.8, 2.1), (0, 0, 1.85), 42),
            ("three", (6.4, -7.4, 2.6), (0, 0.2, 1.85), 42),
            ("side", (10.5, 0.4, 2.0), (0, 0.4, 1.85), 42),
            ("top", (2.2, 2.0, 8.5), (0, 0.4, 1.8), 42),
            ("hips", (-3.0, 1.6, 4.2), (-0.9, 0.2, 2.5), 40),
            ("back", (1.5, 3.8, 5.2), (0, 0.6, 2.0), 45),
            ("underside", (0.5, -2.9, 0.65), (0, -0.7, 1.15), 42),
            ("hand", (-0.75, -1.3, 0.55), (-0.3, -0.75, 0.35), 55),
        ]
    raise ValueError(part)
