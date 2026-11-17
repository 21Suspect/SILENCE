// A tiny stand-in for the host of the Listener's brain: the creature walks straight where the brain asks, at the speed it asks.
// Shared by the running-source, gaze and siege tests.
import './register-ts-hooks.mjs';
const { createCreatureBrain, createRandom } = await import('../../game/sim/creature/creature-brain.ts');

export const percept = (o = {}) => ({ x: 0, y: 0, z: 0, vx: 0, vz: 0, sprinting: false, crouching: false, flashlightOn: false, inWater: false, onLadder: false, indoors: false, ...o });
export const NIGHT = 23.5;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function world({ seed = 1, hours = NIGHT, day = 1, at = { x: 0, z: 0, yaw: 0 }, buildings, tuning, round = () => [] } = {}) {
  const brain = createCreatureBrain({ random: createRandom(seed), round, buildings, tuning });
  const self = { ...at };
  let player = percept({ x: 500, z: 500 });
  const state = { hours, day, openings: undefined };
  const step = (o = {}) => {
    const dt = o.dt ?? .05, d = Math.hypot(self.x - player.x, self.z - player.z);
    const out = brain.tick({
      dt, hours: o.hours ?? state.hours, day: o.day ?? state.day, creature: { ...self }, player, beamOnIt: false,
      reach: o.reach ?? Math.max(0, d - 1.1), openings: typeof state.openings === 'function' ? state.openings() : state.openings,
    });
    const target = out.intent.target;
    if (o.move !== false && target && out.intent.speed > 0) {
      const dx = target.x - self.x, dz = target.z - self.z, l = Math.hypot(dx, dz);
      if (l > (out.intent.arrive ?? 1.2)) { const s = Math.min(l, out.intent.speed * dt); self.x += dx / l * s; self.z += dz / l * s; self.yaw = Math.atan2(dx, dz); }
    }
    return out;
  };
  /** Run for `seconds`; `o` may be a function of the time. Returns the events, the behaviours in order, the last output. */
  const run = (seconds, o = {}) => {
    const events = [], behaviours = [];
    let out;
    for (let t = 0; t < seconds - 1e-9; t += o.dt ?? .05) {
      out = step(typeof o === 'function' ? o(t) : o);
      events.push(...out.events);
      if (behaviours[behaviours.length - 1] !== out.behaviour) behaviours.push(out.behaviour);
    }
    return { out, events, behaviours };
  };
  return { brain, self, step, run, state, set player(p) { player = percept(p); }, get player() { return player; } };
}
