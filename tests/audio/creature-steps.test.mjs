import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register-ts-hooks.mjs';
const { FOOTFALL, footfallPlan, legPitch, bedName, BEDS, createVoicePool, footSurface, creakPlan, FOOT_TAGS } = await import('../../game/audio/creature-steps.ts');
const { createRandom } = await import('../../game/sim/creature/creature-brain.ts');

const SURFACES = ['earth', 'rock', 'wood', 'road', 'water', 'bark', 'metal', 'stone'];

test('a footfall past 60 m is silent, and so is one at no known distance', () => {
  assert.equal(FOOTFALL.maxDistance, 60);
  assert.equal(footfallPlan({ surface: 'earth', speed: 4, leg: 0, distance: 60.5 }), undefined);
  assert.ok(footfallPlan({ surface: 'earth', speed: 4, leg: 0, distance: 59 }));
  assert.equal(footfallPlan({ surface: 'earth', speed: 4, leg: 0, distance: NaN }), undefined);
});

test('speed scales it: a drift is a soft press, a run heavy, sharp and scraping; every surface agrees', () => {
  for (const surface of SURFACES) {
    const drift = footfallPlan({ surface, speed: 1.2, leg: 2, distance: 8 }, createRandom(1)), run = footfallPlan({ surface, speed: 11, leg: 2, distance: 8 }, createRandom(1));
    assert.ok(run.gain > drift.gain * 3, `${surface}: run ${run.gain.toFixed(3)} vs drift ${drift.gain.toFixed(3)}`);
    assert.ok(drift.gain < .1 && run.gain < .45, `${surface}: bounded`);
    assert.ok(run.duration <= drift.duration, 'no longer when it runs');
    assert.ok(run.tip.length < drift.tip.length && run.thump.decay < drift.thump.decay && run.thump.gain > drift.thump.gain, 'a sharper strike, a heavier thump');
    assert.equal(drift.scrape.gain, 0, 'no scrape when it drifts');
    const most = surface === 'metal' ? 1.2 : .5;   // an iron roof rings on
    assert.ok(run.duration < most && drift.duration < most, `${surface}: over within ${most} s`);
  }
  assert.ok(footfallPlan({ surface: 'earth', speed: 11, leg: 0, distance: 5 }, createRandom(2)).scrape.gain > .03);
});

test('the bed plays near its own pitch, .82 to 1.12 (the leg pitch moves it a little more), takes vary, and no two footfalls are alike', () => {
  const random = createRandom(9), rates = [], takes = new Set(), gains = new Set();
  for (let i = 0; i < 200; i++) {
    const p = footfallPlan({ surface: 'road', speed: 6, leg: i % 8, distance: 10 }, random);
    rates.push(p.rate); takes.add(p.take % BEDS.gravel); gains.add(p.gain.toFixed(5));
    assert.equal(p.bed, 'gravel');
  }
  assert.ok(Math.min(...rates) >= .74 && Math.max(...rates) <= 1.23, `${Math.min(...rates)} .. ${Math.max(...rates)}`);
  assert.ok(Math.min(...rates) < .9 && Math.max(...rates) > 1.05, 'covers the range');
  assert.ok(takes.size >= 8, 'takes rotate');
  assert.ok(gains.size > 150, 'gain differs every time');
});

test('each leg has its own pitch, between .91 and 1.09, and the eight differ', () => {
  const pitches = Array.from({ length: 8 }, (_, i) => legPitch(i));
  assert.ok(pitches.every(p => p >= .91 && p <= 1.09));
  assert.equal(new Set(pitches.map(p => p.toFixed(3))).size, 8);
  const a = footfallPlan({ surface: 'rock', speed: 5, leg: 0, distance: 5 }, () => .5), b = footfallPlan({ surface: 'rock', speed: 5, leg: 3, distance: 5 }, () => .5);
  assert.notEqual(a.tip.frequency, b.tip.frequency);
  assert.notEqual(a.thump.from, b.thump.from);
});

test('the surface sets the sound: beds, ticks and rustles differ; water is a splash; bark and metal borrow no bed', () => {
  const plan = surface => footfallPlan({ surface, speed: 5, leg: 1, distance: 5 }, () => .5);
  assert.equal(plan('earth').bed, 'sand'); assert.equal(plan('road').bed, 'gravel'); assert.equal(plan('wood').bed, 'wood');
  assert.equal(plan('rock').bed, 'stone'); assert.equal(plan('stone').bed, 'stone');
  assert.equal(plan('bark').bed, undefined); assert.equal(plan('metal').bed, undefined);
  assert.equal(plan('water').splash, true); assert.equal(plan('earth').splash, false);
  assert.ok(plan('wood').tip.frequency < plan('rock').tip.frequency, 'wood knocks low, rock clicks high');
  assert.ok(plan('wood').body && !plan('wood').body.ring && !plan('wood').body.sheet, 'boards knock');
  // The iron roof is a damped sheet, not a bar: low modes and a rattle, nothing ringing (it once played like a xylophone).
  const roof = plan('metal').body;
  assert.ok(roof.sheet && !roof.ring && roof.frequency < 120 && roof.rattle.length >= 3, 'the roof booms low and rattles');
  assert.ok(plan('earth').thump.thud > .7 && plan('earth').tip.gain < plan('rock').tip.gain / 5, 'dirt thuds; only hard ground clicks');
  assert.ok(plan('earth').thump.from < plan('rock').thump.from && plan('earth').thump.decay > plan('rock').thump.decay, 'soft ground: a deeper, longer thump');
  assert.ok(plan('earth').rustle.gain > plan('rock').rustle.gain, 'earth rustles');
});

test('bed names are the shipped files: gravel0..9, wood0..9, Stone{L,R}1..3, Sand{L,R}1..3', () => {
  const names = new Set(); for (let i = 0; i < 40; i++) { for (const k of ['gravel', 'wood', 'stone', 'sand']) names.add(bedName(k, i)); }
  assert.ok(names.has('gravel0') && names.has('gravel9') && names.has('wood5') && names.has('StoneL1') && names.has('StoneR3') && names.has('SandL1') && names.has('SandR3'));
  assert.equal(names.size, 10 + 10 + 6 + 6);
  assert.equal(bedName('gravel', -1), 'gravel9');
});

test('at most ten footfall voices at once; a full pool refuses and recovers as voices end', () => {
  assert.equal(FOOTFALL.maxVoices, 10);
  const pool = createVoicePool();
  for (let i = 0; i < 10; i++) assert.equal(pool.take(0, .1), true);
  assert.equal(pool.take(0.01, .1), false, 'the eleventh is dropped');
  assert.equal(pool.active(.05), 10);
  assert.equal(pool.take(.11, .1), true, 'they have ended');
  assert.equal(pool.active(.11), 1);
  pool.clear(); assert.equal(pool.active(0), 0);
});

test('what a foot is on: a tree is bark, a roof metal, a wall wood, then water, rock, wood, the road, earth', () => {
  const on = o => footSurface({ on: 'ground', normalY: 1, ground: 'forest', ...o });
  assert.equal(on({ on: 'tree', normalY: 0 }), 'bark');
  assert.equal(on({ on: 'building', normalY: .9 }), 'metal');
  assert.equal(on({ on: 'building', normalY: 0 }), 'wood');
  assert.equal(on({ ground: 'water', tag: 'rock' }), 'water', 'a wet point is wet');
  assert.equal(on({ tag: 'rock' }), 'rock'); assert.equal(on({ tag: 'river stone' }), 'rock');
  for (const tag of ['cabin floor', 'bridge deck', 'fallen log', 'step']) assert.equal(on({ tag }), 'wood', tag);
  assert.equal(on({ ground: 'road' }), 'road'); assert.equal(on({ ground: 'road', tag: 'bridge deck' }), 'wood', 'a bridge over the road');
  for (const ground of ['forest', 'dirt', 'path', 'beach']) assert.equal(on({ ground }), 'earth');
  assert.ok(FOOT_TAGS.has('rock') && FOOT_TAGS.has('cabin floor') && !FOOT_TAGS.has('tree'));
});

test('the body creaks only when it runs, more often the faster it goes', () => {
  assert.equal(creakPlan(2), undefined); assert.equal(creakPlan(5.9), undefined);
  const slow = creakPlan(6.5, () => .5), fast = creakPlan(11, () => .5);
  assert.ok(fast.gain > slow.gain && fast.next < slow.next);
  assert.ok(fast.next > .5 && slow.next < 4);
});

test('heard further off, a footfall loses its top: the air cut closes from 18 kHz at the foot toward 2 kHz at 60 m', () => {
  const at = d => footfallPlan({ surface: 'road', speed: 4, leg: 0, distance: d }, () => .5).distanceCut;
  assert.ok(at(0) > 17000 && at(30) < at(5) && at(59) < 2600);
});
