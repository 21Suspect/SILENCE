import { noise, type BiomeWeights } from './world';

/**
 * Which plant community holds a piece of floor, at the largest scale (patches 25 to 40 m across): fern brake, damp herb
 * patch (celandine and tall herbs), shrub thicket, grassy gap, or open moss. Each is a value-noise field; raising them to
 * the third power and normalising lets one dominate where it is strongest, with a few metres of mixed ground where two
 * meet. ecology.ts multiplies its finer niches by these weights, so the floor varies over tens of metres as well as metres.
 */
export type Community = { fern: number; herb: number; shrub: number; grass: number; moss: number };

export function communityAt(x: number, z: number, b: BiomeWeights): Community {
  const f = noise(x * .031 + 17, z * .031 - 4) ** 3 * (1 - b.heath * .7);
  const h = noise(x * .037 - 9, z * .037 + 23) ** 3 * (1 - b.heath * .4);
  const s = noise(x * .027 + 41, z * .027 + 7) ** 3 * (1 + b.grove * 1.5);
  const g = noise(x * .025 - 33, z * .025 - 18) ** 3 * (1 + b.heath * 2 + (1 - b.forest) * .5);
  const m = .03;
  const sum = f + h + s + g + m;
  return { fern: f / sum, herb: h / sum, shrub: s / sum, grass: g / sum, moss: m / sum };
}
