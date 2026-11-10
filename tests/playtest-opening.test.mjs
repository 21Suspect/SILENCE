import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The player bot (scripts/playtest/bot.mjs) plays the opening of a night against the real creature in the real world
 * (terrain, trunks, buildings, the noise stream), and the playtest report's rules judge it. The full report runs many
 * seeds and every play style (scripts/playtest/run.mjs); this is a few of them, kept short enough for the suite.
 */
const { playNight } = await import('../scripts/playtest/bot.mjs');
const { judgeRun, RULES } = await import('../scripts/playtest/report.mjs');

for (const [style, seed] of [['trail', 1], ['wander', 2]]) {
  test(`playtest (${style}, seed ${seed}): both encounters seen in time, nothing pops, no grab, sparse sounds`, async () => {
    const log = await playNight({ style, seed, minutes: 6.6, untilDawn: false });
    const { row, violations } = judgeRun(log);
    // The free-roam rules (dead air, the stun) need a whole night; the report checks those.
    const opening = violations.filter(v => !['never-free', 'dead-air'].includes(v.rule));
    assert.deepEqual(opening, [], opening.map(v => `${v.rule}: ${v.detail}`).join('\n'));
    assert.ok(row.e1 <= RULES.glimpseBy && row.e2 <= RULES.treeBy, `seen at ${row.e1?.toFixed(0)} s and ${row.e2?.toFixed(0)} s`);
    assert.equal(log.grabs.length, 0);
    // The reveal recording plays when it is seen, not when it is placed.
    for (const seen of log.opening.filter(e => e.type === 'seen')) assert.ok(log.sounds.some(s => s.kind === 'reveal' && Math.abs(s.t - seen.t) < .05), `reveal at the sighting at ${seen.t.toFixed(1)} s`);
    // Every placement and removal the bot saw happen was out of its view.
    assert.ok(log.transitions.length >= 4, `${log.transitions.length} placements and removals`);
    assert.deepEqual(log.visibilityPops, []);
  });
}
