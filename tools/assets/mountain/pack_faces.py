"""Pack the rock faces bake_faces.py rendered into tiling mountain layers, as public/textures/mountain packs its others.

  python3 tools/assets/mountain/pack_faces.py <faces dir> public/textures/mountain

<layer>-color.webp (2048 px): RGB albedo, A height. <layer>-surface.jpg (1024 px, 4:4:4): R,G normal x,y (OpenGL), B roughness.
  crag    mountainside          (Poly Haven, 7.2 m of a shattered, layered mountainside): the faces' broken rock, at every scale
  blocks  namaqualand_cliff_02  (Poly Haven, 6.5 m of jointed granite blocks): the cliffs' big joints
Tiling: overlap and cross-fade (tile() says how), the fade sharpened by height so the join goes along the rock's own cracks
rather than through a ghosted blend. Colour: the scans are desert stone (red-brown); taken to 30% of their chroma and a
neutral grey-brown, the shader (mountain-surface.ts) takes them the rest of the way to the island's granite. Normals: re-centred,
since no face was quite square to the camera, and a tilt of the whole map would light every tile the same way.
"""
import sys, os
import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
LAYERS = {'crag': 'mountainside', 'blocks': 'namaqualand_cliff_02'}


def load(name, kind, crop):
    raw = np.asarray(Image.open(os.path.join(src, f'{name}-{kind}.png')))  # Pillow reads Blender's 16-bit RGBA as 8-bit
    im = raw.astype(np.float64) / np.iinfo(raw.dtype).max
    n = im.shape[0]
    c = int(n * (1 - crop) / 2)
    return im[c:n - c, c:n - c]


def tile(maps, height, band=.18):
    # Overlap and cross-fade, one axis at a time: the map is cut to n - b, and its first b texels are faded into the b texels
    # that followed the cut, so the last texel runs on into the first as it did in the photograph. Nothing is repeated inside
    # the tile (a half-period roll repeated the middle at the edges). The fade is sharpened by height, so it follows the cracks.
    for axis in (1, 0):
        n = height.shape[axis]; b = int(n * band); m = n - b
        x = np.arange(b) / (b - 1)
        sl = lambda a, lo, hi: a[:, lo:hi] if axis == 1 else a[lo:hi]
        tail_h, head_h = sl(height, m, n), sl(height, 0, b)
        ramp = x[None, :] if axis == 1 else x[:, None]
        w = np.clip((ramp - .5) * 2.5 + (head_h - tail_h) * 2 + .5, 0, 1)
        w = np.where(ramp > .9, 1, np.where(ramp < .1, 0, w)); w = w * w * (3 - 2 * w)
        out = []
        for a in maps:
            ww = w[..., None] if a.ndim == 3 else w
            head = sl(a, 0, b) * ww + sl(a, m, n) * (1 - ww)
            out.append(np.concatenate([head, sl(a, b, m)], axis=axis))
        maps = out; height = maps[2]
    return maps


for layer, name in LAYERS.items():
    crop = .86 if name == 'namaqualand_cliff_02' else 1.0  # its top edge is ragged
    albedo = load(name, 'albedo', crop)[..., :3]
    normal = load(name, 'normal', crop)[..., :3] * 2 - 1
    height = load(name, 'height', crop)[..., 0]
    rough = load(name, 'rough', crop)[..., 0]
    albedo, normal, height, rough = tile([albedo, normal, height, rough], height)
    lum = albedo[..., 0] * .2126 + albedo[..., 1] * .7152 + albedo[..., 2] * .0722
    albedo = lum[..., None] + (albedo - lum[..., None]) * .3
    albedo *= np.array([1.0, .99, .97])
    nx, ny = normal[..., 0] - normal[..., 0].mean(), normal[..., 1] - normal[..., 1].mean()
    nz = np.sqrt(np.clip(1 - nx * nx - ny * ny, 0, 1))
    height = (height - height.min()) / max(1e-6, height.max() - height.min())
    rgba = np.dstack([np.clip(albedo, 0, 1), height]) * 255
    Image.fromarray(rgba.round().astype(np.uint8)).resize((2048, 2048), Image.LANCZOS).save(os.path.join(dst, f'{layer}-color.webp'), quality=90, method=6)
    surf = np.dstack([nx * .5 + .5, ny * .5 + .5, rough]) * 255
    Image.fromarray(np.clip(surf, 0, 255).round().astype(np.uint8)).resize((1024, 1024), Image.LANCZOS).save(os.path.join(dst, f'{layer}-surface.jpg'), quality=92, subsampling=0)
    print(layer, 'mean albedo', albedo.reshape(-1, 3).mean(0).round(3), 'normal z mean', nz.mean().round(3))
