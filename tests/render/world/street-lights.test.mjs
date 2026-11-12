import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
const { LAMP, lampTraits, lampsWanted, failingLevel, pickLights, createStreetLights } = await import('../../../game/render/world/street-lights.ts');

const ids = n => Array.from({ length: n }, (_, i) => `streetlight-${i}`);

test('which lamps are dead or failing depends on the placement id alone', () => {
  for (const id of ids(40)) assert.deepEqual(lampTraits(id), lampTraits(id));
  // Asking in another order, or about other lamps first, changes nothing.
  const forward = ids(40).map(lampTraits), backward = ids(40).reverse().map(lampTraits).reverse();
  assert.deepEqual(forward, backward);
  assert.notDeepEqual(lampTraits('streetlight-3'), lampTraits('streetlight-4'));
});

test('about one lamp in four is dead, and one in five of the rest is failing', () => {
  const traits = ids(5000).map(lampTraits), dead = traits.filter(t => t.dead), rest = traits.filter(t => !t.dead);
  assert.ok(Math.abs(dead.length / traits.length - .25) < .03, `dead ${dead.length / traits.length}`);
  assert.ok(Math.abs(rest.filter(t => t.failing).length / rest.length - .2) < .03, 'failing share of the working lamps');
  assert.ok(dead.every(t => !t.failing), 'a dead lamp cannot also be failing');
  for (const t of traits) assert.ok(t.delay >= 0 && t.delay <= LAMP.stagger && t.seed >= 0 && t.seed < 1);
});

test('the lamps the layout places today are a mixture of dead, failing and working', () => {
  const traits = ids(12).map(lampTraits);
  assert.ok(traits.some(t => t.dead) && traits.some(t => t.failing) && traits.some(t => !t.dead && !t.failing));
});

test('lamps come on at dusk and go out at dawn, and the two thresholds never chatter', () => {
  assert.equal(lampsWanted(false, .3), false);
  assert.equal(lampsWanted(false, LAMP.onAbove + .01), true);
  // Between the two thresholds nothing changes, whichever way the darkness came.
  const mid = (LAMP.onAbove + LAMP.offBelow) / 2;
  assert.equal(lampsWanted(true, mid), true);
  assert.equal(lampsWanted(false, mid), false);
  assert.equal(lampsWanted(true, LAMP.offBelow - .01), false);
  assert.ok(LAMP.offBelow < LAMP.onAbove);
  // A darkness that wobbles around the dusk threshold switches the lamps exactly once.
  let on = false, flips = 0;
  for (let i = 0; i < 400; i++) {
    const darkness = LAMP.onAbove + Math.sin(i * .9) * .05 + i * .0006, next = lampsWanted(on, darkness);
    if (next !== on) flips++;
    on = next;
  }
  assert.equal(flips, 1);
  // Day is off, night is on.
  assert.equal(lampsWanted(true, 0), false);
  assert.equal(lampsWanted(false, 1), true);
});

test('a failing lamp is mostly lit, goes dark in stretches, and flickers without strobing', () => {
  for (const seed of [.03, .37, .71, .98]) {
    const step = .05, samples = [];
    for (let t = 0; t < 400; t += step) samples.push(failingLevel(t, seed));
    assert.ok(samples.every(v => v >= 0 && v <= 1));
    const lit = samples.filter(v => v > .5).length / samples.length;
    assert.ok(lit > .6 && lit < .95, `lit for ${lit} of the time (seed ${seed})`);
    assert.ok(samples.some(v => v === 0), 'it goes properly dark');
    // How often it crosses between lit and dark within any second: a strobe would do this ten times or more.
    let worst = 0;
    for (let i = 0; i + 20 < samples.length; i++) {
      let crossings = 0;
      for (let k = i; k < i + 20; k++) if ((samples[k] > .5) !== (samples[k + 1] > .5)) crossings++;
      worst = Math.max(worst, crossings);
    }
    assert.ok(worst <= 8, `${worst} crossings in one second (seed ${seed})`);
  }
});

test('the nearest lit lamps get the real lights, no more than the budget', () => {
  const lamps = [['a', 90], ['b', 10], ['c', 40], ['d', 25], ['e', 70], ['f', 200]].map(([id, distance]) => ({ id, distance }));
  assert.deepEqual(pickLights(lamps, new Set()), ['b', 'd', 'c']);
  assert.deepEqual(pickLights(lamps, new Set(), 2), ['b', 'd']);
  assert.deepEqual(pickLights([], new Set()), []);
  // A lamp out of range never gets one, however few are lit.
  assert.deepEqual(pickLights([{ id: 'far', distance: LAMP.range + 1 }], new Set()), []);
});

test('a lamp that has a real light keeps it until another is clearly nearer', () => {
  const at = (c, d) => [{ id: 'a', distance: 10 }, { id: 'b', distance: 20 }, { id: 'c', distance: c }, { id: 'd', distance: d }];
  // Three lights, c and d fight for the last one. d holds it while c is only a little nearer.
  const held = new Set(['a', 'b', 'd']);
  assert.deepEqual(new Set(pickLights(at(30, 32), held)), new Set(['a', 'b', 'd']));
  assert.deepEqual(new Set(pickLights(at(30 - LAMP.hold + .1, 30), held)), new Set(['a', 'b', 'd']));
  assert.deepEqual(new Set(pickLights(at(30 - LAMP.hold - 1, 30), held)), new Set(['a', 'b', 'c']));
  // Without the lead, the nearer one would simply win.
  assert.deepEqual(new Set(pickLights(at(30, 32), new Set())), new Set(['a', 'b', 'c']));
});

test('walking along a row of lamps hands each light over once, never back and forth', () => {
  const lamps = Array.from({ length: 8 }, (_, i) => ({ id: `l${i}`, x: i * 70 }));
  let held = new Set(), joins = new Map(), leaves = new Map(), previous = new Set();
  for (let x = -20; x <= 560; x += .5) {
    // A little sway across the road, as a walking player has.
    const pick = pickLights(lamps.map(l => ({ id: l.id, distance: Math.hypot(l.x - x, 4 + Math.sin(x) * .7) })), held);
    assert.ok(pick.length <= LAMP.maxLights);
    held = new Set(pick);
    for (const id of held) if (!previous.has(id)) joins.set(id, (joins.get(id) ?? 0) + 1);
    for (const id of previous) if (!held.has(id)) leaves.set(id, (leaves.get(id) ?? 0) + 1);
    previous = held;
  }
  for (const [id, n] of joins) assert.equal(n, 1, `${id} was given a light ${n} times`);
  for (const [id, n] of leaves) assert.equal(n, 1, `${id} lost its light ${n} times`);
  // Standing exactly between two lamps and swaying by a metre does not swap them.
  const two = [{ id: 'west', distance: 35 }, { id: 'east', distance: 35 }, { id: 'p', distance: 1 }, { id: 'q', distance: 2 }, { id: 'r', distance: 3 }];
  let hold = new Set(pickLights(two, new Set(), 3)), changes = 0;
  for (let i = 0; i < 200; i++) {
    const sway = Math.sin(i * 1.7);
    const next = new Set(pickLights([{ id: 'west', distance: 35 + sway }, { id: 'east', distance: 35 - sway }].concat(two.slice(2, 3)), hold, 2));
    if ([...next].some(id => !hold.has(id))) changes++;
    hold = next;
  }
  assert.ok(changes <= 1, `${changes} swaps while standing still`);
});

// --- the whole thing, with a fake world ------------------------------------------------------------------------------
const world = (n, spacing = 60) => {
  const scene = new THREE.Scene(), hooks = new Map();
  const placements = ids(n).map((id, i) => { hooks.set(id, new THREE.Vector3(i * spacing, 6.5, 0)); return { id }; });
  placements.push({ id: 'pole-1' }, { id: 'sign-0' });
  return { scene, placements, pois: { hook: (id, name) => name === 'lamp' ? hooks.get(id)?.clone() : undefined } };
};
const run = (lights, f, seconds, step = 1 / 30) => { for (let t = 0; t < seconds; t += step) { f.time += step; lights.update({ ...f, dt: step }); } };

test('with no streetlight placements it adds nothing and does nothing', () => {
  const { scene, pois } = world(0);
  const before = scene.children.length, lights = createStreetLights({ scene, pois, placements: [{ id: 'pole-1' }, { id: 'sign-0' }] });
  assert.equal(lights.count, 0);
  lights.update({ dt: .03, time: 1, player: new THREE.Vector3(), darkness: 1 });
  assert.deepEqual(lights.stats().real, []);
  assert.equal(scene.children.length, before);
  lights.dispose();
});

test('a placement whose asset has no lamp hook is not a lamp', () => {
  const { scene, placements } = world(3);
  const lights = createStreetLights({ scene, placements, pois: { hook: () => undefined } });
  assert.equal(lights.count, 0);
  lights.dispose();
});

test('the lamps stay dark by day, come on over a few seconds at dusk, and go out at dawn', () => {
  const { scene, pois, placements } = world(12), lights = createStreetLights({ scene, pois, placements });
  const frame = { time: 0, player: new THREE.Vector3(0, 1.7, 3), darkness: 0 };
  run(lights, frame, 5);
  assert.equal(lights.stats().lit, 0, 'lit by day');
  frame.darkness = .8;
  run(lights, frame, 1);
  assert.ok(lights.stats().lit < lights.stats().working, 'they do not all come on at once');
  run(lights, frame, LAMP.stagger + LAMP.rise + 1);
  const night = lights.stats();
  assert.equal(night.lit, night.working, 'every lamp that works is lit at night');
  assert.ok(night.dead >= 1 && night.dead < night.count);
  frame.darkness = .1;
  run(lights, frame, LAMP.stagger + LAMP.fall + 1);
  assert.equal(lights.stats().lit, 0, 'out again at dawn');
  lights.dispose();
});

test('never more than three real lights, and they follow the player along the road with no swapping back and forth', () => {
  const { scene, pois, placements } = world(14, 70), lights = createStreetLights({ scene, pois, placements });
  const spots = () => scene.getObjectByName('Street lights').children.filter(o => o.isSpotLight);
  assert.equal(spots().length, LAMP.maxLights);
  assert.ok(spots().every(s => !s.castShadow && Math.abs(s.decay - 2) < 1e-9 && s.distance === LAMP.reach));
  const frame = { time: 0, player: new THREE.Vector3(-30, 1.7, 2), darkness: 1 };
  lights.settle(); run(lights, frame, 12);
  const joined = new Map(), seen = [];
  let previous = new Set();
  for (let x = -30; x < 14 * 70; x += .6) {
    frame.player.x = x; run(lights, frame, .02, .02);
    const real = lights.stats().real;
    assert.ok(real.length <= LAMP.maxLights, `${real.length} real lights`);
    assert.ok(spots().filter(s => s.visible && s.intensity > 0).length <= LAMP.maxLights);
    const now = new Set(real);
    for (const id of now) if (!previous.has(id)) joined.set(id, (joined.get(id) ?? 0) + 1);
    previous = now; seen.push(now.size);
  }
  assert.ok(Math.max(...seen) === LAMP.maxLights);
  for (const [id, n] of joined) assert.ok(n <= 1, `${id} was handed a light ${n} times`);
  lights.dispose();
});

test('the lights are sodium orange, aimed straight down, and sit at the lamp', () => {
  const { scene, pois, placements } = world(4), lights = createStreetLights({ scene, pois, placements });
  const frame = { time: 0, player: new THREE.Vector3(150, 1.7, 3), darkness: 1 };
  lights.settle(); run(lights, frame, 2);
  const spots = scene.getObjectByName('Street lights').children.filter(o => o.isSpotLight && o.intensity > 0);
  assert.ok(spots.length >= 1);
  for (const s of spots) {
    assert.ok(s.color.r > s.color.g && s.color.g > s.color.b, 'orange, not white');
    assert.ok(s.color.g / s.color.r < .5, 'warm, around 2000 K');
    s.target.updateMatrixWorld();
    assert.ok(Math.abs(s.target.position.x - s.position.x) < 1e-9 && Math.abs(s.target.position.z - s.position.z) < 1e-9 && s.target.position.y < s.position.y);
    assert.ok(s.position.y === 6.5);
  }
  lights.dispose();
});

test('dispose takes everything out of the scene and frees what it made', () => {
  const { scene, pois, placements } = world(6), before = scene.children.length, lights = createStreetLights({ scene, pois, placements });
  assert.equal(scene.children.length, before + 1);
  const group = scene.getObjectByName('Street lights'), freed = [];
  group.traverse(o => { if (o.geometry) o.geometry.addEventListener('dispose', () => freed.push(o.name)); if (o.material) o.material.addEventListener('dispose', () => freed.push(o.name)); });
  lights.dispose();
  assert.equal(scene.children.length, before);
  assert.ok(freed.length >= 4, `freed ${freed.length} geometries and materials`);
  assert.equal(group.children.length, 0);
});
