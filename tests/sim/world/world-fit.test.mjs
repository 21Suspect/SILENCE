import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import './helpers/register-ts-hooks.mjs';
// The rebuilt world only exists behind ?world-v2; game modules read the flag when they load, so it is set before the first import.
globalThis.location = { search: `?world-v2${process.env.WORLD_SEED ? `&seed=${process.env.WORLD_SEED}` : ''}` };
const { heightAt, pathX, pathDistance, pathWidth, roadZ, riverX, riverPresence, biomeAt, vegetationExclusion, WORLD_RADIUS } = await import('../game/world.ts');
const { POI_PLACEMENTS, SCATTER_PLACEMENTS, TRAILS, TRAIL_LINES, TRAIL_META, LOOP_INDEX, FORDS, JUNCTIONS, MAIN_TRAIL_BOUNDS, ROAD_ENDS, placeLocal } = await import('../game/world-layout.ts');
const { roadArc, roadXAtArc } = await import('../game/road-geometry.ts');
const { coastDistance, lakeDistance, mountainFoot, beachWidth } = await import('../game/coastal-geography.ts');
const { landSlope } = await import('../game/world-landform.ts');
const { ROAD } = await import('../game/road-profile.ts');
const { createPois, seatPlacement, worldColliders, footprintOf, placePoint } = await import('../game/pois.ts');
const { naturalLayout } = await import('../game/placement.ts');
const { createCollisionWorld, moveCharacter, solidContact } = await import('../game/collision.ts');
const assets = (await import('../game/world-assets.json')).default;

/*
 * The fit audit: does everything look like it belongs where it stands? It runs on the real terrain, the real layout and the real
 * colliders from game/world-assets.json, with the rebuilt world switched on, and it never loosens a limit to pass. Every finding is
 * one located line; all of them are written to work/world-review/fit-audit.txt (also when the test fails) and each check then fails
 * with its own list. Where a fix can be computed it is on the line, after "fix:".
 */
const LIMITS = {
  floatM: .06,      // 1. the seated base above the terrain at any point of the footprint
  buriedM: .18,     // 1. the same, below the terrain, for small props (buildings are held to the ledge rule instead)
  ledgeM: .25,      // 2. terrain height range under a building's footprint
  entranceM: 1,     // 3. a trail must end this close to the entrance it serves
  trailClearM: .5,  // 5. nothing on the path
  treeClearM: .3,   // 6. a trunk this close to a prop's collider reads as grown through it
  channelM: 3.6,    // 7. the stream bed and gravel shelf, from the centre line; the bank begins here (see rawHeight)
  entranceAreaM: 3, // 5. a POI's own colliders may stand this close to its own entrance
  stuckS: 2, speed: 1.8, fps: 60,
};
const SUNK = /^(rock_|minerock$|tunnelrock$)/; // modelled to sit below the ground: not judged for floating or burying
const FINDINGS = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [] };
const NOTES = [];
const found = (check, text) => FINDINGS[check].push(text);
const m2 = v => v.toFixed(2), cm = v => `${(v * 100).toFixed(1)} cm`, at = (x, z) => `(${x.toFixed(1)}, ${z.toFixed(1)})`;

// ---------------------------------------------------------------------------------------------------------------------
// Geometry in the ground plane. A shape is a convex polygon (a box) or a capsule: a segment with a radius (a trunk is a point with one).
const sqr = v => v * v;
const pointSeg = (p, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz, t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l)) : 0; return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t); };
function segSeg(a, b, c, d) {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1], den = rx * sz - rz * sx;
  if (Math.abs(den) > 1e-12) { const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den; if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0; }
  return Math.min(pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
}
const inPoly = (p, poly) => { let sign = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (Math.abs(cross) < 1e-12) continue; if (!sign) sign = Math.sign(cross); else if (sign !== Math.sign(cross)) return false; } return true; };
const edges = poly => poly.map((a, i) => [a, poly[(i + 1) % poly.length]]);
function segPoly(a, b, poly) { if (inPoly(a, poly) || inPoly(b, poly)) return 0; let best = Infinity; for (const [c, d] of edges(poly)) best = Math.min(best, segSeg(a, b, c, d)); return best; }
function polyPoly(p, q) {
  if (p.some(v => inPoly(v, q)) || q.some(v => inPoly(v, p))) return 0;
  let best = Infinity; for (const [a, b] of edges(p)) for (const [c, d] of edges(q)) best = Math.min(best, segSeg(a, b, c, d));
  return best;
}
/** Clear distance between two shapes in metres; zero or less means they overlap. */
function gap(A, B) {
  if (A.poly && B.poly) return polyPoly(A.poly, B.poly);
  if (!A.poly && !B.poly) return segSeg(A.a, A.b, B.a, B.b) - A.r - B.r;
  const [s, p] = A.poly ? [B, A] : [A, B];
  return segPoly(s.a, s.b, p.poly) - s.r;
}
const centreOf = s => s.poly ? [s.poly.reduce((n, v) => n + v[0], 0) / s.poly.length, s.poly.reduce((n, v) => n + v[1], 0) / s.poly.length] : [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
/** Furthest a shape reaches from its own centre. */
const reachOf = s => s.poly ? Math.max(...s.poly.map(v => Math.hypot(v[0] - centreOf(s)[0], v[1] - centreOf(s)[1]))) : Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) / 2 + s.r;
const shapeOfCollider = c => {
  if (c.kind === 'capsule') return { a: [c.ax, c.az], b: [c.bx, c.bz], r: c.radius, minY: c.minY, maxY: c.maxY, tag: c.tag };
  const co = Math.cos(c.yaw), si = Math.sin(c.yaw);
  return { poly: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [c.x + u * c.halfX * co + v * c.halfZ * si, c.z - u * c.halfX * si + v * c.halfZ * co]), minY: c.minY, maxY: c.maxY, tag: c.tag };
};
/** A model-local rectangle as a world polygon, through the same placePoint the colliders use. */
const rectPoly = (p, rect, grow = 0) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => { const w = placePoint(p, rect.cx + u * (rect.hx + grow), rect.cz + v * (rect.hz + grow)); return [w.x, w.z]; });
const yOverlap = (a, b) => a.minY < b.maxY && b.minY < a.maxY;

// ---------------------------------------------------------------------------------------------------------------------
// Every placement the game builds, seated exactly as createPois seats it.
const UP = new THREE.Vector3(0, 1, 0);
function entryOf(p, poi) {
  const asset = assets[p.asset]; if (!asset) return undefined;
  // A bridge deck stands at its own level, the same exception createPois makes.
  const seat = p.y !== undefined ? { ground: p.y, placement: p } : seatPlacement(asset, p, heightAt), s = p.scale ?? 1, rect = footprintOf(asset, p.footprint);
  const q = seat.quaternion ?? new THREE.Quaternion().setFromAxisAngle(UP, p.yaw);
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(p.x, seat.ground, p.z), q, new THREE.Vector3(s, s, s));
  const colliders = worldColliders(asset, seat.placement, seat.ground, seat.quaternion);
  const shapes = colliders.map(shapeOfCollider);
  // Without colliders the footprint is the whole extent (a tyre, a shovel): its rectangle stands in.
  if (!shapes.length) shapes.push({ poly: rectPoly(seat.placement, rect), minY: seat.ground, maxY: seat.ground + .5, tag: 'footprint' });
  const building = p.footprint ? rectPoly(p, p.footprint) : undefined;
  const c = [p.x, p.z];
  const reach = Math.max(...shapes.map(sh => Math.hypot(centreOf(sh)[0] - c[0], centreOf(sh)[1] - c[1]) + reachOf(sh)), ...(building ? building.map(v => Math.hypot(v[0] - c[0], v[1] - c[1])) : [0]));
  return { p, poi, asset, seat, matrix, rect, colliders, shapes, building, c, reach, sunk: SUNK.test(p.asset), rock: SUNK.test(p.asset) };
}
const entries = [];
for (const p of POI_PLACEMENTS) { const e = entryOf(p, true); if (e) entries.push(e); else NOTES.push(`${p.id}: asset "${p.asset}" is not in world-assets.json yet; not audited`); }
for (const p of SCATTER_PLACEMENTS) { const e = entryOf(p, false); if (e) entries.push(e); else NOTES.push(`${p.id}: asset "${p.asset}" is not in world-assets.json yet; not audited`); }
const unlistedAssets = [...new Set(NOTES.map(n => n.match(/asset "(.+?)"/)[1]))];
const byId = new Map(entries.map(e => [e.p.id, e]));
const baseAt = (e, lx, lz) => new THREE.Vector3(lx, 0, lz).applyMatrix4(e.matrix);

// Terrain heights under a model-local rectangle, as a fine grid including its edges and corners (the terrain mesh is 0.67 m).
function sampleRect(e, rect, step = .25) {
  const s = e.p.scale ?? 1, nx = Math.max(2, Math.ceil(2 * rect.hx * s / step) + 1), nz = Math.max(2, Math.ceil(2 * rect.hz * s / step) + 1), out = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push([rect.cx + (i / (nx - 1) * 2 - 1) * rect.hx, rect.cz + (j / (nz - 1) * 2 - 1) * rect.hz]);
  return out;
}
/** How the seated base meets the ground over its footprint: the worst float and the worst burial, and where. */
function baseGaps(e) {
  let float = -Infinity, bury = -Infinity, floatAt, buryAt;
  for (const [lx, lz] of sampleRect(e, e.rect)) {
    const w = baseAt(e, lx, lz), g = w.y - heightAt(w.x, w.z);
    if (g > float) { float = g; floatAt = w; } if (-g > bury) { bury = -g; buryAt = w; }
  }
  return { float, bury, floatAt, buryAt };
}

// Trees as the game builds them (see game/forest.ts): the real layout, a capsule of radius .44 * width + .08.
const forest = naturalLayout({ heightAt, exclusion: vegetationExclusion, biomeAt, riverX, riverPresence, roadZ, radius: WORLD_RADIUS });
const treeRadius = t => .44 * t.width + .08;
const treeColliderOf = t => ({ kind: 'capsule', ax: t.x, az: t.z, bx: t.x, bz: t.z, radius: treeRadius(t), minY: t.y - .15, maxY: t.y + 31 * t.height, tag: 'tree' });
const treeCache = new Map();
function treesNear(x, z, r) {
  const out = [];
  for (let cz = Math.floor((z - r) / 32); cz <= Math.floor((z + r) / 32); cz++) for (let cx = Math.floor((x - r) / 32); cx <= Math.floor((x + r) / 32); cx++) {
    const key = `${cx},${cz}`; let cell = treeCache.get(key); if (!cell) treeCache.set(key, cell = forest.cell(cx, cz).trees);
    for (const t of cell) if (Math.hypot(t.x - x, t.z - z) < r) out.push(t);
  }
  return out;
}
const treeShape = t => ({ a: [t.x, t.z], b: [t.x, t.z], r: treeRadius(t), minY: t.y - .15, maxY: t.y + 31 * t.height, tag: 'tree' });

// The trails, as segments. `ends` says which entrance a line arrives at.
const TRAIL_SEGMENTS = [];
TRAIL_LINES.forEach((line, li) => { for (let k = 0; k < line.length - 1; k++) TRAIL_SEGMENTS.push({ a: line[k], b: line[k + 1], r: 0, line: li, k }); });
const entranceOf = e => e.p.entrance ? placeLocal(e.p, e.p.entrance[0], e.p.entrance[1]) : undefined;
const trailEndAt = (x, z) => { let best = { d: Infinity, line: -1 }; TRAIL_LINES.forEach((line, i) => { const [ex, ez] = line[line.length - 1], d = Math.hypot(ex - x, ez - z); if (d < best.d) best = { d, line: i }; }); return best; };
const lineName = i => { const end = TRAIL_LINES[i].at(-1), e = entries.find(q => q.p.entrance && Math.hypot(...entranceOf(q).map((v, j) => v - end[j])) < LIMITS.entranceM); return `trail ${i}${i === LOOP_INDEX ? ' (the hiking loop)' : e ? ` (to ${e.p.id})` : ''}`; };
/** Nearest trail segment to a shape: [clear distance, segment, nearest point on it]. */
function trailClearance(shape) {
  let best = [Infinity, undefined, undefined];
  const [cx, cz] = centreOf(shape), reach = reachOf(shape) + 3;
  for (const seg of TRAIL_SEGMENTS) {
    if (Math.min(seg.a[0], seg.b[0]) > cx + reach || Math.max(seg.a[0], seg.b[0]) < cx - reach || Math.min(seg.a[1], seg.b[1]) > cz + reach || Math.max(seg.a[1], seg.b[1]) < cz - reach) continue;
    const d = gap(shape, seg); if (d < best[0]) best = [d, seg, undefined];
  }
  if (best[1]) { const [cx2, cz2] = centreOf(shape), s = best[1], dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], l = dx * dx + dz * dz, t = l ? Math.max(0, Math.min(1, ((cx2 - s.a[0]) * dx + (cz2 - s.a[1]) * dz) / l)) : 0; best[2] = [s.a[0] + dx * t, s.a[1] + dz * t]; }
  return best;
}
const { channelOffset } = await import('../game/world-noise.ts');
const channelGap = (x, z) => riverPresence(z) > 0 ? channelOffset(x, z) - LIMITS.channelM : Infinity;

// ---------------------------------------------------------------------------------------------------------------------
// Everything that can be judged about one placement against the rest of the world. Used for the checks and, with the placement
// moved, to find the nearest spot that would pass them all.
const sameSpot = (a, b) => Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) < .01 && Math.abs(a.p.yaw - b.p.yaw) < .01;
/** Things set on each other on purpose: one object made of two placements at one origin (the mine and its rock face), or a crate standing on a pallet. */
const deliberate = (a, b) => sameSpot(a, b) || [[a, b], [b, a]].some(([x, y]) => x.p.asset === 'crate' && y.p.asset === 'pallet' && inPoly([x.p.x, x.p.z], rectPoly(y.seat.placement, y.rect)));
/** Sunk into the ground on purpose: a post that stands on the surface is the thing that would look wrong. */
const DRIVEN = new Set(['pole', 'roadsign', 'trailmarker', 'mailbox', 'guardrail', 'guardrail_end', 'guardrail_endr', 'antler_post', 'canline', 'fence', 'wall', 'wall_gap']);
function issuesOf(e, others = entries) {
  const issues = [], id = e.p.id, where = at(e.p.x, e.p.z), label = `${id} (${e.p.asset}) at ${where}`;
  // 1. floating or buried
  if (!e.sunk && e.p.y === undefined) {
    const g = baseGaps(e);
    if (g.float > (e.p.fit === 'run' ? .34 : LIMITS.floatM)) issues.push({ check: 1, text: `${label} floats ${cm(g.float)} above the ground at ${at(g.floatAt.x, g.floatAt.z)}; limit ${cm(LIMITS.floatM)}` });
    if (!e.p.footprint && !DRIVEN.has(e.p.asset) && g.bury > LIMITS.buriedM) issues.push({ check: 1, text: `${label} is buried ${cm(g.bury)} at ${at(g.buryAt.x, g.buryAt.z)}; limit ${cm(LIMITS.buriedM)}${e.p.fit === 'tilt' ? ` (tilted ${tiltOf(e).toFixed(1)} deg, capped at 22)` : ' (it stands upright on a slope)'}` });
  }
  // 5. on a trail (the ends of a trail are a POI's own entrance area)
  const own = entranceOf(e);
  for (const shape of e.shapes) {
    const [d, seg, near] = trailClearance(shape);
    if (d >= LIMITS.trailClearM) continue;
    const end = own && trailEndAt(own[0], own[1]);
    // Any path that ends at this entrance may come up to it (a place can have several: the way in and the way on).
    const endsAtOwn = own && TRAIL_LINES[seg.line].some((v, k, l) => (k === 0 || k === l.length - 1) && Math.hypot(v[0] - own[0], v[1] - own[1]) <= LIMITS.entranceM);
    if (own && endsAtOwn && gap(shape, { a: own, b: own, r: 0 }) <= LIMITS.entranceAreaM) continue;
    const c = centreOf(shape);
    issues.push({ check: 5, text: `${label}: ${shape.tag ? `its ${shape.tag}` : 'its collider'} at ${at(c[0], c[1])} is ${d <= 0 ? 'on' : `${cm(d)} from`} ${lineName(seg.line)} (nearest point ${at(...near)}); limit ${cm(LIMITS.trailClearM)}${e.rock ? ' [rock on a trail]' : ''}`, key: `${id}|trail|${seg.line}` });
    break;
  }
  // 6. inside something
  for (const o of others) {
    if (o === e || Math.hypot(o.c[0] - e.c[0], o.c[1] - e.c[1]) > o.reach + e.reach + 1 || deliberate(e, o)) continue;
    const pair = [id, o.p.id].sort().join('|');
    if (!e.p.footprint && !o.p.footprint) {
      // Broken stone is dumped against the bridge fill, and rail lengths lap each other and the bridge's own rail, by design.
      if ([e.p.id, o.p.id].some(n => n.startsWith('riprap-')) && [e.p, o.p].every(q => q.id.startsWith('riprap-') || q.asset === 'roadbridge')) continue;
      if ([e.p.asset, o.p.asset].some(n => n.startsWith('guardrail')) && [e.p.asset, o.p.asset].every(n => n.startsWith('guardrail') || n === 'roadbridge')) continue;
      for (const a of e.shapes) { const hit = o.shapes.find(b => yOverlap(a, b) && gap(a, b) <= 0); if (hit) { issues.push({ check: 6, text: `${label} overlaps ${o.p.id} (${o.p.asset}) at ${at(o.p.x, o.p.z)}`, key: pair }); break; } }
    } else if (e.p.footprint && o.p.footprint) {
      if (polyPoly(e.building, o.building) <= 0) issues.push({ check: 6, text: `${label} has a footprint overlapping the footprint of ${o.p.id} at ${at(o.p.x, o.p.z)}`, key: pair });
    } else {
      const [prop, bld] = e.p.footprint ? [o, e] : [e, o];
      if (prop === e && prop.shapes.some(s => gap(s, { poly: bld.building }) <= 0)) {
        // A footprint is a bounding rectangle, so it can hold open ground between the building's solids: say which it is.
        const solid = Math.min(...prop.shapes.flatMap(s => bld.shapes.map(b => gap(s, b))));
        // A place's own props belong inside its bounding rectangle, as long as they stand clear of its solids.
        if (solid > 0 && prop.p.id.startsWith(`${bld.p.id}:`)) continue;
        issues.push({ check: 6, text: `${label} ${e.rock ? 'is a rock standing' : 'stands'} inside the footprint of ${bld.p.id} (${bld.p.asset}) at ${at(bld.p.x, bld.p.z)}, ${solid <= 0 ? 'overlapping one of its colliders' : `${m2(solid)} m clear of its colliders`}`, key: pair });
      }
    }
  }
  // 6. trees: inside a footprint, or touching a prop
  for (const t of treesNear(e.c[0], e.c[1], e.reach + 3)) {
    const trunk = treeShape(t);
    if (e.building && gap(trunk, { poly: e.building }) <= 0) issues.push({ check: 6, text: `a tree trunk at ${at(t.x, t.z)} (radius ${m2(treeRadius(t))} m) stands inside the footprint of ${id} at ${where}`, key: `${id}|tree|${t.x}|${t.z}`, tree: true });
    if (!e.building) for (const s of e.shapes) { const d = gap(trunk, s); if (d < LIMITS.treeClearM) { issues.push({ check: 6, text: `a tree trunk at ${at(t.x, t.z)} (radius ${m2(treeRadius(t))} m) is ${d <= 0 ? 'inside' : `${cm(d)} from`} ${label}; limit ${cm(LIMITS.treeClearM)}`, key: `${id}|tree|${t.x}|${t.z}`, tree: true }); break; } }
  }
  // 7. in the stream channel
  // The stepping stones of a ford stand in the stream: that is what they are for.
  if (e.p.asset !== 'guardrail' && e.p.asset !== 'roadbridge' && !e.p.id.startsWith('ford-')) {
    let worst = Infinity, worstAt;
    const probe = (x, z) => { const d = channelGap(x, z); if (d < worst) { worst = d; worstAt = [x, z]; } };
    for (const s of e.shapes) { if (s.poly) { for (const v of s.poly) probe(v[0], v[1]); } else { probe(s.a[0], s.a[1]); probe(s.b[0], s.b[1]); } }
    if (e.building) for (const v of e.building) probe(v[0], v[1]);
    if (worst < 0) issues.push({ check: 7, text: `${label} stands ${m2(-worst)} m inside the stream channel (${m2(LIMITS.channelM)} m either side of the centre line) at ${at(...worstAt)}; guardrails and the bridge are the only exceptions` });
  }
  return issues;
}
function tiltOf(e) { return e.seat.quaternion ? Math.acos(Math.min(1, UP.clone().applyQuaternion(e.seat.quaternion).y)) * 180 / Math.PI : 0; }

/** The nearest spot within 12 m where the placement would have nothing to answer for, or undefined. */
function nearestClear(e) {
  const rest = entries.filter(o => o !== e);
  for (let r = .25; r <= 12.01; r += r < 4 ? .25 : .5) for (let k = 0; k < 24; k++) {
    const a = k / 24 * Math.PI * 2, p = { ...e.p, x: e.p.x + Math.cos(a) * r, z: e.p.z + Math.sin(a) * r }, c = entryOf(p, e.poi);
    if (c && !issuesOf(c, rest).length) return { x: p.x, z: p.z, r };
  }
  return undefined;
}
/** What to change for a prop's findings. A POI the trees grow through needs a clearing; everything else can move. */
function hint(e, issues) {
  if (e.p.footprint) return '';
  if (e.poi && issues.every(i => i.tree)) return ` | fix: in POI_PLACEMENTS give '${e.p.id}' clearing: ${Math.ceil(e.reach) + 1} (its farthest collider is ${m2(e.reach)} m from its origin; trees stand back from the clearing radius, see CLEARINGS in game/world.ts)`;
  const s = nearestClear(e);
  return s ? ` | fix: move ${e.p.id} to x ${s.x.toFixed(2)}, z ${s.z.toFixed(2)} (${m2(s.r)} m away; it passes every check there)` : ` | fix: there is no clear spot within 12 m of ${e.p.id}; it needs a different place`;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1, 5, 6, 7: per placement
const seen = new Set();
for (const e of entries) {
  const issues = issuesOf(e); let suggestion; // one search per placement, however many of its checks fail
  for (const i of issues) {
    if (i.key) { if (seen.has(i.key)) continue; seen.add(i.key); } // a pair is reported once, whichever side is met first
    suggestion ??= hint(e, issues);
    found(i.check, i.text + suggestion);
  }
}


// 8. nothing stands on the road, and what belongs beside it stands beside it
// The road is the one thing that runs nearly along z on its mountain legs, so every distance to it is measured across it: the nearest
// point of the centre line, found by Newton steps (this check does not trust the game's own roadDistance, which it is also testing).
function roadGapAt(px, pz) {
  let x = px;
  for (let k = 0; k < 60; k++) {
    const z = roadZ(x), m = (roadZ(x + .05) - roadZ(x - .05)) / .1, step = ((x - px) + (z - pz) * m) / (1 + m * m);
    x -= Math.max(-2, Math.min(2, step)); if (Math.abs(step) < 1e-7) break;
  }
  const z = roadZ(x), m = (roadZ(x + .05) - roadZ(x - .05)) / .1;
  return { gap: Math.hypot(px - x, pz - z), x, z, m, side: Math.sign((pz - z) - m * (px - x)) || 1 };
}
const EAST = ROAD_ENDS.find(e => e.side > 0), WEST = ROAD_ENDS.find(e => e.side < 0);
/** Things that belong on the carriageway: the bridge that carries it, the tunnel mouths and their rock, the barrier across it. */
const ON_THE_ROAD = /^(road-bridge|tunnel-|tunnel-rock-|gate-)/;
const FURNITURE = new Set(['pole', 'roadsign', 'streetlight', 'mailbox']);
const ROAD_MARGIN = .15, FURNITURE_REACH = 3;
const onRoadCounts = {};
for (const e of entries) {
  if (ON_THE_ROAD.test(e.p.id)) continue;
  const centre = roadGapAt(e.c[0], e.c[1]);
  if (centre.x < WEST.x - 2 || centre.x > EAST.x + 2 || centre.gap > e.reach + ROAD.level + FURNITURE_REACH + 6) continue;
  // The nearest any part of it comes to the centre line: its colliders, or the footprint of its building.
  let nearest = Infinity, nearestAt, what;
  const consider = (px, pz, r, tag) => { const g = roadGapAt(px, pz).gap - r; if (g < nearest) { nearest = g; nearestAt = [px, pz]; what = tag; } };
  const edgePoints = poly => { const pts = []; poly.forEach((a, i) => { const b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / .5)); for (let k = 0; k < n; k++) pts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }); return pts; };
  for (const sh of e.shapes) {
    if (sh.poly) for (const [px, pz] of edgePoints(sh.poly)) consider(px, pz, 0, sh.tag ?? 'collider');
    else { const n = Math.max(1, Math.ceil(Math.hypot(sh.b[0] - sh.a[0], sh.b[1] - sh.a[1]) / .5)); for (let k = 0; k <= n; k++) consider(sh.a[0] + (sh.b[0] - sh.a[0]) * k / n, sh.a[1] + (sh.b[1] - sh.a[1]) * k / n, sh.r, sh.tag ?? 'collider'); }
  }
  if (e.building) for (const [px, pz] of edgePoints(e.building)) consider(px, pz, 0, 'footprint');
  if (nearest < ROAD.level + ROAD_MARGIN) {
    onRoadCounts[e.p.asset] = (onRoadCounts[e.p.asset] ?? 0) + 1;
    found(8, `${e.p.id} (${e.p.asset}) at ${at(e.p.x, e.p.z)}: its ${what} at ${at(...nearestAt)} comes within ${m2(nearest)} m of the road's centre line; the shoulder ends at ${m2(ROAD.level)} m, and ${m2(ROAD.level + ROAD_MARGIN)} m is the least allowed`);
  }
  if (FURNITURE.has(e.p.asset)) {
    const across = centre.gap, yaw = e.p.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), k = 1 / Math.hypot(1, centre.m), tx = k, tz = centre.m * k;
    if (across < ROAD.level + .2 || across > ROAD.level + FURNITURE_REACH) found(8, `${e.p.id} (${e.p.asset}) at ${at(e.p.x, e.p.z)} stands ${m2(across)} m from the centre line: roadside furniture stands between the shoulder (${m2(ROAD.level)} m) and ${FURNITURE_REACH} m beyond it`);
    // A sign, mailbox or lamp faces the road; the power line runs along it.
    const toRoad = [(centre.x - e.p.x), (centre.z - e.p.z)], tl = Math.hypot(...toRoad) || 1;
    if (e.p.asset === 'pole') { if (Math.abs(Math.cos(yaw) * tx - Math.sin(yaw) * tz) < .95) found(8, `${e.p.id} (pole) at ${at(e.p.x, e.p.z)} is not in line with the road: its wires run ${(Math.acos(Math.min(1, Math.abs(Math.cos(yaw) * tx - Math.sin(yaw) * tz))) * 180 / Math.PI).toFixed(0)} degrees across it`); }
    else if ((fx * toRoad[0] + fz * toRoad[1]) / tl < .75) found(8, `${e.p.id} (${e.p.asset}) at ${at(e.p.x, e.p.z)} does not face the road: it turns ${(Math.acos(Math.max(-1, Math.min(1, (fx * toRoad[0] + fz * toRoad[1]) / tl))) * 180 / Math.PI).toFixed(0)} degrees from it`);
  }
}
NOTES.push(`placements on the road, by asset: ${JSON.stringify(onRoadCounts)}`);
// Plants, sampled as the plant code samples: ground cover grows where exclusion is at most .91, tussocks .7, ferns .48, trees .42. Nothing may grow on the carriageway,
// along the whole road, mountain legs included, and no trunk may stand on it.
{
  let arc = 0, last = WEST.x, clear = 0; const bad = [];
  for (let x = WEST.x + 4; x <= EAST.x - 1; x += .25) {
    arc += Math.hypot(.25, roadZ(x) - roadZ(x - .25));
    if (arc < 1.5) continue; arc = 0;
    const z = roadZ(x), m = (roadZ(x + .25) - roadZ(x - .25)) / .5, k = 1 / Math.hypot(1, m), nx = -m * k, nz = k;
    for (let d = -ROAD.half; d <= ROAD.half + 1e-9; d += .5) { const e = vegetationExclusion(x + d * nx, z + d * nz); clear++; if (e < .91) bad.push(`(${(x + d * nx).toFixed(1)}, ${(z + d * nz).toFixed(1)}) exclusion ${e.toFixed(2)}`); }
  }
  if (bad.length) found(8, `ground cover, tussocks and ferns may grow on the carriageway at ${bad.length} of ${clear} sampled points, for example ${bad.slice(0, 4).join('; ')}`);
  let trunks = 0, onRoad = []; arc = 0;
  for (let x = WEST.x + 4; x <= EAST.x - 1; x += .5) {
    arc += Math.hypot(.5, roadZ(x) - roadZ(x - .5)); if (arc < 12) continue; arc = 0;
    for (const t of treesNear(x, roadZ(x), 13)) { trunks++; const g = roadGapAt(t.x, t.z).gap - treeRadius(t); if (g < ROAD.half) onRoad.push(`a trunk at ${at(t.x, t.z)} (radius ${m2(treeRadius(t))} m) is ${m2(g)} m from the centre line`); }
  }
  if (onRoad.length) found(8, `${onRoad.length} tree trunks stand on the carriageway, for example ${[...new Set(onRoad)].slice(0, 3).join('; ')}`);
  NOTES.push(`plants: ${clear} points of the carriageway sampled and ${trunks} trunks looked at along ${(roadZ(0) * 0 + Math.abs(EAST.x - WEST.x)).toFixed(0)} m of x`);
}

// 9. trails stay on the green: no sample of any footpath (the loop, cross paths, links, spurs, ford approaches) on the sand or the lake's edge
// The beach is where the shore is nearer than coastDistance < beachWidth; the lake's shore is lakeDistance 0. A trail's centre line keeps SAND_MARGIN metres
// inland of both, which leaves room for its own width. Round a place's door (16 m) it need only not be on the sand: a door stands where it stands.
{
  const SAND_MARGIN = 3, DOOR_REACH = 16;
  const doorAts = POI_PLACEMENTS.filter(p => p.entrance).map(p => placeLocal(p, p.entrance[0], p.entrance[1]));
  let worst = Infinity, worstAt, worstLine = -1, samples = 0, nearDoor = 0;
  TRAIL_LINES.forEach((line, li) => {
    let reported = false;
    for (let k = 0; k < line.length - 1 && !reported; k++) {
      const [ax, az] = line[k], [bx, bz] = line[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5));
      for (let t = 0; t <= n; t++) {
        const x = ax + (bx - ax) * t / n, z = az + (bz - az) * t / n, margin = Math.min(coastDistance(x, z) - beachWidth(x, z), lakeDistance(x, z) - 1);
        const door = doorAts.some(d => Math.hypot(d[0] - x, d[1] - z) < DOOR_REACH);
        door ? nearDoor++ : samples++;
        if (!door && margin < worst) { worst = margin; worstAt = [x, z]; worstLine = li; }
        if (margin < (door ? 0 : SAND_MARGIN)) { found(9, `${lineName(li)} at ${at(x, z)} is ${m2(margin)} m inland of the sand (beach ${m2(beachWidth(x, z))} m wide, shore ${m2(coastDistance(x, z))} m away, lake edge ${m2(lakeDistance(x, z))} m away); a trail keeps ${SAND_MARGIN} m clear${door ? ' (at a door, only off the sand)' : ''} | fix: close the sand to the router in routePaths`); reported = true; break; }
      }
    }
  });
  NOTES.push(`worst margin inland of sand over ${samples} samples of ${TRAIL_LINES.length} lines (leaving ${nearDoor} within ${DOOR_REACH} m of a door): ${m2(worst)} m at ${at(...worstAt)} on ${lineName(worstLine)}`);
}

// 2. a building on a tilted or rumpled pad looks fake
for (const e of entries) {
  if (!e.p.footprint || e.p.asset === 'tunnel') continue;   // a tunnel mouth is cut into a slope: world.ts shapes the ground for it, and the slope behind is the point
  let lo = Infinity, hi = -Infinity, loAt, hiAt;
  for (const [lx, lz] of sampleRect(e, e.p.footprint)) { const w = placePoint(e.p, lx, lz), y = heightAt(w.x, w.z); if (y < lo) { lo = y; loAt = w; } if (y > hi) { hi = y; hiAt = w; } }
  if (hi - lo <= LIMITS.ledgeM) continue;
  const reach = Math.max(...[-1, 1].flatMap(u => [-1, 1].map(v => Math.hypot(e.p.footprint.cx + u * e.p.footprint.hx, e.p.footprint.cz + v * e.p.footprint.hz))));
  const pad = e.p.pad ? `its pad (radius ${e.p.pad.radius}, falloff ${e.p.pad.falloff}) does not level the whole footprint` : 'it has no pad';
  found(2, `${e.p.id} (${e.p.asset}) at ${at(e.p.x, e.p.z)} stands on ${cm(hi - lo)} of relief under its ${m2(2 * e.p.footprint.hx)} x ${m2(2 * e.p.footprint.hz)} m footprint (lowest ${m2(lo)} m at ${at(loAt.x, loAt.z)}, highest ${m2(hi)} m at ${at(hiAt.x, hiAt.z)}); limit ${cm(LIMITS.ledgeM)}; ${pad}`
    + ` | fix: in POI_PLACEMENTS give '${e.p.id}' pad: { radius: ${Math.ceil(reach + .5)}, falloff: ${Math.max(10, e.p.pad?.falloff ?? 10)} } (the footprint's far corner is ${m2(reach)} m from the origin; the pad is centred on x, z) or move it to ground that is flat under the footprint`);
}

// 3. the path network: every line has both ends on something walked, the loop closes, every place is on it, and nothing is far from it
const bridgeEnds = [[riverX(-35) - 12, -35], [riverX(-35) + 12, -35]]; // the footbridge spans riverX(-35) +/- 12 at z = -35 (game/terrain.ts)
const roadPts = [], trailPts = [];
for (let a = roadArc(WEST.x); a <= roadArc(EAST.x); a += 2) { const x = roadXAtArc(a); roadPts.push([x, roadZ(x)]); }
for (let z = MAIN_TRAIL_BOUNDS.south; z <= MAIN_TRAIL_BOUNDS.north; z += 2) trailPts.push([pathX(z), z]);
const doorsOf = POI_PLACEMENTS.filter(p => p.entrance).map(p => ({ id: p.id, at: placeLocal(p, p.entrance[0], p.entrance[1]) }));
const nearPoint = (q, pts, r) => pts.some(v => Math.hypot(v[0] - q[0], v[1] - q[1]) <= r);
const nearLine = (q, line, r) => { for (let k = 0; k < line.length - 1; k++) if (pointSeg(q, line[k], line[k + 1]) <= r) return true; return false; };
const lineName3 = i => `trail ${i} (${TRAIL_META[i].kind}${TRAIL_META[i].from ? ` ${TRAIL_META[i].from}` : ''}${TRAIL_META[i].to ? ` to ${TRAIL_META[i].to}` : ''})`;
const meets = (q, own) => {
  if (doorsOf.some(d => Math.hypot(d.at[0] - q[0], d.at[1] - q[1]) <= LIMITS.entranceM)) return 'a door';
  if (nearPoint(q, trailPts, pathWidth(q[1]) + .9)) return 'the main trail';
  if (nearPoint(q, roadPts, 2.9)) return 'the road';
  if (bridgeEnds.some(b => Math.hypot(b[0] - q[0], b[1] - q[1]) <= LIMITS.entranceM)) return 'a bridge end';
  for (let j = 0; j < TRAIL_LINES.length; j++) if (j !== own && nearLine(q, TRAIL_LINES[j], 1.2)) return `another path (${lineName3(j)})`;
  return undefined;
};
TRAIL_LINES.forEach((line, i) => {
  if (i === LOOP_INDEX) {
    const gap = Math.hypot(line[0][0] - line.at(-1)[0], line[0][1] - line.at(-1)[1]);
    if (gap > .5) found(3, `the hiking loop does not close: it ends ${m2(gap)} m from where it starts | fix: close the ring of waypoints in routePaths`);
    return;
  }
  for (const [end, q] of [['start', line[0]], ['end', line.at(-1)]]) if (!meets(q, i)) found(3, `${lineName3(i)} ${end} at ${at(...q)} meets nothing: no door, road, main trail, bridge end or other path within reach | fix: make the line end on something walked`);
});
// every place with an entrance has a path ending at its door; the places that used to be dead ends have a second
for (const d of doorsOf) {
  const ends = TRAIL_LINES.filter((l, i) => i !== LOOP_INDEX && (Math.hypot(l[0][0] - d.at[0], l[0][1] - d.at[1]) <= LIMITS.entranceM || Math.hypot(l.at(-1)[0] - d.at[0], l.at(-1)[1] - d.at[1]) <= LIMITS.entranceM)).length;
  if (!ends && !d.id.startsWith('tunnel')) found(3, `${d.id}: no path ends within ${LIMITS.entranceM} m of its entrance ${at(...d.at)}`);
  if (['hunter-camp', 'lookout', 'hide', 'fold', 'pumphouse', 'mine', 'shrine', 'graves', 'chapel'].includes(d.id) && ends < 2) found(3, `${d.id} is a dead end: only ${ends} path(s) reach its door; a place that stood at the end of a path has a way on to the loop or another path`);
}
// from every place you can reach the loop on paths (the road and the main trail are paths too)
{
  const items = [...TRAIL_LINES.map((l, i) => ({ name: lineName3(i), pts: l })), { name: 'the road', pts: roadPts }, { name: 'the main trail', pts: trailPts }];
  const parent = items.map((_, i) => i), find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const touches = (a, b) => { for (const q of a.pts) if (nearLine(q, b.pts, 2.5)) return true; return false; };
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (find(i) !== find(j) && touches(items[i], items[j])) parent[find(i)] = find(j);
  for (const d of doorsOf) {
    const on = items.findIndex((it, i) => i < TRAIL_LINES.length && nearPoint(d.at, [it.pts[0], it.pts.at(-1)], LIMITS.entranceM));
    if (on >= 0 && find(on) !== find(LOOP_INDEX)) found(3, `${d.id}: its path ${items[on].name} does not lead to the hiking loop`);
  }
  items.forEach((it, i) => { if (find(i) !== find(LOOP_INDEX)) found(3, `${it.name} is cut off from the loop: no walk joins them`); });
}
// no stretch of dry, walkable land below the mountains is left without a path
const NEAR_PATH_M = 140;   // the worst is the top of the east hill, a gentle knoll with no gentle way up to it
{
  const everything = [...roadPts, ...trailPts, ...TRAIL_LINES.flatMap(l => l)];
  let worst = 0, worstAt;
  for (let x = -520; x <= 520; x += 12) for (let z = -340; z <= 360; z += 12) {
    if (coastDistance(x, z) < 12 || lakeDistance(x, z) < 8 || z > mountainFoot(x) || landSlope(x, z, 5) > .5) continue;
    let d = Infinity; for (const q of everything) { const e = Math.hypot(q[0] - x, q[1] - z); if (e < d) { d = e; if (d < worst) break; } }
    if (d > worst) { worst = d; worstAt = [x, z]; }
  }
  NOTES.push(`furthest dry, gentle land below the mountain foot from any path, trail or road: ${worst.toFixed(0)} m at ${at(...worstAt)}`);
  if (worst > NEAR_PATH_M) found(3, `dry land at ${at(...worstAt)} is ${worst.toFixed(0)} m from the nearest path; the limit is ${NEAR_PATH_M} m | fix: lay a cross path through it`);
}
// the furniture of the network: a waymark at every junction, at every place the loop meets the road and the fords' stones
for (const j of JUNCTIONS) if (!SCATTER_PLACEMENTS.some(p => p.asset === 'trailmarker' && Math.hypot(p.x - j.x, p.z - j.z) < 8)) found(3, `the junction on ${j.on} at ${at(j.x, j.z)} has no waymark within 8 m`);
if (!SCATTER_PLACEMENTS.some(p => p.id.startsWith('cairn-loop'))) found(3, 'the loop has no cairn where it tops a rise');
if (!SCATTER_PLACEMENTS.some(p => p.id.startsWith('bench-loop'))) found(3, 'the loop has no bench');
FORDS.forEach((f, n) => { if (SCATTER_PLACEMENTS.filter(p => p.id.startsWith(`ford-${n}-`)).length < 5) found(3, `${f.id} at ${at(f.x, f.z)} has no line of stepping stones`); });

// 4. the paths can be walked, with the real moveCharacter
const ENGINE = { height: 1.69, accel: 6, decel: 10, yDamp: 18 };
// Every trail starts on the main trail or the road, so those are walked end to end as well (4 m between points, like the trails).
const along = (n, f, from=-400, to=400) => Array.from({ length: n + 1 }, (_, i) => f(from + i * (to-from) / n));
const roadWalk = []; for (let a = roadArc(WEST.x) + 30; a <= roadArc(EAST.x) - 30; a += 4) { const x = roadXAtArc(a); roadWalk.push([x, roadZ(x)]); }
// Every line is walked end to end, the loop included. The audit's moveCharacter has no water in it: wading a ford is slower in the game
// (see waterDepthAt) and that is allowed there, and only there; everywhere else 1.8 m/s must be enough.
const ROUTES = [...TRAIL_LINES.map((line, i) => ({ line, name: lineName(i), index: i })),
  { line: roadWalk, name: 'the road between the closed tunnel barriers', extra: true }, { line: along(Math.ceil((MAIN_TRAIL_BOUNDS.north-MAIN_TRAIL_BOUNDS.south)/4), z => [pathX(z), z],MAIN_TRAIL_BOUNDS.south,MAIN_TRAIL_BOUNDS.north), name: 'the main trail (dry beach to mountain foothills)', extra: true }];
const solids = createCollisionWorld(), labels = new Map(), treeColliders = [], allProps = [];
for (const e of entries) for (const [i, c] of e.colliders.entries()) { labels.set(c, `${e.p.id} ${c.tag ?? `collider ${i}`}`); allProps.push(c); }
{
  const cells = new Set();
  for (const { line } of ROUTES) for (const [x, z] of line) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) cells.add(`${Math.floor(x / 32) + dx},${Math.floor(z / 32) + dz}`);
  for (const key of cells) { const [cx, cz] = key.split(',').map(Number); for (const t of forest.cell(cx, cz).trees) { const c = treeColliderOf(t); labels.set(c, `tree at ${at(t.x, t.z)}, radius ${m2(c.radius)} m`); treeColliders.push(c); } }
}
solids.replace('pois', allProps); solids.replace('trees', treeColliders);
function walkLine(line, name, extra) {
  const dt = 1 / LIMITS.fps, speed = LIMITS.speed, window = Math.round(LIMITS.stuckS * LIMITS.fps);
  const length = line.slice(1).reduce((n, v, i) => n + Math.hypot(v[0] - line[i][0], v[1] - line[i][1]), 0), budget = Math.ceil((length / speed * 2 + 20) * LIMITS.fps);
  const p = { x: line[0][0], y: heightAt(line[0][0], line[0][1]), z: line[0][1] }, trace = [[p.x, p.z]];
  let vx = 0, vz = 0, next = 1;
  for (let frame = 0; frame < budget; frame++) {
    let d = Math.hypot(line[next][0] - p.x, line[next][1] - p.z);
    while (d < (next === line.length - 1 ? .35 : .8)) { if (++next === line.length) return undefined; d = Math.hypot(line[next][0] - p.x, line[next][1] - p.z); }
    const ease = 1 - Math.exp(-dt * ENGINE.accel);
    vx += ((line[next][0] - p.x) / d * speed - vx) * ease; vz += ((line[next][1] - p.z) / d * speed - vz) * ease;
    const moved = moveCharacter(p, vx * dt, vz * dt, ENGINE.height, heightAt, solids);
    p.x = moved.x; p.z = moved.z; p.y += (moved.y - p.y) * (1 - Math.exp(-ENGINE.yDamp * dt));
    trace.push([p.x, p.z]);
    if (trace.length > window) {
      const was = trace[trace.length - 1 - window];
      if (Math.hypot(p.x - was[0], p.z - was[1]) < .5) return stuck(p, line, next, name, frame / LIMITS.fps, extra);
    }
  }
  return `${name} never reached its end: after ${(budget / LIMITS.fps).toFixed(0)} s it is at ${at(p.x, p.z)}, ${m2(Math.hypot(line.at(-1)[0] - p.x, line.at(-1)[1] - p.z))} m short of ${at(...line.at(-1))}`;
}
function stuck(p, line, next, name, time, extra) {
  const g = (dx, dz) => (heightAt(p.x + dx, p.z + dz) - heightAt(p.x - dx, p.z - dz)) / .7, gx = g(.35, 0), gz = g(0, .35);
  const blockers = solids.nearby(p.x, p.z, 1).filter(c => solidContact(c, p.x, p.z, .24 + .06).depth > 0 && c.maxY > p.y + .28 && c.minY < p.y + ENGINE.height).map(c => labels.get(c) ?? c.tag);
  const toward = line[next];
  return `${name} gets stuck at ${at(p.x, p.z)} after ${time.toFixed(1)} s, heading for ${at(toward[0], toward[1])}: ${blockers.length ? `blocked by ${[...new Set(blockers)].join('; ')}` : `nothing in contact; the ground gradient there is ${Math.hypot(gx, gz).toFixed(2)} (moveCharacter will not climb above .95)`}`
    + (blockers.some(b => b.startsWith('tree')) ? ' | fix: the layout keeps trees 1.4 m from the trail line; this one is closer to the walked wander of the route, so either widen the exclusion in game/world.ts exclusionV2 or straighten the wander in TRAIL_LINES here' : blockers.length ? (extra ? ' | fix: a prop stands across it; correct its yaw or position in world-layout.ts' : ' | fix: move the blocking prop off the trail (see check 5)') : ' | fix: the route needs a different line, or the terrain here needs grading');
}
const DECKS = allProps.filter(c => c.tag === 'road bridge deck');
for (const { line, name, index, extra } of ROUTES) {
  // The steepest slope the route asks the player to climb, measured as moveCharacter measures it.
  let steepest = { rise: 0 };
  for (let k = 0; k < line.length - 1; k++) {
    const [ax, az] = line[k], [bx, bz] = line[k + 1], len = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / len, dz = (bz - az) / len;
    for (let s = 0; s < len; s += .1) {
      const x = ax + dx * s, z = az + dz * s, gx = (heightAt(x + .35, z) - heightAt(x - .35, z)) / .7, gz = (heightAt(x, z + .35) - heightAt(x, z - .35)) / .7, up = dx * gx + dz * gz;
      if (DECKS.some(c => solidContact(c, x, z, .3).depth > 0)) continue; // on the bridge, the ground underneath does not matter
      if (Math.hypot(gx, gz) > .95 && up > .05 && up > steepest.rise) steepest = { rise: up, grade: Math.hypot(gx, gz), x, z };
    }
  }
  const what = extra ? 'extra, not a TRAIL_LINES route: ' : '';
  if (steepest.x !== undefined) found(4, `${what}${name} climbs a slope moveCharacter will not: ground gradient ${steepest.grade.toFixed(2)} (limit .95) at ${at(steepest.x, steepest.z)}, with ${steepest.rise.toFixed(2)} of it uphill along the route | fix: ${extra ? `the terrain needs grading there (the ${name.includes('road') ? 'road crosses the stream channel' : 'trail climbs'}; see rawHeight in game/world.ts)` : `re-route TRAILS[${index}] around ${at(steepest.x, steepest.z)} or grade the terrain there`}`);
  const problem = walkLine(line, name, extra); if (problem) found(4, what + problem);
}

// ---------------------------------------------------------------------------------------------------------------------
const REPORT = fileURLToPath(new URL('../work/world-review/fit-audit.txt', import.meta.url));
const TITLES = { 1: 'FLOATING OR BURIED', 2: 'SITS ON A LEDGE', 3: 'PATH NETWORK', 4: 'PATH NOT WALKABLE', 5: 'ON THE PATH', 6: 'INSIDE SOMETHING', 7: 'IN THE WATER', 8: 'ON THE ROAD', 9: 'ON THE SAND' };
const gaps = entries.filter(e => !e.sunk).map(e => ({ id: e.p.id, ...baseGaps(e) }));
after(() => {
  const total = Object.values(FINDINGS).reduce((n, l) => n + l.length, 0), lines = [
    'WORLD FIT AUDIT: real terrain, POI_PLACEMENTS and SCATTER_PLACEMENTS, WORLD_V2 on, colliders from game/world-assets.json',
    ...NOTES.filter(n => /^(placements on the road|plants:|furthest|worst margin)/.test(n)),
    `placements audited: ${entries.length} (${entries.filter(e => e.poi).length} POI, ${entries.filter(e => !e.poi).length} scatter)${unlistedAssets.length ? `; skipped, asset not in world-assets.json yet: ${unlistedAssets.join(', ')}` : ''}`,
    `limits: float ${cm(LIMITS.floatM)}, buried ${cm(LIMITS.buriedM)} (small props), ledge ${cm(LIMITS.ledgeM)}, entrance gap ${LIMITS.entranceM} m, trail clearance ${cm(LIMITS.trailClearM)}, tree clearance ${cm(LIMITS.treeClearM)}, stuck ${LIMITS.stuckS} s at ${LIMITS.speed} m/s and ${LIMITS.fps} fps`,
    `worst seated base over all ${gaps.length} placements judged: ${cm(Math.max(0, Math.max(...gaps.map(g => g.float))))} above the ground (${gaps.reduce((a, b) => b.float > a.float ? b : a).id}), ${cm(Math.max(...gaps.map(g => g.bury)))} below it (${gaps.reduce((a, b) => b.bury > a.bury ? b : a).id})`, '',
  ];
  for (const check of [1, 2, 3, 4, 5, 6, 7, 8, 9]) { lines.push(`${check}. ${TITLES[check]} (${FINDINGS[check].length})`, ...FINDINGS[check].map(t => `  ${t}`), ''); }
  lines.push('SUMMARY', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(c => `  ${c}. ${TITLES[c].toLowerCase().padEnd(24, '.')} ${FINDINGS[c].length}`), `  total ${total}: ${total ? 'FAIL' : 'PASS'}`, '');
  mkdirSync(fileURLToPath(new URL('../work/world-review/', import.meta.url)), { recursive: true });
  writeFileSync(REPORT, lines.join('\n'));
});
const check = (n, what) => test(`fit ${n}: ${what}`, () => assert.equal(FINDINGS[n].length, 0, `\n${FINDINGS[n].length} finding(s):\n${FINDINGS[n].map(t => `  ${t}`).join('\n')}\n(all checks: work/world-review/fit-audit.txt)\n`));

test('the audit sees exactly what the game builds: createPois seats every placement as seatPlacement does', () => {
  const world = createCollisionWorld(), pois = createPois(new THREE.Scene(), heightAt, world);
  assert.equal(pois.solidColliders.length, entries.reduce((n, e) => n + e.colliders.length, 0));
  assert.deepEqual(pois.solidColliders, entries.flatMap(e => e.colliders));
  assert.ok(entries.length > 100 && TRAIL_LINES.length === TRAILS.length);
  pois.dispose();
});
check(1, 'every prop sits on the ground: nothing floats, nothing is buried');
check(2, 'no building stands on a ledge or a rumpled pad');
check(3, 'the path network: both ends of every line on something walked, the loop closed, every place on it and none left dead-ended, nothing far from a path, waymarks at the junctions');
check(4, 'every trail can be walked at 1.8 m/s with the real moveCharacter, trees and props in place');
check(5, 'nothing stands on a trail');
check(6, 'nothing stands inside anything else, trees included');
check(7, 'nothing stands in the stream channel');
check(9, 'no trail runs on the sand or at the lake\'s edge: every footpath keeps inland of the beach by a margin');
check(8, 'nothing stands on the road, roadside furniture stands beside it and faces it, and nothing grows on the carriageway');
