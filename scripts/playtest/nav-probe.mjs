// Can the creature get at a player who hides behind a tree, and does it go between two trunks that stand closer
// together than its legs are wide? Real forest, real navigation and gait. For each case: did its head come within
// grabbing distance, how long that took against a straight run, and how long it stood still on the way.
//   node --experimental-strip-types --no-warnings scripts/playtest/nav-probe.mjs [--verbose]
import { createHeadlessWorld, heightAt } from './world.mjs';
const DT = 1 / 60, verbose = process.argv.includes('--verbose'), GRAB = 2.2, SPEED = 6.5;
globalThis.__nav={gap:0,astar:0,pull:0,round:0,iter:0,searches:0};
const w = await createHeadlessWorld({}); const e = w.encounters;
const treesNear = (x, z, r) => w.collisions.nearby(x, z, r).filter(c => c.tag === 'tree');
/** Drives the body at the player's position (as a hunt does) until its head is within reach or time runs out. */
function chase(start, player, seconds = 14) {
  w.streamForest(start); const yaw = Math.atan2(player.x - start.x, player.z - start.z);
  e.preview(start.x, start.z, yaw);
  const s0 = e.navigationStatus().position, direct = Math.hypot(player.x - s0[0], player.z - s0[2]);
  let t = 0, still = 0, closest = Infinity, reached, path = [];
  for (let i = 0; i < seconds / DT; i++) {
    t += DT; const p = e.navigationStatus().position;
    e.previewChase(DT, t, SPEED, player.x, player.z);
    const s = e.navigationStatus();
    const head = { x: s.position[0] + Math.sin(s.yaw) * 1.1, z: s.position[2] + Math.cos(s.yaw) * 1.1 };
    // The game's own rule: its head within grabbing distance, or the player within reach of its body (BODY_REACH 1.2 m).
    const reach = Math.min(Math.hypot(head.x - player.x, head.z - player.z), Math.max(0, Math.hypot(s.position[0] - player.x, s.position[2] - player.z) - 1.2));
    closest = Math.min(closest, reach);
    if (t > .8 && s.speed < .4) still += DT;
    if (i % 6 === 0) path.push([s.position[0], s.position[2]]);
    if (reach < GRAB) { reached = t; break; }
  }
  return { reached, closest, still, direct, ideal: .8 + Math.max(0, direct - GRAB - 1.1) / SPEED, path };
}
// --- A: the player stands close behind one trunk, the creature comes from straight in front of it.
const centres = [[-30, 40], [-120, 160], [60, 120], [-80, -20], [140, 60], [-160, 40], [40, 200], [-40, 110]];
let cases = [], pairs = [];
for (const [cx, cz] of centres) {
  w.streamForest({ x: cx, z: cz });
  const trees = treesNear(cx, cz, 40);
  for (const tree of trees.slice(0, 40)) {
    const angle = (tree.ax * 12.9898 + tree.az * 78.233) % (Math.PI * 2), dx = Math.sin(angle), dz = Math.cos(angle);
    const start = { x: tree.ax + dx * 13, z: tree.az + dz * 13 }, player = { x: tree.ax - dx * (tree.radius + .75), z: tree.az - dz * (tree.radius + .75) };
    if (Math.abs(heightAt(start.x, start.z) - heightAt(player.x, player.z)) > 3) continue;
    if (cases.filter(c => c.centre === cx).length < 5) cases.push({ centre: cx, tree, start, player });
  }
  for (let i = 0; i < trees.length; i++) for (let j = i + 1; j < trees.length; j++) {
    const a = trees[i], b = trees[j], gap = Math.hypot(a.ax - b.ax, a.az - b.az) - a.radius - b.radius;
    if (gap < 1.9 || gap > 3.2) continue;
    const mx = (a.ax + b.ax) / 2, mz = (a.az + b.az) / 2, l = Math.hypot(b.ax - a.ax, b.az - a.az), nx = -(b.az - a.az) / l, nz = (b.ax - a.ax) / l;
    if (pairs.filter(c => c.centre === cx).length < 3) pairs.push({ centre: cx, gap, mid: { x: mx, z: mz }, start: { x: mx + nx * 11, z: mz + nz * 11 }, player: { x: mx - nx * 5, z: mz - nz * 5 } });
  }
}
const summary = (name, list) => {
  const got = list.filter(r => r.reached !== undefined), slow = got.filter(r => r.reached > r.ideal * 1.6 + 1);
  console.log(`${name}: reached ${got.length} of ${list.length}`, '| mean time over a straight run', (got.reduce((a, r) => a + r.reached - r.ideal, 0) / Math.max(1, got.length)).toFixed(1), 's | slow (over 1.6x)', slow.length,
    '| mean standing still', (list.reduce((a, r) => a + r.still, 0) / list.length).toFixed(1), 's | never reached:', list.filter(r => r.reached === undefined).map(r => r.closest.toFixed(1) + ' m').join(', ') || 'none');
};
const A = cases.map(c => { const r = chase(c.start, c.player); if (verbose) console.log('  behind tree at', c.tree.ax.toFixed(0), c.tree.az.toFixed(0), 'r', c.tree.radius.toFixed(2), r.reached ? `reached in ${r.reached.toFixed(1)} s (straight ${r.ideal.toFixed(1)})` : `NOT reached, closest ${r.closest.toFixed(1)} m`, 'still', r.still.toFixed(1)); return r; });
summary('hiding behind a trunk', A);
const B = pairs.map(c => { const r = chase(c.start, c.player);
  // Did it go between the two trunks, or round the outside?
  const through = r.path.some(([x, z]) => Math.hypot(x - c.mid.x, z - c.mid.z) < c.gap / 2 + .3);
  r.through = through;
  if (verbose) console.log('  gap', c.gap.toFixed(2), 'm at', c.mid.x.toFixed(0), c.mid.z.toFixed(0), r.reached ? `reached in ${r.reached.toFixed(1)} s (straight ${r.ideal.toFixed(1)})` : `NOT reached, closest ${r.closest.toFixed(1)} m`, through ? 'went through' : 'went round', 'still', r.still.toFixed(1)); return r; });
summary('player beyond a 1.9 to 3.2 m gap', B);
console.log('went through the gap:', B.filter(r => r.through).length, 'of', B.length);
const plans = e.navigationStatus();
console.log('route planning:', plans.replans, 'plans,', (plans.planMs / plans.replans).toFixed(2), 'ms each on average, worst', plans.planWorst.toFixed(1), 'ms,', plans.planSlow, 'over 8 ms');
w.dispose(); process.exit(0);
