/**
 * The valley road's height along its length: a graded profile, not the lie of the land.
 *
 * Through the valley the road still follows the ground (it always did: the mean of the natural height along the centre line).
 * Each end then climbs into the mountains the way a built road does: a long ramp of a few percent with a vertical curve at
 * either end, arriving level at the tunnel mouth. The portals are not fixed places: each is the first spot along the end of
 * the road where the hillside behind a mouth stands well above the bore, so the tunnel reads as going INTO the mountain and no
 * wall has to be raised in open ground. The ground is then cut and filled to this profile (see `shapedGround` in world.ts).
 *
 * Depends on the land's natural shape and the road's plan only, so the layout, the ground and the tests all read one profile.
 */
import { landform } from './world-landform';
import { coastDistance, beachWidth, mountainFoot } from './coastal-geography';
import { ROAD_PLAN, roadZ, roadSlope } from './world-noise';
import { WORLD_V2 } from './world-flags';
import { LEG_FROM, PLAN_X0, PLAN_N, PLAN_DX, type LegPoint } from './road-plan';

/** Never steeper than this for long (a short stretch of the vertical curves may touch a little more). */
export const GRADE_LIMIT = .07;
/** Metres of road the climb is spread over, and the level run into the mouth. */
export const RAMP_LENGTH = 170, MOUTH_LEVEL = 30;
/** A mouth stands well above the beaches (which top out near +3 m): its floor is never lower than this. */
export const MOUTH_FLOOR = 9;
const DS = 2;
const GRID_DX = 1;
const GRID_N = Math.round(-PLAN_X0 * 2 / GRID_DX) + 1;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** The climb's shape: a smoothstep leaning towards its upper end, where the land rises under it. Level at both ends. */
const ramp = (u: number) => { const t = Math.pow(Math.max(0, Math.min(1, u)), 1.5); return t * t * (3 - 2 * t); };
const ss = (v: number, a: number, b: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const natural = (x: number, z: number) => landform(x, z, Math.hypot(x, z));
/** Through the southern valley: the mean of the land's height along the centre line, 32 m of it, as it always was. */
const southern = (x: number) => { const cz = (px: number) => natural(px, roadZ(px)); return (cz(x - 16) + cz(x - 8) + cz(x) + cz(x + 8) + cz(x + 16)) / 5; };

export interface PortalSite {
  side: number; x: number; z: number;
  /** Arc length from the junction at which the mouth stands, and the level of the floor there. */
  s: number; level: number;
  /** How far the natural ground at the mouth, and 14 m behind it, stands above the floor. */
  cutAt: number; riseBehind: number;
}
export interface GradeLeg {
  side: number; points: { s: number; x: number; z: number }[]; natural: number[]; y: number[]; portal: PortalSite;
  /** The climb: where it starts and tops out (arc length from the junction), how far it rises and the highest bank it needs under the road. */
  ramp: { from: number; to: number; rise: number; fill: number };
}

function smoothed(values: number[], radius: number, passes: number) {
  let out = values.slice();
  for (let p = 0; p < passes; p++) {
    const next = out.slice();
    for (let i = 0; i < out.length; i++) { let sum = 0, n = 0; for (let k = -radius; k <= radius; k++) { const j = Math.max(0, Math.min(out.length - 1, i + k)); sum += out[j]; n++; } next[i] = sum / n; }
    out = next;
  }
  return out;
}

/** The points of one end of the road, from the first one before the junction. Arc length is zero at the junction. */
function legSamples(side: number, points: LegPoint[]) {
  // Behind the junction the road is the southern course: walk back along it a short way in equal steps of arc.
  const back: { s: number; x: number; z: number }[] = [];
  let x = side * LEG_FROM;
  for (let k = 1; k <= 40; k++) { const m = roadSlope(x), step = DS / Math.hypot(1, m); x -= side * step; back.push({ s: -k * DS, x, z: roadZ(x) }); }
  return [...back.reverse(), ...points.filter(p => p.s % DS === 0).map(p => ({ s: p.s, x: p.x, z: p.z }))];
}

/** Natural ground that has to stand above the floor behind a mouth, and the part of the hillside that counts. */
function hillBehind(x: number, z: number, heading: number, side: number, floor: number) {
  const dx = side * Math.cos(heading), dz = Math.sin(heading), nx = -dz, nz = dx;
  let low = Infinity;
  for (const lateral of [-9, -4.5, 0, 4.5, 9]) low = Math.min(low, natural(x + dx * 14 + nx * lateral, z + dz * 14 + nz * lateral));
  const far = natural(x + dx * 30, z + dz * 30);
  return { rise: low - floor, far: far - floor };
}

function designLeg(side: number, points: LegPoint[]): GradeLeg {
  const samples = legSamples(side, points), first = samples.findIndex(p => p.s === 0);
  const natu = samples.map(p => natural(p.x, p.z));
  const body = smoothed(natu, 14, 3);
  // Where the road meets the southern course it keeps that course's own height, then hands over to the land.
  const start = samples.map((p, i) => i < first ? southern(p.x) : mix(southern(p.x), body[i], ss(p.s, 0, 70)));
  const heading = (i: number) => points[Math.min(points.length - 1, Math.max(0, Math.round(samples[i].s / DS)))].heading;
  const sites: { i: number; a: number; level: number; cut: number; rise: number; far: number; ok: boolean; fill: number }[] = [];
  const rampCells = RAMP_LENGTH / DS, mouthCells = MOUTH_LEVEL / DS, longest = 360 / DS;
  for (let i = first + Math.round(300 / DS); i < samples.length - 12; i++) {
    const p = samples[i];
    if (Math.abs(p.x) > -PLAN_X0 - 28) break;
    // Well inland of the beach (which is wider in some coves than others).
    if (coastDistance(p.x, p.z) < beachWidth(p.x, p.z) + 48) continue;
    // A mouth is reached on a straight: the heading has hardly changed over the last 60 m (the gate, the lamp and the barrier stand there).
    if (Math.abs(heading(i) - heading(i - 30)) > 7 * Math.PI / 180) continue;
    const top = i - mouthCells;
    // The climb starts where the valley is low and rises as little as the ground allows without a tall bank under the road.
    let best: { a: number; level: number; fill: number; cost: number } | undefined;
    for (let a = top - rampCells; a >= Math.max(first + 30, top - longest); a--) {
      const base = start[a];
      for (let rise = Math.max(3.5, MOUTH_FLOOR - base); rise <= 11; rise += .5) {
        let fill = -Infinity, cut = -Infinity;
        for (let k = a; k <= top; k++) { const y = base + rise * ramp((k - a) / (top - a)); fill = Math.max(fill, y - Math.min(body[k], natu[k] + 1.5)); cut = Math.max(cut, body[k] - y); }
        if (fill > 6.5 || 1.8 * rise / ((top - a) * DS) > .064) continue;
        const cost = Math.max(fill - 2, 0) * 3 + Math.max(cut - 3, 0) + Math.max(rise - 6, 0) * .4 + (top - rampCells - a) * .004;
        if (!best || cost < best.cost) best = { a, level: base + rise, fill, cost };
      }
    }
    if (!best) continue;
    const hill = hillBehind(p.x, p.z, heading(i), side, best.level);
    sites.push({ i, a: best.a, level: best.level, cut: natu[i] - best.level, rise: hill.rise, far: hill.far, ok: natu[i] - best.level >= 5 && hill.rise >= 12 && hill.far >= 20 && best.fill <= 5.6 && p.z > mountainFoot(p.x) + 6, fill: best.fill });
  }
  // Of the places that qualify, the one nearest where this end of the road was steered to.
  const aim = ROAD_PLAN!.targets[side > 0 ? 0 : 1], away = (s: { i: number }) => Math.hypot(samples[s.i].x - aim.x, samples[s.i].z - aim.z);
  const chosen = sites.filter(s => s.ok).sort((a, b) => away(a) - away(b))[0] ?? sites.reduce((best, s) => (s.rise + s.cut > best.rise + best.cut ? s : best), sites[0]);
  const i = chosen.i, a = chosen.a, valley = start[a], top = i - mouthCells;
  // The profile: the land, then the ramp, then the level floor of the mouth, all rounded off by smoothing so no vertical kink remains.
  const lead = 24;
  const y = start.slice(0, i + lead + 1).map((v, k) => k <= a ? v : k >= top ? chosen.level : valley + (chosen.level - valley) * ramp((k - a) / (top - a)));
  let profile = y;
  for (let pass = 0; pass < 3; pass++) {
    const out = profile.slice();
    for (let k = 1; k < profile.length - 1; k++) { let sum = 0, n = 0; for (let d = -7; d <= 7; d++) { const j = Math.max(0, Math.min(profile.length - 1, k + d)); sum += profile[j]; n++; } out[k] = sum / n; }
    // The southern course and the level floor of the mouth are fixed; everything between gives way to the vertical curves.
    for (let k = 0; k <= first + 2; k++) out[k] = y[k];
    // The floor of the mouth is held from a little way in, so the top of the ramp rounds off into it and not onto it.
    for (let k = top + 8; k < out.length; k++) out[k] = chosen.level;
    profile = out;
  }
  // The grade never exceeds the limit: whatever the land asked for, it is spread out. Each clamp leaves a small corner, so clamping
  // and rounding alternate, and the last word is a rounding that cannot raise a grade.
  const clamp = () => {
    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let k = first + 3; k < top; k++) { const d = profile[k + 1] - profile[k]; if (Math.abs(d) > GRADE_LIMIT * DS) { const fix = (Math.abs(d) - GRADE_LIMIT * DS) / 2 * Math.sign(d); if (k + 1 < top) profile[k + 1] -= fix; profile[k] += fix; moved = true; } }
      if (!moved) break;
    }
  };
  const round = () => { const out = profile.slice(); for (let k = first + 4; k < top - 1; k++) out[k] = (profile[k - 1] + profile[k] * 2 + profile[k + 1]) / 4; profile = out; };
  for (let cycle = 0; cycle < 24; cycle++) { clamp(); round(); }
  clamp();
  const level = profile[i];
  const p = samples[i];
  return { side, points: samples.slice(0, i + lead + 1), natural: natu.slice(0, i + lead + 1), y: profile,
    portal: { side, x: p.x, z: p.z, s: p.s, level, cutAt: natu[i] - level, riseBehind: chosen.rise },
    ramp: { from: samples[a].s, to: samples[top].s, rise: chosen.level - valley, fill: chosen.fill } };
}

let GRADE: { legs: GradeLeg[]; table: Float32Array } | undefined;
function build() {
  const legs = ROAD_PLAN!.legs.map((points, k) => designLeg(k === 0 ? 1 : -1, points));
  // One table for the whole road, a height at every metre of x.
  const table = new Float32Array(GRID_N);
  for (let g = 0; g < GRID_N; g++) {
    const x = PLAN_X0 + g * GRID_DX, side = x >= 0 ? 1 : -1;
    if (Math.abs(x) <= LEG_FROM - 80) { table[g] = southern(x); continue; }
    const leg = legs[side > 0 ? 0 : 1], pts = leg.points, u = Math.abs(x);
    // Beyond the mouth the floor of the tunnel runs on level.
    const lastU = Math.abs(pts[pts.length - 1].x);
    if (u >= lastU) { table[g] = leg.y[leg.y.length - 1]; continue; }
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Math.abs(pts[mid].x) <= u) lo = mid; else hi = mid; }
    const span = Math.abs(pts[hi].x) - Math.abs(pts[lo].x) || 1;
    table[g] = mix(leg.y[lo], leg.y[hi], Math.max(0, Math.min(1, (u - Math.abs(pts[lo].x)) / span)));
  }
  return { legs, table };
}
const grade = () => GRADE ??= build();

/** The two ends of the road, east first. */
export const roadPortals = (): PortalSite[] => WORLD_V2 ? grade().legs.map(l => l.portal) : [];
/** The designed height of the road at x (the centre line's height; the carriageway is level across). */
export function roadGradeAt(x: number) {
  const g = grade().table, u = (x - PLAN_X0) / GRID_DX;
  if (u <= 1) return g[1]; if (u >= GRID_N - 3) return g[GRID_N - 3];
  const i = Math.floor(u), t = u - i, p0 = g[i - 1], p1 = g[i], p2 = g[i + 1], p3 = g[i + 2];
  return p1 + .5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}
/** The profile as the legs were built: for audits and the printed table. */
export const roadGradeLegs = () => grade().legs;
export const GRADE_GRID = { dx: GRID_DX, n: GRID_N, x0: PLAN_X0, step: PLAN_DX, cells: PLAN_N };
