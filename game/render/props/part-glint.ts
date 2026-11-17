import * as THREE from 'three';
import { lineOfSight } from './interaction';

/** Reach of the torch's catch and of daylight's, in metres: a part lying out twinkles inside these and nowhere else. */
export const GLINT_TORCH_RANGE = 28, GLINT_DAY_RANGE = 12;
const MAX_GLINTS = 16, RECHECK = .2, CHECKS_PER_FRAME = 3, PX_MIN = 3, PX_MAX = 11, LIFT = .12;
/** Half-angle (radians) inside which the torch beam catches a part at all, and the one where it catches hardest. */
const BEAM_WIDE = .55, BEAM_AXIS = .06;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * How bright a glint is, 0 to 1, before the pulse and the wall test. The torch catches mostly near its axis and out to 28 m
 * (so searching is a sweep of the beam); daylight alone gives a fainter, beam-free twinkle within 12 m, fading as the night
 * comes on; no torch at night, nothing. `cosBeam` is the cosine of the angle between the beam's axis and the way to the part.
 */
export function glintBrightness(distance: number, cosBeam: number, torchOn: boolean, darkness: number) {
  const day = (1 - Math.min(1, Math.max(0, darkness))) * .5 * (1 - smooth(8, GLINT_DAY_RANGE, distance));
  let torch = 0;
  if (torchOn && distance < GLINT_TORCH_RANGE) {
    const axis = smooth(Math.cos(BEAM_WIDE), Math.cos(BEAM_AXIS), cosBeam);
    torch = (.12 + .88 * axis) * axis * (1 - smooth(18, GLINT_TORCH_RANGE, distance));
  }
  return Math.max(day, torch);
}

/** Glass bulbs catch whiter and brighter, metal (fuse, jerry can, cable) warmer; [r, g, b, strength]. */
const GLASS: readonly [number, number, number, number] = [.85, .94, 1, 1.25], CLOTH: readonly [number, number, number, number] = [1, .9, .7, .6], METAL: readonly [number, number, number, number] = [1, .78, .48, .95];
export function glintTint(kind: string) { return kind === 'bulbs' ? GLASS : kind === 'backpack' ? CLOTH : METAL; }

type Located = { x: number; y: number; z: number };
type GlintItem = { status: string; kind: string; at?: { x: number; y?: number; z: number }; hook?: string; poiId?: string };
type Slot = { key: unknown; pos: THREE.Vector3; fade: number; phase: number; seen: number; checked: number; clear: boolean; kind: string; live: boolean };

/**
 * A twinkle on each part lying out (status 'world'), so a place is searched with a sweep of the torch rather than a pixel hunt.
 * One additive THREE.Points with depth testing on (walls and ground hide it); each point's size is a few pixels whatever the
 * distance. Wall and terrain tests run on a few candidates a frame and are remembered for a fifth of a second.
 */
export function createPartGlint(o: {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; collisions: Parameters<typeof lineOfSight>[0]; heightAt: (x: number, z: number) => number;
  /** Where an item lies (its hook or its dropped position), undefined if nowhere. */
  locate: (item: GlintItem) => Located | undefined;
}) {
  const position = new Float32Array(MAX_GLINTS * 3), color = new Float32Array(MAX_GLINTS * 3), size = new Float32Array(MAX_GLINTS);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('glow', new THREE.BufferAttribute(color, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('px', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'attribute vec3 glow; attribute float px; varying vec3 vGlow; void main(){ vGlow = glow; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv; gl_PointSize = px; }',
    // A hot point with a thin four-point cross: soft enough not to look like a marker, sharp enough to read as a catch of light.
    fragmentShader: 'varying vec3 vGlow; void main(){ vec2 p = gl_PointCoord * 2. - 1.; float r = length(p);'
      + ' float core = exp(-r * r * 14.); float cross = exp(-abs(p.x) * 16.) * exp(-abs(p.y) * 2.2) + exp(-abs(p.y) * 16.) * exp(-abs(p.x) * 2.2);'
      + ' float a = core + .7 * cross * (1. - r * .6); gl_FragColor = vec4(vGlow * a, 1.); }',
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'Part glints'; points.frustumCulled = false; points.renderOrder = 5; o.scene.add(points);
  const slots = new Map<string, Slot>(), dir = new THREE.Vector3(), to = new THREE.Vector3(), eye = new THREE.Vector3();
  let disposed = false;

  function clearTo(slot: Slot, from: THREE.Vector3) {
    // The ground first (a part behind a rise), then solids; sampled every 1.5 m, which is finer than anything a rise hides.
    const dx = slot.pos.x - from.x, dy = slot.pos.y - from.y, dz = slot.pos.z - from.z, steps = Math.ceil(Math.hypot(dx, dy, dz) / 1.5);
    for (let i = 1; i < steps; i++) { const t = i / steps; if (o.heightAt(from.x + dx * t, from.z + dz * t) > from.y + dy * t) return false; }
    return lineOfSight(o.collisions, from, slot.pos, .3);
  }

  return {
    /** `viewScale` is half the view height in pixels times the projection's y scale, as the ambient layer is given it. */
    update(f: { dt: number; time: number; darkness: number; torchOn: boolean; viewScale: number; items: Record<string, GlintItem> }) {
      if (disposed) return;
      eye.copy(o.camera.position); o.camera.getWorldDirection(dir);
      for (const id in f.items) {
        const item = f.items[id];
        if (item.status !== 'world') continue;
        let slot = slots.get(id);
        const key = item.at ?? item.hook;
        if (!slot || slot.key !== key) {
          const at = o.locate(item); if (!at) continue;
          if (!slot) { slot = { key, pos: new THREE.Vector3(), fade: 0, phase: slots.size * 2.4 + id.length, seen: 0, checked: -1, clear: false, kind: item.kind, live: false }; slots.set(id, slot); }
          slot.key = key; slot.pos.set(at.x, at.y + LIFT, at.z); slot.checked = -1;
        }
        slot.seen = f.time; slot.live = true;
      }
      let n = 0, checks = CHECKS_PER_FRAME;
      for (const [id, slot] of slots) {
        const lying = slot.seen === f.time && slot.live;
        slot.live = false;
        to.subVectors(slot.pos, eye); const d = to.length(), bright = lying && n < MAX_GLINTS ? glintBrightness(d, to.dot(dir) / Math.max(d, 1e-3), f.torchOn, f.darkness) : 0;
        if (bright > .01 && f.time - slot.checked > RECHECK && checks > 0) { checks--; slot.clear = clearTo(slot, eye); slot.checked = f.time; }
        const target = bright > .01 && slot.clear ? bright : 0;
        slot.fade += Math.max(-f.dt / .4, Math.min(f.dt / .25, target - slot.fade));
        if (slot.fade <= .004 && !lying) { slots.delete(id); continue; }
        if (slot.fade <= .004 || n >= MAX_GLINTS) continue;
        // A gentle pulse that never quite goes out, so the catch breathes rather than blinks.
        const pulse = .4 + .6 * Math.pow(.5 + .5 * Math.sin(f.time * 2.6 + slot.phase), 2), [r, g, b, k] = glintTint(slot.kind), a = slot.fade * pulse * k * 1.4;
        position[n * 3] = slot.pos.x; position[n * 3 + 1] = slot.pos.y; position[n * 3 + 2] = slot.pos.z;
        color[n * 3] = r * a; color[n * 3 + 1] = g * a; color[n * 3 + 2] = b * a;
        size[n] = Math.min(PX_MAX, Math.max(PX_MIN, .2 * f.viewScale / Math.max(d, 1)) * (.7 + .3 * slot.fade));
        n++;
      }
      geometry.setDrawRange(0, n);
      (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true; (geometry.attributes.glow as THREE.BufferAttribute).needsUpdate = true; (geometry.attributes.px as THREE.BufferAttribute).needsUpdate = true;
    },
    stats() { return { tracked: slots.size, drawn: geometry.drawRange.count }; },
    dispose() { disposed = true; o.scene.remove(points); geometry.dispose(); material.dispose(); slots.clear(); },
  };
}
