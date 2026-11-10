import * as THREE from 'three';
import type { Pois } from './pois';

/**
 * The lamps along the valley road. Every `streetlight-*` placement has a `lamp` hook (the light opening, in the asset's
 * metadata); this gives each a sodium-orange light at dusk and puts it out again at dawn.
 *
 * Which lamps work is settled by the placement's id alone, so it is the same on every visit: about one in four is dead, and one
 * in five of the rest is failing (it cycles out and back, with a few uneven flickers in between, never a strobe).
 *
 * Rendering is budgeted. At most MAX_LIGHTS real spot lights exist, handed to the lit lamps nearest the player with hysteresis so
 * they never swap on a boundary. Every lit lamp, near or far, also has a glowing bulb and an additive halo drawn in one
 * instanced call each, which is what a distant lamp reads as in the fog. A lamp far from the player costs nothing else.
 */
export const LAMP = {
  /** Fractions, in the order a lamp is judged: a dead lamp is never also failing. */
  dead: .25, failing: .2,
  /** Darkness (1 minus daylight, from the sky) at which the lamps come on and go out. They differ, so a passing cloud cannot make them chatter. */
  onAbove: .42, offBelow: .28,
  /** Seconds for a lamp to come up to full once it starts (the lamps start up one after another over `stagger`), and to die back. */
  rise: 4.5, fall: 1.6, stagger: 3,
  /** Real lights: how many, how far a light reaches, how far from the player a lamp may be to be given one, and the lead a held light keeps. */
  maxLights: 3, reach: 16, range: 110, hold: 5,
  /** Candela at full, and the cone's half angle. */
  candela: 170, angle: 1.18,
} as const;

/** FNV-1a with a finaliser: a repeatable 0..1 from an id and a salt, so lamps of one kind never match. */
export function unit(id: string, salt: number) {
  let h = Math.imul(2166136261 ^ salt, 16777619);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; h = Math.imul(h, 3266489917); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export type LampTraits = { dead: boolean; failing: boolean; /** Seconds this lamp waits, at dusk, behind the first one. */ delay: number; /** Offsets its failing cycle from every other lamp's. */ seed: number };
export function lampTraits(id: string): LampTraits {
  const dead = unit(id, 11) < LAMP.dead;
  return { dead, failing: !dead && unit(id, 23) < LAMP.failing, delay: unit(id, 31) * LAMP.stagger, seed: unit(id, 47) };
}

/** Lamps on or off for this much darkness, given whether they were on: two thresholds, so there is no chatter between them. */
export function lampsWanted(wasOn: boolean, darkness: number) {
  return wasOn ? darkness > LAMP.offBelow : darkness > LAMP.onAbove;
}

/**
 * How bright a failing lamp is at a moment: 1 for most of a 14-30 s cycle, then a few uneven flickers, a stretch of dark, and
 * a restrike that stumbles twice before it holds. A pure function of time, so a lamp needs no state to fail.
 */
export function failingLevel(time: number, seed: number) {
  const cycle = 14 + 16 * seed, tail = 9, phase = ((time + seed * 977) % cycle + cycle) % cycle;
  if (phase < cycle - tail) return 1;
  const t = phase - (cycle - tail), slot = Math.floor(phase * 1000 / 97), noise = (k: number) => unit(`f${slot}`, Math.floor(seed * 1e6) + k);
  if (t < 2.4) return noise(1) < .62 ? 1 : .12 + .2 * noise(2);                       // going: stuttering, mostly still lit
  if (t < 5.6) return noise(3) > .93 ? .22 : 0;                                         // out, with the odd faint blip
  if (t < 6.8) { const ramp = (t - 5.6) / 1.2; return noise(4) < ramp ? ramp : 0; }    // restrike
  return t < 7.8 && noise(5) < .35 ? .35 : 1;                                           // and a last wobble before it holds
}

/**
 * Which lit lamps get a real light: the nearest `max` within `range`, except that a lamp already holding one keeps it until
 * another is nearer by more than `hold` metres. `held` is what was chosen last time.
 */
export function pickLights(lamps: readonly { id: string; distance: number }[], held: ReadonlySet<string>, max: number = LAMP.maxLights, hold: number = LAMP.hold, range: number = LAMP.range) {
  const score = (l: { id: string; distance: number }) => l.distance - (held.has(l.id) ? hold : 0);
  return lamps.filter(l => l.distance <= range).sort((a, b) => score(a) - score(b) || (a.id < b.id ? -1 : 1)).slice(0, max).map(l => l.id);
}

/** Dim, pinkish red as a sodium lamp strikes, then the orange it settles into. Linear RGB. */
const STRIKE = new THREE.Color(1, .1, .06), SODIUM = new THREE.Color(1, .3, .04), HOT = new THREE.Color(1, .5, .2);

type Lamp = { id: string; at: THREE.Vector3; traits: LampTraits; charge: number; shown: number; waited: number };
export type StreetLightOptions = {
  scene: THREE.Scene;
  /** Only `hook(placementId, name)` is used: a lamp's world position. */
  pois: Pick<Pois, 'hook'>;
  /** Every scatter placement; the ones whose id starts with `streetlight-` become lamps. */
  placements: readonly { id: string }[];
};
export type StreetLightFrame = { dt: number; time: number; player: THREE.Vector3; darkness: number };

const HALO_VERTEX = `
  attribute vec3 aColour;
  varying vec2 vUv;varying vec3 vColour;varying float vDistance;
  uniform float uSize,uAngle;
  void main(){
    vec4 centre=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);
    float dist=length(centre.xyz);
    // Big enough close to read as a lamp's glow; never smaller than a few pixels, so far ones stay points of light in the fog.
    float size=max(uSize,dist*uAngle);
    vec3 view=centre.xyz+vec3(position.xy*size*2.,0.)-normalize(centre.xyz)*.5;
    gl_Position=projectionMatrix*vec4(view,1.);
    vUv=position.xy*2.;vDistance=dist;
    vColour=aColour*(1.-smoothstep(230.,310.,dist));
  }`;
const HALO_FRAGMENT = `
  varying vec2 vUv;varying vec3 vColour;varying float vDistance;
  void main(){
    float r=length(vUv);
    if(r>1.)discard;
    // The mist between here and the lamp takes the light with it; lift the far ones back so they still read as points.
    float lift=1.+vDistance*.03;
    float glow=exp(-r*r*7.)*.85+pow(1.-r,3.)*.5+exp(-r*r*40.)*.7;
    gl_FragColor=vec4(vColour*glow*lift,1.);
  }`;

export function createStreetLights(o: StreetLightOptions) {
  const lamps: Lamp[] = [];
  for (const p of o.placements) {
    if (!p.id.startsWith('streetlight-')) continue;
    const at = o.pois.hook(p.id, 'lamp');
    if (at) lamps.push({ id: p.id, at, traits: lampTraits(p.id), charge: 0, shown: 0, waited: 0 });
  }
  lamps.sort((a, b) => a.at.x - b.at.x);
  const working = lamps.filter(l => !l.traits.dead);
  const group = new THREE.Group(); group.name = 'Street lights';
  let wanted = false, anyLit = false;
  const held = new Set<string>();
  const slots: { light: THREE.SpotLight; target: THREE.Object3D; id?: string; level: number }[] = [];
  const disposables: { dispose: () => void }[] = [];

  let bulbs: THREE.InstancedMesh | undefined, halos: THREE.InstancedMesh | undefined, colourAttribute: THREE.InstancedBufferAttribute | undefined;
  if (working.length) {
    const n = working.length, m = new THREE.Matrix4();
    const bulbGeometry = new THREE.SphereGeometry(.15, 12, 8), bulbMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    bulbs = new THREE.InstancedMesh(bulbGeometry, bulbMaterial, n); bulbs.name = 'Street lamp bulbs'; bulbs.frustumCulled = false;
    const haloGeometry = new THREE.PlaneGeometry(1, 1);
    colourAttribute = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); colourAttribute.setUsage(THREE.DynamicDrawUsage);
    haloGeometry.setAttribute('aColour', colourAttribute);
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: .55 }, uAngle: { value: .0042 } }, vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    halos = new THREE.InstancedMesh(haloGeometry, haloMaterial, n); halos.name = 'Street lamp halos'; halos.frustumCulled = false; halos.renderOrder = 5;
    working.forEach((l, i) => {
      m.makeTranslation(l.at.x, l.at.y - .04, l.at.z); bulbs!.setMatrixAt(i, m); halos!.setMatrixAt(i, m); bulbs!.setColorAt(i, new THREE.Color(0, 0, 0));
    });
    bulbs.instanceMatrix.needsUpdate = true; halos.instanceMatrix.needsUpdate = true;
    group.add(bulbs, halos);
    disposables.push(bulbGeometry, bulbMaterial, haloGeometry, haloMaterial, bulbs, halos);
    // The pool of real lights. They always exist, so a lamp coming on never changes the number of lights the scene's materials are built for.
    for (let i = 0; i < LAMP.maxLights; i++) {
      const light = new THREE.SpotLight(0xff9638, 0, LAMP.reach, LAMP.angle, 1, 2), target = new THREE.Object3D();
      light.castShadow = false; light.visible = false; light.name = `Street lamp light ${i}`; light.target = target;
      group.add(light, target); slots.push({ light, target, level: 0 });
    }
  }
  if (working.length) o.scene.add(group);   // nothing to show, nothing in the scene

  const colour = new THREE.Color(), tmp: { id: string; distance: number }[] = [];
  const ease = (x: number) => x * x * (3 - 2 * x);
  let changed = true, settling = false;

  function tint(l: Lamp, level: number, out: THREE.Color) {
    // Starts as a dim red and warms to orange over the climb; a lamp that is flickering shows the same colour at its level.
    return out.copy(STRIKE).lerp(SODIUM, ease(Math.min(1, l.charge * 1.4))).lerp(HOT, Math.max(0, level - .8) * 1.1).multiplyScalar(level);
  }

  return {
    /** Lamps along the road that exist (a lamp whose hook is missing is not one). */
    get count() { return lamps.length; },
    update(f: StreetLightFrame) {
      const next = lampsWanted(wanted, f.darkness);
      if (next !== wanted) { wanted = next; for (const l of lamps) l.waited = 0; }
      const dt = Math.max(0, Math.min(f.dt, .1));
      const jump = settling;
      if (jump) { settling = false; for (const l of working) { l.waited = 99; l.charge = wanted ? 1 : 0; } }
      anyLit = false;
      for (let i = 0; i < working.length; i++) {
        const l = working[i];
        l.waited += dt;
        // Each lamp starts a moment after the one before it.
        if (l.waited >= (wanted ? l.traits.delay : l.traits.delay * .3)) l.charge = THREE.MathUtils.clamp(l.charge + (wanted ? dt / LAMP.rise : -dt / LAMP.fall), 0, 1);
        const target = ease(l.charge) * (l.traits.failing && l.charge > .98 ? failingLevel(f.time, l.traits.seed) : 1);
        // A hot filament cannot change instantly: a failing lamp flickers but never strobes.
        const shown = l.traits.failing && l.charge > .98 && !jump ? l.shown + (target - l.shown) * (1 - Math.exp(-dt * (target > l.shown ? 22 : 11))) : target;
        if (Math.abs(shown - l.shown) > 1e-3) {
          l.shown = shown; changed = true;
          tint(l, shown, colour);
          colourAttribute!.setXYZ(i, colour.r * 1.5, colour.g * 1.5, colour.b * 1.5);
          bulbs!.setColorAt(i, colour.multiplyScalar(2.2));
        }
        if (l.shown > .02) anyLit = true;
      }
      if (changed && colourAttribute) { colourAttribute.needsUpdate = true; if (bulbs?.instanceColor) bulbs.instanceColor.needsUpdate = true; changed = false; }

      // Real lights: the lit lamps nearest the player, with hysteresis.
      tmp.length = 0;
      // A failing lamp keeps its light through its dark spells (its brightness, not its place in the budget, is what blinks).
      for (const l of working) if (l.charge > .02) tmp.push({ id: l.id, distance: Math.hypot(l.at.x - f.player.x, l.at.z - f.player.z) });
      const pick = pickLights(tmp, held, slots.length);
      held.clear(); for (const id of pick) held.add(id);
      for (const s of slots) if (s.id && !held.has(s.id)) s.level = Math.max(0, s.level - dt * 6);   // let go quickly, so the light is not seen to jump
      for (const s of slots) if (s.id && s.level <= 0 && !held.has(s.id)) s.id = undefined;
      for (const id of held) {
        let slot = slots.find(s => s.id === id);
        if (!slot) {
          slot = slots.find(s => !s.id);
          if (!slot) continue;       // every light is still fading out; this lamp gets the next one free
          const l = working.find(w => w.id === id)!;
          slot.id = id; slot.level = 0;
          slot.light.position.copy(l.at); slot.target.position.set(l.at.x, l.at.y - 8, l.at.z); slot.target.updateMatrixWorld();
        }
        slot.level = jump ? 1 : Math.min(1, slot.level + dt * 4);
      }
      for (const s of slots) {
        const l = s.id ? working.find(w => w.id === s.id) : undefined;
        const level = l ? l.shown * ease(s.level) : 0;
        s.light.intensity = level * LAMP.candela;
        if (l) tint(l, 1, s.light.color);
        s.light.visible = anyLit;
      }
    },
    /**
     * Loading only: show every real light of the pool (still at zero intensity) so a draw made now builds the shader programs for
     * "lamps on" while the loading veil covers the screen. Returns the undo. Without it the first dusk changes the scene's light count
     * and every lit material is compiled in the frame the first lamp comes on.
     */
    warm() { const was = slots.map(s => s.light.visible); for (const s of slots) s.light.visible = true; return () => { slots.forEach((s, i) => { s.light.visible = was[i]; }); }; },
    /** Finish every lamp's climb or fall now (a paused or hidden game, a test). */
    settle() { settling = true; },
    stats() {
      return {
        count: lamps.length, working: working.length, dead: lamps.length - working.length, failing: working.filter(l => l.traits.failing).length,
        wanted, lit: working.filter(l => l.shown > .02).length, real: slots.filter(s => s.id && s.light.intensity > 0).map(s => s.id!),
        levels: Object.fromEntries(working.map(l => [l.id, +l.shown.toFixed(3)])),
      };
    },
    dispose() {
      o.scene.remove(group);
      for (const d of disposables) d.dispose();
      for (const s of slots) s.light.dispose();
      group.clear();
    },
  };
}
export type StreetLights = ReturnType<typeof createStreetLights>;
