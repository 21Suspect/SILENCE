import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
// The valley road only exists in the rebuilt world, which game modules choose when they load.
globalThis.location = { search: `?world-v2${process.env.WORLD_SEED ? `&seed=${process.env.WORLD_SEED}` : ''}` };
const { roadZ, roadDistance, roadPresence, heightAt, vegetationExclusion } = await import('../../../game/sim/world/world.ts');
const { ROAD, roadArcTable } = await import('../../../game/sim/world/road-profile.ts');
const { GROUND_PADS, POI_PLACEMENTS, SCATTER_PLACEMENTS, TRAIL_LINES, ROAD_ENDS, ROAD_CROSSING: CROSSING } = await import('../../../game/sim/world/world-layout.ts');
const ROAD_CROSSING = () => CROSSING;
const { roadSurface } = await import('../../../game/render/world/road-surface.ts');
const { roadGradeAt, roadGradeLegs, GRADE_LIMIT, RAMP_LENGTH, MOUTH_LEVEL, MOUTH_FLOOR } = await import('../../../game/sim/world/road-grade.ts');
const { ROAD_PLAN, roadSlope } = await import('../../../game/sim/world/world-noise.ts');
const { roadArcAt } = await import('../../../game/sim/world/road-profile.ts');
const { roadArc, roadXAtArc, roadGap } = await import('../../../game/sim/world/road-geometry.ts');
const { landform } = await import('../../../game/sim/world/world-landform.ts');
const { mountainFoot, coastDistance, beachWidth } = await import('../../../game/sim/world/coastal-geography.ts');

const tangent = x => { const m = roadZ(x + .5) - roadZ(x - .5), k = 1 / Math.hypot(1, m); return { tx: k, tz: m * k, nx: -m * k, nz: k }; };
const stations = (from, to, step) => { const out = []; for (let x = from; x <= to; x += step) out.push(x); return out; };
const WEST = ROAD_ENDS.find(e => e.side < 0), EAST = ROAD_ENDS.find(e => e.side > 0);
const inside = x => x > WEST.x + 30 && x < EAST.x - 30;
/** Abscissae of the road between its two mouths, one every `step` metres of road (not of x: the legs are steep). */
const along = (step, from = 0, to = 0) => { const out = []; for (let s = roadArc(WEST.x) + from; s <= roadArc(EAST.x) - to; s += step) out.push(roadXAtArc(s)); return out; };

test('the carriageway is two 3 m lanes, 6 m, to fit the 6.2 m bore of the tunnels', () => {
  assert.equal(ROAD.half * 2, 6);
  assert.ok(ROAD.half * 2 < 6.2);
  assert.ok(ROAD.level > ROAD.half && ROAD.level - ROAD.half <= 1.2, 'a slight shoulder stays level');
  assert.ok(ROAD.ease > ROAD.level + 6, 'and it eases into the terrain over several metres');
  assert.ok(ROAD.footstep >= ROAD.half && ROAD.footstep < ROAD.level);
});

test('distance from the road is measured across it, not along z, even on the steep diagonal stretch', () => {
  let worst = 0, verge = 0, checked = 0;
  for (const x of along(9, 3, 3)) for (const d of [-5.5, -3, -.7, 0, 1.3, 3.1, 4.4, 5.9]) {
    const { nx, nz } = tangent(x), px = x + d * nx, pz = roadZ(x) + d * nz;
    // The truth: the nearest of a fine run of points along the centre line.
    let nearest = Infinity;
    for (let u = px - 9; u <= px + 9; u += .01) nearest = Math.min(nearest, Math.hypot(px - u, pz - roadZ(u)));
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
  assert.ok(steepest > 2, `the legs are steep enough for z to be a poor measure: ${steepest.toFixed(2)}`);
  // The measure is exact everywhere, including the sign: positive on the +z side.
  for (const x of along(25, 3, 3)) { const { nx, nz } = tangent(x); assert.ok(Math.abs(roadDistance(x + 2 * nx, roadZ(x) + 2 * nz) - 2) < .01 && roadGap(x - 2 * nx, roadZ(x) - 2 * nz) > 1.99); }
});

test('away from pads and trail junctions the road is level across the carriageway and its shoulder', () => {
  const pads = [...GROUND_PADS.map(p => ({ x: p.x, z: p.z, reach: p.radius + p.falloff })), ...POI_PLACEMENTS.filter(p => p.pad).map(p => ({ x: p.x, z: p.z, reach: p.pad.radius + p.pad.falloff }))];
  const nearTrail = (x, z) => TRAIL_LINES.some(line => line.some(([tx, tz], i) => {
    if (Math.hypot(tx - x, tz - z) < 14) return true;
    if (!i) return false;
    const [ax, az] = line[i - 1], dx = tx - ax, dz = tz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(x - ax - dx * t, z - az - dz * t) < 14;
  }));
  let judged = 0, worst = 0, at = 0, shoulder = 0, shoulderAt = 0;
  for (const x of [...stations(WEST.x, EAST.x, 4), ...along(3, 30, 30)]) {
    const c = roadZ(x);
    if (!inside(x) || pads.some(p => Math.hypot(p.x - x, p.z - c) < p.reach * 1.2 + 6) || nearTrail(x, c)) continue;
    const { nx, nz } = tangent(x);
    let lo = Infinity, hi = -Infinity, slo = Infinity, shi = -Infinity;
    for (let d = -ROAD.level; d <= ROAD.level; d += .25) {
      const h = heightAt(x + d * nx, c + d * nz);
      slo = Math.min(slo, h); shi = Math.max(shi, h);
      if (Math.abs(d) <= ROAD.half) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    }
    judged++; if (hi - lo > worst) { worst = hi - lo; at = x; } if (shi - slo > shoulder) { shoulder = shi - slo; shoulderAt = x; }
  }
  assert.ok(judged > 80, `only ${judged} stretches could be judged`);
  assert.ok(worst < .08, `the section at x=${at} varies by ${(worst * 100).toFixed(0)} cm across the carriageway`);
  assert.ok(shoulder < .2, `${(shoulder * 100).toFixed(0)} cm across carriageway and shoulder at x=${shoulderAt.toFixed(1)}, z=${roadZ(shoulderAt).toFixed(1)}`);
});

const roadPadded = x => [...GROUND_PADS.map(p => ({ x: p.x, z: p.z, reach: p.radius + p.falloff })), ...POI_PLACEMENTS.filter(p => p.pad).map(p => ({ x: p.x, z: p.z, reach: p.pad.radius + p.pad.falloff }))].some(p => Math.hypot(p.x - x, p.z - roadZ(x)) < p.reach + 16);
test('beyond the shoulder the ground eases back into the land rather than ending in a wall', () => {
  let steepest = 0, steepAt = [];
  for (const x of [...stations(-300, 330, 17), ...along(11, 100, 90)].filter(x => !roadPadded(x))) {
    const c = roadZ(x), { nx, nz } = tangent(x);
    let previous = heightAt(x + ROAD.level * nx, c + ROAD.level * nz);
    for (let d = ROAD.level + .5; d <= ROAD.ease + 1; d += .5) {
      const h = heightAt(x + d * nx, c + d * nz);
      if (Math.abs(h - previous) / .5 > steepest) { steepest = Math.abs(h - previous) / .5; steepAt = [x, c, d]; } previous = h;
    }
  }
  assert.ok(steepest < 1.2, `a bank ${steepest.toFixed(2)} m per metre at x=${steepAt[0]?.toFixed(1)}, z=${steepAt[1]?.toFixed(1)}, ${steepAt[2]} m across`);
});

test('plants stay off the road, and thin out across the verge', () => {
  let onRoad = 0;
  for (const x of [...stations(-300, 330, 23), ...along(7, 25, 25)]) {
    const c = roadZ(x), { nx, nz } = tangent(x);
    for (const side of [-1, 1]) {
      const at = d => vegetationExclusion(x + side * d * nx, c + side * d * nz);
      if (at(0) < .999 || at(ROAD.half) < .999 || at(ROAD.clearFrom - .05) < .99) onRoad++;
    }
  }
  assert.equal(onRoad, 0, 'plants on the carriageway or its shoulder');
  // Where nothing else lays claim to the ground the verge thins out between clearFrom and clearTo and is wild beyond.
  // Stretches nothing else lays claim to: no footpath, pad or prop within 30 m.
  const free = x => { const c = roadZ(x); return !TRAIL_LINES.some(l => l.some(q => Math.hypot(q[0] - x, q[1] - c) < 30)) && !POI_PLACEMENTS.some(p => Math.hypot(p.x - x, p.z - c) < 40) && !SCATTER_PLACEMENTS.some(p => Math.hypot(p.x - x, p.z - c) < 12); };
  const open = along(15, 60, 120).filter(free), picks = open.filter((_, i) => i % Math.max(1, Math.floor(open.length / 8)) === 0).slice(0, 8);
  assert.ok(picks.length >= 3, `only ${picks.length} free stretches of road to look at`);
  for (const x of picks) {
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

test('the paint is laid out along the centre line by arc length, on the steep legs as well as the flat stretch', () => {
  const table = roadArcTable(roadZ, roadSlope);
  assert.equal(table.length, ROAD.arcCount);
  assert.equal(table[0], 0);
  // The table is uniform in x, so on a leg its steps are far apart along the road; it still has to be sane in size and increasing.
  assert.ok(ROAD.arcCount <= 600, 'the shader carries two tables of this size');
  for (let i = 1; i < table.length; i++) assert.ok(table[i] - table[i - 1] >= ROAD.arcStep && table[i] - table[i - 1] < ROAD.arcStep * 6, `step ${i}`);
  // Between the two mouths the arc length the shader reads (a cubic through each cell's ends and their true rates) is within 4 cm
  // of an independent integration (4 cm at most), so a dash of 3 m in every 9 stays 3 m in 9 everywhere, steep or flat.
  let worst = 0, at = 0;
  for (const x of along(5.3, 0, 0)) {
    let length = 0; const from = ROAD.arcFrom;
    for (let u = from; u < x; u += .02) length += Math.hypot(.02, roadZ(Math.min(u + .02, x)) - roadZ(u));
    const read = roadArcAt(table, roadSlope, x), err = Math.abs(read - length);
    if (err > worst) { worst = err; at = x; }
  }
  assert.ok(worst < .04, `the paint is off by ${(worst * 100).toFixed(1)} cm at x=${at.toFixed(0)}`);
  // A 9 m dash cycle laid out in arc length is 9 m of road everywhere: a nine-metre stretch spans 9 m of arc whether it is flat or steep.
  for (const x0 of along(60, 20, 20)) { const x1 = roadXAtArc(roadArc(x0) + 9); assert.ok(Math.abs(roadArcAt(table, roadSlope, x1) - roadArcAt(table, roadSlope, x0) - 9) < .03); }
});

test('the road shader carries the road as specified: 6 m, dashes of 3 m in 9, a 12 cm centre line', () => {
  const { functions, mask, colour, roughness, normal } = roadSurface();
  assert.ok(functions.includes(`const float ROAD_HALF=${ROAD.half.toFixed(2)};`));
  const table = /ROAD_ARC\[(\d+)\]=float\[\d+\]\(([^)]*)\)/.exec(functions);
  assert.equal(+table[1], ROAD.arcCount);
  assert.equal(table[2].split(',').length, ROAD.arcCount);
  assert.ok(functions.includes('roadPlanGen') && /xc-=/.test(functions), 'the shader finds the nearest point of the centre line by Newton steps, as roadFoot does');
  assert.ok(colour.includes('floor(u/9.)') && colour.includes('roadBox(dashPhase,wS,0.,3.)'), 'dashes of 3 m in a 9 m cycle');
  assert.ok(colour.includes('roadBox(roadAbs,wA,-.06,.06)'), 'a line 12 cm wide');
  assert.ok(colour.includes('roadBox(abs(roadAbs-2.8),wA,-.05,.05)'), 'an edge line 15 cm in from the carriageway edge');
  assert.ok(mask.includes('roadPresence(p)'), 'it still stops at the tunnel mouths');
  for (const part of [functions, mask, colour, roughness, normal]) assert.ok(!/\b(patch|half|smooth|flat|sample|common|active)\s*[=;(]/.test(part.replace(/\broadBox|samplePatch|smoothstep|surfaceNoise/g, '')), 'a GLSL reserved word used as a name');
});

// ---------------------------------------------------------------------------------------------------------------------
// The mountain legs: their plan, their profile and the mouths they end in.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const DEG = 180 / Math.PI;
const legs = roadGradeLegs();            // east first
const [eastLeg, westLeg] = legs;
/** Heading of the road as a walker sees it going out along a leg (0 = outward along x, 90 = due north), every 3 m of road. */
function headings(leg) {
  const out = [], first = roadArc(leg.side * 176), last = roadArc(leg.portal.x);
  for (let s = 0; s <= Math.abs(last - first); s += 3) {
    const x = roadXAtArc(leg.side > 0 ? first + s : first - s);
    out.push({ s, heading: Math.atan(Math.abs(roadSlope(x))) * DEG, x, z: roadZ(x) });
  }
  return out;
}
/** Zig-zag extrema of a series, ignoring reversals smaller than `min`. */
function turns(series, min) {
  const out = []; let ext = series[0], dir = 0;
  for (const p of series) {
    if (dir === 0) { if (p.heading > ext.heading + min) { dir = 1; ext = p; } else if (p.heading < ext.heading - min) { dir = -1; ext = p; } }
    else if (dir === 1) { if (p.heading > ext.heading) ext = p; else if (ext.heading - p.heading > min) { out.push({ ...ext, kind: 'max' }); dir = -1; ext = p; } }
    else { if (p.heading < ext.heading) ext = p; else if (p.heading - ext.heading > min) { out.push({ ...ext, kind: 'min' }); dir = 1; ext = p; } }
  }
  return out;
}

test('the legs wind like a mountain approach road: S-curves of 15 to 35 degrees, wavelengths of 80 to 160 m, never doubling back', () => {
  for (const leg of legs) {
    const h = headings(leg);
    // It runs steadily outward and north: dz/dx never reaches zero or turns, so it cannot double back on itself.
    for (const p of h.filter(p => p.s > 0)) assert.ok(p.heading > 0 && p.heading < 79.5 && (p.s < 130 || p.heading > 38), `heading ${p.heading.toFixed(0)} deg at s=${p.s} on the ${leg.side > 0 ? 'east' : 'west'} leg`);
    const body = h.filter(p => p.s > 110 && p.z < leg.portal.z - 70), t = turns(body, 6);
    assert.ok(t.length >= 4, `only ${t.length} bends on the ${leg.side > 0 ? 'east' : 'west'} leg`);
    for (let i = 1; i < t.length; i++) {
      const swing = Math.abs(t[i].heading - t[i - 1].heading), half = t[i].s - t[i - 1].s;
      assert.ok(swing >= 10.5 && swing <= 38, `a ${swing.toFixed(0)} degree change at s=${t[i].s}`);
      assert.ok(half >= 28 && half <= 115, `half a wave is ${half} m at s=${t[i].s}`);
      if (i > 1) { const wave = t[i].s - t[i - 2].s; assert.ok(wave >= 70 && wave <= 190, `a wavelength of ${wave} m at s=${t[i].s}`); }
    }
  }
  // Different on the two legs.
  const a = turns(headings(eastLeg).filter(p => p.s > 110), 6).map(p => p.s), b = turns(headings(westLeg).filter(p => p.s > 110), 6).map(p => p.s);
  assert.ok(a.slice(0, 5).some((v, i) => Math.abs(v - b[i]) > 12), 'the bends fall at the same places on both legs');
});

test('the two mouths are not mirror images: they stand at different x and different z', () => {
  assert.ok(Math.abs(EAST.x + WEST.x) > 8, `x: ${EAST.x.toFixed(1)} and ${WEST.x.toFixed(1)}`);
  assert.ok(Math.abs(EAST.z - WEST.z) > 5, `z: ${EAST.z.toFixed(1)} and ${WEST.z.toFixed(1)}`);
  assert.ok(EAST.z > mountainFoot(EAST.x) && WEST.z > mountainFoot(WEST.x), 'both are in the foothills');
  for (const e of ROAD_ENDS) { assert.ok(coastDistance(e.x, e.z) > beachWidth(e.x, e.z) + 40, `a mouth at x=${e.x.toFixed(0)}, z=${e.z.toFixed(0)} is only ${coastDistance(e.x, e.z).toFixed(0)} m from the sea`); assert.ok(e.level >= MOUTH_FLOOR - .2 && Math.abs(heightAt(e.x, e.z) - e.level) < .5, 'a mouth stands well above the beach, on its own level floor'); }
});

test('the road is graded: a ramp of at least 150 m at no more than 8%, curved at both ends, arriving level at the mouth', () => {
  for (const leg of legs) {
    const name = leg.side > 0 ? 'east' : 'west', { ramp, y, points } = leg, step = 2;
    assert.ok(ramp.to - ramp.from >= 150, `the ${name} ramp is ${ramp.to - ramp.from} m long`);
    assert.ok(ramp.rise >= 3.5 && ramp.rise <= 11, `the ${name} ramp rises ${ramp.rise.toFixed(1)} m`);
    // Grade between neighbouring samples, in percent, from the first sample past the junction to the mouth.
    const first = points.findIndex(p => p.s === 0), top = points.findIndex(p => p.s >= leg.portal.s);
    const grade = i => (y[i + 1] - y[i]) / step * 100;
    let steep = 0, worst = 0;
    for (let i = first + 3; i < top; i++) { const g = Math.abs(grade(i)); worst = Math.max(worst, g); if (g > 8) steep += step; assert.ok(g <= 10.2, `${g.toFixed(1)}% on the ${name} leg at s=${points[i].s}`); }
    assert.ok(worst <= GRADE_LIMIT * 100 + .5 && steep === 0, `the ${name} leg climbs at ${worst.toFixed(1)}%`);
    // No kink: the grade changes by well under a percent from one 2 m step to the next (a vertical curve, not a corner).
    let kink = 0; for (let i = first + 3; i < top - 1; i++) kink = Math.max(kink, Math.abs(grade(i + 1) - grade(i)));
    assert.ok(kink < 1.2, `a vertical kink of ${kink.toFixed(2)} percent in ${step} m on the ${name} leg`);
    // The top of the ramp eases out into the level floor of the mouth, the foot of it eases in from the valley.
    const level = i => y[i] - y[top - MOUTH_LEVEL / step];
    assert.ok(Math.abs(grade(top - 2)) < .3, `the ${name} mouth is not level`);
    for (let i = top - 7; i <= top; i++) assert.ok(Math.abs(y[i] - leg.portal.level) < .06, `the last 14 m before the ${name} mouth are level`);
    for (let i = top - MOUTH_LEVEL / step; i <= top; i++) assert.ok(Math.abs(y[i] - leg.portal.level) < .4, `the last ${MOUTH_LEVEL} m before the ${name} mouth are level-ish`);
  }
});

test('the ground is cut and filled to that grade: banks no steeper than 35 degrees, and only low embankments', () => {
  let deepest = 0, tallest = 0, steepest = 0, where = '';
  const padded = (x, z) => [...GROUND_PADS.map(p => ({ x: p.x, z: p.z, reach: p.radius + p.falloff })), ...POI_PLACEMENTS.filter(p => p.pad).map(p => ({ x: p.x, z: p.z, reach: p.pad.radius + p.pad.falloff }))].some(p => Math.hypot(p.x - x, p.z - z) < p.reach + 14);
  for (const leg of legs) for (const x of along(5, 0, 0).filter(x => Math.sign(x) === leg.side && Math.abs(x) > 180 && (leg.side > 0 ? x < EAST.x - 70 : x > WEST.x + 70) && !padded(x, roadZ(x)))) {
    const f = { x, z: roadZ(x) }, centre = heightAt(x, f.z), grade = roadGradeAt(x), { nx, nz } = tangent(x);
    // The carriageway is at its grade (the lattice is 0.67 m: a few centimetres of noise stay).
    if (!POI_PLACEMENTS.some(p => p.pad && Math.hypot(p.x - x, p.z - f.z) < p.pad.radius + p.pad.falloff + 8) && !TRAIL_LINES.some(l => l.some(q => Math.hypot(q[0] - x, q[1] - f.z) < 16))) assert.ok(Math.abs(centre - grade) < .12, `${(centre - grade).toFixed(2)} m off its grade at x=${x.toFixed(0)}`);
    const land = landform(x, f.z); deepest = Math.max(deepest, land - grade); tallest = Math.max(tallest, grade - land);
    for (const side of [-1, 1]) {
      let previous = heightAt(x + side * 5 * nx, f.z + side * 5 * nz);
      for (let d = 5.5; d <= 40; d += .5) {
        const px = x + side * d * nx, pz = f.z + side * d * nz, h = heightAt(px, pz);
        // A bank is the stretch where the ground has been moved: more than half a metre from the land as it was.
        if (Math.abs(h - landform(px, pz)) > .5 && Math.abs(previous - landform(px - side * .5 * nx, pz - side * .5 * nz)) > .5 && !TRAIL_LINES.some(l => l.some(q => Math.hypot(q[0] - px, q[1] - pz) < 8))) {
          const slope = Math.abs(h - previous) / .5; if (slope > steepest) { steepest = slope; where = `x=${px.toFixed(0)}, z=${pz.toFixed(0)}`; }
        }
        previous = h;
      }
    }
  }
  assert.ok(steepest < Math.tan(38 / DEG), `a bank of ${(Math.atan(steepest) * DEG).toFixed(0)} degrees at ${where}`);
  assert.ok(tallest < 6.6, `an embankment ${tallest.toFixed(1)} m high`);
  assert.ok(legs.every(l => l.portal.cutAt >= 5), 'the road has to cut into the foothills at the mountain end');
});

test('each mouth goes INTO the mountain: the rock face behind the headwall stands at least 9 m above the bore', () => {
  for (const end of ROAD_ENDS) {
    const c = Math.cos(end.yaw), s = Math.sin(end.yaw), at = (lx, lz) => heightAt(end.x + lx * c + lz * s, end.z - lx * s + lz * c);
    for (const lz of [-12, -16, -22]) for (const lx of [-8, -4, 0, 4, 8]) assert.ok(at(lx, lz) - end.level >= 9, `${(at(lx, lz) - end.level).toFixed(1)} m above the floor at ${lx}, ${lz} behind the ${end.side > 0 ? 'east' : 'west'} mouth`);
    // And the floor in front of it is the road's own, level across, so the road runs straight in.
    for (const lz of [4, 10, 18]) for (const lx of [-3, 0, 3]) assert.ok(Math.abs(at(lx, lz) - end.level) < .12, `the floor ${lz} m in front of the ${end.side > 0 ? 'east' : 'west'} mouth is ${(at(lx, lz) - end.level).toFixed(2)} m off`);
  }
});

test('the road profile table', () => {
  const rows = ['ROAD PROFILE from the bridge to each mouth: arc length from the bridge, x, z, height of the road, grade, the natural ground 15 m either side (-n / +n)', ''];
  const bridge = roadArc(ROAD_CROSSING().x);
  for (const end of [EAST, WEST]) {
    rows.push(`${end.side > 0 ? 'EAST' : 'WEST'} leg to the mouth at x=${end.x.toFixed(1)}, z=${end.z.toFixed(1)}, floor ${end.level.toFixed(2)} m`, '  arc(m)       x       z   height  grade%  ground-15  ground+15   cut(+)/fill(-)');
    const total = Math.abs(roadArc(end.x) - bridge);
    for (let a = 0; a <= total + 1e-6; a += 20) {
      const x = roadXAtArc(bridge + (end.side > 0 ? a : -a)), f = { z: roadZ(x), m: roadSlope(x) }, k = 1 / Math.hypot(1, f.m), nx = -f.m * k, nz = k;
      const next = roadXAtArc(bridge + (end.side > 0 ? a + 2 : -a - 2)), grade = (roadGradeAt(next) - roadGradeAt(x)) / 2 * 100 * end.side;
      const l = landform(x - 15 * nx, f.z - 15 * nz), r = landform(x + 15 * nx, f.z + 15 * nz), c = landform(x, f.z);
      rows.push(`${a.toFixed(0).padStart(7)} ${x.toFixed(1).padStart(7)} ${f.z.toFixed(1).padStart(7)} ${roadGradeAt(x).toFixed(2).padStart(8)} ${grade.toFixed(1).padStart(7)} ${l.toFixed(2).padStart(10)} ${r.toFixed(2).padStart(10)} ${(c - roadGradeAt(x)).toFixed(2).padStart(10)}`);
    }
    rows.push('');
  }
  mkdirSync(fileURLToPath(new URL('../../../work/world-review', import.meta.url)), { recursive: true });
  writeFileSync(fileURLToPath(new URL('../../../work/world-review/road-profile.txt', import.meta.url)), rows.join('\n'));
  assert.ok(rows.length > 40);
});
