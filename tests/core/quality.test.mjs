import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRatio, renderSize, pixelCostVs1080, resolutionLabel, autoResolution, RESOLUTIONS, DEFAULT_RESOLUTION, AUTO_RESOLUTION } from '../../game/core/quality.ts';

test('a fixed resolution renders that many rows in the window\'s shape', () => {
  // A 14" MacBook window (CSS pixels) on a Retina screen.
  assert.deepEqual(renderSize(1080, 1512, 982, 2), { width: 1662, height: 1080, ratio: 1080 / 982 });
  assert.equal(renderSize(720, 1512, 982, 2).height, 720);
  assert.equal(renderSize(1440, 1512, 982, 2).height, 1440);
  // Ultra-wide keeps its shape.
  const wide = renderSize(1080, 3440, 1440, 1);
  assert.equal(wide.height, 1080); assert.equal(wide.width, 2580);
});

test('never more rows than the screen has; Native is one pixel per screen pixel and follows the window', () => {
  assert.deepEqual(renderSize(1440, 800, 600, 1), { width: 800, height: 600, ratio: 1 });
  assert.deepEqual(renderSize(0, 1512, 982, 2), { width: 3024, height: 1964, ratio: 2 });
  assert.deepEqual(renderSize(0, 1000, 700, 2), { width: 2000, height: 1400, ratio: 2 });
  assert.equal(renderRatio(0, 100, 100, NaN), 1);
  assert.equal(renderRatio(1080, 1920, 1080, 1), 1);
});

test('the cost note compares pixels with 1080p in the same window', () => {
  const retina = pixelCostVs1080(0, 1512, 982, 2);
  assert.ok(retina > 3.2 && retina < 3.4, `native Retina is ${retina}x 1080p`);
  assert.equal(pixelCostVs1080(1080, 1512, 982, 2), 1);
  // A 1080p screen: Native is 1080p.
  assert.equal(pixelCostVs1080(0, 1920, 1080, 1), 1);
});

test('the choices, their names and the default', () => {
  assert.deepEqual([...RESOLUTIONS], [-1, 720, 1080, 1440, 0]);
  assert.deepEqual(RESOLUTIONS.map(resolutionLabel), ['Auto', '720p', '1080p', '1440p', 'Native']);
  assert.equal(DEFAULT_RESOLUTION, AUTO_RESOLUTION);
});

test('Auto keeps the Mac look on a high-density screen and draws every pixel of an ordinary one', () => {
  // The MacBook it was tuned on: 1080 rows stretched over Retina, as before.
  assert.deepEqual(renderSize(-1, 1512, 982, 2), renderSize(1080, 1512, 982, 2));
  // A 1440p ultra-wide at a ratio of 1 in a browser window: native, not 2384 x 1080 stretched over 2841 x 1287.
  assert.deepEqual(renderSize(-1, 2841, 1287, 1), { width: 2841, height: 1287, ratio: 1 });
  assert.deepEqual(renderSize(-1, 1920, 1080, 1), { width: 1920, height: 1080, ratio: 1 });
  // A 4K monitor at a ratio of 1 is held to 1440 rows; Windows' 125 % and 150 % scaling are treated by their real rows.
  assert.equal(renderSize(-1, 3840, 2160, 1).height, 1440);
  assert.equal(autoResolution(1152, 1.25), 0);
  assert.equal(autoResolution(1440, 1.5), 1080);
});
