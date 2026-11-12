import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { planeToUv, marchRelief, barkReach, shadeDirectionalLights, BARK_RELIEF_NEAR, BARK_RELIEF_FAR } = await import('../../../game/render/world/bark-relief.ts');

// A pixel of a surface whose uv run 1 per `mx` metres along x and 1 per `my` metres along y, seen square on from afar: one pixel is
// `px` metres, so the screen-space derivatives of position are (px, 0, 0) and (0, px, 0) and those of uv are px/mx and px/my.
const quad = (px, mx, my) => ({ dp1: [px, 0, 0], dp2: [0, px, 0], n: [0, 0, 1], duv1: [px / mx, 0], duv2: [0, px / my] });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test('a displacement in metres comes back as uv at the surface\'s own scale, however the instance is stretched', () => {
  // One metre of the surface is 1 / mx uv across and 1 / my uv up.
  for (const [mx, my] of [[1, 1], [.86, 2.4], [3, .5]]) {
    const q = quad(.004, mx, my);
    const [u, v] = planeToUv(q.dp1, q.dp2, q.n, q.duv1, q.duv2, [.02, -.03, 0]);
    close(u, .02 / mx); close(v, -.03 / my);
  }
});

test('what lies along the normal drops out: a ray into the surface moves the uv only by its sideways part', () => {
  const q = quad(.004, 1, 1);
  const a = planeToUv(q.dp1, q.dp2, q.n, q.duv1, q.duv2, [.01, .02, 0]);
  const b = planeToUv(q.dp1, q.dp2, q.n, q.duv1, q.duv2, [.01, .02, -.5]);
  close(a[0], b[0]); close(a[1], b[1]);
});

test('a tilted facet and a sheared pixel footprint give the same metres', () => {
  // The surface is the plane z = x tan(30deg) with uv = (x, y) / 2 (so 2 m per uv), and the screen derivatives are sheared.
  const t = Math.tan(Math.PI / 6), n = [-t, 0, 1].map(c => c / Math.hypot(t, 1));
  const dp1 = [.003, .001, .003 * t], dp2 = [-.001, .004, -.001 * t];
  const duv1 = [dp1[0] / 2, dp1[1] / 2], duv2 = [dp2[0] / 2, dp2[1] / 2];
  // Half a metre along x in the plane is (.5, 0, .5 t); the oblique split along the normal must not care which way "up" is.
  const [u, v] = planeToUv(dp1, dp2, n, duv1, duv2, [.5, 0, .5 * t]);
  close(u, .25); close(v, 0);
});

test('a degenerate pixel (edge on) gives no movement instead of a huge one', () => {
  assert.deepEqual(planeToUv([1, 0, 0], [2, 0, 0], [0, 0, 1], [1, 0], [0, 1], [.1, .1, 0]), [0, 0]);
});

test('the march meets a flat top at once and finds the depth of a step in the relief', () => {
  assert.equal(marchRelief(() => 1, [.1, 0]).depth, 0);
  // Mid grey everywhere: the ray enters the slab half a depth above the surface, so it meets it at depth 1/2, and the uv shift
  // there is the ray's own: perDepth * (1/2 - 1/2) = nothing. A flat bark at mean height never moves, whatever the angle.
  const flat = marchRelief(() => .5, [.08, -.04]);
  close(flat.depth, .5, 1e-6); close(flat.shift[0], 0, 1e-9); close(flat.shift[1], 0, 1e-9);
  // A ridge: mid height until the shift reaches -.01, then high. The ray (it starts at -.04 and goes down and right) meets the ridge's
  // flank between the step before it and the step after, not at either.
  const ridge = marchRelief(s => (s[0] > -.01 ? .9 : .5), [.08, 0], 10);
  assert.ok(ridge.shift[0] > -.016 && ridge.shift[0] < -.008, `${ridge.shift[0]}`);
  assert.ok(ridge.depth > .3 && ridge.depth < .4, `${ridge.depth}`);
});

test('the march lands on a smooth surface\'s true crossing', () => {
  // Height falls linearly across the shift: h(s) = .6 - 4 s.x. The ray starts at -.04 (half of perDepth) and is at depth d = (s.x + .04) / .08,
  // and meets the surface where 1 - h(s) = d:  .4 + 4 s = 12.5 s + .5  ->  s = -.1 / 8.5. Lines cross exactly, whatever the step.
  const per = [.08, 0], h = s => .6 - 4 * s[0];
  const r = marchRelief(h, per, 10);
  close(r.shift[0], -.1 / 8.5, 1e-9);
  close(r.depth, (r.shift[0] + .04) / .08, 1e-9);
  close(r.height, h(r.shift), 1e-9);
  assert.equal(marchRelief(h, per, 5).shift[0].toFixed(9), r.shift[0].toFixed(9));
});

test('the relief fades out between 8 and 14 m and when edge on, and is whole close up and square on', () => {
  close(barkReach(1, 1), 1); close(barkReach(BARK_RELIEF_NEAR, 1), 1); close(barkReach(BARK_RELIEF_FAR, 1), 0);
  assert.ok(barkReach(11, 1) > 0 && barkReach(11, 1) < 1);
  close(barkReach(3, .05), 0); close(barkReach(3, .3), 1);
  for (let d = 0; d < 20; d += .5) assert.ok(barkReach(d, 1) >= barkReach(d + .5, 1) - 1e-12, 'never grows with distance');
});

test('the sun\'s shade goes on after its shadow map is read, and only on directional lights', () => {
  const chunk = [
    'RE_Direct( directLight, a );   // a point light',
    'getDirectionalLightInfo( directionalLight, directLight );',
    '#if defined( USE_SHADOWMAP )',
    'directLight.color *= getShadow( x );',
    '#endif',
    '\t\tif ( directLight.visible && lit ) RE_Direct( directLight, b );',
  ].join('\n');
  const out = shadeDirectionalLights(chunk).split('\n');
  const shade = out.findIndex(l => l.includes('barkReliefShade'));
  assert.equal(out.filter(l => l.includes('barkReliefShade')).length, 1);
  assert.ok(shade > out.findIndex(l => l.includes('getShadow')), 'after the shadow');
  assert.ok(shade < out.findIndex(l => l.includes('RE_Direct( directLight, b )')), 'before the sun is lit');
  assert.ok(shade > out.findIndex(l => l.includes('a point light')), 'not on the point light');
  assert.equal(shadeDirectionalLights('nothing to find'), 'nothing to find');
});
