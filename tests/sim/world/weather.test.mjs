import test from 'node:test';
import assert from 'node:assert/strict';
import '../../helpers/register-ts-hooks.mjs';
const { mistWeather, createGameClock } = await import('../../../game/sim/world/weather.ts');

test('the mist comes and goes: some nights thick, some clear, never off or overwhelming', () => {
  const nights = [];
  for (let day = 0; day < 40; day++) nights.push(mistWeather(day * 24 + 3));
  assert.ok(Math.max(...nights) > 1.3 && Math.min(...nights) < .9, `${Math.min(...nights)} .. ${Math.max(...nights)}`);
  for (let t = 0; t < 2000; t += .37) { const w = mistWeather(t); assert.ok(w >= .45 && w <= 1.75); }
  // It changes slowly: over a few minutes of play (a tenth of a game hour) by a few percent at most.
  for (let t = 0; t < 500; t += 1.1) assert.ok(Math.abs(mistWeather(t + .1) - mistWeather(t)) < .06);
  // The small hours lean thicker than the afternoon, on average.
  let small = 0, afternoon = 0; for (let d = 0; d < 200; d++) { small += mistWeather(d * 24 + 4); afternoon += mistWeather(d * 24 + 16); }
  assert.ok(small > afternoon);
});

test('the game clock counts days across midnight', () => {
  const clock = createGameClock();
  assert.equal(clock(23), 23); assert.equal(clock(23.9), 23.9); assert.ok(Math.abs(clock(.1) - 24.1) < 1e-9); assert.ok(Math.abs(clock(5) - 29) < 1e-9);
});
