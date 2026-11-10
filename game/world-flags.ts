/**
 * The rebuilt world is the game. ?classic-world opens the original one, for comparison.
 * Workers inherit the choice through their own script URL. Outside a browser there is no
 * location, so plain unit tests keep exercising the original paths unless they ask otherwise.
 */
export const WORLD_V2 = typeof location !== 'undefined' && !new URLSearchParams(location.search).has('classic-world');
/** Every player given the same seed walks the same basin. ?seed=N picks one. */
export const WORLD_SEED = WORLD_V2 ? (Number.parseInt(new URLSearchParams(location.search).get('seed') ?? '', 10) || 7741) : 0;
