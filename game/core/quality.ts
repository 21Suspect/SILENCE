/**
 * Render resolution. The player picks it and it stays: a fixed height (720p, 1080p, 1440p) drawn with the window's aspect ratio,
 * or Native, one pixel per screen pixel. Nothing lowers it on its own; there used to be an adaptive scaler here (capped at 2 MP and
 * a device pixel ratio of 1.4, then cut the scale whenever frames ran long) and players could not tell what they were looking at.
 */
export const RESOLUTIONS = [-1, 720, 1080, 1440, 0] as const;
/** Rows to render, 0 for the screen's own pixels, or -1 for Auto (autoResolution). */
export type Resolution = typeof RESOLUTIONS[number];
export const AUTO_RESOLUTION = -1;
export const DEFAULT_RESOLUTION: Resolution = AUTO_RESOLUTION;
export const resolutionLabel = (resolution: number) => resolution < 0 ? 'Auto' : resolution > 0 ? `${resolution}p` : 'Native';

/**
 * What Auto renders. The game was tuned on a Retina MacBook, where 1080 rows stretched over a high-density panel (and sharpened,
 * post/sharpen.ts) looks crisp and Native costs three times the pixels. On an ordinary-density screen the same 1080 rows are a
 * plain bilinear stretch the eye sees as soft: a 1440p monitor at a device pixel ratio of 1 drew 2384 x 1080 into a 2841 x 1287
 * window (measured in Chrome on Windows). So Auto is Native where the screen has few enough rows that every one is visible, and
 * 1440 rows past that (a 4K monitor at a ratio of 1), and stays at 1080 on high-density screens.
 */
export function autoResolution(cssHeight: number, devicePixelRatio: number, nativeRows = autoNativeRows): 0 | 1080 | 1440 {
  if (devicePixelRatio >= 1.5 || !(nativeRows > 0)) return 1080;
  return cssHeight * devicePixelRatio <= nativeRows ? 0 : 1440;
}
let autoNativeRows = 1600;
/** The device's policy (device.ts): the rows Auto draws natively up to on an ordinary-density screen; 0 keeps it at 1080. */
export function configureAuto(nativeRows: number) { autoNativeRows = nativeRows; }

/**
 * Device pixels per CSS pixel for the canvas. A fixed choice renders `resolution` rows, never more than the screen has (so 1440p
 * in a small window is that window's native size); Native is the device pixel ratio, and follows the window and the screen.
 */
export function renderRatio(resolution: number, cssWidth: number, cssHeight: number, devicePixelRatio: number) {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const rows = resolution < 0 ? autoResolution(cssHeight, dpr) : resolution;
  if (!(rows > 0)) return dpr;
  return Math.min(dpr, rows / Math.max(1, cssHeight));
}

/** The drawing buffer the ratio gives, as three.js sizes it (floor of CSS size times ratio). */
export function renderSize(resolution: number, cssWidth: number, cssHeight: number, devicePixelRatio: number) {
  const ratio = renderRatio(resolution, cssWidth, cssHeight, devicePixelRatio);
  return { width: Math.max(1, Math.floor(cssWidth * ratio)), height: Math.max(1, Math.floor(cssHeight * ratio)), ratio };
}

/**
 * What a choice costs next to 1080p in the same window, as a multiple of its pixels. The frame is per-pixel bound (measured on an
 * M5 Pro: about 5 ms fixed plus 5.5 ms per megapixel), so this is close to the multiple of GPU time beyond the fixed part.
 */
export function pixelCostVs1080(resolution: number, cssWidth: number, cssHeight: number, devicePixelRatio: number) {
  const chosen = renderSize(resolution, cssWidth, cssHeight, devicePixelRatio), reference = renderSize(1080, cssWidth, cssHeight, devicePixelRatio);
  return (chosen.width * chosen.height) / (reference.width * reference.height);
}
