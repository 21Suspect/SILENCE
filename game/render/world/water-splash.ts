import * as THREE from 'three';

const COUNT = 160;
/** Radius of a droplet in metres: mostly fine mist, now and then a fat bead. */
const SMALLEST = .005, LARGEST = .014;
/** Seconds of travel a droplet's streak shows, as if by a short shutter. */
const STREAK = .02;

/**
 * Droplets thrown up where something breaks the water. Ballistic, allocation-free, one draw call.
 * Each is a small camera-facing capsule stretched along its own motion, so a fast one is a streak and a slow one at the top of
 * its arc is a round bead, with a bright glint on its upper side and a clear, darker body: water, not a speck. The
 * pass keeps every drop at least about a pixel wide and fades it by the area it loses, so none shimmers or turns square.
 * A drop that lands rings the surface, if the river has said how (see `scene.userData.waterRing`).
 */
export function createWaterSplash(scene: THREE.Scene, surfaceAt: (x: number, z: number) => number | undefined) {
  const position = new Float32Array(COUNT * 3), velocity = new Float32Array(COUNT * 3), meta = new Float32Array(COUNT * 2);
  const life = new Float32Array(COUNT), rings = new Uint8Array(COUNT);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aPos', new THREE.InstancedBufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aVel', new THREE.InstancedBufferAttribute(velocity, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aMeta', new THREE.InstancedBufferAttribute(meta, 2).setUsage(THREE.DynamicDrawUsage));
  geometry.instanceCount = COUNT;
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTint: { value: new THREE.Color(.72, .78, .76) }, uViewHeight: { value: 900 }, uStreak: { value: STREAK } },
    vertexShader: `
      attribute vec2 corner;attribute vec3 aPos,aVel;attribute vec2 aMeta;
      uniform float uViewHeight,uStreak;
      varying vec2 vP;varying float vA,vLen;
      void main(){
        if(aMeta.y<=0.){gl_Position=vec4(2.,2.,2.,1.);vP=vec2(0.);vA=0.;vLen=0.;return;}
        vec4 head=modelViewMatrix*vec4(aPos,1.),tail=modelViewMatrix*vec4(aPos-aVel*uStreak,1.);
        float depth=max(-head.z,.05),pixelsPerMetre=projectionMatrix[1][1]*uViewHeight*.5/depth;
        // At least a pixel and a bit across; whatever area that adds is taken back out of the opacity.
        float r=max(aMeta.x,1.1/pixelsPerMetre);
        vec2 axis=tail.xy-head.xy;float len=length(axis);vec2 dir=len>1e-6?axis/len:vec2(0.,1.),across=vec2(-dir.y,dir.x);
        float along=-r+(len+2.*r)*(corner.y*.5+.5);
        gl_Position=projectionMatrix*vec4(head.xy+dir*along+across*r*corner.x,head.z,1.);
        vP=vec2(corner.x,along/r);vLen=len/r;vA=aMeta.y*min(1.,(aMeta.x*aMeta.x)/(r*r)*1.6);
      }`,
    fragmentShader: `
      uniform vec3 uTint;varying vec2 vP;varying float vA,vLen;
      void main(){
        if(vA<=0.)discard;
        // A capsule from the head (0) back along the streak (vLen), tapering to a thin tail.
        float s=clamp(vP.y/max(vLen,.001),0.,1.),along=clamp(vP.y,0.,vLen);
        float d=length(vec2(vP.x,vP.y-along))/mix(1.,.32,s);
        float body=1.-smoothstep(.55,1.,d);
        if(body<=0.)discard;
        // Clear water against the dark forest: a dim body, a bright rim on the shadow side, a hard glint on top.
        float head=1.-smoothstep(0.,1.5,vP.y);
        float rim=smoothstep(.45,.95,d)*.6;
        float glint=smoothstep(.5,.0,length(vP-vec2(-.28,.3)))*head;
        vec3 col=uTint*(.55+.35*rim+.25*head)+vec3(1.)*glint*.9;
        float a=body*vA*(.42+.5*rim+.5*glint)*mix(1.,.55,s);
        gl_FragColor=vec4(col,clamp(a,0.,1.));
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Water spray'; mesh.frustumCulled = false;
  // Drawn in the water pass and after it, or the surface would paint over the droplets.
  mesh.layers.set(1); mesh.renderOrder = 5;
  scene.add(mesh);
  let cursor = 0, seed = 1;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const sky = new THREE.Color();
  return {
    /** strength 0..1: a careful step is a few drops, running in throws a curtain. */
    burst(x: number, y: number, z: number, strength: number, dirX = 0, dirZ = 0) {
      const n = Math.round(6 + strength * 20), moving = Math.hypot(dirX, dirZ) > .2;
      // The foot comes down a stride ahead of the eye, and kicks the water on forwards, where it can be seen.
      const fx = x + (moving ? dirX * .7 : 0), fz = z + (moving ? dirZ * .7 : 0);
      let ringers = 2 + Math.round(strength * 2);
      for (let i = 0; i < n; i++) {
        const k = cursor = (cursor + 1) % COUNT, a = random() * 6.283, size = random();
        const out = (.2 + random() * .95) * (.5 + strength * .7), lift = (.9 + random() * 1.5) * (.5 + strength * .6);
        position[k * 3] = fx + Math.cos(a) * .12; position[k * 3 + 1] = y + .03; position[k * 3 + 2] = fz + Math.sin(a) * .12;
        velocity[k * 3] = Math.cos(a) * out + dirX * (.5 + random() * 1.1); velocity[k * 3 + 1] = lift; velocity[k * 3 + 2] = Math.sin(a) * out + dirZ * (.5 + random() * 1.1);
        // Radius skews small: the cube makes beads rare.
        meta[k * 2] = SMALLEST + (LARGEST - SMALLEST) * size * size * size; meta[k * 2 + 1] = 1;
        life[k] = 1.6; rings[k] = size > .55 && ringers > 0 ? (ringers--, 1) : 0;
      }
    },
    update(dt: number, darkness: number, viewHeight: number) {
      const fog = scene.userData.fogColor as THREE.Color | undefined;
      // Drops take the colour of the sky they mirror, dimmed with the light.
      sky.setRGB(.72, .78, .76); if (fog) sky.lerp(fog, .55);
      // With the torch lit, drops a step ahead of the player are in its beam: they keep a floor of brightness at night.
      material.uniforms.uTint.value.copy(sky).multiplyScalar(Math.max(1 - darkness * .92, scene.userData.flashlight ? .42 : 0));
      material.uniforms.uViewHeight.value = viewHeight;
      const ring = scene.userData.waterRing as ((x: number, z: number, strength: number) => void) | undefined;
      for (let i = 0; i < COUNT; i++) {
        if (life[i] <= 0) { meta[i * 2 + 1] = 0; continue; }
        if (dt <= 0) continue;
        velocity[i * 3 + 1] -= 9.8 * dt;
        position[i * 3] += velocity[i * 3] * dt; position[i * 3 + 1] += velocity[i * 3 + 1] * dt; position[i * 3 + 2] += velocity[i * 3 + 2] * dt;
        life[i] -= dt;
        const surface = surfaceAt(position[i * 3], position[i * 3 + 2]);
        if (surface !== undefined && velocity[i * 3 + 1] < 0 && position[i * 3 + 1] < surface) {
          if (rings[i] && ring) ring(position[i * 3], position[i * 3 + 2], .1 + (meta[i * 2] - SMALLEST) / (LARGEST - SMALLEST) * .2);
          life[i] = 0;
        }
        meta[i * 2 + 1] = life[i] > 0 ? Math.min(1, life[i] * 6) : 0;
      }
      geometry.attributes.aPos.needsUpdate = true; geometry.attributes.aVel.needsUpdate = true; geometry.attributes.aMeta.needsUpdate = true;
    },
    dispose() { scene.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}
