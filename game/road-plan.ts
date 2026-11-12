/**
 * The plan view of the valley road: where its centre line runs, as z for every x. No imports: world-noise builds it and the
 * shader receives the same numbers, so the road the ground is graded to and the road that is painted are one curve.
 *
 * The southern stretch (the bridge, the trailhead, the water tower, the chapel) is the old closed-form course. Beyond
 * `LEG_FROM` each end runs on into the mountains as a mountain approach road: it is built by steering, not by a formula in x. The
 * heading eases round to the north, swings in long S-curves, bends back out along the foot of the range and then runs straight
 * for the last stretch, so the tunnel mouth is reached on a line a driver could use. The result is tabulated every `PLAN_DX` m
 * of x and read back with a Catmull-Rom curve, in JavaScript and in GLSL alike.
 */
export const PLAN_X0 = -520, PLAN_DX = 2, PLAN_N = 521;
/** Where the legs leave the old southern course. A grid node: |x| = PLAN_X0 + 348 * PLAN_DX. */
export const LEG_FROM = 176;
const DEG = Math.PI / 180;
const ss = (v: number, a: number, b: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

/** What one end of the road is told to do. Lengths are metres of road, angles are radians from the outward x axis. */
export interface LegSpec {
  /** Where the road is to arrive: outward distance |x| and z. Its long climb north is steered (see `walkLeg`) to pass here. */
  targetX: number; targetZ: number;
  /** Metres over which the heading eases from the one it leaves the southern course with to the one of the climb. */
  turnIn: number;
  /** Two S-curves laid over the heading: amplitude (heading swing either side), wavelength in metres of road and phase. */
  swing: number; wave: number; phase: number;
  swing2: number; wave2: number; phase2: number;
}
export interface LegPoint { s: number; x: number; z: number; heading: number }
export interface RoadPlan {
  /** z at x = PLAN_X0 + i * PLAN_DX. */
  z: Float64Array;
  /** The legs as walked: east first. Arc length from the point they leave the southern course. */
  legs: LegPoint[][];
  /** The heading of the long climb that was found to reach each leg's target. */
  climb: number[];
  /** Where each leg was told to arrive (x with its sign, z). */
  targets: { x: number; z: number }[];
}

/** Walks one end of the road out from the southern course with the climb heading `main`. `side` is +1 east, -1 west. */
function stride(south: (x: number) => number, side: number, spec: LegSpec, main: number, reach: number) {
  const u0 = LEG_FROM, z0 = south(side * u0), slope0 = south(side * (u0 + .5)) - south(side * (u0 - .5));
  const heading0 = Math.atan(slope0);
  const points: LegPoint[] = [];
  let u = u0, z = z0, s = 0;
  const headingAt = (s: number, z: number) => {
    const base = heading0 + (main - heading0) * ss(s, 0, spec.turnIn);
    // The S-curves live in the middle of the road: they ease in after the junction and die out in the last stretch before the target,
    // so the mouth is reached on a straight.
    const env = ss(s, 25, 95) * (1 - ss(z, spec.targetZ - 85, spec.targetZ - 25));
    const wiggle = env * (spec.swing * Math.sin(Math.PI * 2 * s / spec.wave + spec.phase) + spec.swing2 * Math.sin(Math.PI * 2 * s / spec.wave2 + spec.phase2));
    return Math.max(Math.min(8 * DEG, heading0), Math.min(78 * DEG, base + wiggle));
  };
  const h = .5;
  points.push({ s: 0, x: side * u, z, heading: heading0 });
  while (u < reach) {
    const a = headingAt(s, z), du = Math.cos(a) * h, dz = Math.sin(a) * h, b = headingAt(s + h, z + dz);
    u += (du + Math.cos(b) * h) / 2; z += (dz + Math.sin(b) * h) / 2; s += h;
    if (Math.abs(s % 2) < 1e-9) points.push({ s, x: side * u, z, heading: b });
  }
  return points;
}
/** |x| at which a walked leg reaches z. */
function uAt(points: LegPoint[], z: number) {
  for (let i = 1; i < points.length; i++) if (points[i].z >= z) { const a = points[i - 1], b = points[i], t = (z - a.z) / (b.z - a.z || 1); return Math.abs(a.x) + (Math.abs(b.x) - Math.abs(a.x)) * t; }
  return Infinity;
}
/** Walks one end of the road out from the southern course, steering the climb so that the road passes through its target. */
export function walkLeg(south: (x: number) => number, side: number, spec: LegSpec, reach = 540): { points: LegPoint[]; climb: number } {
  // The steeper the climb, the less far out the road is when it has risen to the target's z: bisect on the heading.
  let lo = 36 * DEG, hi = 72 * DEG;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (uAt(stride(south, side, spec, mid, reach), spec.targetZ) > spec.targetX) lo = mid; else hi = mid;
  }
  const climb = (lo + hi) / 2;
  return { points: stride(south, side, spec, climb, reach), climb };
}

/** The table: the southern course for |x| <= LEG_FROM and the two walked legs beyond it. */
export function buildRoadPlan(south: (x: number) => number, east: LegSpec, west: LegSpec): RoadPlan {
  const z = new Float64Array(PLAN_N);
  const legs = [walkLeg(south, 1, east), walkLeg(south, -1, west)];
  for (let i = 0; i < PLAN_N; i++) {
    const x = PLAN_X0 + i * PLAN_DX, side = x >= 0 ? 1 : -1;
    if (Math.abs(x) <= LEG_FROM) { z[i] = south(x); continue; }
    const pts = legs[side > 0 ? 0 : 1].points, u = Math.abs(x);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Math.abs(pts[mid].x) <= u) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)], span = Math.abs(b.x) - Math.abs(a.x) || 1;
    z[i] = a.z + (b.z - a.z) * Math.max(0, Math.min(1, (u - Math.abs(a.x)) / span));
  }
  // The GLSL carries three decimals: the table is rounded to them here, so both sides read the very same curve.
  for (let i = 0; i < PLAN_N; i++) z[i] = Math.round(z[i] * 1000) / 1000;
  return { z, legs: legs.map(l => l.points), climb: legs.map(l => l.climb), targets: [{ x: east.targetX, z: east.targetZ }, { x: -west.targetX, z: west.targetZ }] };
}

/** Catmull-Rom through the table at x, and its slope. Beyond the table the end slopes carry on in a straight line. */
export function planAt(z: ArrayLike<number>, x: number, out: { z: number; m: number }) {
  const u = (x - PLAN_X0) / PLAN_DX;
  if (u < 1 || u > PLAN_N - 2) {
    const e = u < 1 ? 1 : PLAN_N - 2, m = (z[e + 1] - z[e - 1]) / (2 * PLAN_DX);
    out.z = z[e] + m * (x - (PLAN_X0 + e * PLAN_DX)); out.m = m; return out;
  }
  const i = Math.min(PLAN_N - 3, Math.floor(u)), t = u - i, p0 = z[i - 1], p1 = z[i], p2 = z[i + 1], p3 = z[i + 2];
  const a = -.5 * p0 + 1.5 * p1 - 1.5 * p2 + .5 * p3, b = p0 - 2.5 * p1 + 2 * p2 - .5 * p3, c = -.5 * p0 + .5 * p2;
  out.z = ((a * t + b) * t + c) * t + p1; out.m = ((3 * a * t + 2 * b) * t + c) / PLAN_DX;
  return out;
}

/** The same lookup as a GLSL function: `float roadZGen(float x)` and `float roadSlopeGen(float x)` over the same table. */
export function planGLSL(z: ArrayLike<number>) {
  const table = Array.from(z, v => v.toFixed(3)).join(',');
  return `
  const float ROAD_PLAN[${PLAN_N}]=float[${PLAN_N}](${table});
  vec2 roadPlanGen(float x){
    float u=(x-(${PLAN_X0.toFixed(1)}))/${PLAN_DX.toFixed(1)};
    float e=clamp(u,1.,${(PLAN_N - 2).toFixed(1)});
    int i=min(${PLAN_N - 3},int(floor(e)));float t=e-float(i);
    float p0=ROAD_PLAN[i-1],p1=ROAD_PLAN[i],p2=ROAD_PLAN[i+1],p3=ROAD_PLAN[i+2];
    float a=-.5*p0+1.5*p1-1.5*p2+.5*p3,b=p0-2.5*p1+2.*p2-.5*p3,c=-.5*p0+.5*p2;
    float m=((3.*a*t+2.*b)*t+c)/${PLAN_DX.toFixed(1)};
    float zc=((a*t+b)*t+c)*t+p1;
    if(u<1.||u>${(PLAN_N - 2).toFixed(1)})zc+=m*(x-(${PLAN_X0.toFixed(1)}+e*${PLAN_DX.toFixed(1)}));
    return vec2(zc,m);
  }
  float roadZGen(float x){return roadPlanGen(x).x;}
  float roadSlopeGen(float x){return roadPlanGen(x).y;}
  `;
}
