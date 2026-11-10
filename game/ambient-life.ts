import * as THREE from 'three';

/** `hidden` roosts have no authored perch: the birds are in the canopy and only show once they break out of it. */
export type Roost = { x: number; y: number; z: number; hidden?: boolean };
export type AmbientOptions = {
  /** Where crows sit: tall landmarks, in world metres. They burst upward when the player gets within 25 m. */
  roosts: readonly Roost[];
  /** Base of the cabin's thin smoke column. */
  chimney?: THREE.Vector3;
  heightAt: (x: number, z: number) => number;
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
};

const BURST_RADIUS = 25, TAU = Math.PI * 2;
const smooth = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * Two draws in total (crows and smoke), all instanced or point-based, and nothing is
 * allocated per frame: positions live in typed arrays, wing flap and puff motion run in the vertex
 * shaders, and anything that cannot be seen (night for crows and smoke) skips its
 * work and its draw call entirely.
 */
export function createAmbientLife(scene: THREE.Scene, o: AmbientOptions) {
  const random = rng(o.seed ?? 1913), group = new THREE.Group(); group.name = 'Ambient life'; scene.add(group);

  // --- crows -----------------------------------------------------------------------------------
  const N = o.crows ?? 24, roosts = o.roosts;
  // Two wings and a body, 4 triangles. `aWing` is 1 at a wingtip: that is the only vertex the shader moves.
  const shape: [number, number, number, number][] = [
    [0, 0, .5, 0], [-.09, 0, -.02, 0], [.09, 0, -.02, 0], [-.09, 0, -.02, 0], [.09, 0, -.02, 0], [0, 0, -.42, 0],
    [-.07, 0, .16, 0], [-.07, 0, -.2, 0], [-.62, 0, -.1, 1], [.07, 0, .16, 0], [.62, 0, -.1, 1], [.07, 0, -.2, 0],
  ];
  const crowGeometry = new THREE.BufferGeometry();
  crowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(shape.flatMap(v => [v[0], v[1], v[2]]), 3));
  crowGeometry.setAttribute('aWing', new THREE.Float32BufferAttribute(shape.map(v => v[3]), 1));
  const birdAttribute = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3), birdData = birdAttribute.array as Float32Array;
  birdAttribute.setUsage(THREE.DynamicDrawUsage); crowGeometry.setAttribute('aBird', birdAttribute);
  const crowMaterial = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: `
      attribute float aWing;attribute vec3 aBird; // phase, flap amplitude, fold (1 = wings against the body)
      void main(){
        vec3 p=position;
        p.x*=mix(1.,.3,aBird.z*aWing);
        float flap=sin(aBird.x)*aBird.y*.62;
        // The tip travels up and down while sweeping back on the down-stroke, so it reads as flapping from far off.
        p.y+=aWing*flap;p.z-=aWing*max(0.,-flap)*.35;
        gl_Position=projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(p,1.);
      }`,
    fragmentShader: 'void main(){gl_FragColor=vec4(.018,.021,.026,1.);}',
  });
  const crows = new THREE.InstancedMesh(crowGeometry, crowMaterial, N);
  crows.name = 'Crows'; crows.frustumCulled = false; crows.visible = false; crows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const matrix = crows.instanceMatrix.array as Float32Array;
  const jx = new Float32Array(N), jy = new Float32Array(N), jz = new Float32Array(N), perchYaw = new Float32Array(N);
  const ang = new Float32Array(N), orbitR = new Float32Array(N), alt = new Float32Array(N), dir = new Float32Array(N), seedPhase = new Float32Array(N);
  const delay = new Float32Array(N), dur = new Float32Array(N), air = new Float32Array(N), phase = new Float32Array(N), size = new Float32Array(N);
  const fx = new Float32Array(N), fy = new Float32Array(N), fz = new Float32Array(N), qx = new Float32Array(N), qy = new Float32Array(N), qz = new Float32Array(N);
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    jx[i] = (random() - .5) * 2.8; jy[i] = (random() - .5) * .9; jz[i] = (random() - .5) * 2.8; perchYaw[i] = random() * TAU;
    ang[i] = random() * TAU; orbitR[i] = 20 + random() * 18; alt[i] = 34 + random() * 18; dir[i] = 1; seedPhase[i] = random() * TAU; size[i] = 1.1 * (.9 + random() * .2);
    qx[i] = NaN; fx[i] = Math.sin(perchYaw[i]); fz[i] = Math.cos(perchYaw[i]);
  }
  let home = -1, hx = 0, hy = 0, hz = 0, hiddenPerch = false, wantAir = false, switchAt = 0, circleUntil = 0, alarm = 0, lastBurst = -Infinity, twilightOn = false, reassignAt = 0, flockVisible = false;

  const chooseHome = (player: THREE.Vector3) => {
    let best = -1, bestD = Infinity;
    // Not one that is about to be on top of the player: they would pop in at arm's length.
    for (let pass = 0; pass < 2 && best < 0; pass++) for (let i = 0; i < roosts.length; i++) {
      const d = (roosts[i].x - player.x) ** 2 + (roosts[i].z - player.z) ** 2;
      if (d < bestD && (pass === 1 || d > 60 * 60)) { bestD = d; best = i; }
    }
    return best;
  };
  const setHome = (index: number) => {
    home = index; hx = roosts[index].x; hy = roosts[index].y; hz = roosts[index].z; hiddenPerch = !!roosts[index].hidden;
    for (let i = 0; i < N; i++) { px[i] = hx + jx[i]; py[i] = hy + jy[i]; pz[i] = hz + jz[i]; qx[i] = NaN; air[i] = 0; }
  };
  const retime = (quick: boolean) => {
    // A startle empties the roost in about a second; dusk takes it a few at a time over most of a minute.
    for (let i = 0; i < N; i++) { delay[i] = random() * (quick ? .6 : 14); dur[i] = quick ? 2.6 + random() * 1.4 : 10 + random() * 8; }
  };
  const startle = (time: number, onBurst: AmbientOptions['onBurst']) => {
    if (!wantAir) { wantAir = true; switchAt = time; retime(true); }
    circleUntil = Math.max(circleUntil, time + 55); alarm = 1;
    if (time - lastBurst > 20) { lastBurst = time; onBurst?.(hx, hy, hz); }
  };

  function updateCrows(f: AmbientFrame) {
    const { time, dt, player, darkness } = f;
    const visible = roosts.length > 0 && darkness < .93;
    if (visible !== flockVisible) {
      flockVisible = visible; crows.visible = visible;
      // They are gone for the night; at dawn they start again on their roost.
      if (!visible) { wantAir = false; alarm = 0; air.fill(0); qx.fill(NaN); }
    }
    if (!visible || dt < 1e-4) return;
    if (time >= reassignAt) {
      reassignAt = time + 1;
      let perched = !wantAir; for (let i = 0; perched && i < N; i++) if (air[i] !== 0) perched = false;
      // Out of sight and far from the current roost: hand the flock to a nearer one.
      if (home < 0 || (perched && (hx - player.x) ** 2 + (hz - player.z) ** 2 > 150 * 150)) {
        const next = chooseHome(player);
        if (next >= 0 && next !== home && (home < 0 || (roosts[next].x - player.x) ** 2 + (roosts[next].z - player.z) ** 2 < ((hx - player.x) ** 2 + (hz - player.z) ** 2) - 40 * 40)) setHome(next);
      }
    }
    if (home < 0) return;
    // Dusk and dawn: the flock lifts off and circles; by day and deep night it sits.
    const twilight = smooth(darkness, .02, .2) * (1 - smooth(darkness, .55, .88));
    twilightOn = twilightOn ? twilight > .2 : twilight > .35;
    const want = twilightOn || time < circleUntil;
    if (want !== wantAir) { wantAir = want; switchAt = time; retime(false); }
    if ((player.x - hx) ** 2 + (player.z - hz) ** 2 < BURST_RADIUS * BURST_RADIUS) startle(time, o.onBurst);
    alarm = Math.max(0, alarm - dt * .06);
    const speed = 7.5 + alarm * 4, radiusScale = 1 + alarm * .7, lift = alarm * 14, step = Math.min(dt, .05);
    const target = wantAir ? 1 : 0;
    for (let i = 0; i < N; i++) {
      // Crows already in the air keep going when the target flips; only ones at rest wait their turn.
      if (time - switchAt > delay[i] || (air[i] > 0 && air[i] < 1)) air[i] = Math.min(1, Math.max(0, air[i] + (target ? 1 : -1) * step / dur[i]));
      const a = air[i], k = a * a * (3 - 2 * a), r = orbitR[i] * radiusScale;
      ang[i] += dir[i] * speed / orbitR[i] * step;
      const ox = hx + Math.cos(ang[i]) * r, oz = hz + Math.sin(ang[i]) * r, oy = hy + alt[i] + Math.sin(time * .31 + seedPhase[i]) * 2.5 + lift;
      const x = px[i] + (ox - px[i]) * k, z = pz[i] + (oz - pz[i]) * k, y = py[i] + (oy - py[i]) * k + Math.sin(Math.PI * a) * 5;
      // Heading is the velocity once it moves, the way it was sitting before that.
      let tx = Math.sin(perchYaw[i]), ty = 0, tz = Math.cos(perchYaw[i]);
      if (!Number.isNaN(qx[i])) {
        const vx = (x - qx[i]) / step, vy = (y - qy[i]) / step, vz = (z - qz[i]) / step, v = Math.sqrt(vx * vx + vy * vy + vz * vz), moving = Math.min(1, Math.max(0, (v - .5) / 2.5));
        if (v > 1e-4) { tx += (vx / v - tx) * moving; ty += (vy / v - ty) * moving; tz += (vz / v - tz) * moving; }
      }
      qx[i] = x; qy[i] = y; qz[i] = z;
      const s = 1 - Math.exp(-6 * step); fx[i] += (tx - fx[i]) * s; fy[i] += (ty - fy[i]) * s; fz[i] += (tz - fz[i]) * s;
      const fl = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i] + fz[i] * fz[i]) || 1, ax = fx[i] / fl, ay = fy[i] / fl, az = fz[i] / fl;
      // Right = up x forward, up = forward x right; then lean into the turn about the forward axis.
      const rl = Math.sqrt(az * az + ax * ax) || 1; let rx = az / rl, rz = -ax / rl, ry = 0;
      let ux = ay * rz, uy = az * rx - ax * rz, uz = -ay * rx;
      const side = ((hx - x) * rx + (hz - z) * rz) / (Math.hypot(hx - x, hz - z) || 1), bank = .42 * k * side, c = Math.cos(bank), n = Math.sin(bank);
      const bx = rx * c - ux * n, by = ry * c - uy * n, bz = rz * c - uz * n; ux = ux * c + rx * n; uy = uy * c + ry * n; uz = uz * c + rz * n; rx = bx; ry = by; rz = bz;
      const m = i * 16, S = hiddenPerch ? size[i] * smooth(a, 0, .08) : size[i];
      matrix[m] = rx * S; matrix[m + 1] = ry * S; matrix[m + 2] = rz * S; matrix[m + 4] = ux * S; matrix[m + 5] = uy * S; matrix[m + 6] = uz * S;
      matrix[m + 8] = ax * S; matrix[m + 9] = ay * S; matrix[m + 10] = az * S; matrix[m + 12] = x; matrix[m + 13] = y; matrix[m + 14] = z; matrix[m + 15] = 1;
      // Flap hard while climbing or alarmed, then alternate beats and glides once circling.
      const trans = 4 * a * (1 - a), rate = 3 + 7 * trans + alarm * 2.5;
      phase[i] += step * rate * TAU * (.9 + seedPhase[i] * .03);
      const amp = a < .02 ? 0 : trans > .1 || alarm > .2 ? 1 : .15 + .85 * smooth(Math.sin(time * .43 + seedPhase[i] * 6), -.1, .45);
      const t = Math.min(1, a / .12);
      birdData[i * 3] = phase[i]; birdData[i * 3 + 1] = amp; birdData[i * 3 + 2] = 1 - t * t * (3 - 2 * t);
    }
    crows.instanceMatrix.needsUpdate = true; birdAttribute.needsUpdate = true;
  }
  for (let i = 0; i < N; i++) { birdData[i * 3 + 2] = 1; matrix.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -9999, 0, 1], i * 16); }
  group.add(crows);

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
    /** Per frame; no allocation, and a frame costs a few microseconds by day and less at night. */
    update(f: AmbientFrame) { updateCrows(f); updateSmoke(f); },
    /** Frighten the flock as if the player had walked up to its roost (dev staging). */
    startle(time: number) { if (home >= 0) startle(time, o.onBurst); },
    objects: { crows, smoke },
    stats() {
      let airborne = 0; for (let i = 0; i < N; i++) if (air[i] > .5) airborne++;
      return { crowsVisible: crows.visible, airborne, home, smokeVisible: smoke.visible, draws: [crows, smoke].filter(m => m.visible).length };
    },
    dispose() {
      scene.remove(group); crows.dispose(); crowGeometry.dispose(); crowMaterial.dispose(); smokeGeometry.dispose(); smokeMaterial.dispose();
    },
  };
}

export type AmbientLife = ReturnType<typeof createAmbientLife>;
