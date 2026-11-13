"""The shared material library for buildings: tiling CC0 scans, one copy on the GPU for every prop that uses them.

A prop built in tiled mode (kit.Model(..., tiled=True)) carries no copy of these maps. Its GLB holds geometry with metric
tiling UVs (TEXCOORD_0, already divided by the library entry's `metres`) and a small unique map of its own on TEXCOORD_1
(ambient occlusion, moss and grime masks); each material names its library entry in its extras (`lib`), and the game
(game/render/props/prop-materials.ts) hangs the shared maps on it. That is how a log wall gets 1000 to 2000 texels per
metre where the old one-atlas bake gave the cabin 123 (work/gfx/research/texture-audit.md).

    python3 tools/assets/world-v2/library.py fetch     # downloads the sources (Poly Haven, CC0) into work/materials/src
    python3 tools/assets/world-v2/library.py pack      # writes public/world/materials/<id>/{color,normal,orm}.jpg

ORM is glTF's packing: R ambient occlusion, G roughness, B metalness (Poly Haven's `arm` maps are exactly this).
"""
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
SRC = os.path.join(ROOT, "work/materials/src")
OUT = os.path.join(ROOT, "public/world/materials")

# id -> source scan, its real width in metres (Poly Haven's `dimensions`), the width one texture repeat covers on a model
# (`metres`; larger than the scan's own width scales its features up), and the shipped size of each map.
LIBRARY = {
    # Weathered, checked timber: logs, beams, boards. The scan is only 0.5 m wide; at 1 m a repeat a log's checks are the
    # size of a real cabin log's and 2048 texels still cover each metre.
    "timber": dict(scan="rough_wood", width=.5, metres=1.0, color=2048, normal=2048, orm=1024),
    # A floor of worn deck boards.
    "floor": dict(scan="plank_flooring_03", width=2.25, metres=2.25, color=2048, normal=2048, orm=1024),
    # Galvanised sheet gone to rust in blooms; the corrugation is geometry.
    "sheet": dict(scan="rusty_metal_sheet", width=2.0, metres=2.0, color=2048, normal=2048, orm=1024),
    # Fieldstone laid in pale lime mortar: the chimney and the footing. Grey, like the island's own stones.
    "fieldstone": dict(scan="castle_wall_slates", width=2.5, metres=2.2, color=2048, normal=2048, orm=1024, height=True, saturation=.6),
    # Lime mortar chinking between the logs.
    "mortar": dict(scan="grey_plaster_02", width=1.0, metres=1.0, color=1024, normal=1024, orm=1024),
    # Wrought and cast iron: stove, hinges, straps.
    "iron": dict(scan="rusty_metal_04", width=2.0, metres=1.0, color=1024, normal=1024, orm=1024),
    # Bark on the firewood.
    "bark": dict(scan="pine_bark", width=2.0, metres=1.2, color=1024, normal=1024, orm=1024),
    # Grey lichened granite: single stones (hearth, lintel, chimney cap), not walls.
    "rock": dict(scan="lichen_rock", width=2.0, metres=1.2, color=2048, normal=2048, orm=1024, saturation=.5),
    # Woven cotton: a mattress, sacking, a tarp. Its colour comes from the material's tint.
    # Weathered outdoor concrete, board-marked and stained: the bridge's piers, abutments and wing walls.
    "concrete": dict(scan="concrete", width=4.0, metres=3.2, color=2048, normal=2048, orm=1024, saturation=.7),
    # A second, dirtier pour for the deck's slab and edge beams, so no two big faces of a bridge show one repeat.
    "canvas": dict(scan="book_pattern", width=.3, metres=.45, color=1024, normal=1024, orm=1024, diffuse="col1", saturation=.08),
}


def _get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "silence-game-asset-download"})
    with urllib.request.urlopen(request) as response:
        return response.read()


def fetch():
    for entry in LIBRARY.values():
        scan = entry["scan"]
        files = json.loads(_get(f"https://api.polyhaven.com/files/{scan}"))
        info = json.loads(_get(f"https://api.polyhaven.com/info/{scan}"))
        folder = os.path.join(SRC, scan)
        os.makedirs(folder, exist_ok=True)
        kinds = [(entry.get("diffuse", "Diffuse"), "color"), ("nor_gl", "normal"), ("arm", "orm")] + ([("Displacement", "height")] if entry.get("height") else [])
        record = dict(scan=scan, authors=sorted(info.get("authors", {})), dimensions=info.get("dimensions"), maps={})
        for key, name in kinds:
            item = files[key]["2k"]["jpg"]
            path = os.path.join(folder, f"{name}.jpg")
            if not (os.path.exists(path) and hashlib.md5(open(path, "rb").read()).hexdigest() == item["md5"]):
                data = _get(item["url"])
                if hashlib.md5(data).hexdigest() != item["md5"]:
                    raise SystemExit(f"checksum mismatch: {scan} {key}")
                open(path, "wb").write(data)
            record["maps"][name] = dict(url=item["url"], md5=item["md5"])
        json.dump(record, open(os.path.join(folder, "source.json"), "w"), indent=1)
        print(scan, "ok")


def pack():
    from PIL import Image
    credits = []
    for lib, entry in LIBRARY.items():
        folder = os.path.join(SRC, entry["scan"])
        source = json.load(open(os.path.join(folder, "source.json")))
        out = os.path.join(OUT, lib)
        os.makedirs(out, exist_ok=True)
        for name in ("color", "normal", "orm"):
            image = Image.open(os.path.join(folder, f"{name}.jpg")).convert("RGB")
            size = entry[name]
            if image.size[0] != size:
                image = image.resize((size, size), Image.LANCZOS)
            if name == "color" and "saturation" in entry:
                image = _saturate(image, entry["saturation"])
            # 4:4:4: a normal map keeps x and y in chroma, which 4:2:0 would halve (texture audit, section 4.7).
            image.save(os.path.join(out, f"{name}.jpg"), quality=92 if name != "normal" else 95, subsampling=0)
        credits.append(dict(library=lib, asset=entry["scan"], authors=source["authors"], source=f"https://polyhaven.com/a/{entry['scan']}",
                            license="CC0-1.0", license_url="https://polyhaven.com/license", width_m=entry["width"], maps=source["maps"]))
        print(lib, entry["scan"], "packed")
    endgrain()
    # Mean linear albedo of each entry: the lamp bake (tiled.py) bounces light off surfaces of this colour times their tint.
    import numpy as np
    means = {}
    for lib in list(LIBRARY) + ["endgrain"]:
        a = np.asarray(Image.open(os.path.join(OUT, lib, "color.jpg")).convert("RGB").resize((256, 256), Image.BOX), np.float32) / 255
        means[lib] = dict(mean=[round(float(v), 4) for v in (a ** 2.2).reshape(-1, 3).mean(axis=0)])
    json.dump(means, open(os.path.join(OUT, "library.json"), "w"), indent=1)
    json.dump(dict(note="Shared tiling materials for the buildings (tools/assets/world-v2/library.py). endgrain/ is generated "
                        "by the same script from nothing but noise, so it carries no credit.", assets=credits),
              open(os.path.join(OUT, "attribution.json"), "w"), indent=1)


def _saturate(image, amount):
    """Scale chroma in linear light about each pixel's own luminance, keeping its brightness."""
    import numpy as np
    from PIL import Image
    a = (np.asarray(image).astype(np.float32) / 255) ** 2.2
    y = a[..., 0] * .2126 + a[..., 1] * .7152 + a[..., 2] * .0722
    a = y[..., None] + (a - y[..., None]) * amount
    return Image.fromarray((np.clip(a, 0, 1) ** (1 / 2.2) * 255 + .5).astype(np.uint8))


# Sawn log ends, weathered grey like the faces: four discs in a 2 x 2 sheet, each filling its quarter, so a cap's UVs (a
# unit disc) take one whole (tiled.py picks the quarter and turns it).
ENDGRAIN = dict(size=1024)


def endgrain():
    import numpy as np
    from PIL import Image
    sheets = [_endgrain_disc(seed) for seed in (11, 23, 37, 51)]
    out = os.path.join(OUT, "endgrain")
    os.makedirs(out, exist_ok=True)
    for i, (name, q) in enumerate((("color", 92), ("normal", 95), ("orm", 92))):
        # Image rows run top-down: quarter q sits at column q % 2, row 1 - q // 2 (UV v runs bottom-up).
        top = np.concatenate((sheets[2][i], sheets[3][i]), 1)
        bottom = np.concatenate((sheets[0][i], sheets[1][i]), 1)
        Image.fromarray(np.concatenate((top, bottom), 0)).save(os.path.join(out, f"{name}.jpg"), quality=q, subsampling=0)
    print("endgrain generated")


def _endgrain_disc(seed):
    import numpy as np
    from PIL import Image
    n = ENDGRAIN["size"]
    rng = np.random.default_rng(seed)
    yy, xx = (np.mgrid[0:n, 0:n] + .5) / n * 2 - 1

    def noise(scale, octaves=4):
        """Value noise by summing bilinear-upsampled random grids."""
        out = np.zeros((n, n), np.float32)
        amp, total = 1.0, 0.0
        for o in range(octaves):
            k = int(scale * 2 ** o) + 2
            grid = Image.fromarray((rng.random((k, k)) * 255).astype(np.uint8)).resize((n, n), Image.BICUBIC)
            out += amp * (np.asarray(grid, np.float32) / 255 - .5)
            total += amp
            amp *= .5
        return out / total

    # The pith is off centre, as it nearly always is; years differ in width (good and bad summers) and rings wobble.
    px, py = rng.uniform(-.1, .1), rng.uniform(-.1, .1)
    warp = noise(3) * .05
    r = np.hypot(xx - px, yy - py) * (1 + warp)
    theta = np.arctan2(yy - py, xx - px)
    years = int(rng.integers(30, 60))
    widths = np.exp(rng.normal(0, .35, years)) * np.linspace(1.6, .7, years)
    bounds = np.concatenate(([0], np.cumsum(widths))) / widths.sum() * .9
    k = np.clip(np.searchsorted(bounds, r) - 1, 0, len(widths) - 1)
    f = np.clip((r - bounds[k]) / (bounds[k + 1] - bounds[k]), 0, 1.5)
    late = np.clip((f - .7) / .3, 0, 1) ** 1.3 * (f <= 1)
    # Drying checks: wedges from the rim inwards, widest at the rim, wandering a little; one runs through the pith.
    cracks = np.zeros((n, n), np.float32)
    checks = [(rng.uniform(-np.pi, np.pi), rng.uniform(.18, .45), rng.uniform(.006, .016)) for _ in range(rng.integers(3, 7))] + [(rng.uniform(-np.pi, np.pi), rng.uniform(.5, .9), .02)]
    for a0, length, wide in checks:
        phase = rng.uniform(0, 6)
        along = np.angle(np.exp(1j * (theta - a0 - .025 * np.sin(r * 7 + phase)))) * r
        open_ = np.clip((r - (.9 - length)) / length, 0, 1) ** 1.4 * wide
        cracks = np.maximum(cracks, np.clip(1 - np.abs(along) / np.maximum(open_, 1e-4), 0, 1) ** .6 * (open_ > 1e-4))
    rim = np.clip((r - .9) / .04, 0, 1)                   # bark at the edge
    grain = noise(40, 2) * .5 + noise(160, 1) * .5
    # Chainsaw marks across the face: faint arcs, lighter where the chain polished the fibres.
    saw = np.sin((xx * .95 + yy * .31 + .03 * np.sin(yy * 9)) * 210) * .5 + .5
    saw = saw ** 3 * (.5 + .5 * noise(4, 2) + .5)
    # Weathered silver-brown: pale earlywood, dark latewood and checks, dirtier and greyer towards the rim.
    base = np.array((.47, .43, .38), np.float32) ** 2.2
    tone = (1 + .22 * noise(2.5, 3) + .2 * noise(9, 3) + .14 * grain + .05 * saw)[..., None] * base
    tone *= (1 - .3 * late)[..., None]
    grey = np.clip((r - .4) / .5, 0, 1)[..., None] * .5
    tone = tone * (1 - grey) + tone.mean(-1, keepdims=True) * grey * .92
    dirt = np.clip(cracks * 3, 0, 1)
    tone *= (1 - .55 * dirt)[..., None]
    tone *= (1 - .85 * cracks)[..., None]
    bark = (np.array((.21, .18, .145), np.float32) ** 2.2) * (1 + .5 * noise(30, 2))[..., None]
    tone = tone * (1 - rim[..., None]) + bark * rim[..., None]
    pith = np.exp(-(np.hypot(xx - px, yy - py) / .025) ** 2)
    tone *= (1 - .45 * pith)[..., None]
    colour = (np.clip(tone, 0, 1) ** (1 / 2.2) * 255 + .5).astype(np.uint8)
    # Height: latewood stands proud after weathering, checks are deep, the bark is rough.
    h = .12 * late + .08 * grain + .03 * saw - 1.4 * cracks + rim * (.25 + .3 * noise(25, 2))
    gy, gx = np.gradient(h * 6)
    nn = np.stack((-gx, gy, np.ones_like(h)), -1)
    nn /= np.linalg.norm(nn, axis=-1, keepdims=True)
    normal = ((nn * .5 + .5) * 255 + .5).astype(np.uint8)
    orm = np.stack((np.clip(1 - .7 * cracks, 0, 1), np.clip(.82 + .1 * grain + .1 * rim, 0, 1), np.zeros_like(h)), -1)
    orm = (orm * 255 + .5).astype(np.uint8)
    return colour, normal, orm


def height_path(lib):
    """The scan's height map, for displacing geometry at build time (not shipped)."""
    return os.path.join(SRC, LIBRARY[lib]["scan"], "height.jpg")


if __name__ == "__main__":
    {"fetch": fetch, "pack": pack}[sys.argv[1]]()
