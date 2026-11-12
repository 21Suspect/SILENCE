import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { transmittance, skyRadiance, skyIrradiance, SUN_ILLUMINANCE, MOON_ILLUMINANCE, ATMOSPHERE } from '../../../game/render/world/sky-model.ts';

const sunAt = elevation => new THREE.Vector3(Math.sqrt(1 - elevation * elevation), elevation, 0);
const lum = c => c.r * .2126 + c.g * .7152 + c.b * .0722;

test('a clear noon sky is blue overhead and brighter, paler towards the horizon', () => {
  const sun = sunAt(.8), zenith = skyRadiance(new THREE.Vector3(0, 1, 0), sun, SUN_ILLUMINANCE, undefined, 24);
  const horizon = skyRadiance(new THREE.Vector3(0, .06, 1).normalize(), sun, SUN_ILLUMINANCE, undefined, 24);
  assert.ok(zenith.b > zenith.g && zenith.g > zenith.r, 'zenith is blue');
  assert.ok(lum(horizon) > lum(zenith) * 2, 'horizon is brighter');
  assert.ok(horizon.r / horizon.b > .9 * zenith.r / zenith.b, 'the horizon is no deeper a blue than the zenith');
});

test('the sun reddens and dims as it sinks, and is gone below the horizon', () => {
  const high = transmittance(.85), low = transmittance(.06), under = transmittance(-.05);
  assert.ok(high.r > .85 && high.b > .65, 'a high sun is nearly white');
  assert.ok(low.r / low.b > 4 * (high.r / high.b), 'a low sun is far redder');
  assert.ok(lum(low) < lum(high));
  assert.equal(under.r + under.g + under.b, 0);
});

test('the sky lights the ground by day at a believable share of the sun, and the moon only faintly', () => {
  const sun = sunAt(.7), E = skyIrradiance(sun, SUN_ILLUMINANCE), direct = SUN_ILLUMINANCE * .7 * lum(transmittance(.7));
  const ratio = direct / lum(E);
  assert.ok(ratio > 2 && ratio < 10, `clear-day direct to sky ratio ${ratio.toFixed(2)}`);
  const moonSky = skyIrradiance(sunAt(.6), MOON_ILLUMINANCE);
  assert.ok(lum(moonSky) > 0 && lum(moonSky) < lum(E) / 100);
  assert.ok(ATMOSPHERE.top > ATMOSPHERE.ground);
});
