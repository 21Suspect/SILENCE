// The new-sounds soundboard (tools/sounds/creature.html). Everything plays through the game's own builders, so what is heard here is
// what the game plays: footfalls (buildFootfall), the body's creak, the door scratch and crash, the engines' loop, the bicycle.
import { footfallPlan, buildFootfall, buildCreak, buildScratch, buildCrash, creakPlan, bedName, BEDS, createBrush } from '/game/audio/creature-steps.ts';
import { synthesizeEngine, engineHearing, engineRate, engineFlutter } from '/game/audio/engines.ts';
import { createBicycleAudio } from '/game/audio/bicycle-audio.ts';
import { gaitTiming, legShift, createRhythmWander, LEGS } from '/game/render/creature/spider-rhythm.ts';
import { createScuttle } from '/game/sim/creature/scuttle.ts';

const status = document.getElementById('status'), root = document.getElementById('groups');
let c, master, noise;
const beds = new Map();

async function audio() {
  if (c) { if (c.state !== 'running') await c.resume(); return; }
  c = new AudioContext({ latencyHint: 'interactive' });
  master = c.createGain(); master.gain.value = 1.4; master.connect(c.destination);
  // The same white noise the game makes (audio.ts): two seconds.
  noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const white = noise.getChannelData(0); for (let i = 0; i < white.length; i++) white[i] = Math.random() * 2 - 1;
  const names = [];
  for (const kind of Object.keys(BEDS)) for (let i = 0; i < BEDS[kind]; i++) names.push(bedName(kind, i));
  status.textContent = 'Loading the footstep recordings...';
  await Promise.all(names.map(name => fetch(`/audio/footsteps/${name}.wav`).then(r => r.arrayBuffer()).then(b => c.decodeAudioData(b)).then(b => beds.set(name, b)).catch(() => {})));
  // You stand at the origin facing -z, as a camera does.
  const l = c.listener;
  l.positionX.value = 0; l.positionY.value = 1.6; l.positionZ.value = 0; l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
  status.textContent = 'Ready. You stand facing forward; the creature is placed around you.';
}

/** A panner at a point, as the game's creature sounds use (audio.ts creaturePanner). */
function panner(x, y, z) {
  const p = c.createPanner();
  p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 4; p.maxDistance = 90; p.rolloffFactor = 1.2;
  p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; p.connect(master);
  return p;
}
function step(surface, speed, leg, x, y, z, when, lift = false) {
  const plan = footfallPlan({ surface, speed, leg, lift, distance: Math.hypot(x, y - 1.6, z) });
  if (plan) buildFootfall(c, plan, panner(x, y, z), noise, name => beds.get(name), when);
}

// Where each foot stands in the body's frame, metres [sideways, forward], in spider-rhythm's LEGS order: left 1-4, then right 1-4.
const FEET = [[-1.7, 1.2], [-1.9, .35], [-1.9, -.5], [-1.6, -1.3], [1.7, 1.2], [1.9, .35], [1.9, -.5], [1.6, -1.3]];
/**
 * The creature moving in a straight line from `a` to `b` ({x, y, z}) with the game's own rhythm (spider-rhythm.ts, as the gait in
 * spider-gait.ts runs it): the step rate and duty for the pace, each leg called at its tetrapod's turn with the wander on top, the
 * claw ticking as it lifts and landing a swing later, further on. `scuttle` breaks an unhurried pace into bursts and dead stops,
 * as the game does when it creeps, prowls or searches (scuttle.ts). `side` is the body's sideways axis (level when walking,
 * across the trunk when climbing); `spread` scales the stance. Every footfall is scheduled at once; returns the seconds it takes.
 */
function gait(surface, speed, a, b, { scuttle = false, side, spread = 1 } = {}) {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), f = { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length };
  const h = Math.hypot(f.x, f.z) || 1, r = side ?? { x: -f.z / h, y: 0, z: f.x / h };
  const wander = createRhythmWander(1 + Math.floor(Math.random() * 1e6)), bursts = createScuttle(), marks = LEGS.map(() => NaN);
  const at = (d, k, ahead) => {
    const [sx, sz] = FEET[k], fwd = (sz + ahead) * spread, sd = sx * spread;
    return { x: a.x + f.x * (d + fwd) + r.x * sd, y: a.y + f.y * (d + fwd) + r.y * sd, z: a.z + f.z * (d + fwd) + r.z * sd };
  };
  const dt = 1 / 240, t0 = c.currentTime + .08;
  let t = 0, travelled = 0, pace = 0, phase = 0, wasMoving = false, brushAt = 0;
  // The legs' brush between the footfalls, as the game plays it (audio.ts creatureMove), carried along with the body.
  const bodyPan = panner(a.x, a.y + .6, a.z), brush = createBrush(c, bodyPan, noise);
  while (travelled < length && t < 90) {
    const asked = scuttle ? speed * bursts.factor(dt, speed, true) : speed;
    // The body gets going and pulls up quickly; a burst is a lunge, a freeze a dead stop.
    pace += (asked - pace) * (1 - Math.exp(-dt * (asked > pace ? 10 : 16)));
    const moving = pace > .15, { run, duty, frequency, swing } = gaitTiming(Math.max(pace, .2));
    if (moving && !wasMoving) { phase = Math.ceil(phase) + duty - .01; marks.fill(NaN); }
    wasMoving = moving;
    const previous = phase, rate = moving ? frequency : 0;
    phase += rate * dt; wander.advance(rate * dt); travelled += pace * dt; t += dt;
    if (t >= brushAt) {
      const when = t0 + t, x = a.x + f.x * travelled, y = a.y + f.y * travelled + .6, z = a.z + f.z * travelled;
      bodyPan.positionX.linearRampToValueAtTime(x, when); bodyPan.positionY.linearRampToValueAtTime(y, when); bodyPan.positionZ.linearRampToValueAtTime(z, when);
      brush.set(pace, surface, when); brushAt = t + .06 + Math.random() * .08;
    }
    // Half the ground a foot covers while it is down: it lifts that far behind its stance point and lands that far ahead of it.
    const reach = moving ? pace * duty / frequency / 2 : 0;
    LEGS.forEach(({ index, side: s }, k) => {
      const now = phase + legShift(index, s, run, wander) - duty, from = Number.isNaN(marks[k]) ? previous + legShift(index, s, run, wander) - duty : marks[k];
      if (moving && Math.floor(from) < Math.floor(now)) {
        const up = at(travelled, k, -reach / spread), down = at(travelled + pace * swing, k, reach / spread);
        // A few hundredths early or late, as the game plays them (audio.ts creatureStep).
        step(surface, pace, k, up.x, up.y, up.z, t0 + t + Math.random() * .02, true);
        step(surface, pace, k, down.x, down.y, down.z, t0 + t + swing + Math.random() * .02);
        wander.kick(index, s);
      }
      marks[k] = Math.max(from, now);
    });
  }
  brush.stop(t0 + t + .15);
  return t;
}
/** Walk along the ground (height `y`) from (x0, z0) to (x1, z1). */
function walk(surface, speed, x0, z0, x1, z1, y = 0, options) { return gait(surface, speed, { x: x0, y, z: z0 }, { x: x1, y, z: z1 }, options); }

// --- The board ------------------------------------------------------------------------------------------------------------------

const SURFACES = [
  ['earth', 'Forest floor'], ['road', 'Gravel road'], ['rock', 'Rock'], ['wood', 'Wooden deck'], ['water', 'Shallow water'],
];
const sections = [];
function section(title, note, rows) { sections.push({ title, note, rows }); }

section('One footfall', 'A single foot landing 6 m away, front left. Drift is it creeping toward a faint sound; trot is it going to a loud one; run is it charging.',
  SURFACES.map(([s, label]) => [label, [['drift', () => step(s, 1.2, 1, -3, 0, -5, c.currentTime)], ['trot', () => step(s, 4, 1, -3, 0, -5, c.currentTime)], ['run', () => step(s, 11, 1, -3, 0, -5, c.currentTime)]]]));

section('It walks past', 'Eight legs passing in front of you at 8 m, left to right, in the game’s own rhythm. Creeping (to a faint sound) and prowling (its round) it scuttles: bursts and dead stops. Trotting to a loud noise and charging it never stops.',
  SURFACES.map(([s, label]) => [label, [['creeps by', () => walk(s, 1.2, -9, -8, 9, -8, 0, { scuttle: true })], ['prowls by', () => walk(s, 2.2, -14, -8, 14, -8, 0, { scuttle: true })],
    ['trots by', () => walk(s, 4, -16, -8, 16, -8)], ['runs by', () => walk(s, 11.2, -30, -8, 30, -8)]]]));

section('It comes for you', 'From 45 m straight at you, stopping 3 m short.',
  [['Forest floor', [['creeps up on you', () => walk('earth', 1.2, 0, -22, 0, -3, 0, { scuttle: true })], ['runs at you', () => walk('earth', 11.2, 0, -45, 0, -3)]]],
   ['Gravel road', [['runs at you', () => walk('road', 11.2, 0, -45, 0, -3)]]],
   ['Behind you', [['trots up behind', () => walk('earth', 4, 0, 30, 0, 4)]]]]);

section('Over and around you', 'Indoors, with it on the cabin roof right above you; on a tree trunk beside you.',
  [['Iron roof, above', [['walks over', () => walk('metal', 2.5, -5, -1, 5, 1, 3.2)], ['runs over', () => walk('metal', 7, -7, -1, 7, 1, 3.2)]]],
   ['Wooden wall', [['crawls along', () => walk('wood', 2, -4, -3, 4, -3, 2)]]],
   ['Tree trunk, 5 m', [['climbs', () => climb()]]]]);

/** Up a trunk 4 m to your right: the same rhythm, its feet spread round the bark. */
function climb() { return gait('bark', 1.6, { x: 4, y: .5, z: -2 }, { x: 4, y: 5, z: -2 }, { side: { x: 0, y: 0, z: 1 }, spread: .22 }); }

section('Its body and the doors', 'The creak while it runs, its claws on a shut door, a door forced.',
  [['Body', [['creak (running)', () => { const p = creakPlan(10); if (p) buildCreak(c, p, panner(-2, 1.5, -6), noise, c.currentTime); }],
             ['creaks while running', () => { let t = c.currentTime; for (let i = 0; i < 4; i++) { const p = creakPlan(11); buildCreak(c, p, panner(-6 + i * 4, 1.5, -7), noise, t); t += p.next; } walk('earth', 11.2, -12, -8, 12, -8); }]]],
   ['Cabin door, 3 m', [['scratches', () => buildScratch(c, panner(0, 1.2, -3), noise, c.currentTime)], ['forced open', () => buildCrash(c, panner(0, 1.2, -3), noise, c.currentTime)]]]]);

// Engines: a loop like audio.ts's (one buffer source, a low-pass and a gain per engine), driven every frame by distance.
const engines = new Map();
function engine(id, kind, distance) {
  const e = engines.get(id);
  if (e) { e.source.stop(); engines.delete(id); return false; }
  const data = synthesizeEngine(kind, c.sampleRate), buffer = c.createBuffer(1, data.length, c.sampleRate); buffer.copyToChannel(data, 0);
  const source = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain(), pan = c.createPanner();
  source.buffer = buffer; source.loop = true; filter.type = 'lowpass'; filter.Q.value = .5; gain.gain.value = 0;
  pan.panningModel = 'HRTF'; pan.rolloffFactor = 0; pan.positionX.value = distance * .6; pan.positionY.value = 1; pan.positionZ.value = -distance * .8;
  source.connect(filter).connect(gain).connect(pan).connect(master); source.start();
  engines.set(id, { source, filter, gain, kind, distance, started: c.currentTime });
  return true;
}
(function frame() {
  if (c) for (const [id, e] of engines) {
    const h = engineHearing(e.kind, e.distance), t = c.currentTime - e.started;
    e.gain.gain.setTargetAtTime(h.gain * engineFlutter(id, t), c.currentTime, .12); e.filter.frequency.setTargetAtTime(h.lowpass, c.currentTime, .15);
    e.source.playbackRate.setTargetAtTime(engineRate(id, t), c.currentTime, .25);
  }
  requestAnimationFrame(frame);
})();
section('Machines', 'A running engine is one steady sound for as long as it runs. Click again to stop it.',
  [['Generator', [['at 8 m', 'gen8', () => engine('gen8', 'generator', 8)], ['at 40 m', 'gen40', () => engine('gen40', 'generator', 40)], ['at 120 m', 'gen120', () => engine('gen120', 'generator', 120)]]],
   ['Pump', [['at 10 m', 'pump10', () => engine('pump10', 'pump', 10)]]]]);

// The bicycle, through its own module (bicycle-audio.ts).
const bike = createBicycleAudio();
function ride(surface, speed) { bike.attach(c, master); const t0 = performance.now(); (function go() { const t = (performance.now() - t0) / 1000; bike.roll(t < 4 ? speed * Math.min(1, t / .6) : 0, surface); if (t < 4.6) requestAnimationFrame(go); })(); }
section('Bicycle', 'The bell (the island\'s best lure) and the tyres rolling for four seconds.',
  [['Bell', [['ring', () => { bike.attach(c, master); bike.bell(); }]]],
   ['Rolling', [['road, cruising', () => ride('road', 5.4)], ['forest path', () => ride('path', 4)], ['off the path', () => ride('forest', 2.2)]]]]);

for (const { title, note, rows } of sections) {
  const s = document.createElement('section'), h = document.createElement('h2'); h.textContent = title; s.appendChild(h);
  if (note) { const p = document.createElement('p'); p.textContent = note; s.appendChild(p); }
  for (const [label, buttons] of rows) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.textContent = label; row.appendChild(name);
    for (const entry of buttons) {
      const [text, maybeId, maybeFn] = entry, toggle = typeof maybeId === 'string', fn = toggle ? maybeFn : maybeId;
      const b = document.createElement('button'); b.textContent = text;
      b.onclick = async () => { await audio(); const on = fn(); if (toggle) b.setAttribute('aria-pressed', on ? 'true' : 'false'); };
      row.appendChild(b);
    }
    s.appendChild(row);
  }
  root.appendChild(s);
}
