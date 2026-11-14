/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed
 * with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Advanced Terrain Erosion Filter, after Rune Skovbo Johansen ("Fast and Gorgeous Erosion Filter", blog.runevision.com, March
 * 2026; Shadertoy wXcfWn; Copyright 2025 Rune Skovbo Johansen, MPL-2.0), ported to TypeScript from the Rust CPU mirror in
 * bevy_erosion_filter 0.1.1 (src/cpu.rs, MPL-2.0; WGSL/Rust port additions copyright 2026 the bevy_erosion_filter authors).
 * Inigo Quilez's 2D hash and gradient noise with derivatives (`noised`) come along with it under MIT, as in that crate.
 * TypeScript port and the comments: SILENCE, 2026. This file stays under MPL-2.0 (file-level copyleft); the rest of the
 * repository is MIT. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Why this filter: the Clay John style filter it replaces (cosine stripes across the slope, each octave turned by the gullies
 * before it) gave soft, melted gullies on both sides of every crest: "crumpled foil" from afar. This one fades each octave
 * towards a target (-1 in valleys, +1 on peaks) wherever the slope gives out, so crests stay crisp and the valley floors stay
 * clean; its gullies join downhill (the next octave follows the slope the last one carved) and it rounds ridges and creases by
 * separate amounts. It also gives a ridge map (-1 gully line .. +1 ridge line), which the mountains' shading uses as drainage.
 *
 * Pure per-point maths, as the terrain needs: any point's height is known on its own (the worker, the colliders, the tests).
 * Units: positions, heights and slopes in one unit (the caller scales metres by a length), so slopes are true rise over run.
 */

const TAU = Math.PI * 2;
const fract = (v: number) => v - Math.floor(v);
const clamp01 = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const powInv = (t: number, power: number) => 1 - Math.pow(1 - clamp01(t), power);
const easeOut = (t: number) => { const v = 1 - clamp01(t); return 1 - v * v; };
const smoothStart = (t: number, smoothing: number) => t >= smoothing ? t - .5 * smoothing : .5 * t * t / smoothing;

/** Inigo Quilez's 2D hash: one component, -1..1 (k picks x or y). */
const K0 = .3183099, K1 = .3678794;
function hashX(x: number, y: number) { const a = x * K0 + K1, b = y * K1 + K0; return -1 + 2 * fract(16 * K0 * fract(a * b * (a + b))); }
function hashY(x: number, y: number) { const a = x * K0 + K1, b = y * K1 + K0; return -1 + 2 * fract(16 * K1 * fract(a * b * (a + b))); }

/** Inigo Quilez's gradient noise with its analytic derivative: writes [value, d/dx, d/dy] into out. */
export function noised(px: number, py: number, out: number[]) {
  const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const gax = hashX(ix, iy), gay = hashY(ix, iy), gbx = hashX(ix + 1, iy), gby = hashY(ix + 1, iy);
  const gcx = hashX(ix, iy + 1), gcy = hashY(ix, iy + 1), gdx = hashX(ix + 1, iy + 1), gdy = hashY(ix + 1, iy + 1);
  const va = gax * fx + gay * fy, vb = gbx * (fx - 1) + gby * fy, vc = gcx * fx + gcy * (fy - 1), vd = gdx * (fx - 1) + gdy * (fy - 1);
  const k = va - vb - vc + vd;
  out[0] = va + ux * (vb - va) + uy * (vc - va) + ux * uy * k;
  out[1] = gax + ux * (gbx - gax) + uy * (gcx - gax) + ux * uy * (gax - gbx - gcx + gdx) + dux * (uy * k + vb - va);
  out[2] = gay + ux * (gby - gay) + uy * (gcy - gay) + ux * uy * (gay - gby - gcy + gdy) + duy * (ux * k + vc - va);
  return out;
}

/**
 * Rune Skovbo Johansen's Phacelle noise: a wave across `dir` (normalised), blended from a jittered 4 x 4 neighbourhood of cells
 * so it bends smoothly between them. Writes [cos wave, sin wave, side x, side y]; the side vector is premultiplied by freq * TAU,
 * so sin wave x side is the cosine wave's approximate derivative.
 */
function phacelle(px: number, py: number, dirX: number, dirY: number, freq: number, offsetCycles: number, normalization: number, out: number[]) {
  const sideX = -dirY * freq * TAU, sideY = dirX * freq * TAU, offset = offsetCycles * TAU;
  const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
  let cx = 0, cy = 0, weightSum = 0;
  for (let i = -1; i <= 2; i++) for (let j = -1; j <= 2; j++) {
    const gx = ix + i, gy = iy + j;
    const vx = fx - i - hashX(gx, gy) * .5, vy = fy - j - hashY(gx, gy) * .5;
    const weight = Math.exp(-(vx * vx + vy * vy) * 2) - .01111;
    if (weight <= 0) continue;
    weightSum += weight;
    const wave = vx * sideX + vy * sideY + offset;
    cx += Math.cos(wave) * weight; cy += Math.sin(wave) * weight;
  }
  cx /= weightSum; cy /= weightSum;
  const magnitude = Math.max(1 - normalization, Math.hypot(cx, cy));
  out[0] = cx / magnitude; out[1] = cy / magnitude; out[2] = sideX; out[3] = sideY;
}

export type ErosionParams = {
  /** Spacing of the widest gullies, in the caller's unit. */
  scale: number;
  /** Depth of the gullies relative to their spacing. */
  strength: number;
  gullyWeight: number;
  /** How quickly finer octaves give out where coarser ones flattened the slope. */
  detail: number;
  /** Rounding of ridges (x), of creases (y), for the input (z), growth per octave (w). */
  rounding: readonly [number, number, number, number];
  /** Slope at which the filter sets in: input (x), octave (y), ridge map input (z), ridge map octave (w). */
  onset: readonly [number, number, number, number];
  /** The slope the first octave assumes (x) and how far it trusts that over the real one (y). */
  assumedSlope: readonly [number, number];
  cellScale: number;
  normalization: number;
  octaves: number;
  lacunarity: number;
  gain: number;
};
/** The upstream defaults (bevy_erosion_filter's ErosionFilterParams::default, which are Rune's). */
export const EROSION_DEFAULTS: ErosionParams = {
  scale: .15, strength: .22, gullyWeight: .5, detail: 1.5, rounding: [.1, 0, .1, 2], onset: [1.25, 1.25, 2.8, 1.5],
  assumedSlope: [.7, 1], cellScale: .7, normalization: .5, octaves: 5, lacunarity: 2, gain: .5,
};

/** The filter's result: the height and slope to add, the octaves' summed strength, and the ridge map (-1 gully .. +1 ridge). */
export type ErosionResult = { height: number; slopeX: number; slopeY: number; magnitude: number; ridge: number };
const ph = [0, 0, 0, 0];

/**
 * Erosion at p for land of height h and slope (sx, sy), all in one unit. `fadeTarget` is where the land sits between valley
 * (-1) and peak (+1): where an octave finds no slope to carve, the height eases towards that target instead, which is what
 * keeps the valley floors smooth and the peaks pointed. Writes into and returns `out`.
 */
export function erosionFilter(px: number, py: number, h: number, sx: number, sy: number, fadeTargetIn: number, params: ErosionParams, out: ErosionResult): ErosionResult {
  const p = params;
  let strength = p.strength * p.scale, fadeTarget = Math.min(1, Math.max(-1, fadeTargetIn));
  let hh = h, hx = sx, hy = sy;
  let freq = 1 / (p.scale * p.cellScale), magnitude = 0, roundingMult = 1;
  const slopeLength = Math.max(1e-10, Math.hypot(sx, sy));
  const roundingForInput = mix(p.rounding[1], p.rounding[0], clamp01(fadeTarget + .5)) * p.rounding[2];
  let combiMask = easeOut(smoothStart(slopeLength * p.onset[0], roundingForInput * p.onset[0]));
  let ridgeMask = easeOut(slopeLength * p.onset[2]), ridgeTarget = fadeTarget;
  // The first octave's gullies run down the input slope, at an assumed steepness (the real one would make them vanish on gentle land).
  let gsx = mix(sx, sx / slopeLength * p.assumedSlope[0], p.assumedSlope[1]), gsy = mix(sy, sy / slopeLength * p.assumedSlope[0], p.assumedSlope[1]);
  for (let o = 0; o < p.octaves; o++) {
    const gl = Math.hypot(gsx, gsy), nx = gl > 1e-10 ? gsx / gl : gsx, ny = gl > 1e-10 ? gsy / gl : gsy;
    phacelle(px * freq, py * freq, nx, ny, p.cellScale, .25, p.normalization, ph);
    const zx = ph[2] * -freq, zy = ph[3] * -freq, sloping = Math.abs(ph[1]);
    // The next octave's gullies follow the slope this one carved: finer gullies run into bigger ones, and branch.
    const sign = ph[1] > 0 ? 1 : ph[1] < 0 ? -1 : 0;
    gsx += sign * zx * strength * p.gullyWeight; gsy += sign * zy * strength * p.gullyWeight;
    const oh = ph[0] * p.gullyWeight, ox = ph[1] * zx * p.gullyWeight, oy = ph[1] * zy * p.gullyWeight;
    const fh = mix(fadeTarget, oh, combiMask), fx = ox * combiMask, fy = oy * combiMask;
    hh += fh * strength; hx += fx * strength; hy += fy * strength;
    magnitude += strength;
    fadeTarget = fh;
    const roundingForOctave = mix(p.rounding[1], p.rounding[0], clamp01(ph[0] + .5)) * roundingMult;
    const newMask = easeOut(smoothStart(sloping * p.onset[1], roundingForOctave * p.onset[1]));
    combiMask = powInv(combiMask, p.detail) * newMask;
    ridgeTarget = mix(ridgeTarget, ph[0], ridgeMask);
    ridgeMask *= easeOut(sloping * p.onset[3]);
    strength *= p.gain; freq *= p.lacunarity; roundingMult *= p.rounding[3];
  }
  out.height = hh - h; out.slopeX = hx - sx; out.slopeY = hy - sy; out.magnitude = magnitude;
  out.ridge = ridgeTarget * (1 - ridgeMask);
  return out;
}
