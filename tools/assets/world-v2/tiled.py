"""Tiled build for the buildings: shared high-resolution library materials plus a small unique map per prop.

kit.build() bakes a whole prop into one atlas, so a 9 m cabin gets 123 texels per metre however good its sources are
(work/gfx/research/texture-audit.md). A model authored with Model(..., tiled=True) is built here instead:

* TEXCOORD_0 is the part's own metric UV divided by its library entry's `metres` (library.py), so the shared scans tile
  at 900 to 2000 texels per metre and never stretch. Every part already starts at a random place in the scan.
* TEXCOORD_1 is a unique atlas for a `macro` map baked here at `model.tex`: R ambient occlusion (0.5 m contact times the share of sky the part sees, so a room is dim), G moss,
  B grime (rain streaks, splash at the foot, dirt in crevices), A a per-part and slow tone variation. It is low
  frequency on purpose; detail comes from the scans.
* Each material is plain (base colour = the recipe's tint) and names its library entry in its extras (`lib`), with
  `normal`, `vary` and `moss` settings; game/render/props/prop-materials.ts hangs the shared maps on it and reads the
  macro map from the glTF occlusion slot. Image materials (posters) and the glass pane export as before.
"""
import math
import os
import random
import subprocess
import tempfile

import bpy
import numpy as np

import kit
import library
import shrink_textures
from kit import G, log

# Recipe name -> library entry and look. `tint` multiplies the scan in linear light; `rough` and `metal` are glTF factors
# (roughness multiplies the scan's own); `normal` is the normal map strength; `moss`, `grime` how readily the part takes
# them; `vary` how far one part's tone may stray from the next.
# Wood is warmed against the scan's grey: shaded walls take a lot of blue sky light in the game (measured on screen: logs
# at sRGB 45/58/68 beside grass at 61/69/54), where a forest's own green-brown bounce would warm them in life.
TILED = {
    "logwood": dict(lib="timber", tint=(1.38, 1.18, .94), moss=.5, grime=.8, vary=.22, normal=1.2),
    "wood": dict(lib="timber", tint=(1.32, 1.18, 1.0), moss=.25, grime=.7, vary=.2, normal=1.0),
    "wood_dark": dict(lib="timber", tint=(.88, .75, .62), moss=.2, grime=.6, vary=.16, normal=1.0),
    "wood_fresh": dict(lib="timber", tint=(1.5, 1.25, .92), moss=0, grime=.2, vary=.1, normal=.8),
    "boards": dict(lib="boards", tint=(1.12, 1.08, 1.04), moss=.45, grime=.6, vary=.14, normal=1.0),
    "floor": dict(lib="floor", tint=(.86, .84, .82), moss=.15, grime=.6, vary=.1, normal=1.0),
    "tin": dict(lib="sheet", tint=(.92, .95, .98), metal=.3, rough=.95, moss=.3, grime=.7, vary=.16, normal=1.0),
    # Masonry is displaced by the scan's own height (parts_hq.masonry_face): the normal map only adds what geometry can't.
    "stone": dict(lib="fieldstone", tint=(.8, .78, .74), moss=1.0, grime=.6, vary=.2, normal=.6),
    "stone_soot": dict(lib="fieldstone", tint=(.2, .19, .18), moss=0, grime=.9, vary=.1, normal=.6),
    "rock": dict(lib="rock", tint=(1.0, 1.0, 1.0), moss=.6, grime=.5, vary=.15, normal=1.0),
    "char": dict(lib="bark", tint=(.05, .045, .04), rough=.9, moss=0, grime=.3, vary=.05, normal=1.2),
    "blanket": dict(lib="canvas", tint=(1.7, .55, .32), moss=0, grime=.4, vary=.05, normal=1.0),
    "mortar": dict(lib="mortar", tint=(.92, .92, .9), moss=.5, grime=.7, vary=.12, normal=1.0),
    "iron": dict(lib="iron", tint=(.55, .52, .5), metal=.5, moss=0, grime=.3, vary=.1, normal=1.0),
    "iron_black": dict(lib="iron", tint=(.16, .15, .14), metal=.55, rough=.9, moss=0, grime=.25, vary=.08, normal=1.2),
    "bark": dict(lib="bark", tint=(1.0, 1.0, 1.0), moss=.6, grime=.4, vary=.2, normal=1.2),
    "endgrain": dict(lib="endgrain", tint=(.86, .76, .64), moss=.15, grime=.5, vary=.2, normal=1.0),
    "canvas": dict(lib="canvas", tint=(3.0, 2.85, 2.35), moss=0, grime=.5, vary=.1, normal=1.0),
}
# A lamp's lit globe: no library maps, its glow set by the game from the lamp's brightness (prop-materials.ts).
TILED["lamp_glow"] = dict(lib=None, glow=True, tint=(1.0, .86, .62), moss=0, grime=0, vary=0)
# The baked recipes' names, so a model written for kit.build() can be built tiled unchanged.
TILED.update(concrete=TILED["mortar"], steel=TILED["iron_black"], steel_bare=TILED["iron"], soot_iron=TILED["iron_black"])
AO_DISTANCE = .5
INDOOR_AMBIENT = .16         # share of the sky's light left where no sky is seen (a closed room)


def tile_uvs(obj, model):
    """Rewrite the `tile` layer from each island's metric UVs into library repeats."""
    rng = random.Random(model.name)
    uvs = []
    for name in sorted(model.parts):
        b = model.parts[name]
        uv = np.concatenate(b["uv"]).astype(float)
        r = TILED.get(name)
        for start, count, k, _density in b["islands"]:
            part = uv[start:start + count]
            if r is None or r.get("lib") is None:
                continue                                     # an image material (its own 0..1 square) or a glow
            if r["lib"] == "endgrain":
                # A log end takes one of the four discs, turned and maybe mirrored.
                q, a = rng.randrange(4), rng.random() * 2 * math.pi
                c = part - .5
                if rng.random() < .5:
                    c[:, 0] *= -1
                c = c @ np.array(((math.cos(a), -math.sin(a)), (math.sin(a), math.cos(a)))).T
                part[:] = c * .5 * .97 + .25 + np.array((q % 2, q // 2)) * .5
            else:
                part[:] = part * k / library.LIBRARY[r["lib"]]["metres"]
        uvs.append(uv)
    uv = np.concatenate(uvs)
    tile = obj.data.uv_layers["tile"]
    loops = np.zeros(len(obj.data.loops), int)
    obj.data.loops.foreach_get("vertex_index", loops)
    tile.data.foreach_set("uv", uv[loops].ravel())


def mask_material(name):
    """What the macro bake sees: emission R moss, G grime, B tone variation (AO is baked on its own)."""
    r = TILED.get(name, dict(moss=0, grime=.3, vary=0))
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    g = G(mat.node_tree)
    geo = g.node("ShaderNodeNewGeometry")
    pos = geo.outputs["Position"]
    nsep = g.node("ShaderNodeSeparateXYZ")
    g.link(geo.outputs["Normal"], nsep.inputs[0])
    psep = g.node("ShaderNodeSeparateXYZ")
    g.link(pos, psep.inputs[0])
    nz, z = nsep.outputs["Z"], psep.outputs["Z"]
    seed = g.node("ShaderNodeVertexColor", layer_name="seed").outputs["Color"]
    seed_r = g.node("ShaderNodeSeparateColor")
    g.link(seed, seed_r.inputs[0])
    # Weather reaches what can see the sky: inside the cabin nothing grows and no rain runs.
    open_sky = g.ao(6.0, samples=16)
    weather = g.ramp(open_sky, .25, .6)
    crevice = g.math("SUBTRACT", 1.0, g.ao(.22, samples=12))
    up = g.ramp(nz, .15, .9)
    foot = g.ramp(z, 1.0, .08)
    broad = g.noise(pos, .8, 4, .6)
    fine = g.noise(pos, 7, 4, .62)
    field = g.math("ADD", g.math("MULTIPLY", up, .5), g.math("MULTIPLY", foot, .55))
    field = g.math("ADD", field, g.math("MULTIPLY", crevice, .4))
    field = g.math("ADD", field, g.math("MULTIPLY", g.math("SUBTRACT", broad, .5), 1.3))
    field = g.math("ADD", field, g.math("MULTIPLY", g.math("SUBTRACT", fine, .5), .45))
    moss = g.math("MULTIPLY", g.math("MULTIPLY", g.ramp(field, .55, .85), weather), r["moss"])
    # Grime: rain streaks run down what stands upright, mud splashes the foot, dirt sits in the crevices.
    upright = g.math("SUBTRACT", 1.0, g.ramp(g.math("ABSOLUTE", nz), .35, .85))
    streak = g.math("MULTIPLY", g.ramp(g.noise(g.stretch(pos, 7, 7, .3), 1.0, 3, .55), .5, .78), upright)
    splash = g.ramp(z, .6, .04)
    grime = g.math("ADD", g.math("MULTIPLY", g.math("ADD", g.math("MULTIPLY", streak, .5), g.math("MULTIPLY", splash, .85)), weather), g.math("MULTIPLY", crevice, .45))
    grime = g.math("MULTIPLY", g.math("MINIMUM", grime, 1.0), r["grime"])
    vary = g.math("ADD", .5, g.math("MULTIPLY", g.math("SUBTRACT", seed_r.outputs[0], .5), .8))
    vary = g.math("ADD", vary, g.math("MULTIPLY", g.math("SUBTRACT", g.noise(pos, .45, 2, .5), .5), .7), clamp=True)
    combine = g.node("ShaderNodeCombineColor")
    g.link(moss, combine.inputs[0])
    g.link(grime, combine.inputs[1])
    g.link(vary, combine.inputs[2])
    # Second pass (`pass` = 1): how much sky reaches the part. The game's ambient light comes from the whole sky, walls or
    # not, so a room would be lit like the porch; this scales it down indoors to what comes in by the door and windows.
    sky = g.mixf(g.ramp(open_sky, .03, .42), INDOOR_AMBIENT, 1.0)
    pass_ = g.node("ShaderNodeValue", name="pass")
    pass_.outputs[0].default_value = 0.0
    chosen = g.mix(pass_.outputs[0], combine.outputs[0], _grey(g, sky))
    em = g.node("ShaderNodeEmission")
    g.link(chosen, em.inputs["Color"])
    out = g.n["Material Output"]
    g.link(em.outputs[0], out.inputs["Surface"])
    return mat, None


def _grey(g, v):
    n = g.node("ShaderNodeCombineColor")
    for i in range(3):
        g.link(v, n.inputs[i])
    return n.outputs[0]


def bake_macro(obj, size, samples):
    scene = bpy.context.scene
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bake = bpy.ops.object.bake
    # Masks and openness first, without the ground: the ground is not a roof. It is where a porch ceiling's light comes
    # from (the game's hemisphere sends it up as bounce), so only the model's own walls and roofs may shut out the sky.
    img = kit._bake_target("masks", size)
    kit._set_targets(obj, img)
    scene.cycles.samples = samples
    bake(type="EMIT", margin=12)
    masks = kit._pixels(img, size)
    for mat in obj.data.materials:
        mat.node_tree.nodes["pass"].outputs[0].default_value = 1.0
    img = kit._bake_target("sky", size)
    kit._set_targets(obj, img)
    bake(type="EMIT", margin=12)
    sky = kit._pixels(img, size)[..., 0]
    # Contact occlusion with a ground plane, so the foot of every wall and post is darkened where it meets the earth.
    bpy.ops.mesh.primitive_plane_add(size=160, location=(0, 0, -0.005))
    ground = bpy.context.active_object
    ground.data.materials.append(bpy.data.materials.new("bake ground"))
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    img = kit._bake_target("ao", size)
    kit._set_targets(obj, img)
    scene.world = scene.world or bpy.data.worlds.new("bake")
    scene.world.light_settings.distance = AO_DISTANCE
    scene.cycles.samples = samples * 2
    bake(type="AO", margin=12)
    ao = kit._pixels(img, size)[..., 0]
    bpy.data.objects.remove(ground)
    return np.clip(np.stack((ao * sky, masks[..., 0], masks[..., 1], masks[..., 2]), -1), 0, 1)


def export_material(model, name):
    if name not in TILED:
        return image_material(name)
    r = TILED[name]
    mat = bpy.data.materials.new(f"{model.name} {name}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    if r.get("glow"):
        bsdf.inputs["Base Color"].default_value = (*r["tint"], 1)
        bsdf.inputs["Emission Color"].default_value = (*r["tint"], 1)
        bsdf.inputs["Emission Strength"].default_value = 1.0
        mat["glow"] = 1
        return mat
    # glTF clamps the base colour to 1, so a tint that brightens the scan travels in the extras (`tint`); the base colour
    # keeps its hue for other viewers.
    peak = max(1.0, *r["tint"])
    bsdf.inputs["Base Color"].default_value = (*(c / peak for c in r["tint"]), 1)
    mat["tint"] = list(r["tint"])
    bsdf.inputs["Roughness"].default_value = r.get("rough", 1.0)
    bsdf.inputs["Metallic"].default_value = r.get("metal", 0.0)
    mat["lib"] = r["lib"]
    mat["normal"] = r.get("normal", 1.0)
    mat["vary"] = r.get("vary", .15)
    return mat


def image_material(name):
    """A printed sheet: its image on the part's own 0..1 square, as kit's poster recipe."""
    recipe = kit.RECIPES[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    bsdf = tree.nodes["Principled BSDF"]
    uv = tree.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "tile"
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = kit._image(recipe["image"], True)
    tree.links.new(uv.outputs[0], tex.inputs[0])
    tree.links.new(tex.outputs[0], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = .85
    return mat


def attach_macro(path, macro, name, quality=88):
    """Put the macro map in the GLB as a WebP texture and hang it on every library material's occlusion slot (TEXCOORD_1)."""
    doc, blob = shrink_textures.read_glb(path)
    views = [bytes(blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]) for v in doc["bufferViews"]]
    with tempfile.TemporaryDirectory() as tmp:
        png, webp = os.path.join(tmp, "m.png"), os.path.join(tmp, "m.webp")
        size = macro.shape[0]
        img = bpy.data.images.new(f"{name}_macro", size, size, alpha=True)
        img.colorspace_settings.name = "Non-Color"
        img.alpha_mode = "STRAIGHT"
        img.pixels.foreach_set(macro.astype(np.float32).ravel())     # Blender rows run bottom-up, as baked
        img.filepath_raw = png
        img.file_format = "PNG"
        img.save()
        subprocess.run(["cwebp", "-quiet", "-q", str(quality), "-alpha_q", "100", "-exact", "-m", "5", png, "-o", webp], check=True)
        data = open(webp, "rb").read()
    doc["bufferViews"].append(dict(buffer=0, byteLength=len(data)))
    views.append(data)
    doc.setdefault("images", []).append(dict(bufferView=len(views) - 1, mimeType="image/webp", name=f"{name}_macro"))
    doc.setdefault("samplers", []).append(dict(magFilter=9729, minFilter=9987, wrapS=33071, wrapT=33071))
    doc.setdefault("textures", []).append(dict(sampler=len(doc["samplers"]) - 1, extensions=dict(EXT_texture_webp=dict(source=len(doc["images"]) - 1))))
    for ext in ("extensionsUsed", "extensionsRequired"):
        if "EXT_texture_webp" not in doc.setdefault(ext, []):
            doc[ext].append("EXT_texture_webp")
    texture = len(doc["textures"]) - 1
    tagged = 0
    for m in doc.get("materials", []):
        if (m.get("extras") or {}).get("lib"):
            m["occlusionTexture"] = dict(index=texture, texCoord=1)
            tagged += 1
    shrink_textures.write_glb(path, doc, views)
    return tagged


LAMP_MAX = 4.0     # irradiance per candela stored at full scale (a surface 0.5 m from the flame)


def _soften(a, sigma=.8):
    """A small Gaussian blur, separable: what is left of the bake's noise after its samples. Under a texel of radius, so it
    stays inside the 3-texel gaps the atlas leaves between islands."""
    r = int(math.ceil(sigma * 3))
    k = np.exp(-np.arange(-r, r + 1) ** 2 / (2 * sigma * sigma))
    k /= k.sum()
    a = np.apply_along_axis(lambda row: np.convolve(np.pad(row, r, mode="edge"), k, mode="valid"), 1, a)
    return np.apply_along_axis(lambda col: np.convolve(np.pad(col, r, mode="edge"), k, mode="valid"), 0, a)


def bake_lamps(obj, model, size, samples=1024):
    """The light of the model's lamps (`model.lamps`: [{at, radius}]), with their shadows and one bounce off surfaces of the
    library's own colours: irradiance per candela on every texel of the macro atlas. A 1 cd point is a Blender point light of
    4 pi W, and Cycles' diffuse light pass is irradiance / pi (measured: 0.317 at 1 m), hence the factor pi."""
    lamps = getattr(model, "lamps", None)
    if not lamps:
        return None
    import json
    means = json.load(open(os.path.join(library.OUT, "library.json")))
    scene = bpy.context.scene
    saved = list(obj.data.materials)
    for i, name in enumerate(sorted(model.parts)):
        r = TILED.get(name, {})
        mat = bpy.data.materials.new(f"lamp bake {name}")
        mat.use_nodes = True
        tree = mat.node_tree
        if r.get("glow"):
            # The globe lets its own light out.
            out = tree.nodes["Material Output"]
            tree.links.new(tree.nodes.new("ShaderNodeBsdfTransparent").outputs[0], out.inputs["Surface"])
        else:
            mean = means.get(r.get("lib"), dict(mean=(.15, .15, .15)))["mean"]
            tint = r.get("tint", (1, 1, 1))
            bsdf = tree.nodes["Principled BSDF"]
            bsdf.inputs["Base Color"].default_value = (*(min(.9, a * b) for a, b in zip(mean, tint)), 1)
            bsdf.inputs["Roughness"].default_value = 1
        obj.data.materials[i] = mat
    world = scene.world or bpy.data.worlds.new("bake")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.0
    added = []
    for lamp in lamps:
        light = bpy.data.lights.new("lamp", "POINT")
        light.energy = 4 * math.pi
        light.shadow_soft_size = lamp.get("radius", .03)
        o = bpy.data.objects.new("lamp", light)
        bpy.context.collection.objects.link(o)
        o.location = tuple(kit.to_blender(np.array(lamp["at"], float)))
        added.append(o)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    img = kit._bake_target("lamp", size)
    kit._set_targets(obj, img)
    scene.cycles.samples = samples
    bounces, clamp = scene.cycles.diffuse_bounces, scene.cycles.sample_clamp_indirect
    scene.cycles.diffuse_bounces = 2
    scene.cycles.sample_clamp_indirect = .5     # a bounce off a texel next to the flame must not leave a bright speck on the floor
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=8)
    scene.cycles.diffuse_bounces, scene.cycles.sample_clamp_indirect = bounces, clamp
    lit = _soften(kit._pixels(img, size)[..., 0]) * math.pi
    for o in added:
        bpy.data.objects.remove(o)
    for i, mat in enumerate(saved):
        obj.data.materials[i] = mat
    log(model.name, "lamp light baked: irradiance per cd, p50 %.3f p99 %.3f max %.2f" % (np.median(lit[lit > 1e-4]) if (lit > 1e-4).any() else 0, np.percentile(lit, 99), lit.max()))
    return lit


def attach_lamp(path, lit, name, quality=90):
    """The lamp light map as each library material's emissive texture on TEXCOORD_1 (emissive colour black: the game turns it into
    light, prop-materials.ts), sRGB-encoded irradiance / LAMP_MAX, so its darks keep their steps."""
    doc, blob = shrink_textures.read_glb(path)
    views = [bytes(blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]) for v in doc["bufferViews"]]
    x = np.clip(lit / LAMP_MAX, 0, 1)
    enc = np.where(x <= .0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - .055)
    rgba = np.ones(lit.shape + (4,), np.float32)
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = enc
    with tempfile.TemporaryDirectory() as tmp:
        png, webp = os.path.join(tmp, "l.png"), os.path.join(tmp, "l.webp")
        img = bpy.data.images.new(f"{name}_lamp", lit.shape[1], lit.shape[0], alpha=False)
        img.colorspace_settings.name = "Non-Color"
        img.pixels.foreach_set(rgba.ravel())
        img.filepath_raw = png
        img.file_format = "PNG"
        img.save()
        subprocess.run(["cwebp", "-quiet", "-q", str(quality), "-m", "5", png, "-o", webp], check=True)
        data = open(webp, "rb").read()
    doc["bufferViews"].append(dict(buffer=0, byteLength=len(data)))
    views.append(data)
    doc["images"].append(dict(bufferView=len(views) - 1, mimeType="image/webp", name=f"{name}_lamp"))
    doc["samplers"].append(dict(magFilter=9729, minFilter=9987, wrapS=33071, wrapT=33071))
    doc["textures"].append(dict(sampler=len(doc["samplers"]) - 1, extensions=dict(EXT_texture_webp=dict(source=len(doc["images"]) - 1))))
    texture = len(doc["textures"]) - 1
    for m in doc.get("materials", []):
        extras = m.get("extras") or {}
        if extras.get("lib"):
            m["emissiveTexture"] = dict(index=texture, texCoord=1)
            m["emissiveFactor"] = [0, 0, 0]
            extras["lampMax"] = LAMP_MAX
            m["extras"] = extras
    shrink_textures.write_glb(path, doc, views)


def build(model, shots=None, samples=24):
    kit.clear_scene()
    kit.setup_cycles()
    panes = model.parts.pop("glass", None)
    import support
    support.report(support.audit(model), log)
    obj, _ = kit.assemble(model, mask_material)
    kit.atlas_uv(obj, model)
    macro = bake_macro(obj, model.tex, samples)
    log(model.name, "macro baked")
    # At the atlas's own size: its islands are packed 3 texels apart, so a coarser map (or a wider blur) bleeds the light of
    # one surface into the next, and a log end outside glowed with the room's light.
    lit = bake_lamps(obj, model, model.tex)
    tile_uvs(obj, model)
    names = sorted(model.parts)
    # Swap each slot in place: clearing the slots would reset every face to the first one.
    for i, name in enumerate(names):
        obj.data.materials[i] = export_material(model, name)
    obj.data.uv_layers.active = obj.data.uv_layers["tile"]
    if "seed" in obj.data.color_attributes:
        obj.data.color_attributes.remove(obj.data.color_attributes["seed"])
    extra = [kit.glass_object(model.name, panes)] if panes else []
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for o in extra:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(kit.OUT, model.name + ".glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False, export_animations=False,
                              export_yup=True, export_normals=True, export_texcoords=True, export_materials="EXPORT",
                              export_image_format="WEBP", export_image_quality=88, export_extras=True, export_vertex_color="NONE")
    tagged = attach_macro(path, macro, model.name)
    if lit is not None:
        attach_lamp(path, lit, model.name)
    log(model.name, "exported", round(os.path.getsize(path) / 1e6, 2), "MB,", tagged, "library materials")
    entry = dict(url=f"/world/{model.name}.glb", radius=model.radius, colliders=model.colliders, hooks=model.hooks, ladders=model.ladders)
    if model.doors:
        entry["doors"] = model.doors
    return entry
