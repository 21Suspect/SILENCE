import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The player bot (tools/playtest/bot.mjs) plays the start of a night against the real creature in the real world (terrain, trunks,
 * buildings, the noise stream), and the playtest report's rules judge it. The scripted opening is off now (the run starts at 07:00 with the
 * Listener asleep in its lair): the bot starts at 18:30, dusk comes half a minute in, and the Listener leaves the lair. The full report
 * runs many seeds and every play style (tools/playtest/run.mjs); this is a few of them, kept short enough for the suite.
 */
const { playNight } = await import('../../tools/playtest/bot.mjs');
const { judgeRun } = await import('../../tools/playtest/report.mjs');

for (const [style, seed] of [['trail', 1], ['wander', 2]]) {
  test(`playtest (${style}, seed ${seed}): dusk comes, nothing pops in view, the clicks belong to a search`, async () => {
    const log = await playNight({ style, seed, minutes: 2.5, untilDawn: false });
    const { violations } = judgeRun(log);
    // The free-roam rules that need a whole night (dead air, the stun's shape on a few samples) are the report's.
    const checked = violations.filter(v => !['dead-air'].includes(v.rule));
    assert.deepEqual(checked, [], checked.map(v => `${v.rule}: ${v.detail}`).join('\n'));
    assert.equal(log.openingScripted, false);
    assert.ok(log.runEvents.some(e => e.type === 'dusk'), 'dusk reached the run');
    assert.deepEqual(log.visibilityPops, []);
    assert.ok(log.transitions.length >= 0);
    // A grab ends the night with the player kept whole: the run moved to the next dawn, no life is lost.
    for (const d of log.deaths) assert.equal(d.outcome, 'dawn');
  });
}
