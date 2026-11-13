/**
 * The mist's weather: how much ground mist there is, as a factor on the hour's own (render/post/grade.ts fogDensityFor), drifting
 * over the game's hours so some nights are clear and some thick, the way a weather system comes and goes. Pure maths of the total
 * game hours: the same moment always has the same weather.
 *
 * Two slow waves of smooth noise: one over about 9 hours (the system: a foggy night, a clearer one), one over about 2.5 (the mist
 * thickening and lifting within a night). Mist forms in the still small hours and burns off through the morning, so the small
 * hours lean thicker and the afternoon thinner. The factor runs from about .5 to 1.7.
 */
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const wave = (t: number) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash(i) + (hash(i + 1) - hash(i)) * u; };

export function mistWeather(totalHours: number) {
  const system = wave(totalHours / 9 + 3.7), gusts = wave(totalHours / 2.5 + 11.3);
  const hour = ((totalHours % 24) + 24) % 24;
  // +.25 around 4 am, -.2 around 4 pm.
  const smallHours = .25 * Math.cos((hour - 4) / 24 * Math.PI * 2) + .025;
  return Math.min(1.75, Math.max(.45, .55 + system * .8 + (gusts - .5) * .35 + smallHours));
}

/** Counts whole days as the clock wraps past midnight, so the weather runs on instead of repeating every day. */
export function createGameClock() {
  let last = -1, days = 0;
  return (hours: number) => {
    if (last >= 0 && hours < last - 12) days++;
    else if (last >= 0 && hours > last + 12) days = Math.max(0, days - 1);
    last = hours;
    return days * 24 + hours;
  };
}
