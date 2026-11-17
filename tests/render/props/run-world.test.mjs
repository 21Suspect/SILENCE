import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import '../../helpers/register-ts-hooks.mjs';
globalThis.location ??= { search: '' }; // the rebuilt world, as in the browser
const { initialState, applyAction } = await import('../../../game/sim/objectives/objectives.ts');
const { createContainers, bankedIn, depositable } = await import('../../../game/render/props/containers.ts');
const { createLandingPad } = await import('../../../game/render/props/landing-pad.ts');
const { createHelicopter, HELI } = await import('../../../game/render/props/helicopter.ts');
const { createObjectivesRuntime } = await import('../../../game/render/props/objectives-runtime.ts');
const { generatorBuffer, helicopterBuffer, MAIN_ROTOR_HZ } = await import('../../../game/audio/helicopter-audio.ts');

const me = 'p1';
const items = () => ({ ...initialState().items,
  'pad-bulbs': { kind: 'bulbs', poi: 'chapel', status: 'world', part: 'pad-bulbs' }, 'pad-cable': { kind: 'cable', poi: 'mine', status: 'world', part: 'pad-cable' },
  'pad-fuel': { kind: 'jerry', poi: 'camp', status: 'world', part: 'pad-fuel' } });
/** A tiny host: one state, the real reducer, the registered prompts. */
const host = (state = initialState(items())) => {
  const h = { state, registered: new Map(), events: [] };
  h.dispatch = a => { const r = applyAction(h.state, a); h.state = r.state; h.events.push(...r.events); return r.events; };
  h.interaction = { register: item => { h.registered.set(item.id, item); return () => h.registered.delete(item.id); } };
  h.label = id => { const l = h.registered.get(id).label; return typeof l === 'function' ? l() : l; };
  h.ok = id => h.registered.get(id).enabled();
  h.use = id => h.registered.get(id).activate();
  h.give = (...ids) => { for (const id of ids) h.dispatch({ type: 'pickup', player: me, item: id }); };
  return h;
};
const quiet = fn => { const original = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = original; } };

test('a part is put in the chest or taken out with the words the prompt says, and the count shows', () => {
  const h = host(); h.give('backpack-cabin');
  const sites = { chest: { lid: new THREE.Vector3(0, 1, 0), front: new THREE.Vector3(0, .5, 0) } };
  createContainers({ interaction: h.interaction, state: () => h.state, dispatch: h.dispatch, me, sites });
  assert.deepEqual([...h.registered.keys()].sort(), ['bank:chest:put', 'bank:chest:take']);
  assert.equal(h.ok('bank:chest:put'), false, 'empty hands, empty pack: nothing to put in'); assert.equal(h.ok('bank:chest:take'), false, 'and nothing in it');
  h.give('pad-bulbs'); h.give('pad-cable');
  assert.equal(h.label('bank:chest:put'), 'Left click to put the bulbs in the chest');
  h.use('bank:chest:put');
  assert.deepEqual(bankedIn(h.state, 'chest'), ['pad-bulbs']);
  assert.equal(depositable(h.state, me).id, 'pad-cable', 'the next thing is in the backpack, offered from there');
  h.use('bank:chest:put');
  assert.deepEqual(bankedIn(h.state, 'chest'), ['pad-bulbs', 'pad-cable']);
  assert.equal(h.ok('bank:chest:put'), false);
  assert.equal(h.label('bank:chest:take'), 'Left click to take the bulbs from the chest (2 inside)');
  h.use('bank:chest:take');
  assert.equal(h.state.carrying[me], 'pad-bulbs'); assert.equal(h.label('bank:chest:take'), 'Left click to take the cable from the chest');
});

test('a full hand says so, and a heavy can needs the hand even with room in the pack', () => {
  const h = host(); h.give('backpack-cabin', 'pad-fuel');
  createContainers({ interaction: h.interaction, state: () => h.state, dispatch: h.dispatch, me, sites: { pad: { lid: new THREE.Vector3(), front: new THREE.Vector3() } } });
  h.use('bank:pad:put'); assert.deepEqual(bankedIn(h.state, 'pad'), ['pad-fuel']);
  h.give('fuse-mine'); assert.equal(h.state.carrying[me], 'fuse-mine');
  assert.equal(h.label('bank:pad:take'), 'Hands full', 'room in the pack does not help a can');
  h.dispatch({ type: 'drop', player: me }); assert.equal(h.label('bank:pad:take'), 'Left click to take the jerry can from the crate');
});

// A pad in a made-up frame: the lamps in a ring round the middle, the box off to one side.
const padPois = () => {
  const hooks = { 'landing-pad': { light0: [6, .45, 0], light1: [0, .45, 6], light2: [-6, .45, 0], light3: [0, .45, -6], switch: [7.4, .92, 1.7], cable_in: [7.2, .5, 1.6] }, 'pad-generator': { pullcord: [10, .4, 3] } };
  return {
    hook: (id, name) => { const h = hooks[id]?.[name]; return h ? new THREE.Vector3(...h) : undefined; },
    seats: () => [{ id: 'landing-pad', placement: { x: 0, z: 0, yaw: 0 }, ground: 0 }, { id: 'pad-generator', placement: { x: 10.2, z: 3.4, yaw: 0 }, ground: .1 }],
  };
};

test('the pad takes its four steps at the right places with the right thing in hand, and lights up', () => {
  const h = host(), s = new THREE.Scene();
  const audioCalls = [], audio = { setHum: (id, at, level) => audioCalls.push([id, !!at, level]) };
  const pad = quiet(() => createLandingPad({ scene: s, heightAt: () => 0, pois: padPois(), interaction: h.interaction, state: () => h.state, dispatch: h.dispatch, me, audio }));
  assert.equal(pad.lampCount, 4);
  assert.equal(h.label('pad:switch'), 'The lamps have no bulbs', 'the switch says what is missing');
  assert.equal(h.ok('pad:cable'), false); assert.equal(h.ok('pad:refuel'), false); assert.equal(h.ok('pad:bulbs:0'), false);
  h.give('pad-bulbs'); assert.equal(h.ok('pad:bulbs:2'), true, 'at any lamp'); assert.equal(h.ok('pad:bulbs:box'), true, 'or at the box');
  h.use('pad:bulbs:1'); assert.equal(h.state.pad.bulbs, true); assert.equal(h.ok('pad:bulbs:0'), false);
  h.give('pad-cable'); assert.equal(h.ok('pad:cable'), true); h.use('pad:cable');
  assert.equal(h.label('pad:switch'), 'The generator has no fuel');
  h.use('pad:switch'); assert.equal(h.state.pad.lit, false, 'a dry flick goes nowhere');
  h.give('pad-fuel'); assert.equal(h.ok('pad:refuel'), true); h.use('pad:refuel'); assert.ok(h.state.pad.fuel > 0);
  assert.equal(h.label('pad:switch'), 'Left click to switch the lights on');
  const group = s.getObjectByName('Landing pad');
  assert.equal(group.getObjectByName('Pad bulbs').visible, false, 'before the first frame');
  const player = new THREE.Vector3(5, 1.7, 0);
  pad.update(.016, 0, player);
  assert.equal(group.getObjectByName('Pad bulbs').visible, true); assert.equal(group.getObjectByName('Pad bulbs').children.length, 8, 'a base and a globe at each of four sockets');
  assert.ok(group.getObjectByName('Pad cable'), 'the cable is laid'); assert.equal(pad.level, 0);
  h.use('pad:switch'); assert.equal(h.state.pad.lit, true);
  for (let i = 0; i < 120; i++) pad.update(.016, i * .016, player);
  assert.ok(pad.level > .95, `the lamps are up: ${pad.level}`);
  const lights = []; group.traverse(x => { if (x.isPointLight) lights.push(x); });
  assert.equal(lights.length, 2, 'two real lights, always there'); assert.ok(lights[0].intensity > 5 && lights[1].intensity > 2);
  assert.ok(audioCalls.some(([id, on]) => id === 'pad' && on), 'its generator hums while lit');
  h.use('pad:switch'); for (let i = 0; i < 200; i++) pad.update(.016, i * .016, player);
  assert.equal(pad.level, 0); assert.equal(lights[0].intensity, 0, 'dark again: the light is still there, at zero');
  pad.dispose(); assert.equal(h.registered.size, 0, 'every prompt withdrawn'); assert.equal(s.children.length, 0);
});

const flight = (h, over = {}) => {
  const s = new THREE.Scene(), heli = createHelicopter({ scene: s, pad: { x: 0, z: 0, yaw: .4, top: 10 }, state: () => h.state, dispatch: h.dispatch, me, interaction: h.interaction,
    load: () => Promise.reject(new Error('no model')), collisions: { replace: (name, list) => { h.colliders = list; } }, ...over });
  const clock = hours => { h.state = { ...h.state, clock: hours }; };
  const fly = (seconds, dt = .05) => { for (let t = 0; t < seconds; t += dt) heli.update(dt, t); };
  return { heli, s, clock, fly };
};
const called = (h, arrives) => { h.state = { ...h.state, phase: 'signalSent', signalBy: me, clock: 0, helicopter: { status: 'inbound', arrives, until: null, calls: 1 } }; };

test('called, it comes in from the sea a little before dawn, circles a dark pad, and leaves when the reducer says so', () => {
  quiet(() => {
    const h = host(), { heli, clock, fly } = flight(h);
    fly(2); assert.equal(heli.phase, 'away'); assert.equal(heli.visible, false, 'nothing is drawn until it is called');
    called(h, 10); clock(9.7); fly(.2); assert.equal(heli.phase, 'away', 'too early');
    clock(9.85); fly(.1); assert.equal(heli.phase, 'approach');
    const start = heli.position.clone(); assert.ok(Math.hypot(start.x, start.z) > HELI.startDistance * .9, `out at sea: ${start.x},${start.z}`); assert.ok(start.y > 100);
    fly(40); assert.equal(heli.phase, 'orbit', 'then it circles over the pad');
    for (let i = 0; i < 100; i++) { fly(.1); const d = Math.hypot(heli.position.x, heli.position.z); assert.ok(d > 20 && d < 120, `circling at ${d.toFixed(0)} m`); assert.ok(heli.position.y > 25); }
    // The reducer gives up on the dark pad.
    h.state = { ...h.state, helicopter: { status: 'gone', arrives: null, until: null, calls: 1 } };
    fly(120); assert.equal(heli.phase, 'away'); assert.equal(heli.visible, false);
  });
});

test('on a lit pad it lands on the slab and can be boarded; boarding calls the world', () => {
  quiet(() => {
    const h = host(); let boarded = 0; const { heli, clock, fly } = flight(h, { onBoard: () => { boarded++; } });
    called(h, 10); clock(9.9); fly(1);
    assert.equal(heli.phase, 'approach');
    h.state = { ...h.state, clock: 10, pad: { bulbs: true, cable: true, fuel: 1, lit: true }, helicopter: { status: 'landed', arrives: 10, until: 10.17, calls: 1 } };
    assert.equal(h.ok('helicopter:left'), false, 'not before it is down');
    fly(40); assert.equal(heli.phase, 'landed'); assert.equal(heli.position.y, 10, 'the skids rest on the slab'); assert.ok(Math.hypot(heli.position.x, heli.position.z) < .01);
    assert.equal(h.colliders.length, 1, 'a landed helicopter is solid'); assert.equal(h.colliders[0].tag, 'helicopter');
    assert.equal(heli.rpm, 1, 'rotors turning');
    assert.equal(h.ok('helicopter:left'), true); assert.equal(h.ok('helicopter:right'), true); assert.equal(h.label('helicopter:left'), 'Left click to board the helicopter');
    const door = heli.doors().left; assert.ok(door.distanceTo(new THREE.Vector3(0, 11, 0)) < 2.5, 'at the doors');
    h.use('helicopter:right');
    assert.equal(h.state.phase, 'escaped'); assert.equal(boarded, 1); assert.equal(h.ok('helicopter:left'), false);
  });
});

test('lights switched on while it circles bring it down; the lights going out send it off from the pad', () => {
  quiet(() => {
    const h = host(), { heli, clock, fly } = flight(h);
    called(h, 10); clock(10.05); h.state = { ...h.state, helicopter: { status: 'circling', arrives: 10, until: 10.3, calls: 1 } };
    fly(3); assert.equal(heli.phase, 'orbit');
    h.state = { ...h.state, helicopter: { status: 'landed', arrives: 10, until: 10.2, calls: 1 } };
    fly(30); assert.equal(heli.phase, 'landed');
    h.state = { ...h.state, helicopter: { status: 'gone', arrives: null, until: null, calls: 1 } };
    fly(1); assert.equal(heli.phase, 'depart'); assert.equal(h.colliders.length, 0, 'no longer solid once it lifts');
    fly(5); assert.ok(heli.position.y > 12, 'climbing'); fly(120); assert.equal(heli.phase, 'away');
  });
});

test('seeded parts lie on their hook, or on the ground at their x/z, and can be picked up there', () => {
  const placements = [{ id: 'chapel-1', asset: 'chapel', x: 100, z: 0, yaw: 0 }, { id: 'cabin', asset: 'cabin', x: 0, z: 0, yaw: 0 }];
  const seeded = {
    'call-fuse-1': { kind: 'fuse', poi: 'chapel', poiId: 'chapel-1', hook: 'fuse', status: 'world', part: 'call-fuse-1' },
    'pad-bulbs': { kind: 'bulbs', poi: 'chapel', poiId: 'chapel-1', status: 'world', part: 'pad-bulbs', at: { x: 104, z: 3 } },
    'backpack-cabin': { kind: 'backpack', poi: 'cabin', status: 'world' },
  };
  const pois = { hook: (id, name) => id === 'chapel-1' && name === 'fuse' ? new THREE.Vector3(101, 1.2, 1) : id === 'cabin' && name === 'backpack' ? new THREE.Vector3(2, 1, 2) : undefined, object: () => undefined };
  const registered = new Map(), camera = new THREE.PerspectiveCamera();
  const rt = createObjectivesRuntime({ scene: new THREE.Scene(), camera, heightAt: (x, z) => x * .01 + z * .1, placements, pois, newState: () => initialState(structuredClone(seeded)), load: () => new Promise(() => {}),
    interaction: { register: item => { registered.set(item.id, item); return () => registered.delete(item.id); } } });
  assert.deepEqual([...registered.keys()].sort(), ['pickup:backpack-cabin', 'pickup:call-fuse-1', 'pickup:pad-bulbs']);
  assert.deepEqual(registered.get('pickup:call-fuse-1').position.toArray(), [101, 1.2 + .08, 1]);
  const ground = registered.get('pickup:pad-bulbs').position;
  assert.deepEqual([ground.x, ground.z], [104, 3]); assert.ok(Math.abs(ground.y - (104 * .01 + 3 * .1 + .08)) < 1e-9, `on the terrain: ${ground.y}`);
  registered.get('pickup:pad-bulbs').activate(); assert.equal(rt.state.carrying.local, 'pad-bulbs');
  rt.reset(); assert.equal(rt.state.carrying.local, undefined, 'a restart puts the parts back'); assert.equal(rt.state.items['pad-bulbs'].status, 'world');
  rt.dispose();
});

test('the machines\' sounds are rendered from nothing: the right length, loud enough, and the thump keeps the rotor\'s time', () => {
  const context = { sampleRate: 8000, createBuffer: (c, n, rate) => { const data = new Float32Array(n); return { length: n, sampleRate: rate, getChannelData: () => data }; } };
  for (const [name, buffer, seconds] of [['generator', generatorBuffer(context), 2], ['helicopter', helicopterBuffer(context), 1]]) {
    const data = buffer.getChannelData(0); assert.equal(buffer.length, 8000 * seconds, name);
    const peak = Math.max(...data.map(Math.abs)); assert.ok(peak > .15 && peak <= 1, `${name} peak ${peak}`);
    assert.ok(data.every(Number.isFinite));
  }
  // Ten slaps a second at five turns of two blades: each pulse starts on the beat and has died away before the next.
  const heli = helicopterBuffer(context).getChannelData(0), bin = 8000 / (MAIN_ROTOR_HZ * 2), energy = (k, from, to) => { let e = 0; for (let i = Math.floor((k + from) * bin); i < Math.floor((k + to) * bin); i++) e += heli[i] * heli[i]; return e; };
  assert.ok(energy(0, 0, .25) > energy(0, .5, .75) * 2 && energy(3, 0, .25) > energy(3, .5, .75) * 2);
});
