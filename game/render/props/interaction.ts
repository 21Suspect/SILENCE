import * as THREE from 'three';
import { solidContact, type SolidCollider } from '../../sim/world/collision';

export type Interactable = {
  id: string; position: THREE.Vector3;
  /** Metres from the eye. Default 2.4, as with the old flashlight pickup. */
  range?: number;
  /**
   * The line as written for a mouse ("Left click to pick up"); touch devices get "Tap to ..." instead.
   * Text that does not start with that phrase is shown as it is ("Hands full").
   */
  label: string | (() => string);
  enabled: () => boolean;
  activate: () => void;
  /**
   * Skip the line-of-sight test. For something whose own structure stands between the eye and it: a ladder seen from the
   * platform it comes up to, through that platform's rail. Such things must be tight in `enabled` instead.
   */
  seeThrough?: boolean;
  /**
   * Run by the interact key only, never by a mouse click (a click away from anything else works the torch). For things the
   * player does deliberately, like a door. The prompt names the key: "E to open". A tap still works on touch screens.
   */
  keyOnly?: boolean;
};
type World = { nearby: (x: number, z: number, radius?: number) => SolidCollider[] };

const CLICK_PREFIX = /^(left click|click|tap) to /i;
/** Looking straight at something counts; the cone narrows as the thing gets further away. */
const CONE_NEAR = .86, CONE_FAR = .94, DEFAULT_RANGE = 2.4;
const _step = new THREE.Vector3();

/**
 * The same walk flashlight.canPick makes, lifted out so every pickup shares it: sample the
 * eye-to-target segment every 12 cm and fail if any sample is inside a solid. The last
 * 18 cm are not tested, so something resting on or against a wall can still be reached.
 */
export function lineOfSight(world: World, from: THREE.Vector3, to: THREE.Vector3, tail = .18) {
  _step.subVectors(to, from); const distance = _step.length(); _step.divideScalar(distance || 1);
  for (let t = .15; t < distance - tail; t += .12) {
    const x = from.x + _step.x * t, y = from.y + _step.y * t, z = from.z + _step.z * t;
    for (const c of world.nearby(x, z, .02)) if (y > c.minY && y < c.maxY && solidContact(c, x, z, .01).depth > 0) return false;
  }
  return true;
}

/** "Left click to pick up" / "Tap to pick up" under the crosshair, the only HUD in the game. */
export function promptText(label: string, touch: boolean, key?: string) {
  return CLICK_PREFIX.test(label) ? label.replace(CLICK_PREFIX, touch ? 'Tap to ' : key ? `${key} to ` : 'Left click to ') : label;
}

export function createInteraction(container: HTMLElement, camera: THREE.PerspectiveCamera, world: World, options: { touch?: boolean; keyLabel?: () => string } = {}) {
  const keyName = () => options.keyLabel?.() ?? 'E';
  const touch = options.touch ?? (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  const items = new Map<string, Interactable>();
  let list: Interactable[] = [], focused: Interactable | undefined, shown = '';
  const eye = new THREE.Vector3(), direction = new THREE.Vector3(), toItem = new THREE.Vector3();

  const el = container.ownerDocument.createElement('div');
  el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  // The 220 ms ease is the whole animation; the text stays put while it fades so it never blinks to empty.
  el.style.cssText = 'position:absolute;left:50%;bottom:17%;transform:translateX(-50%);max-width:84%;text-align:center;pointer-events:none;z-index:20;opacity:0;transition:opacity 220ms ease;font:400 15px/1.35 system-ui,sans-serif;letter-spacing:.05em;color:#dcd8c9;text-shadow:0 1px 3px #000,0 0 14px rgba(0,0,0,.75)';
  container.appendChild(el);

  const labelOf = (item: Interactable) => typeof item.label === 'function' ? item.label() : item.label;

  /** The best enabled, in-range, in-view, unobstructed item right now. */
  function pick(): Interactable | undefined {
    camera.getWorldDirection(direction); eye.copy(camera.position);
    let best: Interactable | undefined, bestScore = -Infinity;
    for (const item of list) {
      const range = item.range ?? DEFAULT_RANGE;
      toItem.subVectors(item.position, eye); const distance = toItem.length();
      if (distance > range || !item.enabled()) continue;
      // Inside arm's reach any glance down at it is enough; a hand-length away it is still a point-blank target.
      const dot = distance < .35 ? 1 : toItem.divideScalar(distance).dot(direction);
      if (dot < THREE.MathUtils.lerp(CONE_NEAR, CONE_FAR, distance / range)) continue;
      // Prefer what the player is looking at, then what is nearer; line of sight is only paid for when it could win.
      const score = dot - distance / range * .08;
      if (score > bestScore && (item.seeThrough || lineOfSight(world, eye, item.position))) { best = item; bestScore = score; }
    }
    return best;
  }

  function show(item: Interactable | undefined) {
    focused = item;
    if (item) { const text = promptText(labelOf(item), touch, item.keyOnly ? keyName() : undefined); if (text !== shown) { shown = text; el.textContent = text; } el.style.opacity = '1'; }
    else el.style.opacity = '0';
  }

  return {
    register(item: Interactable) {
      items.set(item.id, item); list = [...items.values()];
      return () => { if (items.get(item.id) === item) { items.delete(item.id); list = [...items.values()]; } };
    },
    unregister(id: string) { items.delete(id); list = [...items.values()]; },
    /** Call once a frame. `active` is false while paused or loading: nothing is offered then. */
    update(active = true) { show(active ? pick() : undefined); },
    /** Runs the item being looked at and returns true; false if there was none (so the click can do something else). */
    activate(fromKey = false) {
      const item = pick(); if (!item || (item.keyOnly && !fromKey && !touch)) return false;
      item.activate(); show(pick()); return true;
    },
    get focused() { return focused; },
    get text() { return el.textContent ?? ''; },
    get touch() { return touch; },
    dispose() { items.clear(); list = []; el.remove(); },
  };
}

export type Interaction = ReturnType<typeof createInteraction>;
