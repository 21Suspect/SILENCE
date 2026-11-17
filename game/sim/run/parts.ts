/**
 * Where the helicopter's parts lie this run, laid out by the seed (docs/game-design.md, "The whole island, and getting across
 * it"). Pure and deterministic: the same places, lair and seed always give the same layout, and a different seed a different one.
 *
 * Seven parts: for the call, a can of fuel and three fuses (carried to the relay hut); for the pad, bulbs, a cable and a can of
 * fuel for its lights. The rules, which every layout meets whenever the island offers the places to meet them:
 *   - they come from at least three different quarters of the island (north-east, north-west, south-west, south-east of its centre),
 *   - one lies in the lair,
 *   - no place holds more than two,
 *   - a part goes on a prop's hook when the prop has one for it ('fuse' on the mine, lookout, logging camp, chapel and deer stand;
 *     'jerrycan' on the camp), and otherwise on the ground by the place's door.
 * Hooks are weighted, not forced: a layout of nothing but hooked places would be the same hunt every run.
 */
import worldAssets from '../../data/world-assets.json';
import type { Item, ItemKind } from '../objectives/objectives';

export type PartId = 'call-fuel' | 'call-fuse-1' | 'call-fuse-2' | 'call-fuse-3' | 'pad-bulbs' | 'pad-cable' | 'pad-fuel';
export type PartGroup = 'call' | 'pad';
export const PARTS: readonly { id: PartId; kind: ItemKind; group: PartGroup }[] = [
  { id: 'call-fuel', kind: 'jerry', group: 'call' },
  { id: 'call-fuse-1', kind: 'fuse', group: 'call' },
  { id: 'call-fuse-2', kind: 'fuse', group: 'call' },
  { id: 'call-fuse-3', kind: 'fuse', group: 'call' },
  { id: 'pad-bulbs', kind: 'bulbs', group: 'pad' },
  { id: 'pad-cable', kind: 'cable', group: 'pad' },
  { id: 'pad-fuel', kind: 'jerry', group: 'pad' },
];

/** The prop hook each kind of part sits on, where the prop has one (game/data/world-assets.json). Bulbs and a cable have none. */
export const HOOK_OF: Partial<Record<ItemKind, string>> = { fuse: 'fuse', jerry: 'jerrycan' };
/** The places a part may lie at: where things are found. Not the cabin, the relay, the bus stop, the tunnels or the notice board. */
export const PART_SITES: readonly string[] = ['camp', 'chapel', 'mine', 'lookout', 'logstack', 'deerstand', 'well', 'ruin', 'pumphouse', 'shrine', 'graves', 'effigy', 'watertower'];

export type Quarter = 'NE' | 'NW' | 'SW' | 'SE';
/**
 * The island's middle, for the quarters: the map's z runs from the south coast near -340 to the mountains near 410 and x from
 * about -440 to 440, so the middle is a little north of the origin.
 */
export const ISLAND_CENTER = { x: 0, z: 35 };
export const quarterOf = (p: { x: number; z: number }, center: { x: number; z: number } = ISLAND_CENTER): Quarter =>
  p.z >= center.z ? (p.x >= center.x ? 'NE' : 'NW') : (p.x >= center.x ? 'SE' : 'SW');

/** What the layout needs to know of a place; world-layout's PoiPlacement fits. */
export type PartsPoi = {
  id: string; asset: string; x: number; z: number; yaw: number;
  footprint?: { cx: number; cz: number; hx: number; hz: number };
  entrance?: [number, number];
};
export type PartPlacement = {
  part: PartId; kind: ItemKind; group: PartGroup;
  /** The place's id and asset name. */
  poiId: string; asset: string;
  /** The prop hook the part sits on, when the prop has the matching one; otherwise `ground`, a world position beside the place. */
  hook?: string;
  ground?: { x: number; z: number };
  quarter: Quarter;
  inLair: boolean;
};
export type PartsLayout = { parts: PartPlacement[]; lairId: string; quarters: Quarter[]; seed: number };
export type PlacePartsOptions = {
  seed: number;
  /** The id of the lair's place. One part lies there. */
  lairId: string;
  center?: { x: number; z: number };
  /** Hook names per asset; defaults to game/data/world-assets.json. */
  hooks?: Record<string, readonly string[]>;
  /** Assets a part may lie at; defaults to {@link PART_SITES}. */
  sites?: readonly string[];
};

const ASSET_HOOKS: Record<string, string[]> = Object.fromEntries(Object.entries(worldAssets as Record<string, { hooks?: Record<string, unknown> }>).map(([k, v]) => [k, Object.keys(v.hooks ?? {})]));
const MAX_PER_PLACE = 2, TRIES = 400, QUARTERS_WANTED = 3;

/** A small fast seeded generator (mulberry32): enough for shuffling seven parts, and the same in every JS engine. */
function rng(seed: number) {
  let a = (Math.imul(Math.trunc(seed) | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Model-local to world, as three.js applies rotation.y = yaw (the same maths as world-layout's placeLocal, kept here so this module stays light). */
const local = (p: { x: number; z: number; yaw: number }, lx: number, lz: number): { x: number; z: number } => {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return { x: p.x + lx * c + lz * s, z: p.z + lz * c - lx * s };
};

/** A spot on the ground beside a place, on its door's side when it has one so the part is found on the way in, 2.2 m clear of the walls. */
function groundBeside(poi: PartsPoi, nth: number, random: () => number) {
  const f = poi.footprint ?? { cx: 0, cz: 0, hx: 2, hz: 2 };
  const base = poi.entrance ? Math.atan2(poi.entrance[0] - f.cx, poi.entrance[1] - f.cz) : random() * Math.PI * 2;
  // Two parts at one place stand apart: the second to the other side of the door, not on the first.
  const angle = base + (poi.entrance ? (nth % 2 ? -.7 : .7) + (random() - .5) * .5 : nth * 2.4);
  const reach = Math.max(f.hx, f.hz) + 2.2 + nth * .8;
  return local(poi, f.cx + Math.sin(angle) * reach, f.cz + Math.cos(angle) * reach);
}

export function placeParts(pois: readonly PartsPoi[], opts: PlacePartsOptions): PartsLayout {
  const hooks = opts.hooks ?? ASSET_HOOKS, sites = opts.sites ?? PART_SITES, center = opts.center ?? ISLAND_CENTER;
  const lair = pois.find(p => p.id === opts.lairId);
  const candidates = pois.filter(p => sites.includes(p.asset) || p.id === opts.lairId);
  if (!candidates.length) throw new Error('placeParts: no places to put parts at');
  const hookedFor = (poi: PartsPoi, kind: ItemKind) => { const name = HOOK_OF[kind]; return name !== undefined && (hooks[poi.asset] ?? []).includes(name); };

  type Draw = { at: PartsPoi; part: (typeof PARTS)[number] }[];
  let best: Draw = [], bestQuarters = -1;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const random = rng(opts.seed * 1000 + attempt);
    const order = PARTS.map(p => ({ p, k: random() })).sort((x, y) => x.k - y.k).map(x => x.p);
    const draw: Draw = [], held = new Map<string, number>(), hookTaken = new Set<string>();
    for (const [i, part] of order.entries()) {
      // The first part drawn goes to the lair; the rest are weighted towards places with a hook for them.
      let pick: PartsPoi | undefined = i === 0 ? lair : undefined;
      if (!pick) {
        const open = candidates.filter(c => (held.get(c.id) ?? 0) < MAX_PER_PLACE);
        const weight = (c: PartsPoi) => hookedFor(c, part.kind) && !hookTaken.has(`${c.id}:${HOOK_OF[part.kind]}`) ? 4 : 1;
        const total = open.reduce((s, c) => s + weight(c), 0);
        let roll = random() * total;
        pick = open.find(c => (roll -= weight(c)) < 0) ?? open[open.length - 1];
      }
      if (!pick) break;
      held.set(pick.id, (held.get(pick.id) ?? 0) + 1);
      if (hookedFor(pick, part.kind)) hookTaken.add(`${pick.id}:${HOOK_OF[part.kind]}`);
      draw.push({ at: pick, part });
    }
    if (draw.length < PARTS.length) continue;
    const quarters = new Set(draw.map(d => quarterOf(d.at, center))).size;
    if (quarters > bestQuarters) { best = draw; bestQuarters = quarters; }
    if (quarters >= QUARTERS_WANTED) break;
  }

  // Parts keep their own order in the output, not the draw's; the hook goes to the first of its kind to claim it.
  const random = rng(opts.seed * 7919 + 13), used = new Set<string>(), onGround = new Map<string, number>();
  const parts: PartPlacement[] = PARTS.map(part => {
    const at = best.find(d => d.part.id === part.id)!.at;
    const name = HOOK_OF[part.kind], slot = `${at.id}:${name}`;
    const hook = hookedFor(at, part.kind) && !used.has(slot) ? name : undefined;
    if (hook) used.add(slot);
    const nth = onGround.get(at.id) ?? 0;
    const ground = hook ? undefined : groundBeside(at, nth, random);
    if (!hook) onGround.set(at.id, nth + 1);
    return { part: part.id, kind: part.kind, group: part.group, poiId: at.id, asset: at.asset, ...(hook ? { hook } : {}), ...(ground ? { ground } : {}), quarter: quarterOf(at, center), inLair: at.id === opts.lairId };
  });
  return { parts, lairId: opts.lairId, quarters: [...new Set(parts.map(p => p.quarter))].sort(), seed: opts.seed };
}

/**
 * The reducer's items for a layout (pass them to initialState): each part lies at its place's asset, on its hook or on the
 * ground at `at`; the backpack stays at the cabin. Item ids are the part ids.
 */
export function partsToItems(layout: PartsLayout): Record<string, Item> {
  const items: Record<string, Item> = {};
  for (const p of layout.parts) {
    items[p.part] = { kind: p.kind, poi: p.asset, status: 'world', part: p.part, poiId: p.poiId, ...(p.hook ? { hook: p.hook } : {}), ...(p.ground ? { at: { ...p.ground } } : {}) };
  }
  items['backpack-cabin'] = { kind: 'backpack', poi: 'cabin', status: 'world' };
  return items;
}
