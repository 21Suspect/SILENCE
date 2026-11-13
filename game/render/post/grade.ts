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
  // The eye rests at 5.8, where it settles looking level into the wood at noon (5.2 at the sky, 7.1 at the floor before).
  // Out of the wood onto the open beach the view is 3 to 4 times brighter: past a stop the eye follows it by .85 (bright), down to
  // 2.5 stops, so the sand keeps its colour instead of burning white.
  key: .11, minExposure: .4, maxExposure: 9, anchor: 5.8, response: .4, bright: .85, close: 2.5, open: 1.25, bias: 0, temperature: .1, tint: 0, saturation: .98, contrast: 1.1,
  shadows: [.99, 1, 1], highlights: [1.03, 1, .96], scotopic: 0, vignette: .1, grain: 0, bloom: .04,
};
export const GOLDEN: Key = {
  key: .19, minExposure: .4, maxExposure: 14, anchor: 10, response: .4, bright: .7, close: 1.75, open: 1.25, bias: 0, temperature: .35, tint: -.12, saturation: 1, contrast: 1.08,
  shadows: [.99, .99, 1], highlights: [1.06, .99, .92], scotopic: 0, vignette: .12, grain: 0, bloom: .06,
};
export const NIGHT: Key = {
  // The cap on exposure is how much the eye may open in the dark: it decides how readable a moonlit wood is without the torch.
  // At night the meter wants far more than the cap (a moonlit wood meters about 2^-13), so the eye rests at the cap. A lamp seen
  // from the road no longer moves it at all (it closed by nearly two stops under one); only the torch's own spot filling the view
  // at arm's length closes it, by at most a stop and a quarter, so the ground under it does not burn white.
  // Blue, short of the first night key (white balance -.3, blue shadows, blue rod shift: a night frame 2.7 times bluer than red).
  // Neutral-warm (.86) read plain grey and 1.3 not blue enough; this key with the rod shift gives about 1.8.
  key: .09, minExposure: .4, maxExposure: 90, anchor: 90, response: .35, bright: .35, close: 1.25, open: .5, bias: 0, temperature: -.12, tint: 0, saturation: .9, contrast: 1.06,
  shadows: [.97, .99, 1.06], highlights: [1.02, 1, .97], scotopic: 1, vignette: .18, grain: 0, bloom: .08,
};

function blend(a: Key, b: Key, t: number): Key {
  const mix = (x: number, y: number) => x + (y - x) * t, mix3 = (x: readonly number[], y: readonly number[]) => [mix(x[0], y[0]), mix(x[1], y[1]), mix(x[2], y[2])] as const;
  // Exposure limits blend in log space: from 9 to 260 is a range of stops, not of units.
  const logMix = (x: number, y: number) => Math.exp(Math.log(x) + (Math.log(y) - Math.log(x)) * t);
  return {
    key: mix(a.key, b.key), minExposure: logMix(a.minExposure, b.minExposure), maxExposure: logMix(a.maxExposure, b.maxExposure), bias: mix(a.bias, b.bias),
    anchor: logMix(a.anchor, b.anchor), response: mix(a.response, b.response), bright: mix(a.bright, b.bright), close: mix(a.close, b.close), open: mix(a.open, b.open),
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
