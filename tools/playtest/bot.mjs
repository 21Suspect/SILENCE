/**
 * A headless player that plays a whole night against the real creature (tools/playtest/world.mjs), the way
 * game/core/engine.ts drives a player: the same walking, sprinting and crouching speeds and easing, moveCharacter against
 * the real colliders, footsteps into the real noise stream by surface, the torch switch, the senses the creature is
 * given, the grab, three lives and waking at the cabin. Each play style is a small controller that decides, every
 * frame, where to go, where to look, and what to do with the torch. Everything is seeded: one style, one seed, one
 * night, the same log every time.
 *
 * What the bot knows of the creature is what a player would: whether it is on screen with nothing in the way (the
 * game's own sighting test) and where it was then, and where its sounds came from.
 */
import * as THREE from 'three';
import { game, heightAt, darknessAt, createHeadlessWorld } from './world.mjs';
// The player's real stamina: the bot gets out of breath exactly as a player does (9 s of sprint, then a walk).
const { createStamina, gaitSpeed } = await import('../../game/sim/player/stamina.ts');

const W = game.world, L = game.layout, V = game.v2, B = game.brain, LV = game.lives, VIS = game.visibility;
const ENGINE = { walk: 1.8, hurry: 3.35, crouch: .95, wading: .55, offTrail: .88, stand: 1.69, low: 1.05, stride: .82 };
export const FRAME = 1 / 30;
export const STYLES = ['trail', 'wander', 'still', 'sprint', 'indoors', 'smart', 'careless'];

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const yawToward = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** The walk a player takes along the trails: spawn, the cabin door, the main path south, the road east, the relay hut. */
function trailRoute() {
  const pts = [];
  for (let z = 12; z >= -34; z -= 4) pts.push({ x: W.pathX(z), z });
  const cabin = V.cabinWakePoint();
  for (const [x, z] of L.TRAIL_LINES[0]) pts.push({ x, z });
  pts.push({ x: cabin.x, z: cabin.z, pause: 12 });
  for (const [x, z] of [...L.TRAIL_LINES[0]].reverse()) pts.push({ x, z });
  for (let z = -38; z >= -86; z -= 4) pts.push({ x: W.pathX(z), z });
  for (let x = W.pathX(-88); x <= 150; x += 5) pts.push({ x, z: W.roadZ(x) });
  for (const [x, z] of [...L.TRAIL_LINES[3]].reverse()) pts.push({ x, z });
  // Outside the relay hut's door, a while.
  const hut = L.POI_PLACEMENTS.find(p => p.id === 'relay-hut'), [hx, hz] = L.placeLocal(hut, hut.entrance[0], hut.entrance[1] + 1.6);
  pts.push({ x: hx, z: hz, pause: 15 });
  // And back the way they came, then out again: a night of errands.
  const back = pts.slice(0, -1).reverse();
  return [...pts, ...back, ...pts.slice(1)];
}

/** A seeded player. `style` picks the controller. */
export function createBot(style, seed) {
  const random = B.createRandom(seed * 7919 + STYLES.indexOf(style) * 104729 + 13);
  const between = (a, b) => a + random() * (b - a);
  const route = trailRoute();
  const cabin = L.POI_PLACEMENTS.find(p => p.id === 'cabin');
  const [insideX, insideZ] = L.placeLocal(cabin, cabin.footprint.cx, cabin.footprint.cz);
  const door = V.cabinWakePoint();
  let leg = 0, pauseUntil = 0, heading = between(-Math.PI, Math.PI), turnAt = 0, stopUntil = 0, standUntil = 0, walkUntil = between(10, 20);
  let glanceAt = between(2, 6), glanceUntil = 0, glanceYaw = 0, lookAtSound, lookUntil = 0, reactAt = Infinity, reactTo;
  let seenAt = -Infinity, seenPos, lastSeenDist = Infinity, closing = 0, threatUntil = 0, hideUntil = 0, hideSpot, stareUntil = 0, beamUntil = 0, stuckFor = 0, sidestepUntil = 0, sidestepSide = 1;
  let indoorsPhase = 'going', pan = 0, standYaw = 0, quietUntil = 0, glancePitch = 0, beamSince;
  const doorLeg = route.findIndex(w => w.pause);
  // How a style reacts: chance to turn toward a creature sound, how often it glances about, and when it uses the torch.
  const temper = {
    trail: { react: .7, glance: [3, 9], torchDark: .5 },
    wander: { react: .5, glance: [3, 8], torchDark: .5 },
    still: { react: .85, glance: [2, 5], torchDark: .5 },
    sprint: { react: .35, glance: [6, 14], torchDark: .5 },
    indoors: { react: .8, glance: [2, 6], torchDark: .5 },
    smart: { react: .9, glance: [2.5, 6], torchDark: .55 },
    careless: { react: .6, glance: [4, 10], torchDark: .2 },
  }[style];

  /** Where the route says to go next, and whether it says to wait there. */
  function follow(t, p) {
    let w = route[leg % route.length];
    while (flat(p, w) < 2.5) {
      if (w.pause && pauseUntil < t && !w.waited) { w.waited = true; pauseUntil = t + w.pause; }
      if (t < pauseUntil) return { stop: true };
      w.waited = false; leg++; w = route[leg % route.length];
    }
    return { goal: w };
  }

  return {
    style, seed,
    /**
     * One frame of intent. `s` is what the player knows: time, darkness, position, view yaw, whether the creature is
     * on screen (and where), the creature sounds just heard, and whether the torch is on.
     */
    decide(s) {
      const t = s.t, p = s.player, out = { move: undefined, sprint: false, crouch: false, torch: s.darkness > temper.torchDark, yaw: s.yaw, pitch: 0, look: undefined };
      // Seeing it.
      if (s.seen) {
        const d = flat(p, s.seen);
        closing = s.t - seenAt < .5 ? (lastSeenDist - d) / Math.max(1e-3, s.t - seenAt) : 0;
        if (seenAt < t - 3) stareUntil = t + between(1.5, 3.5);
        seenAt = t; seenPos = { ...s.seen }; lastSeenDist = d;
        if (closing > 2.2 || d < 11) threatUntil = t + 8;
      }
      // Hearing it: turn toward the sound after a moment, sometimes.
      for (const sound of s.heard) {
        if (flat(p, sound) < 35) quietUntil = t + 20;
        if (random() < temper.react && flat(p, sound) < 80) { reactAt = t + between(.3, .9); reactTo = { x: sound.x + between(-3, 3), y: sound.y, z: sound.z + between(-3, 3) }; }
      }
      if (t >= reactAt) { lookAtSound = reactTo; lookUntil = t + between(1.5, 3); reactAt = Infinity; }

      let goal, stop = false;
      const threatened = t < threatUntil && seenPos;
      const away = seenPos ? { x: p.x + (p.x - seenPos.x), z: p.z + (p.z - seenPos.z) } : undefined;
      switch (style) {
        case 'trail': case 'sprint': {
          if (threatened) { goal = away; out.sprint = true; break; }
          const f = follow(t, p); goal = f.goal; stop = !!f.stop || (style === 'trail' && t < stareUntil);
          out.sprint = style === 'sprint';
          break;
        }
        case 'wander': {
          if (threatened) { goal = away; out.sprint = true; break; }
          if (t > turnAt) { heading += (random() < .5 ? -1 : 1) * between(1, 2.6); turnAt = t + between(6, 15); if (random() < .3) stopUntil = t + between(2, 6); }
          // Not off the edge of the world: drift back toward the middle.
          if (Math.hypot(p.x, p.z) > 330) heading = yawToward(p, { x: 0, z: 0 });
          goal = { x: p.x - Math.sin(heading) * 10, z: p.z - Math.cos(heading) * 10 };
          stop = t < stopUntil || t < stareUntil;
          break;
        }
        case 'still': {
          if (threatened) { goal = away; out.sprint = true; break; }
          if (t > walkUntil && t > standUntil) { standUntil = t + between(20, 60); walkUntil = standUntil + between(10, 20); pan = between(-1, 1); standYaw = s.yaw; }
          if (t < standUntil && !(t < lookUntil && lookAtSound) && !(seenPos && t < stareUntil)) { stop = true; out.look = standYaw + Math.sin(t * .25 + seed) * 1.6 + pan; }
          else if (t < standUntil) stop = true;
          else goal = follow(t, p).goal;
          break;
        }
        case 'indoors': {
          // To the cabin, in, and stay in until well into the night; then out and along the trail.
          if (indoorsPhase === 'going') {
            goal = leg >= doorLeg || flat(p, door) < 3 ? { x: insideX, z: insideZ } : follow(t, p).goal;
            if (flat(p, { x: insideX, z: insideZ }) < 1.2) indoorsPhase = 'inside';
          } else if (indoorsPhase === 'inside') {
            stop = true;
            // Looking about the room, and now and then out of the door.
            const toDoor = yawToward(p, door);
            if (!(t < lookUntil && lookAtSound)) out.look = Math.sin(t * .17 + seed) > .55 ? toDoor + Math.sin(t * .9) * .25 : toDoor + Math.PI + Math.sin(t * .3) * 1.8;
            if (t > 450) indoorsPhase = 'leaving';
          } else if (indoorsPhase === 'leaving') {
            goal = { x: door.x, z: door.z };
            if (flat(p, door) < 1.5) { indoorsPhase = 'out'; leg = doorLeg + 1; }
          } else {
            if (threatened) { goal = s.indoors ? { x: insideX, z: insideZ } : { x: door.x, z: door.z }; out.sprint = true; break; }
            goal = follow(t, p).goal;
          }
          break;
        }
        case 'smart': {
          const d = seenPos ? flat(p, seenPos) : Infinity, recent = t - seenAt < 1.5;
          if (t < hideUntil && hideSpot) {
            // Broken line of sight: crouched behind a trunk, torch off, waiting.
            goal = hideSpot; out.crouch = flat(p, hideSpot) < 1.5; out.torch = false; stop = flat(p, hideSpot) < .8;
            if (stop) out.look = seenPos ? yawToward(p, seenPos) : s.yaw;
            break;
          }
          // A stand-off with something that keeps its distance does not last: after a while it walks on, torch on it.
          const standing = recent && d < 24 && s.darkness > .3 && (closing > 1 || d < 14 || t < beamUntil);
          if (standing) beamSince ??= t; else beamSince = undefined;
          if (standing && (t - beamSince < 8 || closing > 1 || s.stun !== 'none' || d < 9)) {
            // Face it and hold the beam on its face; once it is held, back away.
            out.torch = true; out.look = yawToward(p, s.head ?? seenPos); out.pitch = Math.atan2((s.head?.y ?? p.y + 2) - (p.y + 1.69), Math.max(1, d));
            // Held by the beam: back away from it as fast as one can, keeping the light on its face.
            if (s.stun === 'held' || s.stun === 'slowing') { beamUntil = t + .6; goal = { x: p.x + (p.x - seenPos.x), z: p.z + (p.z - seenPos.z) }; out.sprint = true; }
            else if (beamUntil > t) stop = true;
            else stop = true;
            if (s.stun === 'starting' || (s.stun === 'none' && t > beamUntil && t - seenAt < .2 && d < 9)) {
              // It is coming again: break the line of sight behind the nearest trunk away from it.
              hideSpot = s.cover?.(seenPos); if (hideSpot) hideUntil = t + between(10, 18);
            }
            break;
          }
          if (threatened && d < 30) { hideSpot = s.cover?.(seenPos); if (hideSpot) { hideUntil = t + between(8, 14); goal = hideSpot; out.sprint = true; break; } goal = away; out.sprint = true; break; }
          // Quiet when it is close: having heard it near, torch off and crouched for a while.
          if (t < quietUntil) { out.torch = false; out.crouch = true; }
          const f = follow(t, p); goal = f.goal; stop = !!f.stop || t < stareUntil;
          break;
        }
        case 'careless': {
          // Walks straight at it.
          if (seenPos && t - seenAt < 6) goal = { x: seenPos.x, z: seenPos.z };
          else { const f = follow(t, p); goal = f.goal; stop = !!f.stop; }
          out.torch = s.darkness > .2;
          break;
        }
      }
      // Stuck against something: a sidestep.
      if (s.moved < .25 * (s.wanted || 0) && s.wanted > .5) stuckFor += FRAME; else stuckFor = Math.max(0, stuckFor - FRAME * 2);
      if (stuckFor > 1) { stuckFor = 0; sidestepUntil = t + between(.8, 1.6); sidestepSide = random() < .5 ? -1 : 1; }
      if (goal && !stop) {
        let dir = yawToward(p, goal);
        if (t < sidestepUntil) dir += sidestepSide * 1.3;
        out.move = dir;
      }
      // Where to look: the style's own look, else a sound just heard, else where it goes, with glances about.
      // Where to look: up or down toward what it is looking at, level otherwise.
      const pitchToward = q => q.y === undefined ? 0 : Math.atan2(q.y - (p.y + 1.69), Math.max(1, flat(p, q)));
      let look = out.look, pitch = out.pitch || undefined;
      if (look === undefined && t < lookUntil && lookAtSound) { look = yawToward(p, lookAtSound); pitch = pitchToward(lookAtSound); }
      if (look === undefined && style !== 'careless' && seenPos && t < stareUntil) { look = yawToward(p, seenPos); pitch = pitchToward({ ...seenPos, y: seenPos.y + 2 }); }
      if (look === undefined && style === 'careless' && seenPos && t - seenAt < 6) look = yawToward(p, seenPos);
      if (look === undefined) {
        if (t > glanceAt) { glanceYaw = (random() < .5 ? -1 : 1) * between(.7, 1.9); glancePitch = between(-.15, .35); glanceUntil = t + between(.6, 1.6); glanceAt = glanceUntil + between(...temper.glance); }
        const base = out.move ?? s.yaw;
        look = t < glanceUntil ? base + glanceYaw : base;
        if (t < glanceUntil) pitch = glancePitch;
      }
      // A head turns at a human pace.
      out.yaw = s.yaw + Math.max(-4 * FRAME * 1.6, Math.min(4 * FRAME * 1.6, wrap(look - s.yaw)));
      out.pitch = (s.pitch ?? 0) + Math.max(-2 * FRAME * 1.6, Math.min(2 * FRAME * 1.6, (pitch ?? -.04) - (s.pitch ?? 0)));
      return out;
    },
  };
}

/** Somewhere behind a trunk from a point: the nearest trunk within 12 m whose far side puts it between. */
function coverFrom(collisions, p, threat) {
  let best, score = Infinity;
  for (const c of collisions.nearby(p.x, p.z, 12)) {
    if (c.kind !== 'capsule' || c.tag !== 'tree' || c.radius < .3) continue;
    const tx = c.ax - threat.x, tz = c.az - threat.z, l = Math.hypot(tx, tz) || 1;
    const spot = { x: c.ax + tx / l * (c.radius + .7), z: c.az + tz / l * (c.radius + .7) };
    const s = flat(p, spot) + (flat(spot, threat) < flat(p, threat) ? 8 : 0);
    if (s < score) { score = s; best = spot; }
  }
  return best;
}

/**
 * Play one night. Returns the structured log: every behaviour change, sound, sighting, placement and removal,
 * stun, hunt, grab and death, the opening's timeline, and the silences.
 */
export async function playNight({ style, seed, minutes = 15, untilDawn = true, onFrame } = {}) {
  const events = [];
  const spawn = L.SPAWN, player = new THREE.Vector3(spawn.x, heightAt(spawn.x, spawn.z), spawn.z);
  // Each trace entry is stamped with how far the player was from where it happened.
  const world = await createHeadlessWorld({ creatureSeed: seed * 131 + 7, trace: e => events.push(e.x === undefined ? e : { ...e, distance: Math.hypot(e.x - player.x, e.z - player.z) }) });
  const { encounters, collisions, world2, view } = world;
  const bot = createBot(style, seed);
  const velocity = new THREE.Vector3(), lastFoot = player.clone(), forward = new THREE.Vector3(), temp = new THREE.Vector3();
  let yaw = Math.atan2(player.x - W.pathX(player.z - 8), 8), pitch = -.045, elapsed = 0, hours = LV.NIGHT_START_HOURS, stride = 0, cameraHeight = ENGINE.stand;
  let torch = false, lives = LV.initialLives(), grab, ended, heardIndex = 0, wantedSpeed = 0, moved = 0;
  const unsubscribe = world2.noise.subscribe(e => { if (e.x !== undefined && e.z !== undefined) encounters.hear({ loudness: e.loudness, source: e.source, x: e.x, z: e.z }); });
  const log = { style, seed, frames: 0, sightings: [], deaths: [], grabs: [], visibilityPops: [], stuns: [], hunts: [], sounds: [], transitions: [], behaviours: [], opening: [], deadAir: [], timeline: [], samples: [] };
  let sighting, lastVisible = false, lastStun = 'none', stun, lastBehaviour, indoorsSeconds = 0, lastGroundSpeed = 0;
  const stamina = createStamina();
  const head = new THREE.Vector3();
  const endAt = minutes * 60;

  for (let frame = 0; ; frame++) {
    const dt = FRAME; elapsed += dt; world.setClock(elapsed);
    if (!grab) hours = (hours + dt / 60) % 24;
    const darkness = darknessAt(hours);
    if (elapsed >= endAt || (untilDawn && elapsed > 300 && hours >= 6 && hours < 16)) { ended = elapsed >= endAt ? 'time' : 'dawn'; break; }
    // --- What the player knows this frame.
    const probe = encounters.probe(), indoors = V.indoorsAt(player.x, player.z);
    const heard = world.sounds.slice(heardIndex); heardIndex = world.sounds.length;
    const seen = probe.directSight ? { x: probe.x, y: probe.y, z: probe.z } : undefined;
    if (seen) encounters.headPosition(head);
    const intent = grab ? { yaw, pitch } : bot.decide({ t: elapsed, darkness, player, yaw, pitch, seen, head: seen ? { x: head.x, y: head.y, z: head.z } : undefined, heard, indoors, stun: probe.stun, moved, wanted: wantedSpeed, cover: threat => coverFrom(collisions, player, threat) });
    // --- The engine's frame (game/core/engine.ts animate), for one player.
    yaw = intent.yaw ?? yaw; pitch = THREE.MathUtils.clamp(intent.pitch ?? 0, -1.28, 1.32);
    if (!grab && intent.torch !== undefined && intent.torch !== torch) { torch = intent.torch; world2.noise.emit({ type: 'noise', loudness: B.FLASHLIGHT_CLICK_LOUDNESS, source: 'flashlight', x: player.x, z: player.z }); }
    const crouch = !grab && !!intent.crouch, run = stamina.update(dt, !grab && !!intent.sprint && !crouch, lastGroundSpeed), hurry = run.sprinting;
    const waterY = W.riverSurfaceAt(player.x, player.z), inWater = waterY !== undefined && player.y < waterY + .10;
    let moveSpeed = crouch ? ENGINE.crouch : gaitSpeed(run.blend);
    if (inWater) moveSpeed *= ENGINE.wading;
    const offTrail = W.vegetationExclusion(player.x, player.z);
    if (offTrail < .25) moveSpeed *= ENGINE.offTrail;
    // The wanted direction in the world, as keys pressed relative to where the camera faces.
    if (!grab && intent.move !== undefined) temp.set(-Math.sin(intent.move), 0, -Math.cos(intent.move)).multiplyScalar(moveSpeed); else temp.set(0, 0, 0);
    wantedSpeed = temp.length();
    const ease = 1 - Math.exp(-dt * (temp.lengthSq() > 0 ? 6 : 10)); velocity.lerp(temp, ease);
    const oldX = player.x, oldZ = player.z;
    const next = game.collision.moveCharacter(player, velocity.x * dt, velocity.z * dt, crouch ? 1.05 : 1.69, heightAt, collisions);
    player.x = next.x; player.z = next.z; player.y = THREE.MathUtils.damp(player.y, next.y, 18, dt);
    const speed = Math.hypot(player.x - oldX, player.z - oldZ) / dt; moved = speed;
    if (!grab && speed > .25 && !inWater) {
      stride += speed * dt;
      if (stride > ENGINE.stride) {
        stride %= ENGINE.stride;
        const surface = Math.abs(player.z - W.roadZ(player.x)) < 2.7 ? 'road' : offTrail < .25 ? 'forest' : 'dirt';
        const loudness = B.footstepLoudness({ speed, sprinting: hurry && !crouch, crouching: crouch, surface }) * (indoors ? .5 : 1);
        if (loudness > 0) world2.noise.emit({ type: 'noise', loudness, source: 'footstep', x: player.x, z: player.z });
      }
    }
    cameraHeight = THREE.MathUtils.damp(cameraHeight, crouch ? ENGINE.low : ENGINE.stand, 7, dt);
    forward.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    view.position.set(player.x, player.y + cameraHeight, player.z); view.forward.copy(forward);
    view.right.set(Math.cos(yaw), 0, -Math.sin(yaw)); view.up.crossVectors(view.right, view.forward).normalize();
    // Being taken: the camera belongs to the grab, then black.
    if (grab && !grab.respawned) { encounters.headPosition(head); const k = 1 - Math.exp(-dt * 12); yaw += wrap(Math.atan2(-(head.x - view.position.x), -(head.z - view.position.z)) - yaw) * k; }
    if (world.streamForest(player)) {}
    world2.update({ dt, time: elapsed, player, darkness, active: !grab, simulate: true });
    const teleported = Math.hypot(player.x - lastFoot.x, player.z - lastFoot.z) > dt * 12;
    lastGroundSpeed = teleported ? 0 : Math.hypot(player.x - lastFoot.x, player.z - lastFoot.z) / dt;
    const senses = { vx: teleported ? 0 : (player.x - lastFoot.x) / dt, vz: teleported ? 0 : (player.z - lastFoot.z) / dt, sprinting: hurry && !crouch, crouching: crouch, flashlightOn: torch, inWater, onLadder: false, indoors, untouchable: !!grab, blackout: !!grab && LV.grabTimeline(grab.t).black >= 1 };
    const wasVisible = probe.visible;
    encounters.update(dt, elapsed, player, forward, darkness, hours, senses); lastFoot.copy(player);
    if (encounters.takeStrike() && !grab) {
      const r = LV.loseLife(lives); lives = r.state; grab = { t: 0, outcome: r.outcome, respawned: false };
      const after = encounters.probe();
      log.grabs.push({ t: elapsed, phase: after.phase, hours, distance: flat(player, after), outcome: r.outcome });
      if (stun) stun.interrupted = 'grab';
      velocity.set(0, 0, 0);
    }
    const now = encounters.probe();
    if (wasVisible || now.visible) collisions.replace('creature', encounters.solidColliders());
    // A grab plays out: black at 1.05 s, the move under black at 1.6 s, the eyes open at 5.5 s.
    if (grab) {
      grab.t += dt;
      const g = LV.grabTimeline(grab.t);
      if (g.respawn && !grab.respawned) {
        grab.respawned = true;
        log.deaths.push({ t: elapsed, hours, outcome: grab.outcome });
        if (grab.outcome === 'game-over') { ended = 'game-over'; break; }
        hours = LV.respawnHours(hours);
        const at = V.cabinWakePoint();
        player.set(at.x, heightAt(at.x, at.z), at.z); velocity.set(0, 0, 0); yaw = at.yaw; lastFoot.copy(player);
        encounters.relocate(player, elapsed);
      }
      if (g.done) grab = undefined;
    }
    // --- The log.
    if (indoors) indoorsSeconds += dt;
    const d = flat(player, now);
    if (now.directSight && !sighting) sighting = { t: elapsed, phase: now.phase, script: now.script, behaviour: now.behaviour, minDistance: d, startDistance: d, seconds: 0 };
    if (sighting) { if (now.directSight) { sighting.seconds += dt; sighting.minDistance = Math.min(sighting.minDistance, d); sighting.end = elapsed; } else if (elapsed - sighting.end > .4) { log.sightings.push(sighting); sighting = undefined; } }
    // The bot's own check of the pop-in rule: whenever the body appears or disappears, was its bounding sphere on screen?
    if (now.visible !== lastVisible) {
      // The host's own rule (encounter-visibility.ts): its body sphere, with the frustum's margins.
      const inView = VIS.creatureInView(view, { x: now.x, y: now.y + 2, z: now.z }, VIS.CREATURE_VIEW_RADIUS);
      log.transitions.push({ t: elapsed, appeared: now.visible, inView, distance: +d.toFixed(1), phase: now.phase, script: now.script ?? null, blackout: senses.blackout });
      if (inView && !senses.blackout) log.visibilityPops.push({ t: elapsed, appeared: now.visible, distance: d, phase: now.phase, script: now.script ?? null });
      lastVisible = now.visible;
    }
    if (now.stun !== lastStun) {
      if (now.stun === 'slowing') stun = { t: elapsed, startDistance: d, phases: {}, phaseAt: elapsed };
      if (stun) { stun.phases[lastStun] = (stun.phases[lastStun] ?? 0) + (elapsed - stun.phaseAt); stun.phaseAt = elapsed; if (lastStun === 'held') stun.heldEndDistance = d; }
      if (now.stun === 'none' && stun) { stun.endDistance = d; delete stun.phases.none; delete stun.phaseAt; log.stuns.push(stun); stun = undefined; }
      lastStun = now.stun;
    }
    if (stun) { stun.minSpeedHeld = Math.min(stun.minSpeedHeld ?? Infinity, now.stun === 'held' ? now.speed : Infinity); stun.speeds ??= []; if (frame % 3 === 0) stun.speeds.push([+(elapsed - stun.t).toFixed(2), now.stun, +now.speed.toFixed(2), now.blocked ? 1 : 0]); }
    if (frame % 30 === 0) log.samples.push([+elapsed.toFixed(1), +player.x.toFixed(1), +player.z.toFixed(1), now.visible ? 1 : 0, +d.toFixed(1), now.phase, now.script ?? now.behaviour, indoors ? 1 : 0]);
    onFrame?.({ elapsed, player, probe: now, darkness, hours, encounters });
    log.frames++;
  }
  if (sighting) log.sightings.push(sighting);
  unsubscribe(); world.dispose();
  // Sort the creature's own trace into the log.
  for (const e of events) {
    if (e.type === 'sound') log.sounds.push({ t: e.t, kind: e.kind, presence: e.presence, seen: e.seen, distance: +e.distance.toFixed(1) });
    else if (e.type === 'transition') log.timeline.push(e);
    else if (e.type === 'behaviour') log.behaviours.push({ t: e.t, from: e.from, to: e.to });
    else if (e.type === 'hunt') log.hunts.push({ t: e.t });
    else if (e.type === 'phase' || e.type === 'director' || e.type === 'script' || e.type === 'seen') log.opening.push(e);
    else if (e.type === 'dead-air') log.deadAir.push(e);
    if (e.type !== 'behaviour' && e.type !== 'transition') log.timeline.push(e);
  }
  log.indoorsSeconds = indoorsSeconds;
  log.lives = lives; log.ended = ended; log.duration = elapsed; log.audioCalls = world.sounds.length;
  return log;
}
