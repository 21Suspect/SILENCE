"""Texel-exact PBR bake. Every texel finds the true sculpt surface, reads its
normal and anatomy tags, and builds colour from 3D procedural layers."""
import numpy as np

import anatomy as A
import head_variants as H
from sdf import fbm, perlin, ridged, smoothstep

F = np.float32


def srgb(r, g, b):
    c = np.array((r, g, b), F) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055).astype(F)


# The original's palette: pale bone crests, dark mottled rot, warm tendon.
BONE = srgb(198, 188, 160)
PALE = srgb(164, 156, 134)
GREY = srgb(102, 104, 90)
ROT = srgb(36, 40, 36)
BRUISE = srgb(66, 48, 58)
TENDON = srgb(122, 56, 44)
BLOOD = srgb(52, 16, 16)
GUM = srgb(112, 44, 42)
BLACK = srgb(9, 8, 9)
TOOTH = srgb(214, 198, 158)
TOOTH_ROOT = srgb(96, 70, 44)


def mix(a, b, t):
    t = np.asarray(t, F)[..., None]
    return a * (1 - t) + b * t


def rasterize(uv, tex):
    """Return texel coords, triangle index and barycentrics for each covered texel."""
    t = uv * tex - 0.5
    xs, ys, tri, b1s, b2s = [], [], [], [], []
    for i in range(len(t)):
        a, b, c = t[i]
        x0, x1 = int(np.floor(min(a[0], b[0], c[0]))) - 1, int(np.ceil(max(a[0], b[0], c[0]))) + 2
        y0, y1 = int(np.floor(min(a[1], b[1], c[1]))) - 1, int(np.ceil(max(a[1], b[1], c[1]))) + 2
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, tex), min(y1, tex)
        if x1 <= x0 or y1 <= y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1), np.arange(y0, y1))
        v0, v1 = b - a, c - a
        d = v0[0] * v1[1] - v0[1] * v1[0]
        if abs(d) < 1e-12:
            continue
        px, py = gx - a[0], gy - a[1]
        u = (px * v1[1] - py * v1[0]) / d
        v = (py * v0[0] - px * v0[1]) / d
        e = 0.6 / max(np.sqrt(abs(d)), 1.0)
        mask = (u >= -e) & (v >= -e) & (u + v <= 1 + e)
        if mask.any():
            xs.append(gx[mask])
            ys.append(gy[mask])
            tri.append(np.full(int(mask.sum()), i))
            b1s.append(u[mask])
            b2s.append(v[mask])
    return (np.concatenate(xs), np.concatenate(ys), np.concatenate(tri), np.concatenate(b1s).astype(F), np.concatenate(b2s).astype(F))


def height_detail(part, p):
    """Fine height added on top of the sculpt: creases, pores, cracks, furrows."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    kind = part["kind"]
    if kind == "teeth":
        return perlin(x * 400, y * 60, z * 400) * 0.00018
    if kind == "leg":
        # Dry, furrowed hide running with the bone, like dead bark.
        furrow = perlin(x * 62, y * 6.5, z * 62) * 0.0028
        crack = np.clip(1 - np.abs(perlin(x * 96, y * 8, z * 96)) * 2.4, 0, 1) ** 12
        grit = fbm(x * 210, y * 70, z * 210, 3) * 0.0011
        return furrow - crack * 0.0034 + grit + perlin(x * 560, y * 560, z * 560) * 0.00026
    # Skin: stretched creases, slack folds, grain and pores.
    crease = perlin(x * 48, y * 15, z * 48) * 0.0018 + perlin(x * 22, y * 70, z * 22) * 0.0009
    grain = fbm(x * 190, y * 190, z * 190, 3) * 0.0008
    pores = perlin(x * 640, y * 640, z * 640) * 0.0003
    return crease + grain + pores


def shade(part, field, p, n, ao_small, ao_large):
    """Albedo and roughness in linear space."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    kind = part["kind"]
    macro = fbm(x * 3.1 + 11, y * 3.6, z * 3.1, 4) * 1.6 + 0.5
    mid = fbm(x * 12, y * 12, z * 12, 4) * 1.5 + 0.5
    fine = fbm(x * 70, y * 70, z * 70, 3) * 1.5 + 0.5
    speck = perlin(x * 240, y * 240, z * 240) * 2.0 + 0.5
    # Veins: warped ridged noise that only surfaces in patches.
    wx, wy, wz = x + fbm(x * 8, y * 8, z * 8, 2) * 0.05, y + fbm(x * 8 + 9, y * 8, z * 8, 2) * 0.05, z + fbm(x * 8, y * 8, z * 8 + 5, 2) * 0.05
    vein_raw = 1 - np.abs(perlin(wx * 16, wy * 16, wz * 16)) * 7
    veins = np.clip(vein_raw, 0, 1) ** 2 * smoothstep(0.45, 0.72, macro)

    if kind == "teeth" and part.get("wide"):
        bite, half = H.wide_mouth(x)
        rootward = np.abs(y - bite) / np.maximum(half, 0.012)
        c = np.tile(TOOTH * 0.88, (len(p), 1))
        c = mix(c, TOOTH_ROOT, smoothstep(0.32, 0.8, mid) * 0.34)
        c = mix(c, TOOTH_ROOT * 0.42, smoothstep(0.62, 1.0, rootward) * 0.92)
        streak_t = perlin(x * 210, y * 16, z * 210) * 2.0 + 0.5
        c = mix(c, TOOTH_ROOT * 0.5, smoothstep(0.6, 0.86, streak_t) * 0.5)
        c = mix(c, BLACK, (1 - ao_small) * 0.9)
        c *= (0.76 + 0.34 * fine)[..., None]
        return c, np.clip(0.34 + (mid - 0.5) * 0.3, 0.2, 0.7).astype(F)

    if kind == "teeth":
        place = part.get("place")
        c = np.tile(TOOTH, (len(p), 1))
        c = mix(c, TOOTH_ROOT, smoothstep(0.3, 0.75, mid) * 0.45)
        # Brown near the gum: upper teeth root high, lower teeth root low.
        rim = np.sqrt((x / A.MOUTH_A) ** 2 + ((y - A.MOUTH_Y) / A.MOUTH_B) ** 2)
        c = mix(c, TOOTH_ROOT * 0.5, smoothstep(0.82, 1.0, rim) * 0.9)
        c *= (0.75 + 0.3 * fine)[..., None]
        return c, np.full(len(p), 0.3, F)

    streak_fall = fbm(x * 42, y * 3.2, z * 42, 3) * 1.5 + 0.5

    if kind == "hand":
        tag_bone = field.sample(field.tags["bone"], p)
        tag_nail = field.sample(field.tags["nail"], p)
        c = mix(PALE, GREY, smoothstep(0.2, 0.9, mid) * 0.42)
        c = mix(c, BRUISE, smoothstep(0.25, 0.95, macro) * 0.32)
        c = mix(c, BONE, smoothstep(0.012, 0.0, tag_bone) * 0.4)
        c = mix(c, ROT, (1 - ao_small) * 0.9)
        nail = smoothstep(0.003, -0.0005, tag_nail)
        c = mix(c, BLACK * 1.4 + BLOOD * 0.3, nail)
        c *= (0.82 + 0.3 * fine)[..., None]
        rough = 0.6 - nail * 0.25
        return c, rough.astype(F)

    if kind == "leg":
        seg = part["segment"]
        tag_bone = field.sample(field.tags["bone"], p)
        tag_tendon = field.sample(field.tags["tendon"], p)
        distal = y / max(float(A.SEGMENT_LENGTHS[seg]), 0.1)
        # Pale near the body, charring toward the claw: dead wood that moves.
        char = np.clip((seg + np.clip(distal, 0, 1)) / 3.2, 0, 1)
        fibre = fbm(x * 58, y * 5.0, z * 58, 3) * 1.6 + 0.5
        c = mix(GREY * 1.05, PALE, smoothstep(0.34, 0.74, fibre) * (1 - char * 0.75))
        c = mix(c, ROT * (0.7 + 0.5 * fibre[..., None]), smoothstep(0.12, 1.0, char) * 0.86)
        c = mix(c, ROT * 0.5, smoothstep(0.42, 0.2, fibre) * 0.5)
        c = mix(c, BRUISE, smoothstep(0.3, 0.95, macro) * 0.22 * (1 - char))
        # Torn patches where muscle shows through, instead of a painted line.
        tear = smoothstep(0.58, 0.8, perlin(x * 6, y * 2.4, z * 6) * 1.7 + 0.5 + (fine - 0.5) * 0.7 + (fibre - 0.5) * 0.4)
        strip = smoothstep(0.008, -0.004, tag_tendon) * tear * (0.8 if seg < 2 else 0.3)
        muscle = TENDON * 0.62 * (0.6 + 0.9 * (0.5 + 0.5 * np.sin(x * 240 + z * 180 + fibre * 6))[..., None])
        c = mix(c, muscle, strip)
        joint = smoothstep(0.014, 0.0, tag_bone)
        bone_colour = BONE * (0.78 + 0.32 * fibre[..., None])
        c = mix(c, bone_colour, joint * (1 - char * 0.62))
        c = mix(c, ROT * 0.32, (1 - ao_small) * 0.95)
        c *= (0.8 + 0.34 * fine)[..., None] * (0.9 + 0.2 * speck)[..., None]
        rough = 0.74 - joint * 0.24 - strip * 0.34 + (fibre - 0.5) * 0.12
        return c, np.clip(rough, 0.26, 0.95).astype(F)

    if kind == "torso":
        tag_bone = field.sample(field.tags["bone"], p)
        tag_tendon = field.sample(field.tags["tendon"], p)
        c = mix(PALE, GREY, smoothstep(0.22, 0.88, mid) * 0.5)
        c = mix(c, BRUISE, smoothstep(0.22, 0.95, macro) * 0.36)
        # Blood pooled along the belly and undersides, with drained skin on top.
        under = smoothstep(1.84, 1.5, y)
        c = mix(c, BRUISE * 0.72, under * (0.32 + 0.4 * smoothstep(0.3, 0.8, mid)))
        c = mix(c, ROT * (0.8 + 0.4 * streak_fall[..., None]), smoothstep(0.55, 0.92, streak_fall) * 0.5)
        c = mix(c, srgb(40, 50, 66), veins * 0.62)
        tear = smoothstep(0.58, 0.8, perlin(x * 6, y * 5.0, z * 6) * 1.7 + 0.5 + (fine - 0.5) * 0.7)
        strip = smoothstep(0.012, -0.006, tag_tendon) * tear * 0.8
        c = mix(c, TENDON * 0.62 * (0.7 + 0.8 * mid[..., None]), strip * 0.85)
        bone = smoothstep(0.018, 0.0, tag_bone)
        c = mix(c, BONE * (0.78 + 0.34 * fine[..., None]), bone * 0.68)
        c = mix(c, ROT * 0.3, (1 - ao_small) * 0.95)
        c *= (0.82 + 0.3 * fine)[..., None]
        rough = 0.54 + (mid - 0.5) * 0.18 - bone * 0.12 - strip * 0.26
        return c, np.clip(rough, 0.24, 0.95).astype(F)

    if part.get("wide"):
        socket = field.sample(field.tags["socket"], p)
        mouth = field.sample(field.tags["mouth"], p)
        gum = field.sample(field.tags["gum"], p)
        bone = field.sample(field.tags["bone"], p)
        c = mix(PALE, GREY, smoothstep(0.22, 0.88, mid) * 0.46)
        c = mix(c, BRUISE, smoothstep(0.26, 0.95, macro) * 0.28)
        c = mix(c, srgb(40, 50, 66), veins * 0.5)
        c = mix(c, BONE, smoothstep(0.01, 0.0, bone) * 0.3)
        # Filth soaking outward from the black around the eyes and the grin.
        soak = np.maximum(smoothstep(0.08, 0.0, socket), smoothstep(0.07, 0.0, mouth))
        stain = perlin(x * 66, y * 4.5, z * 66) * 2.0 + 0.5
        c = mix(c, ROT * 0.45, soak * smoothstep(0.34, 0.74, stain) * 0.75)
        c = mix(c, BLOOD * 0.6, smoothstep(0.05, 0.0, mouth) * smoothstep(0.4, 0.72, stain) * 0.8)
        c = mix(c, ROT * 0.4, (1 - ao_small) * 0.85)
        c *= (0.8 + 0.32 * fine)[..., None]
        void = smoothstep(0.012, -0.004, socket)
        in_mouth = smoothstep(0.012, -0.004, mouth)
        c = mix(c, BLACK * 0.2, in_mouth)
        in_gum = smoothstep(0.006, -0.002, gum)
        c = mix(c, GUM * (0.5 + 0.5 * mid[..., None]), in_gum)
        c = mix(c, BLACK * 0.12, void)
        rough = 0.5 + (mid - 0.5) * 0.18
        rough = rough * (1 - void) + void * 0.98
        rough = rough * (1 - in_gum) + in_gum * 0.3
        return c, np.clip(rough, 0.2, 1.0).astype(F)

    if part.get("void"):
        socket = field.sample(field.tags["socket"], p)
        bone = field.sample(field.tags["bone"], p)
        c = mix(PALE, GREY, smoothstep(0.22, 0.88, mid) * 0.42)
        c = mix(c, BRUISE, smoothstep(0.26, 0.95, macro) * 0.26)
        c = mix(c, srgb(40, 50, 66), veins * 0.5)
        c = mix(c, BONE, smoothstep(0.01, 0.0, bone) * 0.3)
        c = mix(c, ROT * 0.4, (1 - ao_small) * 0.8)
        c *= (0.8 + 0.32 * fine)[..., None]
        void = smoothstep(0.012, -0.004, socket)
        c = mix(c, BLACK * 0.12, void)
        rough = 0.5 + (mid - 0.5) * 0.18
        rough = rough * (1 - void) + void
        return c, np.clip(rough, 0.2, 1.0).astype(F)

    # head
    socket = field.sample(field.tags["socket"], p)
    mouth = field.sample(field.tags["mouth"], p)
    bone = field.sample(field.tags["bone"], p)
    c = mix(PALE, GREY, smoothstep(0.22, 0.88, mid) * 0.42)
    c = mix(c, BRUISE, smoothstep(0.26, 0.95, macro) * 0.3)
    c = mix(c, srgb(40, 50, 66), veins * 0.5)
    c = mix(c, BONE, smoothstep(0.01, 0.0, bone) * 0.32)
    # Darkness soaking out from each orbit, and long stains running down the face.
    eye_d = np.minimum(np.hypot((x + A.EYE_X) / 0.09, (y - A.EYE_Y) / 0.08), np.hypot((x - A.EYE_X) / 0.09, (y - A.EYE_Y) / 0.08))
    c = mix(c, BRUISE * 0.5, smoothstep(1.2, 0.6, eye_d) * 0.75)
    streak = perlin(x * 70, y * 3.4, z * 70) * 2.0 + 0.5
    under_eye = np.maximum(smoothstep(0.05, 0.0, np.abs(np.abs(x) - A.EYE_X)), 0) * smoothstep(0.12, 0.06, y) * smoothstep(-0.22, 0.04, y)
    c = mix(c, BLOOD * 0.65, smoothstep(0.42, 0.72, streak) * under_eye * 0.85)
    # Old blood down the chin and around the mouth.
    rim = np.sqrt((x / A.MOUTH_A) ** 2 + ((y - A.MOUTH_Y) / A.MOUTH_B) ** 2)
    c = mix(c, BLOOD, smoothstep(1.5, 1.02, rim) * smoothstep(0.3, 0.68, mid) * 0.75)
    chin = smoothstep(A.MOUTH_Y - 0.08, A.MOUTH_Y - 0.25, y)
    drips = perlin(x * 84, y * 3, z * 60) * 2.0 + 0.5
    c = mix(c, BLOOD * 0.8, chin * smoothstep(0.42, 0.68, drips) * 0.85)
    in_socket = smoothstep(0.012, -0.002, socket)
    in_mouth = smoothstep(0.01, -0.004, mouth)
    c = mix(c, BLACK * 0.4, in_socket)
    # Inside of the maw: wet gum at the front, blackness in the throat.
    gum = mix(GUM * (0.6 + 0.6 * mid[..., None]), BLOOD * 0.3, smoothstep(0.18, 0.09, z))
    c = mix(c, gum, in_mouth)
    c = mix(c, ROT * 0.4, (1 - ao_small) * 0.75 * (1 - in_mouth))
    c *= (0.78 + 0.34 * fine)[..., None] * (0.92 + 0.16 * speck)[..., None]
    rough = 0.5 + (mid - 0.5) * 0.18 - in_mouth * 0.28 + in_socket * 0.3
    return c, np.clip(rough, 0.18, 0.95).astype(F)


def bake_part(part, field, uv, p_local, n_local, tex, colour, normal_map, rough, written):
    xs, ys, tri, b1, b2 = rasterize(uv, tex)
    b0 = 1 - b1 - b2
    p = p_local[tri, 0] * b0[:, None] + p_local[tri, 1] * b1[:, None] + p_local[tri, 2] * b2[:, None]
    N = n_local[tri, 0] * b0[:, None] + n_local[tri, 1] * b1[:, None] + n_local[tri, 2] * b2[:, None]
    N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-8)

    # Tangent frame from UVs, per triangle.
    e1, e2 = p_local[:, 1] - p_local[:, 0], p_local[:, 2] - p_local[:, 0]
    d1, d2 = uv[:, 1] - uv[:, 0], uv[:, 2] - uv[:, 0]
    r = d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]
    r = np.where(np.abs(r) < 1e-12, 1e-12, r)
    T_all = (e1 * d2[:, 1, None] - e2 * d1[:, 1, None]) / r[:, None]
    B_all = (e2 * d1[:, 0, None] - e1 * d2[:, 0, None]) / r[:, None]
    T = T_all[tri]
    B = B_all[tri]

    # Find the true sculpt surface under each texel.
    p = p.copy()
    for _ in range(4):
        d = field.sample(field.d, p)[:, None]
        p -= field.gradient(field.d, p, field.h * 1.2) * np.clip(d, -0.04, 0.04)
    surface_n = field.gradient(field.d, p, field.h * 1.1)

    # Add micro detail by perturbing the gradient.
    step = max(0.0005, field.h * 0.5)
    base = height_detail(part, p)
    grad = np.empty_like(surface_n)
    for axis in range(3):
        offset = np.zeros(3)
        offset[axis] = step
        grad[:, axis] = (height_detail(part, p + offset) - base) / step
    detail_n = surface_n - (grad - surface_n * (grad * surface_n).sum(1, keepdims=True))
    detail_n /= np.maximum(np.linalg.norm(detail_n, axis=1, keepdims=True), 1e-8)

    # Ambient occlusion straight from the distance field.
    def occlusion(distances):
        total = np.zeros(len(p), F)
        weight = 0.0
        for dist in distances:
            value = field.sample(field.d, p + surface_n * dist)
            total += np.clip(value / dist, 0, 1) / dist
            weight += 1 / dist
        return total / weight

    ao_small = occlusion((0.004, 0.009, 0.018))
    ao_large = occlusion((0.04, 0.09))
    # Where the field is flat its distance values collapse and small-scale occlusion
    # reads falsely black. Real crevices always show up at the larger scale too.
    ao_small = np.maximum(ao_small, smoothstep(0.6, 0.97, ao_large) * 0.82)
    albedo, roughness = shade(part, field, p, surface_n, ao_small, ao_large)
    albedo = albedo * (0.5 + 0.5 * ao_large)[..., None]

    if part.get("void"):
        flat = smoothstep(0.012, -0.004, field.sample(field.tags["socket"], p))[:, None]
        detail_n = detail_n * (1 - flat) + surface_n * flat
        detail_n /= np.maximum(np.linalg.norm(detail_n, axis=1, keepdims=True), 1e-8)

    # Where the projection landed on the wrong layer of the sculpt, the true normal
    # disagrees with the mesh. Baking it would shade that patch black, so use the mesh.
    agree = (surface_n * N).sum(1)
    bad = smoothstep(0.45, 0.15, agree)[:, None]
    if bad.any():
        detail_n = detail_n * (1 - bad) + N * bad
        detail_n /= np.maximum(np.linalg.norm(detail_n, axis=1, keepdims=True), 1e-8)

    # Encode against the interpolated mesh frame.
    Tn = T - N * (T * N).sum(1, keepdims=True)
    Tn /= np.maximum(np.linalg.norm(Tn, axis=1, keepdims=True), 1e-8)
    Bs = np.cross(N, Tn)
    flip = np.sign((Bs * B).sum(1, keepdims=True))
    flip = np.where(flip == 0, 1, flip)
    Bs = Bs * flip
    encoded = np.stack([(detail_n * Tn).sum(1), (detail_n * Bs).sum(1), (detail_n * N).sum(1)], axis=1)
    encoded[:, 2] = np.maximum(encoded[:, 2], 0.05)
    encoded /= np.linalg.norm(encoded, axis=1, keepdims=True)

    colour[ys, xs] = albedo
    normal_map[ys, xs] = encoded * 0.5 + 0.5
    rough[ys, xs] = roughness
    written[ys, xs] = True


def dilate(colour, normal_map, rough, written, iterations):
    filled = written.copy()
    for _ in range(iterations):
        n = np.stack([np.roll(filled, s, axis=a) for s, a in ((1, 0), (-1, 0), (1, 1), (-1, 1))], axis=0)
        count = n.sum(axis=0)
        grow = (~filled) & (count > 0)
        if not grow.any():
            break
        for arr in (colour, normal_map):
            total = np.zeros_like(arr)
            for s, a in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
                shifted = np.roll(arr, s, axis=a) * np.roll(filled, s, axis=a)[..., None]
                total += shifted
            arr[grow] = total[grow] / count[grow, None]
        total = np.zeros_like(rough)
        for s, a in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
            total += np.roll(rough, s, axis=a) * np.roll(filled, s, axis=a)
        rough[grow] = total[grow] / count[grow]
        filled |= grow
    return colour, normal_map, rough
