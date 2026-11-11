import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// game/pois.ts uses extensionless and JSON imports that only the bundler understands.
import './helpers/register-ts-hooks.mjs';
const { createCollisionWorld, moveCharacter, characterSupportAt, solidContact } = await import('../game/collision.ts');
const { worldColliders, worldLadder, placePoint } = await import('../game/pois.ts');
const { createLadderClimber, ladderBody, ladderFront, ladderAim, ladderReachable, ladderLength, LADDER_SPEED } = await import('../game/ladders.ts');
const assets = (await import('../game/world-assets.json')).default;

/*
 * Can the player actually walk and climb the new world? These run the real moveCharacter, characterSupportAt and the real
 * colliders from game/world-assets.json on flat ground, with a player driven the way game/engine.ts drives one: the velocity
 * eases toward the wanted velocity, moveCharacter moves it, and the visible height chases the support under the feet.
 */

// What game/engine.ts does each frame. The first test below reads engine.ts and collision.ts to keep these honest.
const ENGINE = { height: 1.69, radius: .24, yDamp: 18, accel: 6, decel: 10, walk: 1.8, hurry: 3.35 };
const SPEEDS = [ENGINE.walk, ENGINE.hurry], FRAME_RATES = [60, 30];
const flat = () => 0;
// The model at its own origin, and the model placed somewhere with a yaw, as world-layout places it.
const PLACEMENTS = [{ name: 'at the model origin', x: 0, z: 0, yaw: 0 }, { name: 'placed at (37.5, -22.25), yaw 0.7', x: 37.5, z: -22.25, yaw: .7 }];
const configs = () => PLACEMENTS.flatMap(placement => SPEEDS.flatMap(speed => FRAME_RATES.map(fps => ({ placement, speed, fps, label: `${speed} m/s at ${fps} fps, ${placement.name}` }))));

function scene(assetName, placement) {
  const place = { id: assetName, asset: assetName, ...placement }, asset = assets[assetName];
  const colliders = worldColliders(asset, place, 0), names = new Map();
  colliders.forEach((c, i) => names.set(c, `${c.tag} #${i}`)); // "#i" is the index in assets[name].colliders
  const world = createCollisionWorld(); world.replace('pois', colliders);
  const c = Math.cos(place.yaw), n = Math.sin(place.yaw);
  return { asset, place, world, colliders, names, at: (x, z, y = 0) => ({ ...placePoint(place, x, z), y }),
    /** A world position written back in model-local metres, so a failure reads the same wherever the model stands. */
    local: p => { const dx = p.x - place.x, dz = p.z - place.z; return `(${(dx * c - dz * n).toFixed(2)}, ${p.y.toFixed(2)}, ${(dx * n + dz * c).toFixed(2)})`; } };
}

/** One simulated player: the engine's walking update (velocity easing, moveCharacter, damped height). */
function createPlayer(sc, start, speed, fps) {
  const dt = 1 / fps, p = { ...start }; let vx = 0, vz = 0, time = 0;
  return {
    p, dt, get time() { return time; },
    /** The lowest and highest the visible height has been; a player that popped onto a rail or sank through a floor shows here. */
    range: { min: start.y, max: start.y },
    /** One frame of holding W toward (dx, dz): a unit vector, or zero for no input. */
    walk(dx, dz) {
      const ease = 1 - Math.exp(-dt * (dx || dz ? ENGINE.accel : ENGINE.decel));
      vx += (dx * speed - vx) * ease; vz += (dz * speed - vz) * ease;
      const next = moveCharacter(p, vx * dt, vz * dt, ENGINE.height, flat, sc.world);
      p.x = next.x; p.z = next.z; p.y += (next.y - p.y) * (1 - Math.exp(-ENGINE.yDamp * dt)); time += dt;
      this.range.min = Math.min(this.range.min, p.y); this.range.max = Math.max(this.range.max, p.y);
    },
    /** What the engine does while a ladder holds the player: set the position, drop the velocity. */
    hold(x, y, z) { p.x = x; p.y = y; p.z = z; vx = vz = 0; time += dt; },
    stand(seconds) { for (let i = 0; i < Math.round(seconds * fps); i++) this.walk(0, 0); },
    /** Steer straight at (x, z) until `arrived()`; returns false after `limit` seconds without getting there. */
    goTo(x, z, arrived, limit) {
      for (let t = 0; t < limit; t += dt) {
        const d = Math.hypot(x - p.x, z - p.z); if (arrived(d)) return true;
        this.walk((x - p.x) / d, (z - p.z) / d);
      }
      return false;
    },
  };
}

/** The colliders pressing on the player that it would have to climb or pass: what a stuck player is stuck on. */
function blockers(sc, p) {
  const out = [];
  for (const c of sc.world.nearby(p.x, p.z, 1)) {
    if (c.minY > p.y + ENGINE.height + .025 || c.maxY < p.y - .12 || c.maxY <= p.y + .28) continue;
    const depth = solidContact(c, p.x, p.z, ENGINE.radius + .03).depth;
    if (depth > 0) out.push(`${sc.names.get(c)} (y ${c.minY.toFixed(2)}..${c.maxY.toFixed(2)}, ${(depth * 100).toFixed(0)} cm in)`);
  }
  return out;
}

/**
 * Walk the waypoints in order: [label, x, z, y] in model-local metres, y being the floor height the player should be on there.
 * A leg that takes more than three times its walking time plus two seconds is a player stuck; one that arrives at the wrong
 * height is a player on the wrong surface. Returns the first problem, or undefined.
 */
function walkRoute(sc, route, { speed, fps }) {
  // Where the floor changes height the foot-sized sole reads the highest of two or three treads and the height eases after it: +/- 0.6 m there, 0.15 m on level floor.
  const pts = route.map(([label, x, z, y], i) => ({ label, ...sc.at(x, z, y), tol: [route[i - 1], route[i + 1]].some(n => n && Math.abs(n[3] - y) > 1e-9) ? .6 : .15 }));
  const player = createPlayer(sc, pts[0], speed, fps), p = player.p;
  for (let i = 1; i < pts.length; i++) {
    const to = pts[i], from = pts[i - 1], limit = 2 + Math.hypot(to.x - from.x, to.z - from.z) / speed * 3;
    const ok = player.goTo(to.x, to.z, d => d <= .2, limit);
    if (!ok) return `stuck going from "${from.label}" to "${to.label}": stopped at ${sc.local(p)}, ${Math.hypot(to.x - p.x, to.z - p.z).toFixed(2)} m short; blocked by ${blockers(sc, p).join('; ') || 'nothing in contact'}`;
    if (Math.abs(p.y - to.y) > to.tol) return `reached "${to.label}" at height ${p.y.toFixed(2)}, expected ${to.y.toFixed(2)} (+/- ${to.tol})`;
  }
  const end = pts[pts.length - 1], floors = pts.map(q => q.y);
  // Never lower than the lowest floor of the route or higher than the highest by more than the sole reading a tread ahead (0.2 m) and the easing.
  if (player.range.min < Math.min(...floors) - .05 || player.range.max > Math.max(...floors) + .45) return `left the route's heights: went as low as ${player.range.min.toFixed(2)} and as high as ${player.range.max.toFixed(2)}, the floors are ${Math.min(...floors)}..${Math.max(...floors)}`;
  player.stand(.8);
  if (Math.abs(p.y - end.y) > .02) return `ended at height ${p.y.toFixed(3)}, expected ${end.y.toFixed(3)} at "${end.label}"`;
  return undefined;
}

/** Up the route and back down it, in every configuration. Returns one line per failure. */
function routeProblems(assetName, route) {
  const problems = [];
  for (const { placement, speed, fps, label } of configs()) {
    const sc = scene(assetName, placement);
    for (const [direction, r] of [['up', route], ['back down', route.slice().reverse()]]) {
      const problem = walkRoute(sc, r, { speed, fps });
      if (problem) problems.push(`${direction}, ${label}: ${problem}`);
    }
  }
  return problems;
}
/** Failures are the same in every configuration far more often than not, so say so once: "(all 8 configurations)". */
function noProblems(problems) {
  const groups = new Map();
  for (const problem of problems) { const [config, text] = [problem.slice(0, problem.indexOf(': ')), problem.slice(problem.indexOf(': ') + 2)]; groups.set(text, [...groups.get(text) ?? [], config]); }
  const total = configs().length * 2;
  const lines = [...groups].map(([text, list]) => `${list.length === total || list.length === configs().length ? 'every configuration' : list.length + ' configurations'} (${[...new Set(list.map(c => c.split(', ')[0]))].join(', ')}): ${text}`);
  assert.ok(!problems.length, `\n${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------------------------------------------------
test('the traversal simulation uses the movement constants game/engine.ts and game/collision.ts really have', () => {
  const engine = readFileSync(new URL('../game/engine.ts', import.meta.url), 'utf8'), collision = readFileSync(new URL('../game/collision.ts', import.meta.url), 'utf8');
  const number = (source, pattern, what) => { const m = source.match(pattern); assert.ok(m, `no longer found: ${what}; update ENGINE in tests/traversal.test.mjs`); return m.slice(1).map(Number); };
  assert.deepEqual(number(engine, /moveSpeed=crouch\?[\d.]+:hurry\?([\d.]+):([\d.]+)/, 'the hurry and walking speeds'), [ENGINE.hurry, ENGINE.walk]);
  assert.deepEqual(number(engine, /moveCharacter\(player,velocity\.x\*dt,velocity\.z\*dt,crouch\?[\d.]+:([\d.]+),movementGround,collisions\)/, 'the standing height passed to moveCharacter'), [ENGINE.height]);
  assert.deepEqual(number(engine, /damp\(player\.y,next\.y,(\d+),dt\)/, 'the height damping'), [ENGINE.yDamp]);
  assert.deepEqual(number(engine, /Math\.exp\(-dt\*\(temp\.lengthSq\(\)>0\?([\d.]+):([\d.]+)\)\)/, 'the velocity easing'), [ENGINE.accel, ENGINE.decel]);
  assert.deepEqual(number(collision, /world:ReturnType<typeof createCollisionWorld>,radius=([\d.]+)\)/, "moveCharacter's default radius"), [ENGINE.radius]);
});

// ---------------------------------------------------------------------------------------------------------------------
// lookout: six switchback flights up a 14.4 m tower. Written out from the 'stair tread' and 'stair landing' colliders in
// world-assets.json (model-local metres). Every flight is 12 treads, 0.2 m rise and 0.26 m run each; the landing after it
// turns the walker round. Odd flights climb +z along x=-0.48 and even flights climb -z along x=+0.48.
const LOOKOUT_FLIGHTS = [
  // flight, x, first tread z, last tread z, first tread top, last tread top, landing z, landing top
  [1, -.48, -1.43, 1.43, .2, 2.4, 1.94, 2.4],
  [2, .48, 1.43, -1.43, 2.6, 4.8, -1.94, 4.8],
  [3, -.48, -1.43, 1.43, 5.0, 7.2, 1.94, 7.2],
  [4, .48, 1.43, -1.43, 7.4, 9.6, -1.94, 9.6],
  [5, -.48, -1.43, 1.43, 9.8, 12.0, 1.94, 12.0],
  [6, .48, 1.43, -1.43, 12.2, 14.4], // the last tread meets the cab floor at 14.4
];
/** Ground to the top tread of flight 6 and nothing beyond. */
const lookoutStairs = () => {
  const route = [['approach, on the ground', LOOKOUT_FLIGHTS[0][1], -3, 0]];
  LOOKOUT_FLIGHTS.forEach(([n, x, z0, z1, top0, top1, landingZ, landingTop]) => {
    route.push([`flight ${n}, first tread`, x, z0, top0], [`flight ${n}, last tread`, x, z1, top1]);
    if (landingZ !== undefined) route.push([`landing ${n}, same side`, x, landingZ, landingTop], [`landing ${n}, other side`, -x, landingZ, landingTop]);
  });
  return route;
};
/** The cab: the stairwell is cut into its floor, and the way off the top tread is east, through the gap in the well rail. */
const lookoutCab = () => [...lookoutStairs(), ['cab floor, east of the stairwell', 1.4, -1.2, 14.4]];

test('lookout: the route data matches the stair colliders in world-assets.json', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-6, colliders = assets.lookout.colliders;
  const find = (tag, x, z, top) => colliders.filter(c => c.tag === tag && near(c.x, x) && near(c.z, z) && near(c.maxY, top));
  for (const [n, x, z0, z1, top0, top1, landingZ, landingTop] of LOOKOUT_FLIGHTS) {
    for (let k = 0; k < 12; k++) {
      const z = z0 + (z1 - z0) * k / 11, top = top0 + (top1 - top0) * k / 11, treads = find('stair tread', x, z, top);
      assert.equal(treads.length, 1, `flight ${n} tread ${k + 1}: expected one tread at x ${x}, z ${z.toFixed(2)}, top ${top.toFixed(2)}`);
      assert.ok(treads[0].halfX >= .45 && treads[0].halfZ >= .14 && near(treads[0].maxY - treads[0].minY, .12), `flight ${n} tread ${k + 1} has changed shape`);
    }
    if (landingZ !== undefined) assert.equal(find('stair landing', 0, landingZ, landingTop).length, 1, `landing ${n}`);
  }
  assert.equal(colliders.filter(c => c.tag === 'stair tread').length, 72);
  assert.equal(colliders.filter(c => c.tag === 'stair landing').length, 5);
});

test('lookout: ground up all six flights and every landing to the top tread (14.4), and back down', () => {
  noProblems(routeProblems('lookout', lookoutStairs()));
});

test('lookout: through the stairwell into the cab at 14.4, and back down to the ground', {
}, () => {
  noProblems(routeProblems('lookout', lookoutCab()));
});

// ---------------------------------------------------------------------------------------------------------------------
// cabin: two steps (0.14 m and 0.28 m), the porch and floor at 0.42, a door in the wall at z=2.5 between x=-1.2 and x=-0.22.
const CABIN_ROUTE = [
  ['ground, in front of the porch', -.7, 7.2, 0],
  ['bottom step', -.7, 5.24, .14],
  ['top step', -.7, 4.92, .28],
  ['porch', -.7, 4.2, .42],
  ['door', -.7, 2.5, .42],
  ['room', -.7, .6, .42],
];
test('cabin: up both steps, onto the porch, through the door into the room, and back out', () => noProblems(routeProblems('cabin', CABIN_ROUTE)));

// chapel: two steps, then the nave floor at 0.42 behind a doorway between x=-0.8 and x=0.8 (its doors stand open outwards).
const CHAPEL_ROUTE = [
  ['ground, in front of the steps', 0, 7.6, 0],
  ['bottom step', 0, 5.82, .14],
  ['top step', 0, 5.52, .28],
  ['doorway', 0, 5.2, .42],
  ['nave, aisle', 0, 3.2, .42],
  ['middle of the nave', 0, 0, .42],
];
test('chapel: up both steps and through the door to the middle of the nave, and back out', () => noProblems(routeProblems('chapel', CHAPEL_ROUTE)));

// ---------------------------------------------------------------------------------------------------------------------
// Ladders: walk up to it, take hold, climb to the top and stand on the platform; then take hold from the platform and climb down.
const withLadders = Object.entries(assets).filter(([, a]) => a.ladders?.length);

function ladderProblems(assetName, index) {
  const problems = [];
  for (const config of configs()) { const problem = ladderRun(assetName, index, config); if (problem) problems.push(problem); }
  return problems;
}

/** One configuration of the whole ladder routine. Returns the first thing that went wrong, or undefined. */
function ladderRun(assetName, index, { placement, speed, fps, label }) {
  const sc = scene(assetName, placement), ladder = worldLadder(sc.asset, sc.place, 0, index), front = ladderFront(ladder), where = `${assetName} ladder ${index}, ${label}`;
  const player = createPlayer(sc, { x: ladder.bottom.x + front.x * 4, y: 0, z: ladder.bottom.z + front.z * 4 }, speed, fps), p = player.p;
  const fail = message => `${where}: ${message}`;
  // 1. Walk at the foot of the ladder until within a metre of its line, which is when the prompt appears.
  const foot = ladderBody(ladder, 0);
  if (!player.goTo(foot.x, foot.z, () => ladderReachable(ladder, p), 8)) return fail(`never got within a metre of the ladder; stopped at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}), blocked by ${blockers(sc, p).join('; ') || 'nothing'}`);
  const eye = { x: p.x, y: p.y + ENGINE.height, z: p.z }, look = { x: foot.x - p.x, y: 0, z: foot.z - p.z }, n = Math.hypot(look.x, look.z);
  const aim = ladderAim(ladder, eye, { x: look.x / n, y: 0, z: look.z / n }, 2.4);
  if (aim.gap > .05) return fail(`looking straight at the ladder from the foot misses its line by ${aim.gap.toFixed(2)} m`);
  // 2. Take hold and climb with W held to the top. No frame may jump.
  const climber = createLadderClimber(); assert.ok(climber.attach(ladder, p));
  const limit = Math.ceil((ladderLength(ladder) / LADDER_SPEED + 2) * fps);
  let step, previous = { ...p }, worst = 0, frames = 0;
  for (; frames < limit; frames++) {
    step = climber.update(player.dt, { forward: 1 }, p); if (!step) break;
    worst = Math.max(worst, Math.hypot(step.x - previous.x, step.y - previous.y, step.z - previous.z) / player.dt); previous = { x: step.x, y: step.y, z: step.z };
    player.hold(step.x, step.y, step.z); if (step.done) break;
  }
  if (step?.done !== 'top') return fail(`W held for ${(frames / fps).toFixed(1)} s did not top out (done: ${step?.done})`);
  if (worst > 8) return fail(`the player moved at ${worst.toFixed(1)} m/s in one frame while climbing`);
  if (Math.hypot(p.x - ladder.exit.x, p.z - ladder.exit.z) > 1e-9 || Math.abs(p.y - ladder.exit.y) > 1e-9) return fail('released somewhere other than the exit');
  // 3. Stand there: the floor collider supports exactly the platform height, nothing pushes or drops the player, and they can cross the platform.
  const support = characterSupportAt(ladder.exit.x, ladder.exit.z, ladder.exit.y, flat, sc.world, ENGINE.radius * .9);
  if (Math.abs(support - ladder.top.y) > 1e-9) return fail(`the support at the exit is ${support}, the platform is at ${ladder.top.y}`);
  player.stand(1);
  if (Math.hypot(p.x - ladder.exit.x, p.z - ladder.exit.z) > .01 || Math.abs(p.y - ladder.exit.y) > .005) return fail(`standing at the exit moved the player to (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}); blocked by ${blockers(sc, p).join('; ') || 'nothing'}`);
  const floor = sc.colliders.find(c => c.maxY === ladder.top.y && solidContact(c, ladder.exit.x, ladder.exit.z, 0).depth > 0);
  if (!floor) return fail('no floor collider at the exit');
  if (!player.goTo(floor.x, floor.z, d => d < .12, 6) || Math.abs(p.y - ladder.top.y) > .02) return fail(`could not walk from the exit to the middle of the platform; at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}), blocked by ${blockers(sc, p).join('; ') || 'nothing'}`);
  // 4. Back to the exit, take hold of the ladder from the platform and climb down.
  if (!player.goTo(ladder.exit.x, ladder.exit.z, d => d < .1, 6)) return fail('could not walk back to the exit');
  if (!ladderReachable(ladder, p)) return fail('from the exit the ladder is more than a metre away');
  assert.ok(climber.attach(ladder, p));
  previous = { ...p }; worst = 0; step = undefined;
  for (frames = 0; frames < limit; frames++) {
    step = climber.update(player.dt, { forward: -1 }, p); if (!step) break;
    worst = Math.max(worst, Math.hypot(step.x - previous.x, step.y - previous.y, step.z - previous.z) / player.dt); previous = { x: step.x, y: step.y, z: step.z };
    player.hold(step.x, step.y, step.z); if (step.done) break;
  }
  if (step?.done !== 'bottom') return fail(`S held for ${(frames / fps).toFixed(1)} s did not reach the bottom (done: ${step?.done})`);
  if (worst > 8) return fail(`the player moved at ${worst.toFixed(1)} m/s in one frame while descending`);
  if (Math.abs(p.y - ladder.bottom.y) > 1e-9) return fail(`released at height ${p.y}, the ground is ${ladder.bottom.y}`);
  const released = { ...p }; player.stand(1);
  if (Math.hypot(p.x - released.x, p.z - released.z) > .01 || Math.abs(p.y - ladder.bottom.y) > .005) return fail(`released inside something: standing there moved the player from (${released.x.toFixed(2)}, ${released.z.toFixed(2)}) to (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}); blocked by ${blockers(sc, released).join('; ') || 'nothing'}`);
  // 5. And away from the ladder.
  if (!player.goTo(p.x + front.x * 3, p.z + front.z * 3, d => d < .2, 6)) return fail('could not walk away from the foot of the ladder');
  // 6. Take hold again, climb halfway and let go: the player drops, through the engine's height damping, to whatever is beneath.
  if (!player.goTo(foot.x, foot.z, () => ladderReachable(ladder, p), 8)) return fail('could not walk back to the ladder');
  const again = createLadderClimber(); again.attach(ladder, p);
  for (frames = 0; again.distance < ladderLength(ladder) / 2 && frames < limit; frames++) { step = again.update(player.dt, { forward: 1 }, p); player.hold(step.x, step.y, step.z); }
  step = again.update(player.dt, { forward: 0, letGo: true }, p);
  if (step.done !== 'let-go') return fail(`letting go gave ${step.done}`);
  const dropFrom = { ...p }, expected = characterSupportAt(p.x, p.z, p.y, flat, sc.world, ENGINE.radius * .9);
  player.stand(3);
  if (Math.abs(p.y - expected) > .005 || dropFrom.y - p.y < .5) return fail(`let go ${dropFrom.y.toFixed(2)} m up and ended at height ${p.y.toFixed(3)}, expected the support beneath, ${expected.toFixed(3)}`);
  if (Math.hypot(p.x - dropFrom.x, p.z - dropFrom.z) > .01) return fail('a dropped player drifted sideways');
  return undefined;
}

test('every ladder in world-assets.json is covered here', () => {
  assert.ok(['deerstand', 'mast'].every(name => withLadders.some(([n]) => n === name)), 'deerstand and mast must each have a ladder');
});
for (const [name, asset] of withLadders) asset.ladders.forEach((_, index) => {
  test(`${name} ladder ${index}: walk up to it, climb to the platform, stand on it, climb back down; let go halfway`, () => noProblems(ladderProblems(name, index)));
});
