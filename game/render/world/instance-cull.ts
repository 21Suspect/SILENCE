import { perfOn } from '../../core/perf-flags';

/**
 * Per-instance frustum culling in the vertex shader.
 *
 * The forest and the undergrowth draw from a few large instanced batches. three.js culls a batch whole against the camera,
 * so every tree or grass patch in a batch that is partly in view is still transformed, lit and rasterised off screen, and
 * the undergrowth (one ring of batches round the player) is never culled at all. Here each instance tests its own bounds
 * (a vertical segment, swept by a radius, in model units of the instance) against the frustum of the camera drawing it,
 * and when it is wholly outside, every one of its vertices leaves at once: no lighting, no shadow coordinates, no triangles
 * to bin. No extra draw calls, and right in every pass (view, reflection, sun and torch shadows), because each pass uses its
 * own camera matrices.
 *
 * The plane test: for a perspective camera, a view-space point's distance outside the right plane is
 * (clip.x - clip.w) / sqrt(P00^2 + 1), and likewise for the others. For an orthographic camera (the sun's shadow) the true
 * margin is r P00, smaller than r sqrt(P00^2 + 1), so the test only ever keeps a little more than it must, never less.
 */
/** 1 culls, 0 does not: a uniform, so the cull can be switched and measured without a recompile. */
export const instanceCullSwitch = { value: perfOn('instanceCull') ? 1 : 0 };

export const INSTANCE_CULL_HEADER = 'uniform float uInstanceCull;';

/** GLSL for the top of an instanced vertex `main()`: returns when the instance's segment (0, bottom, 0) to (0, top, 0), swept by
 * `radius` times its horizontal scale, is wholly outside one plane of the view frustum or behind the camera. */
export function instanceCullGLSL(bottom: number, top: number, radius: number) {
  const f = (x: number) => x.toFixed(3);
  return `
    #ifdef USE_INSTANCING
    if(uInstanceCull>.5){
      // The segment's ends in clip space: the clip map is linear, so the top is the base plus the instance's up axis.
      vec4 cullBase=projectionMatrix*(viewMatrix*(modelMatrix*vec4(instanceMatrix[3].xyz,1.)));
      vec4 cullAxis=projectionMatrix*(viewMatrix*(modelMatrix*vec4(instanceMatrix[1].xyz,0.)));
      vec4 cullLo=cullBase+cullAxis*${f(bottom)},cullHi=cullBase+cullAxis*${f(top)};
      float cullReach=${f(radius)}*length(instanceMatrix[0].xyz);
      float cullX=cullReach*sqrt(projectionMatrix[0][0]*projectionMatrix[0][0]+1.),cullY=cullReach*sqrt(projectionMatrix[1][1]*projectionMatrix[1][1]+1.);
      if((cullLo.x-cullLo.w>cullX&&cullHi.x-cullHi.w>cullX)||(-cullLo.x-cullLo.w>cullX&&-cullHi.x-cullHi.w>cullX)
        ||(cullLo.y-cullLo.w>cullY&&cullHi.y-cullHi.w>cullY)||(-cullLo.y-cullLo.w>cullY&&-cullHi.y-cullHi.w>cullY)
        ||(cullLo.w<-cullReach&&cullHi.w<-cullReach)){gl_Position=vec4(2.,2.,2.,1.);return;}
    }
    #endif`;
}

/** The same test in JavaScript, for tests: true when the segment is wholly outside. `clip` maps a world point to clip space. */
export function instanceCulled(clip: (x: number, y: number, z: number) => [number, number, number, number], base: [number, number, number], bottom: number, top: number, reach: number, p00: number, p11: number) {
  const lo = clip(base[0], base[1] + bottom, base[2]), hi = clip(base[0], base[1] + top, base[2]);
  const mx = reach * Math.sqrt(p00 * p00 + 1), my = reach * Math.sqrt(p11 * p11 + 1);
  const out = (f: (c: [number, number, number, number]) => number, m: number) => f(lo) > m && f(hi) > m;
  return out(c => c[0] - c[3], mx) || out(c => -c[0] - c[3], mx) || out(c => c[1] - c[3], my) || out(c => -c[1] - c[3], my) || (lo[3] < -reach && hi[3] < -reach);
}
