import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/register-ts-hooks.mjs';
const { makeProjection, ringedPlaceIds, contourSegments, MAP_BOUNDS, idsKey } = await import('../../game/sim/world/map-shapes.ts');
const { PLACES } = await import('../../game/sim/world/places.ts');
const { createBannerTracker } = await import('../../game/ui/place-banner.ts');

test('the projection puts north up, east right, fits the island whole and inverts exactly', () => {
  const p = makeProjection(MAP_BOUNDS, 1200, 1000, 40);
  const [x0, y0] = p.toCanvas(MAP_BOUNDS.x0, MAP_BOUNDS.z0), [x1, y1] = p.toCanvas(MAP_BOUNDS.x1, MAP_BOUNDS.z1);
  assert.ok(x0 >= 40 - 1e-6 && y0 >= 40 - 1e-6 && x1 <= 1160 + 1e-6 && y1 <= 960 + 1e-6);
  const [, north] = p.toCanvas(0, -100), [, south] = p.toCanvas(0, 100), [east] = p.toCanvas(100, 0), [west] = p.toCanvas(-100, 0);
  assert.ok(north < south && east > west);
  const [wx, wz] = p.toWorld(...p.toCanvas(123, -45));
  assert.ok(Math.abs(wx - 123) < 1e-9 && Math.abs(wz + 45) < 1e-9);
});

test('a place is ringed while a part seeded there still lies out, and not once it is taken', () => {
  const items = {
    a: { kind: 'fuse', poi: 'mine', status: 'world', part: 'call-fuse-1' },
    b: { kind: 'fuse', poi: 'lookout', status: 'held', part: 'call-fuse-2' },
    c: { kind: 'jerry', poi: 'camp', status: 'world', part: 'call-fuel' },
    d: { kind: 'backpack', poi: 'cabin', status: 'world' },
    e: { kind: 'fuse', poi: 'logstack', status: 'banked', part: 'call-fuse-3' },
  };
  const ids = ringedPlaceIds(items);
  assert.deepEqual([...ids].sort(), ['hunter-camp', 'mine']);
  assert.equal(idsKey(ids), 'hunter-camp|mine');
  assert.equal(ringedPlaceIds(undefined).size, 0);
  assert.ok(ringedPlaceIds({ a: { ...items.a, poiId: 'chapel' } }).has('chapel'));
  assert.ok(PLACES.length > 0);
});

test('marching squares finds the circle where a field crosses zero', () => {
  const n = 41, f = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) f[j * n + i] = 10 - Math.hypot(i - 20, j - 20);
  const segs = contourSegments(f, n, n, 0, 0, 1, 0);
  assert.ok(segs.length > 40);
  for (const s of segs) for (const [x, z] of [[s[0], s[1]], [s[2], s[3]]]) assert.ok(Math.abs(Math.hypot(x - 20, z - 20) - 10) < .25);
  assert.equal(contourSegments(f, n, n, 0, 0, 1, 99).length, 0);
});

test('the banner fires on entering a place, not while staying, and not again until a minute away', () => {
  const t = createBannerTracker();
  assert.equal(t.update(undefined, 0), undefined);
  assert.equal(t.update('cabin', 1), 'cabin');
  assert.equal(t.update('cabin', 2), undefined);
  assert.equal(t.update(undefined, 10), undefined);
  assert.equal(t.update('cabin', 30), undefined);       // back within a minute
  assert.equal(t.update('chapel', 31), 'chapel');
  assert.equal(t.update(undefined, 40), undefined);
  assert.equal(t.update('cabin', 120), 'cabin');        // away since 31... last inside at 31 is >60 s ago
  assert.equal(t.update(undefined, 130), undefined);
  assert.equal(t.update('cabin', 170), undefined);
  assert.equal(t.update(undefined, 180), undefined);
  assert.equal(t.update('cabin', 260), 'cabin');
});

const { placeLabels, boxesTouch, boxDistance, SHORT_NAMES } = await import('../../game/sim/world/map-shapes.ts');

// Text widths as a 12 px italic serif (names) and a 14.5 px bold spaced one (key places) measure about: close enough to test the layout.
const widthOf = pl => pl.key ? pl.title.length * 12.5 : pl.name.replace(/^the /, '').length * 5.9;

for (const [W, H, strip] of [[1075, 756, 236], [795, 504, 236], [1024, 1024, 0]]) {
  test(`place names never overlap each other, a symbol or the furniture, and key and ringed places keep theirs (${W} x ${H})`, () => {
    const AW = W - strip, p = makeProjection(MAP_BOUNDS, AW, H, 22);
    const items = [...PLACES].sort((a, b) => Number(!!b.key) - Number(!!a.key)).map(pl => { const [cx, cy] = p.toCanvas(pl.x, pl.z); const w = widthOf(pl); return { id: pl.id, cx, cy, r: pl.key ? 20 : 16, w, h: pl.key ? 14.5 : 12, must: !!pl.key, variants: pl.key ? [14.5, 13.5, 12.5].map(z => ({ w: w * z / 14.5, h: z })) : SHORT_NAMES[pl.id] ? [{ w, h: 12 }, { w: SHORT_NAMES[pl.id].length * 5.9, h: 12 }] : undefined }; });
    const blocked = strip ? [[AW, 0, W, H]] : [[30, 30, 220, 90], [W - 140, H - 150, W - 10, H - 10]];
    const area = [8, 8, AW - 8, H - 8], symbol = i => [i.cx - i.r, i.cy - i.r, i.cx + i.r, i.cy + i.r];
    const maxOff = strip ? 60 : 90, spots = placeLabels(items, blocked, area, 3, undefined, maxOff);
    for (const it of items.filter(i => i.must)) assert.ok(spots.get(it.id)?.clear, `key place ${it.id} has a clear name`);
    const placed = items.filter(i => spots.has(i.id));
    assert.ok(placed.length >= items.length - 4, 'only a few minor names may be dropped');
    for (const a of placed) {
      const box = spots.get(a.id).box;
      assert.ok(boxDistance(a.cx, a.cy, box) <= maxOff + 1, `${a.id} is within ${maxOff} px of its symbol`);
      assert.ok(box[0] >= area[0] && box[1] >= area[1] && box[2] <= area[2] && box[3] <= area[3], `${a.id} is on the sheet`);
      for (const b of blocked) assert.ok(!boxesTouch(box, b), `${a.id} covers the furniture`);
      for (const b of items) {
        if (b.id !== a.id) assert.ok(!boxesTouch(box, symbol(b)), `${a.id} covers the symbol of ${b.id}`);
        if (b.id !== a.id && spots.has(b.id)) assert.ok(!boxesTouch(box, spots.get(b.id).box), `${a.id} overlaps ${b.id}`);
      }
    }
    // Any dropped place that gets ringed still finds a clear spot for its name.
    for (const it of items.filter(i => !spots.has(i.id))) {
      const got = placeLabels([{ ...it, must: true }, ...items.filter(i => i.id !== it.id)], blocked, area, 3, spots, maxOff).get(it.id);
      assert.ok(got?.clear, `${it.id} (ringed) finds a clear spot`);
      assert.ok(boxDistance(it.cx, it.cy, got.box) <= maxOff + 1, `${it.id} (ringed) stays near its symbol`);
      for (const b of items) if (b.id !== it.id) assert.ok(!boxesTouch(got.box, symbol(b)));
      for (const [id, sp] of spots) assert.ok(!boxesTouch(got.box, sp.box), `${it.id} over ${id}`);
    }
  });
}
