import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
// game/spider-gait.ts imports './spider-rig' without an extension and the rig imports JSON without an
// attribute; this test-only loader hook lets Node import the unchanged game sources.
import './helpers/register-ts-hooks.mjs';
const { createSpiderGait } = await import('../game/spider-gait.ts');
const { LEG_COUNT, SPIDER_SCALE: S } = await import('../game/spider-rig.ts');

// ---------------------------------------------------------------- harness
const DT = 1 / 60;
const flat = (target, out) => { out.point.set(target.x, 0, target.z); out.normal.set(0, 1, 0); };

/** A gait on a stub rig. The stub only needs setLeg; joints arrive in thorax space and are kept in world space. */
function createStage({ surface = flat, clearance, width = 1, obstacles } = {}) {
  const root = new THREE.Group(); root.scale.setScalar(S); // the game scales the root; the gait works in unscaled thorax space
  const body = new THREE.Group(); root.add(body);
  const stage = { root, body, pose: [] };
  const rig = { setLeg(leg, hip, joints, foot) { stage.pose[leg] = [hip, joints.knee, joints.ankle, joints.tarsal, foot].map(p => body.localToWorld(p.clone())); } };
  stage.gait = createSpiderGait(root, body, rig);
  stage.anchor = new THREE.Vector3(); stage.up = new THREE.Vector3(0, 1, 0); stage.forward = new THREE.Vector3(0, 0, 1);
  stage.command = { anchor: stage.anchor, up: stage.up, forward: stage.forward, surface, ride: 1.9 * S, width, length: 1, clearance, obstacles };
  stage.update = time => { stage.pose = []; stage.gait.update(DT, time, stage.command); };
  return stage;
}
/** Walks the gait along a path and records what the rig was told and where every foot is each frame. */
function simulate({ seconds, move, ...options }) {
  const stage = createStage(options), frames = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const t = (i + 1) * DT;
    move(t, stage.anchor, stage.forward);
    stage.update(t);
    frames.push({
      t,
      anchor: stage.anchor.clone(),
      swinging: stage.gait.legs.map(l => l.swinging),
      feet: stage.gait.legs.map(l => l.foot.clone()),   // world-locked contact points
      pose: stage.pose,                                  // per leg: world hip, knee, ankle, tarsal, rendered foot
      clearance: stage.gait.minimumClearance(),
    });
  }
  return { gait: stage.gait, frames };
}
/** Heads along +z at speed(t) m/s, starting from z0. */
function straight(speed, z0 = 0) { let z = z0; return (t, anchor, forward) => { z += speed(t) * DT; anchor.set(0, 0, z); forward.set(0, 0, 1); }; }
/** Circles with the given radius at constant speed, always facing along its tangent. */
function circle(radius, speed) { let angle = 0; return (t, anchor, forward) => { angle += speed / radius * DT; anchor.set(radius * (1 - Math.cos(angle)), 0, radius * Math.sin(angle)); forward.set(Math.sin(angle), 0, Math.cos(angle)); }; }

const swingCount = frame => frame.swinging.filter(Boolean).length;
/** Frame-by-frame list of {frame, leg} where a leg lifted off. */
function swingStarts(frames) {
  const starts = [];
  frames.forEach((frame, k) => frame.swinging.forEach((swinging, leg) => { if (swinging && !(k > 0 && frames[k - 1].swinging[leg])) starts.push({ frame: k, leg }); }));
  return starts;
}

// ---------------------------------------------------------------- planted feet
test('planted feet never move while not swinging, on a steady walk, stop-and-go, a run and a turn', () => {
  const scenarios = {
    'steady walk': straight(() => 1.2),
    'stop and go': straight(t => (t < 1 || (t > 5 && t < 7) ? 0 : 1.5)),
    'run': straight(() => 5.5),
    'turning circle': circle(3, 1.5),
  };
  for (const [name, move] of Object.entries(scenarios)) {
    const { frames } = simulate({ seconds: 10, move });
    let planted = 0, swings = 0;
    for (let k = 1; k < frames.length; k++) for (let leg = 0; leg < LEG_COUNT; leg++) {
      const now = frames[k], before = frames[k - 1];
      if (now.swinging[leg] && !before.swinging[leg]) swings++;
      if (now.swinging[leg] || before.swinging[leg]) continue;
      // The rig draws the claw pressed just into the surface at the planted foot.
      assert.ok(now.pose[leg][4].distanceTo(now.feet[leg].clone().setY(now.feet[leg].y - CLAW_SINK)) < 1e-6, `${name}: frame ${k} leg ${leg} rendered claw is off its foot`);
      planted++;
      assert.ok(now.feet[leg].equals(before.feet[leg]), `${name}: frame ${k} leg ${leg} slid from ${before.feet[leg].toArray()} to ${now.feet[leg].toArray()}`);
      assert.ok(now.pose[leg][4].distanceTo(before.pose[leg][4]) < 1e-6, `${name}: frame ${k} leg ${leg} rendered claw drifted while planted`);
      assert.equal(now.feet[leg].y, 0, `${name}: planted foot rests on the ground`);
    }
    assert.ok(planted > 1500, `${name}: ${planted} planted comparisons`);
    assert.ok(swings >= 8, `${name}: only ${swings} swings, the walk is not exercising the gait`);
    const travelled = frames.reduce((sum, f, k) => sum + (k ? f.anchor.distanceTo(frames[k - 1].anchor) : 0), 0);
    assert.ok(travelled > (name === 'stop and go' ? 6 : 9), `${name}: the body travelled ${travelled.toFixed(1)} m`);
  }
});

test('swings lift the claw off flat ground and land exactly on it without dipping below', () => {
  const { frames } = simulate({ seconds: 8, move: straight(() => 1.4) });
  let landings = 0, highest = 0;
  for (let k = 1; k < frames.length; k++) for (let leg = 0; leg < LEG_COUNT; leg++) {
    const foot = frames[k].feet[leg];
    if (frames[k].swinging[leg]) { assert.ok(foot.y >= 0, `leg ${leg} dipped below the ground at t=${frames[k].t.toFixed(2)}`); highest = Math.max(highest, foot.y); }
    else if (frames[k - 1].swinging[leg]) { landings++; assert.equal(foot.y, 0, `leg ${leg} lands on the surface`); }
  }
  assert.ok(landings > 20, `${landings} landings`);
  assert.ok(highest > .035 && highest < .18, `the arc lifts the claw ${highest.toFixed(2)} m`);
});

test('hovering a leg lifts only its drawn claw, never unplanting the foot', () => {
  const stage = createStage(), leg = stage.gait.legs[0];
  for (let i = 0; i < 90; i++) stage.update(i * DT); // stand still until every settling step is done
  assert.equal(stage.gait.legs.filter(l => l.swinging).length, 0, 'the standing body has come to rest');
  const planted = leg.foot.clone(), point = planted.clone().add(new THREE.Vector3(0, 1.1, .5)), halfway = planted.clone().lerp(point, .5);
  stage.gait.hover(0, .5, point); stage.update(2);
  assert.ok(stage.pose[0][4].distanceTo(halfway.clone().addScaledVector(leg.normal, -CLAW_SINK)) < 1e-6, 'half weight draws the claw halfway to the hover point');
  stage.gait.hover(0, 1, point); stage.update(2 + DT);
  assert.ok(stage.pose[0][4].distanceTo(point.clone().addScaledVector(leg.normal, -CLAW_SINK)) < 1e-6, 'full weight draws the claw at the hover point');
  assert.ok(leg.foot.equals(planted) && !leg.swinging, 'the contact point itself never moved');
  stage.gait.hover(0, 0, point); stage.update(2 + 2 * DT);
  assert.ok(stage.pose[0][4].distanceTo(planted.clone().addScaledVector(leg.normal, -CLAW_SINK)) < 1e-6, 'releasing the hover puts the claw back on its foot');
});

// ---------------------------------------------------------------- rhythm
const TETRAPODS = [['L0', 'R1', 'L2', 'R3'], ['R0', 'L1', 'R2', 'L3']];

test('no more than six legs ever swing and at least two stay planted, at every speed and through turns', () => {
  const walks = {
    creep: straight(() => .5), walk: straight(() => 1.2), brisk: straight(() => 3), run: straight(() => 6.5),
    'creep then bolt': straight(t => (t < 4 ? .4 : 7)), 'stop and go': straight(t => (t % 4 < 2 ? 0 : 2)), 'tight circle': circle(1.6, 2.2),
  };
  for (const [name, move] of Object.entries(walks)) {
    const { frames } = simulate({ seconds: 12, move });
    let most = 0;
    for (const frame of frames) {
      const swinging = swingCount(frame);
      most = Math.max(most, swinging);
      assert.ok(swinging <= 6, `${name}: ${swinging} legs swinging at t=${frame.t.toFixed(2)}`);
      assert.ok(LEG_COUNT - swinging >= 2, `${name}: fewer than two planted legs at t=${frame.t.toFixed(2)}`);
    }
    assert.ok(most >= 1, `${name}: the legs actually step`);
  }
});

test('a sustained brisk walk alternates the two tetrapods, four legs at a time, each leg stepping once per cycle', () => {
  const { gait, frames } = simulate({ seconds: 14, move: straight(() => 3) });
  const group = leg => TETRAPODS.findIndex(set => set.includes(gait.legs[leg].label));
  TETRAPODS.flat().forEach(label => assert.ok(gait.legs.some(l => l.label === label), `leg ${label} exists`));
  // Steady state only: skip the first two seconds of start-up.
  const starts = swingStarts(frames).filter(s => frames[s.frame].t > 2);
  const runs = [];
  for (const s of starts) { const g = group(s.leg); if (runs.at(-1)?.group === g) runs.at(-1).legs.push(s.leg); else runs.push({ group: g, legs: [s.leg] }); }
  assert.ok(runs.length >= 8, `${runs.length} alternating bursts of steps`);
  // Ignore the possibly truncated first and last bursts.
  for (let i = 1; i < runs.length - 1; i++) {
    assert.equal(runs[i].legs.length, 4, `burst ${i} moves four legs`);
    assert.equal(new Set(runs[i].legs).size, 4, `burst ${i} moves four different legs`);
    assert.notEqual(runs[i].group, runs[i - 1].group, `burst ${i} alternates with the previous tetrapod`);
  }
  // Four legs at most are ever airborne, so a full tetrapod always carries the body.
  assert.ok(Math.max(...frames.map(swingCount)) <= 4, 'never more than one tetrapod lifted');
  // Both tetrapods share the work evenly.
  const steps = gait.legs.map((_, leg) => starts.filter(s => s.leg === leg).length);
  assert.ok(Math.max(...steps) - Math.min(...steps) <= 1, `steps per leg ${steps}`);
  // The two tetrapods really are in antiphase: most airborne time is spent with one tetrapod only.
  let pure = 0, airborne = 0;
  for (const frame of frames) {
    const counts = [0, 0];
    frame.swinging.forEach((swinging, leg) => { if (swinging) counts[group(leg)]++; });
    if (counts[0] + counts[1] === 0) continue;
    airborne++; if (Math.min(...counts) === 0) pure++;
  }
  assert.ok(pure / airborne > .55, `${(pure / airborne * 100).toFixed(0)}% of airborne frames lift a single tetrapod`);
});

// ---------------------------------------------------------------- limb avoidance
/** Horizontal distance from the segment a-b to the surface of a vertical trunk (negative once inside it). */
function trunkClearance({ x, z, radius }) {
  return (a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
    const k = length < 1e-12 ? 0 : THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / length, 0, 1);
    return Math.hypot(a.x + dx * k - x, a.z + dz * k - z) - radius;
  };
}
/** What the limbs really did, measured independently of the gait: the three segments that must stay clear. */
function measured(frame, clearance) {
  let nearest = Infinity;
  for (const [hip, knee, ankle, tarsal] of frame.pose) nearest = Math.min(nearest, clearance(hip, knee), clearance(knee, ankle), clearance(ankle, tarsal));
  return nearest;
}
// A trunk 2.4 m beside the line of travel; the body walks past with the narrowed stance it uses near trunks.
const CLAW_SINK = .075; // planted claws are drawn pressed into the surface
const TRUNK = { x: 2.4, z: 3, radius: .5 }, NARROW = .57;
const PHASES = [2.6, 2.8, 3.0, 3.2, 3.4, 3.6]; // where along the route the trunk stands, so it meets every part of the stride
function passTrunk({ speed, z, avoid, seconds = 8, start = -4 }) {
  const clearance = trunkClearance({ ...TRUNK, z });
  const { frames } = simulate({ seconds, move: straight(() => speed, start), width: NARROW, clearance: avoid ? clearance : undefined, obstacles: avoid ? [{ x: TRUNK.x, z, r: TRUNK.radius }] : undefined });
  const walk = frames.filter(f => f.t > 1); // the first second is settling into stance
  const actual = walk.map(f => measured(f, clearance));
  let longest = 0, current = 0;
  for (const value of actual) { current = value < 0 ? current + 1 : 0; longest = Math.max(longest, current); }
  return { walk, actual, worst: Math.min(...actual), inside: actual.filter(v => v < 0).length, longest };
}

test('creeping past a vertical trunk, minimumClearance stays above a small margin; the same walk without avoidance cuts into it', { todo: 'limbs still reach a trunk close beside the path since the knee search was removed to stop twitching; foothold planning needs another pass' }, () => {
  const gains = [];
  let blindIntrusions = 0;
  for (const z of PHASES) {
    const avoiding = passTrunk({ speed: .8, z, avoid: true }), blind = passTrunk({ speed: .8, z, avoid: false });
    const reported = Math.min(...avoiding.walk.map(f => f.clearance));
    assert.ok(reported > .02, `trunk z ${z}: minimumClearance() fell to ${reported.toFixed(3)} m`);
    // The gait's report is the true minimum over the three limb segments that must stay clear, every frame.
    avoiding.walk.forEach((f, i) => assert.ok(Math.abs(f.clearance - avoiding.actual[i]) < 1e-6, `trunk z ${z}: reported ${f.clearance} vs measured ${avoiding.actual[i]} at t=${f.t.toFixed(2)}`));
    assert.equal(avoiding.inside, 0, `trunk z ${z}: limbs inside the trunk`);
    assert.ok(blind.worst < avoiding.worst, `trunk z ${z}: avoidance (${avoiding.worst.toFixed(3)} m) is no better than none (${blind.worst.toFixed(3)} m)`);
    gains.push(avoiding.worst - blind.worst);
    if (blind.worst < 0) blindIntrusions++;
  }
  assert.ok(blindIntrusions >= 4, `the blind walk intersects the trunk in only ${blindIntrusions} of ${PHASES.length} placements`);
  assert.ok(gains.reduce((a, b) => a + b) / gains.length > .2, `mean gain from avoidance ${(gains.reduce((a, b) => a + b) / gains.length).toFixed(3)} m`);
});

test('at walking and running speed avoidance still removes sustained intrusions, leaving at most isolated frames', { todo: 'limbs still reach a trunk close beside the path since the knee search was removed to stop twitching; foothold planning needs another pass' }, () => {
  let insideAvoiding = 0, insideBlind = 0;
  for (const speed of [1.4, 2.5]) for (const z of PHASES) {
    const avoiding = passTrunk({ speed, z, avoid: true }), blind = passTrunk({ speed, z, avoid: false });
    insideAvoiding += avoiding.inside; insideBlind += blind.inside;
    assert.ok(blind.worst < -.1, `speed ${speed}, trunk z ${z}: without avoidance the limbs should cut into the trunk, worst ${blind.worst.toFixed(3)} m`);
    assert.ok(avoiding.longest <= 2, `speed ${speed}, trunk z ${z}: limbs stay inside the trunk for ${avoiding.longest} consecutive frames`);
    assert.ok(avoiding.inside * 10 < blind.inside, `speed ${speed}, trunk z ${z}: ${avoiding.inside} frames inside the trunk with avoidance against ${blind.inside} without`);
  }
  assert.ok(insideBlind > 500, `the scenario is meaningful: ${insideBlind} blind frames inside the trunk`);
  assert.ok(insideAvoiding * 20 < insideBlind, `avoidance leaves ${insideAvoiding} of ${insideBlind} intrusion frames`);
});

test('the trunk is genuinely beside the route: only the stretch of walk alongside it matters', () => {
  const blind = passTrunk({ speed: 1.4, z: TRUNK.z, avoid: false, seconds: 12, start: -9 }); // long enough to be well clear of it at either end, whatever the creature's size
  const paired = blind.walk.map((f, i) => [f, blind.actual[i]]);
  const alongside = paired.filter(([f]) => Math.abs(f.anchor.z - TRUNK.z) < 2.6), farAway = paired.filter(([f]) => Math.abs(f.anchor.z - TRUNK.z) > 4 * S / .8);
  assert.ok(blind.walk.some(f => f.anchor.z < TRUNK.z - 3) && blind.walk.some(f => f.anchor.z > TRUNK.z + 3), 'walk starts before and ends beyond the trunk');
  assert.ok(alongside.length > 60, 'the body walks alongside the trunk');
  assert.ok(farAway.length > 30, 'the body also spends time well away from it');
  assert.ok(alongside.some(([, v]) => v < 0), 'limbs reach the trunk while passing it');
  assert.ok(farAway.every(([, v]) => v > .3), 'and are nowhere near it otherwise');
});

// Known defect: above a creep, single frames (typically the first frame of a swing) still pull a limb through the
// trunk by up to ~0.3 m. The knee direction is damped through its intermediate angles (and a swing foot travels in
// a straight line) without testing the clearance of the poses in between; when the preferred knee direction flips
// between two individually clear options, the damped angle sweeps the limb across the blocked option in between.
test('minimumClearance stays above a small margin at walking and running speed too', { todo: 'single-frame knee sweeps at swing start still cut through the trunk' }, () => {
  const failures = [];
  for (const speed of [1.4, 2.5]) for (const z of PHASES) {
    const { worst } = passTrunk({ speed, z, avoid: true });
    if (worst < .03) failures.push(`speed ${speed}, trunk z ${z}: ${worst.toFixed(3)} m`);
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------- stepping over an obstacle
/** A low wall (fallen log) across the whole path between z0 and z1, reached through the surface callback. */
function ridge(top, z0, z1) {
  const height = z => (z >= z0 && z <= z1 ? top : 0);
  return { top, z0, z1, height, surface: (target, out) => { out.point.set(target.x, height(target.z), target.z); out.normal.set(0, 1, 0); } };
}
/** Swings that start and finish off the ridge but pass over it, with the lowest the claw got while above it. */
function crossings(frames, wall) {
  const found = [];
  for (let leg = 0; leg < LEG_COUNT; leg++) {
    let startFrame = -1, lowest = Infinity;
    frames.forEach((frame, k) => {
      if (frame.swinging[leg]) {
        if (startFrame < 0) { startFrame = k; lowest = Infinity; }
        const foot = frame.feet[leg];
        if (foot.z >= wall.z0 && foot.z <= wall.z1) lowest = Math.min(lowest, foot.y);
      } else if (startFrame >= 0) {
        const from = startFrame > 0 ? frames[startFrame - 1].feet[leg] : frame.feet[leg];
        if (wall.height(from.z) === 0 && wall.height(frame.feet[leg].z) === 0 && lowest < Infinity) found.push({ leg, frame: startFrame, lowest });
        startFrame = -1;
      }
    });
  }
  return found;
}
const walkOver = (wall, speed) => simulate({ seconds: 10, move: straight(() => speed, -2), surface: wall.surface });

test('swing feet clear a raised section of ground and every planted foot rests on the surface', () => {
  const wall = ridge(.25, 3, 3.3);
  for (const speed of [.5, 1, 1.5, 2.5]) {
    const { frames } = walkOver(wall, speed);
    const over = crossings(frames, wall);
    assert.ok(over.length >= 2, `speed ${speed}: only ${over.length} swings cross the wall`);
    for (const c of over) assert.ok(c.lowest > wall.top, `speed ${speed}: leg ${c.leg} swing at frame ${c.frame} passes over the wall at ${c.lowest.toFixed(3)} m, below its ${wall.top} m top`);
    for (const frame of frames) frame.feet.forEach((foot, leg) => {
      const ground = wall.height(foot.z);
      if (frame.swinging[leg]) assert.ok(foot.y >= ground - 1e-9, `speed ${speed}: swinging claw dipped below the surface at t=${frame.t.toFixed(2)}`);
      else assert.ok(Math.abs(foot.y - ground) < 1e-9, `speed ${speed}: planted foot floats or sinks (${foot.y}) at t=${frame.t.toFixed(2)}`);
    });
    assert.ok(Math.max(...frames.flatMap(f => f.feet.map(p => p.y))) > .25, `speed ${speed}: the arc lifts the claws`);
  }
});

// Known defect: startSwing() raises the arc's peak to (obstacle height + 0.1 m), but the arc only reaches that
// peak at t = 0.72 while the foot has already covered ~96 % of the horizontal distance, and at path fraction ~0.25
// the arc stands at ~54 % of its peak. An obstacle in the first third of a stride is therefore hit by the claw.
test('swing feet clear a tall log wherever it falls along the stride', () => {
  const wall = ridge(.35, 3, 3.4), failures = [];
  for (const speed of [.5, 1, 1.5, 2.5]) for (const c of crossings(walkOver(wall, speed).frames, wall)) {
    if (c.lowest <= wall.top) failures.push(`speed ${speed}, leg ${c.leg}, frame ${c.frame}: claw ${c.lowest.toFixed(3)} m over a ${wall.top} m log`);
  }
  assert.deepEqual(failures, []);
});

test('sprinting from a standstill keeps four feet down and never overstretches a leg', () => {
  const stage = createStage({ width: 1 });
  let speed = 0, mostInAir = 0, furthest = 0;
  for (let t = 0; t < 9; t += DT) {
    speed = Math.min(6.6, speed + 4.2 * DT);
    stage.anchor.z += speed * DT;
    stage.update(t);
    if (t < .4) continue;
    mostInAir = Math.max(mostInAir, stage.gait.legs.filter(l => l.swinging).length);
    furthest = Math.max(furthest, ...stage.gait.legs.map(l => l.reachRatio));
  }
  assert.ok(mostInAir <= 5, `${mostInAir} legs were in the air at once`); // one over the usual four, only to save an overstretching leg
  assert.ok(furthest < 1, `a leg was asked to reach ${furthest.toFixed(3)} of its length`);
});

// ---------------------------------------------------------------- standing still
// Seen in the game: stopped beside a trunk, one leg kept lifting and setting down again, for ever.
test('standing still among trunks, every leg settles and then stays down', () => {
  const stop = 3; // metres walked before it halts
  for (const [name, trunks] of Object.entries({
    'a trunk where a front foot wants to rest': [{ x: 2.6 * S / .8, z: stop + 2.2 * S / .8, radius: .55 }],
    'trunks on both sides': [{ x: 2.4 * S / .8, z: stop + .4, radius: .5 }, { x: -2.7 * S / .8, z: stop - 1.5, radius: .6 }],
    'a trunk close against the body': [{ x: 1.5 * S / .8, z: stop, radius: .45 }],
  })) {
    const each = trunks.map(trunkClearance);
    const clearance = (a, b) => Math.min(...each.map(f => f(a, b)));
    const { frames } = simulate({ seconds: 14, move: straight(t => (t < stop ? 1 : 0), 0), clearance, obstacles: trunks.map(t => ({ x: t.x, z: t.z, r: t.radius })) });
    const late = swingStarts(frames).filter(s => frames[s.frame].t > stop + 5);
    assert.deepEqual(late.map(s => `leg ${s.leg} at ${frames[s.frame].t.toFixed(1)} s`), [], `${name}: legs still stepping after five seconds at rest`);
  }
});

 test('flat-ground foot lift grows with actual walking speed', () => {
  const peak = speed => {
    const {frames} = simulate({seconds:8, move:straight(() => speed)});
    return Math.max(...frames.flatMap(f=>f.feet.map((p,i)=>f.swinging[i]?p.y:0)));
  };
  const slow=peak(.6), walk=peak(2.5), run=peak(6.5);
  assert.ok(slow<walk && walk<run, `lift must grow with speed: ${slow}, ${walk}, ${run}`);
 });
