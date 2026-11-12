import * as THREE from 'three';

/**
 * What the grown trees (conifer.ts, broadleaf.ts) are built from: a seeded random stream, the ring trunk the forest relies on,
 * tapered tubes for limbs and roots, and spray cards cut from a twig atlas.
 *
 * Bark is mapped with square texels everywhere: a tube's texture runs a whole number of times round it and its length
 * coordinate advances by distance over local circumference, so bark is never stretched along a thin limb or squashed
 * round a tapering trunk (with a fixed vertical scale a spruce's bark was squeezed about 4:1 across at 20 m). The fissures
 * get finer as the wood gets thinner, as they do on a real tree.
 */
export const TRUNK_RINGS = [0, .16, .45, .9, 1.5, 2.4, 4, 6, 8.5, 11, 14, 17, 20, 23, 26, 29, 31];
export const TRUNK_SEGMENTS = 16;

export function random(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** A buffer of one kind of part: wood (bark uv, colour, root index, stream detail) or foliage (atlas uv, colour, lod). */
export class Parts {
  p: number[] = []; n: number[] = []; uv: number[] = []; c: number[] = []; root: number[] = []; detail: number[] = []; idx: number[] = [];
  geometry(foliage: boolean, lod = 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    if (this.n.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (foliage) g.setAttribute('crownLod', new THREE.Float32BufferAttribute(new Float32Array(this.p.length / 3).fill(lod), 1));
    else { g.setAttribute('rootIndex', new THREE.Float32BufferAttribute(this.root, 1)); g.setAttribute('streamDetail', new THREE.Float32BufferAttribute(this.detail, 1)); }
    g.setIndex(this.idx);
    if (!this.n.length) g.computeVertexNormals();
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

/**
 * The trunk in the forest's ring layout: TRUNK_RINGS x (TRUNK_SEGMENTS + 1) vertices first in the geometry (the ground under
 * a tree is sampled from ring 0, the creature's bark contact walks the rings, the root deform moves ring vertices by their
 * rootIndex). `centre(y)` is the axis, `radius(y, a)` the bark surface, `colour` its vertex colour; `around` how many times
 * the bark texture runs round the base, and the length coordinate keeps the texels square up the taper.
 */
export function ringTrunk(out: Parts, centre: (y: number) => THREE.Vector3, radius: (y: number, a: number) => number, around: number, colour: (y: number, a: number) => [number, number, number]) {
  let v = 0, lastY = 0;
  const mean = (y: number) => { let s = 0; for (let i = 0; i < 8; i++) s += radius(y, i / 8 * Math.PI * 2); return s / 8; };
  for (let r = 0; r < TRUNK_RINGS.length; r++) {
    const y = TRUNK_RINGS[r], c = centre(y);
    // dv = distance along the axis x around / circumference, integrated in eight steps between rings (the radius changes
    // fast at a flare or a fork, and an oak's leader leans away above its fork).
    if (r > 0) for (let k = 0; k < 8; k++) {
      const y0 = lastY + (y - lastY) * k / 8, y1 = lastY + (y - lastY) * (k + 1) / 8;
      v += centre(y1).distanceTo(centre(y0)) * around / (Math.PI * (mean(y0) + mean(y1)));
    }
    lastY = y;
    for (let i = 0; i <= TRUNK_SEGMENTS; i++) {
      const a = i / TRUNK_SEGMENTS * Math.PI * 2, rad = radius(y, a);
      out.p.push(c.x + Math.cos(a) * rad, y - .08, c.z + Math.sin(a) * rad);
      out.uv.push(i / TRUNK_SEGMENTS * around, v);
      const [cr, cg, cb] = colour(y, a); out.c.push(cr, cg, cb);
      out.root.push(i % TRUNK_SEGMENTS); out.detail.push(0);
      if (r < TRUNK_RINGS.length - 1 && i < TRUNK_SEGMENTS) { const a0 = r * (TRUNK_SEGMENTS + 1) + i, b0 = a0 + TRUNK_SEGMENTS + 1; out.idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); }
    }
  }
}

/**
 * A tapered tube along a curve, for limbs and roots: `at(t)` the centre, `radius(t)`, rootIndex for the ground deform,
 * nearOnly (1 = fades out with the trunk's detail band), `shade(t)` its vertex colour. The bark runs `around` times round
 * it at its base and its length coordinate advances by distance over local circumference (square texels).
 */
export function tube(out: Parts, at: (t: number) => THREE.Vector3, radius: (t: number) => number, sides: number, segments: number, rootIndex: number, nearOnly: number, shade: (t: number) => number, around = 1, v0 = 0) {
  const start = out.p.length / 3, tangent = v3(), side = v3(), up = v3(0, 1, 0), normal = v3();
  let v = v0, last = at(0), lastR = radius(0);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments, centre = at(t), r = radius(t), k = shade(t);
    v += centre.distanceTo(last) * around / (Math.PI * Math.max(.004, r + lastR)); last = centre; lastR = r;
    tangent.subVectors(at(Math.min(1, t + .02)), at(Math.max(0, t - .02))).normalize();
    side.crossVectors(tangent, Math.abs(tangent.y) > .95 ? v3(1, 0, 0) : up).normalize();
    normal.crossVectors(side, tangent).normalize();
    for (let i = 0; i <= sides; i++) {
      const a = i / sides * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const nx = side.x * ca + normal.x * sa, ny = side.y * ca + normal.y * sa, nz = side.z * ca + normal.z * sa;
      out.p.push(centre.x + nx * r, centre.y + ny * r, centre.z + nz * r);
      out.uv.push(i / sides * around, v);
      out.c.push(k, k * .99, k * .95); out.root.push(rootIndex); out.detail.push(nearOnly);
      if (s < segments && i < sides) { const a0 = start + s * (sides + 1) + i, b0 = a0 + sides + 1; out.idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); }
    }
  }
  return v;
}

/** A spray in a twig atlas, in pixels: x, y, width, height, and whether it lies sideways (stem at the left). */
export type SprayRect = readonly [number, number, number, number, boolean];

/** One spray card: `along` from stem to tip, `across` its width; bent along its length; `rows` 1 (far) or 2 (near). */
export function card(out: Parts, base: THREE.Vector3, along: THREE.Vector3, across: THREE.Vector3, length: number, rect: SprayRect, bend: number, rows: number, light: (p: THREE.Vector3) => [number, THREE.Vector3], atlas = 2048) {
  const [x, y, w, h, sideways] = rect, aspect = sideways ? h / w : w / h, width = length * aspect;
  const u0 = x / atlas, u1 = (x + w) / atlas, vb = 1 - (y + h) / atlas, vt = 1 - y / atlas;
  const lift = v3().crossVectors(across, along).normalize(), start = out.p.length / 3, p = v3();
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    for (const s of [-1, 1]) {
      p.copy(base).addScaledVector(along, length * t).addScaledVector(across, width * .5 * s).addScaledVector(lift, bend * length * t * t);
      out.p.push(p.x, p.y, p.z);
      const [ao, n] = light(p);
      out.n.push(n.x, n.y, n.z); out.c.push(ao, ao, ao);
      // Stem at the card's base: the bottom of an upright spray, the left of a sideways one.
      if (sideways) out.uv.push(u0 + (u1 - u0) * t, s < 0 ? vb : vt);
      else out.uv.push(s < 0 ? u0 : u1, vb + (vt - vb) * t);
    }
    if (r < rows) { const a = start + r * 2; out.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
}
