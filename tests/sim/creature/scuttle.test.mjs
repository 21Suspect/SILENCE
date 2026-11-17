import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { createScuttle, SCUTTLE } = await import('../../../game/sim/creature/scuttle.ts');
const { createRandom } = await import('../../../game/sim/creature/creature-brain.ts');

const run = (asked, seconds, dt = 1 / 60, seed = 3) => {
  const s = createScuttle(createRandom(seed)), out = [];
  for (let t = 0; t < seconds; t += dt) out.push(s.factor(dt, asked, true));
  return out;
};

test('it scuttles: bursts and dead stops, and over time its mean speed is what was asked', () => {
  const f = run(1.2, 120), mean = f.reduce((a, b) => a + b, 0) / f.length;
  assert.ok(Math.abs(mean - 1) < .12, `mean factor ${mean.toFixed(3)}`);
  assert.ok(f.some(x => x === 0), 'it freezes');
  assert.ok(f.some(x => x > 1.3), 'and bursts faster than asked');
  let switches = 0; for (let i = 1; i < f.length; i++) if ((f[i] === 0) !== (f[i - 1] === 0)) switches++;
  assert.ok(switches > 80 && switches < 220, `${switches} starts and stops in two minutes`);
});

test('a spell starts with a burst, not a stop', () => {
  const s = createScuttle(createRandom(1));
  assert.ok(s.factor(1 / 60, 2, true) > 1);
});

test('a trot to a loud noise and a charge are not scuttled, nor is standing still', () => {
  const s = createScuttle(createRandom(2));
  for (const asked of [5, 11.2, 0, .1]) assert.equal(s.factor(1 / 60, asked, true), 1, `asked ${asked}`);
  assert.equal(s.factor(1 / 60, 2, false), 1, 'not a scuttling behaviour');
});

test('a burst never runs faster than the cap', () => {
  for (const asked of [1, 2, 3, 4.5]) for (const x of run(asked, 60)) assert.ok(x * asked <= SCUTTLE.top + 1e-9 && x <= SCUTTLE.maxFactor + 1e-9);
});

test('frame rate does not change the pattern: 30 and 144 fps spend the same share of time frozen', () => {
  const share = f => f.filter(x => x === 0).length / f.length;
  const a = share(run(1.5, 300, 1 / 30, 7)), b = share(run(1.5, 300, 1 / 144, 7));
  assert.ok(Math.abs(a - b) < .03, `${a.toFixed(3)} vs ${b.toFixed(3)}`);
});
