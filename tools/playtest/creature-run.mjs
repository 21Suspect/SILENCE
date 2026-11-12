// How smoothly does the real creature travel? Runs the real body (navigation, gait, limb limits) through the real
// forest at a commanded speed and reports how closely its actual speed follows, and how steadily.
//   node --experimental-strip-types --no-warnings tools/playtest/creature-run.mjs [--verbose]
import { createHeadlessWorld, heightAt } from './world.mjs';
const DT = 1 / 60, verbose = process.argv.includes('--verbose');
const w = await createHeadlessWorld({});
const e = w.encounters;
/** A straight run from (x, z) along `yaw`, speed following `profile(t)`. */
function run(name, x, z, yaw, profile, seconds = 9, steer) {
  w.streamForest({ x, z }); e.preview(x, z, yaw);
  let t = 0, held = 0; const rows = [];
  for (let i = 0; i < seconds / DT; i++) {
    t += DT; const want = profile(t);
    if (steer) { const p = e.navigationStatus().position; e.previewHeading(steer(p[0], p[2])); }
    e.previewStep(DT, t, want);
    const s = e.navigationStatus(); w.streamForest({ x: s.position[0], z: s.position[2] });
    if (t > 2.5 && s.limitedBy && s.speed < s.plannedSpeed * .9) held++;
    rows.push({ t, want, speed: s.speed, y: s.position[1], yaw: s.yaw, x: s.position[0], z: s.position[2], planned: s.plannedSpeed ?? NaN });
  }
  const steady = rows.filter(r => r.t > 2.5);
  const mean = steady.reduce((a, r) => a + r.speed, 0) / steady.length, wantMean = steady.reduce((a, r) => a + r.want, 0) / steady.length;
  // Jerkiness: how much speed changes from one frame to the next beyond what the commanded profile asks.
  let jerk = 0, worstDrop = 0, stalls = 0, yawJitter = 0, bob = 0;
  for (let i = 1; i < steady.length; i++) {
    const dv = steady[i].speed - steady[i - 1].speed, dw = steady[i].want - steady[i - 1].want;
    jerk += Math.abs(dv - dw); worstDrop = Math.max(worstDrop, -(dv - dw));
    if (steady[i].want > 1 && steady[i].speed < steady[i].want * .5) stalls++;
    if (i > 1) { const a = steady[i].yaw - steady[i - 1].yaw, b = steady[i - 1].yaw - steady[i - 2].yaw; yawJitter += Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      bob += Math.abs((steady[i].y - steady[i - 1].y) - (steady[i - 1].y - steady[i - 2].y)); }
  }
  const n = steady.length - 1, dist = Math.hypot(rows.at(-1).x - x, rows.at(-1).z - z);
  console.log(name.padEnd(30), 'want', wantMean.toFixed(1).padStart(5), 'got', mean.toFixed(2).padStart(5), `(${(mean / wantMean * 100).toFixed(0)}%)`.padStart(6),
    '| held by legs', (held / n * 100).toFixed(0).padStart(3) + '%', '| frame-to-frame speed change', (jerk / n).toFixed(3).padStart(6), 'm/s | worst drop', worstDrop.toFixed(2).padStart(5), '| under half speed', (stalls / n * 100).toFixed(0).padStart(3) + '%',
    '| yaw jitter', (yawJitter / n * 1000).toFixed(1).padStart(5), 'mrad | bob', (bob / n * 1000).toFixed(1).padStart(5), 'mm | travelled', dist.toFixed(0), 'm');
  if (verbose) console.log(rows.filter((_, i) => i % 6 === 0 && i > 120).slice(0, 50).map(r => r.speed.toFixed(1)).join(' '));
  return { mean, want: wantMean, jerk: jerk / n, worstDrop, stalls: stalls / n, held: held / n };
}
const ramp = (to, a = 10) => t => Math.min(to, t * a);
const { roadZ, pathX } = (await import('../../game/sim/world/world.ts'));
// Along the road it steers for the centre line a little way ahead; along the trail likewise. In the forest it holds a heading.
const alongRoad = (x, z) => Math.atan2(14, roadZ(x + 14) - z), alongTrail = (x, z) => Math.atan2(pathX(z + 14) - x, 14);
const places = [['forest by the start', -30, 40, .4], ['forest north-west', -120, 160, 2.2], ['along the road', -60, null, Math.PI / 2, alongRoad], ['along the main trail', null, 60, 0, alongTrail]];
for (const [label, px, pz, yaw, steer] of places) {
  const x = px ?? pathX(pz), z = pz ?? roadZ(px);
  console.log('---', label, `(${x.toFixed(0)}, ${z.toFixed(0)})`, 'ground', heightAt(x, z).toFixed(1));
  for (const v of [2.5, 5, 7.5, 10, 13.5]) run(`steady ${v} m/s`, x, z, yaw, ramp(v), 9, steer);
  run('surging 5 to 12 m/s', x, z, yaw, t => 8.5 + 3.5 * Math.sin(t * 1.3), 9, steer);
}
w.dispose();
process.exit(0);
