import { vegetationExclusion } from './world';
import { treeDensity, smooth } from './world-noise';
import { coastDistance, lakeOutline } from './coastal-geography';

/** The mist map covers the island, MIST_EXTENT metres each way from the middle, in MIST_CELLS x MIST_CELLS cells (8 m). */
export const MIST_EXTENT = 768, MIST_CELLS = 192;
/** Mist over open land and over water, as a share of the mist in a thick wood. */
export const MIST_OPEN = .28, MIST_WATER = .08;

/**
 * How thick the ground mist lies, 0..1 per cell: it is a forest's mist, the damp air under the crowns. In a thick wood it is
 * all there; over beaches, meadows and roads it thins to MIST_OPEN, over the lake and the sea to MIST_WATER. A uniform mist
 * laid the same grey band over the open water and the beaches as over the wood, and washed out every view from the island's edge.
 * The map is blurred over three cells (24 m) so the mist drifts a little way out of a wood rather than stopping at its edge.
 */
export function mistCover(cells = MIST_CELLS, extent = MIST_EXTENT): Float32Array {
  const raw = new Float32Array(cells * cells), cell = extent * 2 / cells;
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const x = -extent + (i + .5) * cell, z = -extent + (j + .5) * cell;
    const water = coastDistance(x, z) < 0 || lakeOutline(x, z) < 0;
    const wood = smooth(treeDensity(x, z), .3, .7) * (1 - smooth(vegetationExclusion(x, z), .22, .5));
    const base = water ? MIST_WATER : MIST_OPEN;
    raw[j * cells + i] = base + (1 - base) * (water ? 0 : wood);
  }
  const out = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    let sum = 0, n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = Math.min(cells - 1, Math.max(0, i + di)), b = Math.min(cells - 1, Math.max(0, j + dj));
      sum += raw[b * cells + a]; n++;
    }
    out[j * cells + i] = sum / n;
  }
  return out;
}
