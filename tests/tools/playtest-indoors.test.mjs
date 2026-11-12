import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * A player who shuts themselves in the cabin from the start (tools/playtest/bot.mjs, style "indoors"): the creature
 * waits at the treeline in view of the door, and the opening's deadlines only run while they are out of doors.
 */
const { playNight } = await import('../../tools/playtest/bot.mjs');
const { judgeRun, RULES } = await import('../../tools/playtest/report.mjs');

test('playtest (indoors): it waits at the treeline in view of the door; the deadline waits while the player is inside', async () => {
  const log = await playNight({ style: 'indoors', seed: 1, minutes: 6.5, untilDawn: false });
  const { violations } = judgeRun(log);
  const opening = violations.filter(v => !['never-free', 'dead-air'].includes(v.rule));
  assert.deepEqual(opening, [], opening.map(v => `${v.rule}: ${v.detail}`).join('\n'));
  assert.ok(log.indoorsSeconds > 200, `inside for ${log.indoorsSeconds.toFixed(0)} s`);
  const waits = log.timeline.filter(e => e.type === 'transition' && e.kind === 'treeline');
  assert.ok(waits.length >= 1 && waits.every(w => !w.inView), 'placed at the treeline, out of view');
  const seen = log.opening.filter(e => e.event === 'seen');
  assert.ok(seen.length >= 1 && seen.every(e => e.at <= (e.phase === 'glimpse' ? RULES.glimpseBy : RULES.treeBy)), seen.map(e => `${e.phase} at ${e.at.toFixed(0)} s`).join(', '));
  assert.deepEqual(log.visibilityPops, []);
  assert.equal(log.grabs.length, 0);
});
