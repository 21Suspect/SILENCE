/**
 * The island's named places, in the words a player reads them: the board's hints ("around the chapel"), the quest HUD, the paper
 * map and the name that shows when you walk into one. One list, so a place is never called two things. Pure: built from the layout.
 *
 * A place covers its clearing and a margin round it (`radius`): far enough that standing where a part lies counts as being there,
 * near enough that two places never claim the same ground (the nearest wins).
 */
import { POI_PLACEMENTS, type PoiPlacement } from './world-layout';

export type Place = {
  /** The placement id it is built on (the relay hut stands for the mast and generator beside it). */
  id: string;
  /** As the board writes it, "the chapel"; `title` starts a line, "The chapel". */
  name: string; title: string;
  x: number; z: number; radius: number;
  /** Places the run sends you to, drawn bold on the map. */
  key?: boolean;
};

/** Placement id: the name, and whether it is one the run is built round. */
const NAMES: Record<string, { name: string; key?: boolean }> = {
  'cabin': { name: 'the cabin', key: true },
  'relay-hut': { name: 'the relay hut', key: true },
  'landing-pad': { name: 'the landing pad', key: true },
  'lookout': { name: 'the lookout' },
  'logging-camp': { name: 'the logging camp' },
  'hunter-camp': { name: 'the camp' },
  'chapel': { name: 'the chapel' },
  'mine': { name: 'the mine' },
  'well': { name: 'the well' },
  'ruin': { name: 'the ruin' },
  'pumphouse': { name: 'the pump house' },
  'shrine': { name: 'the shrine' },
  'graves': { name: 'the graves' },
  'watertower': { name: 'the water tower' },
  'fold': { name: 'the fold' },
  'hide': { name: 'the deer stand' },
  'busstop': { name: 'the bus stop' },
  'road-bridge': { name: 'the road bridge' },
};

/** The asset names objective items carry (`item.poi`), to the placement id of their place. */
const ASSET_PLACE: Record<string, string> = {
  cabin: 'cabin', hut: 'relay-hut', mast: 'relay-hut', generator: 'relay-hut', helipad: 'landing-pad', lookout: 'lookout',
  logstack: 'logging-camp', camp: 'hunter-camp', chapel: 'chapel', mine: 'mine', well: 'well', ruin: 'ruin', pumphouse: 'pumphouse',
  shrine: 'shrine', graves: 'graves', watertower: 'watertower', effigy: 'fold', deerstand: 'hide', busstop: 'busstop', roadbridge: 'road-bridge',
};

const title = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** A place's reach: its levelled pad and falloff, or its footprint, with a margin; never under 20 m (a part lies within a dozen metres of its place). */
function reach(p: PoiPlacement) {
  const pad = p.pad ? p.pad.radius + p.pad.falloff * .6 : 0;
  const foot = p.footprint ? Math.hypot(p.footprint.hx, p.footprint.hz) + 8 : 0;
  return Math.max(20, pad, foot, (p.clearing ?? 0) + 4);
}

export function buildPlaces(placements: readonly PoiPlacement[]): Place[] {
  const out: Place[] = [];
  for (const p of placements) {
    const n = NAMES[p.id];
    if (!n) continue;
    out.push({ id: p.id, name: n.name, title: title(n.name), x: p.x, z: p.z, radius: reach(p), key: n.key });
  }
  return out;
}

export const PLACES: readonly Place[] = buildPlaces(POI_PLACEMENTS);

/** The place (x, z) is in: the nearest whose reach covers it, or undefined out in the woods. */
export function placeAt(x: number, z: number, places: readonly Place[] = PLACES): Place | undefined {
  let best: Place | undefined, bestD = Infinity;
  for (const p of places) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d <= p.radius && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/** A place by its placement id, or by the asset name an objective item carries ('camp', 'effigy'...). */
export function placeOf(idOrAsset: string, places: readonly Place[] = PLACES): Place | undefined {
  return places.find(p => p.id === idOrAsset) ?? places.find(p => p.id === ASSET_PLACE[idOrAsset]);
}
