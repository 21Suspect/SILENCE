import test from 'node:test';
import assert from 'node:assert/strict';
import { createWarmQueue, createGpuWarmup } from '../game/gpu-warmup.ts';
import { planTiles } from '../game/texture-slicer.ts';

const tex = name => ({ name });
const run = (queue, now, cost, status) => { const item = queue.next(now); if (item) item.finished(cost, now + cost, status); return item; };

test('a model is built texture by texture, then one light state of programs at a time, and reports when it is whole', () => {
  let done = 0;
  const q = createWarmQueue({ states: 3, minGap: 0, idlePause: 0 });
  q.add({ label: 'cabin', textures: [tex('a'), tex('b')], object: { id: 'cabin' }, onDone: () => { done++; } });
  const seen = []; let now = 0;
  for (let i = 0; i < 8; i++) { const item = run(q, now, 1); if (item) seen.push(item.step.kind === 'texture' ? `t:${item.step.texture.name}` : `c:${item.step.state}`); now += 5; }
  assert.deepEqual(seen, ['t:a', 't:b', 'c:0', 'c:1', 'c:2']);
  assert.equal(q.pending, 0);
  assert.equal(done, 1);
});

test('a task with nothing to do is done at once', () => {
  let done = 0;
  const q = createWarmQueue();
  q.add({ label: 'empty', textures: [], onDone: () => { done++; } });
  assert.equal(done, 1);
  assert.equal(q.pending, 0);
});

test('a texture that did a piece of its upload, or is not ready, stays at the front until it says done', () => {
  const q = createWarmQueue({ minGap: 10, idlePause: 0 });
  q.add({ label: 'big', textures: [tex('big'), tex('small')] });
  assert.equal(run(q, 0, 3, 'wait').step.texture.name, 'big');
  assert.equal(run(q, 20, 3, 'more').step.texture.name, 'big');
  assert.equal(run(q, 40, 3, 'more').step.texture.name, 'big');
  assert.equal(run(q, 60, 3, 'done').step.texture.name, 'big');
  assert.equal(run(q, 80, 3, 'done').step.texture.name, 'small');
  assert.equal(q.pending, 0);
});

test('a texture that never becomes ready is given up on so its model is not hidden forever', () => {
  let done = 0;
  const q = createWarmQueue({ minGap: 0, idlePause: 0 });
  q.add({ label: 'broken', textures: [tex('never')], onDone: () => { done++; } });
  for (let i = 0; i < 700 && !done; i++) run(q, i, 0, 'wait');
  assert.equal(done, 1);
});

test('the pause after a piece grows with what it cost, and is shorter for a model that is wanted now', () => {
  let wanted = false;
  const q = createWarmQueue({ minGap: 40, idlePause: 4, urgentPause: .25 });
  q.add({ label: 'x', textures: [tex('a'), tex('b'), tex('c')], urgent: () => wanted });
  assert.ok(run(q, 0, 30));                    // 30 ms piece: next one no earlier than 30 + 120
  assert.equal(q.next(149), undefined);
  assert.ok(run(q, 151, 5));                   // a cheap piece waits only the minimum gap: 5 + 40
  assert.equal(q.next(195), undefined);
  wanted = true;
  assert.ok(run(q, 200, 30));                  // wanted: 30 * .25 = 7.5, so the minimum gap rules
  assert.equal(q.next(239), undefined);
  assert.equal(q.next(271), undefined, 'nothing left');
});

test('a task that is wanted now goes ahead of tasks that arrived earlier', () => {
  const q = createWarmQueue({ minGap: 0, idlePause: 0 });
  q.add({ label: 'far', textures: [tex('far')] });
  q.add({ label: 'near', textures: [tex('near')], urgent: () => true });
  assert.equal(run(q, 0, 1).label, 'near');
  assert.equal(run(q, 10, 1).label, 'far');
});

test('a disposed task is dropped without doing any of its work, and still lets go of whatever waited on it', () => {
  let gone = false, released = 0;
  const q = createWarmQueue({ minGap: 0, idlePause: 0 });
  q.add({ label: 'gone', textures: [tex('a'), tex('b')], object: {}, cancelled: () => gone, onDone: () => { released++; } });
  gone = true;
  assert.equal(q.next(0), undefined);
  assert.equal(q.pending, 0);
  assert.equal(released, 1);
});

test('the warm-up does one piece per update and survives a failing compile', () => {
  let t = 0; const uploads = [], compiles = [];
  const w = createGpuWarmup({
    states: 2, minGap: 0, idlePause: 0, clock: () => (t += 1),
    upload: texture => { uploads.push(texture.name); return uploads.length < 2 ? 'wait' : 'done'; },
    compile: (object, state) => { compiles.push(state); if (state === 0) throw new Error('boom'); },
  });
  const warn = console.warn; console.warn = () => {};
  try {
    w.add({ label: 'a', textures: [tex('late')], object: {} });
    assert.equal(w.update().status, 'wait');
    assert.equal(w.update().status, 'done');
    for (let i = 0; i < 4; i++) w.update();
    assert.deepEqual(uploads, ['late', 'late']);
    assert.deepEqual(compiles, [0, 1]);
    assert.equal(w.pending, 0);
  } finally { console.warn = warn; }
});

test('drain runs everything without pauses within its budget, and stops when something must wait', () => {
  let t = 0, waits = 0;
  const w = createGpuWarmup({
    states: 1, minGap: 1000, idlePause: 50, clock: () => (t += 1),
    upload: texture => (texture.name === 'late' && waits++ === 0 ? 'wait' : 'done'),
    compile: () => {},
  });
  w.add({ label: 'a', textures: [tex('x'), tex('late')], object: {} });
  assert.equal(w.drain(100), 1, 'stopped on the texture that is not ready');
  assert.equal(w.drain(100), 0, 'and finishes on the next call');
});

test('tiles cover a texture exactly, row by row, with ragged edges', () => {
  const rects = planTiles(4096, 4096, 1024);
  assert.equal(rects.length, 16);
  assert.deepEqual(rects[0], { x: 0, y: 0, w: 1024, h: 1024 });
  assert.deepEqual(rects[5], { x: 1024, y: 1024, w: 1024, h: 1024 });
  const ragged = planTiles(2500, 1100, 1024);
  assert.equal(ragged.length, 6);
  assert.equal(ragged.reduce((a, r) => a + r.w * r.h, 0), 2500 * 1100);
  assert.deepEqual(ragged.at(-1), { x: 2048, y: 1024, w: 452, h: 76 });
});
