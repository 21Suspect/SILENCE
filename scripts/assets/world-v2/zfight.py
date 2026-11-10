#!/usr/bin/env python3
"""zfight.py - find Z-FIGHTING in the world-v2 prop GLBs without anyone looking at them.

Z-fighting is two faces on (almost) the same plane that overlap in area, so the depth buffer
cannot decide which one is in front and the surface flickers as the camera moves.  This reads
every GLB in public/world/ (binary glTF parsed here, no dependencies beyond numpy), puts all
triangles in model space (glTF is y-up, metres, exactly the game's frame for the prop),
and reports every patch where two triangles

  (a) have normals parallel within --angle degrees (default 1.0), facing the SAME way or
      OPPOSITE ways (reported as two different kinds),
  (b) are within --tol-mm (default 1.5 mm) of each other's plane, measured over the overlap,
  (c) overlap in positive area in that plane (shared edges / vertices do not count, adjacent
      triangles of one surface therefore never match).

Hits are clustered into findings: one contiguous coplanar patch of ONE pair of parts (parts =
edge-connected triangle shells of the baked mesh, described by size and shape), ranked by the area
that is actually fighting (union of the overlaps, so a triple-stacked face is not counted three
times).  Each finding is classed

  SAME      same-facing and in the open: the visible flicker.  Fix these.
  HIDDEN    same-facing but never seen: a downward face at the prop's y=0 base (sunk in the terrain)
            or a patch entirely inside another solid (ray test: 1 mm above the patch, the first
            surface met is seen from behind).  The ray test is a heuristic, run on the 80 biggest.
  OPP       opposite-facing coincident faces.  With consistently outward normals this is the contact
            plane of two abutting solids, each face buried behind the other body: normally harmless.
            Listed separately, lower severity.

Each finding also says how far away a gap of that size still flickers (24-bit depth buffer, camera
near plane 0.075 m as in game/engine.ts): an exact 0 mm gap flickers at any range, 0.5 mm only from
about 25 m, 1.5 mm only from about 45 m.  Fix the 0 mm ones first.

RUN
  python3 scripts/assets/world-v2/zfight.py                  # every GLB in public/world, worst first
  python3 scripts/assets/world-v2/zfight.py well ruin gate   # named assets (or paths to .glb)
  python3 scripts/assets/world-v2/zfight.py --selftest       # synthetic calibration, writes nothing
  python3 scripts/assets/world-v2/zfight.py -v cabin         # list every finding, not just the top few
  # same script inside Blender's bundled python (it also ships numpy):
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
      --python scripts/assets/world-v2/zfight.py -- [asset ...]

Needs python3 with numpy (system python3 here: 3.9 with numpy 2.0.2).  Writes
assets/world-v2/review/<asset>.zfight.json for each asset (not in --selftest).  Always exits 0:
it is a report, not a gate.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[3]
WORLD_DIR = REPO / "public" / "world"
REVIEW_DIR = REPO / "assets" / "world-v2" / "review"

DEFAULTS = dict(
    tol_mm=1.5,        # plane distance below which two surfaces can z-fight
    angle_deg=1.0,     # normals parallel within this
    min_area_cm2=1.0,  # findings below this total overlapping area are ignored
    min_tri_area_m2=1e-7,  # triangles smaller than 0.1 mm^2 have no usable normal
    sat_eps_m=2e-5,    # overlap must be deeper than 0.02 mm to count as area (edge/vertex contact does not)
    near_m=0.075,      # game camera near plane (game/engine.ts) - used only to estimate how far away a gap still flickers
    depth_bits=24,
    exposure_checks=80,  # how many same-facing findings (largest first) get the buried-in-a-solid ray test
    ground_y_m=0.03,   # downward faces within +/-3 cm of the prop's y=0 base plane sit in the terrain and are never seen
)

# ----------------------------------------------------------------------------------------------
# glTF / GLB reading
# ----------------------------------------------------------------------------------------------
_CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def split_glb(data: bytes):
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError("not a binary glTF (bad magic)")
    off, js, binchunk = 12, None, None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        body = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(body.decode("utf-8"))
        elif ctype == 0x004E4942 and binchunk is None:
            binchunk = body
        off += 8 + clen
    if js is None:
        raise ValueError("GLB has no JSON chunk")
    return js, binchunk or b""


def read_accessor(js, buf, index):
    acc = js["accessors"][index]
    dt = np.dtype(_CT[acc["componentType"]]).newbyteorder("<")
    ncomp, count = _NC[acc["type"]], acc["count"]
    if "bufferView" in acc:
        bv = js["bufferViews"][acc["bufferView"]]
        base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = bv.get("byteStride") or ncomp * dt.itemsize
        arr = np.ndarray((count, ncomp), dtype=dt, buffer=buf, offset=base, strides=(stride, dt.itemsize))
        arr = np.array(arr)  # own the memory
    else:
        arr = np.zeros((count, ncomp), dtype=dt)
    if "sparse" in acc:
        sp = acc["sparse"]
        n = sp["count"]
        ibv, vbv = js["bufferViews"][sp["indices"]["bufferView"]], js["bufferViews"][sp["values"]["bufferView"]]
        idt = np.dtype(_CT[sp["indices"]["componentType"]]).newbyteorder("<")
        sidx = np.frombuffer(buf, idt, n, ibv.get("byteOffset", 0) + sp["indices"].get("byteOffset", 0))
        sval = np.frombuffer(buf, dt, n * ncomp, vbv.get("byteOffset", 0) + sp["values"].get("byteOffset", 0)).reshape(n, ncomp)
        arr[sidx.astype(np.int64)] = sval
    if acc.get("normalized") and dt.kind in "iu":
        info = np.iinfo(dt)
        arr = np.maximum(arr.astype(np.float64) / info.max, -1.0) if dt.kind == "i" else arr.astype(np.float64) / info.max
    return arr


def _node_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    t = np.array(node.get("translation", [0, 0, 0]), dtype=np.float64)
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    s = np.array(node.get("scale", [1, 1, 1]), dtype=np.float64)
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / n, y / n, z / n, w / n
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = r * s[None, :]
    m[:3, 3] = t
    return m


def _strip_fan_to_tris(idx, mode):
    n = len(idx)
    if mode == 5:  # strip
        out = []
        for i in range(n - 2):
            out.append((idx[i], idx[i + 1], idx[i + 2]) if i % 2 == 0 else (idx[i + 1], idx[i], idx[i + 2]))
        return np.array(out, dtype=np.int64).reshape(-1, 3)
    return np.array([(idx[0], idx[i], idx[i + 1]) for i in range(1, n - 1)], dtype=np.int64).reshape(-1, 3)  # fan


def load_model(data: bytes, name: str = "model"):
    """Parse a GLB (bytes) into world-space triangles plus per-triangle bookkeeping."""
    js, buf = split_glb(data)
    warnings = []
    for ext in js.get("extensionsRequired", []):
        if ext in ("KHR_draco_mesh_compression", "EXT_meshopt_compression"):
            raise ValueError("compressed geometry (%s) is not supported" % ext)
    nodes = js.get("nodes", [])
    scenes = js.get("scenes", [])
    if scenes:
        roots = scenes[js.get("scene", 0)].get("nodes", [])
    else:
        children = {c for n in nodes for c in n.get("children", [])}
        roots = [i for i in range(len(nodes)) if i not in children]

    materials = js.get("materials", [])
    mat_info = [
        dict(name=m.get("name", "mat%d" % i), double_sided=bool(m.get("doubleSided", False)),
             alpha_mode=m.get("alphaMode", "OPAQUE"))
        for i, m in enumerate(materials)
    ]
    default_mat = len(mat_info)
    mat_info.append(dict(name="(default)", double_sided=False, alpha_mode="OPAQUE"))

    tri_list, uv_list, mat_list, node_list, prim_list = [], [], [], [], []
    node_names = []
    cache = {}

    def prim_data(mi, pi, prim):
        key = (mi, pi)
        if key in cache:
            return cache[key]
        if "extensions" in prim and "KHR_draco_mesh_compression" in prim["extensions"]:
            raise ValueError("draco-compressed primitive")
        pos = read_accessor(js, buf, prim["attributes"]["POSITION"]).astype(np.float64)
        if "indices" in prim:
            idx = read_accessor(js, buf, prim["indices"]).reshape(-1).astype(np.int64)
        else:
            idx = np.arange(len(pos), dtype=np.int64)
        mode = prim.get("mode", 4)
        if mode == 4:
            idx = idx[: len(idx) // 3 * 3].reshape(-1, 3)
        elif mode in (5, 6):
            idx = _strip_fan_to_tris(idx, mode)
        else:
            idx = np.zeros((0, 3), dtype=np.int64)  # points / lines
        uv = None
        if "TEXCOORD_0" in prim["attributes"]:
            uv = read_accessor(js, buf, prim["attributes"]["TEXCOORD_0"]).astype(np.float64)
        cache[key] = (pos, idx, uv, prim.get("material", default_mat))
        return cache[key]

    def walk(ni, parent, depth=0):
        if depth > 64:
            return
        node = nodes[ni]
        world = parent @ _node_matrix(node)
        node_names.append(node.get("name", "node%d" % ni))
        my_node_id = len(node_names) - 1
        if "mesh" in node:
            mesh = js["meshes"][node["mesh"]]
            flip = np.linalg.det(world[:3, :3]) < 0
            for pi, prim in enumerate(mesh.get("primitives", [])):
                pos, idx, uv, mat = prim_data(node["mesh"], pi, prim)
                if len(idx) == 0:
                    continue
                with np.errstate(all="ignore"):  # Accelerate-backed matmul raises bogus FP flags on some macOS builds
                    wpos = pos @ world[:3, :3].T + world[:3, 3]
                ii = idx[:, [0, 2, 1]] if flip else idx
                tri_list.append(wpos[ii])
                uv_list.append(uv[ii] if uv is not None else np.full((len(ii), 3, 2), np.nan))
                mat_list.append(np.full(len(ii), mat, dtype=np.int32))
                node_list.append(np.full(len(ii), my_node_id, dtype=np.int32))
                prim_list.append(np.full(len(ii), pi, dtype=np.int32))
        for c in node.get("children", []):
            walk(c, world, depth + 1)

    for r in roots:
        walk(r, np.eye(4))

    if tri_list:
        tris = np.concatenate(tri_list)
        uvs = np.concatenate(uv_list)
        mats = np.concatenate(mat_list)
        nodes_arr = np.concatenate(node_list)
        prims = np.concatenate(prim_list)
    else:
        tris = np.zeros((0, 3, 3))
        uvs = np.zeros((0, 3, 2))
        mats = np.zeros(0, dtype=np.int32)
        nodes_arr = np.zeros(0, dtype=np.int32)
        prims = np.zeros(0, dtype=np.int32)
    return dict(name=name, tris=tris, uvs=uvs, mat=mats, node=nodes_arr, prim=prims, node_names=node_names,
                materials=mat_info, warnings=warnings)


# ----------------------------------------------------------------------------------------------
# Broad phase: triangles whose (inflated) boxes overlap, found with a spatial hash
# ----------------------------------------------------------------------------------------------
def aabb_candidate_pairs(bmin, bmax, cs, cap=125, chunk=3_000_000):
    """Yield (ia, ib) index arrays of boxes that share a grid cell. Each overlapping pair is yielded once
    (in the cell holding the max corner of the two minima). Boxes that would touch more than `cap`
    cells are 'big' and tested against everything directly."""
    n = len(bmin)
    if n < 2:
        return
    i0 = np.floor(bmin / cs).astype(np.int64)
    i1 = np.floor(bmax / cs).astype(np.int64)
    cnt = i1 - i0 + 1
    tot = cnt[:, 0] * cnt[:, 1] * cnt[:, 2]
    small = tot <= cap
    big_ids = np.nonzero(~small)[0]
    ids = np.nonzero(small)[0]
    if len(ids) > 1:
        c = cnt[ids]
        t = tot[ids]
        owner = np.repeat(ids, t)
        starts = np.cumsum(t) - t
        local = np.arange(int(t.sum()), dtype=np.int64) - np.repeat(starts, t)
        cy_cz = np.repeat(c[:, 1] * c[:, 2], t)
        cz = np.repeat(c[:, 2], t)
        a = local // cy_cz
        b = (local // cz) % np.repeat(c[:, 1], t)
        d = local % cz
        cell = i0[owner] + np.stack([a, b, d], axis=1)
        gmin = cell.min(axis=0)
        dims = cell.max(axis=0) - gmin + 1
        rel = cell - gmin
        key = (rel[:, 0] * dims[1] + rel[:, 1]) * dims[2] + rel[:, 2]
        order = np.argsort(key, kind="stable")
        key, owner, cell = key[order], owner[order], cell[order]
        m = len(key)
        change = np.flatnonzero(np.diff(key)) + 1
        gstart = np.concatenate(([0], change))
        gend = np.concatenate((change, [m]))
        gend_per_entry = np.repeat(gend, gend - gstart)
        counts = gend_per_entry - np.arange(m) - 1
        cum = np.cumsum(counts)
        total_pairs = int(cum[-1]) if m else 0
        s = 0
        while s < m and total_pairs > 0:
            base = cum[s - 1] if s else 0
            e = int(np.searchsorted(cum, base + chunk, side="right"))
            e = max(e, s + 1)
            e = min(e, m)
            cn = counts[s:e]
            tp = int(cn.sum())
            if tp:
                apos = np.repeat(np.arange(s, e), cn)
                offs = np.arange(tp, dtype=np.int64) - np.repeat(np.cumsum(cn) - cn, cn)
                bpos = apos + 1 + offs
                ia, ib = owner[apos], owner[bpos]
                canon = np.maximum(i0[ia], i0[ib])
                ok = (canon == cell[apos]).all(axis=1)
                if ok.any():
                    yield ia[ok], ib[ok]
            s = e
    if len(big_ids):
        is_big = ~small
        for b in big_ids:
            mask = (bmin <= bmax[b]).all(axis=1) & (bmax >= bmin[b]).all(axis=1)
            mask[b] = False
            mask &= ~is_big | (np.arange(n) > b)
            others = np.nonzero(mask)[0]
            if len(others):
                yield np.full(len(others), b, dtype=np.int64), others


# ----------------------------------------------------------------------------------------------
# Narrow phase
# ----------------------------------------------------------------------------------------------
def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-300)


def _project(V, o, e1, e2):
    """V (K,3,3) world -> (K,3,2) in the plane frame (o,e1,e2) each (K,3)."""
    d = V - o[:, None, :]
    return np.stack([np.einsum("kvc,kc->kv", d, e1), np.einsum("kvc,kc->kv", d, e2)], axis=2)


def _sat_overlap(A2, B2, eps):
    """Positive-area overlap test for two sets of 2D triangles (K,3,2). Touching = no overlap."""
    ok = np.ones(len(A2), dtype=bool)
    for T in (A2, B2):
        E = np.roll(T, -1, axis=1) - T
        L = np.maximum(np.linalg.norm(E, axis=2, keepdims=True), 1e-300)
        ax = np.stack([-E[..., 1], E[..., 0]], axis=2) / L
        pa = np.einsum("kae,kve->kav", ax, A2)
        pb = np.einsum("kae,kve->kav", ax, B2)
        sep = (pa.max(2) <= pb.min(2) + eps) | (pb.max(2) <= pa.min(2) + eps)
        ok &= ~sep.any(axis=1)
    return ok


def _clip(poly, a, b, c):
    """Sutherland-Hodgman: keep the part of the convex polygon where a*x + b*y + c >= 0."""
    out = []
    n = len(poly)
    for i in range(n):
        p, q = poly[i], poly[(i + 1) % n]
        dp = a * p[0] + b * p[1] + c
        dq = a * q[0] + b * q[1] + c
        if dp >= 0:
            out.append(p)
            if dq < 0:
                t = dp / (dp - dq)
                out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
        elif dq >= 0:
            t = dp / (dp - dq)
            out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def _poly_area(poly):
    s = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return 0.5 * s


def _poly_centroid(w3):
    """Area-weighted centroid of a convex 3D polygon (fan from vertex 0)."""
    a = w3[1:-1] - w3[0]
    b = w3[2:] - w3[0]
    ar = 0.5 * np.linalg.norm(np.cross(a, b), axis=1)
    if ar.sum() <= 0:
        return w3.mean(axis=0)
    cen = (w3[0] + w3[1:-1] + w3[2:]) / 3.0
    return (cen * ar[:, None]).sum(axis=0) / ar.sum()


def find_hits(tris, cfg):
    """Return dict of arrays describing every overlapping, near-coplanar triangle pair."""
    tol = cfg["tol_mm"] * 1e-3
    cos_tol = math.cos(math.radians(cfg["angle_deg"]))
    eps = cfg["sat_eps_m"]
    P0, P1, P2 = tris[:, 0], tris[:, 1], tris[:, 2]
    cr = np.cross(P1 - P0, P2 - P0)
    ln = np.linalg.norm(cr, axis=1)
    area = 0.5 * ln
    valid = area >= cfg["min_tri_area_m2"]
    N = cr / np.maximum(ln, 1e-300)[:, None]
    bmin = tris.min(axis=1) - tol
    bmax = tris.max(axis=1) + tol
    bmin[~valid] = np.inf  # invalid triangles never match anything
    bmax[~valid] = -np.inf
    n = len(tris)
    stats = dict(triangles=int(n), degenerate=int((~valid).sum()), candidates=0, near_coplanar=0, overlapping=0)
    empty = dict(ia=np.zeros(0, np.int64), ib=np.zeros(0, np.int64), area=np.zeros(0), polys=[], gap_mean=np.zeros(0),
                 gap_max=np.zeros(0), cos=np.zeros(0), centroid=np.zeros((0, 3)), stats=stats)
    if n < 2 or valid.sum() < 2:
        return empty
    vidx = np.nonzero(valid)[0]
    ext = np.max(bmax[vidx] - bmin[vidx], axis=1)
    cs = float(np.clip(2.0 * np.median(ext), 0.02, 0.25))

    surv_a, surv_b = [], []
    # work on valid triangles only (indices mapped back)
    sub_min, sub_max = bmin[vidx], bmax[vidx]
    for sa, sb in aabb_candidate_pairs(sub_min, sub_max, cs):
        ia, ib = vidx[sa], vidx[sb]
        stats["candidates"] += len(ia)
        dots = np.einsum("ij,ij->i", N[ia], N[ib])
        k = np.abs(dots) >= cos_tol
        if not k.any():
            continue
        ia, ib = ia[k], ib[k]
        k = (bmin[ia] <= bmax[ib]).all(axis=1) & (bmin[ib] <= bmax[ia]).all(axis=1)
        ia, ib = ia[k], ib[k]
        if not len(ia):
            continue
        dB = np.einsum("kvc,kc->kv", tris[ib] - P0[ia][:, None, :], N[ia])
        dA = np.einsum("kvc,kc->kv", tris[ia] - P0[ib][:, None, :], N[ib])
        k = ~(((dB > tol).all(1) | (dB < -tol).all(1)) | ((dA > tol).all(1) | (dA < -tol).all(1)))
        ia, ib = ia[k], ib[k]
        if not len(ia):
            continue
        stats["near_coplanar"] += len(ia)
        e1 = _unit(P1[ia] - P0[ia])
        e2 = np.cross(N[ia], e1)
        A2 = _project(tris[ia], P0[ia], e1, e2)
        B2 = _project(tris[ib], P0[ia], e1, e2)
        k = _sat_overlap(A2, B2, eps)
        if k.any():
            surv_a.append(ia[k])
            surv_b.append(ib[k])
    if not surv_a:
        return empty
    ia = np.concatenate(surv_a)
    ib = np.concatenate(surv_b)
    stats["overlapping"] = int(len(ia))

    # exact overlap polygon, restricted to where the two surfaces are within tolerance
    e1 = _unit(P1[ia] - P0[ia])
    e2 = np.cross(N[ia], e1)
    A2 = _project(tris[ia], P0[ia], e1, e2)
    B2 = _project(tris[ib], P0[ia], e1, e2)
    same = np.einsum("ij,ij->i", N[ia], N[ib]) > 0
    # f(u,v) = n_B . (p - b0) with p = a0 + u e1 + v e2 : distance of A's plane point from B's plane
    f0 = np.einsum("kc,kc->k", N[ib], P0[ia] - P0[ib])
    gu = np.einsum("kc,kc->k", N[ib], e1)
    gv = np.einsum("kc,kc->k", N[ib], e2)

    out_a, out_b, out_area, out_polys, out_gm, out_gx, out_cos, out_c = [], [], [], [], [], [], [], []
    for k in range(len(ia)):
        poly = [tuple(p) for p in A2[k]]
        B = B2[k]
        if not same[k]:  # B is CW in A's frame; reverse to CCW
            B = B[[0, 2, 1]]
        for j in range(3):
            x0, y0 = B[j]
            x1, y1 = B[(j + 1) % 3]
            # inside (left of edge) :  (x1-x0)*(y-y0) - (y1-y0)*(x-x0) >= 0
            ex, ey = x1 - x0, y1 - y0
            poly = _clip(poly, -ey, ex, ey * x0 - ex * y0)
            if len(poly) < 3:
                break
        if len(poly) < 3:
            continue
        poly = _clip(poly, -gu[k], -gv[k], tol - f0[k])   # f <= tol
        if len(poly) < 3:
            continue
        poly = _clip(poly, gu[k], gv[k], tol + f0[k])     # f >= -tol
        if len(poly) < 3:
            continue
        ar = _poly_area(poly)
        if ar <= 1e-8:  # < 0.01 cm2: a sliver
            continue
        pu = np.array(poly)
        fv = np.abs(f0[k] + gu[k] * pu[:, 0] + gv[k] * pu[:, 1])
        w3 = P0[ia[k]][None, :] + pu[:, 0:1] * e1[k][None, :] + pu[:, 1:2] * e2[k][None, :]
        out_a.append(ia[k])
        out_b.append(ib[k])
        out_area.append(ar)
        out_polys.append(w3)
        out_gm.append(float(fv.mean()))
        out_gx.append(float(fv.max()))
        out_cos.append(float(np.dot(N[ia[k]], N[ib[k]])))
        out_c.append(_poly_centroid(w3))
    return dict(ia=np.array(out_a, dtype=np.int64), ib=np.array(out_b, dtype=np.int64), area=np.array(out_area),
                polys=out_polys, gap_mean=np.array(out_gm), gap_max=np.array(out_gx), cos=np.array(out_cos),
                centroid=np.array(out_c).reshape(-1, 3), stats=stats)


# ----------------------------------------------------------------------------------------------
# Parts: edge-connected shells of the baked mesh, so a finding can say WHAT collides
# ----------------------------------------------------------------------------------------------
def tri_components(tris):
    n = len(tris)
    q = np.round(tris.reshape(-1, 3) / 5e-5).astype(np.int64)
    _, vid = np.unique(q, axis=0, return_inverse=True)
    vid = vid.reshape(-1).reshape(n, 3)
    nv = int(vid.max()) + 1 if n else 1
    ea = np.concatenate([vid[:, 0], vid[:, 1], vid[:, 2]])
    eb = np.concatenate([vid[:, 1], vid[:, 2], vid[:, 0]])
    lo, hi = np.minimum(ea, eb), np.maximum(ea, eb)
    key = lo * nv + hi
    tri_of = np.concatenate([np.arange(n)] * 3)
    order = np.argsort(key, kind="stable")
    key, tri_of = key[order], tri_of[order]
    same = np.flatnonzero(key[1:] == key[:-1])
    parent = np.arange(n)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in same.tolist():
        a, b = find(int(tri_of[i])), find(int(tri_of[i + 1]))
        if a != b:
            parent[max(a, b)] = min(a, b)
    comp = np.array([find(i) for i in range(n)], dtype=np.int64)
    _, comp = np.unique(comp, return_inverse=True)
    return comp.reshape(-1)


def describe_part(model, comp, cid, cache):
    if cid in cache:
        return cache[cid]
    tri_ids = np.nonzero(comp == cid)[0]
    pts = model["tris"][tri_ids].reshape(-1, 3)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    dims = np.sort(hi - lo) * 100.0  # cm
    ntri = int(len(tri_ids))
    d0, d1, d2 = dims
    if ntri <= 2 and d0 < 0.5:
        shape = "flat quad"
    elif d0 < 1.0 and d1 > 4 * max(d0, 0.1):
        shape = "thin sheet"
    elif d0 < 4.0 and d1 < 4.0 and d2 > 4 * max(d1, 1.0):
        shape = "rod/strip"
    elif d0 < 4.0 and d1 > 3 * d0:
        shape = "slab/plate"
    else:
        shape = "solid"
    nodes = sorted({model["node_names"][i] for i in np.unique(model["node"][tri_ids])})
    mats = sorted({model["materials"][i]["name"] for i in np.unique(model["mat"][tri_ids])})
    info = dict(id=int(cid), triangles=ntri, shape=shape,
                bbox_min=[round(float(v), 4) for v in lo], bbox_max=[round(float(v), 4) for v in hi],
                size_cm=[round(float(v), 1) for v in (hi - lo) * 100.0],
                centre=[round(float(v), 3) for v in (lo + hi) / 2], nodes=nodes[:4], materials=mats[:4])
    cache[cid] = info
    return info


# ----------------------------------------------------------------------------------------------
# Clustering hits into findings
# ----------------------------------------------------------------------------------------------
def _sample_points(polys, count):
    """Up to `count` points spread over the overlap polygons (largest first): centroids, then points inside the biggest one."""
    pts = [_poly_centroid(p) for p in polys[:count]]
    if len(pts) < count:
        big = polys[0]
        c = pts[0]
        for v in big:
            pts.append(0.55 * c + 0.45 * v)
            if len(pts) >= count:
                break
    return pts


def _axis_label(n):
    a = np.abs(n)
    k = int(np.argmax(a))
    if a[k] > 0.985:
        return ("+" if n[k] > 0 else "-") + "XYZ"[k] + {0: " (side)", 1: " (top)" if n[k] > 0 else " (underside)", 2: " (side)"}[k]
    return "tilted (%.2f, %.2f, %.2f)" % tuple(n)


def _union_area(polys, n):
    """Area of the union of coplanar convex polygons (3D points), by rasterising in the plane frame."""
    if len(polys) == 1:
        return abs(_poly_area_3d(polys[0], n))
    allp = np.concatenate(polys)
    o = allp.mean(axis=0)
    helper = np.array([0.0, 1.0, 0.0]) if abs(n[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    e1 = _unit(np.cross(helper, n))
    e2 = np.cross(n, e1)
    uv = [np.stack([(p - o) @ e1, (p - o) @ e2], axis=1) for p in polys]
    lo = np.min([p.min(axis=0) for p in uv], axis=0)
    hi = np.max([p.max(axis=0) for p in uv], axis=0)
    span = hi - lo
    res = max(0.001, math.sqrt(max(span[0] * span[1], 1e-9) / 400_000.0))
    nu, nv = int(span[0] / res) + 2, int(span[1] / res) + 2
    grid = np.zeros((nu, nv), dtype=bool)
    for p in uv:
        if _poly_area(p.tolist()) < 0:
            p = p[::-1]
        pl = p.min(axis=0)
        ph = p.max(axis=0)
        i0, j0 = int((pl[0] - lo[0]) / res), int((pl[1] - lo[1]) / res)
        i1, j1 = int((ph[0] - lo[0]) / res) + 1, int((ph[1] - lo[1]) / res) + 1
        gi, gj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1), indexing="ij")
        cu = lo[0] + (gi + 0.5) * res
        cv = lo[1] + (gj + 0.5) * res
        inside = np.ones(gi.shape, dtype=bool)
        m = len(p)
        for k in range(m):
            x0, y0 = p[k]
            x1, y1 = p[(k + 1) % m]
            inside &= ((x1 - x0) * (cv - y0) - (y1 - y0) * (cu - x0)) >= -1e-12
        gi2, gj2 = gi[inside], gj[inside]
        gi2 = np.clip(gi2, 0, nu - 1)
        gj2 = np.clip(gj2, 0, nv - 1)
        grid[gi2, gj2] = True
    return float(grid.sum()) * res * res


def _poly_area_3d(p, n):
    c = p.mean(axis=0)
    s = np.zeros(3)
    for i in range(len(p)):
        s += np.cross(p[i] - c, p[(i + 1) % len(p)] - c)
    return 0.5 * float(np.dot(s, n))


def exposure_fraction(tris, E1, E2, TN, points, n, tmax=3.0):
    """Heuristic: of the sample points on a patch, what fraction is exposed to air just above the patch?
    Casts a ray from 1 mm above each point along the facing normal n; if the first surface it meets is
    seen from behind, the point is inside a solid (buried) - e.g. under another box sitting on it."""
    V0 = tris[:, 0]
    exposed = 0
    for p in points:
        o = p + n * 1e-3
        pv = np.cross(n, E2)
        det = np.einsum("ij,ij->i", E1, pv)
        ok = np.abs(det) > 1e-12
        det_safe = np.where(ok, det, 1.0)
        tv = o - V0
        u = np.einsum("ij,ij->i", tv, pv) / det_safe
        qv = np.cross(tv, E1)
        v = (qv @ n) / det_safe
        t = np.einsum("ij,ij->i", E2, qv) / det_safe
        hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6) & (t <= tmax)
        if not hit.any():
            exposed += 1
            continue
        i = np.nonzero(hit)[0][np.argmin(t[hit])]
        if TN[i] @ n <= 0:  # front-facing surface ahead: the point is in the open
            exposed += 1
    return exposed / max(len(points), 1)


def cluster_hits(model, hits, cfg, comp):
    ia, ib = hits["ia"], hits["ib"]
    nh = len(ia)
    if nh == 0:
        return []
    tris = model["tris"]
    cr = np.cross(tris[ia, 1] - tris[ia, 0], tris[ia, 2] - tris[ia, 0])
    nA = _unit(cr)
    same = hits["cos"] > 0
    polys = hits["polys"]
    bmin = np.array([p.min(axis=0) for p in polys]) - 0.005
    bmax = np.array([p.max(axis=0) for p in polys]) + 0.005
    cent = hits["centroid"]
    ext = np.max(bmax - bmin, axis=1)
    cs = float(np.clip(np.median(ext) * 2.0, 0.05, 0.3))
    parent = np.arange(nh)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    cos2 = math.cos(math.radians(2.0))
    ncomp = int(comp.max()) + 1
    ca, cb = comp[ia], comp[ib]
    pair_key = np.minimum(ca, cb) * ncomp + np.maximum(ca, cb)
    for sa, sb in aabb_candidate_pairs(bmin, bmax, cs):
        k = (same[sa] == same[sb]) & (pair_key[sa] == pair_key[sb])  # a finding = one patch of one part pair
        dd = np.einsum("ij,ij->i", nA[sa], nA[sb])
        # same-facing: A's normal is the real facing direction, so require the same way;
        # opposite-facing: A may be either of the two, so compare as lines
        k &= np.where(same[sa], dd >= cos2, np.abs(dd) >= cos2)
        k &= (bmin[sa] <= bmax[sb]).all(axis=1) & (bmin[sb] <= bmax[sa]).all(axis=1)
        pd = np.abs(np.einsum("ij,ij->i", nA[sa], cent[sb] - cent[sa]))
        k &= pd <= 0.003
        for x, y in zip(sa[k].tolist(), sb[k].tolist()):
            rx, ry = find(x), find(y)
            if rx != ry:
                parent[max(rx, ry)] = min(rx, ry)
    root = np.array([find(i) for i in range(nh)])
    findings = []
    part_cache = {}
    for r in np.unique(root):
        idx = np.nonzero(root == r)[0]
        w = hits["area"][idx]
        poly_list = [polys[i] for i in idx]
        is_same = bool(same[idx[0]])
        n = nA[idx[np.argmax(w)]]
        pair_area = float(w.sum())
        union_area = min(_union_area(poly_list, n), pair_area) if len(idx) > 1 else pair_area
        centre = (cent[idx] * w[:, None]).sum(axis=0) / w.sum()
        allp = np.concatenate(poly_list)
        lo, hi = allp.min(axis=0), allp.max(axis=0)
        gap_mean = float((hits["gap_mean"][idx] * w).sum() / w.sum())
        gap_max = float(hits["gap_max"][idx].max())
        pc_a, pc_b = int(min(comp[ia[idx[0]]], comp[ib[idx[0]]])), int(max(comp[ia[idx[0]]], comp[ib[idx[0]]]))
        pa_info = describe_part(model, comp, pc_a, part_cache)
        pb_info = describe_part(model, comp, pc_b, part_cache)
        mats = model["materials"]
        tri_ids = np.unique(np.concatenate([ia[idx], ib[idx]]))
        mat_ids = np.unique(model["mat"][tri_ids])
        double_sided = any(mats[m]["double_sided"] for m in mat_ids)
        alpha = sorted({mats[m]["alpha_mode"] for m in mat_ids if mats[m]["alpha_mode"] != "OPAQUE"})
        if not is_same:  # canonical sign for display
            k = int(np.argmax(np.abs(n)))
            if n[k] < 0:
                n = -n
        sample_pts = _sample_points([polys[i] for i in idx[np.argsort(-w)]], 9) if is_same else None
        findings.append(dict(
            _samples=sample_pts, _n=n,
            kind="same-facing" if is_same else "opposite-facing",
            area_cm2=round(union_area * 1e4, 2),
            pair_area_cm2=round(pair_area * 1e4, 2),
            centre=[round(float(v), 3) for v in centre],
            bbox_min=[round(float(v), 4) for v in lo], bbox_max=[round(float(v), 4) for v in hi],
            size_cm=[round(float(v), 1) for v in (hi - lo) * 100.0],
            normal=[round(float(v), 4) for v in n], faces=_axis_label(n),
            gap_mm_mean=round(gap_mean * 1e3, 3), gap_mm_max=round(gap_max * 1e3, 3),
            triangle_pairs=int(len(idx)), triangles=int(len(tri_ids)),
            plane_offset_m=round(float(np.dot(n, centre)), 4),
            parts=[pa_info, pb_info], same_part=bool(pc_a == pc_b),
            hidden_in_ground=bool(is_same and n[1] < -0.9 and abs(lo[1]) <= cfg["ground_y_m"] and abs(hi[1]) <= cfg["ground_y_m"]),
            flicker_range_m=_flicker_range(gap_mean, cfg),
            double_sided_material=bool(double_sided), alpha_materials=alpha,
            example_pairs=[[int(ia[i]), int(ib[i])] for i in idx[np.argsort(-w)[:3]]],
        ))
    findings.sort(key=lambda f: -f["area_cm2"])
    return findings


def _flicker_range(gap_m, cfg):
    """Rough distance beyond which a 24-bit depth buffer can no longer tell surfaces `gap_m` apart:
    depth resolution at distance z is about z^2 / (near * 2^bits). None = flickers at any useful range."""
    if gap_m < 2e-5:
        return None
    return round(math.sqrt(gap_m * cfg["near_m"] * (2 ** cfg["depth_bits"])), 1)


def _p(info):
    return "%s, %d tri, %s cm" % (info["shape"], info["triangles"], "x".join("%g" % v for v in info["size_cm"]))


def face_phrase(f):
    n = np.array(f["normal"])
    k = int(np.argmax(np.abs(n)))
    if abs(n[k]) > 0.985:
        axis = "xyz"[k]
        pos = f["centre"][k]
        word = {1: "top" if n[k] > 0 else "underside"}.get(k, "side")
        sign = "+" if n[k] > 0 else "-"
        if f["kind"] == "opposite-facing":
            return "%s%s planes (%s) at %s=%.3f m" % ("+/-", axis.upper(), word if k == 1 else "side", axis, pos)
        return "%s%s (%s) face at %s=%.3f m" % (sign, axis.upper(), word, axis, pos)
    return "tilted face (%.2f, %.2f, %.2f)" % tuple(n)


def _bbox_iou(a, b):
    lo = np.maximum(a["bbox_min"], b["bbox_min"])
    hi = np.minimum(a["bbox_max"], b["bbox_max"])
    inter = float(np.prod(np.maximum(hi - lo, 0.0)))
    va = float(np.prod(np.array(a["bbox_max"]) - np.array(a["bbox_min"])))
    vb = float(np.prod(np.array(b["bbox_max"]) - np.array(b["bbox_min"])))
    return inter / max(va + vb - inter, 1e-12)


def reading(f):
    """Best guess, from position/normal/size, at which two parts collide and how to fix it."""
    a, b = f["parts"]
    if f["kind"] == "opposite-facing":
        base = "back-to-back faces: the contact plane of two abutting solids (each face is buried behind the other body, normally harmless)"
        if f["double_sided_material"]:
            base += "; matters only if either is a one-sided sheet seen from both sides, since the material is double-sided"
        return base
    if f["same_part"]:
        return "faces of ONE welded shell overlap on the same plane (duplicated/doubled faces or a fold): delete the duplicate"
    va, vb = float(np.prod(a["size_cm"])), float(np.prod(b["size_cm"]))
    small, large = (a, b) if va <= vb else (b, a)
    if _bbox_iou(a, b) >= 0.7:
        return "duplicate geometry: two near-identical parts occupy the same place - delete one"
    similar = all(abs(x - y) <= 0.15 * max(x, y, 1.0) for x, y in zip(sorted(a["size_cm"]), sorted(b["size_cm"])))
    if similar and small["shape"] != "flat quad":
        return ("two similar parts (%s / %s) overlap by %g cm and their faces are flush (lapped or spaced planks/beams): "
                "shift one by >= 3 mm or trim the overlap" % (a["shape"], b["shape"], min(s_ for s_ in f["size_cm"] if s_ > 0.05) if any(s_ > 0.05 for s_ in f["size_cm"]) else 0))
    if small["shape"] == "flat quad":
        return ("a poster/decal/sign quad (%s) lies flush on a %s (%s): stand it off 3-5 mm or recess the plate"
                % (_p(small), large["shape"], _p(large)))
    if small["shape"] in ("thin sheet", "slab/plate") and large["shape"] in ("thin sheet", "slab/plate", "solid"):
        return ("a thin board/plate (%s) lies flush with a face of a %s (%s): stand it off 3-5 mm, shrink it, or merge them"
                % (_p(small), large["shape"], _p(large)))
    if small["shape"] == "rod/strip":
        return ("a strip/rod (%s) is laid flush on a %s (%s): stand it off 3-5 mm or sink it into the surface"
                % (_p(small), large["shape"], _p(large)))
    return ("two solids share a face plane (%s, %s): offset or resize one by >= 3 mm, or cut away the doubled face"
            % (small["shape"], large["shape"]))


# ----------------------------------------------------------------------------------------------
# Per-asset driver and reporting
# ----------------------------------------------------------------------------------------------
def classify(f):
    if f["kind"] == "opposite-facing":
        return "opposite"
    if f["hidden_in_ground"]:
        f["hidden_reason"] = "underside at ground level (inside the terrain)"
        return "hidden"
    if f.get("exposed_fraction") == 0.0:
        f["hidden_reason"] = "buried inside another solid (ray test, heuristic)"
        return "hidden"
    return "same"


def analyze_model(model, cfg):
    t0 = time.time()
    hits = find_hits(model["tris"], cfg)
    comp = tri_components(model["tris"]) if len(hits["ia"]) else np.zeros(len(model["tris"]), dtype=np.int64)
    findings = cluster_hits(model, hits, cfg, comp)
    findings = [f for f in findings if f["area_cm2"] >= cfg["min_area_cm2"]]
    if findings:
        tr = model["tris"]
        E1, E2 = tr[:, 1] - tr[:, 0], tr[:, 2] - tr[:, 0]
        TN = _unit(np.cross(E1, E2))
        checked = 0
        for f in findings:  # biggest first; the ray test is the expensive part, so cap it
            if f["kind"] == "same-facing" and not f["hidden_in_ground"] and checked < cfg["exposure_checks"]:
                f["exposed_fraction"] = round(exposure_fraction(tr, E1, E2, TN, f["_samples"], f["_n"]), 2)
                checked += 1
            else:
                f["exposed_fraction"] = None
    for f in findings:
        f.pop("_samples", None)
        f.pop("_n", None)
    counter = {}
    for f in findings:
        f["class"] = classify(f)
        counter[f["class"]] = counter.get(f["class"], 0) + 1
        f["rank"] = counter[f["class"]]  # rank within its class, by overlapping area
        f["reading"] = reading(f)
        f["face_label"] = face_phrase(f)
    by = {c: [f for f in findings if f["class"] == c] for c in ("same", "hidden", "opposite")}
    summary = dict(
        same_facing_findings=len(by["same"]), same_facing_area_cm2=round(sum(f["area_cm2"] for f in by["same"]), 1),
        same_facing_hidden=len(by["hidden"]),
        same_facing_hidden_area_cm2=round(sum(f["area_cm2"] for f in by["hidden"]), 1),
        opposite_facing_findings=len(by["opposite"]),
        opposite_facing_area_cm2=round(sum(f["area_cm2"] for f in by["opposite"]), 1),
    )
    stats = dict(hits.pop("stats"))
    stats["overlap_polygons"] = int(len(hits["ia"]))
    stats["findings_before_area_filter"] = None
    del stats["findings_before_area_filter"]
    return dict(asset=model["name"], triangles=int(len(model["tris"])), seconds=round(time.time() - t0, 2),
                settings=dict(cfg), stats=stats, summary=summary, findings=findings,
                materials=model["materials"], warnings=model["warnings"])


def _range_txt(f):
    r = f["flicker_range_m"]
    return "flickers at any range" if r is None else "flickers beyond ~%g m" % r


def fmt_finding(f, indent="  "):
    tag = {"same": "SAME", "hidden": "HIDDEN", "opposite": "OPP"}[f["class"]]
    lines = []
    lines.append("%s#%-2d %-6s %8.1f cm2  at (%.3f, %.3f, %.3f) m  patch %s cm  %s  gap %.2f mm (%s)"
                 % (indent, f["rank"], tag, f["area_cm2"], *f["centre"], "x".join("%g" % v for v in f["size_cm"]),
                    f["face_label"], f["gap_mm_mean"], _range_txt(f)))
    a, b = f["parts"]
    if f["same_part"]:
        lines.append("%s       one part: %s" % (indent, _p(a)))
    else:
        lines.append("%s       A: %s @ (%.2f, %.2f, %.2f)%s" % (indent, _p(a), *a["centre"], _names(a)))
        lines.append("%s       B: %s @ (%.2f, %.2f, %.2f)%s" % (indent, _p(b), *b["centre"], _names(b)))
    extra = []
    if f.get("hidden_reason"):
        extra.append("hidden: " + f["hidden_reason"])
    elif f.get("exposed_fraction") is not None and f["exposed_fraction"] < 1.0:
        extra.append("only %d%% of sampled points are in the open" % round(100 * f["exposed_fraction"]))
    if f["alpha_materials"]:
        extra.append("alpha material %s: the cut-out may hide it" % "/".join(f["alpha_materials"]))
    lines.append("%s       -> %s%s" % (indent, f["reading"], ("   [" + "; ".join(extra) + "]") if extra else ""))
    return lines


def _names(info):
    names = [n for n in info["nodes"] if n]
    return "  node '%s'" % "/".join(names) if names and len(names) <= 2 else ""


def print_asset(res, top, verbose):
    s = res["summary"]
    print("== %s  (%d tris, %.1fs)  SAME-facing: %d finding(s), %.1f cm2   hidden same-facing: %d   opposite-facing: %d finding(s), %.1f cm2"
          % (res["asset"], res["triangles"], res["seconds"], s["same_facing_findings"], s["same_facing_area_cm2"],
             s["same_facing_hidden"], s["opposite_facing_findings"], s["opposite_facing_area_cm2"]))
    fs = res["findings"]
    groups = [("same", top, None),
              ("hidden", 1, "same-facing but hidden (underside in the terrain, or buried inside another solid):"),
              ("opposite", max(2, top // 3), "opposite-facing (back-to-back, lower severity):")]
    for cls, n_show, head in groups:
        items = [f for f in fs if f["class"] == cls]
        shown = items if verbose else items[:n_show]
        if shown and head:
            print("  " + head)
        for f in shown:
            print("\n".join(fmt_finding(f)))
        if len(items) > len(shown):
            print("    ... %d more %s findings (see the JSON or -v)" % (len(items) - len(shown), cls))
    for w in res["warnings"]:
        print("  warning:", w)


def print_summary(results):
    def key(r):
        s = r["summary"]
        return (-s["same_facing_area_cm2"], -s["same_facing_findings"], -s["opposite_facing_area_cm2"], r["asset"])
    rows = sorted(results, key=key)
    w = max([len(r["asset"]) for r in rows] + [5])
    print()
    print("SUMMARY (worst first = most same-facing overlapping area)")
    head = "%-*s  %7s  %11s  %12s  %9s  %10s  %8s" % (w, "asset", "tris", "same-facing", "same cm2", "hidden", "opposite", "opp cm2")
    print(head)
    print("-" * len(head))
    tf = ta = tg = to = 0
    for r in rows:
        s = r["summary"]
        tf += s["same_facing_findings"]
        ta += s["same_facing_area_cm2"]
        tg += s["same_facing_hidden"]
        to += s["opposite_facing_findings"]
        print("%-*s  %7d  %11d  %12.1f  %9d  %10d  %8.1f" % (
            w, r["asset"], r["triangles"], s["same_facing_findings"], s["same_facing_area_cm2"],
            s["same_facing_hidden"], s["opposite_facing_findings"], s["opposite_facing_area_cm2"]))
    print("-" * len(head))
    clean = sum(1 for r in rows if r["summary"]["same_facing_findings"] == 0)
    print("%-*s  %7s  %11d  %12.1f  %9d  %10d   (%d of %d assets have no same-facing z-fight)" % (
        w, "TOTAL", "", tf, ta, tg, to, clean, len(rows)))


def resolve_assets(names):
    if not names:
        return sorted(p for p in WORLD_DIR.glob("*.glb"))
    out = []
    for n in names:
        p = Path(n)
        if p.suffix.lower() == ".glb" and p.exists():
            out.append(p)
            continue
        cand = WORLD_DIR / (n if n.endswith(".glb") else n + ".glb")
        if cand.exists():
            out.append(cand)
        else:
            print("no such asset: %s (looked for %s)" % (n, cand))
    return out


def to_json_obj(res):
    """Findings reference their two parts by id; the part descriptions live once in the top-level `parts` list."""
    parts, fs = {}, []
    for f in res["findings"]:
        g = dict(f)
        g["parts"] = []
        for info in f["parts"]:
            parts[info["id"]] = info
            g["parts"].append(info["id"])
        fs.append(g)
    out = dict(res)
    out["findings"] = fs
    out["parts"] = [parts[k] for k in sorted(parts)]
    return out


def run_assets(paths, cfg, top, verbose, write_json, out_dir, quiet):
    results = []
    for p in paths:
        try:
            model = load_model(p.read_bytes(), p.stem)
            res = analyze_model(model, cfg)
        except Exception as e:  # keep going: this is a report
            print("== %s  FAILED: %s: %s" % (p.stem, type(e).__name__, e))
            continue
        res["file"] = str(p.relative_to(REPO)) if REPO in p.resolve().parents else str(p)
        results.append(res)
        if write_json:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / ("%s.zfight.json" % p.stem)).write_text(json.dumps(to_json_obj(res), separators=(",", ":")) + "\n")
        if not quiet:
            print_asset(res, top, verbose)
    return results


# ----------------------------------------------------------------------------------------------
# Self test: tiny synthetic GLBs through the real loader and analysis
# ----------------------------------------------------------------------------------------------
def make_glb(meshes, nodes=None, doubleSided=True):
    """meshes: list of (positions (n,3), indices (m,3)) ; nodes: list of node dicts (mesh index set per node)."""
    bin_parts, views, accessors, mesh_defs = [], [], [], []
    off = 0
    for pos, idx in meshes:
        pos = np.asarray(pos, dtype="<f4")
        idx = np.asarray(idx, dtype="<u2").reshape(-1)
        pb, ib = pos.tobytes(), idx.tobytes()
        ib += b"\0" * (-len(ib) % 4)
        views.append(dict(buffer=0, byteOffset=off, byteLength=len(pb)))
        accessors.append(dict(bufferView=len(views) - 1, componentType=5126, count=len(pos), type="VEC3",
                              min=pos.min(0).tolist(), max=pos.max(0).tolist()))
        pa = len(accessors) - 1
        off += len(pb)
        views.append(dict(buffer=0, byteOffset=off, byteLength=len(idx) * 2))
        accessors.append(dict(bufferView=len(views) - 1, componentType=5123, count=len(idx), type="SCALAR"))
        ia = len(accessors) - 1
        off += len(ib)
        bin_parts += [pb, ib]
        mesh_defs.append(dict(primitives=[dict(attributes=dict(POSITION=pa), indices=ia, material=0)]))
    if nodes is None:
        nodes = [dict(mesh=i) for i in range(len(meshes))]
    js = dict(asset=dict(version="2.0"), scene=0, scenes=[dict(nodes=list(range(len(nodes))))], nodes=nodes,
              meshes=mesh_defs, accessors=accessors, bufferViews=views, buffers=[dict(byteLength=off)],
              materials=[dict(name="m", doubleSided=doubleSided)])
    jb = json.dumps(js).encode()
    jb += b" " * (-len(jb) % 4)
    bb = b"".join(bin_parts)
    total = 12 + 8 + len(jb) + 8 + len(bb)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(jb), 0x4E4F534A) + jb
            + struct.pack("<II", len(bb), 0x004E4942) + bb)


def quad(x0, x1, z0, z1, y=0.0, up=True):
    """Axis-aligned quad in the XZ plane at height y (metres). up=True: +Y normal."""
    pos = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]]
    idx = [[0, 2, 1], [0, 3, 2]]  # (p2-p0)x(p1-p0) ... verify orientation below
    pos = np.array(pos, dtype=float)
    idx = np.array(idx)
    # make sure triangle 0 faces +Y when up, -Y otherwise
    n = np.cross(pos[idx[0, 1]] - pos[idx[0, 0]], pos[idx[0, 2]] - pos[idx[0, 0]])
    if (n[1] > 0) != up:
        idx = idx[:, [0, 2, 1]]
    return pos, idx


def _case(label, meshes, nodes=None, expect=None, cfg=None, doubleSided=True):
    cfg = dict(DEFAULTS, **(cfg or {}))
    model = load_model(make_glb(meshes, nodes, doubleSided), label)
    res = analyze_model(model, cfg)
    return res


def selftest():
    ok_all = True
    rows = []

    def check(name, cond, detail=""):
        nonlocal ok_all
        ok_all &= bool(cond)
        rows.append((name, bool(cond), detail))

    a10 = quad(0, 0.10, 0, 0.10)                 # 10 x 10 cm
    # 1. coplanar overlapping quads, 0 mm apart -> found, 50 cm2 (offset 5 cm)
    r = _case("coplanar0", [a10, quad(0.05, 0.15, 0, 0.10)])
    f = r["findings"]
    check("coplanar quads, 0 mm apart -> found (same-facing, ~50 cm2)",
          len(f) == 1 and f[0]["kind"] == "same-facing" and abs(f[0]["area_cm2"] - 50.0) < 1.0,
          "%d finding(s): %s" % (len(f), [(x["kind"], x["area_cm2"], x["gap_mm_mean"]) for x in f]))
    # 1b. 1.0 mm apart -> found; 2.0 mm -> not
    r = _case("gap1", [a10, quad(0.05, 0.15, 0, 0.10, y=0.001)])
    check("same, 1 mm apart -> found", len(r["findings"]) == 1 and r["findings"][0]["kind"] == "same-facing",
          "%d finding(s)" % len(r["findings"]))
    # 2. 3 mm apart -> not found
    r = _case("gap3", [a10, quad(0.05, 0.15, 0, 0.10, y=0.003)])
    check("same, 3 mm apart -> NOT found", len(r["findings"]) == 0, "%d finding(s)" % len(r["findings"]))
    # 3. sharing only an edge -> not found ; sharing only a vertex -> not found
    r = _case("edge", [a10, quad(0.10, 0.20, 0, 0.10)])
    check("quads sharing only an edge -> NOT found", len(r["findings"]) == 0, "%d finding(s)" % len(r["findings"]))
    r = _case("vertex", [a10, quad(0.10, 0.20, 0.10, 0.20)])
    check("quads sharing only a vertex -> NOT found", len(r["findings"]) == 0, "%d finding(s)" % len(r["findings"]))
    # 3b. a quad split in two triangles (adjacent coplanar triangles of ONE surface) -> not found
    r = _case("adjacent", [a10])
    check("adjacent triangles of one quad -> NOT found", len(r["findings"]) == 0, "%d finding(s)" % len(r["findings"]))
    # 4. back-to-back opposite-facing quads -> reported as opposite-facing
    r = _case("backtoback", [a10, quad(0.05, 0.15, 0, 0.10, up=False)])
    f = r["findings"]
    check("back-to-back opposite-facing quads -> opposite-facing (~50 cm2)",
          len(f) == 1 and f[0]["kind"] == "opposite-facing" and abs(f[0]["area_cm2"] - 50.0) < 1.0
          and r["summary"]["same_facing_findings"] == 0,
          "%d finding(s): %s" % (len(f), [(x["kind"], x["area_cm2"]) for x in f]))
    # 5. exact duplicate quad -> found, full area, one finding
    r = _case("dup", [a10, a10, a10])
    f = r["findings"]
    check("triple-stacked quad -> ONE finding, union area 100 cm2 (pair sum would be 300)",
          len(f) == 1 and abs(f[0]["area_cm2"] - 100.0) < 2.0 and f[0]["pair_area_cm2"] > 250,
          "%s" % [(x["area_cm2"], x["pair_area_cm2"]) for x in f])
    # 6. tilt: 0.5 deg tilt over 10 cm is still co-planar enough, 3 deg is not
    def tilted(deg):
        p, i = quad(0.05, 0.15, 0, 0.10)
        t = math.radians(deg)
        p[:, 1] = (p[:, 0] - 0.05) * math.tan(t)
        return p, i
    r = _case("tilt05", [a10, tilted(0.5)])
    check("0.5 deg tilt (<=1.5 mm over the patch) -> found", len(r["findings"]) == 1, "%d" % len(r["findings"]))
    r = _case("tilt3", [a10, tilted(3.0)])
    check("3 deg tilt -> NOT found", len(r["findings"]) == 0, "%d" % len(r["findings"]))
    # 7. node transforms: the second quad is built elsewhere then rotated/translated onto the first
    # mesh 1 lies in the XY plane (normal +Z); rotate -90 deg about X so it lands in XZ facing +Y, translate to x=0.05
    s = math.sqrt(0.5)
    q = [[0, 0, 0], [0.10, 0, 0], [0.10, 0.10, 0], [0, 0.10, 0]]
    m1 = (np.array(q, float), np.array([[0, 1, 2], [0, 2, 3]]))
    nodes = [dict(mesh=0), dict(mesh=1, rotation=[-s, 0, 0, s], translation=[0.05, 0, 0.10])]
    r = _case("xform", [a10, m1], nodes)
    f = r["findings"]
    check("node rotation+translation applied -> found at right place (~50 cm2 near x=0.075,z=0.05)",
          len(f) == 1 and abs(f[0]["area_cm2"] - 50.0) < 1.0 and abs(f[0]["centre"][0] - 0.075) < 0.005
          and abs(f[0]["centre"][2] - 0.05) < 0.005, "%s" % [(x["kind"], x["area_cm2"], x["centre"]) for x in f])
    # 8. mirrored node (negative scale) flips winding: the transformed copy must still face the same way
    nodes = [dict(mesh=0), dict(mesh=0, scale=[-1, 1, 1], translation=[0.10, 0, 0])]  # mirror of a10 over x=0.05 -> overlaps fully
    r = _case("mirror", [a10], nodes)
    f = r["findings"]
    check("mirrored node (negative scale) keeps outward facing -> same-facing, 100 cm2",
          len(f) == 1 and f[0]["kind"] == "same-facing" and abs(f[0]["area_cm2"] - 100.0) < 1.5,
          "%s" % [(x["kind"], x["area_cm2"]) for x in f])
    # 9. tiny overlaps under 1 cm2 are ignored
    r = _case("tiny", [a10, quad(0.095, 0.2, 0, 0.1)])
    check("5 cm2 overlap is reported, 0.5 cm2 overlap is ignored (min 1 cm2)",
          len(r["findings"]) == 1 and len(_case("tiny2", [a10, quad(0.0995, 0.2, 0, 0.1)])["findings"]) == 0, "")
    # 10. perpendicular faces (box corner) never match
    pos = np.array([[0, 0, 0], [0.1, 0, 0], [0.1, 0.1, 0], [0, 0.1, 0]], float)
    r = _case("perp", [a10, (pos, np.array([[0, 1, 2], [0, 2, 3]]))])
    check("perpendicular quads meeting on an edge -> NOT found", len(r["findings"]) == 0, "%d" % len(r["findings"]))

    width = max(len(n) for n, _, _ in rows)
    for n, ok, d in rows:
        print("  [%s] %-*s  %s" % ("PASS" if ok else "FAIL", width, n, d))
    print("selftest: %s (%d/%d)" % ("ALL PASS" if ok_all else "FAILED", sum(1 for _, o, _ in rows if o), len(rows)))
    return ok_all


# ----------------------------------------------------------------------------------------------
def main(argv):
    ap = argparse.ArgumentParser(description="Find z-fighting (coplanar overlapping faces) in the world-v2 GLBs.")
    ap.add_argument("assets", nargs="*", help="asset names (public/world/<name>.glb) or .glb paths; default: all")
    ap.add_argument("--selftest", action="store_true", help="run the synthetic calibration cases and exit")
    ap.add_argument("--tol-mm", type=float, default=DEFAULTS["tol_mm"], help="plane distance tolerance, default 1.5")
    ap.add_argument("--angle", type=float, default=DEFAULTS["angle_deg"], help="normal parallelism tolerance in degrees, default 1.0")
    ap.add_argument("--min-area", type=float, default=DEFAULTS["min_area_cm2"], help="ignore findings below this cm2, default 1.0")
    ap.add_argument("--top", type=int, default=6, help="findings printed per asset (default 6; JSON always has all)")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every finding")
    ap.add_argument("-q", "--quiet", action="store_true", help="only the summary table")
    ap.add_argument("--no-json", action="store_true", help="do not write assets/world-v2/review/<asset>.zfight.json")
    ap.add_argument("--out", type=Path, default=REVIEW_DIR, help="JSON output directory")
    args = ap.parse_args(argv)
    np.seterr(all="ignore")  # some macOS numpy builds raise bogus FP flags from BLAS matmul
    if args.selftest:
        selftest()
        return 0
    cfg = dict(DEFAULTS, tol_mm=args.tol_mm, angle_deg=args.angle, min_area_cm2=args.min_area)
    paths = resolve_assets(args.assets)
    t0 = time.time()
    results = run_assets(paths, cfg, args.top, args.verbose, not args.no_json, args.out, args.quiet)
    if len(results) > 1 or args.quiet:
        print_summary(results)
    print("\n%d asset(s) in %.1fs%s" % (len(results), time.time() - t0, "" if args.no_json else "; JSON in %s" % args.out))
    return 0


if __name__ == "__main__":
    argv = sys.argv[1:]
    try:
        import bpy  # noqa: F401  (running inside Blender: arguments come after "--")
        argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    except ImportError:
        pass
    try:
        main(argv)
    except SystemExit:
        pass
    except Exception:  # a report must not fail the pipeline
        import traceback
        traceback.print_exc()
    sys.exit(0)
