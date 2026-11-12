"""Halves the normal and occlusion/roughness/metal maps inside the prop GLBs, leaving the colour map at full size.

    python3 shrink_textures.py [asset ...]        (needs cwebp and dwebp on PATH; no arguments = every GLB in public/world)

Why: every prop used to ship three maps of the same size. On the GPU a 4096 map costs about 85 MB with its mips, so the
ten big buildings alone held 2.5 GB. What the eye reads as sharpness is the colour map; the normal and ORM maps carry
slow-changing shading, and at half size they are indistinguishable in play (a 2048 normal map over a 9 m cabin is still
about two texels per centimetre at arm's length). kit.export() calls shrink() on every GLB it writes, so new builds
come out the same; running it again on a file that is already shrunk changes nothing.
"""
import json
import os
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
WORLD = os.path.join(ROOT, "public/world")
MIN_SIDE = 2048          # maps this big or bigger are halved; smaller ones are already cheap


def webp_size(data):
    kind = data[12:16]
    if kind == b"VP8 ":
        return struct.unpack("<H", data[26:28])[0] & 0x3FFF, struct.unpack("<H", data[28:30])[0] & 0x3FFF
    if kind == b"VP8L":
        bits = struct.unpack("<I", data[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if kind == b"VP8X":
        return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    raise ValueError("not a WebP image")


def read_glb(path):
    data = open(path, "rb").read()
    assert data[:4] == b"glTF", path
    n = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20:20 + n])
    start = 20 + n
    m = struct.unpack("<I", data[start:start + 4])[0]
    return doc, data[start + 8:start + 8 + m]


def write_glb(path, doc, views):
    """views: the bytes of every bufferView, in order. Offsets are laid out again from scratch."""
    blob = bytearray()
    for view, content in zip(doc["bufferViews"], views):
        while len(blob) % 4:
            blob.append(0)
        view["byteOffset"] = len(blob)
        view["byteLength"] = len(content)
        blob += content
    while len(blob) % 4:
        blob.append(0)
    doc["buffers"][0]["byteLength"] = len(blob)
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, total))
        f.write(struct.pack("<I", len(text)) + b"JSON" + text)
        f.write(struct.pack("<I", len(blob)) + b"BIN\0" + bytes(blob))


def shrink(path, quiet=False):
    """Returns (GPU megabytes before, after) for the file's textures, counting mips."""
    doc, blob = read_glb(path)
    views = [bytes(blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]) for v in doc["bufferViews"]]
    images = doc.get("images", [])
    sizes = [webp_size(views[i["bufferView"]]) if i.get("mimeType") == "image/webp" else None for i in images]
    colour = max((s[0] for i, s in zip(images, sizes) if s and i.get("name", "").endswith("_albedo")), default=0)
    cost = lambda sides: sum(s[0] * s[1] * 4 * 4 / 3 for s in sides if s) / 1e6
    before, changed = cost(sizes), False
    for k, (image, size) in enumerate(zip(images, sizes)):
        name = image.get("name", "")
        if not size or not (name.endswith("_normal") or name.endswith("_orm")):
            continue
        # Already half the colour map, or small enough not to matter.
        if size[0] < MIN_SIDE or (colour and size[0] <= colour // 2):
            continue
        with tempfile.TemporaryDirectory() as tmp:
            src, png, out = (os.path.join(tmp, n) for n in ("in.webp", "x.png", "out.webp"))
            open(src, "wb").write(views[image["bufferView"]])
            subprocess.run(["dwebp", "-quiet", src, "-o", png], check=True)
            # Normals keep a little more quality: blocking in a normal map shows as shading, in a roughness map it does not.
            subprocess.run(["cwebp", "-quiet", "-resize", str(size[0] // 2), str(size[1] // 2), "-q", "90" if name.endswith("_normal") else "84", "-m", "5", png, "-o", out], check=True)
            views[image["bufferView"]] = open(out, "rb").read()
        sizes[k] = (size[0] // 2, size[1] // 2)
        changed = True
    if changed:
        write_glb(path, doc, views)
    after = cost(sizes)
    if not quiet:
        print(f"{os.path.basename(path):24s} {before:7.0f} MB -> {after:7.0f} MB on the GPU{'' if changed else '   (unchanged)'}", flush=True)
    return before, after


if __name__ == "__main__":
    names = sys.argv[1:] or sorted(f[:-4] for f in os.listdir(WORLD) if f.endswith(".glb"))
    total = [0.0, 0.0]
    for n in names:
        b, a = shrink(os.path.join(WORLD, n + ".glb"))
        total[0] += b
        total[1] += a
    print(f"{'all':24s} {total[0]:7.0f} MB -> {total[1]:7.0f} MB on the GPU")
