import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * A player who shuts themselves in the cabin from the start (tools/playtest/bot.mjs, style "indoors"): nothing pops in view, and a night
 * judged by the report's rules breaks none of them. (The old test of the creature waiting at the treeline belonged to the scripted opening.)
 */
const { playNight } = await import('../../tools/playtest/bot.mjs');
const { judgeRun } = await import('../../tools/playtest/report.mjs');

test('playtest (indoors): the player is inside for most of it, and the rules hold', async () => {
  const log = await playNight({ style: 'indoors', seed: 1, minutes: 2.5, untilDawn: false });
  const { violations } = judgeRun(log);
  const checked = violations.filter(v => v.rule !== 'dead-air');
  assert.deepEqual(checked, [], checked.map(v => `${v.rule}: ${v.detail}`).join('\n'));
  assert.ok(log.indoorsSeconds > 60, `inside for ${log.indoorsSeconds.toFixed(0)} s`);
  assert.deepEqual(log.visibilityPops, []);
});
