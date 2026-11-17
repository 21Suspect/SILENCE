import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ObjectiveAction, ObjectiveState } from '../../sim/objectives/objectives';
import type { SolidCollider } from '../../sim/world/collision';
import { MAIN_ROTOR_HZ, TAIL_ROTOR_HZ, type RunAudio } from '../../audio/helicopter-audio';
import type { Interaction } from './interaction';
import { glowTexture } from './glow';
import worldAssets from '../../data/world-assets.json';

/**
 * The helicopter, drawn and flown. Objectives (game/sim/objectives/objectives.ts) decide what it does and when: called, it is `inbound`
 * until dawn; then `circling` over a dark pad (it gives up after a quarter of a game hour), or `landed` on a lit one (it waits a sixth
 * of an hour for someone to board); then `gone`. This only shows that. It comes in from the sea, 600 m out at 120 m, a little ahead of
 * the dawn so that it is over the pad when the reducer says it is; circles the pad at 45 m while it is dark; comes down to the slab
 * when the lights are on (and does so from wherever it is, if they are switched on while it circles); sits there with its rotors
 * turning; and when the reducer says it left (or the lights went out) it climbs and goes the way it came. Boarding is a prompt at its
 * doors; the reducer's `board` wins the run and `onBoard` is how the world tells the engine.
 *
 * The models (helicopter.glb with hooks rotor, tail_rotor, door_left, door_right, beacon; helicopter_rotor.glb about its mast;
 * helicopter_tail_rotor.glb about x) load when it is first called and are never needed to play: until they have (or if they cannot)
 * a plain stand-in is flown, one line in the console. The nose is +z, as in every model here, and the skids rest on y = 0.
 */
export const HELI = {
  /** How far out it comes from, how high, and how soon before dawn (game hours; 1 hour is a minute of play) it starts. */
  startDistance: 600, startHeight: 120, leadHours: .2,
  /** The circle round the pad while it is dark, and its speed. */
  orbitRadius: 70, orbitHeight: 45, orbitSpeed: 22, cruise: 55,
  /** Rotor turns per second, as drawn. The sound's rhythm follows MAIN_ROTOR_HZ. */
  mainHz: MAIN_ROTOR_HZ, tailHz: TAIL_ROTOR_HZ,
} as const;

export type HelicopterPhase = 'away' | 'approach' | 'orbit' | 'land' | 'landed' | 'depart';
type Hooks = Record<string, THREE.Vector3>;
const DEFAULT_HOOKS: Record<string, [number, number, number]> = { rotor: [0, 2.35, .1], tail_rotor: [.18, 1.85, -4.25], door_left: [-1.05, 1.0, .35], door_right: [1.05, 1.0, .35], beacon: [0, 2.75, -4.45] };
const assetHooks = (worldAssets as unknown as Record<string, { hooks?: Record<string, readonly [number, number, number]> } | undefined>).helicopter?.hooks;

export type HelicopterOptions = {
  scene: THREE.Scene;
  /** Where the pad is: its middle and yaw, and the height of the top of the slab (where the skids rest). */
  pad: { x: number; z: number; yaw: number; top: number };
  /** The way the sea is from the pad: a unit vector in x/z (default: away from the island's middle). */
  from?: { x: number; z: number };
  state: () => ObjectiveState;
  dispatch: (action: ObjectiveAction) => unknown;
  me: string;
  interaction: Pick<Interaction, 'register'>;
  collisions?: { replace: (name: string, colliders: SolidCollider[]) => void };
  audio?: RunAudio;
  /** Boarded: the world fades out and ends the run. */
  onBoard?: () => void;
  load?: (url: string) => Promise<{ scene: THREE.Object3D }>;
};

const hooksOf = (): Hooks => {
  const out: Hooks = {};
  for (const [k, v] of Object.entries(DEFAULT_HOOKS)) { const h = assetHooks?.[k] ?? v; out[k] = new THREE.Vector3(h[0], h[1], h[2]); }
  return out;
};

export function createHelicopter(o: HelicopterOptions) {
  const hooks = hooksOf(), root = new THREE.Group(); root.name = 'Helicopter'; root.visible = false; o.scene.add(root);
  const body = new THREE.Group(), mast = new THREE.Group(), tail = new THREE.Group(), geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  root.add(body);
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const lit = (color: number, rough = .6, metal = .3) => { const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }); materials.push(m); return m; };
  const box = (w: number, h: number, d: number) => { const g = new THREE.BoxGeometry(w, h, d); geometries.push(g); return g; };

  // --- a plain stand-in, flown until the model has loaded (or when it cannot) ----------------------
  const standIn = new THREE.Group(); standIn.name = 'Helicopter stand-in'; body.add(standIn);
  {
    const paint = lit(0x4a5248, .55, .35), dark = lit(0x1d1f1d, .7, .2), cabinGeometry = new THREE.SphereGeometry(1, 16, 12); geometries.push(cabinGeometry);
    const cabin = new THREE.Mesh(cabinGeometry, paint); cabin.scale.set(1.05, 1.0, 2.0); cabin.position.set(0, 1.25, .2);
    const boom = new THREE.Mesh(box(.32, .36, 3.9), paint); boom.position.set(0, 1.55, -3.2);
    const fin = new THREE.Mesh(box(.08, 1.1, .7), paint); fin.position.set(0, 2.0, -4.95);
    standIn.add(cabin, boom, fin);
    for (const x of [-.85, .85]) {
      const skid = new THREE.Mesh(box(.09, .09, 3.0), dark); skid.position.set(x, .08, .1);
      const front = new THREE.Mesh(box(.07, .7, .07), dark), rear = front.clone(); front.position.set(x, .45, 1.0); rear.position.set(x, .45, -.8);
      standIn.add(skid, front, rear);
    }
    const blades = lit(0x222421, .5, .2), main = new THREE.Mesh(box(.28, .03, 9.6), blades), main2 = new THREE.Mesh(box(9.6, .03, .28), blades);
    main.position.y = main2.position.y = 0; mast.add(main, main2);
    const tailBlade = new THREE.Mesh(box(.03, 1.5, .14), blades); tail.add(tailBlade);
  }
  mast.position.copy(hooks.rotor); tail.position.copy(hooks.tail_rotor); body.add(mast, tail);
  // The beacon on the tail: a short red flash, like the mast's.
  const glow = glowTexture(), beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xff2a1a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, opacity: 0 }));
  beacon.position.copy(hooks.beacon); beacon.scale.setScalar(1.6); body.add(beacon); materials.push(beacon.material);

  // --- the real models, lazily ---------------------------------------------------------------------
  let loading = false, disposed = false;
  const loaded: THREE.Object3D[] = [];
  let loader: GLTFLoader | undefined;
  const fetchModel = (url: string) => Promise.resolve().then(() => o.load ? o.load(url) : (loader ??= new GLTFLoader()).loadAsync(url)).then(g => g.scene, () => undefined);
  const prep = (scene: THREE.Object3D) => { scene.traverse(x => { if (x instanceof THREE.Mesh) { x.castShadow = false; x.receiveShadow = false; } }); loaded.push(scene); return scene; };
  function load() {
    if (loading) return; loading = true;
    void Promise.all([fetchModel('/world/helicopter.glb'), fetchModel('/world/helicopter_rotor.glb'), fetchModel('/world/helicopter_tail_rotor.glb')]).then(([bodyScene, rotor, tailRotor]) => {
      if (disposed) return;
      if (!bodyScene) { console.warn('SILENCE: /world/helicopter.glb could not load; the helicopter is drawn as a plain stand-in.'); return; }
      // The model's own rotors replace the stand-in's, where they exist; its body replaces the stand-in's body.
      for (const c of [...standIn.children]) standIn.remove(c);
      body.add(prep(bodyScene));
      if (rotor) { for (const c of [...mast.children]) mast.remove(c); mast.add(prep(rotor)); }
      if (tailRotor) { for (const c of [...tail.children]) tail.remove(c); tail.add(prep(tailRotor)); }
    });
  }

  // --- flight ---------------------------------------------------------------------------------------
  const pad = o.pad, centre = new THREE.Vector3(pad.x, pad.top, pad.z);
  const toSea = (() => { const d = o.from ?? { x: pad.x, z: pad.z - 35 }, n = Math.hypot(d.x, d.z) || 1; return { x: d.x / n, z: d.z / n }; })();
  const pos = new THREE.Vector3(), vel = new THREE.Vector3(), goal = new THREE.Vector3(), target = new THREE.Vector3();
  let phase: HelicopterPhase = 'away', theta = Math.atan2(toSea.z, toSea.x), yaw = 0, pitch = 0, roll = 0, rpm = 0, spin = 0, tailSpin = 0, clockSeen = 0;
  const orbitPoint = (t: number, out: THREE.Vector3) => out.set(pad.x + Math.cos(t) * HELI.orbitRadius, pad.top + HELI.orbitHeight, pad.z + Math.sin(t) * HELI.orbitRadius);

  /** Chase a point: speed grows with the distance and is capped, and the velocity follows rather than jumps, so turns are arcs. */
  function chase(to: THREE.Vector3, top: number, dt: number, response = 1.2) {
    goal.copy(to).sub(pos); const distance = goal.length();
    goal.multiplyScalar(distance > 1e-3 ? Math.min(top, distance * .6 + 3) / distance : 0);
    vel.lerp(goal, 1 - Math.exp(-dt * response));
  }
  const spawn = (where: 'sea' | 'orbit' | 'pad') => {
    if (where === 'sea') pos.set(pad.x + toSea.x * HELI.startDistance, pad.top + HELI.startHeight, pad.z + toSea.z * HELI.startDistance);
    else if (where === 'orbit') { theta = Math.atan2(toSea.z, toSea.x); orbitPoint(theta, pos); }
    else pos.copy(centre);
    vel.set(0, 0, 0); roll = pitch = 0; rpm = where === 'pad' ? 1 : .9; root.visible = true; load();
    if (where === 'sea') { vel.set(-toSea.x, -.08, -toSea.z).multiplyScalar(HELI.cruise); yaw = Math.atan2(vel.x, vel.z); }
    else if (where === 'orbit') yaw = Math.atan2(-Math.sin(theta), Math.cos(theta)); else yaw = pad.yaw;
  };
  const collider = (on: boolean) => {
    if (!o.collisions) return;
    // A fuselage: a box about the cabin (nose +z), a man's height and a half, the length of the cabin and its boom's root.
    o.collisions.replace('helicopter', on ? [{ kind: 'box', x: pos.x, z: pos.z - Math.cos(yaw) * .4, halfX: .9, halfZ: 1.9, yaw, minY: pos.y, maxY: pos.y + 2.2, tag: 'helicopter' }] : []);
  };
  const enter = (next: HelicopterPhase) => { if (phase === 'landed' && next !== 'landed') collider(false); phase = next; if (next === 'landed') collider(true); };

  // --- boarding -------------------------------------------------------------------------------------
  const left = new THREE.Vector3(), right = new THREE.Vector3(), seated = () => phase === 'landed' && o.state().helicopter.status === 'landed' && o.state().phase !== 'escaped';
  const board = () => { o.dispatch({ type: 'board', player: o.me }); if (o.state().phase === 'escaped') o.onBoard?.(); };
  const disposers = [
    o.interaction.register({ id: 'helicopter:left', position: left, range: 2.8, label: 'Left click to board the helicopter', enabled: seated, activate: board, seeThrough: true }),
    o.interaction.register({ id: 'helicopter:right', position: right, range: 2.8, label: 'Left click to board the helicopter', enabled: seated, activate: board, seeThrough: true }),
  ];

  function placeBody() {
    euler.set(pitch, yaw, roll); root.rotation.copy(euler); root.position.copy(pos); root.updateMatrixWorld(true);
    left.copy(hooks.door_left).applyMatrix4(root.matrixWorld); right.copy(hooks.door_right).applyMatrix4(root.matrixWorld);
  }

  return {
    get phase() { return phase; },
    get position() { return pos; },
    get visible() { return root.visible; },
    get rpm() { return rpm; },
    /** The helicopter's doors in the world (where the prompts aim), for the dev tools. */
    doors() { return { left: left.clone(), right: right.clone() }; },
    /** Back to nowhere (a restarted run). */
    reset() { enter('away'); root.visible = false; rpm = 0; o.audio?.setHelicopter(undefined); },
    /** Fly it now from where the state says it should be; for the dev tools. `where` puts it there at once instead of at the sea. */
    force(where: 'sea' | 'orbit' | 'pad') { spawn(where); enter(where === 'pad' ? 'landed' : where === 'orbit' ? 'orbit' : 'approach'); placeBody(); },
    update(dt: number, time: number) {
      const s = o.state(), heli = s.helicopter, step = Math.min(dt, .1);
      clockSeen = s.clock;
      if (heli.status === 'inbound') load();
      // --- what it should be doing, from the state --------------------------------------------------
      if (phase === 'away') {
        if (heli.status === 'inbound' && heli.arrives !== null && s.clock >= heli.arrives - HELI.leadHours) { spawn(s.clock >= heli.arrives ? 'orbit' : 'sea'); enter('approach'); }
        else if (heli.status === 'circling') { spawn('orbit'); enter('orbit'); }
        else if (heli.status === 'landed') { spawn('pad'); enter('landed'); }
      } else if (heli.status === 'landed' && phase !== 'landed' && phase !== 'land' && phase !== 'depart') enter('land');
      else if ((heli.status === 'gone' || heli.status === 'none') && phase !== 'depart' && s.phase !== 'escaped') enter('depart');
      if (phase === 'away') { o.audio?.setHelicopter(undefined); return; }

      // --- flight ------------------------------------------------------------------------------------
      const before = yaw;
      if (phase === 'approach') {
        const entry = orbitPoint(theta, target); chase(entry, HELI.cruise, step);
        if (pos.distanceTo(entry) < 30) enter('orbit');
      } else if (phase === 'orbit') {
        theta += HELI.orbitSpeed / HELI.orbitRadius * step;
        const ahead = orbitPoint(theta + .5, target); chase(ahead, HELI.orbitSpeed * 1.15, step, 1.6);
      } else if (phase === 'land') {
        const dx = centre.x - pos.x, dz = centre.z - pos.z, h = Math.hypot(dx, dz), ground = pad.top;
        // Over the pad's edge it slows to a hover and comes straight down; from further out it descends as it closes.
        const speed = Math.min(26, h * .5), wantY = ground + (h > 4 ? Math.min(60, (h - 4) * .5 + 3) : h > 1 ? 3 : 0);
        goal.set(h > 1e-3 ? dx / h * speed : 0, 0, h > 1e-3 ? dz / h * speed : 0);
        vel.x += (goal.x - vel.x) * (1 - Math.exp(-step * 1.4)); vel.z += (goal.z - vel.z) * (1 - Math.exp(-step * 1.4));
        const down = h > 4 ? 6 : h > 1.2 ? 2.2 : 1.6, dy = THREE.MathUtils.clamp((wantY - pos.y) * 1.2, -down, down);
        vel.y += (dy - vel.y) * (1 - Math.exp(-step * 3));
        if (h < 25) yaw += (() => { const d = Math.atan2(Math.sin(pad.yaw - yaw), Math.cos(pad.yaw - yaw)); return d * (1 - Math.exp(-step * 1.2)); })();
        // Skids on the slab: no further down than the pad's top.
        if (pos.y + vel.y * step <= ground + .005 && h < 2.2) { pos.y = ground; vel.set(0, 0, 0); pos.x = centre.x; pos.z = centre.z; yaw = pad.yaw; enter('landed'); }
      } else if (phase === 'landed') {
        vel.set(0, 0, 0);
      } else if (phase === 'depart') {
        goal.set(pad.x + toSea.x * 900, pad.top + HELI.startHeight, pad.z + toSea.z * 900);
        // Straight up first, then away, so it never sweeps the trees.
        const up = pos.y < pad.top + 22; if (up) { goal.x = pos.x; goal.z = pos.z; goal.y = pad.top + 30; }
        chase(goal, HELI.cruise, step, up ? 1.0 : .9);
        if (Math.hypot(pos.x - pad.x, pos.z - pad.z) > 700) { enter('away'); root.visible = false; rpm = 0; o.audio?.setHelicopter(undefined); return; }
      }
      pos.addScaledVector(vel, step);
      // Nose to where it is going (not while it sits, nor in a hover); the body leans into speed and into turns.
      const speed = Math.hypot(vel.x, vel.z);
      if (phase === 'landed') yaw += (pad.yaw - yaw) * (1 - Math.exp(-step * 2));
      else if (speed > 3) { let d = Math.atan2(vel.x, vel.z) - yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); yaw += d * (1 - Math.exp(-step * 1.6)); }
      let turn = yaw - before; turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      pitch += ((phase === 'landed' ? 0 : Math.min(.2, speed * .0045)) - pitch) * (1 - Math.exp(-step * 2));
      roll += (THREE.MathUtils.clamp(-turn / Math.max(step, 1e-3) * speed * .02, -.35, .35) - roll) * (1 - Math.exp(-step * 2.4));
      if (phase === 'landed') { pitch = roll = 0; }
      placeBody();
      rpm = Math.min(1, rpm + step * .5);
      spin += step * HELI.mainHz * Math.PI * 2 * rpm; tailSpin += step * HELI.tailHz * Math.PI * 2 * rpm;
      mast.rotation.y = spin; tail.rotation.x = tailSpin;
      const flash = (time % 1.1) / 1.1; (beacon.material as THREE.SpriteMaterial).opacity = flash < .14 ? Math.sin(flash / .14 * Math.PI) : .04;
      o.audio?.setHelicopter({ x: pos.x, y: pos.y, z: pos.z }, rpm, 1);
    },
    stats() { return { phase, visible: root.visible, position: pos.toArray().map(v => +v.toFixed(1)), clock: clockSeen, rpm: +rpm.toFixed(2) }; },
    dispose() {
      disposed = true; for (const d of disposers) d(); collider(false); o.audio?.setHelicopter(undefined); o.scene.remove(root);
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); glow.dispose();
      for (const m of loaded) m.traverse(x => { if (x instanceof THREE.Mesh) { x.geometry.dispose(); for (const mat of Array.isArray(x.material) ? x.material : [x.material]) mat.dispose(); } });
    },
  };
}
export type Helicopter = ReturnType<typeof createHelicopter>;
