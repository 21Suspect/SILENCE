import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/register-ts-hooks.mjs';
// The valley road only exists in the rebuilt world, which game modules choose when they load.
globalThis.location = { search: '?world-v2' };
const { roadZ, roadDistance, roadPresence, heightAt, vegetationExclusion } = await import('../game/world.ts');
const { ROAD, roadArcTable } = await import('../game/road-profile.ts');
const { GROUND_PADS, POI_PLACEMENTS, TRAIL_LINES, ROAD_ENDS } = await import('../game/world-layout.ts');
const { roadSurface } = await import('../game/road-surface.ts');

const tangent = x => { const m = roadZ(x + .5) - roadZ(x - .5), k = 1 / Math.hypot(1, m); return { tx: k, tz: m * k, nx: -m * k, nz: k }; };
const stations = (from, to, step) => { const out = []; for (let x = from; x <= to; x += step) out.push(x); return out; };
const inside = x => x > ROAD_ENDS.find(e => e.side < 0).x + 30 && x < ROAD_ENDS.find(e => e.side > 0).x - 30;

test('the carriageway is two 3 m lanes, 6 m, to fit the 6.2 m bore of the tunnels', () => {
  assert.equal(ROAD.half * 2, 6);
  assert.ok(ROAD.half * 2 < 6.2);
  assert.ok(ROAD.level > ROAD.half && ROAD.level - ROAD.half <= 1.2, 'a slight shoulder stays level');
  assert.ok(ROAD.ease > ROAD.level + 6, 'and it eases into the terrain over several metres');
  assert.ok(ROAD.footstep >= ROAD.half && ROAD.footstep < ROAD.level);
});

test('distance from the road is measured across it, not along z, even on the steep diagonal stretch', () => {
  let worst = 0, verge = 0, checked = 0;
  for (const x of stations(-440, 440, 11)) for (const d of [-5.5, -3, -.7, 0, 1.3, 3.1, 4.4, 5.9]) {
    const { nx, nz } = tangent(x), px = x + d * nx, pz = roadZ(x) + d * nz;
    // The truth: the nearest of a fine run of points along the centre line.
    let nearest = Infinity;
    for (let u = px - 9; u <= px + 9; u += .02) nearest = Math.min(nearest, Math.hypot(px - u, pz - roadZ(u)));
    const error = Math.abs(roadDistance(px, pz) - nearest);
    // Exact enough on the carriageway, where it decides which side of the edge a stone lies; a little looser in the verge.
    if (Math.abs(d) <= 3.5) worst = Math.max(worst, error); else verge = Math.max(verge, error);
    checked++;
  }
  assert.ok(checked > 300);
  assert.ok(worst < .07, `off by ${worst.toFixed(3)} m on the carriageway`);
  assert.ok(verge < .22, `off by ${verge.toFixed(3)} m in the verge`);
  // Far away it only has to be large, and cheap.
  assert.ok(roadDistance(10, roadZ(10) + 300) > ROAD.ease);
  // The simple z measure is wrong by more than 20% somewhere on this road: this is why it is not used.
  let steepest = 0; for (const x of stations(-440, 440, 1)) steepest = Math.max(steepest, Math.hypot(1, roadZ(x + .5) - roadZ(x - .5)));
  assert.ok(steepest > 1.2);
});

test('away from pads and trail junctions the road is level across the carriageway and its shoulder', () => {
  const pads = [...GROUND_PADS.map(p => ({ x: p.x, z: p.z, reach: p.radius + p.falloff })), ...POI_PLACEMENTS.filter(p => p.pad).map(p => ({ x: p.x, z: p.z, reach: p.pad.radius + p.pad.falloff }))];
  const nearTrail = (x, z) => TRAIL_LINES.some(line => line.some(([tx, tz], i) => {
    if (Math.hypot(tx - x, tz - z) < 14) return true;
    if (!i) return false;
    const [ax, az] = line[i - 1], dx = tx - ax, dz = tz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(x - ax - dx * t, z - az - dz * t) < 14;
  }));
  let judged = 0, worst = 0, at = 0, shoulder = 0;
  for (const x of stations(-440, 440, 4)) {
    const c = roadZ(x);
    if (!inside(x) || pads.some(p => Math.hypot(p.x - x, p.z - c) < p.reach * 1.2 + 6) || nearTrail(x, c)) continue;
    const { nx, nz } = tangent(x);
    let lo = Infinity, hi = -Infinity, slo = Infinity, shi = -Infinity;
    for (let d = -ROAD.level; d <= ROAD.level; d += .25) {
      const h = heightAt(x + d * nx, c + d * nz);
      slo = Math.min(slo, h); shi = Math.max(shi, h);
      if (Math.abs(d) <= ROAD.half) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    }
    judged++; if (hi - lo > worst) { worst = hi - lo; at = x; } shoulder = Math.max(shoulder, shi - slo);
  }
  assert.ok(judged > 80, `only ${judged} stretches could be judged`);
  assert.ok(worst < .08, `the section at x=${at} varies by ${(worst * 100).toFixed(0)} cm across the carriageway`);
  assert.ok(shoulder < .2, `${(shoulder * 100).toFixed(0)} cm across carriageway and shoulder`);
});

test('beyond the shoulder the ground eases back into the land rather than ending in a wall', () => {
  let steepest = 0;
  for (const x of stations(-300, 330, 17)) {
    const c = roadZ(x), { nx, nz } = tangent(x);
    let previous = heightAt(x + ROAD.level * nx, c + ROAD.level * nz);
    for (let d = ROAD.level + .5; d <= ROAD.ease + 1; d += .5) {
      const h = heightAt(x + d * nx, c + d * nz);
      steepest = Math.max(steepest, Math.abs(h - previous) / .5); previous = h;
    }
  }
  assert.ok(steepest < 1.2, `a bank ${steepest.toFixed(2)} m per metre`);
});

test('plants stay off the road, and thin out across the verge', () => {
  let onRoad = 0;
  for (const x of stations(-300, 330, 23)) {
    const c = roadZ(x), { nx, nz } = tangent(x);
    for (const side of [-1, 1]) {
      const at = d => vegetationExclusion(x + side * d * nx, c + side * d * nz);
      if (at(0) < .999 || at(ROAD.half) < .999 || at(ROAD.clearFrom - .05) < .99) onRoad++;
    }
  }
  assert.equal(onRoad, 0, 'plants on the carriageway or its shoulder');
  // Where nothing else lays claim to the ground the verge thins out between clearFrom and clearTo and is wild beyond.
  for (const x of [30, 230, 330]) {
    const c = roadZ(x), { nx, nz } = tangent(x), at = d => vegetationExclusion(x + d * nx, c + d * nz);
    assert.ok(at(ROAD.clearFrom + .4) > at((ROAD.clearFrom + ROAD.clearTo) / 2) && at((ROAD.clearFrom + ROAD.clearTo) / 2) > at(ROAD.clearTo - .4), `no gradual verge at x=${x}`);
    assert.ok(at(ROAD.clearTo + .3) < .01, `still excluded past the verge at x=${x}`);
  }
});

test('the road stops at the tunnel mouths: none of it beyond them', () => {
  for (const end of ROAD_ENDS) {
    assert.equal(roadPresence(end.x - end.side * 20, roadZ(end.x - end.side * 20)), 1);
    assert.ok(roadPresence(end.x + end.side * 4, end.z) < .001);
    assert.ok(roadPresence(end.x + end.side * 30, end.z) === 0);
  }
});

test('the paint is laid out along the centre line by arc length', () => {
  const table = roadArcTable(roadZ);
  assert.equal(table.length, ROAD.arcCount);
  assert.equal(table[0], 0);
  for (let i = 1; i < table.length; i++) {
    const run = table[i] - table[i - 1];
    assert.ok(run >= ROAD.arcStep && run <= ROAD.arcStep * 1.5, `step ${i} is ${run} m`);
  }
  // Against an independent integration of the same curve.
  for (const i of [10, 40, 70, 119]) {
    let length = 0; const from = ROAD.arcFrom, to = ROAD.arcFrom + i * ROAD.arcStep;
    for (let x = from; x < to; x += .05) length += Math.hypot(.05, roadZ(x + .05) - roadZ(x));
    assert.ok(Math.abs(length - table[i]) < .15, `at ${i}: ${length} against ${table[i]}`);
  }
});

test('the road shader carries the road as specified: 6 m, dashes of 3 m in 9, a 12 cm centre line', () => {
  const { functions, mask, colour, roughness, normal } = roadSurface();
  assert.ok(functions.includes(`const float ROAD_HALF=${ROAD.half.toFixed(2)};`));
  const table = /ROAD_ARC\[(\d+)\]=float\[\d+\]\(([^)]*)\)/.exec(functions);
  assert.equal(+table[1], ROAD.arcCount);
  assert.equal(table[2].split(',').length, ROAD.arcCount);
  assert.ok(colour.includes('floor(u/9.)') && colour.includes('roadBox(dashPhase,wS,0.,3.)'), 'dashes of 3 m in a 9 m cycle');
  assert.ok(colour.includes('roadBox(roadAbs,wA,-.06,.06)'), 'a line 12 cm wide');
  assert.ok(colour.includes('roadBox(abs(roadAbs-2.8),wA,-.05,.05)'), 'an edge line 15 cm in from the carriageway edge');
  assert.ok(mask.includes('roadPresence(p)'), 'it still stops at the tunnel mouths');
  for (const part of [functions, mask, colour, roughness, normal]) assert.ok(!/\b(patch|half|smooth|flat|sample|common|active)\s*[=;(]/.test(part.replace(/\broadBox|samplePatch|smoothstep|surfaceNoise/g, '')), 'a GLSL reserved word used as a name');
});
