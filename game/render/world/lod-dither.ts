/**
 * The one dither every level-of-detail hand-over uses, so that two levels of the same thing are complementary: the level fading
 * out keeps the pixels whose value is under its weight, the level fading in exactly the others, and mid-way every pixel shows
 * one of them, never both or neither (Unity's LOD dither and SpeedTree's cross-fade do the same). It has to be in screen space:
 * a streamed tree and its impostor share no surface on which an object-space hash could agree. The pattern is interleaved
 * gradient noise (Jimenez 2014), the one the fog and ambient occlusion already jitter with.
 *
 * `lodFadeDiscard(fadeIn, fadeOut)`: true where the fragment is dissolved; fadeIn rises 0 to 1 as a level comes in, fadeOut falls
 * 1 to 0 as it goes; 1 and 1 keep everything.
 */
export const lodDitherGLSL = `
  float lodDither(){return fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715))));}
  bool lodFadeDiscard(float fadeIn,float fadeOut){float h=lodDither();return h>=fadeOut||h<1.-fadeIn;}`;
