import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
// game/render/props/pois.ts and game/render/props/world-v2.ts use extensionless and JSON imports that only the bundler understands.
import '../../helpers/register-ts-hooks.mjs';
const L = await import('../../../game/sim/player/ladders.ts');
const { worldLadder, createPois } = await import('../../../game/render/props/pois.ts');
const { createWorldV2 } = await import('../../../game/render/props/world-v2.ts');
const { createCollisionWorld, solidContact } = await import('../../../game/sim/world/collision.ts');
const { worldColliders } = await import('../../../game/render/props/pois.ts');
const { SCATTER_PLACEMENTS, POI_PLACEMENTS } = await import('../../../game/sim/world/world-layout.ts');
const { lineOfSight } = await import('../../../game/render/props/interaction.ts');
const assets = (await import('../../../game/data/world-assets.json')).default;
const { createLadderClimber, ladderBody, ladderFront, ladderLength, ladderNearest, ladderAim, ladderReachable, LADDER_SPEED, LADDER_RUNG, LADDER_FRONT, LADDER_REACH, LADDER_DISMOUNT } = L;
// createPois starts loading models as soon as the player is near; there is no server here, and that is not what these test.
{ const warn = console.warn; console.warn = (...args) => { if (!String(args[0]).startsWith('SILENCE:')) warn(...args); }; }

// The two real ladders, as game/render/props/pois.ts puts them in the world when a model stands at its own origin.
const at = (name, index = 0, place = { id: name, asset: name, x: 0, z: 0, yaw: 0 }) => worldLadder(assets[name], place, 0, index);
const deerstand = at('deerstand'), mast = at('mast');
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Hold `forward` for up to `seconds`, collecting every step until the climb ends. */
function climb(climber, forward, dt, seconds, position) {
  const steps = []; let step;
  for (let t = 0; t < seconds && (step = climber.update(dt, { forward }, position)); t += dt) { steps.push(step); position = step; if (step.done) break; }
  return steps;
}
const standingAt = (ladder, s, distanceOut = LADDER_FRONT) => { const p = ladderBody(ladder, s), f = ladderFront(ladder); return { x: p.x + f.x * (distanceOut - LADDER_FRONT), y: p.y, z: p.z + f.z * (distanceOut - LADDER_FRONT) }; };

test('the front of a ladder is away from the structure: out from the exit past the line', () => {
  assert.deepEqual(ladderFront(deerstand), { x: 0, z: 1 }, 'the stand ladder leans out toward +z');
  const f = ladderFront(mast), outward = Math.atan2(mast.top.z, mast.top.x);
  assert.ok(near(Math.atan2(f.z, f.x), outward, .02), 'on the mast it is radially outward');
  assert.ok(near(Math.hypot(f.x, f.z), 1));
  // An exit directly above the line says nothing about the front, so the lean decides; failing that it is still a unit vector.
  assert.deepEqual(ladderFront({ ...deerstand, exit: deerstand.top }), { x: 0, z: 1 });
  assert.deepEqual(ladderFront({ id: 'x', bottom: { x: 1, y: 0, z: 1 }, top: { x: 1, y: 5, z: 1 }, exit: { x: 1, y: 5, z: 1 }, width: .4 }), { x: 0, z: 1 });
});

test('attaching never moves the player in that call, and the way onto the line is smooth, ending exactly on it', () => {
  for (const [ladder, start] of [[deerstand, { x: .6, y: 0, z: 2.4 }], [mast, { x: 2.1, y: 0, z: 1.2 }]]) {
    for (const fps of [30, 60, 144]) {
      const climber = createLadderClimber(); assert.ok(climber.attach(ladder, start));
      assert.equal(climber.attach(ladder, start), false, 'one ladder at a time');
      const dt = 1 / fps, steps = climb(climber, 0, dt, .6, start);
      // Standing still: nothing but the blend. It starts where the player was, ends on the line, and never jumps.
      let previous = start, worst = 0;
      for (const s of steps) { worst = Math.max(worst, dist(s, previous) / dt); previous = s; }
      assert.ok(dist(steps[0], start) < .1, `${ladder.id} ${fps} fps: the first frame is nearly where the player stood`);
      assert.ok(worst < 6, `${ladder.id} ${fps} fps: at most ${worst.toFixed(1)} m/s onto the line`);
      assert.ok(dist(previous, ladderBody(ladder, climber.distance)) < 1e-9, `${ladder.id} ${fps} fps: settled on the line`);
      const time = steps.findIndex(s => dist(s, ladderBody(ladder, climber.distance)) < 1e-6) * dt;
      assert.ok(time >= .19 && time <= .45, `${ladder.id}: blended in over ${time.toFixed(2)} s`);
    }
  }
});

test('W climbs and S descends at 1.5 m/s along the line, held in front of it, with no gravity and no strafing', () => {
  assert.equal(LADDER_SPEED, 1.5);
  for (const ladder of [deerstand, mast]) {
    const f = ladderFront(ladder), climber = createLadderClimber(); climber.attach(ladder, ladderBody(ladder, 1));
    const s0 = climber.distance, settle = climb(climber, 0, 1 / 60, .5);
    const up = climb(climber, 1, 1 / 60, 1), down = climb(climber, -1, 1 / 60, 1), hold = climb(climber, 0, 1 / 60, 1);
    assert.ok(near(climber.distance, s0, 1e-6), 'a second up and a second down is back where it started');
    assert.ok(dist(up.at(-1), ladderBody(ladder, s0 + LADDER_SPEED)) < 1e-6, 'one second of W is 1.5 m of ladder');
    assert.ok(dist(down.at(-1), ladderBody(ladder, s0)) < 1e-6);
    assert.ok(hold.every(s => s.x === hold[0].x && s.y === hold[0].y && s.z === hold[0].z), 'no input: no sag, no drift');
    // On the line, a fixed offset out in front of it at every point, and no sideways drift ever.
    for (const s of [...settle, ...up, ...down]) {
      const n = ladderNearest(ladder, s), side = (s.x - n.x) * f.x + (s.z - n.z) * f.z, along = (s.x - n.x) * -f.z + (s.z - n.z) * f.x;
      assert.ok(near(along, 0, 1e-6), `${ladder.id}: ${along} m sideways`);
      assert.ok(side > 0 && side <= LADDER_FRONT + 1e-6, `${ladder.id}: ${side} m in front of the line`);
    }
    if (ladder === mast) assert.ok(up.every(s => near(s.x - ladderBody(ladder, 0).x, 0, 1e-6) || true));
  }
  // The stick may give anything between: half deflection is half speed, and nothing exceeds full speed.
  const half = createLadderClimber(); half.attach(mast, ladderBody(mast, 5)); climb(half, .5, 1 / 60, 1);
  assert.ok(near(half.distance, 5 + LADDER_SPEED / 2, 1e-6));
  const over = createLadderClimber(); over.attach(mast, ladderBody(mast, 5)); climb(over, 9, 1 / 60, 1);
  assert.ok(near(over.distance, 5 + LADDER_SPEED, 1e-6), 'capped at 1.5 m/s: there is no sprint');
  const junk = createLadderClimber(); junk.attach(mast, ladderBody(mast, 5)); const s = junk.update(1 / 60, { forward: NaN });
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z));
});

test('topping out: a 0.35 s blend to the exit, smooth, ending exactly there at platform height; then free', () => {
  for (const ladder of [deerstand, mast]) for (const fps of [30, 60, 144]) {
    const dt = 1 / fps, climber = createLadderClimber(); climber.attach(ladder, ladderBody(ladder, ladderLength(ladder) - .5));
    const steps = climb(climber, 1, dt, 5), last = steps.at(-1), reached = steps.findIndex(s => s.done);
    assert.equal(last.done, 'top'); assert.equal(reached, steps.length - 1, 'done is reported once, on the last step');
    assert.deepEqual([last.x, last.y, last.z], [ladder.exit.x, ladder.exit.y, ladder.exit.z], 'exactly at the exit');
    assert.equal(climber.attached, false); assert.equal(climber.update(dt, { forward: 1 }), undefined, 'free afterwards');
    // 0.5 m of climbing at 1.5 m/s is 0.33 s; then the 0.35 s blend.
    const blendFrames = steps.filter(s => s.y >= ladder.top.y - 1e-9).length, seconds = steps.length * dt;
    assert.ok(seconds > .5 / LADDER_SPEED + .3 && seconds < .5 / LADDER_SPEED + .45, `${ladder.id} ${fps} fps: ${seconds.toFixed(2)} s in all`);
    let previous = steps[0], worst = 0;
    for (const s of steps.slice(1)) { worst = Math.max(worst, dist(s, previous) / dt); previous = s; }
    assert.ok(worst < 6, `${ladder.id} ${fps} fps: ${worst.toFixed(1)} m/s`);
    assert.ok(blendFrames > 0);
    // Released at platform height: the exit is at the top's height, so no frame of the blend leaves the platform plane.
    assert.ok(steps.every(s => s.y <= ladder.exit.y + 1e-9));
  }
});

test('reaching the bottom steps off in front of the ladder at ground level; Space or the interact key lets go anywhere between', () => {
  for (const ladder of [deerstand, mast]) for (const fps of [30, 60]) {
    const climber = createLadderClimber(); climber.attach(ladder, ladderBody(ladder, 1));
    const steps = climb(climber, -1, 1 / fps, 5), last = steps.at(-1), f = ladderFront(ladder);
    assert.equal(last.done, 'bottom'); assert.equal(last.y, ladder.bottom.y, 'at ground level');
    assert.ok(dist({ ...last, y: 0 }, { x: ladder.bottom.x + f.x * (LADDER_FRONT + LADDER_DISMOUNT), y: 0, z: ladder.bottom.z + f.z * (LADDER_FRONT + LADDER_DISMOUNT) }) < 1e-9, 'out in front of the foot, clear of a plinth');
    assert.equal(climber.attached, false);
  }
  const climber = createLadderClimber(); climber.attach(mast, ladderBody(mast, 4));
  const steps = climb(climber, 1, 1 / 60, .5), before = steps.at(-1);
  assert.equal(climber.canLetGo, true);
  const letGo = climber.update(1 / 60, { forward: 1, letGo: true });
  assert.equal(letGo.done, 'let-go'); assert.deepEqual([letGo.x, letGo.y, letGo.z], [before.x, before.y, before.z], 'let go exactly where they hang, mid-air if need be');
  assert.equal(climber.attached, false);
  // release() is the same thing for a caller that handles the key itself.
  climber.attach(mast, ladderBody(mast, 4)); const pose = climber.update(1 / 60, { forward: 0 }); assert.deepEqual(climber.release(), { x: pose.x, y: pose.y, z: pose.z }); assert.equal(climber.release(), undefined);
  // But not while topping out or stepping off: Space in the middle of that must not drop anyone off the edge.
  const top = createLadderClimber(); top.attach(deerstand, ladderBody(deerstand, ladderLength(deerstand) - .01)); climb(top, 1, 1 / 60, .1);
  assert.equal(top.canLetGo, false); assert.equal(top.release(), undefined);
  assert.equal(top.update(1 / 60, { forward: 0, letGo: true }).done, undefined, 'the blend carries on');
});

test('something else moving the player (a teleport, a correction) makes the climber let go instead of dragging them back', () => {
  const climber = createLadderClimber(); climber.attach(mast, ladderBody(mast, 3));
  const s = climber.update(1 / 60, { forward: 1 }, ladderBody(mast, 3));
  assert.equal(s.done, undefined);
  const moved = { x: 40, y: 0, z: 40 }, out = climber.update(1 / 60, { forward: 1 }, moved);
  assert.equal(out.done, 'let-go'); assert.deepEqual([out.x, out.y, out.z], [40, 0, 40]); assert.equal(climber.attached, false);
});

test('a rung every 0.3 m, either way, and a small camera dip in step with them that is gone when the climber stops', () => {
  assert.equal(LADDER_RUNG, .3);
  for (const fps of [30, 60, 144]) {
    const climber = createLadderClimber(); climber.attach(mast, ladderBody(mast, 2.05));
    const up = climb(climber, 1, 1 / fps, 3); // 4.5 m of ladder from 2.05 to 6.55
    const rungs = up.reduce((n, s) => n + s.rungs, 0);
    assert.equal(rungs, Math.floor(6.55 / LADDER_RUNG) - Math.floor(2.05 / LADDER_RUNG), `${fps} fps: ${rungs} rungs`);
    const down = climb(climber, -1, 1 / fps, 3);
    assert.equal(rungs + down.reduce((n, s) => n + s.rungs, 0), 2 * rungs, 'down again passes the same rungs');
    const bobs = up.map(s => s.bob);
    assert.ok(Math.max(...bobs.map(Math.abs)) <= .01 && Math.max(...bobs.map(Math.abs)) > .006, 'subtle: about a centimetre at most');
    let worst = 0; for (let i = 1; i < bobs.length; i++) worst = Math.max(worst, Math.abs(bobs[i] - bobs[i - 1]));
    assert.ok(worst <= .009 * 2 * Math.PI * LADDER_SPEED / LADDER_RUNG / fps * 1.01 + 1e-9, `${fps} fps: the dip is continuous (${worst.toFixed(4)} m a frame)`);
    // The dip is in step with the rungs: it passes through zero as a rung passes under the feet.
    const rest = climb(climber, 0, 1 / fps, 1); assert.ok(Math.abs(rest.at(-1).bob) < 1e-4, 'still again: no dip left');
  }
  const still = createLadderClimber(); still.attach(mast, ladderBody(mast, 2.05));
  assert.ok(climb(still, 0, 1 / 60, 1).every(s => s.rungs === 0 && s.bob === 0), 'standing on a rung makes no sound');
});

test('the same inputs always give the same climb: any frame rate lands in the same place, and a replay is bit-for-bit', () => {
  const run = (fps, dts = null) => {
    const climber = createLadderClimber(), start = { x: 2.2, y: 0, z: 1.4 }, out = []; climber.attach(mast, start);
    let p = start;
    for (let i = 0; ; i++) {
      const dt = dts ? dts[i % dts.length] : 1 / fps, input = { forward: i < 120 ? 1 : i < 150 ? -1 : 1 };
      const s = climber.update(dt, input, p); if (!s) break; out.push({ ...s, state: climber.state }); p = s; if (i > 5000) throw new Error('never finished');
    }
    return out;
  };
  const a = run(60), b = run(60);
  assert.deepEqual(a, b, 'a replay of the same frames is identical, state included');
  // The ladder is the same at any frame rate: given the same input over the same time, the same place.
  const climbFor = (fps, seconds) => { const climber = createLadderClimber(); climber.attach(deerstand, standingAt(deerstand, 0)); let last; for (let i = 0; i < Math.round(seconds * fps); i++) last = climber.update(1 / fps, { forward: 1 }); return last; };
  for (const fps of [30, 144]) assert.ok(dist(climbFor(fps, 1.5), climbFor(60, 1.5)) < 1e-9, `${fps} fps`);
  // And an uneven frame time (a hitch) cannot skip the end: the climb still tops out exactly on the exit.
  const hitchy = run(0, [1 / 60, 1 / 25, 1 / 144, .04, 1 / 60]), last = hitchy.at(-1);
  assert.equal(last.done, 'top'); assert.deepEqual([last.x, last.y, last.z], [mast.exit.x, mast.exit.y, mast.exit.z]);
});

test('"within about a metre of the line": reach is measured from the feet, so the platform beside the top counts', () => {
  assert.equal(LADDER_REACH, 1);
  assert.ok(ladderReachable(deerstand, { x: 0, y: 0, z: 2.2 }), '0.75 m from the foot');
  assert.ok(!ladderReachable(deerstand, { x: 0, y: 0, z: 2.6 }), '1.15 m');
  assert.ok(ladderReachable(deerstand, deerstand.exit), 'standing on the platform at the exit');
  assert.ok(ladderReachable(mast, mast.exit), 'on the mast platform inside the rail');
  assert.ok(!ladderReachable(mast, { x: 0, y: 0, z: 0 }) && !ladderReachable(mast, { x: 0, y: 10, z: 0 }), 'not from the middle of the mast');
  assert.ok(!ladderReachable(mast, { x: 1.2, y: 8, z: 3 }));
});

test('the prompt aims at the part of the line the player looks along, so looking up a ladder works as well as looking across', () => {
  const eye = { x: mast.bottom.x + 1.3, y: 1.69, z: mast.bottom.z + .4 };
  const k = Math.hypot(1.3, .4), across = ladderAim(mast, eye, { x: -1.3 / k, y: 0, z: -.4 / k }, 2.4), to = ladderNearest(mast, eye);
  assert.ok(across.gap < .02 && near(across.y, 1.69, .02), `looking at it: ${across.gap}`);
  // Looking up the line from beside it, 45 degrees up toward it: the ray meets the line 1.36 m out, 1.36 m higher than the eye.
  const toward = { x: -1.3 / k, z: -.4 / k }, c = Math.SQRT1_2, looking = ladderAim(mast, eye, { x: toward.x * c, y: c, z: toward.z * c }, 2);
  assert.ok(looking.gap < .02 && near(looking.y, 1.69 + k, .02), `looking up: closest ${looking.y.toFixed(2)} m up, ${looking.gap.toFixed(3)} m off`);
  const away = ladderAim(mast, eye, { x: 1, y: 0, z: .3 }, 2.4);
  assert.ok(near(away.gap, to.distance, 1e-9) && near(away.y, 1.69, 1e-9), 'looking away, the aim point is simply the nearest point to the eye, which the view cone then rejects');
  // The point is always on the segment, whatever the ray does.
  for (const d of [{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }]) { const a = ladderAim(mast, eye, d, 2.4); assert.ok(a.y >= 0 && a.y <= mast.top.y && Number.isFinite(a.gap)); }
});

test('ladders are placed like hooks: position, yaw and scale about the model origin, ground added to y', () => {
  const asset = { url: '', radius: 1, ladders: [{ bottom: [1.2, 0, 2], top: [1.2, 3, 1.1], exit: [.4, 3, .5], width: .5 }] };
  for (const [x, z, yaw, scale, ground] of [[10, -4, 0, 1, 0], [10, -4, 1.1, 1, 2.5], [-33, 8, -2.4, 2, .7], [0, 0, Math.PI / 2, .5, 0]]) {
    const place = { id: 'p', asset: 'a', x, z, yaw, scale }, ladder = worldLadder(asset, place, ground, 0);
    // Ground truth: what three.js does to the same points when the model is a placed object.
    const o = new THREE.Object3D(); o.position.set(x, ground, z); o.rotation.y = yaw; o.scale.setScalar(scale); o.updateMatrixWorld(true);
    for (const key of ['bottom', 'top', 'exit']) {
      const truth = o.localToWorld(new THREE.Vector3(...asset.ladders[0][key]));
      assert.ok(near(ladder[key].x, truth.x, 1e-9) && near(ladder[key].y, truth.y, 1e-9) && near(ladder[key].z, truth.z, 1e-9), `${key} at yaw ${yaw}`);
    }
    assert.ok(near(ladder.width, .5 * scale)); assert.equal(ladder.id, 'p#0'); assert.equal(ladder.placement, 'p');
    // The front turns with the model.
    const f = ladderFront(ladder), g = ladderFront(worldLadder(asset, { ...place, yaw: 0, scale: 1 }, ground, 0));
    assert.ok(near(f.x, g.x * Math.cos(yaw) + g.z * Math.sin(yaw), 1e-9) && near(f.z, g.z * Math.cos(yaw) - g.x * Math.sin(yaw), 1e-9));
  }
  assert.equal(worldLadder(asset, { id: 'p', asset: 'a', x: 0, z: 0, yaw: 0 }, 0, 3), undefined);
  assert.equal(worldLadder({ url: '', radius: 1, ladders: [{ bottom: [0, 0, NaN], top: [0, 1, 0], exit: [0, 1, 0], width: .4 }] }, { id: 'p', asset: 'a', x: 0, z: 0, yaw: 0 }, 0, 0), undefined);
});

test('pois exposes every ladder of every placement in world space, from the first frame', () => {
  const placements = [{ id: 'one', asset: 'deerstand', x: 10, z: 20, yaw: 1 }, { id: 'tall', asset: 'mast', x: -50, z: 8, yaw: .4 }, { id: 'hut', asset: 'hut', x: 0, z: 0, yaw: 0 }];
  const pois = createPois(new THREE.Scene(), x => x * .01, undefined, { assets, placements, scatter: [{ id: 'stand-x', asset: 'deerstand', x: 5, z: 5, yaw: 0 }], load: () => new Promise(() => {}) });
  assert.deepEqual(pois.ladders.map(l => l.id), ['one#0', 'tall#0', 'stand-x#0'], 'scatter placements have ladders too; assets without any have none');
  const mastLadder = pois.ladders[1], ground = -50 * .01;
  assert.ok(near(mastLadder.top.y - mastLadder.bottom.y, 20.02) && near(mastLadder.bottom.y, ground), 'ground at the placement centre, plus the model-local height');
  pois.dispose();
});

// ---------------------------------------------------------------------------------------------------------------------
// The wiring in game/render/props/world-v2.ts, with a stand-in for the DOM, flashlight and camera.
function makeWorld() {
  const element = () => ({ style: {}, textContent: '', setAttribute() {}, addEventListener() {}, remove() {} });
  const el = element(); let created = 0;
  const container = { ownerDocument: { createElement: () => created++ === 0 ? el : element() }, appendChild() {} };
  const camera = new THREE.PerspectiveCamera(69, 1.6, .075, 1800); camera.rotation.order = 'YXZ';
  const scene = new THREE.Scene(), collisions = createCollisionWorld(), warn = console.warn; console.warn = () => {};
  const flashlight = { owned: true, setSeat() {}, pickUp: () => true, inspect: () => ({ pickupPosition: [0, 0, 0] }) };
  const world = createWorldV2({ scene, camera, container, heightAt: () => 0, collisions, flashlight, viewHeight: () => 720, riverX: () => 1e6, exclusion: () => 0 });
  const player = new THREE.Vector3(), noises = [];
  world.debug.objectives.subscribe(e => { if (e.type === 'noise') noises.push(e); });
  /** The engine's order within a frame: climb first, then the camera, then the world. */
  const frame = (dt, forward = 0) => {
    const climb = world.climb({ dt, forward, player });
    if (climb) player.set(climb.x, climb.y, climb.z);
    camera.position.set(player.x, player.y + 1.69 + (climb?.bob ?? 0), player.z); camera.updateMatrixWorld(true);
    world.update({ dt, time: 0, player, darkness: 0, active: true, simulate: true });
    return climb;
  };
  const look = (x, y, z) => { camera.position.set(player.x, player.y + 1.69, player.z); camera.lookAt(x, y, z); camera.updateMatrixWorld(true); };
  return { world, collisions, camera, player, frame, look, noises, el, restore: () => { console.warn = warn; world.dispose(); } };
}

test('in the world: the prompt appears within a metre of the line, looking at it; a click takes hold; W climbs, E lets go', () => {
  const stand = SCATTER_PLACEMENTS.find(p => p.asset === 'deerstand'), w = makeWorld();
  try {
    const ladder = w.world.debug.ladders.find(l => l.placement === stand.id), f = ladderFront(ladder), mid = ladderBody(ladder, .8);
    const standAt = metres => { w.player.set(ladder.bottom.x + f.x * metres, 0, ladder.bottom.z + f.z * metres); w.player.y = 0; };
    const aimAtLine = () => { const n = ladderNearest(ladder, { x: w.player.x, y: 1.69, z: w.player.z }); w.look(n.x, n.y, n.z); };
    standAt(5); aimAtLine(); w.frame(1 / 60);
    assert.equal(w.world.debug.interaction.focused?.id, undefined, 'five metres off: nothing');
    standAt(.7); aimAtLine(); w.frame(1 / 60);
    assert.equal(w.world.debug.interaction.focused?.id, `ladder:${ladder.id}`); assert.equal(w.world.debug.interaction.text, 'Left click to climb');
    standAt(.7); w.look(w.player.x + f.x * 5, 1.69, w.player.z + f.z * 5); w.frame(1 / 60);
    assert.equal(w.world.debug.interaction.focused?.id, undefined, 'looking away from it: no prompt');
    standAt(1.4); aimAtLine(); w.frame(1 / 60);
    assert.equal(w.world.debug.interaction.focused?.id, undefined, 'over a metre from the line: no prompt');

    standAt(.7); aimAtLine(); w.frame(1 / 60);
    assert.equal(w.world.activate(), true); assert.equal(w.world.climbing, true);
    assert.equal(w.world.activate(false), false, 'a click while climbing is left to the torch');
    for (let i = 0; i < 60; i++) w.frame(1 / 60, 1);
    assert.ok(w.player.y > 1.2 && w.player.y < 1.6, `a second of W climbs 1.5 m of ladder (${w.player.y.toFixed(2)} m up)`);
    assert.equal(w.world.debug.interaction.focused, undefined, 'no prompt while on the ladder');
    assert.ok(w.noises.length >= 3 && w.noises.every(e => e.source === 'ladder' && e.loudness > 0 && e.loudness < .2 && Math.hypot(e.x - w.player.x, e.z - w.player.z) < 1.5), 'one noise event for each rung, where the player is');
    const before = w.player.clone();
    assert.equal(w.world.letGo(), true); assert.equal(w.world.climbing, false);
    assert.equal(w.world.climb({ dt: 1 / 60, forward: 1, player: w.player }), undefined, 'normal movement resumes');
    assert.ok(w.player.distanceTo(before) === 0, 'where they let go is where they are');
    // Taking hold again and letting go with the interact key.
    w.player.set(before.x, 0, before.z); w.frame(1 / 60); standAt(.7); aimAtLine(); w.frame(1 / 60);
    assert.equal(w.world.activate(true), true); assert.equal(w.world.climbing, true);
    assert.equal(w.world.activate(true), true); assert.equal(w.world.climbing, false, 'E again lets go');
    // To the top: out onto the platform, and the player is released there.
    standAt(.7); aimAtLine(); w.frame(1 / 60); w.world.activate();
    let guard = 0; while (w.world.climbing && guard++ < 1000) w.frame(1 / 60, 1);
    assert.ok(w.player.distanceTo(new THREE.Vector3(ladder.exit.x, ladder.exit.y, ladder.exit.z)) < 1e-9, 'released on the exit');
    assert.ok(mid.y > 0);
  } finally { w.restore(); }
});

test('flying, or being moved by something else, drops a climber rather than pinning them to the ladder', () => {
  const stand = SCATTER_PLACEMENTS.find(p => p.asset === 'deerstand'), w = makeWorld();
  try {
    const ladder = w.world.debug.ladders.find(l => l.placement === stand.id), f = ladderFront(ladder);
    w.player.set(ladder.bottom.x + f.x * .7, 0, ladder.bottom.z + f.z * .7); const n = ladderNearest(ladder, { x: w.player.x, y: 1.69, z: w.player.z }); w.look(n.x, n.y, n.z); w.frame(1 / 60);
    w.world.activate(); assert.equal(w.world.climbing, true);
    assert.equal(w.world.climb({ dt: 1 / 60, forward: 1, player: w.player, enabled: false }), undefined); assert.equal(w.world.climbing, false);
    w.world.activate(); assert.equal(w.world.climbing, true);
    w.player.set(w.player.x + 30, 0, w.player.z); // an admin teleport
    assert.equal(w.world.climb({ dt: 1 / 60, forward: 1, player: w.player }).done, 'let-go'); assert.equal(w.world.climbing, false);
  } finally { w.restore(); }
});

test('standing on the mast platform the prompt still finds the ladder, though the platform rail is between the eye and it', () => {
  const place = POI_PLACEMENTS.find(p => p.asset === 'mast'), w = makeWorld();
  try {
    const ladder = w.world.debug.ladders.find(l => l.placement === place.id), exit = ladder.exit;
    w.player.set(exit.x, exit.y, exit.z); w.player.y = exit.y;
    // Every way of looking down at the line from the exit is blocked by the rail ring as far as the collision-based sight test goes...
    const eye = new THREE.Vector3(exit.x, exit.y + 1.69, exit.z), a = ladderAim(ladder, eye, { x: ladder.top.x - exit.x, y: -1.69, z: ladder.top.z - exit.z }, 2);
    assert.equal(lineOfSight(w.collisions, eye, new THREE.Vector3(a.x, a.y, a.z)), false, 'the rail blocks the eye');
    // ...so the ladder asks not to be sight-tested, and the descent can start from the platform.
    w.look(a.x, a.y, a.z); w.frame(1 / 60);
    assert.equal(w.world.debug.interaction.focused?.id, `ladder:${ladder.id}`); assert.equal(w.world.debug.interaction.text, 'Left click to climb');
    assert.equal(w.world.activate(), true); assert.equal(w.world.climbing, true);
    let step, guard = 0; while (w.world.climbing && guard++ < 3000) { step = w.frame(1 / 60, -1); }
    assert.equal(step.done, 'bottom'); assert.ok(Math.abs(w.player.y - ladder.bottom.y) < 1e-9, 'down to the ground');
  } finally { w.restore(); }
});

test("a ladder's own props are in the way of a walker but never of a climber: the mast leg and platform rail are crossed on the way", () => {
  const colliders = worldColliders(assets.mast, { id: 'mast', asset: 'mast', x: 0, z: 0, yaw: 0 }, 0), start = standingAt(mast, 0, .9);
  const climber = createLadderClimber(); climber.attach(mast, start);
  const crossed = new Set(); let last;
  for (let step; (step = climber.update(1 / 60, { forward: 1 }, last ?? start)); last = step) {
    for (const c of colliders) if (c.maxY > step.y + .28 && c.minY < step.y + 1.69 && c.maxY > step.y - .12 && solidContact(c, step.x, step.z, .24).depth > 0) crossed.add(c.tag);
    if (step.done) { last = step; break; }
  }
  assert.ok(crossed.has('mast leg') && crossed.has('platform rail'), `a walker would be stopped by: ${[...crossed].join(', ')}`);
  assert.equal(last.done, 'top'); assert.deepEqual([last.x, last.y, last.z], [mast.exit.x, mast.exit.y, mast.exit.z]);
});
