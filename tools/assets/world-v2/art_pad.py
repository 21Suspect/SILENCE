"""Paints the landing pad's top: weathered concrete with a worn white ring and H (assets/world-v2/art/helipad_top.png).

    python3 tools/assets/world-v2/art_pad.py

The pad (models_pad.py) lays this over its top face as a poster. 2048 px over the 12 m slab is 170 px a metre: the paint reads
from the pad's edge and from the air, where it has to.
"""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
OUT = os.path.join(ROOT, "assets/world-v2/art/helipad_top.png")
N = 2048
rng = np.random.default_rng(97)


def noise(scale, octaves=5):
    """Value noise summed over octaves, 0..1, tileable enough for a slab."""
    out = np.zeros((N, N), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cells = max(2, int(scale * 2 ** o))
        small = rng.random((cells, cells)).astype(np.float32)
        out += np.asarray(Image.fromarray((small * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC), np.float32) / 255 * amp
        total += amp
        amp *= .5
    return out / total


# Concrete: grey with blotches, darker toward the edges where water stands, hairline cracks.
base = .42 + (noise(6) - .5) * .14 + (noise(40, 3) - .5) * .08
yy, xx = np.mgrid[0:N, 0:N] / (N - 1) * 2 - 1
edge = np.maximum(abs(xx), abs(yy))
base -= np.clip((edge - .8) / .2, 0, 1) ** 2 * .1
cracks = Image.new("L", (N, N), 0)
d = ImageDraw.Draw(cracks)
for _ in range(26):
    x, y = rng.uniform(0, N, 2)
    a = rng.uniform(0, 2 * np.pi)
    pts = [(x, y)]
    for _ in range(int(rng.integers(6, 18))):
        a += rng.normal(0, .5)
        x, y = x + np.cos(a) * rng.uniform(20, 70), y + np.sin(a) * rng.uniform(20, 70)
        pts.append((x, y))
    d.line(pts, fill=255, width=int(rng.integers(1, 3)))
crack = np.asarray(cracks.filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255
base -= crack * .12
# Paint: the touchdown ring and the H, worn where feet and skids scuffed it, chipped at random.
paint = Image.new("L", (N, N), 0)
p = ImageDraw.Draw(paint)
c, ring, w = N / 2, N * .37, N * .028
p.ellipse((c - ring, c - ring, c + ring, c + ring), outline=255, width=int(w))
hw, hh, bar = N * .16, N * .25, N * .055
p.rectangle((c - hw, c - hh, c - hw + bar, c + hh), fill=255)
p.rectangle((c + hw - bar, c - hh, c + hw, c + hh), fill=255)
p.rectangle((c - hw, c - bar / 2, c + hw, c + bar / 2), fill=255)
paint = np.asarray(paint.filter(ImageFilter.GaussianBlur(1.5)), np.float32) / 255
wear = np.clip((noise(24, 4) - .22) * 5, 0, 1) * np.clip(1 - crack * 2, 0, 1)
chips = (noise(90, 2) > .7).astype(np.float32)
paint *= wear * (1 - chips * .8)
# Moss in the cracks and along the edge, faint.
moss = np.clip(crack * 1.5 + np.clip((edge - .9) / .1, 0, 1) * noise(30, 3), 0, 1) * .6
rgb = np.stack([base, base * 1.0, base * .97], -1)
rgb = rgb * (1 - paint[..., None]) + np.array((.78, .77, .72)) * paint[..., None]
rgb = rgb * (1 - moss[..., None]) + np.array((.12, .15, .06)) * moss[..., None]
Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(OUT)
print("wrote", OUT)
