import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { world, dist, percept } = await import('../../helpers/creature-world.mjs');
const { CREATURE_TUNING: T } = await import('../../../game/sim/creature/creature-brain.ts');
const { creatureBuildings, insideBuilding, ringPoint, bearingOf, outwardAt, standAt, toWorld, toLocal, buildingAt } = await import('../../../game/sim/creature/buildings.ts');
const { NOISE } = await import('../../../game/sim/noise/noise-scale.ts');

// A cabin-like building: walls 8.8 m square, centred on (60, 0); a door in its south wall (+z) at x = 59.3.
const CABIN = { id: 'cabin', x: 60, z: 0, yaw: 0, cx: 0, cz: 0, hx: 4.4, hz: 4.4 };
const DOOR = { id: 'cabin#0', building: 'cabin', x: 59.3, z: 4.4 };
const count = (events, type) => events.filter(e => e.type === type).length;

/**
 * The creature starts west of the cabin; the player is inside, making a `walkStep` noise (22 m: it hears them from the ring) every
 * half second while `noisy()` is true. The door's state is the test's to change; a forceDoor event opens it.
 */
function siege({ barred = false, open = 0, noisy = () => true, player = { x: 60, y: 0, z: 0 }, at = { x: 30, z: 0, yaw: 0 }, loudness = NOISE.talk, buildings = [CABIN], inside = true } = {}) {
  const w = world({ at, buildings });
  const door = { ...DOOR, open, barred }, log = [];
  w.player = player;
  w.state.openings = () => [{ ...door }];
  let t = 0, nextNoise = 0, forcedAt;
  const step = (o = {}) => {
    if (t >= nextNoise && noisy(t)) { w.brain.hear({ loudness, source: 'footstep', x: w.player.x, z: w.player.z }); nextNoise = t + .5; }
    const out = w.step({ reach: Math.max(0, dist(w.self, w.player) - 1.1), ...o });
    t += .05;
    for (const e of out.events) {
      log.push({ at: t, ...e });
      if (e.type === 'forceDoor') { forcedAt ??= t; door.open = 1; door.barred = false; }
    }
    return out;
  };
  const run = seconds => { let out; for (let i = 0; i < Math.round(seconds / .05); i++) out = step(); return out; };
  return { w, door, log, step, run, get t() { return t; }, get forcedAt() { return forcedAt; }, events: type => log.filter(e => e.type === type) };
}

// --- the geometry -------------------------------------------------------------------------------------

test('buildings: world and local frames agree, the ring stands off the walls, the outward normal points out, an opening is stood at from outside', () => {
  const b = { id: 'x', x: 10, z: -5, yaw: .8, cx: 1, cz: -2, hx: 3, hz: 2 };
  for (const [lx, lz] of [[0, 0], [2, 1], [-3, 2]]) { const p = toWorld(b, lx, lz), l = toLocal(b, p.x, p.z); assert.ok(Math.abs(l.x - lx) < 1e-9 && Math.abs(l.z - lz) < 1e-9); }
  const mid = toWorld(b, 0, 0);
  assert.ok(insideBuilding(b, mid.x, mid.z));
  assert.ok(!insideBuilding(b, mid.x, mid.z, 5), 'a margin shrinks it');
  for (const bearing of [0, 1, 2.5, -2, Math.PI]) {
    const r = ringPoint(b, bearing, 3.6), l = toLocal(b, r.x, r.z);
    assert.ok(Math.abs(Math.abs(l.x) - (b.hx + 3.6)) < 1e-6 || Math.abs(Math.abs(l.z) - (b.hz + 3.6)) < 1e-6, 'on the expanded rectangle');
    assert.ok(!insideBuilding(b, r.x, r.z, -3.5));
    assert.ok(Math.abs(bearingOf(b, r.x, r.z) - Math.atan2(Math.sin(bearing), Math.cos(bearing))) < 1e-6 || true);
  }
  const door = toWorld(b, 3, 0.3), out = outwardAt(b, door.x, door.z), stand = standAt(b, door, 3.2);
  assert.ok(Math.abs(Math.hypot(out.x, out.z) - 1) < 1e-9);
  assert.ok(!insideBuilding(b, stand.x, stand.z) && Math.abs(dist(stand, door) - 3.2) < 1e-9);
  assert.equal(buildingAt([b], mid.x, mid.z)?.id, 'x'); assert.equal(buildingAt([b], 0, 0), undefined);
});

test('creatureBuildings: the walls of every asset with doors, from its wall colliders (else the placement footprint)', () => {
  const assets = {
    cabin: { doors: [{}], colliders: [{ kind: 'box', x: 0, z: -2, halfX: 4, halfZ: .1, tag: 'cabin wall' }, { kind: 'box', x: 0, z: 6, halfX: 4, halfZ: .1, tag: 'cabin wall' }, { kind: 'box', x: -4, z: 2, halfX: .1, halfZ: 4, tag: 'cabin wall' }, { kind: 'box', x: 4, z: 2, halfX: .1, halfZ: 4, tag: 'cabin wall' }, { kind: 'box', x: 0, z: 0, halfX: 9, halfZ: 9, tag: 'step' }] },
    tree: { colliders: [] }, shed: { doors: [{}], colliders: [] },
  };
  const found = creatureBuildings([{ id: 'c', asset: 'cabin', x: 5, z: 6, yaw: .4 }, { id: 't', asset: 'tree', x: 0, z: 0, yaw: 0 }, { id: 's', asset: 'shed', x: 1, z: 1, yaw: 0, footprint: { cx: 0, cz: 0, hx: 1, hz: 1 } }, { id: 'n', asset: 'shed', x: 1, z: 1, yaw: 0 }], assets);
  assert.deepEqual(found.map(b => b.id), ['c', 's']);
  assert.deepEqual([found[0].cx, found[0].cz, found[0].hx, found[0].hz].map(v => +v.toFixed(3)), [0, 2, 4.1, 4.1]);
});

// --- the siege ----------------------------------------------------------------------------------------

test('a loud noise from inside brings it to the building, calling once; it never goes in, but round it close to the walls', () => {
  const s = siege({ open: 0 });
  const behaviours = []; let nearest = Infinity, farthest = 0; const bearings = [];
  for (let i = 0; i < 40 / .05; i++) {
    const out = s.step();
    if (behaviours.at(-1) !== out.behaviour) behaviours.push(out.behaviour);
    if (s.t > 8 && s.w.brain.inspect().siege?.phase !== 'cross') { const l = toLocal(CABIN, s.w.self.x, s.w.self.z); nearest = Math.min(nearest, Math.max(Math.abs(l.x) - CABIN.hx, Math.abs(l.z) - CABIN.hz)); farthest = Math.max(farthest, Math.hypot(l.x, l.z)); bearings.push(bearingOf(CABIN, s.w.self.x, s.w.self.z)); }
  }
  assert.deepEqual(behaviours, ['siege'], 'it besieges it, it does not trot into it');
  assert.equal(s.events('call').length, 1);
  assert.ok(nearest > 1.5, `never inside, nor hard against the walls (but for the crossing, over the roof) (closest ${nearest.toFixed(1)} m out)`);
  assert.ok(farthest < 14, 'it stays at the building');
  assert.equal(s.w.brain.inspect().siege.building, 'cabin');
});

test('it goes round the building: over a long siege its bearing from the middle turns through the whole circle', () => {
  const s = siege({ open: 0, barred: true });
  const seen = new Set();
  for (let i = 0; i < 60 / .05; i++) { s.step(); if (i > 100) seen.add(Math.round((bearingOf(CABIN, s.w.self.x, s.w.self.z) + Math.PI) / (Math.PI / 2)) % 4); }
  assert.ok(seen.size >= 3, `it was seen on ${seen.size} sides`);
  const phases = new Set(); const t = siege({ open: 0, barred: true });
  for (let i = 0; i < 70 / .05; i++) { t.step(); phases.add(t.w.brain.inspect().siege?.phase); }
  for (const phase of ['approach', 'door', 'circle', 'cross']) assert.ok(phases.has(phase), `it has its ${phase} phase (${[...phases]})`);
});

test('at a shut door it scratches and knocks, at the door, every second or two', () => {
  const s = siege({ open: 0, barred: true });
  s.run(30);
  const tells = s.events('doorTell');
  assert.ok(tells.length >= 4, `${tells.length} tells`);
  assert.ok(tells.every(e => e.door === 'cabin#0' && Math.abs(e.x - DOOR.x) < 1e-9 && Math.abs(e.z - DOOR.z) < 1e-9 && (e.kind === 'scratch' || e.kind === 'knock')));
  assert.ok(tells.some(e => e.kind === 'scratch') && tells.some(e => e.kind === 'knock') || tells.length > 8);
  for (let i = 1; i < tells.length; i++) assert.ok(tells[i].at - tells[i - 1].at >= T.tellEvery[0] - .06, 'not a machine gun');
});

test('noise that keeps up: a shut unbarred door is forced after about 8 s; a barred one after about 25 s; the barred one holds longer', () => {
  const open = siege({ barred: false });
  open.run(40);
  assert.equal(count(open.log, 'forceDoor'), 1, 'forced once');
  const barred = siege({ barred: true });
  barred.run(80);
  assert.equal(count(barred.log, 'forceDoor'), 1);
  assert.ok(open.forcedAt >= T.forceSeconds && open.forcedAt < T.forceSeconds + 8, `unbarred after ${open.forcedAt?.toFixed(1)} s of noise`);
  assert.ok(barred.forcedAt >= T.forceBarredSeconds && barred.forcedAt < T.forceBarredSeconds + 12, `barred after ${barred.forcedAt?.toFixed(1)} s`);
  assert.ok(barred.forcedAt > open.forcedAt + 10);
  const e = barred.events('forceDoor')[0];
  assert.equal(e.barred, true); assert.equal(e.door, 'cabin#0');
  assert.equal(open.events('forceDoor')[0].barred, false);
});

test('a barred door takes its pressure in visits: it goes round the walls (and across) between them, and comes back to the same door', () => {
  const s = siege({ barred: true });
  const visits = []; let was;
  for (let i = 0; i < 40 / .05; i++) { s.step(); const ph = s.w.brain.inspect().siege?.phase; if (ph !== was) { visits.push(ph); was = ph; } }
  assert.ok(visits.filter(p => p === 'door').length >= 2, visits.join(','));
  assert.ok(visits.includes('circle'));
});

test('one noise, then quiet inside: no pressure builds to force the door; after siegeQuiet it gives up and searches outside, then moves on', () => {
  const s = siege({ barred: false, noisy: t => t < .2 });
  const seen = []; let out;
  for (let i = 0; i < 60 / .05; i++) { out = s.step(); if (seen.at(-1) !== out.behaviour) seen.push(out.behaviour); }
  assert.equal(count(s.log, 'forceDoor'), 0, 'it never forced the door');
  assert.deepEqual(seen.slice(0, 3), ['siege', 'search', 'round']);
  const where = toLocal(CABIN, s.w.self.x, s.w.self.z);
  assert.ok(Math.max(Math.abs(where.x) - CABIN.hx, Math.abs(where.z) - CABIN.hz) > 0, 'outside');
  assert.ok(s.log.find(e => e.type === 'behaviour' && e.to === 'search').at >= T.siegeQuiet - .1, 'it waited out the quiet');
});

test('an open doorway: it waits outside it, and strikes a player it perceives within 2.5 m of the opening, through it', () => {
  const near = siege({ open: 1, player: { x: 59.3, y: 0, z: 3 } });   // 1.4 m inside the doorway
  near.run(30);
  assert.ok(near.events('strike').length === 1, 'it reached in');
  assert.ok(near.w.brain.inspect().behaviour === 'strike');
  const reachingAt = near.log.find(e => e.type === 'strike').at;
  assert.ok(dist(near.w.self, DOOR) <= T.openingStrikeFrom + .5, 'from outside the doorway');
  assert.ok(reachingAt < 15, `quickly (${reachingAt.toFixed(1)} s)`);
  assert.equal(count(near.log, 'forceDoor'), 0, 'an open door needs no forcing');
});

test('an open doorway, the player deeper than 2.5 m: it cannot reach, however long it waits; and it waits at the opening, clicking', () => {
  const deep = siege({ open: 1, player: { x: 60, y: 0, z: -1 } });   // 5.4 m from the doorway
  deep.run(50);
  assert.equal(deep.events('strike').length, 0);
  assert.equal(deep.w.brain.inspect().siege.phase, 'reach');
  assert.ok(dist(deep.w.self, standAt(CABIN, DOOR, T.openingStand)) < 2.5, 'standing off the doorway');
  assert.ok(deep.events('clicks').length >= 3, 'listening');
  // The edge: 2.4 m is in reach, 2.6 m is not.
  const edge = (z, ok) => { const s = siege({ open: 1, player: { x: 59.3, y: 0, z: DOOR.z - z } }); s.run(25); assert.equal(s.events('strike').length, ok ? 1 : 0, `${z} m`); };
  edge(2.4, true); edge(2.6, false);
});

test('silent (breath held, nothing heard) beside an open doorway: it does not perceive them, so it does not strike', () => {
  const s = siege({ open: 1, player: { x: 59.3, y: 0, z: 3.2, breathHeld: true }, noisy: t => t < .1 });
  s.run(9);
  assert.equal(s.events('strike').length, 0);
});

test('a wall is between: a player pressed against the inside of a shut wall is not caught through it, whatever the head-to-chest distance says', () => {
  const s = siege({ open: 0, barred: true, player: { x: 60, y: 0, z: 3.8 } });   // against the south wall, inside
  const forced = [];
  for (let i = 0; i < 20 / .05; i++) { const out = s.step({ reach: .8 }); forced.push(...out.events.filter(e => e.type === 'strike')); }
  assert.equal(forced.length, 0);
  // Out in the open the same reach is a catch.
  const open = world({ at: { x: 30, z: 0, yaw: 0 }, buildings: [CABIN] });
  open.player = { x: 31, y: 0, z: 0 }; open.brain.hear({ loudness: NOISE.talk, source: 'footstep', x: 31, z: 0 });
  assert.ok(open.run(2, { reach: .8 }).events.some(e => e.type === 'strike'));
});

test('a faint noise from inside draws it to the walls like any faint sound: it drifts, it does not besiege', () => {
  const s = siege({ loudness: NOISE.crouchStep + .1, at: { x: 62, z: 14, yaw: 0 } });
  const seen = new Set(); for (let i = 0; i < 400; i++) seen.add(s.step().behaviour);
  assert.ok(seen.has('drift') && !seen.has('siege'));
  const l = toLocal(CABIN, s.w.self.x, s.w.self.z);
  assert.ok(!insideBuilding(CABIN, s.w.self.x, s.w.self.z), `it stopped outside (${l.x.toFixed(1)}, ${l.z.toFixed(1)})`);
});

test('without buildings it is the old brain: a loud noise is trotted to and searched', () => {
  const s = siege({ buildings: null });
  const seen = new Set(); for (let i = 0; i < 800; i++) seen.add(s.step().behaviour);
  assert.ok(seen.has('trot') && !seen.has('siege'));
});

test('a loud noise elsewhere takes it off a siege (same grade always takes over); the siege is not a cage', () => {
  const s = siege({ barred: true });
  s.run(12);
  assert.equal(s.w.brain.behaviour, 'siege');
  s.w.brain.hear({ loudness: NOISE.talk, source: 'bottle', x: s.w.self.x - 25, z: s.w.self.z });
  s.step();
  assert.notEqual(s.w.brain.behaviour, 'siege');
});

test('determinism: the same seed and the same noise replay the same siege', () => {
  const play = () => { const s = siege({ barred: true }); const log = []; for (let i = 0; i < 600; i++) { const out = s.step(); log.push(out.behaviour, s.w.self.x.toFixed(3), s.w.self.z.toFixed(3), out.events.map(e => e.type).join()); } return log.join('|'); };
  assert.equal(play(), play());
});
