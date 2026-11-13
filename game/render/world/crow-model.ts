import * as THREE from 'three';

// A carrion crow at life size, built here rather than loaded: 48 cm beak to tail, 98 cm across the wings, about 450
// triangles. The bird's own frame has +z forward (the beak), +y up and the right wing along +x.
//
// Every vertex carries two poses. `position` is the bird in flight with its wings flat out and its legs drawn up into the
// belly; the vertex shader articulates the wings from it (shoulder, then wrist) and spreads the tail. `aFold` is the bird
// sitting: wings folded flat along the flanks with the primaries crossed over the tail, body tilted up 24 degrees on its
// legs, head level. The shader blends the two by the instance's fold, so taking off and landing are one draw like the rest.
//
// aPart: x = part (0 body, beak and legs; 1 arm; 2 hand and primaries; 3 tail), y = side (+1 right, -1 left),
// z = fan: for a primary, radians it turns about the wrist when the hand closes; for the tail, its angle off the centre line.

/** Shoulder pivot (the flap axis runs along z through it) and wrist pivot (at the leading edge, where the bone is). */
export const CROW_SHOULDER = [.03, .016, .01] as const, CROW_WRIST = [.25, .014, .086] as const, CROW_TAIL = [0, .008, -.085] as const;
/** How far below the bird's origin its toes are when it sits (legs are built straight down in the sitting frame): a sitting
 * bird is placed this far above its perch. The tail and wingtips hang lower, over the far side of whatever it sits on. */
export const CROW_FOOT = .108;

// Body cross-sections from the face to the vent: z, centre height, half width, half height. A crow's head is about 4 cm
// across against a 10 cm body, with a steep forehead and a nape narrower than both, so it reads as a head and not the
// front of a torpedo.
const STATIONS: readonly (readonly [number, number, number, number])[] = [
  [.160, .010, .009, .011], [.152, .012, .016, .019], [.138, .013, .020, .023], [.120, .011, .021, .023], [.102, .006, .018, .021],
  [.082, .000, .025, .030], [.058, -.007, .040, .045], [.030, -.010, .050, .053], [.000, -.008, .053, .052], [-.035, -.003, .049, .044],
  [-.068, .002, .038, .032], [-.096, .006, .025, .019], [-.118, .008, .013, .010],
];
/** Centre height, half width and half height of the body at z (zero past either end). */
function section(z: number): [number, number, number] {
  if (z >= STATIONS[0][0] || z <= STATIONS[STATIONS.length - 1][0]) return [STATIONS[z > 0 ? 0 : STATIONS.length - 1][1], 0, 0];
  let i = 0; while (STATIONS[i + 1][0] > z) i++;
  const a = STATIONS[i], b = STATIONS[i + 1], t = (a[0] - z) / (a[0] - b[0]);
  return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

type V3 = [number, number, number];
// Sitting, the body stands at about 35 degrees on its legs and the head is held nearly level.
const HIP: V3 = [0, -.03, 0], NECK: V3 = [0, .004, .095], PERCH_PITCH = .62, HEAD_TILT = .5;
const rotX = (p: V3, a: number, o: V3): V3 => {
  const c = Math.cos(a), s = Math.sin(a), y = p[1] - o[1], z = p[2] - o[2];
  return [p[0], o[1] + y * c - z * s, o[2] + y * s + z * c];
};
/** The sitting bird's body tilt about the hips (nose up), after any part-specific folding. */
const perched = (p: V3): V3 => rotX(p, -PERCH_PITCH, HIP);
/** A sitting crow's head: tilted back to level and drawn in on its neck (in flight the neck is stretched out). */
const perchedHead = (p: V3): V3 => { const q = rotX(p, HEAD_TILT, NECK); return perched([q[0], q[1] - .004, q[2] - .014]); };

/** Folds a point of the right wing flat against the flank: span runs back along the body, chord runs down the side. */
function foldWing(x: number, z: number): V3 {
  const u = Math.min(1, Math.max(0, (x - .03) / .46)), c = Math.min(1, Math.max(0, (.088 - z) / .2));
  // The folded wingtips reach about two thirds of the way down the tail.
  const zf = .07 - u * .26 - c * .02;
  const [yc, rx, ry] = section(zf);
  let yf: number, xf: number;
  if (rx > .012) {
    const yTop = yc + ry * .78, h = .068 * (1 - .72 * u);
    yf = yTop - c * h;
    const k = Math.min(1, Math.abs(yf - yc) / ry);
    xf = rx * Math.sqrt(1 - k * k) + .004 + .005 * (1 - c);
  } else {
    // Past the vent the primaries lie crossed on top of the closed tail (which rises .1 rad off the body line, see tailFold).
    yf = CROW_TAIL[1] + (CROW_TAIL[2] - zf) * .1 + .008 - c * .004; xf = .008 + .012 * (1 - u);
  }
  return [xf, yf, zf];
}

export function createCrowGeometry() {
  const pos: number[] = [], fold: number[] = [], part: number[] = [], index: number[] = [];
  const add = (p: V3, f: V3, seg: number, side: number, fan = 0) => { pos.push(...p); fold.push(...f); part.push(seg, side, fan, 0); return pos.length / 3 - 1; };
  const e = (i: number, k: number) => pos[i * 3 + k];
  /** A triangle wound so that, in the flight pose, its normal points along (dx, dy, dz). */
  const face = (a: number, b: number, c: number, dx: number, dy: number, dz: number) => {
    const u = [e(b, 0) - e(a, 0), e(b, 1) - e(a, 1), e(b, 2) - e(a, 2)], v = [e(c, 0) - e(a, 0), e(c, 1) - e(a, 1), e(c, 2) - e(a, 2)];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (n[0] * dx + n[1] * dy + n[2] * dz < 0) index.push(a, c, b); else index.push(a, b, c);
  };
  /** Wing and tail sheets: the upper side is the front face. */
  const tri = (a: number, b: number, c: number) => face(a, b, c, 0, 1, 0);
  /** Closed parts: facing away from the axis point (0, y, z) beside the triangle. */
  const shell = (a: number, b: number, c: number, y: number, front = .155) => {
    const cx = (e(a, 0) + e(b, 0) + e(c, 0)) / 3, cy = (e(a, 1) + e(b, 1) + e(c, 1)) / 3 - y, cz = (e(a, 2) + e(b, 2) + e(c, 2)) / 3;
    const z = Math.min(Math.max(cz, -.11), front);
    face(a, b, c, cx, cy, cz - z);
  };

  // --- body: thirteen sections of ten, a little flatter over the back than under the breast ---
  const SEG = 10, ring: number[][] = [];
  for (const [z, yc, rx, ry] of STATIONS) {
    const r: number[] = [];
    for (let k = 0; k < SEG; k++) {
      const a = k / SEG * Math.PI * 2, sy = Math.sin(a), p: V3 = [Math.cos(a) * rx, yc + sy * ry * (sy > 0 ? .9 : 1), z];
      const head = z > .09, f = head ? perchedHead(p) : perched(p);
      r.push(add(p, f, 0, 0));
    }
    ring.push(r);
  }
  const capFront = add([0, .010, .164], perchedHead([0, .010, .164]), 0, 0), capBack = add([0, .008, -.124], perched([0, .008, -.124]), 0, 0);
  for (let i = 0; i < ring.length - 1; i++) for (let k = 0; k < SEG; k++) {
    const a = ring[i][k], b = ring[i][(k + 1) % SEG], c = ring[i + 1][k], d = ring[i + 1][(k + 1) % SEG], y = (STATIONS[i][1] + STATIONS[i + 1][1]) / 2;
    shell(a, b, c, y); shell(b, d, c, y);
  }
  for (let k = 0; k < SEG; k++) { shell(capFront, ring[0][(k + 1) % SEG], ring[0][k], .008); shell(capBack, ring[ring.length - 1][k], ring[ring.length - 1][(k + 1) % SEG], .009); }

  // --- beak: stout, its tip turned down; three hexagonal sections and a point ---
  const beakRings = [[.148, .008, .0085, .0115], [.176, .006, .0058, .0078], [.199, .002, .003, .0042]].map(([z, yc, hw, hh]) => {
    const r: number[] = [];
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2, p: V3 = [Math.cos(a) * hw, yc + Math.sin(a) * hh, z];
      r.push(add(p, perchedHead(p), 0, 0));
    }
    return r;
  });
  const tip = add([0, -.003, .212], perchedHead([0, -.003, .212]), 0, 0);
  for (let i = 0; i < 2; i++) for (let k = 0; k < 6; k++) {
    const a = beakRings[i][k], b = beakRings[i][(k + 1) % 6], c = beakRings[i + 1][k], d = beakRings[i + 1][(k + 1) % 6];
    shell(a, b, c, .003, 1); shell(b, d, c, .003, 1);
  }
  for (let k = 0; k < 6; k++) face(beakRings[2][k], beakRings[2][(k + 1) % 6], tip, 0, -.2, 1);

  // --- tail: a rounded fan of 0.19 m, a little open in flight; sitting, closed and held a touch flatter than the tilted body ---
  // Its feathers stack into a shallow keel, about a centimetre deep at the root, so from the side it is a wedge, not a line.
  const FAN = 8, SPREAD = .3, CLOSED = .17, tailAt = (a: number, r: number, spread: number): V3 => {
    const angle = a * spread, len = .19 * (1 - .07 * a * a) * r;
    return [CROW_TAIL[0] + Math.sin(angle) * len, CROW_TAIL[1] - .011 * (1 - .65 * r) * (1 - Math.abs(a)), CROW_TAIL[2] - Math.cos(angle) * len];
  };
  const tailFold = (p: V3) => perched(rotX(p, .1, [...CROW_TAIL] as V3));
  const tailRoot = add([...CROW_TAIL] as V3, tailFold([...CROW_TAIL] as V3), 3, 0, 0);
  const tailMid: number[] = [], tailEdge: number[] = [];
  for (let k = 0; k <= FAN; k++) {
    const a = k / FAN * 2 - 1;
    tailMid.push(add(tailAt(a, .45, SPREAD), tailFold(tailAt(a, .45, CLOSED)), 3, 0, a * SPREAD * .45));
    tailEdge.push(add(tailAt(a, 1, SPREAD), tailFold(tailAt(a, 1, CLOSED)), 3, 0, a * SPREAD));
  }
  for (let k = 0; k < FAN; k++) {
    tri(tailRoot, tailMid[k], tailMid[k + 1]);
    tri(tailMid[k], tailEdge[k], tailEdge[k + 1]); tri(tailMid[k], tailEdge[k + 1], tailMid[k + 1]);
  }

  // --- wings: built for the right side, then mirrored ---
  for (const side of [1, -1]) {
    const W = (x: number, y: number, z: number, seg: number, fan = 0) => {
      const f = perched(foldWing(x, z));
      return add([x * side, y, z], [f[0] * side, f[1], f[2]], seg, side, fan);
    };
    // Arm: root (inside the body, so it never parts from it), elbow and wrist, four points along each chord, cambered.
    const station = (x: number, le: number, te: number, y: number, seg: number, camber: number) =>
      [0, 1, 2, 3].map(k => { const c = k / 3; return W(x, y + camber * Math.sin(Math.PI * c), le + (te - le) * c, seg); });
    const root = station(.03, .072, -.07, .016, 0, .010), elbow = station(.14, .084, -.1, .016, 1, .011), wrist = station(.25, .086, -.112, .014, 2, .007);
    for (const [a, b] of [[root, elbow], [elbow, wrist]]) for (let k = 0; k < 3; k++) { tri(a[k], b[k], a[k + 1]); tri(a[k + 1], b[k], b[k + 1]); }
    // Hand: a plate from the wrist to the bases of the five fingered primaries.
    const mid = [W(.305, .012, .074, 2), W(.305, .013, .02, 2), W(.305, .013, -.046, 2), W(.3, .012, -.104, 2)];
    for (let k = 0; k < 3; k++) { tri(wrist[k], mid[k], wrist[k + 1]); tri(wrist[k + 1], mid[k], mid[k + 1]); }
    const base: [number, number][] = [[.36, .06], [.373, .033], [.378, .003], [.375, -.028], [.366, -.058], [.35, -.088]];
    const arc = base.map(([x, z]) => W(x, .011, z, 2));
    tri(mid[0], arc[0], arc[1]); tri(mid[0], arc[1], mid[1]); tri(mid[1], arc[1], arc[2]); tri(mid[1], arc[2], mid[2]);
    tri(mid[2], arc[2], arc[3]); tri(mid[2], arc[3], arc[4]); tri(mid[2], arc[4], mid[3]); tri(mid[3], arc[4], arc[5]);
    // The fingers: tapering, slotted apart, tips turned up a little; closing the hand turns each about the wrist, the
    // leading ones back and the trailing ones forward, more towards the tip, so the slots shut on the up-stroke.
    const tips: V3[] = [[.452, .02, .04], [.482, .022, .008], [.49, .022, -.03], [.477, .02, -.072], [.448, .018, -.108]];
    const turn = [.24, .12, 0, -.12, -.22];
    // Each is a broad feather (its base the full 3 cm between its neighbours) narrowing only near the end to a round tip.
    for (let k = 0; k < 5; k++) {
      const [bx0, bz0] = base[k], [bx1, bz1] = base[k + 1], t = tips[k];
      const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2, hx = (bx0 - bx1) / 2, hz = (bz0 - bz1) / 2;
      const along = (f: number, w: number, side: number) => W(cx + (t[0] - cx) * f + hx * w * side, .011 + (t[1] - .011) * f * f, cz + (t[2] - cz) * f + hz * w * side, 2, turn[k] * f);
      let last = [arc[k], arc[k + 1]];
      for (const [f, w] of [[.55, .78], [.86, .6], [.97, .33]]) {
        const next = [along(f, w, 1), along(f, w, -1)];
        tri(last[0], last[1], next[1]); tri(last[0], next[1], next[0]); last = next;
      }
      tri(last[0], last[1], along(1, 0, 0));
    }
  }

  // --- legs: drawn up into the belly in flight (every point at the hip), standing on the toes when perched ---
  for (const side of [1, -1]) {
    const hip: V3 = [HIP[0] + .016 * side, HIP[1], HIP[2]], ankle: V3 = [.017 * side, -.1, .006], s = (p: V3) => add(hip, p, 0, 0);
    const w = .0035;
    const legs = [s([hip[0] - w, hip[1], hip[2]]), s([hip[0] + w, hip[1], hip[2]]), s([ankle[0] - w, ankle[1], ankle[2]]), s([ankle[0] + w, ankle[1], ankle[2]]),
      s([hip[0], hip[1], hip[2] - w]), s([hip[0], hip[1], hip[2] + w]), s([ankle[0], ankle[1], ankle[2] - w]), s([ankle[0], ankle[1], ankle[2] + w])];
    index.push(legs[0], legs[2], legs[1], legs[1], legs[2], legs[3], legs[4], legs[6], legs[5], legs[5], legs[6], legs[7]);
    for (const [dx, dz] of [[-.01, .036], [0, .04], [.01, .036], [0, -.026]]) {
      const toe: V3 = [ankle[0] + dx, -CROW_FOOT, ankle[2] + dz], q = .0025;
      const a = s([ankle[0] - q, -.106, ankle[2]]), b = s([ankle[0] + q, -.106, ankle[2]]), c = s([toe[0], toe[1], toe[2]]);
      index.push(a, c, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(index); geometry.computeVertexNormals();
  // The sitting pose's normals come from its own triangles (same indices), so lighting is right in both and in between.
  const folded = new THREE.BufferGeometry();
  folded.setAttribute('position', new THREE.Float32BufferAttribute(fold, 3)); folded.setIndex(index); folded.computeVertexNormals();
  geometry.setAttribute('aFold', new THREE.Float32BufferAttribute(fold, 3));
  geometry.setAttribute('aFoldNormal', folded.getAttribute('normal'));
  geometry.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 4));
  folded.dispose();
  return geometry;
}

const v3 = (v: readonly number[]) => `vec3(${v.map(n => n.toFixed(4)).join(',')})`;
/**
 * Glossy black feathers, lit like everything else (sun, sky, the torch): .026 linear albedo, roughness .55, and a third of
 * the sky's reflection: at full strength the sky's blue at grazing angles turned the backs navy, where a crow's gloss is
 * only a sheen.
 * By day that is a black bird against a bright sky with a grey sheen along its back; at night it can never be brighter than
 * the light that falls on it, unlike the old unlit flat colour, which the night's eye adaptation turned white.
 *
 * aBird (per instance): x = wingbeat phase (radians; the wings are up at 0 and come down through pi/2), y = flap amplitude
 * (0 a held glide, 1 a full beat), z = fold (0 flying, 1 sitting), w = held lift (radians the wings are raised in a glide;
 * about .3 is the shallow V of a bird dropping in to land, which also fans and lowers the tail).
 */
export function createCrowMaterial() {
  const material = new THREE.MeshStandardMaterial({
    name: 'Crow', color: new THREE.Color().setRGB(.026, .026, .028, THREE.LinearSRGBColorSpace), roughness: .55, metalness: 0, envMapIntensity: .35, side: THREE.DoubleSide,
  });
  material.onBeforeCompile = shader => {
    shader.vertexShader = `attribute vec4 aPart,aBird;attribute vec3 aFold,aFoldNormal;
mat3 crowRotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0.,0.,c,s,0.,-s,c);}
mat3 crowRotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s,0.,1.,0.,s,0.,c);}
mat3 crowRotZ(float a){float c=cos(a),s=sin(a);return mat3(c,s,0.,-s,c,0.,0.,0.,1.);}
${shader.vertexShader}`.replace('#include <beginnormal_vertex>', `
vec3 objectNormal=normal,crowPosition=position;
{
  float cs=cos(aBird.x),sn=sin(aBird.x),amp=aBird.y,fold=aBird.z,lift=aBird.w;
  // Down-stroke: the wing straight and spread, the hand pronated a little. Up-stroke: the wrist flexes, the hand sweeps
  // back and hangs below the arm with its fingers closed, so the wing comes up bent rather than as a flat paddle.
  float up=amp*smoothstep(-.1,.8,-sn),down=amp*max(sn,0.);
  if(aPart.x>.5&&aPart.x<2.5){
    vec3 p=position,n=normal;p.x*=aPart.y;n.x*=aPart.y;
    if(aPart.x>1.5){
      mat3 hand=crowRotY(up*.7)*crowRotZ(lift*.4+down*.05-up*.85)*crowRotX(down*.1-up*.28)*crowRotY(aPart.z*clamp(up+fold,0.,1.));
      p=${v3(CROW_WRIST)}+hand*(p-${v3(CROW_WRIST)});n=hand*n;
    }
    mat3 arm=crowRotY(up*.28)*crowRotZ(lift+amp*.8*cs);
    p=${v3(CROW_SHOULDER)}+arm*(p-${v3(CROW_SHOULDER)});n=arm*n;
    p.x*=aPart.y;n.x*=aPart.y;crowPosition=p;objectNormal=n;
  }else if(aPart.x>2.5){
    // The tail opens and dips as the bird brakes (and opens a little on every beat).
    mat3 fan=crowRotX(-lift*.6)*crowRotY(-aPart.z*(.15+lift*1.6+amp*.15));
    crowPosition=${v3(CROW_TAIL)}+fan*(position-${v3(CROW_TAIL)});objectNormal=fan*normal;
  }
  // The body rises as the wings come down.
  crowPosition.y-=amp*.018*cs;
  crowPosition=mix(crowPosition,aFold,fold);
  objectNormal=normalize(mix(objectNormal,aFoldNormal,fold)+vec3(0.,1e-4,0.));
}
`).replace('#include <begin_vertex>', 'vec3 transformed=crowPosition;');
  };
  material.customProgramCacheKey = () => 'crow-articulated-1';
  return material;
}
