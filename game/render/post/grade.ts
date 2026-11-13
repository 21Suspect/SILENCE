import * as THREE from 'three';
import type { Grade } from './final-image';

/**
 * The look of each time of day, as numbers: the exposure the eye aims for and the range it may use, white balance, saturation,
 * contrast, split toning, the night grade, vignette, grain and bloom. Three keys (noon, the golden hour either side of sunset,
 * and night) blended by the sun's elevation (the sine of its angle above the horizon). Pure, so it can be tested and tuned.
 */
type Key = Omit<Grade, 'shadows' | 'highlights'> & { shadows: readonly [number, number, number]; highlights: readonly [number, number, number] };

export const NOON: Key = {
  // Sun flecks on the forest floor are the brightest thing a forest view meters on; at .15 a sunlit floor (albedo about .12)
  // came out near white and the tone curve bleached its colour away. At .11 the moss and needles keep their colour.
  // Neutral to a touch warm: the cool shadow tint and the near-zero white balance read as a cold blue forest.
  key: .11, minExposure: .4, maxExposure: 9, bias: 0, temperature: .1, tint: 0, saturation: .98, contrast: 1.1,
  shadows: [.99, 1, 1], highlights: [1.03, 1, .96], scotopic: 0, vignette: .1, grain: 0, bloom: .04,
};
export const GOLDEN: Key = {
  key: .19, minExposure: .4, maxExposure: 14, bias: 0, temperature: .35, tint: -.12, saturation: 1, contrast: 1.08,
  shadows: [.93, .97, 1.08], highlights: [1.06, .99, .92], scotopic: 0, vignette: .12, grain: 0, bloom: .06,
};
export const NIGHT: Key = {
  // The cap on exposure is how much the eye may open in the dark: it decides how readable a moonlit wood is without the torch.
  key: .09, minExposure: .4, maxExposure: 90, bias: 0, temperature: -.3, tint: -.06, saturation: .9, contrast: 1.06,
  shadows: [.9, .97, 1.12], highlights: [1.02, 1, .97], scotopic: 1, vignette: .18, grain: 0, bloom: .08,
};

function blend(a: Key, b: Key, t: number): Key {
  const mix = (x: number, y: number) => x + (y - x) * t, mix3 = (x: readonly number[], y: readonly number[]) => [mix(x[0], y[0]), mix(x[1], y[1]), mix(x[2], y[2])] as const;
  // Exposure limits blend in log space: from 9 to 260 is a range of stops, not of units.
  const logMix = (x: number, y: number) => Math.exp(Math.log(x) + (Math.log(y) - Math.log(x)) * t);
  return {
    key: mix(a.key, b.key), minExposure: logMix(a.minExposure, b.minExposure), maxExposure: logMix(a.maxExposure, b.maxExposure), bias: mix(a.bias, b.bias),
    temperature: mix(a.temperature, b.temperature), tint: mix(a.tint, b.tint), saturation: mix(a.saturation, b.saturation), contrast: mix(a.contrast, b.contrast),
    shadows: mix3(a.shadows, b.shadows), highlights: mix3(a.highlights, b.highlights), scotopic: mix(a.scotopic, b.scotopic),
    vignette: mix(a.vignette, b.vignette), grain: mix(a.grain, b.grain), bloom: mix(a.bloom, b.bloom),
  };
}

const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** The key for a sun elevation (sine): night below -0.12, golden hour round 0.05, noon above 0.35. */
export function gradeKey(elevation: number): Key {
  if (elevation <= .05) return blend(NIGHT, GOLDEN, smooth(elevation, -.12, .05));
  return blend(GOLDEN, NOON, smooth(elevation, .05, .35));
}

export function gradeFor(elevation: number, out?: Grade): Grade {
  const k = gradeKey(elevation), g = out ?? { ...k, shadows: new THREE.Color(), highlights: new THREE.Color() } as Grade;
  Object.assign(g, { ...k, shadows: g.shadows, highlights: g.highlights });
  g.shadows.setRGB(k.shadows[0], k.shadows[1], k.shadows[2]); g.highlights.setRGB(k.highlights[0], k.highlights[1], k.highlights[2]);
  return g;
}

/**
 * How thick the ground mist is: thickest from dusk to after dawn, thinning to about half when the sun is high and has
 * warmed the air, so a bright day shows its distance (the lake, the ridges) and the night closes in.
 */
export const fogDensityFor = (elevation: number) => 1 - .5 * smooth(elevation, .08, .55);
