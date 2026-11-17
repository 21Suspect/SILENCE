/**
 * The noise scale (docs/game-design.md, "Sound and light" and "The Listener"). The Listener is blind: every sound has a
 * loudness, and that is all it has to go on.
 *
 * Loudness is the distance at which it hears the sound, in hundreds of metres (a noise event's `loudness` has always meant
 * this: 1 is heard within 100 m). Inside that distance it hears it; outside, it does not. There is no falloff and no chance in
 * it, because the design's promise is that "you always know why it found you". Weather shortens every distance (cover).
 *
 * The grade is the sound's own class, by how far it carries, not by how far off it was: a door is faint at 1 m and at 20 m.
 *   faint     under 30 m: it stops, turns its head and drifts that way; ten seconds of silence and it loses interest
 *   loud      30 to 100 m: it calls once, trots to the spot and searches it, listening
 *   veryLoud  100 m and more, or kept up (a generator, hammering): it runs, and stays while it goes on
 */

/** Heard within (hundreds of metres), from the design's table, one value per row picked inside its range. */
export const NOISE = {
  // 5 to 8 m: crouch-walking, a whisper, a bicycle on a path.
  crouchStep: .06, whisper: .06, bicyclePath: .07,
  // 20 to 25 m: walking, a door, a loaded bicycle on a path.
  walkStep: .22, door: .22, loadedBicyclePath: .25,
  // 40 to 50 m: talking, sprinting, a bicycle on rough ground.
  talk: .45, sprintStep: .45, bicycleRough: .45,
  // 60 to 80 m: the bicycle bell, an alarm clock, breaking a crate.
  bell: .7, alarm: .7, crateBreak: .7,
  // 150 m: a generator, a pump, hammering (kept up: the generator's hum repeats while it runs).
  generator: 1.5, pump: 1.5, hammering: 1.5,
  // The whole island: an engine, a siren, the chapel bell, dynamite, the helicopter.
  island: 20,
  // Close up (3 m) it hears your breathing; held, nothing.
  breath: .03,
  // The rest of what the game already makes, placed on the same scale.
  torchClick: .05, ladderRung: .12, pickupSmall: .06, pickupHeavy: .15, dropSmall: .2, dropHeavy: .45,
  refuel: .3, fuseInsert: .22, radio: .45, rattle: .25,
} as const;
export type NoiseName = keyof typeof NOISE;

export type NoiseGrade = 'faint' | 'loud' | 'veryLoud';
/** Grade boundaries, in the same units: under .3 (30 m) is faint, under 1 (100 m) loud. */
export const GRADE = { faintBelow: .3, loudBelow: 1 } as const;

/** The grade of a sound: its class, by how far it carries; anything kept up counts as very loud. */
export function noiseGrade(loudness: number, sustained = false): NoiseGrade {
  if (sustained || loudness >= GRADE.loudBelow) return 'veryLoud';
  return loudness >= GRADE.faintBelow ? 'loud' : 'faint';
}

/** Weather is cover: wind cuts every distance by a third, rain by half, a storm by two thirds. */
export const WEATHER_COVER = { still: 1, wind: 2 / 3, rain: .5, storm: 1 / 3 } as const;
export type WeatherCover = keyof typeof WEATHER_COVER;

/** How far (m) a sound of this loudness carries in this weather. */
export function heardWithin(loudness: number, weather: WeatherCover = 'still') {
  return Math.max(0, loudness) * 100 * WEATHER_COVER[weather];
}

/** Whether the Listener, `distance` metres away, hears it. */
export function hears(loudness: number, distance: number, weather: WeatherCover = 'still') {
  return distance <= heardWithin(loudness, weather);
}

export type StepSurface = 'road' | 'path' | 'dirt' | 'forest' | 'water' | 'wood';
/**
 * One footfall. The gait sets the row of the table (crouch 6 m, walk 22 m, sprint 45 m); the ground nudges it a little (gravel
 * crunches, moss deadens, wading splashes), never across a grade except in water, which is loud whatever you do.
 */
export function footstepNoise(o: { speed: number; sprinting: boolean; crouching: boolean; surface: StepSurface }) {
  if (o.speed < .2) return 0;
  const gait = o.crouching ? NOISE.crouchStep : o.sprinting && o.speed > 2.2 ? NOISE.sprintStep : NOISE.walkStep;
  const ground = o.surface === 'water' ? 2 : o.surface === 'road' ? 1.15 : o.surface === 'forest' ? .9 : o.surface === 'wood' ? 1.1 : 1;
  return gait * ground;
}
