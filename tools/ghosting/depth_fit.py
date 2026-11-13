"""What depth (metres per unit of height) each ground scan's own normal map implies for its height map.
If a normal map was baked from the same displacement, normal.xy ~ -D * d(height)/d(metres); fit D by least squares.
The fits (corr .7 to .85) give the depths in groundLayerDepth (game/render/world/terrain.ts), each divided by about its
correlation and rounded (a least-squares slope is biased low by the noise in the height gradient by about that factor).

    python3 tools/ghosting/depth_fit.py .          (from the repository root; needs Pillow and numpy)
"""
from PIL import Image
import numpy as np
import sys
root = sys.argv[1]
sizes = {'floor': 2.5, 'litter': 3, 'roots': 1.67, 'moss': 1.5, 'path': 2.5, 'rocky': 2, 'rock': 2}
cur = {'floor': .16, 'litter': .14, 'roots': .13, 'moss': .1, 'path': .2, 'rocky': .22, 'rock': 0}
for n, size in sizes.items():
    c = Image.open(f'{root}/public/textures/ground/{n}-color.webp').convert('RGBA')
    h = np.asarray(c.resize((1024, 1024), Image.BOX))[:, :, 3].astype(float) / 255
    s = np.asarray(Image.open(f'{root}/public/textures/ground/{n}-surface.jpg').convert('RGB')).astype(float) / 255
    nx = s[:, :, 0] * 2 - 1
    ny = s[:, :, 1] * 2 - 1
    tau = size / 1024
    dhx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / 2 / tau
    dhy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) / 2 / tau
    best = []
    for sx in (1, -1):
        for sy in (1, -1):
            D = ((sx * nx * dhx).sum() + (sy * ny * dhy).sum()) / ((dhx ** 2).sum() + (dhy ** 2).sum())
            r = np.corrcoef(np.concatenate([(sx * nx).ravel(), (sy * ny).ravel()]), np.concatenate([dhx.ravel(), dhy.ravel()]))[0, 1]
            best.append((abs(r), D, sx, sy, r))
    best.sort(reverse=True)
    print(n, 'size', size, 'current depth', cur[n], 'best corr %.2f D=%.4f m (sx %d sy %d)' % (best[0][4], best[0][1], best[0][2], best[0][3]), 'height std %.3f' % h.std(), 'rms normal xy %.3f' % np.sqrt((nx ** 2 + ny ** 2).mean()))
