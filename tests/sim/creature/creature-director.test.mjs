import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpeningDirector, OPENING } from '../game/creature-director.ts';
import { createRandom } from '../game/creature-brain.ts';

/**
 * A stand-in host: `seenAfter` seconds into each encounter the creature is recognised, and `goneAfter` seconds later it
 * has walked off and been taken away. `indoors(t)` says whether the player is inside at play time t.
 */
function play({ seed = 1, seenAfter = 5, goneAfter = 6, indoors = () => false, seconds = 600, dt = .1 } = {}) {
  const d = createOpeningDirector({ random: createRandom(seed) }), events = [];
  let t = 0, began = -1, seenAt = -1;
  while (t < seconds) {
    t += dt;
    const encounter = d.phase === 'glimpse' || d.phase === 'tree';
    if (encounter && began < 0) { began = t; seenAt = -1; }
    if (!encounter) began = -1;
    const seen = encounter && seenAfter !== Infinity && t - began >= seenAfter;
    if (seen && seenAt < 0) seenAt = t;
    const out = d.tick({ dt, indoors: indoors(t), seen, gone: seen && t - seenAt >= goneAfter });
    for (const e of out.events) events.push({ ...e, t, clock: out.clock });
  }
  return { d, events, phases: events.filter(e => e.type === 'phase').map(e => ({ to: e.to, t: +e.t.toFixed(1), clock: +e.clock.toFixed(1) })) };
}

test('the opening: quiet, the glimpse at 1:30, an interlude with one call, the tree no sooner than 3:45, breathing room, free', () => {
  const { phases, events, d } = play();
  assert.deepEqual(phases.map(p => p.to), ['glimpse', 'interlude', 'tree', 'breathing', 'free']);
  assert.ok(Math.abs(phases[0].t - OPENING.glimpseFrom) < .15, `glimpse at ${phases[0].t}`);
  assert.ok(Math.abs(phases[2].t - OPENING.treeFrom) < .15, `tree at ${phases[2].t} (the glimpse was over early, so 3:45)`);
  const call = events.filter(e => e.type === 'call');
  assert.equal(call.length, 1, 'one distant call');
  assert.ok(call[0].t > phases[1].t + OPENING.callAfter[0] - .2 && call[0].t < phases[1].t + OPENING.callAfter[1] + .2);
  const breathing = phases[4].t - phases[3].t;
  assert.ok(breathing >= OPENING.breathing[0] - .2 && breathing <= OPENING.breathing[1] + .2, `${breathing.toFixed(1)} s of breathing room`);
  assert.equal(d.scripted, false);
  assert.equal(events.filter(e => e.type === 'seen').every(e => !e.late), true);
});

test('a late glimpse pushes the tree back: at least the quiet gap after it, still inside the 6:00 window', () => {
  const { phases } = play({ seenAfter: 75 });
  const interlude = phases.find(p => p.to === 'interlude'), tree = phases.find(p => p.to === 'tree');
  assert.ok(tree.t >= interlude.t + OPENING.quietAfter - .15, `quiet from ${interlude.t} to ${tree.t}`);
});

test('unseen, it escalates every 20 s and walks into view 30 s before the deadline; a stuck encounter does not block the opening', () => {
  const { events, phases } = play({ seenAfter: Infinity, seconds: 900 });
  const glimpse = phases[0].t, escalations = events.filter(e => e.type === 'escalate' && e.t < OPENING.glimpseBy + 1);
  assert.deepEqual(escalations.map(e => Math.round(e.t - glimpse)), [20, 40, 60, 80]);
  const force = events.find(e => e.type === 'force');
  assert.ok(Math.abs(force.t - (OPENING.glimpseBy - OPENING.forceLead)) < .15, `forced at ${force.t}`);
  assert.ok(events.some(e => e.type === 'gave-up' && e.phase === 'glimpse'));
  assert.deepEqual(phases.map(p => p.to), ['glimpse', 'interlude', 'tree', 'breathing', 'free']);
  const late = play({ seenAfter: 100 });
  assert.equal(late.events.find(e => e.type === 'seen').late, true, 'seen after 3:00 is reported late');
});

test('indoors pauses the deadline only while the encounter is unseen; the quiet before it runs on', () => {
  // Inside from 0:30 to 4:00: the quiet still ends at 1:30 (play time), but the glimpse's clock stands still until they come out.
  const inside = t => t > 30 && t < 240;
  const { phases, events } = play({ indoors: inside, seenAfter: 160 });
  assert.ok(Math.abs(phases[0].t - OPENING.glimpseFrom) < .15, 'the glimpse begins on time');
  const seen = events.find(e => e.type === 'seen');
  // 150 s of the glimpse were spent inside: the clock had only run 10 s of it when they came out.
  assert.ok(seen.at < OPENING.glimpseBy, `seen at ${seen.at.toFixed(1)} on the opening clock (play time ${seen.t.toFixed(1)})`);
  assert.equal(seen.late, false);
  assert.ok(seen.t > OPENING.glimpseBy, 'though well after 3:00 of play time');
  assert.equal(events.filter(e => e.type === 'escalate' && e.t > 95 && e.t < 240).length, 0, 'no escalation while inside');
});

test('once free it stays free; the same seed replays the same opening', () => {
  const a = play({ seed: 9 }), b = play({ seed: 9 }), c = play({ seed: 10 });
  assert.deepEqual(a.phases, b.phases);
  assert.notDeepEqual(a.phases.map(p => p.t), c.phases.map(p => p.t), 'another seed breathes differently');
  const d = createOpeningDirector({ random: createRandom(1) });
  const jumped = d.jump('free');
  assert.deepEqual(jumped.map(e => e.to), ['free']);
  for (let i = 0; i < 100; i++) assert.equal(d.tick({ dt: .1, indoors: false, seen: false, gone: false }).phase, 'free');
  assert.equal(d.jump('free').length, 0);
});

test('seen but obstructed creatures cannot keep attacks locked forever', () => {
  const { d, events } = play({ seenAfter: 5, goneAfter: Infinity, seconds: 700 });
  assert.equal(d.phase, 'free');
  assert.equal(events.filter(e => e.type === 'gave-up').length, 2);
});
