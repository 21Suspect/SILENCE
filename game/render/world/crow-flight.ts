// Where the crows go and the line they fly there: pure maths, no three.js (tests/render/world/crow-flight.test.mjs).
//
// A crow does not orbit. It leaves one stand of trees for another a few hundred metres off, on a nearly straight line that
// bows a little, climbing out of the canopy at the start and dropping into it at the end. A route is a centripetal
// Catmull-Rom curve through a handful of waypoints (it passes through every one and does not overshoot or loop between
// close and far points the way a uniform one does), resampled by arc length so a bird is moved along it by distance at
// whatever speed it is flying, with no allocation once the route is built.

export type Site = { x: number; y: number; z: number; hidden?: boolean };
export type Rand = () => number;
export type Vec = { x: number; y: number; z: number };

/** Samples per route: a 600 m route is still sampled every 2.5 m, finer than a bird can turn at 10 m/s. */
export const ROUTE_CAPACITY = 256;
export type Route = { count: number; x: Float32Array; y: Float32Array; z: Float32Array; s: Float32Array; length: number };
export const createRoute = (): Route => ({
  count: 0, length: 0,
  x: new Float32Array(ROUTE_CAPACITY), y: new Float32Array(ROUTE_CAPACITY), z: new Float32Array(ROUTE_CAPACITY), s: new Float32Array(ROUTE_CAPACITY),
});

/** The curve through `n` points (x, y, z triples in `points`), resampled into `route`. */
export function buildRoute(route: Route, points: ArrayLike<number>, n: number): Route {
  if (n < 2) throw new Error('a route needs two points');
  const P = (i: number, k: number) => {
    // The ends are mirrored, so the curve leaves the first point heading for the second and arrives at the last the same way.
    if (i < 0) return 2 * points[k] - points[3 + k];
    if (i >= n) return 2 * points[(n - 1) * 3 + k] - points[(n - 2) * 3 + k];
    return points[i * 3 + k];
  };
  const dist = (a: number, b: number) => Math.hypot(P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2));
  let chord = 0; for (let i = 0; i < n - 1; i++) chord += dist(i, i + 1);
  const spacing = Math.max(1, chord / (ROUTE_CAPACITY - n - 2));
  let count = 0, s = 0, lx = 0, ly = 0, lz = 0;
  const push = (x: number, y: number, z: number) => {
    if (count) s += Math.hypot(x - lx, y - ly, z - lz);
    route.x[count] = lx = x; route.y[count] = ly = y; route.z[count] = lz = z; route.s[count] = s; count++;
  };
  push(P(0, 0), P(0, 1), P(0, 2));
  for (let i = 0; i < n - 1; i++) {
    // Centripetal knots (alpha = .5): the parameter steps by the square root of each chord.
    const t0 = 0, t1 = t0 + Math.max(1e-4, Math.sqrt(dist(i - 1, i))), t2 = t1 + Math.max(1e-4, Math.sqrt(dist(i, i + 1))), t3 = t2 + Math.max(1e-4, Math.sqrt(dist(i + 1, i + 2)));
    const steps = Math.max(2, Math.ceil(dist(i, i + 1) / spacing));
    for (let j = 1; j <= steps; j++) {
      const t = t1 + (t2 - t1) * j / steps;
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 3; k++) {
        const p0 = P(i - 1, k), p1 = P(i, k), p2 = P(i + 1, k), p3 = P(i + 2, k);
        const a1 = ((t1 - t) * p0 + (t - t0) * p1) / (t1 - t0), a2 = ((t2 - t) * p1 + (t - t1) * p2) / (t2 - t1), a3 = ((t3 - t) * p2 + (t - t2) * p3) / (t3 - t2);
        const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0), b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
        const c = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
        if (k === 0) x = c; else if (k === 1) y = c; else z = c;
      }
      push(x, y, z);
    }
  }
  route.count = count; route.length = s;
  return route;
}

/** The point `d` metres along the route into `out`. `hint` is the sample index the last call returned (birds only move forward). */
export function routeAt(route: Route, d: number, out: Vec, hint = 0): number {
  const n = route.count, s = route.s;
  if (n < 2) { out.x = route.x[0]; out.y = route.y[0]; out.z = route.z[0]; return 0; }
  const at = Math.min(Math.max(d, 0), route.length);
  let i = Math.min(Math.max(hint, 0), n - 2);
  while (i < n - 2 && s[i + 1] < at) i++;
  while (i > 0 && s[i] > at) i--;
  const span = s[i + 1] - s[i], t = span > 1e-6 ? (at - s[i]) / span : 0;
  out.x = route.x[i] + (route.x[i + 1] - route.x[i]) * t; out.y = route.y[i] + (route.y[i + 1] - route.y[i]) * t; out.z = route.z[i] + (route.z[i + 1] - route.z[i]) * t;
  return i;
}

export type PathOptions = {
  heightAt: (x: number, z: number) => number;
  /** Height over the highest ground near the line, metres: crows commute at about 20 to 45 m. */
  cruise: number;
  /** Horizontal direction to leave in (a startled flock leaves away from whatever frightened it); else towards the target. */
  away?: { x: number; z: number };
  /** Signed sideways bow of the middle of the route, as a fraction of its length. */
  bow: number;
  /** A startled take-off: steep and straight up out of the trees; otherwise a long shallow climb. */
  burst: boolean;
  /** Ends on something to sit on (comes in flatter, slowing) rather than dropping into a crown. */
  perch: boolean;
};

/** Waypoints from `from` to `to` (x, y, z triples into `out`, at most 22 of them); returns how many. */
export function planWaypoints(out: Float32Array | number[], from: Vec, to: Vec, o: PathOptions): number {
  let n = 0;
  const put = (x: number, y: number, z: number) => { out[n * 3] = x; out[n * 3 + 1] = y; out[n * 3 + 2] = z; n++; };
  let tx = to.x - from.x, tz = to.z - from.z;
  const length = Math.hypot(tx, tz) || 1; tx /= length; tz /= length;
  // Leave mostly away from the threat but already leaning towards the target, so the line never doubles back over it.
  let dx = tx, dz = tz;
  if (o.away) { dx = o.away.x * .72 + tx * .28; dz = o.away.z * .72 + tz * .28; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
  put(from.x, from.y, from.z);
  const [r1, h1, r2, h2] = o.burst ? [2.2, 3.2, 11, 9.5] : [4, 2.4, 18, 7];
  put(from.x + dx * r1, from.y + h1, from.z + dz * r1);
  const wx = from.x + dx * r2, wy = from.y + h2, wz = from.z + dz * r2;
  put(wx, wy, wz);
  // The arrival: a canopy is dropped into steeply (about 35 degrees) from overhead; a perch is come at flatter and slower.
  let ix = to.x - wx, iz = to.z - wz; const il = Math.hypot(ix, iz) || 1; ix /= il; iz /= il;
  const [e2, f2, e1, f1] = o.perch ? [7, 2.2, 26, 8] : [9, 6.5, 30, 14];
  const ax = to.x - ix * e1, az = to.z - iz * e1;
  const ground = (x: number, z: number) => {
    let h = o.heightAt(x, z);
    for (let k = 0; k < 4; k++) h = Math.max(h, o.heightAt(x + Math.cos(k * 1.571) * 18, z + Math.sin(k * 1.571) * 18));
    return h;
  };
  // The middle: a quadratic bow from the climb-out to the approach, sampled every 35 m or so, held `cruise` over the
  // highest ground near each point but never climbing or sinking faster than a crow would (about 25 degrees).
  const mx = ax - wx, mz = az - wz, ml = Math.hypot(mx, mz);
  // Leaving at an angle, the bow goes the same way, so the route is one arc rather than an S.
  const bow = o.away ? Math.abs(o.bow) * (-mz * dx + mx * dz < 0 ? -1 : 1) : o.bow, cx = (wx + ax) / 2 - mz * bow, cz = (wz + az) / 2 + mx * bow;
  const m = Math.max(1, Math.min(16, Math.floor(ml / 35)));
  const ay = Math.max(to.y + f1, ground(ax, az) + 10);
  for (let j = 1; j <= m; j++) {
    const t = j / (m + 1), u = 1 - t;
    const x = u * u * wx + 2 * u * t * cx + t * t * ax, z = u * u * wz + 2 * u * t * cz + t * t * az;
    const fromStart = Math.hypot(x - wx, z - wz), toEnd = Math.hypot(ax - x, az - z);
    let y = ground(x, z) + o.cruise;
    y = Math.min(y, wy + fromStart * .47, ay + toEnd * .47);
    y = Math.max(y, o.heightAt(x, z) + 14);
    put(x, y, z);
  }
  put(ax, ay, az);
  put(to.x - ix * e2, to.y + f2, to.z - iz * e2);
  put(to.x, to.y, to.z);
  return n;
}

const horizontal = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Where a startled flock goes: a roost at least `minDistance` from the one it left, as nearly straight away from the
 * player as there is, preferring about 220 m. -1 when there is none that far.
 */
export function escapeTarget(sites: readonly Site[], from: number, player: Vec, rand: Rand, minDistance = 120): number {
  const f = sites[from], ax = f.x - player.x, az = f.z - player.z, al = Math.hypot(ax, az);
  let best = -1, bestScore = -Infinity;
  for (let j = 0; j < sites.length; j++) {
    if (j === from) continue;
    const dx = sites[j].x - f.x, dz = sites[j].z - f.z, d = Math.hypot(dx, dz);
    if (d < minDistance) continue;
    const align = al > 1 ? (dx * ax + dz * az) / (d * al) : 0;
    const score = align * 2 - Math.abs(d - 220) / 260 + rand() * .25;
    if (score > bestScore) { bestScore = score; best = j; }
  }
  return best;
}

export type CrossingOptions = {
  /** Neither end nearer the player than this: the birds leave and arrive out of sight, or too far off to see go. */
  minEnd: number;
  minLength: number; maxLength: number;
  /** How close the line passes the player (horizontally), so the crossing is seen. */
  passMin: number; passMax: number;
  /** Only roosts in the canopy (where a bird can appear and vanish), not ones with a perch. */
  hiddenOnly?: boolean;
};

/** Two roosts whose line passes within sight of the player, for a pair of crows commuting by day or the dusk stream. */
export function crossingPair(sites: readonly Site[], player: Vec, rand: Rand, o: CrossingOptions): [number, number] | undefined {
  let chosen: [number, number] | undefined, weight = 0;
  for (let i = 0; i < sites.length; i++) for (let j = 0; j < sites.length; j++) {
    if (i === j) continue;
    const a = sites[i], b = sites[j];
    if (o.hiddenOnly && (!a.hidden || !b.hidden)) continue;
    if (horizontal(a, player) < o.minEnd || horizontal(b, player) < o.minEnd) continue;
    const L = horizontal(a, b);
    if (L < o.minLength || L > o.maxLength) continue;
    const t = ((player.x - a.x) * (b.x - a.x) + (player.z - a.z) * (b.z - a.z)) / (L * L);
    // The near point is in the middle part of the line: the birds actually cross the player's sky, not just end near it.
    if (t < .15 || t > .85) continue;
    const pass = Math.hypot(a.x + (b.x - a.x) * t - player.x, a.z + (b.z - a.z) * t - player.z);
    if (pass < o.passMin || pass > o.passMax) continue;
    // A weighted draw (reservoir sampling), favouring lines that pass at about 40 m.
    const w = 1 / (1 + Math.abs(pass - 40) / 25);
    weight += w;
    if (rand() * weight < w) chosen = [i, j];
  }
  return chosen;
}

/**
 * The roost a resting flock is moved to while the player is far from where it was: the nearest one to the player that is
 * still at least `minHidden` m away (`minPerch` for a perch, which is drawn), and nearer than `current` by 40 m. -1 if none.
 */
export function homeNear(sites: readonly (Site & { perches?: readonly unknown[] })[], player: Vec, current: number, minHidden: number, minPerch: number): number {
  const now = current >= 0 ? horizontal(sites[current], player) : Infinity;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < sites.length; i++) {
    const d = horizontal(sites[i], player), visible = !!sites[i].perches?.length;
    if (d < (visible ? minPerch : minHidden) || d > now - 40 || d >= bestD) continue;
    best = i; bestD = d;
  }
  return best;
}
