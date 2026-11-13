/**
 * Terrain shadows and sky occlusion for ground beyond the sun's shadow map (the island's range from afar, the far range): for
 * each vertex, how high the land's horizon stands in eight directions. A shader compares the sun's height with the horizon
 * towards it (interpolated between the two nearest directions), so ridges throw real shadows into the gullies and across the
 * faces as the sun moves, and the mean of the eight is how much of the sky the vertex sees. Without them the mountains were lit
 * as if every face stood alone: flat, with no shaded gully and no cast shadow, the opposite of a sunlit range.
 *
 * Encoding: sin(horizon elevation), 0..1 (below the vertex's own level counts as 0), as unsigned bytes, directions k * 45
 * degrees from +x towards +z, k = 0..7: four in `horizonA`, four in `horizonB`.
 */
const DIRECTIONS = Array.from({ length: 8 }, (_, k) => [Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)] as const);

/**
 * Horizons for points at (x, y, z) given a height lookup. `reach` is the farthest distance looked along each direction; samples
 * are spaced in a growing series (near ridges matter most and are sampled finest).
 */
export function horizonAngles(positions: ArrayLike<number>, count: number, heightAt: (x: number, z: number) => number, step: number, reach: number) {
  const out = new Uint8Array(count * 8), distances: number[] = [];
  for (let d = step; d <= reach; d = Math.max(d + step, d * 1.3)) distances.push(d);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    for (let k = 0; k < 8; k++) {
      const [dx, dz] = DIRECTIONS[k];
      let best = 0;
      for (const d of distances) { const t = (heightAt(x + dx * d, z + dz * d) - y) / d; if (t > best) best = t; }
      out[i * 8 + k] = Math.round(best / Math.sqrt(1 + best * best) * 255);
    }
  }
  return out;
}

/** A bilinear lookup over a square grid of heights, `n` x `n`, `step` apart, its first sample at (x0, z0); clamped at the edge. */
export function gridHeights(heights: Float32Array, n: number, step: number, x0: number, z0: number) {
  return (x: number, z: number) => {
    const fx = Math.min(n - 1.001, Math.max(0, (x - x0) / step)), fz = Math.min(n - 1.001, Math.max(0, (z - z0) / step));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * n + i;
    return heights[k] * (1 - u) * (1 - v) + heights[k + 1] * u * (1 - v) + heights[k + n] * (1 - u) * v + heights[k + n + 1] * u * v;
  };
}

/** The GLSL half: `horizonShadow(sunDirection)` and `horizonSky()`, given the two varyings. */
export const horizonGLSL = `
  varying vec4 vHorizonA,vHorizonB;
  float horizonAt(float k){
    k=mod(k,8.);
    return k<.5?vHorizonA.x:k<1.5?vHorizonA.y:k<2.5?vHorizonA.z:k<3.5?vHorizonA.w:k<4.5?vHorizonB.x:k<5.5?vHorizonB.y:k<6.5?vHorizonB.z:vHorizonB.w;
  }
  // 1 in sun, 0 behind the land's horizon towards it; a soft edge of about two degrees (the sun's disc and the grid's coarseness).
  float horizonShadow(vec3 sun){
    float k=mod(atan(sun.z,sun.x)/.785398+8.,8.),i=floor(k);
    float h=mix(horizonAt(i),horizonAt(i+1.),k-i);
    return smoothstep(h-.035,h+.035,sun.y);
  }
  // How much of the sky the point sees: 1 on a crest, about .6 deep in a gully.
  float horizonSky(){
    float m=dot(vHorizonA,vec4(.125))+dot(vHorizonB,vec4(.125));
    return clamp(1.-m*1.1,.25,1.);
  }
`;
