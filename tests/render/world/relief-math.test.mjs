import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';

const { reliefSteps, reliefHit, patchHeightBlend, layerCount } = await import('../../../game/render/world/relief-math.ts');

// A deterministic stream of numbers in [0, 1).
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
// The answer to a march, found the slow way: thousands of steps and no refinement beyond that.
const truth = (height, top, bottom) => reliefHit(height, top, bottom, 4000, 0, 4000);

test('step count follows the shift in pixels and stays between its bounds', () => {
  assert.equal(reliefSteps(.1, .005, 1.5, 6, 24), 14);       // .1 m of shift over 7.5 mm steps
  assert.equal(reliefSteps(.004, .005, 1.5, 6, 24), 6);      // looking down: almost no shift, the floor of the range
  assert.equal(reliefSteps(2, .002, 1.5, 6, 24), 24);        // grazing and close: the cost bound
  // Below the bound one step moves the lookup no more than 1.5 pixels; the first version's ten steps through .2 m of relief
  // moved it 8 pixels or more at the same distance (a 5 mm pixel, a ray at 25 degrees).
  for (const [shift, footprint] of [[.05, .004], [.08, .006], [.03, .003], [.1, .008]]) {
    const steps = reliefSteps(shift, footprint, 1.5, 6, 24);
    assert.ok(steps === 24 || shift / steps / footprint <= 1.5 + 1e-9, `${shift} m over ${footprint} m pixels: ${steps} steps`);
  }
  const first = .2 * 2.1 / 10 / .005;
  assert.ok(first > 8, `the first version moved the lookup ${first} pixels a step`);
});

test('a flat relief is met exactly, whatever the step count', () => {
  for (const steps of [1, 3, 10, 24]) for (const level of [.35, .5, .62, .74]) {
    const hit = reliefHit(() => level, .8, .3, steps, 3);
    assert.ok(Math.abs(hit - (.8 - level) / .5) < 1e-9, `steps ${steps} level ${level}: ${hit}`);
  }
});

test('a ray inside the relief at the start hits at once, and one that never meets it runs to the floor', () => {
  assert.equal(reliefHit(() => .95, .8, .3, 12, 3), 0);
  assert.equal(reliefHit(() => .1, .8, .3, 12, 3), 1);
});

test('a tilted relief is met exactly (the line through the bisected step is exact for a line)', () => {
  const hit = reliefHit(t => .7 - .3 * t, .8, .3, 7, 2), expected = (.8 - .7 + .3 * hit) / .5;   // g(t) = (.8 - h(t)) / .5 - t = 0
  assert.ok(Math.abs(hit - expected) < 1e-9);
});

// A relief like a scan's: random heights (value noise) with a correlation length of 1.2 cm, standard deviation .07 of the map's range.
const hash = n => { let s = (n * 374761393 + 668265263) >>> 0; s = ((s ^ (s >>> 13)) * 1274126177) >>> 0; return ((s ^ (s >>> 16)) >>> 0) / 4294967296; };
const noise = ell => x => { const u = x / ell, i = Math.floor(u), f = u - i, s = f * f * (3 - 2 * f); return hash(i) * (1 - s) + hash(i + 1) * s; };
const scan = noise(.012), scanHeight = x => .56 + (scan(x) - .5) * .35;

/** Mean error, in metres of where the lookup lands, of a march against the slow answer, over rays 5 mm apart across the scan. */
function lookupError(depth, [top, bottom], steps, refine) {
  const length = depth * (top - bottom) * 3;   // the lookup's shift over the whole depth, for a ray at 18 degrees to the ground
  let error = 0, n = 0;
  for (let k = 0; k < 400; k++) {
    const origin = k * .005, h = t => scanHeight(origin + t * length);
    error += Math.abs(reliefHit(h, top, bottom, steps, refine) - truth(h, top, bottom)) * length; n++;
  }
  return error / n;
}

test('on a random relief the new march lands the lookup within a millimetre, the first version within centimetres', () => {
  // The first version: .2 m deep over the whole 0..1 of the map, ten steps, one straight line through the last two samples.
  const first = lookupError(.2, [1, 0], 10, 0);
  // The new one: the scan's own depth (path: 2.3 cm) over the band of heights the scan uses, steps to the shift, bisection.
  const fixed = lookupError(.023, [.75, .39], reliefSteps(.023 * .36 * 3, .005, 1.5, 6, 24), 3);
  assert.ok(first > .01, `the first version's mean error ${first * 1000} mm`);
  assert.ok(fixed < .001, `the new march's mean error ${fixed * 1000} mm`);
  assert.ok(fixed < first / 20);
});

test('on that relief, the march\'s own changes help at the first version\'s depth too', () => {
  const depth = .2, whole = lookupError(depth, [1, 0], 10, 0), band = lookupError(depth, [.75, .39], 10, 0);
  const adaptive = lookupError(depth, [.75, .39], reliefSteps(depth * .36 * 3, .005, 1.5, 6, 24), 3);
  assert.ok(band < whole * .75, `the scan band ${band} against the whole map ${whole}`);
  assert.ok(adaptive < band * .6, `more steps and bisection ${adaptive} against ${band}`);
});

test('bisecting the last step beats one straight line through it on a smooth relief', () => {
  const height = t => .55 + .15 * Math.sin(t * 2.2);
  for (const steps of [3, 4, 6, 8]) {
    let line = 0, bisected = 0;
    for (let k = 0; k < 100; k++) {
      const top = .66 + k * 1e-3, right = truth(height, top, .3);
      line += Math.abs(reliefHit(height, top, .3, steps, 0) - right);
      bisected += Math.abs(reliefHit(height, top, .3, steps, 3) - right);
    }
    assert.ok(bisected < line * .2, `${steps} steps: bisected ${bisected / 100} against line ${line / 100}`);
  }
});

test('the height blend sums to one, lets the taller tap through, and shares when they are level', () => {
  const sum = b => b[0] + b[1] + b[2];
  const level = patchHeightBlend([.4, .4, .2], [.5, .5, .5], .16);
  assert.ok(Math.abs(sum(level) - 1) < 1e-9);
  assert.ok(Math.abs(level[0] - level[1]) < 1e-9 && level[0] > level[2]);
  // Two taps equally wanted: the one standing taller takes the pixel.
  const tall = patchHeightBlend([.5, .5, 0], [.8, .3, .5], .16);
  assert.ok(tall[0] > .99 && tall[1] < .01 && tall[2] === 0);
  // Close in height they share, in proportion to how far each stands over the cut.
  const near = patchHeightBlend([.5, .5, 0], [.55, .5, .5], .16);
  assert.ok(near[0] > near[1] && near[1] > 0);
});

test('a plain weight over .93 always takes the whole pixel (the shader reads one tap there)', () => {
  const random = rng(11);
  for (let k = 0; k < 20000; k++) {
    const raw = [random() ** 3, random() ** 3, random() ** 3].map((v, i) => v + (i === 0 ? 4 : 0)), s = raw[0] + raw[1] + raw[2], w = raw.map(v => v / s);
    if (w[0] <= .93) continue;
    const b = patchHeightBlend(w, [random(), random(), random()], .16);
    assert.ok(b[0] === 1 && b[1] === 0 && b[2] === 0, `weights ${w} gave ${b}`);
  }
});

test('the height blend cuts the layering: fewer scan copies per pixel than the plain cubed blend', () => {
  const random = rng(3), cubed = [], blended = [];
  for (let k = 0; k < 20000; k++) {
    let x = random(), y = random(); if (x + y > 1) { x = 1 - x; y = 1 - y; }
    const bary = [1 - x - y, x, y].map(v => v ** 3), s = bary[0] + bary[1] + bary[2], w = bary.map(v => v / s);
    cubed.push(layerCount(w));
    blended.push(layerCount(patchHeightBlend(w, [random(), random(), random()], .16)));
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(mean(cubed) > 1.4, `cubed blend ${mean(cubed)} copies on average`);
  assert.ok(mean(blended) < 1.25, `height blend ${mean(blended)} copies on average`);
  assert.equal(layerCount([1, 0, 0]), 1);
  assert.ok(Math.abs(layerCount([1 / 3, 1 / 3, 1 / 3]) - 3) < 1e-9);
});
