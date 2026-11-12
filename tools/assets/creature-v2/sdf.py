"""Vectorised signed-distance modelling for the SILENCE creature.

Every anatomical part is a voxel field built from smooth CSG operations and
meshed with naive surface nets. The same fields are sampled again per texel
when baking, so normal maps come straight from the analytic surface and can
never pick up the wrong neighbouring limb the way ray-cast bakes do.
"""
import numpy as np

F = np.float32


# --- noise -----------------------------------------------------------------
_rng = np.random.default_rng(7741)
_perm = np.concatenate([_rng.permutation(256)] * 2)
_grad = _rng.normal(size=(256, 3))
_grad /= np.linalg.norm(_grad, axis=1, keepdims=True)


def perlin(x, y, z):
    """Classic gradient noise in roughly [-0.7, 0.7]."""
    xi = np.floor(x).astype(np.int32)
    yi = np.floor(y).astype(np.int32)
    zi = np.floor(z).astype(np.int32)
    xf, yf, zf = x - xi, y - yi, z - zi
    xi &= 255
    yi &= 255
    zi &= 255
    u = xf * xf * xf * (xf * (xf * 6 - 15) + 10)
    v = yf * yf * yf * (yf * (yf * 6 - 15) + 10)
    w = zf * zf * zf * (zf * (zf * 6 - 15) + 10)

    def corner(ix, iy, iz, dx, dy, dz):
        g = _grad[_perm[_perm[_perm[(xi + ix) & 255] + ((yi + iy) & 255)] + ((zi + iz) & 255)] & 255]
        return g[..., 0] * (xf - dx) + g[..., 1] * (yf - dy) + g[..., 2] * (zf - dz)

    c000 = corner(0, 0, 0, 0, 0, 0)
    c100 = corner(1, 0, 0, 1, 0, 0)
    c010 = corner(0, 1, 0, 0, 1, 0)
    c110 = corner(1, 1, 0, 1, 1, 0)
    c001 = corner(0, 0, 1, 0, 0, 1)
    c101 = corner(1, 0, 1, 1, 0, 1)
    c011 = corner(0, 1, 1, 0, 1, 1)
    c111 = corner(1, 1, 1, 1, 1, 1)
    a = c000 + u * (c100 - c000)
    b = c010 + u * (c110 - c010)
    c = c001 + u * (c101 - c001)
    d = c011 + u * (c111 - c011)
    e = a + v * (b - a)
    f = c + v * (d - c)
    return e + w * (f - e)


def fbm(x, y, z, octaves=4, gain=0.5, lacunarity=2.03):
    total = np.zeros_like(x, dtype=F)
    amplitude = 1.0
    norm = 0.0
    for i in range(octaves):
        total = total + amplitude * perlin(x + i * 17.3, y - i * 9.1, z + i * 5.7)
        norm += amplitude
        amplitude *= gain
        x, y, z = x * lacunarity, y * lacunarity, z * lacunarity
    return total / norm


def ridged(x, y, z, octaves=3):
    total = np.zeros_like(x, dtype=F)
    amplitude = 0.55
    for i in range(octaves):
        n = 1.0 - np.abs(perlin(x + i * 3.1, y + i * 7.9, z - i * 2.3)) * 2.0
        total = total + n * n * amplitude
        amplitude *= 0.5
        x, y, z = x * 2.1, y * 2.1, z * 2.1
    return total


def smoothstep(a, b, v):
    t = np.clip((v - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# --- primitives ------------------------------------------------------------
def ellipsoid(p, c, r):
    r = np.asarray(r, F)
    q = [(p[i] - c[i]) for i in range(3)]
    k0 = np.sqrt(sum((q[i] / r[i]) ** 2 for i in range(3)))
    k1 = np.sqrt(sum((q[i] / (r[i] * r[i])) ** 2 for i in range(3))) + 1e-7
    return k0 * (k0 - 1.0) / k1


def capsule(p, a, b, ra, rb=None):
    rb = ra if rb is None else rb
    ax, ay, az = a
    bax, bay, baz = b[0] - ax, b[1] - ay, b[2] - az
    pax, pay, paz = p[0] - ax, p[1] - ay, p[2] - az
    t = np.clip((pax * bax + pay * bay + paz * baz) / max(bax * bax + bay * bay + baz * baz, 1e-9), 0, 1)
    dx, dy, dz = pax - bax * t, pay - bay * t, paz - baz * t
    return np.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * t)


def box(p, c, half, radius=0.0):
    q = [np.abs(p[i] - c[i]) - (half[i] - radius) for i in range(3)]
    outer = np.sqrt(sum(np.maximum(v, 0) ** 2 for v in q))
    inner = np.minimum(np.maximum(np.maximum(q[0], q[1]), q[2]), 0)
    return outer + inner - radius


def catmull(points, samples):
    """Sample a Catmull-Rom curve through a list of 3D points or scalars."""
    pts = np.asarray(points, dtype=np.float64)
    n = len(pts) - 1
    out = []
    for s in np.linspace(0, 1, samples):
        f = s * n
        k = min(n - 1, int(f))
        f -= k
        a, b, c, d = pts[max(0, k - 1)], pts[k], pts[k + 1], pts[min(n, k + 2)]
        out.append(0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (3 * b - a - 3 * c + d) * f * f * f))
    return np.array(out)


def smooth_tube(points, radii, samples=None):
    """Return tapered capsule segments that follow a smooth curve."""
    samples = samples or max(6, 6 * (len(points) - 1))
    centres = catmull(points, samples)
    rr = catmull(radii, samples)
    return [(centres[i], centres[i + 1], rr[i], rr[i + 1]) for i in range(len(centres) - 1)]


# --- field -----------------------------------------------------------------
class Field:
    """Dense grid with smooth CSG restricted to each primitive's bounding box."""

    def __init__(self, lo, hi, h, tags=()):
        self.lo = np.asarray(lo, dtype=np.float64)
        self.h = float(h)
        self.n = (np.ceil((np.asarray(hi, dtype=np.float64) - self.lo) / self.h).astype(int) + 1)
        self.d = np.full(self.n, 1.0, F)
        self.tags = {t: np.full(self.n, 1.0, F) for t in tags}

    def region(self, lo, hi):
        i0 = np.maximum(np.floor((np.asarray(lo) - self.lo) / self.h).astype(int), 0)
        i1 = np.minimum(np.ceil((np.asarray(hi) - self.lo) / self.h).astype(int) + 1, self.n)
        if np.any(i1 <= i0):
            return None
        return tuple(slice(int(a), int(b)) for a, b in zip(i0, i1))

    def coords(self, region):
        axes = [np.asarray(self.lo[i] + self.h * np.arange(region[i].start, region[i].stop), F) for i in range(3)]
        return np.meshgrid(*axes, indexing="ij", sparse=True)

    @staticmethod
    def _smin(a, b, k):
        if k <= 0:
            return np.minimum(a, b)
        h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
        return b + (a - b) * h - k * h * (1 - h)

    def _tag(self, region, d, tag):
        if tag is None:
            return
        for t in (tag if isinstance(tag, (list, tuple)) else [tag]):
            self.tags[t][region] = np.minimum(self.tags[t][region], d)

    def union(self, fn, bounds, k=0.02, tag=None, pad=0.0):
        lo, hi = np.asarray(bounds[0], float) - (k * 2.5 + pad + self.h * 3), np.asarray(bounds[1], float) + (k * 2.5 + pad + self.h * 3)
        region = self.region(lo, hi)
        if region is None:
            return
        d = np.asarray(fn(self.coords(region)), F)
        self.d[region] = self._smin(self.d[region], d, k)
        self._tag(region, d, tag)

    def subtract(self, fn, bounds, k=0.02, tag=None):
        lo, hi = np.asarray(bounds[0], float) - (k * 2.5 + self.h * 3), np.asarray(bounds[1], float) + (k * 2.5 + self.h * 3)
        region = self.region(lo, hi)
        if region is None:
            return
        d = np.asarray(fn(self.coords(region)), F)
        self.d[region] = -self._smin(-self.d[region], d, k)
        self._tag(region, d, tag)

    # conveniences ----------------------------------------------------------
    def add_ellipsoid(self, c, r, k=0.02, tag=None):
        c = tuple(c)
        self.union(lambda p: ellipsoid(p, c, r), (np.subtract(c, r), np.add(c, r)), k, tag)

    def cut_ellipsoid(self, c, r, k=0.02, tag=None):
        c = tuple(c)
        self.subtract(lambda p: ellipsoid(p, c, r), (np.subtract(c, r), np.add(c, r)), k, tag)

    def add_capsule(self, a, b, ra, rb=None, k=0.02, tag=None):
        rb = ra if rb is None else rb
        m = max(ra, rb)
        lo, hi = np.minimum(a, b) - m, np.maximum(a, b) + m
        self.union(lambda p: capsule(p, a, b, ra, rb), (lo, hi), k, tag)

    def cut_capsule(self, a, b, ra, rb=None, k=0.02, tag=None):
        rb = ra if rb is None else rb
        m = max(ra, rb)
        lo, hi = np.minimum(a, b) - m, np.maximum(a, b) + m
        self.subtract(lambda p: capsule(p, a, b, ra, rb), (lo, hi), k, tag)

    def add_tube(self, points, radii, k=0.02, tag=None, samples=None):
        """Add a curved tube as a single smooth union, so its links never show."""
        segs = smooth_tube(points, radii, samples)
        lo = np.min([np.minimum(a, b) - max(ra, rb) for a, b, ra, rb in segs], axis=0)
        hi = np.max([np.maximum(a, b) + max(ra, rb) for a, b, ra, rb in segs], axis=0)

        def fn(p):
            out = None
            for a, b, ra, rb in segs:
                d = capsule(p, a, b, ra, rb)
                out = d if out is None else np.minimum(out, d)
            return out

        self.union(fn, (lo, hi), k, tag)

    def cut_tube(self, points, radii, k=0.01, tag=None, samples=None):
        segs = smooth_tube(points, radii, samples)
        lo = np.min([np.minimum(a, b) - max(ra, rb) for a, b, ra, rb in segs], axis=0)
        hi = np.max([np.maximum(a, b) + max(ra, rb) for a, b, ra, rb in segs], axis=0)

        def fn(p):
            out = None
            for a, b, ra, rb in segs:
                d = capsule(p, a, b, ra, rb)
                out = d if out is None else np.minimum(out, d)
            return out

        self.subtract(fn, (lo, hi), k, tag)

    def displace(self, fn, band=0.05):
        """Apply surface displacement only near the surface."""
        idx = np.argwhere(np.abs(self.d) < band)
        if len(idx) == 0:
            return
        p = [(self.lo[i] + self.h * idx[:, i]).astype(F) for i in range(3)]
        self.d[idx[:, 0], idx[:, 1], idx[:, 2]] += np.asarray(fn(p), F)

    # sampling --------------------------------------------------------------
    def sample(self, grid, p):
        """Trilinear sample at Nx3 positions."""
        q = (p - self.lo) / self.h
        i = np.clip(np.floor(q).astype(np.int64), 0, self.n - 2)
        f = np.clip(q - i, 0, 1).astype(F)
        x, y, z = i[:, 0], i[:, 1], i[:, 2]
        fx, fy, fz = f[:, 0], f[:, 1], f[:, 2]
        c00 = grid[x, y, z] * (1 - fx) + grid[x + 1, y, z] * fx
        c10 = grid[x, y + 1, z] * (1 - fx) + grid[x + 1, y + 1, z] * fx
        c01 = grid[x, y, z + 1] * (1 - fx) + grid[x + 1, y, z + 1] * fx
        c11 = grid[x, y + 1, z + 1] * (1 - fx) + grid[x + 1, y + 1, z + 1] * fx
        return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz

    def gradient(self, grid, p, step=None):
        e = step or self.h
        out = np.empty((len(p), 3), F)
        for axis in range(3):
            offset = np.zeros(3)
            offset[axis] = e
            out[:, axis] = self.sample(grid, p + offset) - self.sample(grid, p - offset)
        return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-7)

    # meshing ---------------------------------------------------------------
    def mesh(self):
        return surface_nets(self.d, self.lo, self.h)


def surface_nets(d, lo, h):
    """Naive surface nets. Returns (verts Nx3, quads Mx4); faces point outward."""
    inside = d < 0
    counts = (
        inside[:-1, :-1, :-1].astype(np.int8) + inside[1:, :-1, :-1] + inside[:-1, 1:, :-1] + inside[1:, 1:, :-1]
        + inside[:-1, :-1, 1:] + inside[1:, :-1, 1:] + inside[:-1, 1:, 1:] + inside[1:, 1:, 1:]
    )
    active = (counts > 0) & (counts < 8)
    del counts
    cells = np.argwhere(active)
    del active
    vid = np.full(np.array(d.shape) - 1, -1, np.int32)
    vid[cells[:, 0], cells[:, 1], cells[:, 2]] = np.arange(len(cells), dtype=np.int32)

    # Average the zero crossing over all 12 cell edges.
    corner = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]])
    edges = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    total = np.zeros((len(cells), 3), np.float64)
    hits = np.zeros(len(cells), np.int32)
    for a, b in edges:
        ca, cb = cells + corner[a], cells + corner[b]
        va = d[ca[:, 0], ca[:, 1], ca[:, 2]]
        vb = d[cb[:, 0], cb[:, 1], cb[:, 2]]
        crossing = (va < 0) != (vb < 0)
        t = va[crossing] / (va[crossing] - vb[crossing])
        total[crossing] += corner[a] + (corner[b] - corner[a]) * t[:, None]
        hits[crossing] += 1
    verts = (cells + total / np.maximum(hits, 1)[:, None]) * h + lo

    quads = []
    shape = np.array(d.shape)
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        first = [slice(0, shape[i] - 1) if i == axis else slice(None) for i in range(3)]
        second = [slice(1, shape[i]) if i == axis else slice(None) for i in range(3)]
        change = inside[tuple(first)] != inside[tuple(second)]
        idx = np.argwhere(change)
        # A crossing on the grid boundary has no four surrounding cells.
        keep = (idx[:, u] > 0) & (idx[:, v] > 0) & (idx[:, u] < shape[u] - 1) & (idx[:, v] < shape[v] - 1)
        idx = idx[keep]
        if len(idx) == 0:
            continue
        flip = ~inside[idx[:, 0], idx[:, 1], idx[:, 2]]
        du = np.zeros(3, int)
        dv = np.zeros(3, int)
        du[u] = 1
        dv[v] = 1
        q = np.stack([idx - du - dv, idx - dv, idx, idx - du], axis=1)
        ids = vid[q[..., 0], q[..., 1], q[..., 2]]
        ids[flip] = ids[flip][:, ::-1]
        quads.append(ids)
    return verts, np.concatenate(quads)


def relax(verts, quads, iterations=2, strength=0.5):
    """Laplacian relaxation that removes the voxel staircase before decimation."""
    v = verts.copy()
    a = quads.reshape(-1)
    b = np.roll(quads, -1, axis=1).reshape(-1)
    for _ in range(iterations):
        total = np.zeros_like(v)
        count = np.zeros(len(v))
        np.add.at(total, a, v[b])
        np.add.at(count, a, 1)
        np.add.at(total, b, v[a])
        np.add.at(count, b, 1)
        v += (total / np.maximum(count, 1)[:, None] - v) * strength
    return v
