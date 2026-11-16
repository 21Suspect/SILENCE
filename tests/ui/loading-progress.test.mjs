import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register-ts-hooks.mjs';
const { createLoadingProgress, describeAsset, describeWarm, LOADING_CAP, LOADING_WEIGHTS } = await import('../../game/ui/loading-progress.ts');

const frame = (over = {}) => ({ assetsPending: false, queuePending: 0, warmupDraws: 0, warmupTotal: 2, quiet: false, ...over });

test('a file URL reads as a few plain words, by what kind of file it is', () => {
  assert.equal(describeAsset('/world/nature/rock_moss_set_02.glb'), 'Model · Rock moss set');
  assert.equal(describeAsset('/textures/Bark-Diffuse_4k.jpg?v=3'), 'Texture · Bark diffuse');
  assert.equal(describeAsset('/audio/wind loop.mp3'), 'Sound · Wind loop');
  assert.equal(describeAsset('/sky/dawn.hdr'), 'Sky · Dawn');
  assert.equal(describeAsset('/world/lod/cabin.bin'), 'Model · Cabin');
  assert.equal(describeAsset('/data/readme'), 'Readme', 'no extension: just the name');
});

test('a model\'s own textures arrive as blob or data URLs and are named for that', () => {
  assert.equal(describeAsset('blob:http://localhost:5173/6f1c-aa'), 'Model textures');
  assert.equal(describeAsset('data:image/png;base64,AAAA'), 'Model textures');
});

test('a stray percent sign in a file name does not throw', () => {
  assert.equal(describeAsset('/textures/100%.png'), 'Texture · 100%');
});

test('warm-up pieces are named for what they do, with the whole-scene and ground passes in plain words', () => {
  assert.equal(describeWarm({ label: 'cabin', kind: 'texture' }), 'Uploading textures · Cabin');
  assert.equal(describeWarm({ label: 'cabin', kind: 'compile' }), 'Compiling shaders · Cabin');
  assert.equal(describeWarm({ label: 'scene', kind: 'compile' }), 'Final shader pass');
  assert.equal(describeWarm({ label: 'ground variants', kind: 'compile' }), 'Compiling ground shaders');
});

test('before anything has happened it says it is preparing, at nothing', () => {
  const p = createLoadingProgress();
  assert.deepEqual(p.update(frame()), { fraction: 0, label: 'Preparing the forest' });
});

test('while files arrive it names the latest one, and the bar follows the loaded share of them', () => {
  const p = createLoadingProgress();
  p.asset('/world/nature/tree_stump_01.glb', 2, 8);
  const r = p.update(frame({ assetsPending: true }));
  assert.equal(r.label, 'Model · Tree stump');
  assert.ok(Math.abs(r.fraction - LOADING_WEIGHTS.assets * .25) < 1e-9);
});

test('queued warm-up work names the piece in hand, ahead of the files, and fills its own share of the bar', () => {
  const p = createLoadingProgress();
  p.asset('/a.glb', 4, 4);
  const a = p.update(frame({ assetsPending: true, queuePending: 4, queueLast: { label: 'hut', kind: 'texture' } }));
  assert.equal(a.label, 'Uploading textures · Hut');
  const b = p.update(frame({ queuePending: 1, queueLast: { label: 'hut', kind: 'compile' } }));
  assert.equal(b.label, 'Compiling shaders · Hut');
  assert.ok(b.fraction > a.fraction);
});

test('once everything has gone quiet it announces each whole-scene shader pass, counting from one', () => {
  const p = createLoadingProgress();
  assert.equal(p.update(frame({ quiet: true })).label, 'Compiling shaders (1 of 2)');
  assert.equal(p.update(frame({ quiet: true, warmupDraws: 1 })).label, 'Compiling shaders (2 of 2)');
  assert.equal(p.update(frame({ quiet: true, warmupDraws: 1, warmupTotal: 4 })).label, 'Compiling shaders (2 of 4)', 'with street lamps there are four');
});

test('after the last pass the scene\'s own queue is the final shader pass, not a stale prop; then it is almost ready', () => {
  const p = createLoadingProgress();
  assert.equal(p.update(frame({ warmupDraws: 2, queuePending: 2, queueLast: { label: 'hut', kind: 'compile' } })).label, 'Final shader pass');
  assert.equal(p.update(frame({ warmupDraws: 2 })).label, 'Almost ready');
});

test('the bar never moves backwards, even when late files and new queued work pull the raw figure down', () => {
  const p = createLoadingProgress();
  let last = 0;
  const steps = [
    () => p.asset('/a.glb', 40, 40), () => p.asset('/b.glb', 41, 55), () => p.asset('/c.glb', 42, 90),
  ];
  const frames = [frame({ assetsPending: true }), frame({ queuePending: 3 }), frame({ queuePending: 9 }), frame({ queuePending: 1 }), frame({ queuePending: 6 })];
  for (const step of steps) for (const f of frames) { step(); const r = p.update(f); assert.ok(r.fraction >= last, `${r.fraction} < ${last}`); last = r.fraction; }
});

test('it stops short of full until told to finish, however much has been done', () => {
  const p = createLoadingProgress();
  p.asset('/a.glb', 10, 10);
  p.update(frame({ queuePending: 5 }));
  const r = p.update(frame({ queuePending: 0, warmupDraws: 2, quiet: true }));
  assert.equal(r.fraction, LOADING_CAP);
  assert.ok(LOADING_CAP < 1);
  assert.deepEqual(p.finish(), { fraction: 1, label: 'Ready' });
  assert.deepEqual(p.update(frame()), { fraction: 1, label: 'Ready' }, 'and stays there');
});

test('the stages\' shares add up to the cap, so the last wait on the GPU has the rest of the bar to itself', () => {
  const { assets, queue, draws } = LOADING_WEIGHTS;
  assert.ok(Math.abs(assets + queue + draws - LOADING_CAP) < 1e-9);
});

test('with nothing ever queued, a quiet game still counts its queue stage as done', () => {
  const p = createLoadingProgress();
  p.asset('/a.glb', 3, 3);
  const r = p.update(frame({ quiet: true }));
  assert.ok(Math.abs(r.fraction - (LOADING_WEIGHTS.assets + LOADING_WEIGHTS.queue)) < 1e-9);
});
