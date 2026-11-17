/**
 * The paper map's pure parts: the projection between the island and the sheet, which places are ringed in pencil, and the contour
 * lines of a sampled field (the coast and the lake's edge). No DOM and no three.js, so they are tested alone.
 */
import { placeOf, type Place } from './places';

export type MapBounds = { x0: number; x1: number; z0: number; z1: number };
/** Land lies within x -624..600 and z -400..688 on the seed the game ships with; a margin of the sea is kept all round. */
export const MAP_BOUNDS: MapBounds = { x0: -660, x1: 640, z0: -440, z1: 730 };

/**
 * World to sheet. North is up and is -z (the way the camera looks at yaw 0), east is +x to the right, so the map is never mirrored.
 * The island is scaled to fit the sheet whole and centred; `scale` is pixels per metre.
 */
export function makeProjection(b: MapBounds, width: number, height: number, margin = 0) {
  const scale = Math.min((width - 2 * margin) / (b.x1 - b.x0), (height - 2 * margin) / (b.z1 - b.z0));
  const ox = (width - (b.x1 - b.x0) * scale) / 2, oy = (height - (b.z1 - b.z0) * scale) / 2;
  return {
    scale,
    toCanvas: (x: number, z: number): [number, number] => [ox + (x - b.x0) * scale, oy + (z - b.z0) * scale],
    toWorld: (px: number, py: number): [number, number] => [b.x0 + (px - ox) / scale, b.z0 + (py - oy) / scale],
  };
}

/** The slice of an objective item the map reads. */
export type MapItem = { status: string; part?: string; poi: string; poiId?: string };

/** Ids of the places where a missing part is still lying out in the world, whatever exact spot it lies at there. */
export function ringedPlaceIds(items: Record<string, MapItem> | undefined, places?: readonly Place[]): Set<string> {
  const out = new Set<string>();
  if (!items) return out;
  for (const item of Object.values(items)) {
    if (item.status !== 'world' || !item.part) continue;
    const place = (item.poiId ? placeOf(item.poiId, places) : undefined) ?? placeOf(item.poi, places);
    if (place) out.add(place.id);
  }
  return out;
}

/** A stable key for a set of ids, to redraw the pencil only when it changes. */
export const idsKey = (ids: ReadonlySet<string>) => [...ids].sort().join('|');

/**
 * Marching squares: the line where a field sampled on a grid (row-major, `nx` by `nz`, cell size `step` from x0, z0) crosses `level`,
 * as separate segments [xa, za, xb, zb] with the ends found by linear interpolation along the cell edges.
 */
export function contourSegments(field: ArrayLike<number>, nx: number, nz: number, x0: number, z0: number, step: number, level: number): number[][] {
  const out: number[][] = [];
  const at = (i: number, j: number) => field[j * nx + i] - level;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
    if (code === 0 || code === 15) continue;
    const x = x0 + i * step, z = z0 + j * step;
    // Crossing points on the four edges: top (a-b), right (b-c), bottom (d-c), left (a-d).
    const t = (p: number, q: number) => p / (p - q);
    const top = [x + step * t(a, b), z], right = [x + step, z + step * t(b, c)], bottom = [x + step * t(d, c), z + step], left = [x, z + step * t(a, d)];
    const seg = (p: number[], q: number[]) => out.push([p[0], p[1], q[0], q[1]]);
    switch (code) {
      case 1: case 14: seg(left, top); break;
      case 2: case 13: seg(top, right); break;
      case 3: case 12: seg(left, right); break;
      case 4: case 11: seg(right, bottom); break;
      case 6: case 9: seg(top, bottom); break;
      case 7: case 8: seg(left, bottom); break;
      case 5: seg(left, top); seg(right, bottom); break;
      case 10: seg(top, right); seg(left, bottom); break;
    }
  }
  return out;
}

/** A box [x0, y0, x1, y1] on the sheet. */
export type Box = [number, number, number, number];
export const boxesTouch = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/** Shorter names for the places with long ones, tried when the full name finds no room near its symbol. */
export const SHORT_NAMES: Record<string, string> = { 'road-bridge': 'Bridge', 'watertower': 'Tower', 'logging-camp': 'Logging', 'pumphouse': 'Pumphouse', 'hide': 'Stand', 'hunter-camp': 'Camp' };
const ANGLES = [0, 180, -90, 90, -45, 45, -135, 135, -22.5, 22.5, 157.5, -157.5, -67.5, 67.5, -112.5, 112.5];
export type LabelItem = { id: string; cx: number; cy: number; /** Radius of the symbol and its pencil ring: nothing may stand inside. */ r: number; w: number; h: number;
  /** A name that is always drawn (a key place, a ringed one): it may be set smaller (`variants`) and, as a last resort, further off than `maxOff`. */ must?: boolean;
  /** Smaller sizes of the same name, largest first (variants[0] is w x h itself); tried at each distance before it is pushed further out. */ variants?: { w: number; h: number; text?: string }[] };
export type LabelSpot = { x: number; y: number; box: Box; /** Set when the label was pushed off, to draw a short leader to the symbol. */ leader: boolean; clear: boolean; /** Which variant (size) was used. */ v: number };

/** Distance from (cx, cy) to the nearest point of a box. */
export const boxDistance = (cx: number, cy: number, b: Box) => Math.hypot(Math.max(b[0] - cx, 0, cx - b[2]), Math.max(b[1] - cy, 0, cy - b[3]));

/**
 * Where each place's name goes (x is the text's left, y its baseline): beside the symbol if there is room, else diagonally, above or
 * below, else a little further off with a leader line, never beyond maxOff from the symbol. A name never covers another name,
 * another place's symbol (or its ring) or a blocked box (the legend, the cartouche, the compass, the scale). A name that finds no
 * clear spot is dropped, unless it is "must": it is tried at smaller sizes at each distance and, only if nothing is clear within
 * maxOff, searched out to 3 times that and then takes the least-overlapping spot (clear false). Items are placed in the order
 * given, so the important ones go first. "fixed" holds names already placed (kept as they are, and kept clear of), which is how a
 * ringed place that was dropped gets its name later.
 */
export function placeLabels(items: readonly LabelItem[], blocked: readonly Box[], area: Box, pad = 3, fixed?: ReadonlyMap<string, LabelSpot>, maxOff = 60): Map<string, LabelSpot> {
  const taken: Box[] = [...blocked, ...items.map((i): Box => [i.cx - i.r, i.cy - i.r, i.cx + i.r, i.cy + i.r]), ...[...(fixed?.values() ?? [])].map(f => f.box)];
  const out = new Map<string, LabelSpot>();
  for (const it of items) {
    if (fixed?.has(it.id)) continue;
    const g = it.r + pad, { cx, cy } = it, variants = it.variants?.length ? it.variants : [{ w: it.w, h: it.h }];
    // Right, left, above, below, the diagonals, then between: sixteen places round the symbol at distance d.
    const ring = (d: number, w: number, h: number) => ANGLES.map(deg => {
      const t = deg * Math.PI / 180, dx = Math.cos(t), dy = Math.sin(t);
      const x = cx + dx * d - (dx < -.3 ? w : dx > .3 ? 0 : w / 2), top = cy + dy * d - (dy < -.3 ? h : dy > .3 ? 0 : h / 2);
      return { x, top, w, h };
    });
    const near = Math.min(maxOff, g + (maxOff - g) * .45);
    const dists = [g, near, maxOff].filter((d, i, a) => d >= g && (i === 0 || d > a[i - 1] + 2));
    const far = it.must ? [maxOff * 1.4, maxOff * 2, maxOff * 3] : [];
    let best: LabelSpot | undefined, bestScore = Infinity;
    search: for (const d of [...dists, ...far]) for (let v = 0; v < variants.length; v++) for (const c of ring(d, variants[v].w, variants[v].h)) {
      const box: Box = [c.x - 2, c.top - 1, c.x + c.w + 2, c.top + c.h + 3];
      const outside = (c.w + 4) * (c.h + 4) - overlapArea(box, area);
      let score = outside > .01 ? outside : 0;
      for (const t of taken) score += overlapArea(box, t);
      if (score < bestScore) { bestScore = score; best = { x: c.x, y: c.top + c.h * .85, box, leader: d > g + 1, clear: score === 0, v }; }
      if (score === 0) break search;
    }
    if (best && (best.clear || it.must)) { out.set(it.id, best); taken.push(best.box); }
  }
  return out;
}
