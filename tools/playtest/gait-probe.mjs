// Measures how smoothly the body can travel when its motion is limited by the legs, as the game does it.
import * as THREE from 'three';
const root_ = process.cwd();
await import(root_ + '/tests/helpers/register-ts-hooks.mjs');
const { createSpiderGait } = await import(root_ + '/game/spider-gait.ts');
const { SPIDER_SCALE: S, LEG_MAX_TARSAL } = await import(root_ + '/game/spider-rig.ts');
const DT = 1 / 60;
const flat = (target, out) => { out.point.set(target.x, 0, target.z); out.normal.set(0, 1, 0); };
const bumpy = (target, out) => { const h = .25 * Math.sin(target.x * .9) * Math.cos(target.z * .7) + .12 * Math.sin(target.z * 2.3); out.point.set(target.x, h, target.z); out.normal.set(0, 1, 0); };
function run({ speed, seconds = 8, surface = flat, ride = v => THREE.MathUtils.lerp(1.9, 1.56, THREE.MathUtils.smoothstep(v, 1.5, 7)) * S, accel = Infinity }) {
  const root = new THREE.Group(); root.scale.setScalar(S); const body = new THREE.Group(); root.add(body);
  const rig = { setLeg() {} }, gait = createSpiderGait(root, body, rig);
  const anchor = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), forward = new THREE.Vector3(0, 0, 1);
  const cmd = { anchor, up, forward, surface, ride: 1.9 * S, width: 1, length: 1 };
  let v = 0, z = 0; const speeds = [], fractions = [], reach = []; let airborneMax = 0, swings = 0, prevSw = new Array(8).fill(false);
  for (let i = 0; i < seconds / DT; i++) {
    const t = (i + 1) * DT, want = typeof speed === 'function' ? speed(t) : speed;
    v += Math.max(-accel * DT, Math.min(accel * DT, want - v));
    const dz = v * DT, f = gait.movementAllowance(0, 0, dz, 0);
    z += dz * f; anchor.set(0, surface === flat ? 0 : 0, z); cmd.pace = v; cmd.ride = ride(gait.speed);
    gait.update(DT, t, cmd);
    if (t > 2) { speeds.push(dz * f / DT); fractions.push(f); reach.push(Math.max(...gait.legs.map(l => l.reachRatio))); airborneMax = Math.max(airborneMax, gait.legs.filter(l => l.swinging).length); }
    gait.legs.forEach((l, k) => { if (l.swinging && !prevSw[k] && t > 2) swings++; prevSw[k] = l.swinging; });
  }
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length, sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);
  let worstDrop = 0; for (let i = 1; i < speeds.length; i++) worstDrop = Math.max(worstDrop, speeds[i - 1] - speeds[i]);
  return { mean, sd, min: Math.min(...speeds), limited: fractions.filter(f => f < .999).length / fractions.length, minFraction: Math.min(...fractions), reach: Math.max(...reach), airborneMax, hz: swings / 8 / (seconds - 2), worstDrop };
}
console.log('S', S, 'LEG_MAX_TARSAL', LEG_MAX_TARSAL);
console.log('speed  got    sd    min   limited minFr reach  air  Hz   worstDrop(m/s per frame)');
for (const surface of [flat, bumpy]) { console.log(surface === flat ? '--- flat' : '--- bumpy');
  for (const speed of [1, 2, 4, 6.5, 9, 11.2, 13.5]) { const r = run({ speed, surface });
    console.log(String(speed).padEnd(6), r.mean.toFixed(2).padEnd(6), r.sd.toFixed(2).padEnd(5), r.min.toFixed(2).padEnd(5), (r.limited * 100).toFixed(0).padStart(4) + '%  ', r.minFraction.toFixed(2).padEnd(5), r.reach.toFixed(3).padEnd(6), String(r.airborneMax).padEnd(4), r.hz.toFixed(1).padEnd(4), r.worstDrop.toFixed(2)); } }
