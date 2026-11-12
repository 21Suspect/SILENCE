import * as THREE from 'three';
import { Parts, TRUNK_SEGMENTS, card, random, ringTrunk, smooth, tube, v3, type SprayRect } from './tree-parts';

/**
 * The forest's conifers, grown from a seed: Scots pine and Norway spruce. Each seed gives a different tree (lean, crown base
 * and width, whorl spacing, branch count, length, angle and droop, missing and dead limbs, foliage density, tint), so a stand
 * reads as many trees, not one tree turned.
 *
 * Foliage is photographed needle sprays on cards, cut from the twig atlases of Poly Haven's pine_tree_01 and fir_tree_01
 * (CC0, Rico Cilliers and Rob Tuytel; public/world/trees/attribution.json), placed along modelled branches the way the
 * species carries them: a spruce in whorls from low on the trunk, its branches drooping and turning up at the tips, sprays
 * all along them; a pine on a tall clear bole, upswept limbs ending in tufts. Card normals lean out from the trunk and the
 * cards inside the crown are darkened (vertex colour), so the crown lights as a volume and holds its own shade.
 *
 * The trunk keeps the ring layout the rest of the forest relies on (TRUNK_RINGS x TRUNK_SEGMENTS first in the geometry: the
 * ground under each tree is sampled from the base ring, and the creature's bark contact walks the rings). Below the rings sit
 * buttress lobes and surface roots that dive into the soil, so a trunk grows out of the ground instead of standing on it.
 */
export { TRUNK_RINGS, TRUNK_SEGMENTS } from './tree-parts';
export type ConiferSpecies = 'pine' | 'spruce';
/** Sprays in the 2048 px twig atlases: x, y, width, height, and whether the spray lies sideways (stem at the left). */
const SPRAYS: Record<ConiferSpecies, readonly SprayRect[]> = {
  pine: [[72, 90, 378, 815, false], [1334, 701, 584, 360, true]],
  spruce: [[626, 819, 694, 769, false], [1299, 926, 662, 774, false], [1336, 82, 585, 673, false], [387, 95, 491, 543, false], [1010, 532, 282, 287, false], [792, 592, 149, 191, false]],
};

export type Conifer = {
  trunk: THREE.BufferGeometry; farTrunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry; farCrown: THREE.BufferGeometry;
  /** Height of the lowest live branch, in model units (the tree is 31 tall). */
  crownBase: number;
  /** Bark radius a metre and a half up, in model units: the collider. */
  boleRadius: number;
};

export function buildConifer(species: ConiferSpecies, seed: number): Conifer {
  const rnd = random(seed * 7919 + (species === 'pine' ? 11 : 23)), pick = <T,>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const H = 31, phase = rnd() * Math.PI * 2;
  // The tree's own character.
  const lean = (rnd() - .5) * .9, curve = .3 + rnd() * .6, lobes = 4 + Math.floor(rnd() * 3);
  const pine = species === 'pine';
  const crownBase = pine ? H * (.5 + rnd() * .16) : 2 + rnd() * 4.5;
  const crownWidth = pine ? 3.4 + rnd() * 1.6 : 3.2 + rnd() * 1.4;
  const density = .8 + rnd() * .4, droop = pine ? 0 : .55 + rnd() * .6;
  const axis = (y: number) => v3(Math.sin(y * .045 + phase) * curve * y / H + lean * Math.pow(y / H, 2), y, Math.sin(y * .06 + phase) * curve * .6 * y / H);
  const radiusAt = (y: number) => .44 * Math.pow(Math.max(0, 1 - y / 33), .72) + .5 * Math.exp(-y * 2.6);
  const wood = new Parts(), farWood = new Parts(), crown = new Parts(), farCrown = new Parts();

  // ---- Trunk: the ring layout first (see the module comment), with buttress lobes at the foot. The lobes are broad swells
  // ((1 + cos)/2 squared, about a third of the way round each): a sharper cos^3 peak spanned one of the 16 segments and
  // stood out of the ground as a flat fin.
  const buttressAt = (y: number, a: number) => Math.exp(-y * 2.4) * Math.pow(.5 + .5 * Math.cos(a * lobes + phase), 2.2) * .5;
  for (const out of [wood, farWood]) ringTrunk(out, axis,
    (y, a) => radiusAt(y) * (1 + .09 * Math.sin(a * 5 + phase) + .03 * Math.sin(y * 2 + a * 7)) + buttressAt(y, a), 2.2,
    (y, a) => {
      // Damp, darker and mossier near the ground and on one side; occluded where the lobes meet.
      const moss = Math.max(0, 1 - y / (1.3 + .7 * Math.sin(a * 2 + phase))) * (.55 + .45 * Math.cos(a - phase));
      const ao = .62 + .38 * smooth(y, 0, 1.4) + buttressAt(y, a) * .3;
      return [ao * (.9 - moss * .18), ao * (.88 - moss * .06), ao * (.8 - moss * .22)];
    });
  // Surface roots along the lobes: out from the foot, arching once and diving under the soil.
  for (let k = 0; k < lobes + 2; k++) {
    const a = (k < lobes ? (k * 2 * Math.PI - phase) / lobes : rnd() * Math.PI * 2) + (rnd() - .5) * .3;
    const reach = (k < lobes ? 1.2 : .7) + rnd() * .9, thick = (k < lobes ? .17 : .1) * (.8 + rnd() * .4), wander = (rnd() - .5) * .5;
    const dir = v3(Math.cos(a), 0, Math.sin(a)), sideDir = v3(-dir.z, 0, dir.x);
    const index = ((Math.round(a / (Math.PI * 2) * TRUNK_SEGMENTS) % TRUNK_SEGMENTS) + TRUNK_SEGMENTS) % TRUNK_SEGMENTS;
    tube(wood, t => v3().addScaledVector(dir, .3 + reach * t).addScaledVector(sideDir, wander * t * t).setY(.42 * Math.pow(1 - t, 1.7) + .05 * Math.sin(t * Math.PI) - .28 * t * t - .06),
      t => thick * Math.pow(1 - t, 1.2) + .025, 6, 6, index, 1, t => .55 + .25 * t);
  }

  // ---- Crown. The light at a point in it: outer and upper cards bright, inner and lower ones shaded; normals lean outward.
  const top = H + .5, mid = (crownBase + top) * .5;
  const reachAt = (y: number) => pine ? crownWidth * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, (y - crownBase) / (top - crownBase)))), .7) + .4
    : crownWidth * Math.pow(Math.max(0, (top - y) / (top - crownBase)), .92) + .3;
  const normal = v3();
  const light = (p: THREE.Vector3): [number, THREE.Vector3] => {
    const c = axis(p.y), dx = p.x - c.x, dz = p.z - c.z, r = Math.hypot(dx, dz), outer = Math.min(1, r / Math.max(.5, reachAt(p.y)));
    const height = smooth(p.y, crownBase - 1, top);
    normal.set(dx / Math.max(r, .01) * .8, .45 + .35 * height + (p.y - mid) / (top - crownBase) * .3, dz / Math.max(r, .01) * .8).normalize();
    return [(.38 + .62 * Math.pow(outer, .8)) * (.82 + .18 * height), normal.clone()];
  };
  const sprays = SPRAYS[species];
  const branchList: { start: THREE.Vector3; path: (t: number) => THREE.Vector3; length: number; dir: THREE.Vector3; live: boolean }[] = [];
  if (pine) {
    // Irregular whorls of upswept limbs on the upper bole, each forking into a few shoots that end in tufts.
    const count = Math.round((26 + rnd() * 10) * density);
    for (let j = 0; j < count; j++) {
      const k = (j + rnd() * .6) / count, y = crownBase + k * (top - 1.2 - crownBase), a = j * 2.399963 + phase + (rnd() - .5) * .9;
      const length = Math.max(.6, reachAt(y) * (.75 + rnd() * .4)), rise = .35 + k * .35 + rnd() * .3;
      const dir = v3(Math.cos(a), 0, Math.sin(a)), s = axis(y).addScaledVector(dir, radiusAt(y) * .9);
      const path = (t: number) => s.clone().addScaledVector(dir, length * t).setY(s.y + length * (rise * t - .18 * t * t));
      branchList.push({ start: s, path, length, dir, live: true });
      for (let f = 0; f < 2 + Math.floor(rnd() * 2); f++) {
        const from = .45 + rnd() * .4, o = path(from), fa = a + (rnd() - .5) * 1.6, fdir = v3(Math.cos(fa), 0, Math.sin(fa)), fl = length * (.35 + rnd() * .3);
        branchList.push({ start: o, path: t => o.clone().addScaledVector(fdir, fl * t).setY(o.y + fl * (.5 * t - .1 * t * t)), length: fl, dir: fdir, live: true });
      }
    }
    // Dead stubs down the bole: a Scots pine self-prunes, but the stubs stay for years.
    for (let j = 0; j < 9; j++) {
      const y = 3 + rnd() * (crownBase - 4), a = rnd() * Math.PI * 2, dir = v3(Math.cos(a), 0, Math.sin(a)), s = axis(y).addScaledVector(dir, radiusAt(y) * .9), l = .2 + rnd() * .7;
      branchList.push({ start: s, path: t => s.clone().addScaledVector(dir, l * t).setY(s.y + l * (.1 * t - .3 * t * t)), length: l, dir, live: false });
    }
  } else {
    // Whorls every 0.45 to 0.8 m from the crown base to the leader; 4 to 6 limbs each, drooping in the middle of the crown
    // and turning up at the tips; a few missing, a few short and dead low down.
    for (let y = crownBase; y < top - .6; y += .45 + rnd() * .35) {
      const n = 4 + Math.floor(rnd() * 3), twist = rnd() * Math.PI * 2;
      for (let j = 0; j < n; j++) {
        if (rnd() > .9 * density + .1) continue;
        const a = twist + j / n * Math.PI * 2 + (rnd() - .5) * .5, k = (y - crownBase) / (top - crownBase);
        const length = Math.max(.35, reachAt(y) * (.8 + rnd() * .35)), sag = droop * (1 - k) * (.6 + rnd() * .6);
        const dir = v3(Math.cos(a), 0, Math.sin(a)), s = axis(y).addScaledVector(dir, radiusAt(y) * .9);
        const path = (t: number) => s.clone().addScaledVector(dir, length * t).setY(s.y + length * (.05 * t - sag * t * t + sag * .9 * Math.pow(t, 4) + .12 * k * t));
        branchList.push({ start: s, path, length, dir, live: true });
      }
    }
    for (let j = 0; j < 12; j++) {
      const y = 2.2 + rnd() * Math.max(.5, crownBase - 2.2), a = rnd() * Math.PI * 2, dir = v3(Math.cos(a), 0, Math.sin(a)), s = axis(y).addScaledVector(dir, radiusAt(y) * .9), l = .3 + rnd() * .8;
      branchList.push({ start: s, path: t => s.clone().addScaledVector(dir, l * t).setY(s.y + l * (-.12 * t - .3 * t * t)), length: l, dir, live: false });
    }
  }
  // ---- Wood for the limbs, then the sprays along them.
  const across = v3(), along = v3(), up = v3(0, 1, 0), tangent = v3();
  for (const b of branchList) {
    // Limbs taper from a few centimetres at the trunk: a 4 m spruce limb is about 12 cm thick at its base.
    // Dead limbs are thinner, bark long gone: they read as grey sticks, not spears.
    const r0 = b.live ? .016 + b.length * (pine ? .015 : .012) : .009 + b.length * .007;
    tube(wood, b.path, t => r0 * (1 - t * (b.live ? .8 : .9)), 5, b.length > 1.5 ? 4 : 2, 0, b.length < 1.2 ? 1 : 0, () => b.live ? .85 : .72);
    if (b.length > 1.8) tube(farWood, b.path, t => r0 * (1 - t * .7), 3, 2, 0, 0, () => .8);
    if (!b.live) continue;
    const spacing = pine ? .16 : .2 / density;
    const from = pine ? .55 : .1;
    for (let t = from; t <= 1.001; t += spacing / b.length) {
      const p = b.path(Math.min(1, t));
      tangent.subVectors(b.path(Math.min(1, t + .02)), b.path(Math.max(0, t - .02))).normalize();
      // A card stands for a branchlet with its sprays, 0.5 to 0.95 m: photographed sprays are about 70% air, so smaller
      // cards left the crowns reading as bare limbs even at 5,000 cards a tree.
      const sprayRect = pick(sprays), size = (pine ? .62 + rnd() * .33 : .52 + rnd() * .3) * (1 - (t - from) * .22);
      const shoots = pine ? 3 + Math.floor(rnd() * 3) : 2 + (rnd() < .45 ? 1 : 0);
      for (let s = 0; s < shoots; s++) {
        if (pine) {
          // A tuft: shoots fan out round the limb's direction and up.
          const yaw = (rnd() - .5) * 2.2, pitch = .2 + rnd() * .9;
          along.copy(tangent).applyAxisAngle(up, yaw).lerp(up, pitch * .5).normalize();
        } else {
          // Branchlets off both sides of the limb, roughly flat, drooping a little; a third lies along the top of it.
          const sideways = s === 2 ? (rnd() - .5) * .4 : (s === 0 ? 1 : -1) * (.5 + rnd() * .55);
          along.copy(tangent).applyAxisAngle(up, sideways).setY(along.y - .1 - rnd() * .15).normalize();
        }
        across.crossVectors(up, along).normalize().applyAxisAngle(along, (rnd() - .5) * (pine ? 2.4 : .7));
        card(crown, p, along, across, size, sprayRect, pine ? -.08 : .14, 2, light);
        if (rnd() < (pine ? .32 : .3)) card(farCrown, p, along, across, size * 1.55, sprayRect, pine ? -.06 : .1, 1, light);
      }
    }
    // The tip of every spruce limb carries a leading spray straight out along it.
    if (!pine) { const p = b.path(1); tangent.subVectors(b.path(1), b.path(.95)).normalize(); across.crossVectors(up, tangent).normalize(); card(crown, p, tangent, across, .3, pick(sprays), .1, 2, light); }
  }
  // The leader: a spruce's spire, a pine's last tuft.
  {
    const p = axis(top - .8);
    for (let s = 0; s < 4; s++) { along.set(Math.cos(s * 1.57 + phase) * .25, 1, Math.sin(s * 1.57 + phase) * .25).normalize(); across.crossVectors(up, along).normalize(); if (across.lengthSq() < .01) across.set(1, 0, 0); card(crown, p, along, across, .7, sprays[0], .05, 2, light); card(farCrown, p, along, across, .9, sprays[0], .05, 1, light); }
  }
  // Each tree its own green: spruce bluer and darker, pine lighter and warmer.
  const tint = pine ? [.98 + rnd() * .08, 1, .9 + rnd() * .08] : [.9 + rnd() * .06, .96 + rnd() * .06, .95 + rnd() * .08];
  for (const parts of [crown, farCrown]) for (let i = 0; i < parts.c.length; i += 3) { parts.c[i] *= tint[0]; parts.c[i + 1] *= tint[1]; parts.c[i + 2] *= tint[2]; }
  const trunk = wood.geometry(false), farTrunk = farWood.geometry(false);
  return { trunk, farTrunk, crown: crown.geometry(true, 0), farCrown: farCrown.geometry(true, 1), crownBase, boleRadius: radiusAt(1.5) };
}

/** Several trees per species: the forest picks one by each tree's seed. */
export function buildConiferVariants(species: ConiferSpecies, count: number) {
  return Array.from({ length: count }, (_, i) => buildConifer(species, i + 1));
}
