/**
 * What the game is running on, read in the browser: the operating system, the GPU and the graphics API the browser drives it
 * with (Chrome draws WebGL through ANGLE: Metal on a Mac, Direct3D 11 on Windows), and the screen's pixel density. One place
 * decides what differs per device, so the rest of the game asks for a policy instead of sniffing strings; specific builds per
 * platform can replace the detection later and keep the policies.
 *
 * Classification is pure (classifyDevice, tested in tests/core/device.test.mjs); detectDevice reads the live context.
 */
export type OperatingSystem = 'mac' | 'windows' | 'linux' | 'ios' | 'android' | 'other';
export type GraphicsApi = 'metal' | 'd3d11' | 'd3d9' | 'vulkan' | 'opengl' | 'software' | 'unknown';
export type GpuVendor = 'apple' | 'nvidia' | 'amd' | 'intel' | 'mobile' | 'other';

export type Device = {
  os: OperatingSystem;
  api: GraphicsApi;
  vendor: GpuVendor;
  /** The GPU as the browser names it (WEBGL_debug_renderer_info), for the settings note and bug reports. */
  renderer: string;
  /** A desktop graphics card with its own memory (NVIDIA, AMD Radeon RX, Intel Arc), not a GPU sharing the CPU's memory. */
  discrete: boolean;
  /** Device pixels per CSS pixel of 1.5 or more (Retina and the like). */
  highDensity: boolean;
  /** Policies. */
  policy: {
    /**
     * Anisotropic filtering for solid materials (bark, rock, props; cards always get 2x). Measured on an M5 Pro it was the largest
     * per-pixel cost found (1.3 ms of a 12 ms frame on the road at 16x), so Apple and other shared-memory GPUs keep 8x. A discrete
     * card has the bandwidth for 16x, and at a device pixel ratio of 1 nothing hides the smear 8x leaves on bark seen edge-on.
     */
    solidAnisotropy: number;
    /**
     * Auto resolution on an ordinary-density screen (quality.ts): draw every pixel up to this many rows, past it 1440. 0 keeps
     * 1080 rows: an integrated GPU at 1440p native is more than twice the pixels it was tuned for.
     */
    nativeRows: number;
  };
};

export type DeviceInput = { renderer: string; userAgent: string; platform?: string; devicePixelRatio: number; maxTouchPoints?: number };

function osOf(userAgent: string, platform: string, touch: number): OperatingSystem {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  // iPadOS asks for the desktop site and says Macintosh; only the touch screen tells it apart.
  if (/Macintosh|Mac OS X/i.test(userAgent) || /^Mac/i.test(platform)) return touch > 1 ? 'ios' : 'mac';
  if (/Windows/i.test(userAgent) || /^Win/i.test(platform)) return 'windows';
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux';
  return 'other';
}

function apiOf(renderer: string): GraphicsApi {
  if (/SwiftShader|llvmpipe|Software|Basic Render/i.test(renderer)) return 'software';
  if (/Metal/i.test(renderer) || /^Apple (M\d|GPU)/i.test(renderer)) return 'metal';
  if (/Direct3D11|D3D11/i.test(renderer)) return 'd3d11';
  if (/Direct3D9|D3D9/i.test(renderer)) return 'd3d9';
  if (/Vulkan/i.test(renderer)) return 'vulkan';
  if (/OpenGL|Mesa/i.test(renderer)) return 'opengl';
  return 'unknown';
}

function vendorOf(renderer: string): GpuVendor {
  if (/NVIDIA|GeForce|Quadro|RTX/i.test(renderer)) return 'nvidia';
  if (/Apple/i.test(renderer)) return 'apple';
  if (/AMD|Radeon|ATI/i.test(renderer)) return 'amd';
  if (/Intel/i.test(renderer)) return 'intel';
  if (/Mali|Adreno|PowerVR|Immortalis|Xclipse/i.test(renderer)) return 'mobile';
  return 'other';
}

/** A card with its own memory. AMD's integrated parts are named "Radeon(TM) Graphics" or "Radeon Vega N Graphics"; Intel's discrete ones Arc. */
function discreteOf(vendor: GpuVendor, renderer: string) {
  if (vendor === 'nvidia') return true;
  if (vendor === 'amd') return !/Radeon\s*\(TM\)\s*Graphics|Radeon Graphics|Vega \d+ Graphics|Radeon \d{3}M/i.test(renderer);
  if (vendor === 'intel') return /\bArc\b/i.test(renderer);
  return false;
}

export function classifyDevice(input: DeviceInput): Device {
  const renderer = (input.renderer || '').trim(), dpr = Number.isFinite(input.devicePixelRatio) && input.devicePixelRatio > 0 ? input.devicePixelRatio : 1;
  const os = osOf(input.userAgent || '', input.platform || '', input.maxTouchPoints ?? 0), api = apiOf(renderer), vendor = vendorOf(renderer);
  const discrete = discreteOf(vendor, renderer) && os !== 'ios' && os !== 'android';
  return {
    os, api, vendor, renderer, discrete, highDensity: dpr >= 1.5,
    policy: { solidAnisotropy: discrete ? 16 : 8, nativeRows: discrete || vendor === 'apple' ? 1600 : 0 },
  };
}

/** A one-line description: "Windows, NVIDIA GeForce RTX 5070 Ti (0x00002C05), Direct3D 11". */
export function describeDevice(d: Device) {
  const os = { mac: 'macOS', windows: 'Windows', linux: 'Linux', ios: 'iOS', android: 'Android', other: 'Unknown OS' }[d.os];
  const api = { metal: 'Metal', d3d11: 'Direct3D 11', d3d9: 'Direct3D 9', vulkan: 'Vulkan', opengl: 'OpenGL', software: 'software rendering', unknown: 'unknown API' }[d.api];
  // ANGLE's string carries its own wrapping: "ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)".
  const gpu = d.renderer.replace(/^ANGLE \(([^,]*),\s*/, '').replace(/\s*(Direct3D\d+.*|, D3D\d+\)|, Unspecified Version\)|\))$/i, '').replace(/^ANGLE Metal Renderer:\s*/i, '');
  return `${os}, ${gpu || 'unknown GPU'}, ${api}`;
}

/** Reads the live context. The unmasked renderer string is what tells Metal from Direct3D; without it the API stays unknown. */
export function detectDevice(gl: WebGLRenderingContext | WebGL2RenderingContext): Device {
  let renderer = '';
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) ?? '');
  } catch { /* a locked-down browser: the policies fall back to the shared-memory defaults */ }
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return classifyDevice({
    renderer, userAgent: nav?.userAgent ?? '', platform: nav?.platform ?? '', maxTouchPoints: nav?.maxTouchPoints ?? 0,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
  });
}
