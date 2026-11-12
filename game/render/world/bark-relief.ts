import * as THREE from 'three';

/**
 * Relief on bark (varyDirectionalTexture in texture-variation.ts): the scan's height map, packed by tools/assets/trees/pack.py
 * (high-passed, black = deepest bark, white = the top of the relief), read three ways.
 *  - Parallax occlusion: the view ray is marched down into the relief, so fissures hide what lies behind their lips as the
 *    eye moves and the colour, normal and roughness are all read where the ray meets the surface.
 *  - Self-shadows of the directional light (the sun): a ridge between the point and the sun that stands above the beam shades it.
 *    Only directional lights ask; the torch and the lamps are not the sun and are left as lit.
 *  - Cavity: indirect light (sky, bounce) reaches the bottoms of the fissures less than the lips, which is what keeps bark
 *    under the canopy from reading as a smooth painted tube.
 * `depth` is in metres, between the map's black and white: about 2-3 cm for deep oak and pine fissures, less for birch.
 */
export interface BarkRelief { height: THREE.Texture; depth: number; /** 0..1, default .85 */ shadow?: number; /** 0..1, default 1 */ cavity?: number }

/** The view distance (m) over which the relief fades out: by 14 m a fissure is under a pixel and the baked occlusion carries it. */
export const BARK_RELIEF_NEAR = 8, BARK_RELIEF_FAR = 14;
/** Steps of the view-ray march, plus one refinement between the last two: all of them up close, fewer from the second distance. */
export const BARK_RELIEF_STEPS = 10, BARK_RELIEF_FAR_STEPS = 5, BARK_RELIEF_STEPS_FADE = [2, 7];

type V3 = readonly [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * CPU twin of the shader's barkPlaneUv (pinned by tests/render/world/bark-relief.test.mjs): the change of uv for a displacement
 * `s` from a surface point, given the screen-space derivatives of position (`dp1`, `dp2`, metres) and uv (`duv1`, `duv2`) and the
 * surface normal `n`. `s` is split as a dp1 + b dp2 + c n (Cramer's rule), and the uv change is a duv1 + b duv2: a displacement
 * along the normal drops out, and the answer is in uv per metre however the instance has been scaled, so a trunk stretched
 * three times taller shows the same relief depth in metres. Zero when the derivatives are degenerate (an edge-on pixel).
 */
export function planeToUv(dp1: V3, dp2: V3, n: V3, duv1: readonly [number, number], duv2: readonly [number, number], s: V3): [number, number] {
  const c2 = cross(dp2, n), c1 = cross(n, dp1), det = dot(dp1, c2);
  if (Math.abs(det) < 1e-14) return [0, 0];
  const a = dot(s, c2) / det, b = dot(s, c1) / det;
  return [duv1[0] * a + duv2[0] * b, duv1[1] * a + duv2[1] * b];
}

/**
 * CPU twin of the view-ray march: down into a height field `height(shift)` (0 deepest .. 1 top, read at the uv shift from the
 * pixel's own uv) while the ray moves `perDepth` uv over the whole relief depth. The relief is a slab centred on the mesh surface
 * (mid grey is the surface itself: the ray enters its top, half a depth above, and what stands higher than mid grey leans out
 * toward the eye), so the march starts at -perDepth/2 and a flat mid-grey bark never moves as the eye does. Returns the depth
 * fraction where the ray meets the relief (0 when the top is already hit), the uv shift there, and the height there, found by
 * crossing the last two steps' lines as the shader does.
 */
export function marchRelief(height: (shift: [number, number]) => number, perDepth: readonly [number, number], steps = BARK_RELIEF_STEPS) {
  const step: [number, number] = [perDepth[0] / steps, perDepth[1] / steps], shift: [number, number] = [-perDepth[0] / 2, -perDepth[1] / 2];
  let depth = 0, h = height(shift), lastH = h, lastDepth = 0;
  for (let i = 0; i < steps; i++) {
    if (1 - h <= depth) break;
    lastH = h; lastDepth = depth; shift[0] += step[0]; shift[1] += step[1]; depth += 1 / steps;
    h = height(shift);
  }
  if (depth <= 0) return { depth: 0, shift, height: h };
  const below = depth - (1 - h), above = 1 - lastH - lastDepth, t = above / Math.max(above + below, 1e-4);
  return { depth: depth - (1 - t) / steps, shift: [shift[0] - step[0] * (1 - t), shift[1] - step[1] * (1 - t)] as [number, number], height: lastH + (h - lastH) * t };
}

/** How much of the relief shows at this distance and angle: 1 up close and face on, 0 beyond 14 m or edge on (where one step would be a hand wide). */
export function barkReach(distance: number, facing: number) {
  const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return (1 - ss(BARK_RELIEF_NEAR, BARK_RELIEF_FAR, distance)) * ss(.1, .3, facing);
}

/**
 * Shader side. The globals are set once in the map_fragment replacement (barkReliefBegin) and read by barkReliefShade (called per
 * directional light) and the cavity term after the lights. Marching is in uv of the unrotated base coordinates; the dominant
 * texture patch is read at (tap uv + rotated shift), and the same shift, rotated, is added to all three patches afterwards.
 */
export const barkReliefGLSL = `
  uniform sampler2D uBarkHeight;
  uniform vec3 uBarkRelief;   // depth in metres, self-shadow strength, cavity strength
  uniform float uBarkOn,uBarkLod;
  vec3 barkDp1,barkDp2,barkN;vec2 barkDuv1,barkDuv2,barkTap,barkTurn,barkGx,barkGy;
  float barkReach=0.,barkH=.5,barkCavity=1.;
  // Twin of planeToUv in bark-relief.ts.
  vec2 barkPlaneUv(vec3 s){
    vec3 c2=cross(barkDp2,barkN),c1=cross(barkN,barkDp1);
    float det=dot(barkDp1,c2);
    if(abs(det)<1e-14)return vec2(0.);
    return (barkDuv1*dot(s,c2)+barkDuv2*dot(s,c1))/det;
  }
  // The sunlit share of this point: the relief between it and the light, as the ground's relief shadows (terrain.ts). L points to the light, in view space.
  float barkReliefShade(vec3 L){
    float facing=dot(barkN,L);
    if(barkReach<=.01||uBarkRelief.y<=0.||facing<=.03)return 1.;
    float depth=uBarkRelief.x;
    vec2 perClimb=barkPlaneUv(L/max(facing,.12));   // uv a ray toward the light moves per metre it climbs
    float blocked=0.;
    for(int i=1;i<=6;i++){
      float climb=depth*float(i*i)/40.;   // 2.5 % to 90 % of the relief depth, closer steps near the point
      float hs=textureGrad(uBarkHeight,barkTap+patchRotate(perClimb*climb,barkTurn),barkGx,barkGy).r;
      blocked=max(blocked,(hs-barkH)*depth-climb);
    }
    return 1.-barkReach*uBarkRelief.y*smoothstep(0.,depth*.25,blocked);
  }
`;

/** Placed after the grain patch is made: marches the view ray and moves the three patches to where it meets the relief. */
export const barkReliefBegin = `
  #ifdef BARK_RELIEF
  {
    barkDp1=-dFdx(vViewPosition);barkDp2=-dFdy(vViewPosition);barkDuv1=grainPatch.dx;barkDuv2=grainPatch.dy;
    barkN=normalize(vNormal);
    #ifdef DOUBLE_SIDED
      barkN*=gl_FrontFacing?1.:-1.;
    #endif
    vec3 barkV=normalize(vViewPosition);
    float barkFacing=dot(barkN,barkV);
    barkReach=uBarkOn*(1.-smoothstep(${BARK_RELIEF_NEAR}.,${BARK_RELIEF_FAR}.,length(vViewPosition)))*smoothstep(.1,.3,barkFacing);
    barkTap=grainPatch.a;barkTurn=grainPatch.ra;
    if(grainPatch.w.y>grainPatch.w.x&&grainPatch.w.y>=grainPatch.w.z){barkTap=grainPatch.b;barkTurn=grainPatch.rb;}
    else if(grainPatch.w.z>grainPatch.w.x&&grainPatch.w.z>grainPatch.w.y){barkTap=grainPatch.c;barkTurn=grainPatch.rc;}
    // Only the strongest patch is marched, so where two patches share a point (the thin seams of the blend) the relief fades to nothing:
    // there the marched patch would change from one side of the seam to the other and tear the picture along it.
    barkReach*=smoothstep(.45,.8,max(grainPatch.w.x,max(grainPatch.w.y,grainPatch.w.z)));
    barkGx=patchRotate(grainPatch.dx,barkTurn);barkGy=patchRotate(grainPatch.dy,barkTurn);
    if(barkReach>.01){
      // The ray's uv travel over the whole relief depth, then equal steps down into the height field: ${BARK_RELIEF_STEPS} of them up
      // close, ${BARK_RELIEF_FAR_STEPS} from ${BARK_RELIEF_STEPS_FADE[1]} m (where the relief is a few pixels deep, uBarkLod: perfOn('barkReliefSteps')).
      // The relief is a slab centred on the mesh (mid grey is the surface itself): the ray enters its top, half a depth up the ray.
      float steps=mix(${BARK_RELIEF_STEPS}.,uBarkLod>0.?${BARK_RELIEF_FAR_STEPS}.:${BARK_RELIEF_STEPS}.,smoothstep(${BARK_RELIEF_STEPS_FADE[0]}.,${BARK_RELIEF_STEPS_FADE[1]}.,length(vViewPosition))),stepDepth=1./steps;
      vec2 perDepth=barkPlaneUv(-barkV/max(barkFacing,.2))*uBarkRelief.x,stepUv=perDepth*stepDepth,shift=-.5*perDepth;
      float h=textureGrad(uBarkHeight,barkTap+patchRotate(shift,barkTurn),barkGx,barkGy).r,lastH=h,depth=0.,lastDepth=0.;
      for(int i=0;i<${BARK_RELIEF_STEPS};i++){
        if(1.-h<=depth||float(i)>=steps)break;
        lastH=h;lastDepth=depth;shift+=stepUv;depth+=stepDepth;
        h=textureGrad(uBarkHeight,barkTap+patchRotate(shift,barkTurn),barkGx,barkGy).r;
      }
      // Where the ray's line crosses the surface's, between the last step above the relief and the first below it.
      float below=depth-(1.-h),above=1.-lastH-lastDepth,t=above/max(above+below,1e-4);
      vec2 hit=depth>0.?shift-stepUv*(1.-t):shift;
      barkH=depth>0.?mix(lastH,h,t):h;
      vec2 move=hit*barkReach;
      grainPatch.a+=patchRotate(move,grainPatch.ra);grainPatch.b+=patchRotate(move,grainPatch.rb);grainPatch.c+=patchRotate(move,grainPatch.rc);
      barkTap+=patchRotate(move,barkTurn);
      // Cavity from how far this point lies below its surroundings: the height map read blurred (two mip levels coarser, a
      // gradient 5 and 20 times wider) minus the height here. A pit or a fissure floor is lower than the average round it, a
      // ridge or a plate's lip higher: the pits keep the sky out, the lips catch more of it.
      if(uBarkRelief.z>0.){
        vec2 below2=vec2(textureGrad(uBarkHeight,barkTap,barkGx*5.,barkGy*5.).r,textureGrad(uBarkHeight,barkTap,barkGx*20.,barkGy*20.).r)-barkH;
        float pit=clamp(max(below2.x,0.)*4.+max(below2.y,0.)*3.,0.,1.),lip=clamp(max(-below2.x,0.)*3.+max(-below2.y,0.)*2.,0.,1.);
        barkCavity=1.-.85*pit+.25*lip;
      }
    }
  }
  #endif
`;

/** Placed after the lights: crevices keep the sky and bounce light out (barkCavity: .15 at the bottom of a deep pit, 1 on open bark, 1.25 on a ridge). */
export const barkReliefCavity = `
  #ifdef BARK_RELIEF
  {
    float cavity=mix(1.,barkCavity,barkReach*uBarkRelief.z);
    reflectedLight.indirectDiffuse*=cavity;reflectedLight.indirectSpecular*=cavity;
  }
  #endif
`;

/**
 * The lights chunk with the relief's shade put on each directional light (the sun) after its shadow map is read, so a trunk in the
 * canopy's shade (light already zero) never marches, and from the light's own direction: a torch or a lamp is a spot light and is
 * not touched, so night light is left as it was. Unchanged when the chunk is worded differently (a different three.js release).
 */
export function shadeDirectionalLights(chunk: string) {
  const info = chunk.indexOf('getDirectionalLightInfo( directionalLight, directLight );'), call = info < 0 ? -1 : chunk.indexOf('RE_Direct(', info);
  if (call < 0) return chunk;
  const line = chunk.lastIndexOf('\n', call) + 1;
  return `${chunk.slice(0, line)}\t\tif ( dot( directLight.color, vec3( 1.0 ) ) > 0.0 ) directLight.color *= barkReliefShade( directLight.direction );\n${chunk.slice(line)}`;
}
