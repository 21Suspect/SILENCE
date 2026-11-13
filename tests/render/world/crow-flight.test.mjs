import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { buildRoute, createRoute, routeAt, planWaypoints, escapeTarget, crossingPair, homeNear } = await import('../../../game/render/world/crow-flight.ts');

const rng = (seed = 7) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const flat = () => 0, hilly = (x, z) => 8 * Math.sin(x * .02) + 5 * Math.cos(z * .03);
const route = (from, to, o) => { const w = new Float32Array(72), n = planWaypoints(w, from, to, { heightAt: flat, cruise: 30, bow: .1, burst: false, perch: false, ...o }); return { r: buildRoute(createRoute(), w, n), n, w }; };
const samples = (r, step = 2) => { const out = [], p = { x: 0, y: 0, z: 0 }; let hint = 0; for (let d = 0; d <= r.length; d += step) { hint = routeAt(r, d, p, hint); out.push({ ...p }); } return out; };
const headings = pts => pts.slice(1).map((p, i) => Math.atan2(p.x - pts[i].x, p.z - pts[i].z));
const turned = pts => { const h = headings(pts); let total = 0; for (let i = 1; i < h.length; i++) total += Math.abs(Math.atan2(Math.sin(h[i] - h[i - 1]), Math.cos(h[i] - h[i - 1]))); return total; };

test('a route runs from the first waypoint to the last, by arc length, without loops', () => {
  const { r } = route({ x: 0, y: 20, z: 0 }, { x: 300, y: 20, z: 80 });
  const p = { x: 0, y: 0, z: 0 };
  routeAt(r, 0, p); assert.ok(Math.hypot(p.x, p.y - 20, p.z) < 1e-3);
  routeAt(r, r.length, p); assert.ok(Math.hypot(p.x - 300, p.y - 20, p.z - 80) < 1e-3);
  assert.ok(r.length > Math.hypot(300, 80) && r.length < Math.hypot(300, 80) * 1.25, `length ${r.length.toFixed(1)}`);
  // Sampled every metre or two of arc, monotonic, and well within capacity.
  for (let i = 1; i < r.count; i++) assert.ok(r.s[i] > r.s[i - 1] && r.s[i] - r.s[i - 1] < 4);
  assert.ok(r.count <= 256);
  // A crow line, not a circle: under half a turn of heading change over the whole of it.
  const pts = samples(r);
  assert.ok(turned(pts) < Math.PI / 2, `turned ${(turned(pts) * 180 / Math.PI).toFixed(0)} degrees`);
});

test('routeAt is the same with or without a hint and clamps past the ends', () => {
  const { r } = route({ x: 0, y: 20, z: 0 }, { x: -200, y: 18, z: 150 });
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
  let hint = 0;
  for (let d = 0; d < r.length; d += 7.3) { hint = routeAt(r, d, a, hint); routeAt(r, d, b); assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-4); }
  routeAt(r, r.length + 50, a); routeAt(r, r.length, b); assert.deepEqual(a, b);
  routeAt(r, -5, a); assert.ok(Math.hypot(a.x, a.y - 20, a.z) < 1e-3);
});

test('a startled flock leaves away from the player and keeps going away, climbing steeply out of the trees', () => {
  const player = { x: -20, y: 0, z: 0 }, from = { x: 0, y: 6, z: 0 }, to = { x: 120, y: 18, z: 200 };
  const { r } = route(from, to, { away: { x: 1, z: 0 }, burst: true });
  const pts = samples(r, 1);
  // Horizontal distance from the player never shrinks by more than a whisker, all the way to the far roost.
  const dist = pts.map(p => Math.hypot(p.x - player.x, p.z - player.z));
  for (let i = 1; i < dist.length; i++) assert.ok(dist[i] > dist[i - 1] - .05, `back towards the player at ${i} m`);
  // Ten metres up within the first fifteen metres of flight.
  assert.ok(pts[15].y - from.y > 7, `climbed ${(pts[15].y - from.y).toFixed(1)} m`);
  assert.ok(turned(pts) < Math.PI * .6);
});

test('the middle of a route is at crow height over the ground, even over hills, and drops into the roost at the end', () => {
  const from = { x: 0, y: hilly(0, 0) + 18, z: 0 }, to = { x: 400, y: hilly(400, 100) + 18, z: 100 };
  const { r } = route(from, to, { heightAt: hilly, cruise: 30 });
  const pts = samples(r, 3), n = pts.length;
  for (const p of pts.slice(Math.floor(n * .3), Math.floor(n * .7))) {
    const over = p.y - hilly(p.x, p.z);
    assert.ok(over > 19 && over < 48, `height over ground ${over.toFixed(1)}`);
  }
  for (const p of pts) assert.ok(p.y - hilly(p.x, p.z) > 9, 'never down among the trees mid-route');
  // The last ten metres of arc come down at least five.
  const p = { x: 0, y: 0, z: 0 }; routeAt(r, r.length - 10, p);
  assert.ok(p.y - to.y > 4, `last ten metres drop ${(p.y - to.y).toFixed(1)} m`);
});

test('a startled flock picks a roost at least 120 m off, on the far side from the player', () => {
  const sites = [{ x: 0, y: 0, z: 0 }, { x: -200, y: 0, z: 0 }, { x: 60, y: 0, z: 30 }, { x: 210, y: 0, z: 40 }, { x: 20, y: 0, z: -230 }];
  const player = { x: -15, y: 0, z: 0 };
  for (let k = 0; k < 20; k++) assert.equal(escapeTarget(sites, 0, player, rng(k + 1)), 3);
  assert.equal(escapeTarget([{ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }], 0, player, rng()), -1, 'nothing far enough');
});

test('a commute is between two roosts out of sight of the player whose line passes within sight of them', () => {
  const sites = [
    { x: -200, y: 0, z: 60, hidden: true }, { x: 210, y: 0, z: 10, hidden: true }, { x: 30, y: 0, z: 40 },
    { x: 15, y: 0, z: 250, hidden: true }, { x: -60, y: 0, z: -40, hidden: true },
  ];
  const player = { x: 0, y: 0, z: 0 }, o = { minEnd: 110, minLength: 150, maxLength: 520, passMin: 12, passMax: 90, hiddenOnly: true };
  for (let k = 0; k < 30; k++) {
    const pair = crossingPair(sites, player, rng(k + 3), o);
    assert.ok(pair, 'found one');
    const [a, b] = pair.map(i => sites[i]);
    assert.ok(a.hidden && b.hidden);
    assert.ok(Math.hypot(a.x, a.z) >= 110 && Math.hypot(b.x, b.z) >= 110);
    const L = Math.hypot(b.x - a.x, b.z - a.z), t = (-a.x * (b.x - a.x) - a.z * (b.z - a.z)) / (L * L);
    const pass = Math.hypot(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    assert.ok(pass >= 12 && pass <= 90, `passes at ${pass.toFixed(0)} m`);
  }
  assert.equal(crossingPair(sites, { x: 2000, y: 0, z: 0 }, rng(), o), undefined, 'none in sight of a player far off');
});

test('a resting flock moves to the nearest roost that is not on top of the player, and a perch has to be further off', () => {
  const sites = [{ x: 400, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }, { x: 90, y: 0, z: 0, perches: [{}] }, { x: 130, y: 0, z: 0 }];
  assert.equal(homeNear(sites, { x: 0, y: 0, z: 0 }, 0, 70, 110), 3, 'not the 50 m one (too near), not the 90 m perch (a perch needs 110)');
  assert.equal(homeNear(sites, { x: 0, y: 0, z: 0 }, 3, 70, 110), -1, 'nothing 40 m nearer than where it is');
});
