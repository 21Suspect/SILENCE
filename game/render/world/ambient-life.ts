import * as THREE from 'three';
import { buildRoute, createRoute, crossingPair, escapeTarget, homeNear, planWaypoints, routeAt, type Vec } from './crow-flight';
import { CROW_FOOT, createCrowGeometry, createCrowMaterial } from './crow-model';

/** A place on something solid where a crow sits (the top of a ridge), and the way it faces. */
export type Perch = { x: number; y: number; z: number; yaw: number };
/**
 * Where crows rest. A `hidden` roost is a stand of trees: the birds drop into the crowns and are not drawn until they leave
 * them. A roost with `perches` (the cabin's ridge) is one they sit on in view.
 */
export type Roost = { x: number; y: number; z: number; hidden?: boolean; perches?: readonly Perch[] };
export type AmbientOptions = {
  /** Where crows rest, in world metres. The flock bursts out of its roost when the player gets within 25 m. */
  roosts: readonly Roost[];
  /** Base of the cabin's thin smoke column. */
  chimney?: THREE.Vector3;
  heightAt: (x: number, z: number) => number;
  /**
   * A tree crown within `radius` of (x, z), if the trees there are known (`pick`, 0 to 1, chooses among them): a bird leaves
   * from inside one and drops into one, rather than appearing from the open air.
   */
  canopy?: (x: number, z: number, radius: number, pick: number) => { x: number; y: number; z: number } | undefined;
  /** Fired once per startle for diagnostics. */
  onBurst?: (x: number, y: number, z: number) => void;
  seed?: number; crows?: number; puffs?: number;
};
export type AmbientFrame = {
  /** Simulation seconds; stands still while the game is paused. */
  time: number; dt: number; player: THREE.Vector3;
  /** 0 = full day, 1 = deep night, as sky.update reports it. */
  darkness: number;
  /** Pixels per metre at one metre: drawingBufferHeight / 2 * projectionMatrix.elements[5]. */
  viewScale: number;
  /** Unit direction the camera looks along. Without it every bird counts as in view, and none is added or taken away near the player. */
  view?: THREE.Vector3;
};

const BURST_RADIUS = 25, ESCAPE_MIN = 120, TAU = Math.PI * 2;
// The day ends fast at the game's clock (an hour a minute): darkness is .05 at 18:00, .38 at 18:30 and .6 at 18:45.
// The dusk stream leaves as the light starts going and is down before .6; above NIGHT nothing is drawn at all.
const DUSK = .02, LATE = .45, NIGHT = .6;
const IDLE = 0, PERCH = 1, FLY = 2;
const ROUTES = 6;
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * Two draws in total (crows and smoke), and nothing is allocated per frame: birds live in typed arrays, the wingbeat and
 * puff motion run in the vertex shaders, and anything that cannot be seen (every crow at night, the smoke after dark)
 * skips its work and its draw call entirely.
 *
 * Crows never circle. A resting flock sits in its roost (drawn only on a perch); walked up to, it bursts out over about a
 * second and flies off away from the player to another roost at least 120 m away. By day a pair or a few commute between
 * two stands of trees across the player's sky; at dusk the flock streams to a night roost and is gone before dark.
 */
export function createAmbientLife(scene: THREE.Scene, o: AmbientOptions) {
  const random = rng(o.seed ?? 1913), group = new THREE.Group(); group.name = 'Ambient life'; scene.add(group);

  // --- crows -----------------------------------------------------------------------------------
  const N = o.crows ?? 24, roosts = o.roosts;
  const crowGeometry = createCrowGeometry(), crowMaterial = createCrowMaterial();
  const birdAttribute = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4), birdData = birdAttribute.array as Float32Array;
  birdAttribute.setUsage(THREE.DynamicDrawUsage); crowGeometry.setAttribute('aBird', birdAttribute);
  const crows = new THREE.InstancedMesh(crowGeometry, crowMaterial, N);
  crows.name = 'Crows'; crows.frustumCulled = false; crows.visible = false; crows.count = 0; crows.receiveShadow = true;
  crows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const matrix = crows.instanceMatrix.array as Float32Array;
  group.add(crows);

  const mode = new Uint8Array(N), routeOf = new Int8Array(N).fill(-1), perchOf = new Int16Array(N).fill(-1), perchRoost = new Int16Array(N).fill(-1), member = new Uint8Array(N), startled = new Uint8Array(N), emerge = new Uint8Array(N);
  const leave = new Float64Array(N), hopAt = new Float64Array(N), cursor = new Int32Array(N);
  const dist = new Float32Array(N), speed = new Float32Array(N), cruise = new Float32Array(N), beatRate = new Float32Array(N), size = new Float32Array(N), wob = new Float32Array(N);
  const latOff = new Float32Array(N), upOff = new Float32Array(N), sx = new Float32Array(N), sy = new Float32Array(N), sz = new Float32Array(N), ex = new Float32Array(N), ey = new Float32Array(N), ez = new Float32Array(N);
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
  const ax = new Float32Array(N), ay = new Float32Array(N), az = new Float32Array(N), fx = new Float32Array(N), fy = new Float32Array(N), fz = new Float32Array(N);
  const ux = new Float32Array(N), uy = new Float32Array(N), uz = new Float32Array(N), yaw = new Float32Array(N), hop = new Float32Array(N), scale = new Float32Array(N);
  const phase = new Float32Array(N), amp = new Float32Array(N), lift = new Float32Array(N), fold = new Float32Array(N), beats = new Float32Array(N), glide = new Float32Array(N);
  for (let i = 0; i < N; i++) { size[i] = 1.05 + random() * .15; wob[i] = random(); beatRate[i] = 3.6 + random() * .6; }

  const routes = Array.from({ length: ROUTES }, createRoute), routeUsers = new Int16Array(ROUTES), routeDest = new Int16Array(ROUTES).fill(-1), routePerch = new Uint8Array(ROUTES);
  const waypoints = new Float32Array(3 * 24), at: Vec = { x: 0, y: 0, z: 0 }, ahead: Vec = { x: 0, y: 0, z: 0 }, from: Vec = { x: 0, y: 0, z: 0 }, to: Vec = { x: 0, y: 0, z: 0 };
  // The resident flock: which roost it is in (-1: none yet), how many birds, and how many are still flying to it.
  const flockSize = 8 + Math.floor(random() * 5);
  let home = -1, transit = 0, now = 0, housekeepAt = 0, nextCommute = -1, streamedDusk = false, streamedDawn = false, wasNight = false, started = false, lastBurst = -Infinity;
  let player: THREE.Vector3 | undefined, view: THREE.Vector3 | undefined;

  const seen = (x: number, y: number, z: number) => {
    if (!player || !view) return true;
    const dx = x - player.x, dy = y - player.y - 1.6, dz = z - player.z, d = Math.hypot(dx, dy, dz) || 1;
    return (dx * view.x + dy * view.y + dz * view.z) / d > .3;
  };
  const far = (x: number, z: number, metres: number) => !player || (x - player.x) ** 2 + (z - player.z) ** 2 > metres * metres;
  const freeBird = () => { for (let i = 0; i < N; i++) if (mode[i] === IDLE) return i; return -1; };
  const freeRoute = () => { for (let r = 0; r < ROUTES; r++) if (routeUsers[r] === 0) return r; return -1; };
  const slotOf = (i: number) => perchRoost[i] >= 0 ? roosts[perchRoost[i]].perches?.[perchOf[i]] : undefined;
  /** Birds sitting (and not about to leave) on `roost`. */
  const perched = (roost: number) => { let n = 0; for (let i = 0; i < N; i++) if (mode[i] === PERCH && routeOf[i] < 0 && perchRoost[i] === roost) n++; return n; };
  /** How many of the flock sit on a perch roost: never every place on it, so the row has gaps. */
  const sitters = (roost: number) => Math.min(flockSize, Math.ceil((roosts[roost].perches?.length ?? 0) * .6));
  const unseat = (i: number) => { mode[i] = IDLE; perchOf[i] = perchRoost[i] = -1; };
  /** Abstract flock members appear on the home perch: only out of sight or far off (or as the game starts), never in front of the player. */
  const seat = () => {
    const slots = roosts[home]?.perches;
    if (!slots?.length || transit > 0) return;
    const taken = new Uint8Array(slots.length);
    for (let i = 0; i < N; i++) if (mode[i] === PERCH && perchRoost[i] === home && perchOf[i] >= 0) taken[perchOf[i]] = 1;
    let need = sitters(home) - perched(home);
    // Every fifth slot round the ridge, so a few birds spread out along it rather than bunching at one end.
    for (let k = 0; k < slots.length && need > 0; k++) {
      const j = (k * 5) % slots.length;
      if (taken[j]) continue;
      const i = freeBird(); if (i < 0) return;
      const slot = slots[j];
      mode[i] = PERCH; perchRoost[i] = home; perchOf[i] = j; routeOf[i] = -1; yaw[i] = slot.yaw + (random() - .5) * .7;
      px[i] = slot.x; py[i] = slot.y + CROW_FOOT * size[i]; pz[i] = slot.z; vx[i] = vy[i] = vz[i] = ax[i] = ay[i] = az[i] = 0;
      fx[i] = Math.sin(yaw[i]); fy[i] = 0; fz[i] = Math.cos(yaw[i]); ux[i] = 0; uy[i] = 1; uz[i] = 0;
      fold[i] = 1; amp[i] = lift[i] = phase[i] = 0; hopAt[i] = now + 4 + random() * 12; hop[i] = 0; scale[i] = 1;
      need--;
    }
  };
  const roostPoint = (index: number, out: Vec) => { const r = roosts[index]; out.x = r.x; out.y = r.y; out.z = r.z; return out; };

  /**
   * Sends bird `i` along route `r`, leaving at time `t` from where it is (a perch) or from inside the crown at
   * (cx, cy, cz). `slot` is the perch it will land on, if the route ends on one.
   */
  function launch(i: number, r: number, t: number, lateral: number, vertical: number, fast: boolean, destRoost = -1, slotIndex = -1, crown?: Vec) {
    const route = routes[r], n = route.count - 1;
    leave[i] = t; routeOf[i] = r; routeUsers[r]++; dist[i] = 0; cursor[i] = 0; startled[i] = fast ? 1 : 0;
    latOff[i] = lateral; upOff[i] = vertical; cruise[i] = fast ? 11 + random() * 1.5 : 9.5 + random() * 2;
    beats[i] = 2 + Math.floor(random() * 4); glide[i] = 0;
    if (mode[i] === PERCH) { emerge[i] = 0; sx[i] = px[i] - route.x[0]; sy[i] = py[i] - route.y[0]; sz[i] = pz[i] - route.z[0]; }
    else {
      mode[i] = FLY; emerge[i] = 1; fold[i] = 0; amp[i] = 1; lift[i] = 0; phase[i] = random() * TAU;
      const c = crown ?? o.canopy?.(route.x[0], route.z[0], 16, random());
      if (c) { sx[i] = c.x - route.x[0]; sy[i] = c.y - route.y[0]; sz[i] = c.z - route.z[0]; }
      else { sx[i] = (random() - .5) * 10; sy[i] = (random() - .5) * 3; sz[i] = (random() - .5) * 10; }
      px[i] = route.x[0] + sx[i]; py[i] = route.y[0] + sy[i]; pz[i] = route.z[0] + sz[i];
      vx[i] = vy[i] = vz[i] = ax[i] = ay[i] = az[i] = 0; fx[i] = route.x[2] - route.x[0]; fy[i] = 0; fz[i] = route.z[2] - route.z[0]; ux[i] = 0; uy[i] = 1; uz[i] = 0;
      const l = Math.hypot(fx[i], fz[i]) || 1; fx[i] /= l; fz[i] /= l;
    }
    const slot = destRoost >= 0 ? roosts[destRoost].perches?.[slotIndex] : undefined;
    if (slot) { ex[i] = slot.x - route.x[n]; ey[i] = slot.y + CROW_FOOT * size[i] - route.y[n]; ez[i] = slot.z - route.z[n]; perchRoost[i] = destRoost; perchOf[i] = slotIndex; }
    else {
      const c = o.canopy?.(route.x[n], route.z[n], 14, random());
      if (c) { ex[i] = c.x - route.x[n]; ey[i] = c.y - route.y[n]; ez[i] = c.z - route.z[n]; }
      else { ex[i] = (random() - .5) * 12; ey[i] = (random() - .5) * 3; ez[i] = (random() - .5) * 12; }
      perchOf[i] = perchRoost[i] = -1;
    }
  }

  /** A route from `from` to `to` in slot `r`. */
  function plan(r: number, dest: number, away: { x: number; z: number } | undefined, burst: boolean) {
    const perch = dest >= 0 && !!roosts[dest].perches?.length;
    const n = planWaypoints(waypoints, from, to, { heightAt: o.heightAt, cruise: 22 + random() * 16, away, bow: (random() - .5) * .34, burst, perch });
    buildRoute(routes[r], waypoints, n); routeDest[r] = dest; routePerch[r] = perch ? 1 : 0;
  }

  /** The flock leaves its roost for `dest`; startled, it goes all at once and hard, else in a loose stream. */
  function departFlock(dest: number, away: { x: number; z: number } | undefined, burst: boolean) {
    const r = freeRoute(); if (r < 0 || home < 0) return false;
    roostPoint(home, from);
    if (dest >= 0) roostPoint(dest, to);
    else if (away) { to.x = from.x + away.x * 230; to.z = from.z + away.z * 230; to.y = o.heightAt(to.x, to.z) + 18; }
    else return false;
    plan(r, dest, away, burst);
    const slots = dest >= 0 ? roosts[dest].perches : undefined, leaving = perched(home), seats = slots ? sitters(dest) : 0;
    let count = 0, clumpLeft = 0, clumpAt = now;
    const go = (i: number) => {
      // Startled, they are all off within a second; at dusk they go a few at a time, a couple of seconds apart.
      let t = now + random();
      if (!burst) { if (clumpLeft <= 0) { clumpAt += count ? 1.5 + random() * 2.2 : 0; clumpLeft = 1 + Math.floor(random() * 3); } clumpLeft--; t = clumpAt + random() * .8; }
      const spread = burst ? 7 : 4;
      launch(i, r, t, (random() - .5) * 2 * spread, (random() - .5) * (burst ? 6 : 3), burst, count < seats ? dest : -1, count < seats ? (count * 5) % slots!.length : -1);
      member[i] = 1; count++;
    };
    // The ones sitting in view go as they are; the rest of the flock is in the trees and comes out of them.
    for (let i = 0; i < N; i++) if (mode[i] === PERCH && routeOf[i] < 0 && perchRoost[i] === home) go(i);
    // A flock on a perch is only the birds sitting there: nothing comes out of the open air beside them.
    if (!roosts[home].perches?.length) for (let k = leaving; k < flockSize; k++) { const i = freeBird(); if (i < 0) break; go(i); }
    transit = count; home = dest;
    return count > 0;
  }

  function startle(onBurst: AmbientOptions['onBurst']) {
    if (home < 0 || transit > 0 || flockSize <= 0 || !player) return;
    const r = roosts[home];
    if (r.perches?.length && !perched(home)) return;
    let awayX = r.x - player.x, awayZ = r.z - player.z; const l = Math.hypot(awayX, awayZ);
    if (l < 1) { const a = random() * TAU; awayX = Math.cos(a); awayZ = Math.sin(a); } else { awayX /= l; awayZ /= l; }
    const dest = escapeTarget(roosts, home, player, random, ESCAPE_MIN), x = r.x, y = r.y, z = r.z;
    if (departFlock(dest, { x: awayX, z: awayZ }, true) && now - lastBurst > 20) { lastBurst = now; onBurst?.(x, y, z); }
  }

  /** One to four crows from one stand of trees to another, on a line that crosses the player's sky. */
  function commute() {
    if (!player) return false;
    const r = freeRoute(), pair = crossingPair(roosts, player, random, { minEnd: 110, minLength: 150, maxLength: 520, passMin: 12, passMax: 90, hiddenOnly: true });
    if (r < 0 || !pair) return false;
    roostPoint(pair[0], from); roostPoint(pair[1], to); plan(r, pair[1], undefined, false);
    const roll = random(), count = roll < .2 ? 1 : roll < .7 ? 2 : roll < .9 ? 3 : 4;
    for (let k = 0; k < count; k++) {
      const i = freeBird(); if (i < 0) break;
      launch(i, r, now + k * (.3 + random() * .9), (k - (count - 1) / 2) * (2.5 + random() * 2), (random() - .5) * 2, false);
      member[i] = 0;
    }
    return true;
  }

  /** Dusk (and dawn): the flock goes to its next roost in a loose stream that passes within sight. */
  function stream() {
    if (!player || transit > 0) return false;
    // A flock sitting in view leaves from where it sits; otherwise it is somewhere out of sight, on a line that crosses the sky.
    if (home >= 0 && perched(home) > 0 && !far(roosts[home].x, roosts[home].z, 250)) {
      let best = -1, bestScore = Infinity;
      for (let j = 0; j < roosts.length; j++) {
        if (j === home || !roosts[j].hidden) continue;
        const d = Math.hypot(roosts[j].x - roosts[home].x, roosts[j].z - roosts[home].z), score = Math.abs(d - 190) + random() * 40;
        if (d >= 120 && d <= 280 && score < bestScore) { bestScore = score; best = j; }
      }
      return best >= 0 && departFlock(best, undefined, false);
    }
    const pair = crossingPair(roosts, player, random, { minEnd: 100, minLength: 130, maxLength: 270, passMin: 8, passMax: 90, hiddenOnly: true });
    if (!pair) return false;
    // Out of sight, the resting flock is wherever the line starts (any it had sitting are far off, past 250 m).
    for (let i = 0; i < N; i++) if (mode[i] === PERCH && routeOf[i] < 0) unseat(i);
    home = pair[0];
    return departFlock(pair[1], undefined, false);
  }

  function housekeep(darkness: number) {
    if (!player) return;
    if (darkness >= NIGHT) wasNight = true;
    if (darkness < .01) { wasNight = false; streamedDusk = false; streamedDawn = false; }
    if (darkness >= LATE) return;
    if (!started) {
      // The first roost: anything not right on top of the player (at the start that is the cabin, 42 m from the spawn),
      // seated at once, before anything has been drawn.
      started = true;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < roosts.length; i++) { const d = Math.hypot(roosts[i].x - player.x, roosts[i].z - player.z); if (d >= 30 && d < bestD) { bestD = d; best = i; } }
      home = best; seat();
      // Rare, a small extra and never a fixture overhead: the first crossing two to four minutes in, then one every three to five
      // (about three in the twelve minutes of a game day at the normal pace).
      nextCommute = now + 120 + random() * 120;
    } else if (transit === 0 && (home < 0 || far(roosts[home].x, roosts[home].z, 150))) {
      // Far from its roost: the flock is somewhere nearer the player instead, swapped only where nobody is looking.
      const next = homeNear(roosts, player, home, 70, 110), sitting = home >= 0 ? perched(home) : 0;
      if (next >= 0 && (sitting === 0 || !seen(roosts[home].x, roosts[home].y, roosts[home].z) || far(roosts[home].x, roosts[home].z, 200))) {
        for (let i = 0; i < N; i++) if (mode[i] === PERCH && routeOf[i] < 0) unseat(i);
        home = next;
      }
    }
    const slots = home >= 0 ? roosts[home].perches : undefined;
    if (slots?.length && transit === 0 && perched(home) < sitters(home) && (!seen(roosts[home].x, roosts[home].y, roosts[home].z) || far(roosts[home].x, roosts[home].z, 110))) seat();
    if (!wasNight && darkness >= DUSK && !streamedDusk) streamedDusk = stream() || darkness > .2;
    if (wasNight && !streamedDawn) streamedDawn = stream() || true;
    if (darkness < DUSK && now >= nextCommute) { commute(); nextCommute = now + 180 + random() * 120; }
  }

  function land(i: number) {
    const r = routeOf[i];
    if (r >= 0) routeUsers[r]--;
    if (member[i]) { member[i] = 0; transit = Math.max(0, transit - 1); }
    routeOf[i] = -1;
    const slot = slotOf(i);
    if (r >= 0 && routePerch[r] && slot && routeDest[r] === home) {
      mode[i] = PERCH; yaw[i] = Math.atan2(fx[i], fz[i]); hopAt[i] = now + 3 + random() * 10; hop[i] = 0;
      px[i] = slot.x; py[i] = slot.y + CROW_FOOT * size[i]; pz[i] = slot.z;
    } else unseat(i);
  }

  function updateCrows(f: AmbientFrame) {
    const { time, dt, darkness } = f;
    player = f.player; view = f.view; now = time;
    if (!roosts.length || dt < 1e-4) return;
    if (time >= housekeepAt) { housekeep(darkness); housekeepAt = time + 1; }
    if (home >= 0 && transit === 0 && darkness < LATE && (player.x - roosts[home].x) ** 2 + (player.z - roosts[home].z) ** 2 < BURST_RADIUS * BURST_RADIUS) startle(o.onBurst);
    const step = Math.min(dt, .05), kv = 1 - Math.exp(-step / .12), ka = 1 - Math.exp(-step / .3), kf = 1 - Math.exp(-step * 9);
    let drawn = 0;
    for (let i = 0; i < N; i++) {
      if (mode[i] === IDLE) continue;
      // After dark the birds are gone: out of view or far off at once, and every one of them once it is properly night.
      if (darkness >= NIGHT && (darkness > .72 || !seen(px[i], py[i], pz[i]) || far(px[i], pz[i], 90))) {
        if (routeOf[i] >= 0) routeUsers[routeOf[i]]--;
        if (member[i]) { member[i] = 0; transit = Math.max(0, transit - 1); }
        routeOf[i] = -1; unseat(i); continue;
      }
      let x = px[i], y = py[i], z = pz[i], tfx: number, tfy: number, tfz: number, tux = 0, tuy = 1, tuz = 0, s = 1;
      if (mode[i] === PERCH && routeOf[i] >= 0 && time >= leave[i]) { mode[i] = FLY; speed[i] = startled[i] ? 2.5 : 1.5; amp[i] = Math.max(amp[i], .6); }
      if (mode[i] === PERCH) {
        // Sitting: wings folded; now and then it hops round to face another way.
        if (time >= hopAt[i]) { hopAt[i] = time + 6 + random() * 14; yaw[i] += (random() < .5 ? -1 : 1) * (.6 + random() * 1.6); hop[i] = .35; }
        const slot = slotOf(i);
        if (slot) { x = slot.x; y = slot.y + CROW_FOOT * size[i]; z = slot.z; }
        if (hop[i] > 0) { hop[i] = Math.max(0, hop[i] - step); y += .06 * Math.sin(Math.PI * hop[i] / .35); }
        tfx = Math.sin(yaw[i]); tfy = 0; tfz = Math.cos(yaw[i]);
        fold[i] = Math.min(1, fold[i] + step / .35); amp[i] *= 1 - kv; lift[i] *= 1 - kv;
        phase[i] = 0;
      } else {
        if (time < leave[i]) continue;
        const r = routeOf[i], route = routes[r], L = route.length, perch = routePerch[r] === 1;
        // Speed: up to cruising in a few seconds (hard if startled), braking on the way in so it arrives slow.
        const vEnd = perch ? 1.6 : 4.5, cap = Math.sqrt(vEnd * vEnd + 2 * 2.6 * Math.max(0, L - dist[i])), target = Math.min(cruise[i], cap);
        speed[i] += Math.min(Math.max(target - speed[i], -4.5 * step), (startled[i] ? 7 : 3.5) * step);
        dist[i] += speed[i] * step;
        if (dist[i] >= L) { land(i); if (mode[i] !== PERCH) continue; x = px[i]; y = py[i]; z = pz[i]; tfx = fx[i]; tfy = 0; tfz = fz[i]; }
        else {
          const left = L - dist[i];
          cursor[i] = routeAt(route, dist[i], at, cursor[i]); routeAt(route, dist[i] + 2, ahead, cursor[i]);
          let tx = ahead.x - at.x, tz = ahead.z - at.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
          // Each bird holds its own place beside the line (with a slow wander), blending in from its perch or crown and out
          // to its landing spot.
          const ws = smooth(dist[i], 0, 16), we = 1 - smooth(left, 0, 26), held = ws * (1 - we);
          const lat = latOff[i] + 1.3 * Math.sin(time * .37 + wob[i] * 6), up = upOff[i] + .7 * Math.sin(time * .29 + wob[i] * 9);
          x = at.x + sx[i] * (1 - ws) - tz * lat * held + ex[i] * we;
          y = at.y + sy[i] * (1 - ws) + up * held + ey[i] * we;
          z = at.z + sz[i] * (1 - ws) + tx * lat * held + ez[i] * we;
          // It comes out of the crown and drops back into one: drawn small while inside the leaves.
          s = (emerge[i] ? smooth(dist[i], 0, 5) : 1) * (perch ? 1 : 1 - smooth(dist[i], L - 4, L));
          // Wingbeat: hard while climbing out, flap-flap-glide when cruising, wings set in a shallow V dropping in to land,
          // then a few braking beats.
          const climbing = startled[i] ? dist[i] < 70 : dist[i] < 25, landing = left < 32;
          let rate = beatRate[i], ampT = .92, liftT = .03;
          if (climbing) { rate = startled[i] ? 5.6 : 4.6; ampT = startled[i] ? 1.15 : 1; liftT = .04; glide[i] = 0; }
          else if (landing) {
            if (left > (perch ? 6 : 10)) { ampT = 0; liftT = perch ? .22 : .34; }
            else { ampT = perch ? .85 : .6; liftT = .14; rate = 5; }
          } else if (glide[i] > 0) { glide[i] -= step; ampT = 0; liftT = .1; }
          phase[i] += step * rate * TAU;
          if (phase[i] >= TAU) {
            phase[i] -= TAU;
            if (!climbing && !landing && glide[i] <= 0 && --beats[i] <= 0) { beats[i] = 3 + Math.floor(random() * 6); if (vy[i] < 1) glide[i] = .45 + random() * 1.1; }
          }
          amp[i] += (ampT - amp[i]) * (1 - Math.exp(-step / .1)); lift[i] += (liftT - lift[i]) * (1 - Math.exp(-step / .25));
          fold[i] = perch && left < 1.2 ? Math.min(1, fold[i] + step / .35) : Math.max(0, fold[i] - step / (startled[i] ? .16 : .3));
          // Heading follows the velocity (the way it sat, until it is moving); the body banks with the turn, so its up is
          // along lift: gravity's opposite plus whatever is bending its path. A flare pitches it up as it brakes onto a perch.
          const nvx = (x - px[i]) / step, nvy = (y - py[i]) / step, nvz = (z - pz[i]) / step;
          const ovx = vx[i], ovy = vy[i], ovz = vz[i];
          vx[i] += (nvx - vx[i]) * kv; vy[i] += (nvy - vy[i]) * kv; vz[i] += (nvz - vz[i]) * kv;
          ax[i] += ((vx[i] - ovx) / step - ax[i]) * ka; ay[i] += ((vy[i] - ovy) / step - ay[i]) * ka; az[i] += ((vz[i] - ovz) / step - az[i]) * ka;
          const v = Math.hypot(vx[i], vy[i], vz[i]), moving = smooth(v, .6, 3);
          tfx = Math.sin(yaw[i]) * (1 - moving); tfy = 0; tfz = Math.cos(yaw[i]) * (1 - moving);
          if (v > 1e-3) { tfx += vx[i] / v * moving; tfy += vy[i] / v * moving; tfz += vz[i] / v * moving; }
          const h = Math.hypot(tfx, tfz) || 1e-3;
          tfy = Math.min(.6, Math.max(-.55, tfy / h)) * h + (perch ? .45 * (1 - smooth(left, 0, 9)) * h : 0);
          const fl = Math.hypot(tfx, tfy, tfz) || 1; tfx /= fl; tfy /= fl; tfz /= fl;
          const along = ax[i] * tfx + ay[i] * tfy + az[i] * tfz;
          let lx = ax[i] - tfx * along, ly = ay[i] - tfy * along, lz = az[i] - tfz * along; const ll = Math.hypot(lx, ly, lz);
          if (ll > 6) { lx *= 6 / ll; ly *= 6 / ll; lz *= 6 / ll; }
          tux = lx; tuy = ly + 9.81; tuz = lz;
        }
      }
      px[i] = x; py[i] = y; pz[i] = z; scale[i] = s;
      // Ease the frame towards the targets and rebuild it square: right = up x forward, up = forward x right.
      fx[i] += (tfx - fx[i]) * kf; fy[i] += (tfy - fy[i]) * kf; fz[i] += (tfz - fz[i]) * kf;
      const tl = Math.hypot(tux, tuy, tuz) || 1;
      ux[i] += (tux / tl - ux[i]) * kf; uy[i] += (tuy / tl - uy[i]) * kf; uz[i] += (tuz / tl - uz[i]) * kf;
      const fl = Math.hypot(fx[i], fy[i], fz[i]) || 1, Fx = fx[i] / fl, Fy = fy[i] / fl, Fz = fz[i] / fl;
      let Rx = uy[i] * Fz - uz[i] * Fy, Ry = uz[i] * Fx - ux[i] * Fz, Rz = ux[i] * Fy - uy[i] * Fx; const rl = Math.hypot(Rx, Ry, Rz) || 1; Rx /= rl; Ry /= rl; Rz /= rl;
      const Ux = Fy * Rz - Fz * Ry, Uy = Fz * Rx - Fx * Rz, Uz = Fx * Ry - Fy * Rx;
      const S = size[i] * Math.max(.02, s), m = drawn * 16;
      matrix[m] = Rx * S; matrix[m + 1] = Ry * S; matrix[m + 2] = Rz * S; matrix[m + 3] = 0;
      matrix[m + 4] = Ux * S; matrix[m + 5] = Uy * S; matrix[m + 6] = Uz * S; matrix[m + 7] = 0;
      matrix[m + 8] = Fx * S; matrix[m + 9] = Fy * S; matrix[m + 10] = Fz * S; matrix[m + 11] = 0;
      matrix[m + 12] = x; matrix[m + 13] = y; matrix[m + 14] = z; matrix[m + 15] = 1;
      const b = drawn * 4; birdData[b] = phase[i]; birdData[b + 1] = amp[i]; birdData[b + 2] = fold[i]; birdData[b + 3] = lift[i];
      drawn++;
    }
    crows.count = drawn; crows.visible = drawn > 0;
    if (drawn) { crows.instanceMatrix.needsUpdate = true; birdAttribute.needsUpdate = true; }
  }

  // --- chimney smoke ---------------------------------------------------------------------------
  const P = o.puffs ?? 64, smokeSeed = new Float32Array(P * 4);
  for (let i = 0; i < P; i++) smokeSeed.set([i / P + random() * .02, random(), random(), 0], i * 4);
  const smokeGeometry = new THREE.BufferGeometry();
  smokeGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P * 3), 3)); smokeGeometry.setAttribute('aSeed', new THREE.BufferAttribute(smokeSeed, 4));
  const smokeUniforms = { uTime: { value: 0 }, uScale: { value: 700 }, uHeight: { value: 34 }, uAlpha: { value: 0 }, uTint: { value: new THREE.Color(.5, .54, .57) } };
  const smokeMaterial = new THREE.ShaderMaterial({
    uniforms: smokeUniforms, transparent: true, depthWrite: false,
    vertexShader: `
      attribute vec4 aSeed;uniform float uTime,uScale,uHeight,uAlpha;varying float vA;
      void main(){
        float age=fract(uTime*.045+aSeed.x);
        // Almost no wind: a thin line that climbs far too straight and too high, and thickens in slow pulses.
        float sway=.4*age*age;
        vec3 p=vec3(sin(age*7.+aSeed.z*6.283)*sway,age*uHeight,cos(age*5.+aSeed.z*4.)*sway);
        vec4 mv=modelViewMatrix*vec4(p,1.);float d=-mv.z;
        float width=mix(.34,1.2,pow(age,.7))*(.8+aSeed.y*.4);
        vA=uAlpha*smoothstep(0.,.06,age)*pow(1.-age,1.4)*(.62+.38*sin(age*11.-uTime*.55))*smoothstep(1.5,5.,d);
        gl_PointSize=clamp(width*uScale/max(d,.1),1.,220.);
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader: `uniform vec3 uTint;varying float vA;void main(){float r=length(gl_PointCoord-.5)*2.;gl_FragColor=vec4(uTint,(1.-smoothstep(.15,1.,r))*vA*.5);}`,
  });
  const smoke = new THREE.Points(smokeGeometry, smokeMaterial); smoke.name = 'Chimney smoke'; smoke.frustumCulled = false; smoke.visible = false;
  if (o.chimney) { smoke.position.copy(o.chimney); group.add(smoke); }
  const dayTint = new THREE.Color(.5, .54, .57), duskTint = new THREE.Color(.17, .19, .23);
  function updateSmoke(f: AmbientFrame) {
    const alpha = 1 - smooth(f.darkness, .55, .9);
    smoke.visible = !!o.chimney && alpha > .01;
    if (!smoke.visible) return;
    smokeUniforms.uTime.value = f.time; smokeUniforms.uScale.value = f.viewScale; smokeUniforms.uAlpha.value = alpha;
    smokeUniforms.uTint.value.copy(dayTint).lerp(duskTint, smooth(f.darkness, .05, .6));
  }

  return {
    /** Per frame; no allocation, and a frame costs a few microseconds by day and nothing for the crows at night. */
    update(f: AmbientFrame) { updateCrows(f); updateSmoke(f); },
    /** Frighten the flock as if the player had walked up to its roost (dev staging). */
    startle() { startle(o.onBurst); },
    objects: { crows, smoke },
    stats() {
      let airborne = 0, sitting = 0;
      for (let i = 0; i < N; i++) { if (mode[i] === FLY && now >= leave[i]) airborne++; else if (mode[i] === PERCH) sitting++; }
      return { crowsVisible: crows.visible, airborne, perched: sitting, home, transit, smokeVisible: smoke.visible, draws: [crows, smoke].filter(m => m.visible).length };
    },
    /** Dev staging: send a few crows across the player's sky now, or the flock off on its dusk stream. */
    commute: () => commute(),
    stream: () => stream(),
    /** Dev staging: every crow back in the trees and the flock unplaced, as when the world was built. */
    reset() {
      mode.fill(IDLE); routeOf.fill(-1); perchOf.fill(-1); perchRoost.fill(-1); member.fill(0); routeUsers.fill(0);
      home = -1; transit = 0; started = false; streamedDusk = streamedDawn = wasNight = false; housekeepAt = 0; lastBurst = -Infinity;
      crows.count = 0; crows.visible = false;
    },
    /** Dev: where every drawn crow is (allocates). */
    birds() {
      const out: { x: number; y: number; z: number; mode: string; scale: number }[] = [];
      for (let i = 0; i < N; i++) if (mode[i] !== IDLE && (mode[i] === PERCH || now >= leave[i])) out.push({ x: px[i], y: py[i], z: pz[i], mode: mode[i] === PERCH ? 'perch' : 'fly', scale: scale[i] });
      return out;
    },
    dispose() {
      scene.remove(group); crows.dispose(); crowGeometry.dispose(); crowMaterial.dispose(); smokeGeometry.dispose(); smokeMaterial.dispose();
    },
  };
}

export type AmbientLife = ReturnType<typeof createAmbientLife>;
