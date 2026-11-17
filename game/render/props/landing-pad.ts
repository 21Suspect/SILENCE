import * as THREE from 'three';
import { LIGHT_TUNING } from '../../core/light-tuning';
import { carries, padReady, type ObjectiveAction, type ObjectiveState } from '../../sim/objectives/objectives';
import { placeLocal } from '../../sim/world/world-layout';
import type { RunAudio } from '../../audio/helicopter-audio';
import type { Interaction } from './interaction';
import type { Pois } from './pois';
import { glowTexture } from './glow';
import { GENERATOR_CABLE_END, PAD_GENERATOR_ID, PAD_ID } from './run-sites';

/**
 * The landing pad at work: what each of its four steps does to the world (objectives.ts: bulbs, cable, fuel, lights on), and the
 * prompts that take them.
 *   - fit the bulbs: at the junction box or at any lamp post; eight bulbs (a brass base and a glass globe) appear in the sockets;
 *   - lay the cable: at the junction box; a black cable lies on the ground from the pad's generator to the box;
 *   - fuel the generator: a can in hand, at the generator's pull cord;
 *   - switch on: the lever on the junction box swings, the generator runs (a hum), and the lamps come up warm, an eight-lamp ring.
 * The lamps cost one draw each. Of real light there are TWO point lights, which always exist (a light that comes and goes changes the
 * scene's light count and recompiles every lit material in the frame it changes; street-lights.ts and the torch work the same way)
 * and are skipped for nothing by game/render/gpu/light-guards.ts while dark: one over the middle, one that stands at the lamp nearest
 * the player. The helicopter does not light the pad: the lit pad is the signal it lands on.
 */
export const PAD_LIGHT = { candela: 9, reach: 28, rise: 1.4, fall: .6 } as const;
const WARM = new THREE.Color(1, .66, .32);

export type LandingPadOptions = {
  scene: THREE.Scene;
  heightAt: (x: number, z: number) => number;
  pois: Pick<Pois, 'hook' | 'seats'>;
  interaction: Pick<Interaction, 'register'>;
  state: () => ObjectiveState;
  dispatch: (action: ObjectiveAction) => unknown;
  me: string;
  audio?: RunAudio;
};

export function createLandingPad(o: LandingPadOptions) {
  const disposers: (() => void)[] = [], geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  const root = new THREE.Group(); root.name = 'Landing pad'; o.scene.add(root);
  const lamps = Array.from({ length: 8 }, (_, k) => o.pois.hook(PAD_ID, `light${k}`)).filter((v): v is THREE.Vector3 => !!v);
  const lever = o.pois.hook(PAD_ID, 'switch'), box = o.pois.hook(PAD_ID, 'cable_in'), cord = o.pois.hook(PAD_GENERATOR_ID, 'pullcord');
  const padSeat = o.pois.seats().find(s => s.id === PAD_ID), genSeat = o.pois.seats().find(s => s.id === PAD_GENERATOR_ID);
  const centre = padSeat ? new THREE.Vector3(padSeat.placement.x, padSeat.ground + .2, padSeat.placement.z) : lamps.length ? lamps[0].clone().setX(0) : undefined;
  const missing = [!lamps.length && 'lights', !lever && 'switch', !box && 'cable_in', !cord && 'generator'].filter(Boolean);
  if (missing.length) console.warn(`SILENCE: the landing pad is missing ${missing.join(', ')}; its steps are skipped.`);

  const pad = () => o.state().pad;
  const has = (kind: 'bulbs' | 'cable' | 'jerry') => carries(o.state(), o.me, kind);

  // --- prompts ----------------------------------------------------------------------------------
  const fitBulbs = () => { o.dispatch({ type: 'pad-fit-bulbs', player: o.me }); };
  const bulbsOk = () => has('bulbs') && !pad().bulbs;
  const spots = [...lamps.map((p, k) => ({ id: `pad:bulbs:${k}`, at: p.clone().setY(p.y + .25) })), ...(box && lever ? [{ id: 'pad:bulbs:box', at: box.clone().lerp(lever, .5) }] : [])];
  for (const s of spots) disposers.push(o.interaction.register({ id: s.id, position: s.at, range: 2.6, label: 'Left click to fit the bulbs', enabled: bulbsOk, activate: fitBulbs }));
  if (box) disposers.push(o.interaction.register({
    id: 'pad:cable', position: box, range: 2.6, label: 'Left click to lay the cable',
    enabled: () => has('cable') && !pad().cable, activate: () => { o.dispatch({ type: 'pad-lay-cable', player: o.me }); },
  }));
  if (cord) disposers.push(o.interaction.register({
    id: 'pad:refuel', position: cord, range: 2.6, label: 'Left click to refuel the generator',
    enabled: () => has('jerry') && pad().fuel <= 0 && !pad().lit, activate: () => { o.dispatch({ type: 'pad-refuel', player: o.me }); },
  }));
  /** What the switch says: what is still missing, in the order the pad needs it. */
  const switchLabel = () => {
    const p = pad();
    if (p.lit) return 'Left click to switch the lights off';
    if (padReady(o.state())) return 'Left click to switch the lights on';
    return !p.bulbs ? 'The lamps have no bulbs' : !p.cable ? 'The lamps have no power cable' : 'The generator has no fuel';
  };
  if (lever) disposers.push(o.interaction.register({
    id: 'pad:switch', position: lever, range: 2.6, label: switchLabel, enabled: () => true,
    // A dry flick is allowed: it is how the player learns what is missing. The reducer refuses it and nothing happens.
    activate: () => { o.dispatch({ type: 'pad-lights', player: o.me, on: !pad().lit }); },
  }));

  // --- the bulbs: brass base and a glass globe at each socket -------------------------------------
  const glass = new THREE.MeshStandardMaterial({ color: 0xeee4c4, roughness: .12, metalness: 0, transparent: true, opacity: .88, emissive: 0xffa850, emissiveIntensity: 0 });
  const brass = new THREE.MeshStandardMaterial({ color: 0x9a7a3a, roughness: .38, metalness: .85 });
  const globeGeometry = new THREE.SphereGeometry(.075, 14, 10), baseGeometry = new THREE.CylinderGeometry(.034, .04, .05, 12);
  materials.push(glass, brass); geometries.push(globeGeometry, baseGeometry);
  const bulbs = new THREE.Group(); bulbs.name = 'Pad bulbs'; bulbs.visible = false; root.add(bulbs);
  for (const at of lamps) {
    const base = new THREE.Mesh(baseGeometry, brass), globe = new THREE.Mesh(globeGeometry, glass);
    base.position.copy(at).y += .025; globe.position.copy(at).y += .1; globe.scale.y = 1.18;
    base.castShadow = globe.castShadow = false; bulbs.add(base, globe);
  }
  // A glow round each lit lamp, additive and fog-free like the mast's beacon.
  const glowMap = glowTexture(); const halos: THREE.Sprite[] = [];
  for (const at of lamps) {
    const m = new THREE.SpriteMaterial({ map: glowMap, color: 0xffa850, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, opacity: 0 });
    const s = new THREE.Sprite(m); s.position.copy(at).y += .12; s.scale.setScalar(1.05); s.visible = false; s.name = 'Pad lamp glow'; root.add(s); halos.push(s); materials.push(m);
  }

  // --- the cable: a black tube on the ground from the generator to the junction box ----------------
  let cable: THREE.Mesh | undefined;
  const layCable = () => {
    if (cable || !box || !genSeat) return;
    const q = genSeat.placement, [ex, ez] = placeLocal(q, GENERATOR_CABLE_END[0], GENERATOR_CABLE_END[2]);
    const start = new THREE.Vector3(ex, genSeat.ground + GENERATOR_CABLE_END[1], ez), points: THREE.Vector3[] = [start];
    const n = 12;
    for (let i = 1; i < n; i++) {
      const t = i / n, x = THREE.MathUtils.lerp(start.x, box.x, t), z = THREE.MathUtils.lerp(start.z, box.z, t);
      // Lifts off the ground only at the two ends, where it meets the machines; between, it lies a finger's width above the ground (or the slab).
      const lift = Math.max(0, 1 - t * 6) * (start.y - o.heightAt(x, z)) + Math.max(0, 1 - (1 - t) * 8) * (box.y - o.heightAt(x, z));
      points.push(new THREE.Vector3(x, o.heightAt(x, z) + .03 + lift * .8, z));
    }
    points.push(box.clone());
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', .4);
    const g = new THREE.TubeGeometry(curve, 48, .022, 6, false), m = new THREE.MeshStandardMaterial({ color: 0x151512, roughness: .55, metalness: .1 });
    cable = new THREE.Mesh(g, m); cable.name = 'Pad cable'; cable.castShadow = false; cable.receiveShadow = true; root.add(cable); geometries.push(g); materials.push(m);
  };

  // --- the lever: swings down to off, up to on -----------------------------------------------------
  let leverGroup: THREE.Group | undefined, leverAngle = -.7;
  if (lever) {
    leverGroup = new THREE.Group(); leverGroup.name = 'Pad lever'; leverGroup.position.copy(lever); leverGroup.rotation.y = padSeat?.placement.yaw ?? 0; root.add(leverGroup);
    const rod = new THREE.CylinderGeometry(.012, .012, .2, 8), knob = new THREE.SphereGeometry(.03, 10, 8), m = new THREE.MeshStandardMaterial({ color: 0x8c1d17, roughness: .45, metalness: .3 }), steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: .3, metalness: .9 });
    const stick = new THREE.Mesh(rod, steel), head = new THREE.Mesh(knob, m); stick.position.y = .1; head.position.y = .21; stick.castShadow = false;
    const arm = new THREE.Group(); arm.add(stick, head); leverGroup.add(arm); geometries.push(rod, knob); materials.push(m, steel);
    (leverGroup.userData as { arm?: THREE.Object3D }).arm = arm;
  }

  // --- the lamps' light: two point lights that always exist ----------------------------------------
  const lights = [0, 1].map(k => {
    const l = new THREE.PointLight(0xffa850, 0, PAD_LIGHT.reach, 2); l.name = `Pad light ${k}`; l.castShadow = false; l.layers.enable(3); root.add(l);
    if (centre) l.position.copy(centre).y += 4.5;
    return l;
  });
  let level = 0, flicker = 0, nearest = 0;

  const done = () => { disposers.forEach(d => d()); };
  return {
    /** The brightness the lamps are at, 0 to 1. */
    get level() { return level; },
    get lampCount() { return lamps.length; },
    /** The pad's generator, in the world, where its hum sounds from. */
    get generatorAt() { return genSeat ? new THREE.Vector3(genSeat.placement.x, genSeat.ground + .8, genSeat.placement.z) : undefined; },
    update(dt: number, time: number, player: THREE.Vector3) {
      const p = pad(), step = Math.min(dt, .1);
      bulbs.visible = p.bulbs;
      if (p.cable) layCable(); if (cable) cable.visible = true;
      // Eased up and down, with a faint shimmer of a long cable and an old supply while they burn.
      const target = p.lit ? 1 : 0;
      level += (target - level) * (1 - Math.exp(-step / (target > level ? PAD_LIGHT.rise / 3 : PAD_LIGHT.fall / 3)));
      if (Math.abs(target - level) < .002) level = target;
      flicker = p.lit ? .96 + Math.sin(time * 9.3) * .02 + Math.sin(time * 23.1 + 1) * .015 : 1;
      const shown = level * flicker;
      glass.emissiveIntensity = shown * 3.2;
      for (const h of halos) { h.visible = shown > .01 && p.bulbs; (h.material as THREE.SpriteMaterial).opacity = shown * .55; }
      // The second light follows the player's nearest lamp.
      if (lamps.length) {
        let best = Infinity; for (let k = 0; k < lamps.length; k++) { const d = (lamps[k].x - player.x) ** 2 + (lamps[k].z - player.z) ** 2; if (d < best) { best = d; nearest = k; } }
        lights[1].position.lerp(new THREE.Vector3(lamps[nearest].x, lamps[nearest].y + 2.6, lamps[nearest].z), 1 - Math.exp(-step * 6));
      }
      const candela = shown * PAD_LIGHT.candela * LIGHT_TUNING.lamps;
      lights[0].intensity = candela * 1.2; lights[1].intensity = candela * .5;
      for (const l of lights) l.color.copy(WARM);
      if (leverGroup) {
        leverAngle += ((p.lit ? .75 : -.75) - leverAngle) * (1 - Math.exp(-step * 14));
        const arm = (leverGroup.userData as { arm?: THREE.Object3D }).arm; if (arm) arm.rotation.z = -leverAngle;
      }
      const at = this.generatorAt;
      o.audio?.setHum('pad', p.lit && at ? at : undefined, .62);
    },
    dispose() {
      done(); o.audio?.setHum('pad', undefined); o.scene.remove(root);
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); glowMap.dispose(); for (const l of lights) l.dispose();
    },
  };
}
export type LandingPad = ReturnType<typeof createLandingPad>;
