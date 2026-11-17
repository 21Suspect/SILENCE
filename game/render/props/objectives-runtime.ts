import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { POI_PLACEMENTS, LANDING_PAD } from '../../sim/world/world-layout';
import { initialState, applyAction, firstEmptySlot, carries, generatorHours, GENERATOR_REFUEL_MAX, hasRoom, hasPack, type ObjectiveState, type ObjectiveAction, type ObjectiveEvent, type ItemKind, type Slot } from '../../sim/objectives/objectives';
import type { Interaction } from './interaction';
import { patchInterior } from './prop-materials';
import type { Pois } from './pois';
import { glowTexture } from './glow';

export type ObjectivesRuntimeOptions = {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; heightAt: (x: number, z: number) => number;
  pois: Pick<Pois, 'hook' | 'object'>; interaction: Pick<Interaction, 'register'>;
  placements?: readonly { id: string; asset: string; x: number; z: number }[];
  /** Who "I" am in the action log. A multiplayer host would hand each client its own. */
  localPlayer?: string;
  load?: (url: string) => Promise<{ scene: THREE.Object3D }>;
  /** The run's starting state: the seed's parts (initialState(partsToItems(placeParts(...)))). Default: the old fixed five. Called again by reset(). */
  newState?: () => ObjectiveState;
};

const MODEL_URL: Record<ItemKind, string> = { fuse: '/world/fuse.glb', jerry: '/world/jerrycan.glb', backpack: '/world/backpack.glb', bulbs: '/world/bulbs.glb', cable: '/world/cable_coil.glb' };
const ITEM_HOOK: Record<ItemKind, string> = { fuse: 'fuse', jerry: 'jerrycan', backpack: 'backpack', bulbs: 'bulbs', cable: 'cable' };
// Where each carried thing sits in view, camera-local. The torch owns the right hand, so these go left. A backpack is worn, never held.
const HELD: Record<ItemKind, [number, number, number]> = { fuse: [-.2, -.24, -.46], jerry: [-.3, -.42, -.56], backpack: [0, 0, 0], bulbs: [-.2, -.26, -.46], cable: [-.24, -.3, -.5] };
/** What the inventory shows: a name and a picture (rendered from the item's own model, tools/assets/ui/item-icons.py). */
export const ITEM_NAME: Record<ItemKind, string> = { fuse: 'Fuse', jerry: 'Jerry can', backpack: 'Backpack', bulbs: 'Bulbs', cable: 'Cable' };
// bulbs.png and cable.png are still to be rendered with tools/assets/ui/item-icons.py (the pictures are public/ assets); until then the slot shows no picture.
const ITEM_ICON: Record<ItemKind, string> = { fuse: '/ui/items/fuse.png', jerry: '/ui/items/jerry.png', backpack: '/ui/items/backpack.png', bulbs: '/ui/items/bulbs.png', cable: '/ui/items/cable.png' };
const GLOW = /glow/i;

/**
 * Wires the pure reducer in objectives.ts to the world: pickups sit at the hooks the assets provide,
 * stations register their prompts, and a running generator lights the hut window, blinks the mast
 * beacon. Remote players would feed `dispatch` too; local input is just one more caller.
 */
export function createObjectivesRuntime(o: ObjectivesRuntimeOptions) {
  const me = o.localPlayer ?? 'local', placements = o.placements ?? POI_PLACEMENTS;
  const fresh = o.newState ?? (() => initialState());
  let state = fresh(), shadowsDirty = false, glowApplied: boolean | undefined, disposed = false, clockNow = 0;
  const listeners = new Set<(e: ObjectiveEvent) => void>(), warned = new Set<string>(), missing: string[] = [];
  const disposers: (() => void)[] = [];
  const root = new THREE.Group(); root.name = 'Objective pickups'; o.scene.add(root);

  const hookOf = (asset: string, name: string) => { const p = placements.find(q => q.asset === asset); return p ? o.pois.hook(p.id, name) : undefined; };
  const need = (asset: string, name: string) => { const v = hookOf(asset, name); if (!v) missing.push(`${asset}.${name}`); return v; };

  // --- pickups ----------------------------------------------------------------------------------
  const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  const placeholder = (kind: ItemKind) => {
    const group = new THREE.Group();
    if (kind === 'fuse') {
      const g = new THREE.CylinderGeometry(.018, .018, .09, 12), m = new THREE.MeshStandardMaterial({ color: 0xc9bfa6, roughness: .6, metalness: .35 });
      const body = new THREE.Mesh(g, m); body.rotation.z = Math.PI / 2; body.position.y = .018; group.add(body); geometries.push(g); materials.push(m);
    } else if (kind === 'backpack') {
      const g = new THREE.BoxGeometry(.32, .44, .2), m = new THREE.MeshStandardMaterial({ color: 0x4a4836, roughness: .9 });
      const body = new THREE.Mesh(g, m); body.position.y = .22; group.add(body); geometries.push(g); materials.push(m);
    } else if (kind === 'bulbs') {
      const g = new THREE.SphereGeometry(.035, 12, 8), m = new THREE.MeshStandardMaterial({ color: 0xd9d2b8, roughness: .35 });
      for (const dx of [-.05, 0, .05]) { const bulb = new THREE.Mesh(g, m); bulb.position.set(dx, .035, 0); group.add(bulb); }
      geometries.push(g); materials.push(m);
    } else if (kind === 'cable') {
      const g = new THREE.TorusGeometry(.09, .025, 8, 16), m = new THREE.MeshStandardMaterial({ color: 0x25251f, roughness: .7 });
      const coil = new THREE.Mesh(g, m); coil.rotation.x = Math.PI / 2; coil.position.y = .03; group.add(coil); geometries.push(g); materials.push(m);
    } else {
      const g = new THREE.BoxGeometry(.34, .46, .15), cap = new THREE.CylinderGeometry(.03, .03, .05, 10), m = new THREE.MeshStandardMaterial({ color: 0x59613f, roughness: .82, metalness: .15 });
      const body = new THREE.Mesh(g, m), top = new THREE.Mesh(cap, m); body.position.y = .23; top.position.set(.1, .49, 0); group.add(body, top); geometries.push(g, cap); materials.push(m);
    }
    group.traverse(x => { if (x instanceof THREE.Mesh) { x.castShadow = true; x.receiveShadow = true; } });
    return group;
  };
  const models = new Map<string, Promise<THREE.Object3D | undefined>>(), loadedModels: THREE.Object3D[] = [];
  let loader: GLTFLoader | undefined;
  const model = (url: string) => {
    let p = models.get(url);
    if (!p) {
      p = Promise.resolve().then(() => o.load ? o.load(url) : (loader ??= new GLTFLoader()).loadAsync(url)).then(g => {
        if (disposed) return undefined;
        g.scene.traverse(x => {
          if (!(x instanceof THREE.Mesh)) return;
          x.castShadow = true; x.receiveShadow = true;
          // Indoors (the cabin), a pickup takes the room's light, not the open sky's.
          for (const m of Array.isArray(x.material) ? x.material : [x.material]) if (m instanceof THREE.MeshStandardMaterial) patchInterior(m);
        });
        loadedModels.push(g.scene); return g.scene;
      }, () => { if (!warned.has(url)) { warned.add(url); console.warn(`SILENCE: ${url} could not load; the placeholder stays.`); } return undefined; });
      models.set(url, p);
    }
    return p;
  };

  type Pickup = { id: string; kind: ItemKind; home: THREE.Vector3; position: THREE.Vector3; group: THREE.Group; yaw: number };
  const pickups = new Map<string, Pickup>();
  let index = 0;
  /**
   * Where an item lies at the start: on the prop hook the seed gave it (by the place's id), else on the ground at its x/z (the seed's
   * offset beside the place), else, for the old fixed items, on the first placement of its asset that has the hook.
   */
  const homeOf = (item: ObjectiveState['items'][string]): THREE.Vector3 | undefined => {
    if (item.poiId !== undefined) {
      const hooked = item.hook !== undefined ? o.pois.hook(item.poiId, item.hook) : undefined;
      if (hooked) return hooked;
      if (item.at) return new THREE.Vector3(item.at.x, item.at.y ?? o.heightAt(item.at.x, item.at.z), item.at.z);
      // The hook is missing (a model still being built): beside the place rather than nowhere, so the part can still be found.
      missing.push(`${item.poiId}.${item.hook ?? 'ground'}`);
      const place = placements.find(q => q.id === item.poiId);
      return place ? new THREE.Vector3(place.x + 2.5, o.heightAt(place.x + 2.5, place.z + 2.5), place.z + 2.5) : undefined;
    }
    return need(item.poi, ITEM_HOOK[item.kind]);
  };
  /** A yaw per seeded part from its id, so every client lays the same things the same way and none lie in a row. */
  const yawOf = (id: string, seeded: boolean, fallback: number) => {
    if (!seeded) return fallback;
    let h = 2166136261; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296 * Math.PI * 2;
  };
  for (const [id, item] of Object.entries(state.items)) {
    const home = homeOf(item); if (!home) continue;
    const group = new THREE.Group(); group.name = `Pickup ${id}`; group.add(placeholder(item.kind)); root.add(group);
    // Deterministic, so every client lays the same things the same way.
    const pickup: Pickup = { id, kind: item.kind, home, position: home.clone(), group, yaw: yawOf(id, item.poiId !== undefined, (index++ * 2.399) % (Math.PI * 2)) };
    pickups.set(id, pickup);
    void model(MODEL_URL[item.kind]).then(scene => { if (scene && !disposed) { group.clear(); group.add(scene.clone(true)); } });
    disposers.push(o.interaction.register({
      id: `pickup:${id}`, position: pickup.position, range: 2.6,
      label: () => item.kind === 'backpack' ? 'Left click to take the backpack' : hasRoom(state, me) ? 'Left click to pick up' : hasPack(state, me) ? 'Backpack full' : 'Hands full',
      enabled: () => state.items[id]?.status === 'world',
      activate: () => { dispatch({ type: 'pickup', player: me, item: id }); },
    }));
  }

  // --- stations ---------------------------------------------------------------------------------
  const cord = need('generator', 'pullcord'), fusebox = need('hut', 'fusebox'), radio = need('hut', 'radio'), beaconAt = need('mast', 'beacon'), windowAt = hookOf('hut', 'window');
  // The can or a fuse may be in hand or in the backpack: the reducer takes it from either.
  // A can goes in when there is room for it; while it runs, a nearly dry generator is refuelled rather than switched off (the can is in hand to be used).
  const refuels = () => carries(state, me, 'jerry') && generatorHours(state) <= GENERATOR_REFUEL_MAX && (!state.generator.running || generatorHours(state) < 1);
  if (cord) disposers.push(o.interaction.register({
    id: 'generator:cord', position: cord, range: 2.6,
    label: () => refuels() ? 'Left click to refuel' : state.generator.running ? 'Left click to switch off the generator' : 'Left click to pull the cord',
    // Clicking an empty one is allowed: a dry pull that goes nowhere is how the player learns it wants fuel.
    // Switching off stays possible after the call; starting it again does not (nothing left to power).
    enabled: () => state.generator.running || state.phase !== 'signalSent',
    activate: () => { dispatch(refuels() ? { type: 'refuel', player: me } : state.generator.running ? { type: 'stop-generator', player: me } : { type: 'pull-start', player: me }); },
  }));
  if (fusebox) disposers.push(o.interaction.register({
    id: 'hut:fusebox', position: fusebox, range: 2.6,
    // The fuse box takes fuses with no power; only the radio needs the generator.
    label: 'Left click to insert fuse',
    enabled: () => carries(state, me, 'fuse') && firstEmptySlot(state) >= 0,
    activate: () => { dispatch({ type: 'insert-fuse', player: me, slot: firstEmptySlot(state) }); },
  }));
  if (radio) disposers.push(o.interaction.register({
    id: 'hut:radio', position: radio, range: 2.6, label: 'Left click to transmit',
    enabled: () => state.phase === 'powered',
    activate: () => { dispatch({ type: 'time', hours: clockNow }); dispatch({ type: 'transmit', player: me, hours: clockNow }); },
  }));
  // One summary, not a warning per hook: assets that are still being built are expected to be short of hooks.
  if (missing.length) console.warn(`SILENCE: objectives skipped for missing hooks: ${missing.join(', ')}.`);

  // --- what a running generator does to the world -------------------------------------------------
  const glowMap = glowTexture();
  const sprite = (at: THREE.Vector3 | undefined, color: number, size: number) => {
    if (!at) return undefined;
    const m = new THREE.SpriteMaterial({ map: glowMap, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, opacity: 0 });
    const s = new THREE.Sprite(m); s.position.copy(at); s.scale.setScalar(size); s.visible = false; s.name = 'Generator light'; root.add(s); materials.push(m); return s;
  };
  // A mast light has to read from hundreds of metres, so it is far larger than the bulb that makes it.
  const beacon = sprite(beaconAt, 0xff2a1a, 3), windowGlow = sprite(windowAt, 0xffc27a, 1.7);
  const glowing = new Map<THREE.MeshStandardMaterial, number>();
  function applyGlow(on: boolean) {
    const hut = placements.find(p => p.asset === 'hut'), object = hut && o.pois.object(hut.id);
    if (!object) return false; // not loaded yet; update() retries
    object.traverse(x => {
      if (!(x instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(x.material) ? x.material : [x.material]) if (m instanceof THREE.MeshStandardMaterial && GLOW.test(m.name)) {
        if (!glowing.has(m)) glowing.set(m, m.emissiveIntensity);
        m.emissiveIntensity = on ? Math.max(1.6, glowing.get(m)!) : glowing.get(m)!;
      }
    });
    return true;
  }

  // --- state -> world ---------------------------------------------------------------------------
  const poiPoint = (poi: string | undefined) => {
    if (!poi) return undefined;
    if (poi === 'pad') return { x: LANDING_PAD.x, z: LANDING_PAD.z };
    const direct = poi === 'generator' ? cord : poi === 'hut' ? (fusebox ?? radio) : hookOf(poi, 'fuse') ?? hookOf(poi, 'jerrycan');
    if (direct) return direct;
    const p = placements.find(q => q.asset === poi); return p ? { x: p.x, z: p.z } : undefined;
  };
  const enrich = (e: ObjectiveEvent): ObjectiveEvent => {
    if (e.type !== 'noise' || e.x !== undefined) return e;
    const at = poiPoint(e.poi); return at ? { ...e, x: at.x, z: at.z } : e;
  };
  function sync() {
    for (const p of pickups.values()) {
      const item = state.items[p.id];
      // A state adopted from somewhere else (a dev tool's) may not have this part at all: nothing to show then.
      if (!item) { p.group.visible = false; continue; }
      const carried = item.holder === me;
      const visible = item.status === 'world' || (item.status === 'held' && carried);
      if (item.status === 'world') {
        if (item.at) p.position.set(item.at.x, item.at.y ?? o.heightAt(item.at.x, item.at.z), item.at.z); else p.position.copy(p.home);
        p.group.position.copy(p.position); p.group.rotation.set(0, p.yaw, 0);
        // A prompt aimed at the thing's very centre would sit inside the jerry can; aim a hand above its base.
        p.position.y += p.kind === 'jerry' ? .22 : .08;
      }
      p.group.visible = visible;
      p.group.traverse(x => { if (x instanceof THREE.Mesh) x.castShadow = item.status === 'world'; });
    }
    shadowsDirty = true;
    const running = state.generator.running;
    if (glowApplied !== running) glowApplied = applyGlow(running) ? running : undefined;
  }
  function dispatch(action: ObjectiveAction): ObjectiveEvent[] {
    const r = applyAction(state, action), changed = r.state !== state;
    state = r.state;
    const events = r.events.map(enrich);
    if (changed) sync();
    for (const e of events) { for (const l of listeners) l(e); }
    return events;
  }
  sync();

  return {
    get state() { return state; },
    get localPlayer() { return me; },
    dispatch,
    /** Adopt a snapshot (a host's, or a dev tool's) without replaying how it came about. */
    setState(next: ObjectiveState) { state = next; glowApplied = undefined; sync(); },
    /** A restarted run: the starting state again (the same parts, where the seed put them). */
    reset() { state = fresh(); clockNow = 0; glowApplied = undefined; sync(); },
    /**
     * The run's clock, in absolute game hours (objectives.ts: the count of 24-hour days plus the hour, so it never goes back). It is
     * handed to the reducer at least every half real second, which is 1/120 of a game hour, and always when a jump moves it (`now`):
     * the reducer's helicopter and pad lights run on it. A reading behind the reducer's clock (a developer setting the day back) is
     * kept but not sent, as the reducer refuses a clock that runs backwards.
     */
    time(hours: number, now = false) {
      clockNow = Math.max(clockNow, hours);
      if (clockNow > state.clock && (now || clockNow - state.clock >= 1 / 120)) dispatch({ type: 'time', hours: clockNow });
    },
    /** Every event, with noise given a world position; this is what the creature AI will subscribe to. */
    subscribe(listener: (e: ObjectiveEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** An event the reducer did not produce (a boot on a ladder rung) goes to the same listeners, so the creature has one stream to hear. */
    emit(event: ObjectiveEvent) { const e = enrich(event); for (const l of listeners) l(e); },
    /** Put down what is in hand (or, with `slot`, in that backpack slot) just ahead of the player, on the floor they are standing on. */
    dropHeld(position: THREE.Vector3, forward: THREE.Vector3, slot: Slot = 'hand') {
      const length = Math.hypot(forward.x, forward.z) || 1, x = position.x + forward.x / length * .8, z = position.z + forward.z / length * .8;
      const onDeck = position.y - o.heightAt(position.x, position.z) > .15;
      return dispatch({ type: 'drop', player: me, slot, at: { x, z, y: onDeck ? position.y : o.heightAt(x, z) } }).some(e => e.type === 'dropped');
    },
    /** Rearrange the local player's hand and backpack (game/ui/inventory.ts). */
    move(from: Slot, to: Slot) { return dispatch({ type: 'move', player: me, from, to }).some(e => e.type === 'moved'); },
    /** What the local player carries, for the inventory panel. */
    inventory() {
      const show = (id: string | null | undefined) => {
        const item = id ? state.items[id] : undefined;
        return item && id ? { id, name: ITEM_NAME[item.kind], icon: ITEM_ICON[item.kind] } : null;
      };
      return { hasPack: hasPack(state, me), hand: show(state.carrying[me]), slots: (state.packs?.[me] ?? []).map(show) };
    },
    /** Returns true when shadow casters changed. */
    update(time: number) {
      const camera = o.camera, held = state.carrying[me], p = held === undefined ? undefined : pickups.get(held);
      if (p) {
        const [x, y, z] = HELD[p.kind];
        p.group.position.set(x, y, z).applyQuaternion(camera.quaternion).add(camera.position);
        p.group.quaternion.copy(camera.quaternion); p.group.rotateY(.5);
      }
      const running = state.generator.running;
      if (running && glowApplied === undefined) glowApplied = applyGlow(true) ? true : undefined;
      if (beacon) {
        // A slow aircraft-warning flash: ~1.5 s period, short bright pulse, a dim ember between.
        const phase = (time % 1.5) / 1.5, pulse = phase < .24 ? Math.sin(phase / .24 * Math.PI) ** .6 : 0;
        beacon.visible = running; (beacon.material as THREE.SpriteMaterial).opacity = .05 + pulse * .95;
      }
      if (windowGlow) { windowGlow.visible = running; (windowGlow.material as THREE.SpriteMaterial).opacity = .62 + Math.sin(time * 13.1) * .06 + Math.sin(time * 4.7) * .05; }
      const changed = shadowsDirty; shadowsDirty = false; return changed;
    },
    stats() { return { pickups: pickups.size, phase: state.phase, listeners: listeners.size, hooksMissing: missing.slice() }; },
    dispose() {
      disposed = true;
      for (const d of disposers) d();
      o.scene.remove(root);
      // Restore any material we lit, so a later run of the same assets starts dark.
      for (const [m, base] of glowing) m.emissiveIntensity = base;
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); glowMap.dispose();
      for (const m of loadedModels) m.traverse(x => { if (x instanceof THREE.Mesh) { x.geometry.dispose(); for (const mat of Array.isArray(x.material) ? x.material : [x.material]) mat.dispose(); } });
      listeners.clear(); pickups.clear();
    },
  };
}

export type ObjectivesRuntime = ReturnType<typeof createObjectivesRuntime>;
