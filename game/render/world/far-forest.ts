import * as THREE from 'three';
import { FAR_TREE_STRIDE, type FarForestData } from './far-forest-bake';
import type { FarShadow } from './far-shadow';
import { createImpostorAtlas, impostorMaterial, impostorCasterMaterial, buildImpostors, type ImpostorInstance } from './impostors';

/**
 * The forest beyond the streamed trees (forest.ts draws them to 98 m), out to the island's edge and up the range: no radius past
 * which the forest stops, only cheaper ways of drawing the same trees (impostors.ts), as Distant Horizons does for Minecraft.
 *   The island's forest: its own trees (far-forest-bake.ts runs the forest's layout), each the impostor of its own model, taking
 *   over across the band where the streamed trees dissolve out (83 to 98 m), so walking towards a tree never swaps it.
 *   The range's forest: conifers stood on the bake's forest cover (mountain-bake.ts islandBake: below a tree line that climbs the
 *   gullies, off cliffs, scree and avalanche chutes), where the streamed forest has few; they come in from 110 to 160 m.
 */
/** Where each set comes in (metres from the eye): the island's trees where the streamed ones go (forest.ts fadeInstances 83 to
 *  98 m), the range's where a flat tree is a few dozen pixels. */
const DEV_TREE_HAND = import.meta.env.DEV && typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('tree-hand')) || 0 : 0;
const ISLAND_FADE: readonly [number, number] = import.meta.env.DEV && typeof location !== 'undefined' && location.search.includes('impostor-ab') ? [0, .5] : DEV_TREE_HAND ? [DEV_TREE_HAND - 15, DEV_TREE_HAND] : [83, 98];
const RANGE_FADE = [110, 160] as const;
// Dev: ?impostor-ab shows the island's impostors from the eye out, so with the streamed forest hidden they can be compared tree for
// tree with the real ones at the same pose (the look must be the same, only the detail lower).
/** The forest's models are 31 m tall at a height factor of 1 (forest.ts). */
const MODEL_HEIGHT = 31;
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

export type ImpostorSource = {
  models: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; bark: THREE.Material; leaves: THREE.Material }[];
  modelOf(kind: number, seed: number): number;
  girth(kind: number, height: number, width: number): number;
  textures: THREE.Texture[];
};

export function createFarForest(scene: THREE.Scene, renderer: THREE.WebGLRenderer, source: ImpostorSource, eye: THREE.Vector3, farShadow?: FarShadow) {
  // Every model as the streamed forest draws it where the impostors take over: the far trunk and the light crown (forest.ts swaps
  // to them from 22 to 30 m).
  const atlas = createImpostorAtlas(renderer, source.models.map(m => ({ parts: [{ geometry: m.trunk, material: m.bark }, { geometry: m.crown, material: m.leaves, foliage: true }] })));
  const eyeUniform = { value: eye };
  // No tint, no extra shade: the streamed trees' own lighting (impostors.ts sums it over the normals a texel stands for, light
  // through the leaves included at its full strength) and their own shadows, the island-wide map at each texel's real depth, as
  // the streamed trees past 36 m get no other. Each correction this had before (a tint, a skirt shade, a third of the
  // translucency) was compensating for a bake that differed from the real trees: the full crown where they show the light one,
  // a self-shade they do not have past 36 m, normals bent outward, half-covered texels cut solid.
  const look = { translucent: 1, sky: 1 };
  const islandMaterial = impostorMaterial(atlas, scene, eyeUniform, { ...look, fadeIn: ISLAND_FADE }, farShadow, 'tree');
  const rangeMaterial = impostorMaterial(atlas, scene, eyeUniform, { ...look, fadeIn: RANGE_FADE }, farShadow, 'tree');
  const caster = farShadow ? impostorCasterMaterial(atlas, farShadow.sun) : undefined;
  let island: FarForestData | undefined, range: { trees: Float32Array; horizons: Uint8Array } | undefined;
  const built: ReturnType<typeof buildImpostors>[] = [], near: number[] = [];
  let builtIsland = false, builtRange = false;

  /** The island's trees, exactly as the streamed forest has them (its models, widths and turns). */
  function buildIsland(d: FarForestData) {
    const T = d.trees, S = FAR_TREE_STRIDE, items: ImpostorInstance[] = [];
    for (let o = 0; o < T.length; o += S) {
      const kind = T[o + 6], h = T[o + 4];
      items.push({ x: T[o], y: T[o + 1], z: T[o + 2], yaw: T[o + 3], height: h, width: source.girth(kind, h, T[o + 5]), model: source.modelOf(kind, T[o + 7]) });
    }
    built.push(buildImpostors(scene, items, d.horizons, islandMaterial, 'Distant forest', { caster, farShadow })); near.push(ISLAND_FADE[0]);
  }
  /** The range's conifers: spruce mostly, pine on the warmer, lower ground (the forest's kinds 0 to 3), each a model and turn of its own. */
  function buildRange(d: { trees: Float32Array; horizons: Uint8Array }) {
    const T = d.trees, items: ImpostorInstance[] = [];
    for (let i = 0; i < T.length / 4; i++) {
      const x = T[i * 4], y = T[i * 4 + 1], z = T[i * 4 + 2], h = T[i * 4 + 3] / MODEL_HEIGHT, r = hash(x * .37 + z * 1.13);
      const kind = r < .25 + .3 * (1 - Math.min(1, Math.max(0, (y - 30) / 60))) ? Math.floor(r * 8) % 2 : 2 + Math.floor(r * 8) % 2;
      items.push({ x, y: y - .4, z, yaw: hash(x - z * .71) * Math.PI * 2, height: h, width: source.girth(kind, h, h * (.85 + .3 * hash(z * .53 + x))) * 1.12, model: source.modelOf(kind, Math.floor(hash(x * 2.1 + z) * 1000)) });
    }
    built.push(buildImpostors(scene, items, d.horizons, rangeMaterial, 'Distant forest on the range', { caster, farShadow })); near.push(RANGE_FADE[0]);
  }

  return {
    atlas,
    /** The island's trees (far-forest-bake.ts). */
    setIsland(d: FarForestData) { island = d; },
    /** The range's trees (mountain-bake.ts: x, y, z, height in metres each) and their horizons. */
    setRange(trees: Float32Array, horizons: Uint8Array) { range = { trees, horizons }; },
    /** Bakes the atlas as soon as the forest's maps are in (inside the loading veil: the workers and the maps hold it), then draws
     *  each set as it arrives. */
    update() {
      // A chunk wholly inside the streamed forest's range has all its trees drawn streamed: skipped.
      built.forEach((b, i) => b.cull(eye, near[i]));
      if ((!island && !range) || (!atlas.baked && !atlas.ready())) return;
      if (!atlas.baked) {
        atlas.bake();
        if (import.meta.env.DEV) (window as unknown as { __FAR_FOREST__: unknown }).__FAR_FOREST__ = { albedo: atlas.albedo, normals: atlas.normals, renderer, frames: atlas.frames, built };
      }
      if (island && !builtIsland) { buildIsland(island); builtIsland = true; }
      if (range && !builtRange) { buildRange(range); builtRange = true; }
    },
    get treeCount() { return (island ? island.trees.length / FAR_TREE_STRIDE : 0) + (range ? range.trees.length / 4 : 0); },
    dispose() { for (const b of built) b.dispose(); caster?.dispose(); islandMaterial.dispose(); rangeMaterial.dispose(); atlas.dispose(); },
  };
}
