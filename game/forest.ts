import { WORLD_V2 } from './world-flags';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createUndergrowth } from './undergrowth';
import { createRockGeometry, createRockMaterial } from './surfaces';
import { varyDirectionalTexture } from './texture-variation';
import { WORLD_RADIUS, biomeAt, riverX, riverPresence, roadZ } from './world';
import { naturalLayout, groundedOrigin, type LayoutCell as ForestCell } from './placement';
import type { SolidCollider } from './collision';
import { createMeshSurface } from './surface-support';
import { branchSpec, broadleafGeometry, crownBranches, crownGeometry, stumpGeometry } from './forest-assets';
import { createVegetationBatcher, type VegetationBatchDefinition, type VegetationBatchHandle } from './vegetation-batches';

type Collider = { x: number; z: number; radius: number };
type Tree = { x: number; z: number; y: number; height: number; width: number; yaw: number; kind: number; seed: number };
type Scatter = { x: number; z: number; y: number; size: number; yaw: number; variant: number };
const TRUNK_RINGS = [0, .16, .45, .9, 1.5, 2.4, 4, 6, 8.5, 11, 14, 17, 20, 23, 26, 29, 31];
const TRUNK_SEGMENTS = 16;
const FOREST_STEP=6, FOREST_BUFFER=FOREST_STEP+.5, TREE_RANGE=98, TREE_COLLISION_RANGE=94, TRUNK_DETAIL_END=43;
const branchesByKind = Array.from({length:8}, (_,kind) => Array.from({length:36}, (_,branch) => branchSpec(kind,branch)));

// All vegetation is deterministic; only objects concealed by the fog are recycled.
function random(seed: number) {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function endgrainTextures() {
  const size = 512, rnd = random(555); const height = new Float32Array(size * size);
  const colorCanvas = document.createElement('canvas'); colorCanvas.width = colorCanvas.height = size;
  const colorContext = colorCanvas.getContext('2d')!; const colorImage = colorContext.createImageData(size, size);
  const roughCanvas = document.createElement('canvas'); roughCanvas.width = roughCanvas.height = size;
  const roughContext = roughCanvas.getContext('2d')!; const roughImage = roughContext.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x - 244) / 250, dy = (y - 260) / 250, angle = Math.atan2(dy, dx);
    const radius = Math.hypot(dx, dy) * (1 + .035 * Math.sin(angle * 3) + .018 * Math.sin(angle * 7));
    const phase = radius * 84 + Math.sin(radius * 17 + angle * 2) * .65;
    const growthRing = Math.pow(.5 + .5 * Math.sin(phase), 9);
    const speckle = (rnd() - .5) * 16, rays = Math.pow(Math.abs(Math.sin(angle * 77 + radius * .8)), 18) * 5;
    const stain = Math.sin(dx * 13 + Math.sin(dy * 11)) * 6 + Math.sin(dy * 31 + dx * 17) * 3;
    const value = speckle - growthRing * 23 + rays + stain;
    const i = (y * size + x) * 4;
    colorImage.data[i] = 137 + value; colorImage.data[i + 1] = 122 + value; colorImage.data[i + 2] = 96 + value; colorImage.data[i + 3] = 255;
    height[y * size + x] = .5 - growthRing * .13 + speckle * .002;
    roughImage.data[i] = roughImage.data[i + 1] = roughImage.data[i + 2] = 194 + Math.floor(rnd() * 35); roughImage.data[i + 3] = 255;
  }
  colorContext.putImageData(colorImage, 0, 0); roughContext.putImageData(roughImage, 0, 0);
  // Radial checks and drying splits are much less regular than growth rings.
  for (let n = 0; n < 11; n++) {
    const a = rnd() * Math.PI * 2, inner = .2 + rnd() * .5, outer = .78 + rnd() * .2;
    colorContext.strokeStyle = 'rgba(40,34,24,.8)'; colorContext.lineWidth = .9 + rnd() * 2.3;
    colorContext.beginPath(); colorContext.moveTo(244 + Math.cos(a) * inner * 250, 260 + Math.sin(a) * inner * 250);
    colorContext.quadraticCurveTo(244 + Math.cos(a + .018) * .75 * 250, 260 + Math.sin(a + .018) * .75 * 250, 244 + Math.cos(a) * outer * 250, 260 + Math.sin(a) * outer * 250); colorContext.stroke();
  }
  const normalCanvas = document.createElement('canvas'); normalCanvas.width = normalCanvas.height = size;
  const normalContext = normalCanvas.getContext('2d')!; const normalImage = normalContext.createImageData(size, size);
  const v = new THREE.Vector3();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const left = height[y * size + Math.max(0, x - 1)], right = height[y * size + Math.min(size - 1, x + 1)];
    const down = height[Math.max(0, y - 1) * size + x], up = height[Math.min(size - 1, y + 1) * size + x];
    v.set((left - right) * 2, (down - up) * 2, 1).normalize(); const i = (y * size + x) * 4;
    normalImage.data[i] = (v.x * .5 + .5) * 255; normalImage.data[i + 1] = (v.y * .5 + .5) * 255; normalImage.data[i + 2] = (v.z * .5 + .5) * 255; normalImage.data[i + 3] = 255;
  }
  normalContext.putImageData(normalImage, 0, 0);
  const map = new THREE.CanvasTexture(colorCanvas), normalMap = new THREE.CanvasTexture(normalCanvas), roughnessMap = new THREE.CanvasTexture(roughCanvas);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = normalMap.anisotropy = roughnessMap.anisotropy = 8;
  return { map, normalMap, roughnessMap };
}

function trunkGeometry(seed: number, kind=0, lowDetail=false) {
  const rnd = random(seed); const positions: number[] = []; const colors: number[] = []; const uvs: number[] = []; const indices: number[] = [];
  const rings = TRUNK_RINGS, segments = TRUNK_SEGMENTS;
  const rootIndices: number[] = []; const phase = rnd() * Math.PI * 2; const bend = rnd() * .45;
  for (let r = 0; r < rings.length; r++) {
    const y = rings[r]; const taper = Math.pow(1 - y / 33, .72);
    const radius = .44 * taper + .48 * Math.exp(-y * 2.9);
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2;
      const groove = 1 + .11 * Math.sin(a * 5 + phase) + .035 * Math.sin(y * 2 + a * 7);
      const root = Math.exp(-y * 3) * Math.pow(Math.max(0, Math.cos(a * 4 + phase)), 5) * .43;
      positions.push(Math.cos(a) * (radius * groove + root) + Math.sin(y * .045) * bend, y - .08, Math.sin(a) * (radius * groove + root) + Math.sin(y * .06 + phase) * bend * y / 31);
      uvs.push(i / segments * (kind>=4&&kind<6?1.5:3.1), y * (kind>=4&&kind<6?.38:.78)); rootIndices.push(i % segments);
      const moss = Math.max(0, 1 - y / (1.6 + .6 * Math.sin(a * 3 + phase))) * (.65 + .35 * Math.cos(a + phase));
      const barkAge=kind>=4&&kind<6?Math.max(0,1-y/2.4)*(.65+.35*Math.sin(a*3+phase)):0;
      colors.push((.86-moss*.2)*(1-barkAge*.53),(.84-moss*.12)*(1-barkAge*.52),(.76-moss*.28)*(1-barkAge*.67));
      if (r < rings.length - 1 && i < segments) {
        const a0 = r * (segments + 1) + i; const b0 = a0 + segments + 1;
        indices.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
      }
    }
  }
  const trunk = new THREE.BufferGeometry(); trunk.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); trunk.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); trunk.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); trunk.setAttribute('rootIndex', new THREE.Float32BufferAttribute(rootIndices, 1)); trunk.setIndex(indices); trunk.computeVertexNormals();
  trunk.setAttribute('streamDetail',new THREE.Float32BufferAttribute(new Float32Array(positions.length/3),1));
  const parts = [trunk];
  const species=Math.floor(kind/2);
  const addBranch=(start:THREE.Vector3,end:THREE.Vector3,radius:number,nearOnly=false)=>{
    if(nearOnly&&lowDetail)return;
    const g=new THREE.CylinderGeometry(radius*.19,radius,start.distanceTo(end),species>1&&nearOnly?7:5,species>1&&nearOnly?2:1,false);
    const p=g.attributes.position,uv=g.attributes.uv;
    for(let i=0;i<p.count;i++){const y=p.getY(i),f=y/start.distanceTo(end)+.5;p.setX(i,p.getX(i)+Math.sin(f*Math.PI)*radius*.9);uv.setY(i,f*start.distanceTo(end)*.78);}
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),end.clone().sub(start).normalize()));
    const c=start.clone().add(end).multiplyScalar(.5);g.translate(c.x,c.y,c.z);
    g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(p.count*3).fill(.84),3));
    g.setAttribute('rootIndex',new THREE.Float32BufferAttribute(new Float32Array(p.count),1));
    g.setAttribute('streamDetail',new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(nearOnly?1:0),1));
    parts.push(g);
  };
  // Old broken limbs and irregular lateral shoots below the live crown.
  for(let j=0;j<(species<2?17:7);j++){
    const y=3+rnd()*(species<2?19:9),a=rnd()*Math.PI*2,length=.26+rnd()*(y<11?.9:1.8);
    addBranch(new THREE.Vector3(Math.cos(a)*.25,y,Math.sin(a)*.25),new THREE.Vector3(Math.cos(a)*(length+.25),y+.1+rnd()*.5,Math.sin(a)*(length+.25)),.018+(31-y)*.0014,j%2===1);
  }
  for(const j of crownBranches){
    const b=branchesByKind[kind][j],v=new THREE.Vector3(Math.cos(b.angle),b.rise,Math.sin(b.angle)).normalize();
    const start=new THREE.Vector3(0,b.height,0),end=start.clone().addScaledVector(v,b.length*.99);
    addBranch(start,end,species<2?.022+(1-j/36)*.05:.055+(1-j/36)*.15);
    if(species>1&&!lowDetail&&j%2===0){
      const mid=start.clone().lerp(end,.56),side=new THREE.Vector3(-v.z,.4,v.x).normalize();
      addBranch(mid,mid.clone().addScaledVector(v,b.length*.37).addScaledVector(side,b.length*.31),.035+(1-j/36)*.045,true);
    }
  }
  const geometry = mergeGeometries(parts, false)!; parts.forEach(g => g.dispose()); return geometry;
}

function leafGeometry() {
  // A cupped, weathered birch leaf, smaller than a boot print and partly buried.
  const points = [
    [0, .006, -.065], [-.013, .009, -.041], [-.022, .012, -.029],
    [-.018, .014, -.019], [-.027, .019, -.01], [-.019, .024, .009],
    [-.011, .029, .022], [.002, .034, .043], [.012, .024, .024],
    [.018, .018, .014], [.016, .016, .004], [.022, .01, -.012],
    [.015, .007, -.029], [.009, .005, -.047],
  ];
  const positions: number[] = [0, .008, -.009]; const colors: number[] = [.65, .54, .30]; const indices: number[] = [];
  for (let i = 0; i < points.length; i++) {
    positions.push(...points[i]); const shade = .82 + Math.sin(i * 1.7) * .15;
    colors.push(.59 * shade, .48 * shade, .29 * shade);
    indices.push(0, i + 1, (i + 1) % points.length + 1);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));const uv:number[]=[];for(let i=0;i<positions.length;i+=3)uv.push(.055+(positions[i]+.027)/.049*.14,1-(.05+(positions[i+2]+.065)/.108*.095));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2)); g.setIndex(indices); g.computeVertexNormals(); return g;
}

function canopyGeometry(shootCount: number, shootScale = 1) {
  const parts: THREE.BufferGeometry[] = [], rnd = random(6301);
  // Each atlas image is a real 20–50cm pine shoot. A woody branch carries many
  // separate shoots with open air between them instead of one giant leaf card.
  for (let i = 0; i < shootCount; i++) {
    const t = .28 + i / (shootCount - 1) * .68, side = i % 2 ? 1 : -1;
    const spread = (.045 + (1 - t) * .22) * side;
    const length = (.205 + rnd() * .085) * shootScale, angle = side * (.29 + rnd() * .65);
    for (const crossAngle of [0, Math.PI / 2]) {
      const g = new THREE.PlaneGeometry(length * .49, length, 1, 1);
      g.rotateY(crossAngle); g.rotateZ(-angle);
      g.translate(spread, t - .5, Math.sin(t * 5) * .025 + (rnd() - .5) * .075); parts.push(g);
    }
  }
  const tip = new THREE.PlaneGeometry(.11, .23); tip.translate(0, .46, 0); parts.push(tip);
  const geometry = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return geometry;
}

function canopyWoodGeometry() {
  const parts: THREE.BufferGeometry[] = [], up = new THREE.Vector3(0, 1, 0);
  const stem = (a: THREE.Vector3, b: THREE.Vector3, radius: number) => {
    const g = new THREE.CylinderGeometry(radius * .45, radius, a.distanceTo(b), 5, 1, true);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize()));
    const c = a.clone().add(b).multiplyScalar(.5); g.translate(c.x, c.y, c.z); parts.push(g);
  };
  stem(new THREE.Vector3(0, -.5, 0), new THREE.Vector3(0, .48, -.025), .010);
  for (let i = 0; i < 9; i++) {
    const t = .34 + i / 8 * .61, side = i % 2 ? 1 : -1;
    stem(new THREE.Vector3(0, t - .56, 0), new THREE.Vector3((.045 + (1 - t) * .22) * side, t - .48, Math.sin(t * 5) * .025), .0035);
  }
  const geometry = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return geometry;
}

function logGeometry() {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const segments = 24, rings = 7; const radiusAt = (t: number, a: number) => (1 - .26 * t) * (1 + .035 * Math.sin(a * 5 + 1) + .022 * Math.sin(a * 9));
  const centerAt = (t: number) => new THREE.Vector3(Math.sin(t * 4.2) * .035, t - .5, Math.sin(t * 3.1) * .025);
  for (let r = 0; r <= rings; r++) {
    const t = r / rings, center = centerAt(t);
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2, radius = radiusAt(t, a);
      positions.push(center.x + Math.cos(a) * radius, center.y, center.z + Math.sin(a) * radius); uvs.push(i / segments * 2.4, t * 5);
      if (r < rings && i < segments) { const n = r * (segments + 1) + i, m = n + segments + 1; indices.push(n, m, n + 1, n + 1, m, m + 1); }
    }
  }
  const sideCount = indices.length;
  // Both end caps share the shell's exact perimeter. There is no open cylinder,
  // separate floating disk, or missing underside; rim bark surrounds the grain.
  for (const t of [0, 1]) {
    const center = centerAt(t), outerStart = positions.length / 3;
    for (const fraction of [1, .89]) for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2, radius = radiusAt(t, a) * fraction;
      positions.push(center.x + Math.cos(a) * radius, center.y, center.z + Math.sin(a) * radius); uvs.push(.5 + Math.cos(a) * .5 * fraction, .5 + Math.sin(a) * .5 * fraction);
    }
    for (let i = 0; i < segments; i++) {
      const a = outerStart + i, b = a + segments + 1;
      if (t === 0) indices.push(a, a + 1, b, a + 1, b + 1, b); else indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const barkCount = indices.length;
  for (const t of [0, 1]) {
    const center = centerAt(t), c = positions.length / 3;
    positions.push(center.x, center.y, center.z); uvs.push(.5, .5);
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2, radius = radiusAt(t, a) * .89;
      positions.push(center.x + Math.cos(a) * radius, center.y, center.z + Math.sin(a) * radius); uvs.push(.5 + Math.cos(a) * .5, .5 + Math.sin(a) * .5);
      if (i < segments) { if (t === 0) indices.push(c, c + i + 1, c + i + 2); else indices.push(c, c + i + 2, c + i + 1); }
    }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  geometry.clearGroups(); geometry.addGroup(0, barkCount, 0); geometry.addGroup(barkCount, indices.length - barkCount, 1);
  geometry.userData.closedShellTriangles = sideCount / 3; return geometry;
}

const ROOT_SHADER_HEADER = `
  attribute float rootIndex;
  attribute vec4 rootHeightsA;
  attribute vec4 rootHeightsB;
  attribute vec4 rootHeightsC;
  attribute vec4 rootHeightsD;
`;
const ROOT_SHADER_DEFORM = `
  #include <begin_vertex>
  float rootShift = 0.0;
  if (rootIndex < 3.5) rootShift = rootHeightsA[int(rootIndex + .5)];
  else if (rootIndex < 7.5) rootShift = rootHeightsB[int(rootIndex - 4.0 + .5)];
  else if (rootIndex < 11.5) rootShift = rootHeightsC[int(rootIndex - 8.0 + .5)];
  else rootShift = rootHeightsD[int(rootIndex - 12.0 + .5)];
  transformed.y += rootShift * (1.0 - smoothstep(0.0, 2.0, max(position.y, 0.0)));
`;

export function createForest(scene: THREE.Scene, heightAt: (x: number, z: number) => number, exclusion: (x: number, z: number) => number, spawn: THREE.Vector3) {
  const group = new THREE.Group(); group.name = 'Forest — grounded trunks, pine crowns, deadfall and litter'; scene.add(group);
  const undergrowth = createUndergrowth(scene, heightAt, exclusion);
  const loader = new THREE.TextureLoader(); const textures: THREE.Texture[] = [];
  const texture = (url: string, srgb = false, repeat = true) => {
    const t = loader.load(url); if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; textures.push(t); return t;
  };
  const bark = new THREE.MeshStandardMaterial({ color: 0xb4b5aa, map: texture('/textures/bark-diff.jpg', true), normalMap: texture('/textures/bark-normal.jpg'), roughnessMap: texture('/textures/bark-rough.jpg'), roughness: .98, normalScale: new THREE.Vector2(1.25, 1.25), vertexColors: true });
  const logBark = bark.clone(); logBark.vertexColors = false; logBark.color.set(0xa4aa9c);
  const needlesMaterial = new THREE.MeshStandardMaterial({
    map: texture('/plantassets/pine/pine-diff.png', true, false),
    normalMap: texture('/plantassets/pine/pine-normal.png', false, false),
    roughnessMap: texture('/plantassets/pine/pine-rough.png', false, false),
    normalScale: new THREE.Vector2(.4, .4), alphaTest: .20, alphaToCoverage: true, side: THREE.DoubleSide, roughness: .94, color: 0xaab39b,
  });
  const birchBark=new THREE.MeshStandardMaterial({map:texture('/plantassets/forest-variety/birch-diff.png',true),normalMap:texture('/plantassets/forest-variety/birch-normal.png'),roughnessMap:texture('/plantassets/forest-variety/birch-rough.png'),roughness:.96,normalScale:new THREE.Vector2(.85,-.85),vertexColors:true,color:0xe5e4d8});
  birchBark.name='Scanned silver birch — peeling bark and fissures';
  const oakBark=new THREE.MeshStandardMaterial({map:texture('/plantassets/forest-variety/oak-diff.jpg',true),normalMap:texture('/plantassets/forest-variety/oak-normal.jpg'),roughnessMap:texture('/plantassets/forest-variety/oak-rough.jpg'),roughness:1,normalScale:new THREE.Vector2(.9,.9),vertexColors:true,color:0xdbd6bd});
  oakBark.name='Scanned oak bark';
  const broadleafMaterial=new THREE.MeshStandardMaterial({
    map:texture('/plantassets/forest-variety/broadleaf-diff.jpg',true,false),alphaMap:texture('/plantassets/forest-variety/broadleaf-alpha.jpg',false,false),
    normalMap:texture('/plantassets/forest-variety/broadleaf-normal.jpg',false,false),roughnessMap:texture('/plantassets/forest-variety/broadleaf-rough.jpg',false,false),
    normalScale:new THREE.Vector2(.21,.21),alphaTest:.44,alphaToCoverage:true,side:THREE.DoubleSide,roughness:.92,color:0xc4ceb2,vertexColors:true,
  });
  broadleafMaterial.name='Photographed broadleaf foliage';
  const windTime = { value: 0 };
  const forestEye={value:spawn.clone()};
  function fadeInstances(material:THREE.Material,from:number,to:number,kind?:'trunk'|'branch'){
    const compile=material.onBeforeCompile,cacheKey=material.customProgramCacheKey();
    // One fade works in the main view, reflections and shadow maps.
    material.alphaHash=true;
    material.customProgramCacheKey=()=>`${cacheKey}-stream-${from}-${to}-${kind??''}`;
    material.onBeforeCompile=(shader,renderer)=>{
      compile.call(material,shader,renderer);
      shader.uniforms.uForestEye=forestEye;
      shader.vertexShader=`uniform vec3 uForestEye;varying float vForestCoverage;${kind==='trunk'?'attribute float streamDetail;':''}\n${shader.vertexShader}`.replace(/void main\s*\(\s*\)\s*\{/,`void main(){
        vForestCoverage=1.;
        #ifdef USE_INSTANCING
          vec2 eyeOffset=instanceMatrix[3].xz-uForestEye.xz;
          ${kind==='branch'?'eyeOffset-=instanceMatrix[1].xz*.52;':''}
          float distanceSquared=dot(eyeOffset,eyeOffset);
          vForestCoverage=1.-smoothstep(${from**2}.,${to**2}.,distanceSquared);
          ${kind==='trunk'?`vForestCoverage*=1.-streamDetail*smoothstep(1225.,${TRUNK_DETAIL_END**2}.,distanceSquared);`:''}
          if(vForestCoverage<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
        #endif
      `);
      shader.fragmentShader=`varying float vForestCoverage;\n${shader.fragmentShader}`.replace('#include <alphahash_fragment>',`
        if(vForestCoverage<1.&&vForestCoverage<getAlphaHashThreshold(vPosition))discard;
      `);
    };
  }
  const foliageWind=(shader:THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uForestTime = windTime;
    shader.vertexShader = 'uniform float uForestTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 forestOrigin = instanceMatrix[3].xyz;
        float tip = clamp(transformed.y / 31.,0.,1.);
        float wind = uForestTime * .4 + forestOrigin.x * .09 + forestOrigin.z * .08;
        transformed.x += sin(wind) * tip * tip * .033;
        transformed.z += cos(wind*.83) * tip * tip * .018;
      #endif
    `);
  };
  needlesMaterial.onBeforeCompile=foliageWind;
  broadleafMaterial.onBeforeCompile=shader=>{
    foliageWind(shader);
    shader.vertexShader='attribute vec3 leafCenter;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`
      #include <begin_vertex>
      #ifdef USE_INSTANCING
        // Retain physical spray sizes as the tree stretches around its roots.
        vec3 treeScale=vec3(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz),length(instanceMatrix[2].xyz));
        transformed=leafCenter+(transformed-leafCenter)/max(treeScale,vec3(.01));
      #endif
    `);
  };
  broadleafMaterial.customProgramCacheKey=()=> 'silence-fixed-scale-broadleaf-crown';
  const rootDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const rootDistance = new THREE.MeshDistanceMaterial();
  for (const material of [bark, birchBark, oakBark, rootDepth, rootDistance]) {
    material.onBeforeCompile = shader => {
      shader.vertexShader = ROOT_SHADER_HEADER + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', ROOT_SHADER_DEFORM);
    };
  }
  varyDirectionalTexture(bark);varyDirectionalTexture(birchBark);varyDirectionalTexture(oakBark);
  varyDirectionalTexture(logBark);
  for(const m of [bark,birchBark,oakBark,rootDepth,rootDistance])fadeInstances(m,83,TREE_RANGE,'trunk');
  for(const m of [needlesMaterial,broadleafMaterial])fadeInstances(m,83,TREE_RANGE);
  const stoneMaterials=[createRockMaterial(false),createRockMaterial(false),createRockMaterial(false)];
  for(let i=1;i<3;i++){
    const m=stoneMaterials[i],prefix=i===1?'granite':'slate';
    m.map=texture(`/plantassets/forest-variety/${prefix}-diff.jpg`,true);m.normalMap=texture(`/plantassets/forest-variety/${prefix}-normal.jpg`);m.roughnessMap=texture(`/plantassets/forest-variety/${prefix}-rough.jpg`);
    m.color.set(0xffffff);if(WORLD_V2&&i===2)m.color.setRGB(3.2,3.2,3);m.name=i===1?'Scanned pale granite':'Scanned dark layered slate';
  }
  const stonesMaterial=stoneMaterials[0];
  const leafMaterial = new THREE.MeshStandardMaterial({map:broadleafMaterial.map,normalMap:broadleafMaterial.normalMap,normalScale:new THREE.Vector2(.25,.25), vertexColors: true, side: THREE.DoubleSide, roughness: .78 });
  fadeInstances(leafMaterial,26,34);
  const crownBark=logBark.clone();
  varyDirectionalTexture(crownBark);fadeInstances(crownBark,20,25,'branch');
  const grain = endgrainTextures(); textures.push(grain.map, grain.normalMap, grain.roughnessMap);
  const woodMaterial = new THREE.MeshStandardMaterial({ ...grain, color: 0xd9d3bf, normalScale: new THREE.Vector2(.6, .6), roughness: .94, side: THREE.DoubleSide });
  const geometries: THREE.BufferGeometry[] = [];
  // Keep crowns in smaller sectors for camera culling. Trunks use wider
  // sectors to limit draw calls in the sun and flashlight passes.
  const vegetation = createVegetationBatcher(group, 96);
  let definitionSerial = 0;
  function instances(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], capacity: number, cast = false, name = '', layer?: number, radius = 1, spatial = true): VegetationBatchDefinition {
    geometries.push(geometry);
    return {id: `forest-${definitionSerial++}`,geometry,material,capacity,castShadow:cast,name,layer,radius,spatial};
  }
  const rootAttributeNames = ['rootHeightsA', 'rootHeightsB', 'rootHeightsC', 'rootHeightsD'];
  const trunkCapacity=320;
  const trunkBatches=(lowDetail:boolean)=>Array.from({length:8},(_,i)=>{
    const geometry=trunkGeometry(482+i*394,i,lowDetail);
    for(const name of rootAttributeNames)geometry.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(trunkCapacity*4),4).setUsage(THREE.DynamicDrawUsage));
    const name=(i<2?'Scots pine':i<4?'Norway spruce':i<6?'Silver birch':'Old oak')+(lowDetail?' distant':'');
    const definition=instances(geometry,i<4?bark:i<6?birchBark:oakBark,trunkCapacity,true,name);
    definition.customDepthMaterial=rootDepth; definition.customDistanceMaterial=rootDistance; definition.sectorSize=192;
    return definition;
  });
  const trunks=trunkBatches(false),farTrunks=trunkBatches(true);
  const barkContacts = new WeakMap<Tree, NonNullable<SolidCollider['barkContact']>>();
  const barkRay = new THREE.Ray();
  const barkA = new THREE.Vector3(), barkB = new THREE.Vector3(), barkC = new THREE.Vector3(), barkHit = new THREE.Vector3();
  function barkContactFor(tree: Tree) {
    const cached = barkContacts.get(tree);
    if (cached) return cached;
    const geometry = trunks[tree.kind].geometry;
    const position = geometry.getAttribute('position'), index = geometry.index!;
    const cos = Math.cos(tree.yaw), sin = Math.sin(tree.yaw);
    const contact = (angle: number, y: number) => {
      const localY = (y - tree.y) / tree.height;
      const ring = TRUNK_RINGS.findIndex(height => height - .08 > localY) - 1;
      if (ring < 0) return;
      const dx = Math.cos(angle + tree.yaw), dz = Math.sin(angle + tree.yaw);
      barkRay.origin.set(dx * 4, localY, dz * 4);
      barkRay.direction.set(-dx, 0, -dz);
      // The bole is the first indexed part of the merged tree. Intersect only
      // the two rings at the foot's height, without testing any branches.
      const start = ring * TRUNK_SEGMENTS * 6, end = start + TRUNK_SEGMENTS * 6;
      let nearest = -Infinity, x = 0, z = 0;
      for (let i = start; i < end; i += 3) {
        barkA.fromBufferAttribute(position, index.getX(i));
        barkB.fromBufferAttribute(position, index.getX(i + 1));
        barkC.fromBufferAttribute(position, index.getX(i + 2));
        if (!barkRay.intersectTriangle(barkA, barkB, barkC, false, barkHit)) continue;
        const radial = barkHit.x * dx + barkHit.z * dz;
        if (radial > nearest) { nearest = radial; x = barkHit.x; z = barkHit.z; }
      }
      if (!Number.isFinite(nearest)) return;
      return {x: tree.x + (x * cos + z * sin) * tree.width + Math.cos(angle) * .025,
        y, z: tree.z + (z * cos - x * sin) * tree.width + Math.sin(angle) * .025};
    };
    barkContacts.set(tree, contact);
    return contact;
  }
  // The rebuilt world spends more on crowns, so a canopy reads as a canopy rather than bare limbs.
  const needleBough=canopyGeometry(WORLD_V2?30:16,WORLD_V2?1.35:1),leafBough=broadleafGeometry(WORLD_V2?36:22);
  const crowns=Array.from({length:8},(_,kind)=>{
    const geometry=crownGeometry(kind,kind<4?needleBough:leafBough);
    const {min,max}=geometry.boundingBox!;
    const horizontalRadius=Math.hypot(Math.max(-min.x,max.x),Math.max(-min.z,max.z));
    const definition=instances(geometry,kind<4?needlesMaterial:broadleafMaterial,512,false,kind<4?'Canopy conifer':'Canopy broadleaf');
    definition.sectorSize=56;
    return {definition,horizontalRadius,centerY:(min.y+max.y)*.5,verticalRadius:(max.y-min.y)*.5};
  });
  needleBough.dispose();leafBough.dispose();
  const crownWood = instances(canopyWoodGeometry(), crownBark, 6000, false, 'Canopy wood', 2, 5);
  const stones = Array.from({length:9},(_,i)=>{
    const g=createRockGeometry(182+i*83),type=Math.floor(i/3);
    if(type===1)g.scale(1.18,.82,.96);if(type===2)g.scale(1.35,.56,.88);
    return instances(g,stoneMaterials[type],180,true,['Mossy boulder','Weathered granite','Layered slate'][type],undefined,2.5,false);
  });
  const litter = instances(leafGeometry(), leafMaterial, 6500, false, 'Forest litter', 2, .8, false);
  const logs = instances(logGeometry(), [logBark, woodMaterial], 200, true, 'Fallen logs', undefined, 5, false);
  const sticks = instances(new THREE.CylinderGeometry(.013, .026, 1, 7, 2, false), logBark, 800, true, 'Forest sticks', undefined, 1, false);
  const stumps=[0,1,2].map(i=>instances(stumpGeometry(i),[logBark,woodMaterial],140,true,['Cut stump','Splintered snag','Hollow decayed stump'][i],undefined,2, false));

  const CELL=32,cells=new Map<string,ForestCell>();
  const layout=naturalLayout({heightAt,exclusion,biomeAt,riverX,riverPresence,roadZ,radius:WORLD_RADIUS});
  const colliders:Collider[]=[],solidColliders:SolidCollider[]=[];let collisionVersion=0;
  function buildCell(cx:number,cz:number):ForestCell{const cell=layout.cell(cx,cz);cells.set(`${cx},${cz}`,cell);return cell;}
  const propSurfaces=new WeakMap<Scatter,ReturnType<typeof createMeshSurface>>();
  function surfaceFor(item:Scatter,geometry:THREE.BufferGeometry){
    let surface=propSurfaces.get(item);
    if(!surface){
      dummy.updateMatrix();
      surface=createMeshSurface(geometry,dummy.matrix);
      propSurfaces.set(item,surface);
    }
    return surface;
  }
  const matrix = new THREE.Matrix4(); const dummy = new THREE.Object3D();
  const radialDirection = new THREE.Vector3(), across = new THREE.Vector3(), normal = new THREE.Vector3(), canopyScale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3();
  const crownTransforms=new WeakMap<Tree,Float32Array>();
  const litterTransforms=new WeakMap<Scatter,Float32Array>();
  function crownFor(tree:Tree){
    let transforms=crownTransforms.get(tree);
    if(transforms)return transforms;
    const branches=branchesByKind[tree.kind];
    transforms=new Float32Array(branches.length*16);
    for(let i=0;i<branches.length;i++){
      const b=branches[i],h=b.height*tree.height,a=tree.yaw+b.angle,length=b.length*tree.width;
      const c=Math.cos(a),s=Math.sin(a);
      radialDirection.set(c*tree.width,b.rise*tree.height,s*tree.width).normalize();
      across.set(-s,0,c);normal.crossVectors(across,radialDirection).normalize();
      matrix.makeBasis(across,radialDirection,normal);matrix.scale(canopyScale.setScalar(length));
      matrix.setPosition(tree.x+radialDirection.x*length*.52,tree.y+h+radialDirection.y*length*.52,tree.z+radialDirection.z*length*.52);
      matrix.toArray(transforms,i*16);
    }
    crownTransforms.set(tree,transforms);
    return transforms;
  }
  function litterFor(item:Scatter){
    let transforms=litterTransforms.get(item);
    if(transforms)return transforms;
    transforms=new Float32Array(7*16);
    for(let i=0;i<7;i++){
      const a=item.yaw+i*2.4,x=item.x+Math.cos(a)*(.15+i*.12),z=item.z+Math.sin(a)*(.15+i*.12);
      dummy.position.set(x,heightAt(x,z)+.008,z);dummy.rotation.set(.03,a,.03);dummy.scale.set(item.size*.85,1,item.size*(.65+i*.075));
      dummy.updateMatrix();dummy.matrix.toArray(transforms,i*16);
    }
    litterTransforms.set(item,transforms);
    return transforms;
  }
  const lastPosition = new THREE.Vector3(9999, 0, 9999);
  const lastRenderPosition = new THREE.Vector3(Infinity, 0, Infinity);
  let rendering = true;
  function place(definition: VegetationBatchDefinition, radius = definition.radius ?? 1): VegetationBatchHandle | undefined {
    if (!rendering) return undefined;
    dummy.updateMatrix();
    return vegetation.place(definition, dummy.matrix, radius);
  }
  function placeMatrix(definition: VegetationBatchDefinition, value: THREE.Matrix4, radius = definition.radius ?? 1): VegetationBatchHandle | undefined {
    if (!rendering) return undefined;
    return vegetation.place(definition, value, radius);
  }
  const rootSample = new THREE.Vector3();
  const rootOffsets = new WeakMap<Tree, Float32Array>();
  function groundRoots(tree: Tree, instance: number, mesh:THREE.InstancedMesh) {
    let offsets = rootOffsets.get(tree);
    if (!offsets) {
      offsets = new Float32Array(16);
      const position = mesh.geometry.getAttribute('position');
      const c = Math.cos(tree.yaw), s = Math.sin(tree.yaw);
      for (let i = 0; i < offsets.length; i++) {
        const x = position.getX(i) * tree.width, z = position.getZ(i) * tree.width;
        rootSample.set(tree.x + c * x + s * z, 0, tree.z - s * x + c * z);
        offsets[i] = (heightAt(rootSample.x, rootSample.z) - tree.y) / tree.height;
      }
      rootOffsets.set(tree, offsets);
    }
    for (let i = 0; i < rootAttributeNames.length; i++) {
      const attribute = mesh.geometry.getAttribute(rootAttributeNames[i]);
      const start = i * 4;
      attribute.setXYZW(instance, offsets[start], offsets[start + 1], offsets[start + 2], offsets[start + 3]);
    }
  }
  function build(player: THREE.Vector3, updateColliders:boolean, rebuildVisuals:boolean) {
    rendering=rebuildVisuals;
    if (rendering) vegetation.begin();
    if(updateColliders){
      lastPosition.copy(player);colliders.length=0;solidColliders.length=0;
    }
    const nearby:ForestCell[]=[],cx0=Math.floor(player.x/CELL),cz0=Math.floor(player.z/CELL);
    for(let dx=-4;dx<=4;dx++)for(let dz=-4;dz<=4;dz++){
      const cx=cx0+dx,cz=cz0+dz;
      if(Math.hypot((cx+.5)*CELL-player.x,(cz+.5)*CELL-player.z)>(rendering?128:118))continue;
      nearby.push(cells.get(`${cx},${cz}`)??buildCell(cx,cz));
    }
    for(const [key] of cells){const [x,z]=key.split(',').map(Number);if(Math.abs(x-cx0)>5||Math.abs(z-cz0)>5)cells.delete(key);}
    for(const cell of nearby)for (const tree of cell.trees) {
      const distance2 = (tree.x - player.x) ** 2 + (tree.z - player.z) ** 2;
      if(updateColliders&&distance2<=TREE_COLLISION_RANGE**2){
        const radius=.44*tree.width+.08;colliders.push({x:tree.x,z:tree.z,radius});
        solidColliders.push({kind:'capsule',ax:tree.x,az:tree.z,bx:tree.x,bz:tree.z,radius,minY:tree.y-.15,maxY:tree.y+31*tree.height,tag:'tree',barkContact:barkContactFor(tree)});
      }
      if (!rendering||distance2>(TREE_RANGE+FOREST_BUFFER)**2) continue;
      dummy.position.set(tree.x, tree.y, tree.z); dummy.rotation.set(0, tree.yaw, 0); dummy.scale.set(tree.width, tree.height, tree.width);
      dummy.updateMatrix();
      const trunkDefinition=distance2<(TRUNK_DETAIL_END+FOREST_BUFFER)**2?trunks[tree.kind]:farTrunks[tree.kind];
      const treeInstance=vegetation.allocate(trunkDefinition,tree.x,tree.z,7*tree.width,tree.y+15.5*tree.height,16.5*tree.height+2.5);
      if(treeInstance){
        treeInstance.mesh.setMatrixAt(treeInstance.index,dummy.matrix);
        groundRoots(tree,treeInstance.index,treeInstance.mesh);
      }
      const crown=crowns[tree.kind];
      const crownInstance=vegetation.allocate(crown.definition,tree.x,tree.z,crown.horizontalRadius*tree.width+.5,
        tree.y+crown.centerY*tree.height,crown.verticalRadius*tree.height+.5);
      if(crownInstance)crownInstance.mesh.setMatrixAt(crownInstance.index,dummy.matrix);
      if(distance2<(25+FOREST_BUFFER)**2){
        const transforms=crownFor(tree);
        for(const branch of crownBranches)placeMatrix(crownWood,matrix.fromArray(transforms,branch*16),5);
      }
    }
    if (rendering) for(const cell of nearby)for (const item of cell.scatter) {
      const distance2 = (item.x - player.x) ** 2 + (item.z - player.z) ** 2; if (distance2 > (34+FOREST_BUFFER+1)**2) continue;
      const transforms=litterFor(item);
      for(let l=0;l<transforms.length;l+=16)placeMatrix(litter,matrix.fromArray(transforms,l));
    }
    for(const cell of nearby)for (const item of cell.rubble) {
      if ((item.x - player.x) ** 2 + (item.z - player.z) ** 2 > 58 ** 2) continue;
      const type=Math.min(2,Math.floor(item.variant)),form=Math.floor(item.yaw*2)%3,definition=stones[type*3+form];
      dummy.rotation.set((item.variant%1)*.12,item.yaw,.07);dummy.scale.setScalar(item.size);
      const placed=item as Scatter&{grounded?:{y:number;minY:number;maxY:number;radius:number}};
      if(!placed.grounded){
        const p=definition.geometry.attributes.position,samples:{x:number;y:number;z:number}[]=[],v=new THREE.Vector3();let minY=Infinity,maxY=-Infinity,radius=0;
        for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).multiplyScalar(item.size).applyQuaternion(dummy.quaternion);minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);radius=Math.max(radius,Math.hypot(v.x,v.z));if(p.getY(i)<-.30)samples.push({x:v.x,y:v.y,z:v.z});}
        const y=groundedOrigin(samples,item.x,item.z,heightAt,Math.max(.025,item.size*.06));placed.grounded={y,minY:y+minY,maxY:y+maxY,radius};
      }
      const ground=placed.grounded;dummy.position.set(item.x,ground.y,item.z);
      place(definition,Math.max(2.5,ground.radius));
      if(updateColliders)solidColliders.push({kind:'capsule',ax:item.x,az:item.z,bx:item.x,bz:item.z,radius:ground.radius,minY:ground.minY,maxY:ground.maxY,tag:'rock',surfaceHeight:surfaceFor(item,definition.geometry)});
    }
    for(const cell of nearby)for (const item of cell.sticks) {
      if ((item.x - player.x) ** 2 + (item.z - player.z) ** 2 > 44 ** 2) continue;
      const dx = Math.sin(item.yaw) * item.size * .5, dz = Math.cos(item.yaw) * item.size * .5;
      const a = new THREE.Vector3(item.x - dx, heightAt(item.x - dx, item.z - dz) + .022, item.z - dz);
      const b = new THREE.Vector3(item.x + dx, heightAt(item.x + dx, item.z + dz) + .022, item.z + dz);
      direction.subVectors(b, a); const length=direction.length(); direction.normalize();
      dummy.position.copy(a).add(b).multiplyScalar(.5); dummy.quaternion.setFromUnitVectors(up, direction); dummy.scale.set(item.variant, length, item.variant); place(sticks,1);
      if(updateColliders)solidColliders.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:item.variant*.026,minY:Math.min(a.y,b.y)-.03,maxY:Math.max(a.y,b.y)+item.variant*.026,tag:'twig'});
    }
    for(const cell of nearby)for (const item of cell.deadfall) {
      if ((item.x - player.x) ** 2 + (item.z - player.z) ** 2 > 77 ** 2) continue;
      const dx = Math.sin(item.yaw) * item.size * .5, dz = Math.cos(item.yaw) * item.size * .5;
      const a = new THREE.Vector3(item.x - dx, heightAt(item.x - dx, item.z - dz) + item.variant * .66, item.z - dz);
      const b = new THREE.Vector3(item.x + dx, heightAt(item.x + dx, item.z + dz) + item.variant * .49, item.z + dz);
      direction.subVectors(b, a); const length = direction.length(); direction.normalize();
      dummy.position.copy(a).add(b).multiplyScalar(.5); dummy.quaternion.setFromUnitVectors(up, direction); dummy.scale.set(item.variant, length, item.variant); place(logs,5);
      if(updateColliders)solidColliders.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:item.variant,minY:Math.min(a.y,b.y)-item.variant,maxY:Math.max(a.y,b.y)+item.variant,tag:'fallen log',surfaceHeight:surfaceFor(item,logs.geometry)});
    }
    for(const cell of nearby)for(const item of cell.stumps){
      if((item.x-player.x)**2+(item.z-player.z)**2>65**2)continue;
      const type=Math.floor(item.variant*3),height=type===1?1.2+item.variant: .45+item.variant*.65;
      let base=item.y;
      for(let j=0;j<8;j++){const a=j*Math.PI*.25;base=Math.min(base,heightAt(item.x+Math.cos(a)*item.size,item.z+Math.sin(a)*item.size));}
      dummy.position.set(item.x,base-.06,item.z);dummy.rotation.set(0,item.yaw,0);dummy.scale.set(item.size,height,item.size);
      place(stumps[type],2);
      if(updateColliders)solidColliders.push({kind:'capsule',ax:item.x,az:item.z,bx:item.x,bz:item.z,radius:item.size*.91,minY:base-.1,maxY:base+height*(type===1?1.25:1.04),tag:'stump',surfaceHeight:surfaceFor(item,stumps[type].geometry)});
    }
    if(updateColliders)collisionVersion++;
    if (rendering) {
      vegetation.end();
      lastRenderPosition.copy(player);
    }
    group.userData.cells=cells.size;group.userData.species=trunks.map((definition,i)=>({name:definition.name,count:vegetation.count(definition)+vegetation.count(farTrunks[i])}));
  }
  build(spawn,true,true);
  let disposed = false;
  return {
    colliders,solidColliders,get collisionVersion(){return collisionVersion;},
    warmupTextures(renderer: THREE.WebGLRenderer) {
      // These scanned rock variants can first enter the camera on a ring
      // refresh. Upload their maps while the loading veil is still visible.
      for (const material of stoneMaterials.slice(1)) {
        for (const map of [material.map, material.normalMap, material.roughnessMap]) {
          if (map && map.image?.width > 0) renderer.initTexture(map);
        }
      }
    },
    update(time: number, player: THREE.Vector3) {
      if(disposed)return false;
      windTime.value = time;
      forestEye.value.copy(player);
      const changed=player.distanceToSquared(lastPosition)>20;
      const rebuilt=player.distanceToSquared(lastRenderPosition)>FOREST_STEP**2;
      if(changed||rebuilt)build(player,changed,rebuilt);
      undergrowth.update(time, player, rebuilt);
      return rebuilt;
    },
    dispose() {
      if (disposed) return; disposed = true; undergrowth.dispose(); scene.remove(group); vegetation.dispose(); geometries.forEach(g => g.dispose()); textures.forEach(t => t.dispose());
      for (const map of [stonesMaterial.map, stonesMaterial.normalMap, stonesMaterial.roughnessMap]) map?.dispose();
      [bark, birchBark, oakBark, logBark, crownBark, needlesMaterial, broadleafMaterial, ...stoneMaterials, leafMaterial, woodMaterial, rootDepth, rootDistance].forEach(m => m.dispose());cells.clear();
    },
  };
}
