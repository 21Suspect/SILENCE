"""The Listener's scanned skin layers: one scan per kind of tissue, made grey, for the game's layered skin.

The bake (texturing.py) gives the creature its colour, its folds and veins, and a mask per atlas saying which tissue each texel
is; the game lays these scans over that at about four thousand texels a metre (game/render/creature/creature-skin.ts):
    0 skin    the face, torso, arms and hands
    1 tissue  raw and wet: gums, the inside of the mouth, torn muscle
    2 hide    the legs' dead hide, the nails
    3 bone    teeth, the spines, the joints' knobs
Only each scan's structure is kept, not its colour: its luminance as a ratio to its local mean (so the creature's palette
decides the colour and the scan adds pores, stains and creases in grey), its height (high-passed: a tilt across the whole
scan would show as the same swell on every patch), its roughness, its normal and its occlusion.

    python3 tools/assets/creature-v2/layers.py fetch                  # CC0 scans (Poly Haven) into work/creature/scans
    python3 tools/assets/creature-v2/layers.py pack [--skin <dir|zip>] [--src <dir>]

--skin takes a Megascans surface set (folder or zip of *_BaseColor/_Normal/_Roughness/_Displacement/_AO.jpg) for the skin layer;
without it the skin is Poly Haven's brown_leather. Writes public/creature/layers/<layer>-a.jpg (R luminance ratio / 2, G height,
B roughness) and <layer>-b.jpg (R, G OpenGL normal x, y; B ambient occlusion), 1024 px, 4:4:4, and attribution.json.
"""
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
SRC = os.path.join(ROOT, "work/creature/scans")
OUT = os.path.join(ROOT, "public/creature/layers")
SIZE = 1024
ORDER = ("skin", "tissue", "hide", "bone")
# Layer -> Poly Haven scan (CC0). The skin's default stands in when no Megascans set is given.
POLYHAVEN = {
    # Fine pores in a slack, softly creased surface: the closest CC0 scan to skin.
    "skin": "brown_leather",
    # A tight pebbled grain: glossy and dark, it reads as the papillae and folds of wet gum and torn muscle.
    "tissue": "leather_red_02",
    # Dried mud split into plates: at the legs' scale, hide dried hard and cracked.
    "hide": "mud_cracked_dry_03",
    # Old plaster crazed into fine cracks: the crazing of old enamel and weathered bone.
    "bone": "worn_cracked_plaster",
}
KEYS = (("color", ("Diffuse", "diff", "col")), ("normal", ("nor_gl",)), ("rough", ("Rough",)), ("height", ("Displacement",)), ("ao", ("AO",)))


def _get(url):
    request = urllib.request.Request(url, headers={"User-Agent": "silence-game-asset-download"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def fetch():
    for scan in sorted(set(POLYHAVEN.values())):
        files = json.loads(_get(f"https://api.polyhaven.com/files/{scan}"))
        info = json.loads(_get(f"https://api.polyhaven.com/info/{scan}"))
        folder = os.path.join(SRC, scan)
        os.makedirs(folder, exist_ok=True)
        record = dict(scan=scan, provider="Poly Haven", source=f"https://polyhaven.com/a/{scan}", license="CC0-1.0",
                      authors=sorted(info.get("authors", {})), dimensions=info.get("dimensions"), maps={})
        for name, keys in KEYS:
            key = next(k for k in files if any(k == c or k.lower().startswith(c.lower()) for c in keys))
            item = files[key]["2k"]["jpg"]
            path = os.path.join(folder, f"{name}.jpg")
            if not (os.path.exists(path) and hashlib.md5(open(path, "rb").read()).hexdigest() == item["md5"]):
                data = _get(item["url"])
                if hashlib.md5(data).hexdigest() != item["md5"]:
                    raise SystemExit(f"checksum mismatch: {scan} {key}")
                open(path, "wb").write(data)
            record["maps"][name] = dict(key=key, url=item["url"], md5=item["md5"])
        json.dump(record, open(os.path.join(folder, "source.json"), "w"), indent=1)
        print(scan, "ok")


def read_polyhaven(folder):
    maps = {name: Image.open(os.path.join(folder, f"{name}.jpg")).copy() for name, _ in KEYS}
    record = json.load(open(os.path.join(folder, "source.json"), encoding="utf8"))
    return maps, record


def read_megascans(source):
    """A Megascans surface set from a folder or zip. Its normal map is checked against its displacement, so either convention works."""
    wanted = {"color": "_BaseColor.jpg", "normal": "_Normal.jpg", "rough": "_Roughness.jpg", "height": "_Displacement.jpg", "ao": "_AO.jpg"}
    maps, meta = {}, {}
    if zipfile.is_zipfile(source):
        z = zipfile.ZipFile(source)
        names, read = z.namelist(), z.read
    else:
        names, read = os.listdir(source), (lambda n: open(os.path.join(source, n), "rb").read())
    for n in names:
        for key, suffix in wanted.items():
            if n.endswith(suffix):
                maps[key] = Image.open(io.BytesIO(read(n))).copy()
        if n.endswith(".json"):
            meta = json.loads(read(n))
    missing = [k for k in wanted if k not in maps]
    if missing:
        raise SystemExit(f"{source}: no {', '.join(missing)} map")
    size = meta.get("physicalSize", "?")
    record = dict(scan=meta.get("name", "?"), id=meta.get("id", "?"), provider="Quixel Megascans",
                  license="Megascans / Fab Standard License (not CC0: may not be redistributed as a standalone texture)",
                  physical_size_m=size, maps={k: v for k, v in wanted.items()})
    return maps, record


def wrap_resize(img, size, mode):
    """Resize a tileable image so it still tiles: pad it with its own opposite edges first, then crop the padding off."""
    img = img.convert(mode)
    w, h = img.size
    pad = w // 16
    a = np.asarray(img)
    a = np.pad(a, ((pad, pad), (pad, pad)) + (((0, 0),) if a.ndim == 3 else ()), mode="wrap")
    big = Image.fromarray(a).resize((size + 2 * pad * size // w, size + 2 * pad * size // h), Image.LANCZOS)
    p = pad * size // w
    return np.asarray(big, np.float32)[p:p + size, p:p + size] / 255.0


def blur(a, sigma):
    """Gaussian blur of a tileable image that wraps round its edges (in the frequency domain, where wrapping is free)."""
    fy, fx = np.fft.fftfreq(a.shape[0])[:, None], np.fft.fftfreq(a.shape[1])[None, :]
    kernel = np.exp(-2 * (np.pi * sigma) ** 2 * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * kernel)).astype(np.float32)


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def normal_flip(normal, height):
    """+1 if the normal map is OpenGL's (y up), -1 if DirectX's: the sign of its y against the height's slope down the image."""
    ny = normal[..., 1] * 2 - 1
    dh_row = np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)
    return 1.0 if float((ny * dh_row).mean()) > 0 else -1.0


def relief_from_tone(tone, normal, depth):
    """Grooves where a scan's colour has dark lines its relief lacks (old plaster's crazing is in its colour, not its normal):
    a height from the tone's fine structure, turned into a normal (OpenGL) and added to the scan's own."""
    groove = np.log(np.maximum(tone, 1e-3)) - blur(np.log(np.maximum(tone, 1e-3)), 6)
    groove = blur(groove, 0.8) * depth
    dx = (np.roll(groove, -1, axis=1) - np.roll(groove, 1, axis=1)) * 0.5
    dy = (np.roll(groove, -1, axis=0) - np.roll(groove, 1, axis=0)) * 0.5
    n = np.stack([normal[..., 0] * 2 - 1 - dx, normal[..., 1] * 2 - 1 + dy, np.ones_like(dx)], axis=-1)
    n[..., 2] = np.sqrt(np.clip(1 - n[..., 0] ** 2 - n[..., 1] ** 2, 0.05, 1))
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def pack_layer(maps, tone_relief=0.0):
    rgb = srgb_to_linear(wrap_resize(maps["color"], SIZE, "RGB"))
    lum = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    # The luminance as a ratio to its surroundings (an eighth of the scan): its pores, stains and creases, not its broad blotches,
    # which would come round again with every patch.
    tone = lum / np.maximum(blur(lum, SIZE / 8), 1e-4)
    height = wrap_resize(maps["height"], SIZE, "L")
    folds = height - blur(height, SIZE / 12)
    lo, hi = np.percentile(folds, (0.5, 99.5))
    height01 = np.clip((folds - lo) / max(hi - lo, 1e-6), 0, 1)
    rough = wrap_resize(maps["rough"], SIZE, "L")
    normal = wrap_resize(maps["normal"], SIZE, "RGB")
    flip = normal_flip(normal, height)
    if flip < 0:
        normal[..., 1] = 1 - normal[..., 1]
    if tone_relief:
        normal = relief_from_tone(tone, normal, tone_relief)
    ao = wrap_resize(maps["ao"], SIZE, "L")
    a = np.stack([np.clip(tone * 0.5, 0, 1), height01, rough], axis=-1)
    b = np.stack([normal[..., 0], normal[..., 1], ao], axis=-1)
    stats = dict(tone_spread=round(float(tone.std()), 3), rough_mean=round(float(rough.mean()), 3), ao_mean=round(float(ao.mean()), 3),
                 normal="OpenGL" if flip > 0 else "DirectX (flipped)")
    return a, b, stats


def save(path, rgb):
    Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(path, "JPEG", quality=92, subsampling=0)


def pack(src, skin=None):
    os.makedirs(OUT, exist_ok=True)
    attribution = dict(packing="<layer>-a.jpg: R luminance ratio / 2, G height (high-passed, 0..1), B roughness. <layer>-b.jpg: R, G "
                       "OpenGL normal x, y; B ambient occlusion. 1024 px, JPEG 4:4:4, tileable. Packed by tools/assets/creature-v2/layers.py.",
                       layers=[])
    for layer in ORDER:
        if layer == "skin" and skin:
            maps, record = read_megascans(skin)
        else:
            maps, record = read_polyhaven(os.path.join(src, POLYHAVEN[layer]))
        # Bone's scan (plaster) has its crazing in its colour only: cut it into the relief as well, about 1.5 texels deep a texel.
        a, b, stats = pack_layer(maps, tone_relief=1.5 if layer == "bone" else 0.0)
        save(os.path.join(OUT, f"{layer}-a.jpg"), a)
        save(os.path.join(OUT, f"{layer}-b.jpg"), b)
        attribution["layers"].append(dict(layer=layer, **record))
        print(layer, record["scan"], stats)
    json.dump(attribution, open(os.path.join(OUT, "attribution.json"), "w"), indent=1)


if __name__ == "__main__":
    args = sys.argv[1:]
    option = lambda name, default=None: args[args.index(name) + 1] if name in args else default
    if args[:1] == ["fetch"]:
        fetch()
    elif args[:1] == ["pack"]:
        pack(option("--src", SRC), option("--skin"))
    else:
        raise SystemExit(__doc__)
