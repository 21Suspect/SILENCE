/**
 * Render resolution. The player picks it and it stays: a fixed height (720p, 1080p, 1440p) drawn with the window's aspect ratio,
 * or Native, one pixel per screen pixel. Nothing lowers it on its own; there used to be an adaptive scaler here (capped at 2 MP and
 * a device pixel ratio of 1.4, then cut the scale whenever frames ran long) and players could not tell what they were looking at.
 */
export const RESOLUTIONS = [720, 1080, 1440, 0] as const;
/** Rows to render, or 0 for the screen's own pixels. */
export type Resolution = typeof RESOLUTIONS[number];
export const DEFAULT_RESOLUTION: Resolution = 1080;
export const resolutionLabel = (resolution: number) => resolution > 0 ? `${resolution}p` : 'Native';

/**
 * Device pixels per CSS pixel for the canvas. A fixed choice renders `resolution` rows, never more than the screen has (so 1440p
 * in a small window is that window's native size); Native is the device pixel ratio, and follows the window and the screen.
 */
export function renderRatio(resolution: number, cssWidth: number, cssHeight: number, devicePixelRatio: number) {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (!(resolution > 0)) return dpr;
  return Math.min(dpr, resolution / Math.max(1, cssHeight));
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
