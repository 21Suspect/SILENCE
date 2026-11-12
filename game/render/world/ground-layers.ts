import * as THREE from 'three';
import { loadTextureArray } from './texture-array';

/**
 * The forest floor's materials: seven scanned CC0 sets from Poly Haven and ambientCG (public/textures/ground/attribution.json), each packed
 * into two images and loaded into two texture arrays, so the ground shader reads every layer through two samplers.
 *   color   (2048 px, sRGB): diffuse x ambient occlusion^0.6, height in alpha (for height-based blending)
 *   surface (1024 px):       normal x, normal y, roughness
 * Layer order is the shader's (game/render/world/terrain.ts); physical sizes are the scans' own, in metres.
 */
export const GROUND_LAYERS = [
  { name: 'floor', size: 2.5 },    // Ground068 (ambientCG): moss mats with lanes of needle litter, the damp conifer floor
  { name: 'litter', size: 3 },     // forest_leaves_02: leaves, sticks and moss under broadleaf trees
  { name: 'roots', size: 1.67 },   // roots: root mats round trunk bases
  { name: 'moss', size: 1.5 },     // Moss003 (ambientCG): moss carpet on damp, level ground
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
