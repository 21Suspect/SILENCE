"""
Leaf sprays for the broadleaf trees (game/render/world/broadleaf.ts), composed from scanned leaves: ambientCG LeafSet016
(English oak) and LeafSet004 (a deltoid, pointed leaf that reads as silver birch at tree scale), both CC0.

  python3 tools/assets/trees/sprays.py fetch   # the 2K leaf scans into work/gfx/leaves/src (git-ignored)
  python3 tools/assets/trees/sprays.py         # composes public/world/trees/{oak,birch}/spray-{color.jpg,alpha.png,normal.jpg}

A spray is what one card on the tree shows: a twig with its leaves, laid out as the species grows them (oak leaves crowd
in rosettes at the shoot tips, birch leaves alternate along a fine drooping twig). Four sprays per species share a 2048
atlas, each in a 1024 cell with its stem leaving the cell at the bottom centre, where the card is fixed to its branch.
Every leaf is the photographed leaf (colour, opacity, normal), turned, mirrored, scaled and tinted; leaves are laid
back to front, each first darkening what lies under it with its own blurred shadow, so a spray has depth in the shade
as well as in the sun. Tangent-space normals are turned with their leaves. Colour and normals are bled into the empty
texels so mipmaps do not pull a dark or flat fringe into the leaf edges. Needs numpy and Pillow; deterministic.
"""
import io, json, math, os, random, subprocess, sys, urllib.request, zipfile
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
SRC = os.path.join(ROOT, 'work/gfx/leaves/src')
OUT = os.path.join(ROOT, 'public/world/trees')
CELL, ATLAS = 1024, 2048
SCANS = {'oak': 'LeafSet016', 'birch': 'LeafSet004'}

def fetch():
    for asset in SCANS.values():
        if os.path.isdir(os.path.join(SRC, asset)): continue
        url = f'https://ambientcg.com/get?file={asset}_2K-JPG.zip'
        data = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'silence-game-asset-download'})).read()
        zipfile.ZipFile(io.BytesIO(data)).extractall(os.path.join(SRC, asset))
        print('fetched', asset)

def leaves(asset):
    """Each scanned leaf as float arrays (colour 0-1 sRGB, alpha, normal -1..1) cropped to its box, petiole at the bottom."""
    base = os.path.join(SRC, asset, f'{asset}_2K-JPG')
    color = np.asarray(Image.open(base + '_Color.jpg').convert('RGB'), np.float32) / 255
    alpha = np.asarray(Image.open(base + '_Opacity.jpg').convert('L'), np.float32) / 255
    normal = np.asarray(Image.open(base + '_NormalGL.jpg').convert('RGB'), np.float32) / 127.5 - 1
    # The boxes of the six leaves on each sheet (ImageMagick connected components of the opacity, 8-connected).
    out = subprocess.run(['magick', base + '_Opacity.jpg', '-threshold', '50%', '-define', 'connected-components:verbose=true',
                          '-define', 'connected-components:area-threshold=3000', '-connected-components', '8', 'null:'],
                         capture_output=True, text=True, check=True).stdout
    found = []
    for line in out.splitlines():
        if 'gray(255)' not in line: continue
        w, rest = line.split(':')[1].split()[0].split('x'); h, x, y = rest.split('+')
        w, h, x, y = int(w), int(h), int(x), int(y)
        x0, y0, x1, y1 = max(0, x - 8), max(0, y - 8), min(alpha.shape[1], x + w + 8), min(alpha.shape[0], y + h + 8)
        a = alpha[y0:y1, x0:x1].copy()
        found.append({'color': color[y0:y1, x0:x1], 'alpha': a, 'normal': normal[y0:y1, x0:x1], 'origin': (x0, y0)})
    found.sort(key=lambda leaf: (leaf['origin'][1] // 400, leaf['origin'][0]))
    for leaf in found:
        a = leaf['alpha']; ys, xs = np.nonzero(a > .5)
        bottom = ys.max(); leaf['base'] = (float(xs[ys >= bottom - 3].mean()), float(bottom))
        leaf['length'] = float(bottom - ys.min())
    return found

def rgba(arrays):
    return Image.fromarray(np.clip(np.dstack(arrays) * 255 + .5, 0, 255).astype(np.uint8))

class Spray:
    """One 1024 cell: premultiplied colour, coverage and normal accumulated back to front."""
    def __init__(self, metres):
        self.color = np.zeros((CELL, CELL, 3), np.float32); self.alpha = np.zeros((CELL, CELL), np.float32)
        self.normal = np.zeros((CELL, CELL, 3), np.float32); self.normal[..., 2] = 1
        self.scale = CELL / metres  # pixels per metre

    def shade_under(self, coverage, strength):
        # The leaf (or twig) about to be laid shades what is already there: its coverage blurred and nudged down-right,
        # as light from above the card would throw it a few millimetres onto the leaves behind.
        img = Image.fromarray((coverage * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(9))
        shadow = np.roll(np.roll(np.asarray(img, np.float32) / 255, 7, 0), 4, 1)
        self.color *= (1 - strength * shadow)[..., None]

    def lay(self, color, alpha, normal):
        a = alpha[..., None]
        self.color = color * a + self.color * (1 - a)
        self.normal = normal * a + self.normal * (1 - a)
        self.alpha = alpha + self.alpha * (1 - alpha)

    def stem(self, points, width0, width1, tint, rng):
        """A twig along a polyline in metres (x right, y up from the cell's bottom centre), tapering, lit across its width."""
        px = [(CELL / 2 + x * self.scale, CELL - 6 - y * self.scale) for x, y in points]
        cov = np.zeros((CELL, CELL), np.float32); across = np.zeros((CELL, CELL), np.float32)
        yy, xx = np.mgrid[0:CELL, 0:CELL].astype(np.float32)
        total = sum(math.dist(px[i], px[i + 1]) for i in range(len(px) - 1)); run = 0
        for i in range(len(px) - 1):
            (ax, ay), (bx, by) = px[i], px[i + 1]; seg = math.dist(px[i], px[i + 1]) or 1
            box = (int(max(0, min(ax, bx) - 20)), int(min(CELL, max(ax, bx) + 20)), int(max(0, min(ay, by) - 20)), int(min(CELL, max(ay, by) + 20)))
            sx, sy = slice(box[0], box[1]), slice(box[2], box[3])
            dx, dy = (bx - ax) / seg, (by - ay) / seg
            t = np.clip(((xx[sy, sx] - ax) * dx + (yy[sy, sx] - ay) * dy) / seg, 0, 1)
            side = (xx[sy, sx] - ax) * -dy + (yy[sy, sx] - ay) * dx
            dist = np.hypot(xx[sy, sx] - (ax + dx * seg * t), yy[sy, sx] - (ay + dy * seg * t))
            f = (run + t * seg) / total; w = (width0 + (width1 - width0) * f) * self.scale * .5
            c = np.clip(w + .5 - dist, 0, 1)
            take = c > cov[sy, sx]
            cov[sy, sx] = np.where(take, c, cov[sy, sx]); across[sy, sx] = np.where(take, np.clip(side / np.maximum(w, .5), -1, 1), across[sy, sx])
            run += seg
        self.shade_under(cov, .35)
        nx = across; nz = np.sqrt(np.clip(1 - nx * nx, 0, 1))
        light = .55 + .45 * np.clip(-nx * .6 + nz * .8, 0, 1)
        grain = 1 + .08 * np.sin(yy * .9 + xx * .15)
        color = np.dstack([np.full_like(cov, tint[k]) for k in range(3)]) * (light * grain)[..., None]
        self.lay(color, cov, np.dstack([nx, np.zeros_like(nx), nz]))
        return px

    def leaf(self, leaf, at, angle, length, rng, mirror=False, squash=1., tint=(1, 1, 1), tilt=(0., 0.)):
        """Lays a scanned leaf with its petiole base at `at` (metres), pointing `angle` radians from straight up (positive
        to the left), `length` metres from petiole to tip, foreshortened across by `squash` (the leaf seen edge-on)."""
        s = length * self.scale / leaf['length']
        h, w = leaf['alpha'].shape
        size = (max(2, round(w * s * squash)), max(2, round(h * s)))
        # Pre-filter to about the final scale (Lanczos), so the rotation below only resamples near 1:1.
        col = rgba([leaf['color'][..., 0], leaf['color'][..., 1], leaf['color'][..., 2], leaf['alpha']]).resize(size, Image.LANCZOS)
        nor = rgba([leaf['normal'][..., 0] * .5 + .5, leaf['normal'][..., 1] * .5 + .5, leaf['normal'][..., 2] * .5 + .5]).resize(size, Image.LANCZOS)
        bx, by = leaf['base'][0] * s * squash, leaf['base'][1] * s
        if mirror:
            col = col.transpose(Image.FLIP_LEFT_RIGHT); nor = nor.transpose(Image.FLIP_LEFT_RIGHT); bx = size[0] - bx
        # Canvas -> leaf image: rotate about the petiole base by -angle, then offset.
        cx, cy = CELL / 2 + at[0] * self.scale, CELL - 6 - at[1] * self.scale
        c, sn = math.cos(angle), math.sin(angle)
        # Leaf image vector v maps to canvas as R(angle) v, with image y down: canvas = base + [c, s; -s, c] v.
        # Inverse: v = [c, -s; s, c] (canvas - base).
        data = (c, -sn, bx - c * cx + sn * cy, sn, c, by - sn * cx - c * cy)
        col = np.asarray(col.transform((CELL, CELL), Image.AFFINE, data, Image.BICUBIC), np.float32) / 255
        nor = np.asarray(nor.transform((CELL, CELL), Image.AFFINE, data, Image.BICUBIC), np.float32) / 127.5 - 1
        a = col[..., 3]
        if a.max() <= 0: return
        n = nor.copy()
        if mirror: n[..., 0] *= -1
        # Tangent-space normals turn with the leaf (image y is down, the normal's y is up, hence +angle).
        n[..., 0], n[..., 1] = c * n[..., 0] - sn * n[..., 1], sn * n[..., 0] + c * n[..., 1]
        # A leaf held at an angle to the card leans all its normals one way, so leaves catch the light differently.
        n[..., 0] += tilt[0]; n[..., 1] += tilt[1]
        n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-4)
        self.shade_under(a, .42)
        self.lay(col[..., :3] * np.asarray(tint, np.float32), a, n)

    def bleed(self, steps=24):
        """Spreads colour and normal outward into the empty texels (premultiplied box-blur fill), keeping coverage as is."""
        a = self.alpha; filled = a > .02
        # Colour was accumulated premultiplied by coverage; the texels of a leaf edge get their own colour back.
        col = np.where(filled[..., None], self.color / np.maximum(a, 1e-3)[..., None], 0)
        nor = np.where(filled[..., None], self.normal, 0)
        near = lambda x: np.roll(x, 1, 0) + np.roll(x, -1, 0) + np.roll(x, 1, 1) + np.roll(x, -1, 1)
        for _ in range(steps):
            w = near(filled.astype(np.float32)); grow = ~filled & (w > 0)
            if not grow.any(): break
            sc, sn = near(col * filled[..., None]), near(nor * filled[..., None])
            col[grow] = sc[grow] / w[grow][:, None]; nor[grow] = sn[grow] / w[grow][:, None]
            filled = filled | grow
        col[~filled] = self.color[a > .5].mean(0) / max(1e-3, float(a[a > .5].mean())) if (a > .5).any() else .2
        nor[~filled] = (0, 0, 1)
        nor /= np.maximum(np.linalg.norm(nor, axis=2, keepdims=True), 1e-4)
        return np.clip(col, 0, 1), nor

def oak(spray, leaves_, rng):
    """A shoot from the cell's foot, forking once or twice, every tip a rosette of five to eight lobed leaves."""
    lean = rng.uniform(-.06, .06)
    trunk = [(0, 0), (lean * .3, .08), (lean, .17), (lean * 1.4 + rng.uniform(-.02, .02), .25)]
    tips = [(trunk[-1], 0.)]
    forks = []
    for side in (-1, 1):
        if rng.random() < .8:
            a = trunk[1 + rng.randrange(2)]
            end = (a[0] + side * rng.uniform(.09, .14), a[1] + rng.uniform(.07, .12))
            forks.append([a, ((a[0] + end[0]) / 2 + side * .01, (a[1] + end[1]) / 2 + .015), end]); tips.append((end, side * rng.uniform(.5, .8)))
    for f in forks: spray.stem(f, .0035, .0022, (.42, .36, .29), rng)
    spray.stem(trunk, .0055, .003, (.42, .36, .29), rng)
    lay = []
    for (x, y), heading in tips:
        count = rng.randint(5, 8)
        for i in range(count):
            angle = heading + (i - (count - 1) / 2) / max(1, count - 1) * rng.uniform(2.4, 3.0) + rng.uniform(-.15, .15)
            length = rng.uniform(.075, .11) * (1 - .25 * abs(math.sin(angle - heading)))
            lay.append((abs(angle - heading), (x + rng.uniform(-.006, .006), y + rng.uniform(-.004, .006)), angle, length))
    # A few single leaves along the shoots below the rosettes.
    for f in [trunk] + forks:
        for t in (.45, .7):
            if rng.random() < .6:
                (ax, ay), (bx, by) = f[1], f[2]
                side = rng.choice((-1, 1)); lay.append((3, (ax + (bx - ax) * t, ay + (by - ay) * t), side * rng.uniform(.7, 1.2), rng.uniform(.065, .09)))
    # Outer leaves first: the upright ones in the middle of a rosette lie on top.
    lay.sort(key=lambda item: -item[0])
    for _, at, angle, length in lay:
        g = rng.uniform(.82, 1.08)
        spray.leaf(rng.choice(leaves_), at, angle, length, rng, mirror=rng.random() < .5, squash=rng.uniform(.72, 1.),
                   tint=(g * rng.uniform(.86, .96), g * rng.uniform(.92, 1.0), g * rng.uniform(.74, .86)), tilt=(rng.uniform(-.25, .25), rng.uniform(-.25, .25)))

def birch(spray, leaves_, rng):
    """A fine twig, slightly zigzag at each node, leaves alternating along it and in pairs on short spurs."""
    def twig(start, heading, nodes, step, width):
        pts = [start]; x, y = start
        for i in range(nodes):
            heading += (.18 if i % 2 else -.18) + rng.uniform(-.06, .06); s = step * (1 - .35 * i / nodes)
            x += math.sin(-heading) * s; y += math.cos(heading) * s; pts.append((x, y))
        spray.stem(pts, width, .001, (.30, .21, .17), rng)
        return pts, heading
    main, heading = twig((0, 0), rng.uniform(-.1, .1), 8 + rng.randrange(2), .04, .0028)
    # Side twigs leave the main one every other node, alternating, and fan out: a spray is a little fan of twigs.
    twigs = [main]
    for i, side in ((1, 1), (2, -1), (4, 1), (5, -1)):
        if i < len(main) - 2 and rng.random() < .85:
            twigs.append(twig(main[i], heading * .3 + side * rng.uniform(.55, .85), 4 + rng.randrange(3), .032, .0018)[0])
    lay = []
    for pts in twigs:
        for i in range(1, len(pts)):
            side = 1 if i % 2 else -1
            # Short shoots carry two or three leaves together, long shoots one at each node.
            n = 1 + (rng.random() < .45) + (rng.random() < .15)
            for k in range(n):
                angle = side * rng.uniform(.5, 1.1) + (k - (n - 1) / 2) * .55
                length = rng.uniform(.05, .068) * (1 - .2 * i / len(pts))
                lay.append((rng.random(), pts[i], angle, length))
        lay.append((2, pts[-1], rng.uniform(-.2, .2), rng.uniform(.045, .055)))
    lay.sort(key=lambda item: item[0])
    for _, at, angle, length in lay:
        g = rng.uniform(.84, 1.1)
        spray.leaf(rng.choice(leaves_), at, angle, length, rng, mirror=rng.random() < .5, squash=rng.uniform(.7, 1.),
                   tint=(g * rng.uniform(.9, 1.0), g * rng.uniform(.95, 1.02), g * rng.uniform(.72, .84)), tilt=(rng.uniform(-.3, .3), rng.uniform(-.3, .3)))

# Physical size of one 1024 cell: an oak spray spans about 45 cm, a birch twig about 42 cm.
SPECIES = {'oak': (oak, .46), 'birch': (birch, .42)}

def build():
    for name, (grow, metres) in SPECIES.items():
        leaves_ = leaves(SCANS[name])
        color = np.zeros((ATLAS, ATLAS, 3), np.float32); alpha = np.zeros((ATLAS, ATLAS), np.float32); normal = np.zeros((ATLAS, ATLAS, 3), np.float32)
        for cell in range(4):
            rng = random.Random(f'{name}-{cell}')
            spray = Spray(metres); grow(spray, leaves_, rng)
            c, n = spray.bleed()
            y, x = (cell // 2) * CELL, (cell % 2) * CELL
            color[y:y + CELL, x:x + CELL] = c; alpha[y:y + CELL, x:x + CELL] = spray.alpha; normal[y:y + CELL, x:x + CELL] = n
        out = os.path.join(OUT, name); os.makedirs(out, exist_ok=True)
        Image.fromarray((color * 255 + .5).astype(np.uint8)).save(os.path.join(out, 'spray-color.jpg'), quality=90, subsampling=0)
        Image.fromarray((alpha * 255 + .5).astype(np.uint8), 'L').save(os.path.join(out, 'spray-alpha.png'), optimize=True)
        Image.fromarray(((normal * .5 + .5) * 255 + .5).astype(np.uint8)).save(os.path.join(out, 'spray-normal.jpg'), quality=92, subsampling=0)
        print('composed', name, '->', out)

if __name__ == '__main__':
    fetch() if 'fetch' in sys.argv else build()
