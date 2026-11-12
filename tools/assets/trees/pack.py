"""
Textures for the conifers (game/render/world/conifer.ts): Poly Haven's CC0 pine_tree_01 and fir_tree_01 (Rico Cilliers,
Rob Tuytel). The trees themselves are film assets (4 to 7 million triangles, 1 GB); the game grows its own from a seed and
uses only their photographed maps: the twig atlases (needle sprays with alpha) and the bark.

  python3 tools/assets/trees/pack.py fetch   # the 4K twig maps and 2K bark maps into work/gfx/trees (git-ignored)
  python3 tools/assets/trees/pack.py         # packs them into public/world/trees/{pine,spruce} (needs ImageMagick 7)

Twig: colour 2048 JPEG, alpha 2048 8-bit grey PNG, OpenGL normal 2048 JPEG 4:4:4, roughness 1024 (the ARM map's green).
Bark: colour 2048 with the ARM map's occlusion (red, ^0.6) multiplied in, normal 2048, roughness 1024.
The spray rectangles conifer.ts cuts cards from were measured on the alpha maps (connected components at 2048 px).
"""
import json, os, subprocess, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
CACHE = os.path.join(ROOT, 'work/gfx/trees')
OUT = os.path.join(ROOT, 'public/world/trees')
SETS = {'pine_tree_01': 'pine', 'fir_tree_01': 'spruce'}
MAPS = {'twig_diff': '4k', 'twig_alpha': '4k', 'twig_nor_gl': '4k', 'twig_arm': '4k', 'bark_diff': '2k', 'bark_nor_gl': '2k', 'bark_arm': '2k'}

def fetch():
    agent = {'User-Agent': 'silence-game-asset-download'}
    get = lambda url: urllib.request.urlopen(urllib.request.Request(url, headers=agent)).read()
    for asset in SETS:
        files = json.loads(get(f'https://api.polyhaven.com/files/{asset}'))
        os.makedirs(os.path.join(CACHE, asset, 'hi'), exist_ok=True)
        for key, res in MAPS.items():
            fmt = 'png' if key == 'twig_alpha' else 'jpg'
            path = os.path.join(CACHE, asset, 'hi', f'{key}_{res}.{fmt}')
            if not os.path.exists(path): open(path, 'wb').write(get(files[key][res][fmt]['url']))
        print('fetched', asset)

def pack():
    run = lambda *a: subprocess.run(['magick', *a], check=True)
    for asset, name in SETS.items():
        src, out = os.path.join(CACHE, asset, 'hi'), os.path.join(OUT, name)
        os.makedirs(out, exist_ok=True)
        run(f'{src}/twig_diff_4k.jpg', '-resize', '2048x2048', '-quality', '88', f'{out}/twig-color.jpg')
        run(f'{src}/twig_alpha_4k.png', '-strip', '-resize', '2048x2048', '-colorspace', 'gray', '-depth', '8', '-define', 'png:color-type=0', f'{out}/twig-alpha.png')
        run(f'{src}/twig_nor_gl_4k.jpg', '-resize', '2048x2048', '-quality', '90', '-sampling-factor', '1x1', f'{out}/twig-normal.jpg')
        run(f'{src}/twig_arm_4k.jpg', '-channel', 'G', '-separate', '-resize', '1024x1024', '-quality', '90', f'{out}/twig-roughness.jpg')
        ao = os.path.join(CACHE, f'{name}-ao.png')
        run(f'{src}/bark_arm_2k.jpg', '-channel', 'R', '-separate', '-evaluate', 'pow', '.6', ao)
        run(f'{src}/bark_diff_2k.jpg', ao, '-compose', 'multiply', '-composite', '-quality', '88', f'{out}/bark-color.jpg')
        run(f'{src}/bark_nor_gl_2k.jpg', '-quality', '90', '-sampling-factor', '1x1', f'{out}/bark-normal.jpg')
        run(f'{src}/bark_arm_2k.jpg', '-channel', 'G', '-separate', '-resize', '1024x1024', '-quality', '90', f'{out}/bark-roughness.jpg')
        print('packed', asset, '->', out)

if __name__ == '__main__':
    fetch() if 'fetch' in sys.argv else pack()
