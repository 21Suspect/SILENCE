/**
 * A headless copy of the game world for the player bot: the real terrain, the real forest layout's trunks, the real
 * buildings' colliders and the rebuilt world's noise stream, and the real creature (game/render/creature/encounters.ts with the
 * Listener's model loaded from disk, as tests/render/creature/creature-host.test.mjs does).
 *
 * Import this module before any game module: it sets `location` (the rebuilt world reads it at import time) and the
 * fetch shim the model loader needs. Rocks, logs and stumps are left out (their colliders need the rendered meshes);
 * trunks and buildings are what block sight and paths.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

const worldSeed = Number(process.env.SILENCE_WORLD_SEED) || 7741;
globalThis.location ??= { search: `?world-v2&seed=${worldSeed}` };
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest { constructor(url, options) { super(new URL(url, 'http://localhost/'), options); } };
globalThis.fetch = async request => {
  const url = new URL(request.url ?? request);
  if (url.pathname.endsWith('.glb')) return new Response(readFileSync(new URL(`../../public${decodeURIComponent(url.pathname)}`, import.meta.url)));
  throw new Error('offline');
};
globalThis.self ??= globalThis;
globalThis.ProgressEvent ??= class extends Event { constructor(type, init = {}) { super(type); Object.assign(this, init); } };
await import('../../tests/helpers/register-ts-hooks.mjs');

const quietly = async f => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; console.log = l; } };

export const game = await quietly(async () => ({
  world: await import('../../game/sim/world/world.ts'),
  placement: await import('../../game/sim/world/placement.ts'),
  collision: await import('../../game/sim/world/collision.ts'),
  v2: await import('../../game/render/props/world-v2.ts'),
  layout: await import('../../game/sim/world/world-layout.ts'),
  encounters: await import('../../game/render/creature/encounters.ts'),
  brain: await import('../../game/sim/creature/creature-brain.ts'),
  director: await import('../../game/sim/creature/creature-director.ts'),
  lives: await import('../../game/sim/player/lives.ts'),
  sky: await import('../../game/render/world/sky.ts'),
  sighting: await import('../../game/sim/creature/creature-sighting.ts'),
  visibility: await import('../../game/sim/creature/encounter-visibility.ts'),
  assets: await import('../../game/render/world/forest-assets.ts'),
}));

const W = game.world;
export const heightAt = W.heightAt;
const smoothstep = (v, a, b) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
/** As game/render/world/sky.ts: one minus the daylight at this hour. */
export const darknessAt = hours => 1 - smoothstep(game.sky.solarDirection(hours).y, -.14, .16);

/** The world the creature and the bot share. One per run. */
export async function createHeadlessWorld({ creatureSeed = 7741, trace } = {}) {
  const scene = new THREE.Scene(), collisions = game.collision.createCollisionWorld();
  // The forest's trunks exactly as game/render/world/forest.ts streams them: every tree within 94 m, rebuilt every 4.5 m walked.
  const layout = game.placement.naturalLayout({ heightAt, exclusion: W.vegetationExclusion, biomeAt: W.biomeAt, riverX: W.riverX, riverPresence: W.riverPresence, roadZ: W.roadZ, radius: W.WORLD_RADIUS });
  const lastForest = { x: Infinity, z: Infinity };
  const streamForest = player => {
    if ((player.x - lastForest.x) ** 2 + (player.z - lastForest.z) ** 2 <= 20) return false;
    lastForest.x = player.x; lastForest.z = player.z;
    const solids = [], cx0 = Math.floor(player.x / 32), cz0 = Math.floor(player.z / 32);
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const cx = cx0 + dx, cz = cz0 + dz;
      if (Math.hypot((cx + .5) * 32 - player.x, (cz + .5) * 32 - player.z) > 118) continue;
      for (const tree of layout.cell(cx, cz).trees) {
        if ((tree.x - player.x) ** 2 + (tree.z - player.z) ** 2 > 94 ** 2) continue;
        solids.push({ kind: 'capsule', ax: tree.x, az: tree.z, bx: tree.x, bz: tree.z, radius: .44 * tree.width + .08, minY: tree.y - .15, maxY: tree.y + 31 * tree.height, tag: 'tree', crownBase: tree.y + game.assets.branchSpec(tree.kind, 0).height * tree.height });
      }
    }
    collisions.replace('forest', solids);
    return true;
  };
  // The rebuilt world, with stand-ins for the DOM, the torch and the camera (as tests/sim/creature/creature-noise-stream.test.mjs).
  const element = () => ({ style: {}, textContent: '', hidden: true, setAttribute() {}, addEventListener() {}, remove() {}, appendChild() {} });
  const container = { ownerDocument: { createElement: element }, appendChild() {} };
  const camera = new THREE.PerspectiveCamera(69, 16 / 9, .075, 1800); camera.rotation.order = 'YXZ';
  const flashlight = { owned: true, setSeat() {}, pickUp: () => true, inspect: () => ({ pickupPosition: [0, 0, 0] }) };
  const world2 = await quietly(async () => game.v2.createWorldV2({ scene, camera, container, heightAt, collisions, flashlight, viewHeight: () => 720, riverX: W.riverX, exclusion: W.vegetationExclusion }));

  // The camera the creature checks itself against, which the bot points.
  const view = { position: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), verticalFov: 69, aspect: 16 / 9 };
  // Every creature sound, with where it came from. stalkCue keeps the real 6 s throttle.
  const sounds = [];
  let clock = 0, lastClicks = -Infinity;
  const record = (kind, position, extra) => sounds.push({ kind, t: clock, x: position.x, y: position.y, z: position.z, ...extra });
  const audio = {
    creatureReveal(p) { record('reveal', p); return true; },
    stalkCue(p) { if (clock - lastClicks < 6) return false; lastClicks = clock; record('clicks', p); return true; },
    knock(p) { record('knock', p); return true; },
    screech(p, intensity = 1) { record(intensity >= .99 ? 'grab' : 'roar', p, { intensity }); },
    hiss(p) { record('hiss', p); },
    cue(kind, p) { if (kind !== 'breath') record(kind, p); },
    hush() {}, flashlightClick() {},
  };
  const places = game.layout.POI_PLACEMENTS.filter(p => ['cabin', 'hut', 'generator', 'mast', 'lookout', 'logstack', 'camp', 'chapel', 'mine'].includes(p.asset)).map(p => ({ x: p.x, z: p.z }));
  const encounters = await quietly(async () => {
    const e = game.encounters.createEncounters(scene, heightAt, audio, collisions, () => view, W.riverSurfaceAt, { places, seed: creatureSeed, doorAt: game.v2.doorAt, trace });
    for (let i = 0; i < 200 && !e.modelStatus().ready; i++) await new Promise(r => setTimeout(r, 25));
    return e;
  });
  if (!encounters.modelStatus().ready) throw new Error('the Listener model did not load');
  return {
    scene, collisions, world2, encounters, view, sounds, audio, streamForest,
    setClock(t) { clock = t; },
    dispose() { quietly(async () => { encounters.dispose(); world2.dispose(); }); },
  };
}
