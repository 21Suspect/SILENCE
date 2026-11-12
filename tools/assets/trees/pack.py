"""
Textures for the conifers (game/render/world/conifer.ts): Poly Haven's CC0 pine_tree_01 and fir_tree_01 (Rico Cilliers,
Rob Tuytel). The trees themselves are film assets (4 to 7 million triangles, 1 GB); the game grows its own from a seed and
uses only their photographed maps: the twig atlases (needle sprays with alpha) and the bark.

  python3 tools/assets/trees/pack.py fetch   # the 4K twig maps and 2K bark maps into work/gfx/trees (git-ignored)
  python3 tools/assets/trees/pack.py         # packs them into public/world/trees/{pine,spruce} (needs ImageMagick 7)

SILENCE_TREE_CACHE=/abs/path overrides the cache folder (a worktree has no work/ of its own).

Twig: colour 2048 JPEG, alpha 2048 8-bit grey PNG, OpenGL normal 2048 JPEG 4:4:4, roughness 1024 (the ARM map's green).
Bark: colour 2048 with the ARM map's occlusion (red, ^0.6) multiplied in, normal 2048, roughness 1024.
The spray rectangles conifer.ts cuts cards from were measured on the alpha maps (connected components at 2048 px).
Bark height: the same scan's displacement map, 1024 grey (bark-height.jpg). The scans carry a slow undulation of the photographed
patch (blotches a tenth of the tile wide) that is not bark relief, so each map is high-passed (the tile's own wrap-around blur
taken off, mean back to mid grey) and its 0.5% tails clipped: black and white then mean the deepest and shallowest bark, and the
shader's relief depth (forest.ts, barkRelief) is the depth between those two.

The broadleaf trunks' bark is packed into public/plantassets/forest-variety: oak from Poly Haven's jolcham_oak_bark_01 (fetched,
2K), birch from cgbookcase's BirchBark01 (CC0, 4K = 2048x4096; its download is a button on the site, not a link a script can
follow, so unzip BirchBark01_4K.zip into <cache>/birch-cgbookcase/ by hand). Both: colour and DirectX/OpenGL normal at full size,
roughness and height at half. The birch normal stays DirectX (forest.ts flips normalScale.y); the oak's is OpenGL.
"""
import json, os, subprocess, sys, urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
CACHE = os.environ.get('SILENCE_TREE_CACHE') or os.path.join(ROOT, 'work/gfx/trees')
OUT = os.path.join(ROOT, 'public/world/trees')
SETS = {'pine_tree_01': 'pine', 'fir_tree_01': 'spruce'}
MAPS = {'twig_diff': '4k', 'twig_alpha': '4k', 'twig_nor_gl': '4k', 'twig_arm': '4k', 'bark_diff': '2k', 'bark_nor_gl': '2k', 'bark_arm': '2k', 'bark_disp': '2k'}
OAK = ('jolcham_oak_bark_01', {'Diffuse': 'diff', 'nor_gl': 'nor_gl', 'Rough': 'rough', 'Displacement': 'disp', 'AO': 'ao'})
BIRCH = os.path.join(CACHE, 'birch-cgbookcase', 'BirchBark01_4K_')
FOREST_VARIETY = os.path.join(ROOT, 'public/plantassets/forest-variety')
# Height maps: high-passed over a wrap-around blur of `sigma` pixels (at the size they are packed), then the tails clipped, so the
# relief depth in forest.ts means the same thing for every species.
def height(sigma): return ['-colorspace', 'Gray', '-virtual-pixel', 'tile', '(', '+clone', '-blur', f'0x{sigma}', ')',
                           '-compose', 'Mathematics', '-define', 'compose:args=0,1,-1,0.5', '-composite', '-compose', 'over', '-contrast-stretch', '0.5%x0.5%']

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
    name, maps = OAK
    files = json.loads(get(f'https://api.polyhaven.com/files/{name}'))
    os.makedirs(os.path.join(CACHE, name), exist_ok=True)
    for key, short in maps.items():
        path = os.path.join(CACHE, name, f'{short}_2k.jpg')
        if not os.path.exists(path): open(path, 'wb').write(get(files[key]['2k']['jpg']['url']))
    print('fetched', name)

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
        run(f'{src}/bark_disp_2k.jpg', '-colorspace', 'Gray', '-resize', '1024x1024', *height(48), '-quality', '92', f'{out}/bark-height.jpg')
        print('packed', asset, '->', out)
    pack_broadleaf()

def pack_broadleaf():
    run = lambda *a: subprocess.run(['magick', *a], check=True)
    os.makedirs(FOREST_VARIETY, exist_ok=True)
    # The oak: the scan's own occlusion goes into the colour as on the conifers (^0.6), so the fissures stay dark beyond the
    # distance the shader's relief reaches.
    src = os.path.join(CACHE, OAK[0])
    ao = os.path.join(CACHE, 'oak-ao.png')
    run(f'{src}/ao_2k.jpg', '-colorspace', 'Gray', '-evaluate', 'pow', '.6', ao)
    run(f'{src}/diff_2k.jpg', ao, '-compose', 'multiply', '-composite', '-quality', '88', f'{FOREST_VARIETY}/oak-diff.jpg')
    run(f'{src}/nor_gl_2k.jpg', '-quality', '90', '-sampling-factor', '1x1', f'{FOREST_VARIETY}/oak-normal.jpg')
    run(f'{src}/rough_2k.jpg', '-colorspace', 'Gray', '-resize', '50%', '-quality', '90', f'{FOREST_VARIETY}/oak-rough.jpg')
    run(f'{src}/disp_2k.jpg', '-colorspace', 'Gray', '-resize', '50%', *height(64), '-quality', '92', f'{FOREST_VARIETY}/oak-height.jpg')
    # The birch: BirchBark01's 2048x4096 maps. Its occlusion is baked in the same way; the normal stays DirectX.
    ao = os.path.join(CACHE, 'birch-ao.png')
    run(f'{BIRCH}AO.png', '-colorspace', 'Gray', '-evaluate', 'pow', '.6', ao)
    run(f'{BIRCH}BaseColor.png', ao, '-compose', 'multiply', '-composite', '-quality', '88', f'{FOREST_VARIETY}/birch-diff.jpg')
    run(f'{BIRCH}Normal.png', '-quality', '90', '-sampling-factor', '1x1', f'{FOREST_VARIETY}/birch-normal.jpg')
    run(f'{BIRCH}Roughness.png', '-colorspace', 'Gray', '-resize', '50%', '-quality', '90', f'{FOREST_VARIETY}/birch-rough.jpg')
    run(f'{BIRCH}Height.png', '-colorspace', 'Gray', '-resize', '50%', *height(128), '-quality', '92', f'{FOREST_VARIETY}/birch-height.jpg')
    print('packed oak and birch ->', FOREST_VARIETY)

if __name__ == '__main__':
    fetch() if 'fetch' in sys.argv else pack()
