import * as THREE from 'three';
import { loadTextureArray } from './texture-array';

/**
 * The forest floor's materials: seven scanned CC0 sets from Poly Haven (public/textures/ground/attribution.json), each packed
 * into two images and loaded into two texture arrays, so the ground shader reads every layer through two samplers.
 *   color   (2048 px, sRGB): diffuse x ambient occlusion^0.6, height in alpha (for height-based blending)
 *   surface (1024 px):       normal x, normal y, roughness
 * Layer order is the shader's (game/render/world/terrain.ts); physical sizes are the scans' own, in metres.
 */
export const GROUND_LAYERS = [
  { name: 'floor', size: 3.15 },   // forest_ground_04: soil, needles, twigs and small stones
  { name: 'litter', size: 1.5 },   // forest_leaves_04: needle and leaf litter
  { name: 'roots', size: 1.67 },   // roots: root mats round trunk bases
  { name: 'moss', size: 2 },       // sparse_grass: moss and short grass on damp, open ground
  { name: 'path', size: 2.17 },    // stony_dirt_path: worn trails and trodden pads
  { name: 'rocky', size: 2 },      // rocky_trail: stony ground on slopes, gravel at path edges
  { name: 'rock', size: 2 },       // lichen_rock: rock faces (projected three ways)
] as const;

export function createGroundLayers(renderer?: THREE.WebGLRenderer) {
  const url = (name: string, kind: string, ext: string) => `/textures/ground/${name}-${kind}.${ext}`;
  if (!renderer) {
    // Headless (tests, tools): empty arrays of the right shape.
    const blank = (srgb: boolean) => { const t = new THREE.DataArrayTexture(new Uint8Array(4 * GROUND_LAYERS.length).fill(128), 1, 1, GROUND_LAYERS.length); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t; };
    return { color: blank(true), surface: blank(false), ready: Promise.resolve() };
  }
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const color = loadTextureArray(renderer, GROUND_LAYERS.map(l => url(l.name, 'color', 'webp')), { size: 2048, srgb: true, anisotropy });
  const surface = loadTextureArray(renderer, GROUND_LAYERS.map(l => url(l.name, 'surface', 'jpg')), { size: 1024, anisotropy });
  return { color: color.texture as THREE.Texture, surface: surface.texture as THREE.Texture, ready: Promise.all([color.ready, surface.ready]).then(() => {}) };
}
