import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDevice, describeDevice } from '../../game/core/device.ts';

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const M5 = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)';

test('the PC this pass was made on: Windows, an NVIDIA card through Direct3D 11, 16x filtering, native up to 1600 rows', () => {
  const d = classifyDevice({ renderer: RTX, userAgent: WIN_UA, platform: 'Win32', devicePixelRatio: 1 });
  assert.deepEqual([d.os, d.api, d.vendor, d.discrete, d.highDensity], ['windows', 'd3d11', 'nvidia', true, false]);
  assert.deepEqual(d.policy, { solidAnisotropy: 16, nativeRows: 1600 });
  assert.equal(describeDevice(d), 'Windows, NVIDIA GeForce RTX 5070 Ti (0x00002C05), Direct3D 11');
});

test('the MacBook it was tuned on: macOS, Apple silicon through Metal, the 8x filtering it was measured with', () => {
  const d = classifyDevice({ renderer: M5, userAgent: MAC_UA, platform: 'MacIntel', devicePixelRatio: 2 });
  assert.deepEqual([d.os, d.api, d.vendor, d.discrete, d.highDensity], ['mac', 'metal', 'apple', false, true]);
  assert.equal(d.policy.solidAnisotropy, 8);
  assert.equal(describeDevice(d), 'macOS, Apple M5 Pro, Metal');
  // Safari names the GPU without ANGLE.
  assert.equal(classifyDevice({ renderer: 'Apple GPU', userAgent: MAC_UA, devicePixelRatio: 2 }).api, 'metal');
});

test('integrated GPUs keep the shared-memory policies; AMD and Intel discrete cards are told apart by name', () => {
  const amdIgpu = classifyDevice({ renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics (0x0000164E) Direct3D11 vs_5_0 ps_5_0, D3D11)', userAgent: WIN_UA, devicePixelRatio: 1 });
  assert.deepEqual([amdIgpu.vendor, amdIgpu.discrete, amdIgpu.policy.solidAnisotropy, amdIgpu.policy.nativeRows], ['amd', false, 8, 0]);
  assert.equal(classifyDevice({ renderer: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', userAgent: WIN_UA, devicePixelRatio: 1 }).discrete, true);
  assert.equal(classifyDevice({ renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', userAgent: WIN_UA, devicePixelRatio: 1 }).discrete, false);
  assert.equal(classifyDevice({ renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', userAgent: WIN_UA, devicePixelRatio: 1 }).discrete, true);
});

test('phones, tablets, software rendering and a hidden renderer string fall back safely', () => {
  const ipad = classifyDevice({ renderer: 'Apple GPU', userAgent: MAC_UA, platform: 'MacIntel', devicePixelRatio: 2, maxTouchPoints: 5 });
  assert.equal(ipad.os, 'ios'); assert.equal(ipad.discrete, false);
  assert.equal(classifyDevice({ renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', userAgent: WIN_UA, devicePixelRatio: 1 }).api, 'software');
  const hidden = classifyDevice({ renderer: 'WebKit WebGL', userAgent: WIN_UA, devicePixelRatio: NaN });
  assert.deepEqual([hidden.api, hidden.vendor, hidden.discrete, hidden.highDensity, hidden.policy.solidAnisotropy], ['unknown', 'other', false, false, 8]);
  assert.equal(classifyDevice({ renderer: 'Mali-G78', userAgent: 'Mozilla/5.0 (Linux; Android 14)', devicePixelRatio: 3 }).os, 'android');
});
