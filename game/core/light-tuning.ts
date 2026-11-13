/**
 * Live lighting knobs for Pause > Developer Options > Lighting: factors over the tuned values (1 changes nothing) and an exposure
 * offset in stops (0 changes nothing), read every frame by the code that owns each light. They are saved in this browser
 * (localStorage), so a tuned look survives the reload a code edit causes; Reset puts them all back.
 */
export const LIGHT_DEFAULTS = {
  /** Torch brightness, times its 14 cd. */
  torch: 1,
  /** Torch cone, times its 54 degree spread (the hot spot keeps its share of the cone). */
  torchCone: 1,
  /** How far the torch reaches, times its 45 m. */
  torchReach: 1,
  /** Sunlight, times. */
  sun: 1,
  /** Sky light from above (the hemisphere), times; by night it is the moon's sky and the night floor. */
  sky: 1,
  /** The night's floor of airglow and starlight, times: how much of a moonless wood is readable without the torch. */
  night: 1,
  /** Street lamps and the cabin's lantern, times. */
  lamps: 1,
  /** Mist and haze thickness, times. */
  haze: 1,
  /** Exposure offset, in stops. */
  exposure: 0,
};
export type LightTuning = typeof LIGHT_DEFAULTS;
export type LightKey = keyof LightTuning;

const STORE = 'silence-light-tuning';
export const LIGHT_TUNING: LightTuning = { ...LIGHT_DEFAULTS };
try {
  const saved = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? 'null') as Partial<LightTuning> | null;
  if (saved) for (const key of Object.keys(LIGHT_DEFAULTS) as LightKey[]) if (Number.isFinite(saved[key])) LIGHT_TUNING[key] = saved[key]!;
} catch { /* no storage (private window, tests): the defaults stand */ }

/** Bumped on every change, so code that caches derived values (the sky's light, recomputed only as the sun moves) can tell. */
export let lightTuningVersion = 0;
export function setLightTuning(key: LightKey, value: number) {
  LIGHT_TUNING[key] = value; lightTuningVersion++;
  try { globalThis.localStorage?.setItem(STORE, JSON.stringify(LIGHT_TUNING)); } catch { /* not saved; still live */ }
}
export function resetLightTuning() {
  Object.assign(LIGHT_TUNING, LIGHT_DEFAULTS); lightTuningVersion++;
  try { globalThis.localStorage?.removeItem(STORE); } catch { /* nothing saved */ }
}
