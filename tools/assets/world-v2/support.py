"""Support audit: nothing in a prop may float.

Every part of a model (the pieces that share vertices: a log with its caps, a board with its ends) must be grounded (it
reaches the ground plane), resting (one of the lowest points of it touches another part within TOUCH), or embedded
(its surface passes into another part's: a nail in a board, logs crossing at a corner, a wire round a rafter). Anything
else floats, and is reported with where it is, what it is, and how far it would have to fall to land (the gap). Parts that
touch something only higher up (hung on a wire, leant on a wall) are listed as leaning, to be looked at.

    support.audit(model) -> dict(parts, grounded, resting, embedded, floating=[...])

tiled.build() runs it on every build, prints one line per floating part and writes work/gfx/audit/<name>-support.json.
Needs Blender's mathutils (BVH trees); coordinates are the model's own (metres, y up, ground at y = 0).
"""
import json
import os

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

TOUCH = .004            # closer than this is touching
GROUND = .01            # a part reaching this low stands on the ground (or is set into it)


def _components(model):
    """Vertices, triangles and material of every connected part, connecting islands that share a vertex position."""
    verts, faces, island_of, mats, islands = [], [], [], [], []
    base = 0
    for name in sorted(model.parts):
        b = model.parts[name]
        v = np.concatenate(b["v"])
        owner = np.empty(len(v), int)
        for start, count, _k, _d in b["islands"]:
            owner[start:start + count] = len(islands)
            islands.append(name)
        verts.append(v)
        island_of.append(owner)
        faces += [tuple(i + base for i in f) for f in b["f"]]
        base += len(v)
    V = np.concatenate(verts)
    owner = np.concatenate(island_of)
    parent = list(range(len(islands)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    seen = {}
    for i, key in enumerate(map(tuple, np.round(V / 2e-4).astype(np.int64))):
        j = seen.setdefault(key, owner[i])
        a, b = find(j), find(owner[i])
        if a != b:
            parent[a] = b
    comp = np.array([find(owner[i]) for i in range(len(V))])
    parts = {}
    for f in faces:
        parts.setdefault(comp[f[0]], []).append(f)
    out = []
    for c, fs in parts.items():
        idx = sorted({i for f in fs for i in f})
        remap = {g: k for k, g in enumerate(idx)}
        pv = V[idx]
        tris = []
        for f in fs:
            for k in range(1, len(f) - 1):
                tris.append((remap[f[0]], remap[f[k]], remap[f[k + 1]]))
        names = sorted({islands[owner[i]] for i in idx})
        out.append(dict(v=pv, tris=tris, mats=names))
    return out


def _samples(v, tris, keep, spacing=.03):
    """Points over the triangles that have a vertex in `keep` (a mask over v), about `spacing` apart, vertices included:
    two flat faces meeting between vertices still touch."""
    out = [v[keep]]
    for a, b, c in tris:
        if not (keep[a] or keep[b] or keep[c]):
            continue
        A, B, C = v[a], v[b], v[c]
        n = int(np.ceil(max(np.linalg.norm(B - A), np.linalg.norm(C - B), np.linalg.norm(A - C)) / spacing))
        if n < 2:
            continue
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1))
        sel = (i + j) <= n
        u, w = i[sel] / n, j[sel] / n
        out.append(A + (B - A) * u[:, None] + (C - A) * w[:, None])
    return np.concatenate(out)


def audit(model, write=True):
    parts = _components(model)
    for p in parts:
        p["bvh"] = BVHTree.FromPolygons([Vector(x) for x in p["v"]], p["tris"], epsilon=0.0)
        p["lo"], p["hi"] = p["v"].min(axis=0), p["v"].max(axis=0)
    lo = np.array([p["lo"] for p in parts])
    hi = np.array([p["hi"] for p in parts])
    counts = dict(grounded=0, resting=0, embedded=0, leaning=0)
    floating, leaning = [], []
    for i, p in enumerate(parts):
        if p["lo"][1] <= GROUND:
            counts["grounded"] += 1
            continue
        near = np.where(np.all(lo <= p["hi"] + TOUCH, axis=1) & np.all(hi >= p["lo"] - TOUCH, axis=1))[0]
        near = [j for j in near if j != i]
        height = p["hi"][1] - p["lo"][1]
        band = p["v"][:, 1] <= p["lo"][1] + max(.012, .2 * height)
        bottom = p["v"][band]
        state = None
        for j in near:
            # Resting: something under it touches its lowest fifth (sampled over its faces, not just its corners).
            if any(parts[j]["bvh"].find_nearest(Vector(v), TOUCH)[0] is not None for v in _samples(p["v"], p["tris"], band)):
                state = "resting"
                break
        if state is None:
            for j in near:
                if p["bvh"].overlap(parts[j]["bvh"]):
                    state = "embedded"
                    break
        if state is None:
            # Touching only higher up (hung, leaning): allowed, but listed, since a gap under it may still show.
            everywhere = _samples(p["v"], p["tris"], np.ones(len(p["v"]), bool), .05)
            if any(any(parts[j]["bvh"].find_nearest(Vector(v), TOUCH)[0] is not None for v in everywhere) for j in near):
                state = "leaning"
                leaning.append(dict(mats=p["mats"], centre=[round(float(x), 3) for x in (p["lo"] + p["hi"]) / 2]))
        if state:
            counts[state] = counts.get(state, 0) + 1
            continue
        # How far it would fall: rays straight down from its lowest points onto anything below (or the ground).
        gap = float(p["lo"][1])
        below = [j for j in range(len(parts)) if j != i and lo[j][0] <= p["hi"][0] and hi[j][0] >= p["lo"][0] and lo[j][2] <= p["hi"][2] and hi[j][2] >= p["lo"][2] and lo[j][1] < p["lo"][1] + .01]
        for v in bottom[np.argsort(bottom[:, 1])[:12]]:
            for j in below:
                hit = parts[j]["bvh"].ray_cast(Vector(v) + Vector((0, -1e-4, 0)), Vector((0, -1, 0)), gap)
                if hit[0] is not None:
                    gap = min(gap, hit[3] + 1e-4)
        floating.append(dict(mats=p["mats"], centre=[round(float(x), 3) for x in (p["lo"] + p["hi"]) / 2],
                             size=[round(float(x), 3) for x in p["hi"] - p["lo"]], gap=round(gap, 4)))
    floating.sort(key=lambda f: -f["gap"])
    result = dict(model=model.name, parts=len(parts), **counts, floating=floating, leaners=leaning)
    if write:
        from kit import ROOT
        folder = os.path.join(ROOT, "work/gfx/audit")
        os.makedirs(folder, exist_ok=True)
        json.dump(result, open(os.path.join(folder, f"{model.name}-support.json"), "w"), indent=1)
    return result


def report(result, log):
    log(result["model"], "SUPPORT", result["parts"], "parts:", result["grounded"], "grounded,", result["resting"], "resting,",
        result["embedded"], "embedded,", result["leaning"], "leaning,", len(result["floating"]), "FLOATING")
    for f in result["leaners"][:20]:
        log(result["model"], "  leans", "+".join(f["mats"]), "at", f["centre"])
    for f in result["floating"][:40]:
        log(result["model"], "  floats", "+".join(f["mats"]), "at", f["centre"], "size", f["size"], "gap", f["gap"])
