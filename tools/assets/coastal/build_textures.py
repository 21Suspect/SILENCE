"""Rebuild CC0 terrain atlas (Pillow, curl). Run from any working directory.

Each scan keeps a 1024px face with wrapped 16px gutters. Layers are stacked in
reverse image order because Three.js flips image Y on upload. The colour atlas
is sRGB; the normal/roughness atlas is linear with roughness in alpha.
"""
from pathlib import Path
import json
import subprocess
import tempfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'public/textures'
SIZE, GUTTER = 1024, 16
TILE = SIZE + GUTTER * 2
LAYERS = 3


def scan(asset, suffix, cache):
    file = cache / f'{asset}_{suffix}.jpg'
    if not file.exists():
        url = f'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/{asset}/{asset}_{suffix}_1k.jpg'
        subprocess.run(['curl', '-fLs', '--retry', '3', url, '-o', str(file)], check=True)
    return Image.open(file).convert('RGB').resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def gutter(image):
    target = Image.new(image.mode, (TILE, TILE))
    for y in (-SIZE, 0, SIZE):
        for x in (-SIZE, 0, SIZE):
            target.paste(image, (GUTTER + x, GUTTER + y))
    return target


with tempfile.TemporaryDirectory(prefix='silence-coastal-') as tmp:
    cache = Path(tmp)
    colour = Image.new('RGB', (TILE, TILE * LAYERS))
    packed = Image.new('RGBA', colour.size)
    for layer, asset in enumerate(['sand_02', 'snow_02', 'brown_mud_leaves_01']):
        if layer == 2:
            diffuse = Image.open(OUT / 'leaves-diff.jpg').convert('RGB').resize((SIZE, SIZE))
            normal = Image.open(OUT / 'leaves-normal.jpg').convert('RGB').resize((SIZE, SIZE))
            rough = Image.new('L', (SIZE, SIZE), 227)
        else:
            diffuse = scan(asset, 'diff', cache)
            normal = scan(asset, 'nor_gl', cache)
            rough = scan(asset, 'rough', cache).convert('L')
        normal.putalpha(rough)
        offset = (0, (LAYERS - 1 - layer) * TILE)
        colour.paste(gutter(diffuse), offset)
        packed.paste(gutter(normal), offset)
    colour.save(OUT / 'coastal-diff.webp', quality=93, method=6)
    packed.save(OUT / 'coastal-normal-rough.png', optimize=True)

normal = Image.open(OUT / 'ground-normal.jpg').convert('RGB')
rough = Image.open(OUT / 'ground-rough.jpg').convert('L').resize(normal.size)
normal.putalpha(rough)
normal.save(OUT / 'ground-normal-rough.png', optimize=True)

credits_file = OUT / 'texture-attribution.json'
credits = json.loads(credits_file.read_text())
for asset in credits['assets']:
    if asset['asset'] in ['sand_02', 'snow_02', 'brown_mud_leaves_01']:
        asset['files'] = ['coastal-diff.webp', 'coastal-normal-rough.png']
        asset['processing'] = 'Sand/snow/leaf-litter atlas; 16px wrapped gutters; roughness in normal alpha. Rebuild: tools/assets/coastal/build_textures.py'
credits_file.write_text(json.dumps(credits, indent=2) + '\n')
print('Rebuilt 3-layer terrain atlas and packed ground normal/roughness.')
