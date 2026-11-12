/**
 * The numbers behind screen-space ambient occlusion, kept free of three.js so they can be tested. The GLSL in
 * ambient-occlusion.ts and the resolve shader in atmosphere.ts repeat these formulas; the tests pin the CPU twins.
 */

/** What each setting level (0 off, 1 medium, 2 high) costs and buys. Slices are the directions per pixel, steps the samples per side of a slice. */
export const aoQuality = (level: number) => level >= 2 ? { on: true, slices: 3, steps: 8, scale: .5 } : level === 1 ? { on: true, slices: 2, steps: 5, scale: .5 } : { on: false, slices: 0, steps: 0, scale: .5 };

/** World radius of the occlusion in metres. Under a metre only the tightest creases show; over two it greys whole trunks. */
export const AO_RADIUS = .8;
/** Largest darkening AO may apply. Under 1 because bounce light fills creases. Grass cards are thin but count as solid in the depth, so
 * at 1 whole clumps went black at noon (view -52,47 yaw 2.4); .7 keeps ferns and clumps grounded without losing the sun-shadow pattern. */
export const AO_STRENGTH = .7;
/** Past FADE_NEAR metres the effect thins out, gone at FADE_FAR: distant trunks and the horizon are fog's business, and the screen radius there is a pixel or two. */
export const AO_FADE_NEAR = 18, AO_FADE_FAR = 48;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Distance falloff of the whole effect (1 near, 0 far). */
export const aoDistanceFade = (viewDistance: number) => 1 - smooth(AO_FADE_NEAR, AO_FADE_FAR, viewDistance);

/**
 * How much of a pixel's light is direct sun, 0..1: the sun's level, whether the shadow map sees it, and the cosine of the surface to the sun.
 * Occlusion belongs only to the ambient part, which cannot be separated from the finished colour. So the strength is lowered in step with
 * this fraction, but not to zero: the sun shadow map is 4096 texels over a long range and misses every contact crease and leaf gap, so a
 * little occlusion on lit surfaces stands in for the shadow that is not there. SUNLIT_KEEP is what stays at full sun (chosen by eye at noon:
 * .5 washed out the sun/shadow stripes on the ground under grass, 0 left sunlit trunk bases flat).
 */
export const SUNLIT_KEEP = .25;
export const sunFraction = (sunLevel: number, shadowLit: number, cosine: number) => Math.min(1, Math.max(0, sunLevel)) * Math.min(1, Math.max(0, shadowLit)) * Math.min(1, Math.max(0, cosine));
export const aoWeight = (sunFrac: number) => 1 - (1 - SUNLIT_KEEP) * sunFrac;

/** Final multiplier on the HDR colour from the raw visibility (1 open, 0 closed). */
export const aoMultiplier = (visibility: number, sunFrac: number, distanceFade: number) => 1 - AO_STRENGTH * aoWeight(sunFrac) * distanceFade * (1 - Math.min(1, Math.max(0, visibility)));
