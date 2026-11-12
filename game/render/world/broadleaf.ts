import * as THREE from 'three';
import { Parts, TRUNK_SEGMENTS, card, random, ringTrunk, smooth, tube, v3, type SprayRect } from './tree-parts';

/**
 * The forest's broadleaf trees, grown from a seed: English oak and silver birch, as conifer.ts grows the pines and spruces.
 * Each seed is its own tree (lean, fork height, limb count, reach and wander, crown shape, density, tint).
 *
 * The wood is a real branching structure, limb to branch to twig, and the foliage sits where a tree carries it: leaf
 * sprays (tools/assets/trees/sprays.py composes them from scanned leaves) in clumps round the ends of the twigs. An oak forks
 * low into a few heavy, wandering limbs and holds its leaves out flat in dense clouds; a birch keeps one slender white
 * leader, its branches climb and then arch over, and its fine twigs hang in curtains.
 *
 * The trunk keeps the forest's ring layout (tree-parts.ts ringTrunk); above an oak's fork the rings follow its leading limb.
 */
export type BroadleafSpecies = 'birch' | 'oak';
export type Broadleaf = {
  trunk: THREE.BufferGeometry; farTrunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry; farCrown: THREE.BufferGeometry;
  /** Height of the lowest live branch, in model units (the tree is 31 tall). */
  crownBase: number;
  /** Bark radius a metre and a half up, in model units: the collider. */
  boleRadius: number;
};

/** The four sprays of each species' 2048 atlas, a 1024 cell each, stem at the bottom centre. */
const CELLS: readonly SprayRect[] = [[0, 0, 1024, 1024, false], [1024, 0, 1024, 1024, false], [0, 1024, 1024, 1024, false], [1024, 1024, 1024, 1024, false]];

/** A limb, branch or twig (depth 0, 1, 2); `ring` for the oak's leading limb, which the ring trunk already draws. */
type Limb = { path: (t: number) => THREE.Vector3; length: number; r0: number; r1: number; depth: number; live: boolean; ring?: boolean };

export function buildBroadleaf(species: BroadleafSpecies, seed: number): Broadleaf {
  const rnd = random(seed * 6151 + (species === 'oak' ? 37 : 53)), range = (a: number, b: number) => a + rnd() * (b - a);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const oak = species === 'oak', H = 31, phase = rnd() * Math.PI * 2;
  const wood = new Parts(), farWood = new Parts(), crown = new Parts(), farCrown = new Parts();
  const lean = v3(Math.cos(phase), 0, Math.sin(phase)).multiplyScalar(oak ? range(.3, 1.4) : range(.2, 1.1));
  const wobble = range(.15, .45);

  // ---- The stem: an oak's bole to its fork and then its leading limb; a birch's leader all the way up.
  const fork = oak ? range(5.5, 9.5) : H;
  const boleR = oak ? range(.72, .9) : range(.24, .3);
  const axis = (y: number) => {
    const k = y / H, above = Math.max(0, y - fork) / (H - fork + 1e-6);
    return v3(lean.x * k * k + Math.sin(y * .21 + phase) * wobble * k + (oak ? lean.x * above * 1.6 : 0), y,
      lean.z * k * k + Math.sin(y * .17 + phase * 1.7) * wobble * k + (oak ? lean.z * above * 1.6 : 0));
  };
  const radiusAt = (y: number) => {
    if (!oak) return boleR * Math.pow(Math.max(0, 1 - y / 32.5), .85) + .03 + .22 * Math.exp(-y * 3);
    // Past the fork the leader carries about half the bole; the limbs that leave there hide the step.
    const bole = boleR * (1 - .2 * y / fork), leader = boleR * .52 * Math.pow(Math.max(0, 1 - (y - fork) / (H + .5 - fork)), .9) + .035;
    return bole + (leader - bole) * smooth(y, fork - 1, fork + 1.5) + .5 * Math.exp(-y * 2.2);
  };
  const lobes = oak ? 5 + Math.floor(rnd() * 3) : 3 + Math.floor(rnd() * 2);
  const buttressAt = (y: number, a: number) => Math.exp(-y * (oak ? 2 : 3)) * Math.pow(.5 + .5 * Math.cos(a * lobes + phase), 2.2) * (oak ? .62 : .22);
  // A birch's bark goes black and fissured round its foot, up to a metre or two and higher on one side.
  const blackFoot = (y: number, a: number) => oak ? 0 : 1 - smooth(y, .6 + 1.2 * (.5 + .5 * Math.sin(a + phase)), 2 + 1.5 * (.5 + .5 * Math.sin(a * 2 + phase)));
  for (const out of [wood, farWood]) ringTrunk(out, axis,
    (y, a) => radiusAt(y) * (1 + (oak ? .07 : .03) * Math.sin(a * 5 + phase) + .03 * Math.sin(y * 1.3 + a * 7)) + buttressAt(y, a), oak ? 3 : 2,
    (y, a) => {
      const moss = Math.max(0, 1 - y / (1.2 + .8 * Math.sin(a * 2 + phase))) * (.55 + .45 * Math.cos(a - phase)) * (oak ? 1 : .6);
      const ao = .6 + .4 * smooth(y, 0, 1.4) + buttressAt(y, a) * .3, dark = 1 - .55 * blackFoot(y, a);
      return [ao * dark * (.9 - moss * .2), ao * dark * (.88 - moss * .07), ao * dark * (.82 - moss * .24)];
    });
  // Surface roots between the buttresses, arching out and diving into the soil. An oak's run out a metre or two; a birch's
  // are short swellings that sink at once (longer, thinner ones stood on the ground like legs).
  for (let k = 0; k < lobes + (oak ? 3 : 0); k++) {
    const a = (k < lobes ? (k * 2 * Math.PI - phase) / lobes : rnd() * Math.PI * 2) + (rnd() - .5) * .3;
    const reach = oak ? 1.6 + rnd() * 1.4 : .35 + rnd() * .35, thick = (oak ? (k < lobes ? .22 : .12) : .11) * (.8 + rnd() * .4), wander = (rnd() - .5) * (oak ? .6 : .2);
    const dir = v3(Math.cos(a), 0, Math.sin(a)), sideDir = v3(-dir.z, 0, dir.x), r0 = radiusAt(0) * .7;
    const index = ((Math.round(a / (Math.PI * 2) * TRUNK_SEGMENTS) % TRUNK_SEGMENTS) + TRUNK_SEGMENTS) % TRUNK_SEGMENTS;
    const rise = oak ? .5 : .16, sink = oak ? .3 : .4;
    tube(wood, t => v3().addScaledVector(dir, r0 + reach * t).addScaledVector(sideDir, wander * t * t).setY(rise * Math.pow(1 - t, 1.7) + (oak ? .05 : .01) * Math.sin(t * Math.PI) - sink * t * t - .06),
      t => thick * Math.pow(1 - t, 1.2) + .02, 6, oak ? 6 : 4, index, 1, t => .5 + .25 * t, oak ? 1.5 : 1);
  }

  // ---- Limbs. `grow` makes a curved limb from a start point, heading, elevation and length; the curve wanders sideways and
  // bends under its own weight (`sag`, positive droops the tip).
  const limbs: Limb[] = [];
  const grow = (start: THREE.Vector3, heading: number, elevation: number, length: number, r0: number, depth: number, sag: number, wander: number) => {
    const dir = v3(Math.cos(heading) * Math.cos(elevation), Math.sin(elevation), Math.sin(heading) * Math.cos(elevation));
    const side = v3(-Math.sin(heading), 0, Math.cos(heading)), w = rnd() * 6.28;
    const path = (t: number) => start.clone().addScaledVector(dir, length * t).addScaledVector(side, Math.sin(t * 3.2 + w) * wander * length * t)
      .setY(start.y + dir.y * length * t - sag * length * t * t + Math.sin(t * 2.6 + w) * wander * .5 * length * t);
    // A limb thins to a sixth of its base by its tip, where its own branches have taken over (a third looked sawn off).
    const limb: Limb = { path, length, r0, r1: Math.max(.006, r0 * (depth === 0 ? .16 : .2)), depth, live: true };
    limbs.push(limb);
    return limb;
  };
  const tangentAt = (l: Limb, t: number) => l.path(Math.min(1, t + .02)).sub(l.path(Math.max(0, t - .02))).normalize();
  const headingOf = (d: THREE.Vector3) => Math.atan2(d.z, d.x);
  let crownBase: number;
  const crownCentre = v3(), crownRadii = v3();
  if (oak) {
    // Three to five heavy limbs leave the fork, spreading wide; open-grown oaks often keep one or two long low limbs.
    const n = 3 + Math.floor(rnd() * 3), spread = range(9, 13);
    for (let j = 0; j < n; j++) {
      const heading = phase + j / n * Math.PI * 2 + (rnd() - .5) * .8, y = fork - .6 + rnd() * 1.6, s = axis(y);
      const elevation = range(.55, 1.0), length = spread * range(.85, 1.15) / Math.cos(elevation * .8);
      grow(s.addScaledVector(v3(Math.cos(heading), 0, Math.sin(heading)), radiusAt(y) * .5), heading, elevation, length, boleR * range(.38, .48), 0, range(.12, .3), range(.05, .12));
    }
    for (let j = 0; j < (rnd() < .6 ? 2 : 1); j++) {
      const heading = rnd() * Math.PI * 2, y = fork * range(.55, .85), s = axis(y);
      grow(s.addScaledVector(v3(Math.cos(heading), 0, Math.sin(heading)), radiusAt(y) * .6), heading, range(.12, .35), spread * range(.8, 1.05), boleR * range(.26, .34), 0, range(-.05, .08), range(.06, .12));
    }
    // The leading limb is the ring trunk itself above the fork: it gets branches like the others.
    const top = axis(H), base = axis(fork);
    limbs.push({ path: t => axis(fork + (H - fork) * t), length: base.distanceTo(top), r0: radiusAt(fork + .5), r1: .04, depth: 0, live: true, ring: true });
    crownBase = fork + 1;
    crownCentre.set(lean.x * .6, (fork + H) * .55, lean.z * .6); crownRadii.set(spread + 2, (H - fork) * .62, spread + 2);
  } else {
    // A birch climbs: branches all the way up from the crown base, rising steeply and arching over at the tips.
    crownBase = range(8, 13);
    const count = Math.round(range(40, 56));
    for (let j = 0; j < count; j++) {
      const k = (j + rnd() * .7) / count, y = crownBase + k * (H - 1.5 - crownBase), s = axis(y);
      const heading = j * 2.399963 + phase + (rnd() - .5) * .7;
      const length = (6.2 - 4.4 * k) * range(.75, 1.2), elevation = range(.8, 1.2) - .2 * (1 - k);
      grow(s.addScaledVector(v3(Math.cos(heading), 0, Math.sin(heading)), radiusAt(y) * .8), heading, elevation, length, .03 + length * .014, 0, range(.25, .55), range(.04, .1));
    }
    crownCentre.set(lean.x * .7, (crownBase + H) * .55, lean.z * .7); crownRadii.set(5.5, (H - crownBase) * .58, 5.5);
  }
  // Second and third orders: branches off each limb turning outward, twigs off those.
  const primary = limbs.slice();
  for (const l of primary) {
    const count = oak ? Math.round(l.length * range(1, 1.3)) : Math.round(l.length * range(1.8, 2.4));
    for (let i = 0; i < count; i++) {
      const t = oak ? range(.22, 1) : range(.15, .98), s = l.path(t), d = tangentAt(l, t);
      const out = v3(s.x - crownCentre.x, 0, s.z - crownCentre.z).normalize();
      const heading = headingOf(d.clone().lerp(out, oak ? .5 : .3)) + (rnd() - .5) * 1.8;
      if (oak) grow(s, heading, range(.15, .7), Math.min(6.5, l.length * range(.3, .45)) * (1.15 - t * .4), Math.max(.02, (l.r0 + (l.r1 - l.r0) * t) * .5), 1, range(.05, .2), .12);
      // A birch's side shoots hang: long fine twigs that leave the branch and fall away under their own weight.
      else grow(s, heading, range(-.3, .3), range(1.4, 3) * (1.1 - t * .3), .012, 1, range(.5, .9), .08);
    }
  }
  if (oak) for (const l of limbs.filter(l => l.depth === 1)) {
    const count = Math.round(l.length * range(1.4, 1.8));
    for (let i = 0; i < count; i++) {
      const t = range(.3, 1), s = l.path(t), d = tangentAt(l, t);
      grow(s, headingOf(d) + (rnd() - .5) * 2.2, range(-.1, .7), range(.9, 2) * (1.1 - t * .3), .012, 2, .1, .15);
    }
  }
  // Dead stubs below the crown: shed lower branches, broken off short.
  for (let j = 0; j < (oak ? 4 : 7); j++) {
    const y = (oak ? 2 : 2.5) + rnd() * Math.max(1, crownBase - (oak ? 3 : 3)), heading = rnd() * Math.PI * 2, s = axis(y);
    const l = grow(s.addScaledVector(v3(Math.cos(heading), 0, Math.sin(heading)), radiusAt(y) * .85), heading, range(-.3, .3), range(.25, oak ? 1.2 : .8), oak ? .07 : .03, 2, .1, .05);
    l.live = false;
  }

  // ---- Wood. Limbs and branches in both distances; twigs near only (they fade out with the trunk's detail band).
  const barkShade = (l: Limb) => (t: number) => oak ? (l.live ? .86 - .14 * l.depth : .7) : (l.depth === 0 ? .95 - .45 * t : l.live ? .42 : .55);
  for (const l of limbs) {
    if (l.ring) continue;
    const r = (t: number) => l.r0 + (l.r1 - l.r0) * Math.pow(t, .8);
    const sides = l.depth === 0 ? (oak ? 9 : 5) : l.depth === 1 ? (oak ? 5 : 3) : 3;
    // Twigs are straight enough for one segment; they are the most numerous part of the wood (several hundred a tree).
    const segments = l.depth === 2 ? 1 : Math.max(2, Math.min(10, Math.round(l.length * (l.depth === 0 ? 1.1 : .9))));
    tube(wood, l.path, r, sides, segments, 0, l.depth >= (oak ? 2 : 1) ? 1 : 0, barkShade(l), l.depth === 0 && oak ? 2 : 1);
    if (l.depth === 0 || (oak && l.depth === 1 && l.length > 3)) tube(farWood, l.path, r, l.depth === 0 ? (oak ? 5 : 3) : 3, Math.max(2, Math.round(segments * .5)), 0, 0, barkShade(l), 1);
  }

  // ---- Foliage. Light inside the crown: outer and upper cards bright, inner and lower ones in its shade; normals point out
  // of the crown's ellipsoid, so it lights as one volume.
  const normal = v3();
  const light = (p: THREE.Vector3): [number, THREE.Vector3] => {
    const dx = (p.x - crownCentre.x) / crownRadii.x, dy = (p.y - crownCentre.y) / crownRadii.y, dz = (p.z - crownCentre.z) / crownRadii.z;
    const outer = Math.min(1, Math.hypot(dx, dy, dz)), height = smooth(dy, -1, 1);
    normal.set(dx * .9, dy * .9 + .35, dz * .9).normalize();
    return [(.34 + .66 * Math.pow(outer, .9)) * (.8 + .2 * height), normal.clone()];
  };
  const density = range(.85, 1.15), up = v3(0, 1, 0), along = v3(), across = v3();
  const tips = limbs.filter(l => l.live && (oak ? l.depth === 2 : l.depth === 1));
  for (const l of tips) {
    // An oak clumps its leaves round the end of each twig; a birch hangs them all along its fine twigs.
    const cards = Math.round((oak ? range(5, 8) : l.length * range(3.4, 4.4)) * density);
    for (let i = 0; i < cards; i++) {
      const t = oak ? range(.45, 1) : range(.15, 1), p = l.path(t), d = tangentAt(l, t);
      if (oak) {
        // Held out flat towards the light: the spray points along the twig, tipped up, its face turned to the sky.
        along.copy(d).applyAxisAngle(up, (rnd() - .5) * 2.4).setY(d.y * .3 + range(.05, .5)).normalize();
        across.crossVectors(up, along).normalize().applyAxisAngle(along, (rnd() - .5) * .9);
      } else {
        // Hanging with the twig, turned a little either way.
        along.copy(d).setY(Math.min(d.y, -.3) - range(.2, .6)).normalize().applyAxisAngle(up, (rnd() - .5) * .8);
        across.crossVectors(up, along).normalize().applyAxisAngle(along, (rnd() - .5) * 1.2);
      }
      if (across.lengthSq() < .01) across.set(1, 0, 0);
      const size = (oak ? range(1.2, 1.6) : range(.95, 1.3)) * (1 - .15 * (1 - t));
      const rect = pick(CELLS);
      card(crown, p, along, across, size, rect, oak ? .12 : -.1, oak ? 1 : 2, light);
      if (rnd() < (oak ? .2 : .32)) card(farCrown, p, along, across, size * (oak ? 1.75 : 1.6), rect, oak ? .1 : -.08, 1, light);
    }
  }
  // Each tree its own green: oaks deeper and warmer, birches lighter and fresher.
  const tint = oak ? [.92 + rnd() * .1, .98 + rnd() * .06, .86 + rnd() * .1] : [.96 + rnd() * .08, 1, .9 + rnd() * .1];
  for (const parts of [crown, farCrown]) for (let i = 0; i < parts.c.length; i += 3) { parts.c[i] *= tint[0]; parts.c[i + 1] *= tint[1]; parts.c[i + 2] *= tint[2]; }
  return { trunk: wood.geometry(false), farTrunk: farWood.geometry(false), crown: crown.geometry(true, 0), farCrown: farCrown.geometry(true, 1), crownBase, boleRadius: radiusAt(1.5) };
}

/** Several trees per species: the forest picks one by each tree's seed. */
export function buildBroadleafVariants(species: BroadleafSpecies, count: number) {
  return Array.from({ length: count }, (_, i) => buildBroadleaf(species, i + 1));
}
