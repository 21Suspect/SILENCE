import { WORLD_V2 } from '../../sim/world/world-flags';
import * as THREE from 'three';
import { createUndergrowth } from './undergrowth';
import { createRockGeometry, createRockMaterial } from './surfaces';
import { varyDirectionalTexture } from './texture-variation';
import { WORLD_RADIUS, biomeAt, groundMasks, riverX, riverPresence, roadZ, structureClearance } from '../../sim/world/world';
import { naturalLayout, groundedOrigin, type LayoutCell as ForestCell } from '../../sim/world/placement';
import type { SolidCollider } from '../../sim/world/collision';
import { createMeshSurface } from './surface-support';
import { stumpGeometry } from './forest-assets';
import { createVegetationBatcher, type VegetationBatchDefinition, type VegetationBatchHandle } from './vegetation-batches';
import { perfOn } from '../../core/perf-flags';
import { INSTANCE_CULL_HEADER, instanceCullGLSL, instanceCullSwitch } from './instance-cull';
import { BANDS, NEAR_PREFETCH, NEAR_TREES, barkPoint, loadAlders, loadNear, type AlderModel } from './alder';
import { createAlderMaterials, type AlderMaterials } from './alder-materials';
import { loadNature, type NatureVariant } from './nature-assets';
import { createSlice, runSlice, runToEnd } from '../../core/time-slice';

type Collider = { x: number; z: number; radius: number };
type Tree = { x: number; z: number; y: number; height: number; width: number; yaw: number; kind: number; seed: number };
type Scatter = { x: number; z: number; y: number; size: number; yaw: number; variant: number };
// How far a tree's foot is sunk below the ground the layout gave it, in metres a unit of its scale: the alders' roots flare out of the bark.
const FOOT_SINK=.06;
// Trees are placed out to TREE_RANGE+FOREST_BUFFER round the point the forest was last rebuilt at and faded by distance from the eye in
// the shader, so the placement stays valid until the player is FOREST_BUFFER from that point. A rebuild starts every FOREST_STEP and
// is spread over a few frames; the 1.5 m between the two is the room it has to finish in.
const FOREST_STEP=6, FOREST_BUFFER=FOREST_STEP+1.5, TREE_RANGE=98, TREE_COLLISION_RANGE=94, TRUNK_DETAIL_END=43, CROWN_DETAIL_START=22, CROWN_DETAIL_END=30;
// The crown band is a uniform (dev: __SILENCE__.perf.crownBand()), so other bands can be measured and compared live; both crowns
// are placed over CROWN_PLACE_*, so widen that to try a band outside it. 22/30 m against the earlier 30/40 (2026-11-12, 1920x1080,
// interleaved A/B): -0.1 ms at the canopy, -0.4 at spawn, -0.44 at dusk; judged in play to look the same.
// How far the scanned ground pieces are drawn. Each dissolves out over the last 8 m, so a rebuild never pops one in or out.
const ROCK_RANGE=58, BRANCH_RANGE=42, STUMP_RANGE=65, TRUNK_RANGE=77, PEBBLE_RANGE=24;
// Trees within this distance cast crown shadows (the sun's shadow map spans 72 m round the player, shadows.ts).
const SHADOW_RANGE=60;

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

export function createForest(scene: THREE.Scene, heightAt: (x: number, z: number) => number, exclusion: (x: number, z: number) => number, spawn: THREE.Vector3) {
  const group = new THREE.Group(); group.name = 'Forest — grounded trunks, pine crowns, deadfall and litter'; scene.add(group);
  const layout=naturalLayout({heightAt,exclusion,biomeAt,riverX,riverPresence,roadZ,radius:WORLD_RADIUS});
  const undergrowth = createUndergrowth(scene, heightAt, exclusion, (cx, cz) => layout.cell(cx, cz));
  const loader = new THREE.TextureLoader(); const textures: THREE.Texture[] = [];
  const texture = (url: string, srgb = false, repeat = true) => {
    const t = loader.load(url); if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; textures.push(t); return t;
  };
  const bark = new THREE.MeshStandardMaterial({ color: 0xb4b5aa, map: texture('/textures/bark-diff.jpg', true), normalMap: texture('/textures/bark-normal.jpg'), roughnessMap: texture('/textures/bark-rough.jpg'), roughness: .98, normalScale: new THREE.Vector2(1.25, 1.25), vertexColors: true });
  const logBark = bark.clone(); logBark.vertexColors = false; logBark.color.set(0xa4aa9c);
  const windTime = { value: 0 };
  const crownBand={value:new THREE.Vector2(CROWN_DETAIL_START,CROWN_DETAIL_END)};
  const forestEye={value:spawn.clone()};
  /** `cull`: the instance's bounds for per-instance frustum culling (instance-cull.ts), [bottom, top, radius] in model units. */
  function fadeInstances(material:THREE.Material,from:number,to:number,kind?:'trunk'|'branch'|'crown',cull?:readonly [number,number,number]){
    const compile=material.onBeforeCompile,cacheKey=material.customProgramCacheKey();
    // One fade works in the main view, reflections and shadow maps.
    material.alphaHash=true;
    material.customProgramCacheKey=()=>`${cacheKey}-stream-${from}-${to}-${kind??''}-${cull?.join(',')??''}`;
    material.onBeforeCompile=(shader,renderer)=>{
      compile.call(material,shader,renderer);
      shader.uniforms.uForestEye=forestEye;shader.uniforms.uInstanceCull=instanceCullSwitch;shader.uniforms.uCrownBand=crownBand;
      shader.vertexShader=`${INSTANCE_CULL_HEADER}uniform vec3 uForestEye;uniform vec2 uCrownBand;varying float vForestCoverage;${kind==='trunk'?'attribute float streamDetail;':kind==='crown'?'attribute float crownLod;':''}\n${shader.vertexShader}`.replace(/void main\s*\(\s*\)\s*\{/,`void main(){
        vForestCoverage=1.;
        #ifdef USE_INSTANCING
          vec2 eyeOffset=instanceMatrix[3].xz-uForestEye.xz;
          ${kind==='branch'?'eyeOffset-=instanceMatrix[1].xz*.52;':''}
          float distanceSquared=dot(eyeOffset,eyeOffset);
          vForestCoverage=1.-smoothstep(${from**2}.,${to**2}.,distanceSquared);
          ${kind==='trunk'?`vForestCoverage*=1.-streamDetail*smoothstep(1225.,${TRUNK_DETAIL_END**2}.,distanceSquared);`:''}
          ${kind==='crown'?`
          // The full crown thins out across the band as the light one fills in under it: a dissolve from one to the
          // other over ${CROWN_DETAIL_END-CROWN_DETAIL_START} m of walking, never a switch.
          float lodBlend=smoothstep(uCrownBand.x*uCrownBand.x,uCrownBand.y*uCrownBand.y,distanceSquared);
          vForestCoverage*=mix(1.-lodBlend,lodBlend,crownLod);`:''}
          if(vForestCoverage<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
        #endif
        ${cull?instanceCullGLSL(...cull):''}
      `);
      shader.fragmentShader=`varying float vForestCoverage;\n${shader.fragmentShader}`.replace('#include <alphahash_fragment>',`
        if(vForestCoverage<1.&&vForestCoverage<getAlphaHashThreshold(vPosition))discard;
      `);
    };
  }
  // Bark relief (bark-relief.ts): each scan's height map and how deep it stands in metres, between its black and white.
  varyDirectionalTexture(bark);
  varyDirectionalTexture(logBark);
  const stoneMaterials=[createRockMaterial(false),createRockMaterial(false),createRockMaterial(false)];
  for(let i=1;i<3;i++){
    const m=stoneMaterials[i],prefix=i===1?'granite':'slate';
    m.map=texture(`/plantassets/forest-variety/${prefix}-diff.jpg`,true);m.normalMap=texture(`/plantassets/forest-variety/${prefix}-normal.jpg`);m.roughnessMap=texture(`/plantassets/forest-variety/${prefix}-rough.jpg`);
    m.color.set(0xffffff);if(WORLD_V2&&i===2)m.color.setRGB(3.2,3.2,3);m.name=i===1?'Scanned pale granite':'Scanned dark layered slate';
  }
  const stonesMaterial=stoneMaterials[0];
  // The litter's leaves are cut from the Poly Haven tree_small_02 leaf atlas (public/plantassets/forest-variety).
  const leafMaterial = new THREE.MeshStandardMaterial({map:texture('/plantassets/forest-variety/broadleaf-diff.jpg',true,false),normalMap:texture('/plantassets/forest-variety/broadleaf-normal.jpg',false,false),normalScale:new THREE.Vector2(.25,.25), vertexColors: true, side: THREE.DoubleSide, roughness: .78 });
  fadeInstances(leafMaterial,26,34);
  const grain = endgrainTextures(); textures.push(grain.map, grain.normalMap, grain.roughnessMap);
  const woodMaterial = new THREE.MeshStandardMaterial({ ...grain, color: 0xd9d3bf, normalScale: new THREE.Vector2(.6, .6), roughness: .94, side: THREE.DoubleSide });
  const geometries: THREE.BufferGeometry[] = [];
  // Keep crowns in smaller sectors for camera culling. Trunks use wider
  // sectors to limit draw calls in the sun and flashlight passes.
  // Two copies of the trees round the player, as with the undergrowth: one is drawn while the other is rebuilt a slice at a time
  // (game/core/time-slice.ts), and they swap once it is whole, so nothing on screen is ever missing or half placed. Rebuilt in one go,
  // the forest cost 5 to 10 ms every 6 m of walking (and up to 100 ms while it still recomputed terrain heights).
  const buffers=[new THREE.Group(),new THREE.Group()];buffers[1].visible=false;group.add(buffers[0],buffers[1]);
  const batchers=[createVegetationBatcher(buffers[0],96),createVegetationBatcher(buffers[1],96)];
  let shown=0,vegetation=batchers[0],job:Generator<void,void,void>|undefined,jobVisuals=false;
  const slice=createSlice(2);
  let definitionSerial = 0;
  function instances(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], capacity: number, cast = false, name = '', layer?: number, radius = 1, spatial = true): VegetationBatchDefinition {
    geometries.push(geometry);
    return {id: `forest-${definitionSerial++}`,geometry,material,capacity,castShadow:cast,name,layer,radius,spatial};
  }
  // ---- The trees: Black Alders (alder.ts), each in up to four levels of detail that dissolve into one another by distance. ----
  // Not loaded yet, the forest has no trees (the loading veil waits for them); the cells, the scatter and the ground pieces carry on.
  type TreeEntry={model:AlderModel;definitions:Map<string,VegetationBatchDefinition>;shadow?:VegetationBatchDefinition};
  let entries:TreeEntry[]=[],pools:TreeEntry[][]=[],alderMaterials:AlderMaterials|undefined,nearDirty=false;
  // Which alders each of the old species' places take: tall and narrow for the pines and spruces, the smaller ones for the
  // birches, the broad open-grown ones for the oaks. A tree takes one by its own seed.
  const POOLS:string[][]=[
    ['Forest_01','Forest_02','Forest_03','Forest_05','Field_04'],['Forest_02','Forest_03','Forest_04','Forest_05','Forest_01'],
    ['Forest_04','Forest_05','Forest_06','Forest_07','Field_05','Forest_09'],['Field_01','Field_02','Field_03','Field_04','Field_05','Forest_08'],
  ];
  /**
   * The bands a level fades across. The level after the finest one comes in two variants: on a tree that has the finest level it
   * dissolves in under it, and on one that does not (only the nearest few do) it simply fills the near range.
   */
  function levelBands(model:AlderModel,i:number,under:boolean){
    const level=model.levels[i];
    const inBand=under?BANDS[0]:(i===0||(i===1&&model.near))?undefined:BANDS[level.from-1];
    return {inBand,outBand:level.to<3?BANDS[level.to]:undefined};
  }
  const levelKey=(i:number,under:boolean)=>under?`${i}u`:`${i}`;
  function defineLevel(entry:TreeEntry,i:number,under:boolean){
    const level=entry.model.levels[i],key=levelKey(i,under);
    if(!level.mesh||!alderMaterials||entry.definitions.has(key))return;
    const {inBand,outBand}=levelBands(entry.model,i,under);
    // Instances a model may hold at once: a handful of the finest, many of the light ones.
    const capacity=level===entry.model.near?NEAR_TREES+2:level.from>=2?420:240;
    const definition=instances(level.mesh.geometry,alderMaterials.forMesh(entry.model,key,level.mesh.parts,inBand,outBand),capacity,false,`${entry.model.name} ${key} L${level.lod}`);
    definition.sectorSize=level.to===0?40:level.to===1?96:192;entry.definitions.set(key,definition);
  }
  const entryFor=(tree:Tree)=>{const pool=pools[Math.floor(tree.kind/2)];return pool?.length?pool[(Math.imul(tree.seed,2654435761)>>>0)%pool.length]:undefined;};
  /** A tree's size: its own height number (.5 to 1.2) spread over .8 to 1.45 times the alder as scanned. */
  const scaleOf=(tree:Tree)=>THREE.MathUtils.clamp(.8+(tree.height-.5)*.9,.8,1.45);
  const barkContacts=new WeakMap<Tree,NonNullable<SolidCollider['barkContact']>>();
  function barkContactFor(tree:Tree,model:AlderModel,s:number){
    let contact=barkContacts.get(tree);
    if(!contact){const y=tree.y-FOOT_SINK*s;contact=(angle,at)=>barkPoint(model,tree.x,y,tree.z,tree.yaw,s,angle,at);barkContacts.set(tree,contact);}
    return contact;
  }
  loadAlders(POOLS.flat()).then(set=>{
    if(disposed)return;
    alderMaterials=createAlderMaterials(set.textureBase,forestEye,windTime,76,TREE_RANGE-4,textures);
    entries=set.models.map(model=>({model,definitions:new Map()}));
    for(const entry of entries){
      entry.model.levels.forEach((_,i)=>{defineLevel(entry,i,false);if(i===1&&entry.model.near)defineLevel(entry,i,true);});
      // Every tree within shadow range casts from its lightest mesh (nothing of it is drawn in the picture): the fine ones are far too
      // heavy for the sun's shadow map, which is redrawn several times a second.
      const mesh=entry.model.levels[entry.model.levels.length-1].mesh!;
      entry.shadow=instances(mesh.geometry,alderMaterials.casting(mesh.parts),200,true,`${entry.model.name} shadow`);entry.shadow.sectorSize=56;
    }
    pools=POOLS.map(names=>names.map(n=>entries.find(e=>e.model.name===n)).filter((e):e is TreeEntry=>!!e));
    rescan=true;
  }).catch(error=>console.warn('SILENCE: the alder trees did not load; the forest stays empty.',error));
  const stones = Array.from({length:9},(_,i)=>{
    const g=createRockGeometry(182+i*83),type=Math.floor(i/3);
    if(type===1)g.scale(1.18,.82,.96);if(type===2)g.scale(1.35,.56,.88);
    return instances(g,stoneMaterials[type],180,true,['Mossy boulder','Weathered granite','Layered slate'][type],undefined,2.5,false);
  });
  const litter = instances(leafGeometry(), leafMaterial, 6500, false, 'Forest litter', 2, .8, false);
  const logs = instances(logGeometry(), [logBark, woodMaterial], 200, true, 'Fallen logs', undefined, 5, false);
  const sticks = instances(new THREE.CylinderGeometry(.013, .026, 1, 7, 2, false), logBark, 800, true, 'Forest sticks', undefined, 1, false);
  const stumps=[0,1,2].map(i=>instances(stumpGeometry(i),[logBark,woodMaterial],140,true,['Cut stump','Splintered snag','Hollow decayed stump'][i],undefined,2, false));
  // The scanned pieces (nature-assets.ts) replace the procedural rocks, sticks, cut stumps and fallen logs once they have
  // loaded (behind the loading veil: the GLBs count as pending assets); the forest then rebuilds once. Until then, or if
  // they fail to load, the procedural pieces stand in. The tall splintered snag and the layered slate have no scan and stay.
  // Close up a scan runs out of texels: a 1.5 m boulder has about 250 px per metre at 2K where the screen resolves 393 at 2 m
  // (work/gfx/research/texture-audit.md). The ground's own lichen-rock layer (ground-layers.ts, already on the GPU for the
  // terrain's rock faces) is laid over it, projected three ways in world space at a finer scale than the scan, so no seam
  // of the scan's atlas shows: its normals perturb the scan's, its height darkens the crevices. It fades in inside 14 m.
  const rockDetail=(m:THREE.MeshStandardMaterial)=>{
    const layers=scene.userData.groundLayers as {color:THREE.Texture;surface:THREE.Texture}|undefined;
    if(!layers||!perfOn('rockDetail'))return;
    m.onBeforeCompile=shader=>{
      shader.uniforms.uDetailColor={value:layers.color};shader.uniforms.uDetailSurface={value:layers.surface};
      shader.vertexShader=`varying vec3 vDetailWorld,vDetailNormal;\n${shader.vertexShader}`.replace('#include <begin_vertex>',`#include <begin_vertex>
        vec4 detailWorld=vec4(transformed,1.);vec3 detailNormal=objectNormal;
        #ifdef USE_INSTANCING
          detailWorld=instanceMatrix*detailWorld;detailNormal=mat3(instanceMatrix)*detailNormal;
        #endif
        vDetailWorld=(modelMatrix*detailWorld).xyz;vDetailNormal=mat3(modelMatrix)*detailNormal;`);
      shader.fragmentShader=`uniform sampler2DArray uDetailColor,uDetailSurface;varying vec3 vDetailWorld,vDetailNormal;\n${shader.fragmentShader}`.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
        float detailFade=1.-smoothstep(6.,14.,length(vViewPosition));
        if(detailFade>0.){
          // How well the scan itself resolves here: its texels per screen pixel along the direction where they are fewest (the
          // smaller singular value of the uv-to-pixel Jacobian). A scan's atlas gives steep and under faces few texels,
          // stretched along the surface, so a boulder was crisp in one spot and smeared in the next. Where that falls under
          // about one texel a pixel, the scan's own colour is softened (its stretched streaks go) and the detail takes over.
          vec2 scanSize=vec2(textureSize(map,0)),ux=dFdx(vMapUv)*scanSize,uy=dFdy(vMapUv)*scanSize;
          float ja=dot(ux,ux),jb=dot(ux,uy),jc=dot(uy,uy),scanTexels=sqrt(max(0.,.5*(ja+jc-sqrt((ja-jc)*(ja-jc)+4.*jb*jb))));
          float starved=(1.-smoothstep(.4,1.2,scanTexels))*detailFade;
          // Triplanar with whiteout blending (Golus, "Normal Mapping for a Triplanar Shader", 2017); the layer is 2 m a tile,
          // laid at 0.8 m so its grain is finer than the scan's.
          vec3 nW=normalize(vDetailNormal),w=pow(abs(nW),vec3(4.));w/=dot(w,vec3(1.));
          vec3 p=vDetailWorld/.8,s=sign(nW);
          vec3 tx=texture(uDetailSurface,vec3(p.zy,6.)).xyz,ty=texture(uDetailSurface,vec3(p.xz,6.)).xyz,tz=texture(uDetailSurface,vec3(p.xy,6.)).xyz;
          vec2 dx=tx.xy*2.-1.,dy=ty.xy*2.-1.,dz=tz.xy*2.-1.;
          vec3 nx=vec3(dx+nW.zy,abs(nW.x)),ny=vec3(dy+nW.xz,abs(nW.y)),nz=vec3(dz+nW.xy,abs(nW.z));
          nx.z*=s.x;ny.z*=s.y;nz.z*=s.z;
          vec3 detailN=normalize(nx.zyx*w.x+ny.xzy*w.y+nz.xyz*w.z);
          normal=normalize(normal+(viewMatrix*vec4(detailN-nW,0.)).xyz*(.6*detailFade+.6*starved));
          vec4 cd=texture(uDetailColor,vec3(p.zy,6.))*w.x+texture(uDetailColor,vec3(p.xz,6.))*w.y+texture(uDetailColor,vec3(p.xy,6.))*w.z;
          // The layer's own mean (its last mip), so its colour only varies the scan's, never shifts it.
          vec3 mean=textureLod(uDetailColor,vec3(.5,.5,6.),12.).rgb;
          float grain=dot(cd.rgb,vec3(.2126,.7152,.0722))/max(dot(mean,vec3(.2126,.7152,.0722)),.01);
          vec3 scan=texture(map,vMapUv).rgb,soft=texture(map,vMapUv,2.).rgb;
          diffuseColor.rgb*=mix(vec3(1.),soft/max(scan,vec3(.002)),.6*starved);
          diffuseColor.rgb*=mix(1.,clamp(grain,.65,1.4),.1*detailFade+.25*starved)*mix(1.,.72+.56*cd.a,.45*detailFade+.2*starved);
          roughnessFactor=mix(roughnessFactor,clamp(roughnessFactor*(.85+.3*(tx.z*w.x+ty.z*w.y+tz.z*w.z)),0.,1.),detailFade);
        }`);
    };
    m.customProgramCacheKey=()=>'silence-rock-detail-v2';
  };
  type Scanned={definition:VegetationBatchDefinition;variant:NatureVariant;foot:number};
  let scanned:{rocks:Scanned[][];pebbles:Scanned[];branches:Scanned[];stumps:Scanned[];trunk:Scanned}|undefined;
  let rescan=false;
  loadNature().then(n=>{
    if(disposed)return;
    const fade=(material:THREE.MeshStandardMaterial,range:number,detail=false)=>{
      const m=material.clone();if(detail)rockDetail(m);fadeInstances(m,range-8,range);natureMaterials.push(m);
      for(const map of [m.map,m.normalMap,m.roughnessMap,m.metalnessMap])if(map&&!textures.includes(map))textures.push(map);
      return m;
    };
    const set=(variants:NatureVariant[],material:THREE.MeshStandardMaterial,capacity:number,cast:boolean,name:string,radius:number,layer?:number)=>variants.map((variant,i)=>{
      geometries.push(variant.geometry);
      // Where a rock is seated from: the bottom tenth of its height. A scan was lifted off real ground, so it already has a
      // flat underside, and seating it on anything higher buries the uphill side.
      const box=variant.geometry.boundingBox!,foot=box.min.y+(box.max.y-box.min.y)*.1;
      return {definition:instances(variant.geometry,material,capacity,cast,`${name} ${i+1}`,layer,radius,false),variant,foot};
    });
    const rocks=set(n.rocks.variants,fade(n.rocks.material,ROCK_RANGE,true),80,true,'Scanned boulder',2.5);
    scanned={
      rocks:[rocks,rocks],
      pebbles:set(n.pebbles.variants,fade(n.rocks.material,PEBBLE_RANGE,true),400,false,'Scanned pebble',.3,2),
      branches:set(n.branches.variants,fade(n.branches.material,BRANCH_RANGE),320,true,'Scanned fallen branch',1,2),
      stumps:n.stumps.map(s=>set(s.variants,fade(s.material,STUMP_RANGE),140,true,'Scanned stump',2)[0]),
      trunk:set(n.trunk.variants,fade(n.trunk.material,TRUNK_RANGE),200,true,'Scanned fallen trunk',5)[0],
    };
    // The trunk was photographed wet: its colour map averages 0.035 (linear), half the other scans and the forest floor
    // (0.07 to 0.10), and it read as charcoal. Brought to the level of dry dead bark.
    (scanned.trunk.definition.material as THREE.MeshStandardMaterial).color.setScalar(2);
    for(const s of [n.rocks,n.branches,...n.stumps,n.trunk])s.material.dispose();
    rescan=true;
  }).catch(error=>console.warn('Scanned forest scatter did not load; the procedural pieces stay.',error));
  const natureMaterials:THREE.Material[]=[];
  /** Picks a variant from a list by a scatter item's own random numbers, so the same item always gets the same piece. */
  const pick=<T,>(list:T[],item:Scatter)=>list[Math.floor((((item.variant%1)*7.31+item.yaw*.913)%1)*list.length)%list.length];
  const pebbleCells=new WeakMap<ForestCell,Float32Array>();
  /**
   * Loose stones for one cell: scree at the foot of each boulder, and a scatter weighted to where the ground is stony or worn
   * (path margins, the rock mask), never on the trodden middle of a path, roads, banks, beaches or footprints. Six numbers a
   * stone: x, y, z, size, yaw, variant. A generator so the ground tests run inside the rebuild's time slice.
   */
  function* growPebbles(cell:ForestCell,cx:number,cz:number,pause:()=>boolean):Generator<void,Float32Array,void>{
    let seed=(Math.imul(cx,73856093)^Math.imul(cz,19349663)^0x2c1b3c6d)>>>0;
    const r=()=>{seed=(seed+0x6d2b79f5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
    const out:number[]=[],variants=scanned!.pebbles.length;
    const add=(x:number,z:number,size:number)=>{if(exclusion(x,z)>.985)return;out.push(x,heightAt(x,z),z,size,r()*Math.PI*2,Math.floor(r()*variants));};
    for(const rock of cell.rubble){
      const count=Math.round(2+Math.min(rock.size,1.3)*10);
      for(let k=0;k<count;k++){const a=r()*Math.PI*2,d=rock.size*(1.05+r()*r()*1.6);add(rock.x+Math.cos(a)*d,rock.z+Math.sin(a)*d,.025+r()*r()*Math.min(.17,.05+rock.size*.12));}
    }
    for(let i=0;i<900;i++){
      if((i&31)===0&&pause())yield;
      const x=(cx+r())*CELL,z=(cz+r())*CELL,[worn,rock]=groundMasks(x,z);
      // Stones gather at the edge of a worn path (kicked aside), not on its trodden middle.
      if(r()>.035+rock*.5+worn*(1-worn)*1.6)continue;
      add(x,z,.02+r()*r()*r()*.13);
    }
    const loose=new Float32Array(out);pebbleCells.set(cell,loose);return loose;
  }

  const CELL=32,cells=new Map<string,ForestCell>();
  const colliders:Collider[]=[],solidColliders:SolidCollider[]=[];let collisionVersion=0;
  function buildCell(cx:number,cz:number):ForestCell{const cell=layout.cell(cx,cz);cells.set(`${cx},${cz}`,cell);return cell;}
  const propSurfaces=new WeakMap<Scatter,{geometry:THREE.BufferGeometry;surface:ReturnType<typeof createMeshSurface>}>();
  function surfaceFor(item:Scatter,geometry:THREE.BufferGeometry){
    let cached=propSurfaces.get(item);
    // Keyed on the mesh too: when the scans arrive, the same item is re-placed with a different piece.
    if(!cached||cached.geometry!==geometry){
      dummy.updateMatrix();
      cached={geometry,surface:createMeshSurface(geometry,dummy.matrix)};
      propSurfaces.set(item,cached);
    }
    return cached.surface;
  }
  const basisX=new THREE.Vector3(),basisY=new THREE.Vector3(),basisZ=new THREE.Vector3(),basis=new THREE.Matrix4();
  /** Turns `dummy` so the piece's long axis (x or z) runs along `along`, keeping its own up as close to world up as it can. */
  function alignAxis(along:THREE.Vector3,axis:'x'|'z'){
    if(axis==='z'){basisZ.copy(along);basisX.crossVectors(up,basisZ).normalize();basisY.crossVectors(basisZ,basisX);}
    else{basisX.copy(along);basisZ.crossVectors(basisX,up).normalize();basisY.crossVectors(basisZ,basisX);}
    dummy.quaternion.setFromRotationMatrix(basis.makeBasis(basisX,basisY,basisZ));
  }
  const matrix = new THREE.Matrix4(); const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3();
  const litterTransforms=new WeakMap<Scatter,Float32Array>();
  function litterFor(item:Scatter){
    let transforms=litterTransforms.get(item);
    if(transforms)return transforms;
    transforms=new Float32Array(7*16);
    for(let i=0;i<7;i++){
      const a=item.yaw+i*2.4,x=item.x+Math.cos(a)*(.15+i*.12),z=item.z+Math.sin(a)*(.15+i*.12);
      dummy.position.set(x,heightAt(x,z)+.008,z);dummy.rotation.set(.03,a,.03);dummy.scale.set(item.size*.85,1,item.size*(.65+i*.075));
      // The leaves spread up to 0.9 m from their anchor and are up to 1.5 m across: one that would lie in a building is left out.
      if(WORLD_V2&&structureClearance(x,z)<item.size*.45)dummy.scale.set(0,0,0);
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
  /**
   * Places the trees and their litter round `player` into the hidden copy and/or rebuilds the colliders, then swaps it on screen.
   * A generator so that update() can run it a slice a frame: with `sliced` it yields whenever the slice is used up.
   */
  function* build(player: THREE.Vector3, updateColliders:boolean, rebuildVisuals:boolean, sliced:boolean): Generator<void,void,void> {
    rendering=rebuildVisuals;
    if (rendering) { vegetation=batchers[1-shown]; vegetation.begin(); }
    const nextColliders:Collider[]=[],nextSolid:SolidCollider[]=[];
    let work=0;
    const pause=()=>sliced&&(++work&15)===0&&slice.over();
    const nearby:ForestCell[]=[],nearbyAt:[number,number][]=[],cx0=Math.floor(player.x/CELL),cz0=Math.floor(player.z/CELL);
    for(let dx=-4;dx<=4;dx++)for(let dz=-4;dz<=4;dz++){
      const cx=cx0+dx,cz=cz0+dz;
      if(Math.hypot((cx+.5)*CELL-player.x,(cz+.5)*CELL-player.z)>(rendering?128:118))continue;
      nearby.push(cells.get(`${cx},${cz}`)??buildCell(cx,cz));nearbyAt.push([cx,cz]);
      if(sliced&&slice.over())yield;
    }
    for(const [key] of cells){const [x,z]=key.split(',').map(Number);if(Math.abs(x-cx0)>5||Math.abs(z-cz0)>5)cells.delete(key);}
    // The finest level goes on the few nearest trees, once a model's mesh has arrived; the nearest trees' models start loading it.
    const nearest=new Set<Tree>();
    if(rendering&&entries.length){
      const candidates:{d:number;tree:Tree}[]=[];
      for(const cell of nearby)for(const tree of cell.trees){const d=(tree.x-player.x)**2+(tree.z-player.z)**2;if(d<(NEAR_PREFETCH+FOREST_BUFFER)**2)candidates.push({d,tree});}
      candidates.sort((a,b)=>a.d-b.d);
      candidates.forEach(({d,tree},rank)=>{
        const entry=entryFor(tree);if(!entry)return;
        if(d<NEAR_PREFETCH**2&&entry.model.nearState==='idle')loadNear(entry.model,()=>{nearDirty=true;});
        if(rank<NEAR_TREES&&entry.model.nearState==='ready'&&d<(BANDS[0][1]+FOREST_BUFFER)**2){defineLevel(entry,0,false);nearest.add(tree);}
      });
    }
    nearDirty=false;
    for(const cell of nearby)for (const tree of cell.trees) {
      const distance2 = (tree.x - player.x) ** 2 + (tree.z - player.z) ** 2;
      if(pause())yield;
      const entry=entryFor(tree);
      if(!entry)continue;
      const model=entry.model,s=scaleOf(tree);
      if(updateColliders&&distance2<=TREE_COLLISION_RANGE**2){
        const radius=model.boleRadius*s+.08;nextColliders.push({x:tree.x,z:tree.z,radius});
        nextSolid.push({kind:'capsule',ax:tree.x,az:tree.z,bx:tree.x,bz:tree.z,radius,minY:tree.y-.15,maxY:tree.y+model.height*s,tag:'tree',barkContact:barkContactFor(tree,model,s),crownBase:tree.y+model.crownBase*s});
      }
      if (!rendering||distance2>(TREE_RANGE+FOREST_BUFFER)**2) continue;
      dummy.position.set(tree.x, tree.y-FOOT_SINK*s, tree.z); dummy.rotation.set(0, tree.yaw, 0); dummy.scale.setScalar(s);
      dummy.updateMatrix();
      const withNear=nearest.has(tree);
      for(let i=0;i<model.levels.length;i++){
        const level=model.levels[i];
        if(level===model.near&&!withNear)continue;
        const under=withNear&&i===1,definition=entry.definitions.get(levelKey(i,under));
        if(!definition)continue;
        // Each level is placed over the distances it is drawn at, widened by FOREST_BUFFER (the placement is redone every FOREST_STEP metres).
        const {inBand,outBand}=levelBands(model,i,under);
        const from=inBand?Math.max(0,inBand[0]-FOREST_BUFFER):0,to=outBand?outBand[1]+FOREST_BUFFER:Infinity;
        if(distance2<from*from||distance2>to*to)continue;
        const instance=vegetation.allocate(definition,tree.x,tree.z,model.reach*s+.5,tree.y+model.height*s*.5,model.height*s*.5+.5);
        if(instance)instance.mesh.setMatrixAt(instance.index,dummy.matrix);
      }
      if(distance2<SHADOW_RANGE**2&&entry.shadow){
        const caster=vegetation.allocate(entry.shadow,tree.x,tree.z,model.reach*s+.5,tree.y+model.height*s*.5,model.height*s*.5+.5);
        if(caster)caster.mesh.setMatrixAt(caster.index,dummy.matrix);
      }
    }
    if (rendering) for(const cell of nearby)for (const item of cell.scatter) {
      if(pause())yield;
      const distance2 = (item.x - player.x) ** 2 + (item.z - player.z) ** 2; if (distance2 > (34+FOREST_BUFFER+1)**2) continue;
      const transforms=litterFor(item);
      for(let l=0;l<transforms.length;l+=16)placeMatrix(litter,matrix.fromArray(transforms,l));
    }
    for(const cell of nearby)for (const item of cell.rubble) {
      if(pause())yield;
      if ((item.x - player.x) ** 2 + (item.z - player.z) ** 2 > (ROCK_RANGE+FOREST_BUFFER) ** 2) continue;
      const type=Math.min(2,Math.floor(item.variant)),form=Math.floor(item.yaw*2)%3,scan=scanned&&type<2?pick(scanned.rocks[type],item):undefined;
      const definition=scan?.definition??stones[type*3+form],foot=scan?.foot??-.30;
      // A scan already rests the way it lay: only a slight lean, so its flat underside stays against the slope. Scanned
      // boulders are lower than the old egg-shaped ones; a quarter more height is still well within how rocks vary.
      dummy.rotation.set((item.variant%1)*(scan?.06:.12),item.yaw,scan?.03:.07);
      if(scan)dummy.scale.set(item.size*1.1,item.size*1.38,item.size*1.1);else dummy.scale.setScalar(item.size);
      const placed=item as Scatter&{grounded?:{definition:VegetationBatchDefinition;y:number;minY:number;maxY:number;radius:number}};
      if(placed.grounded?.definition!==definition){
        const p=definition.geometry.attributes.position,samples:{x:number;y:number;z:number}[]=[],v=new THREE.Vector3();let minY=Infinity,maxY=-Infinity,radius=0;
        for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).multiply(dummy.scale).applyQuaternion(dummy.quaternion);minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);radius=Math.max(radius,Math.hypot(v.x,v.z));if(p.getY(i)<foot)samples.push({x:v.x,y:v.y,z:v.z});}
        const y=groundedOrigin(samples,item.x,item.z,heightAt,Math.max(.025,item.size*(scan?.07:.06)));placed.grounded={definition,y,minY:y+minY,maxY:y+maxY,radius};
      }
      const ground=placed.grounded;dummy.position.set(item.x,ground.y,item.z);
      place(definition,Math.max(2.5,ground.radius));
      if(updateColliders)nextSolid.push({kind:'capsule',ax:item.x,az:item.z,bx:item.x,bz:item.z,radius:ground.radius,minY:ground.minY,maxY:ground.maxY,tag:'rock',surfaceHeight:surfaceFor(item,definition.geometry)});
    }
    if(rendering&&scanned)for(let c=0;c<nearby.length;c++){
      const cell=nearby[c],[cx,cz]=nearbyAt[c];
      if(Math.hypot((cx+.5)*CELL-player.x,(cz+.5)*CELL-player.z)>PEBBLE_RANGE+FOREST_BUFFER+CELL*.71)continue;
      const loose=pebbleCells.get(cell)??(yield* growPebbles(cell,cx,cz,pause));
      for(let i=0;i<loose.length;i+=6){
        if(pause())yield;
        const x=loose[i],z=loose[i+2],size=loose[i+3],yaw=loose[i+4];
        if((x-player.x)**2+(z-player.z)**2>(PEBBLE_RANGE+FOREST_BUFFER)**2)continue;
        const scan=scanned.pebbles[loose[i+5]];
        // Bedded about a third of its depth into the soil, tipped as it fell.
        dummy.position.set(x,loose[i+1]-scan.variant.geometry.boundingBox!.min.y*size*.62,z);dummy.rotation.set((yaw*3.1%1-.5)*.5,yaw,(yaw*7.7%1-.5)*.5);dummy.scale.setScalar(size);
        place(scan.definition,.3);
      }
    }
    for(const cell of nearby)for (const item of cell.sticks) {
      if(pause())yield;
      if ((item.x - player.x) ** 2 + (item.z - player.z) ** 2 > (scanned?BRANCH_RANGE+FOREST_BUFFER:44) ** 2) continue;
      const dx = Math.sin(item.yaw) * item.size * .5, dz = Math.cos(item.yaw) * item.size * .5;
      if(scanned){
        const scan=pick(scanned.branches,item);
        const a = new THREE.Vector3(item.x - dx, heightAt(item.x - dx, item.z - dz) - .012, item.z - dz);
        const b = new THREE.Vector3(item.x + dx, heightAt(item.x + dx, item.z + dz) - .012, item.z + dz);
        direction.subVectors(b, a); const length=direction.length(); direction.normalize();
        dummy.position.copy(a).add(b).multiplyScalar(.5); alignAxis(direction,'z'); dummy.scale.setScalar(length); place(scan.definition,1);
        if(updateColliders)nextSolid.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:scan.variant.size.x*length*.3,minY:Math.min(a.y,b.y)-.03,maxY:Math.max(a.y,b.y)+scan.variant.size.y*length,tag:'twig'});
        continue;
      }
      const a = new THREE.Vector3(item.x - dx, heightAt(item.x - dx, item.z - dz) + .022, item.z - dz);
      const b = new THREE.Vector3(item.x + dx, heightAt(item.x + dx, item.z + dz) + .022, item.z + dz);
      direction.subVectors(b, a); const length=direction.length(); direction.normalize();
      dummy.position.copy(a).add(b).multiplyScalar(.5); dummy.quaternion.setFromUnitVectors(up, direction); dummy.scale.set(item.variant, length, item.variant); place(sticks,1);
      if(updateColliders)nextSolid.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:item.variant*.026,minY:Math.min(a.y,b.y)-.03,maxY:Math.max(a.y,b.y)+item.variant*.026,tag:'twig'});
    }
    for(const cell of nearby)for (const item of cell.deadfall) {
      if(pause())yield;
      if ((item.x - player.x) ** 2 + (item.z - player.z) ** 2 > (scanned?TRUNK_RANGE+FOREST_BUFFER:77) ** 2) continue;
      const dx = Math.sin(item.yaw) * item.size * .5, dz = Math.cos(item.yaw) * item.size * .5;
      if(scanned){
        // The scan is one 3 m trunk: stretched to the log's length, with its girth kept within a third of in proportion so
        // the bark is never visibly smeared round or along it.
        const t=scanned.trunk,half=Math.max(t.variant.size.y,t.variant.size.z)*.5;
        const girth=THREE.MathUtils.clamp(item.variant/half,item.size*.75,item.size*1.35),radius=half*girth;
        const a = new THREE.Vector3(item.x - dx, heightAt(item.x - dx, item.z - dz) + radius * .72, item.z - dz);
        const b = new THREE.Vector3(item.x + dx, heightAt(item.x + dx, item.z + dz) + radius * .62, item.z + dz);
        direction.subVectors(b, a); const length = direction.length(); direction.normalize();
        dummy.position.copy(a).add(b).multiplyScalar(.5); alignAxis(direction,'x'); dummy.scale.set(length, girth, girth); place(t.definition,5);
        if(updateColliders)nextSolid.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius,minY:Math.min(a.y,b.y)-radius,maxY:Math.max(a.y,b.y)+radius,tag:'fallen log',surfaceHeight:surfaceFor(item,t.definition.geometry)});
        continue;
      }
      const a = new THREE.Vector3(item.x - dx, heightAt(item.x - dx, item.z - dz) + item.variant * .66, item.z - dz);
      const b = new THREE.Vector3(item.x + dx, heightAt(item.x + dx, item.z + dz) + item.variant * .49, item.z + dz);
      direction.subVectors(b, a); const length = direction.length(); direction.normalize();
      dummy.position.copy(a).add(b).multiplyScalar(.5); dummy.quaternion.setFromUnitVectors(up, direction); dummy.scale.set(item.variant, length, item.variant); place(logs,5);
      if(updateColliders)nextSolid.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:item.variant,minY:Math.min(a.y,b.y)-item.variant,maxY:Math.max(a.y,b.y)+item.variant,tag:'fallen log',surfaceHeight:surfaceFor(item,logs.geometry)});
    }
    for(const cell of nearby)for(const item of cell.stumps){
      if(pause())yield;
      if((item.x-player.x)**2+(item.z-player.z)**2>65**2)continue;
      const type=Math.floor(item.variant*3),height=type===1?1.2+item.variant: .45+item.variant*.65;
      let base=item.y;
      for(let j=0;j<8;j++){const a=j*Math.PI*.25;base=Math.min(base,heightAt(item.x+Math.cos(a)*item.size,item.z+Math.sin(a)*item.size));}
      const scan=scanned&&type!==1?scanned.stumps[type===0?0:1]:undefined;
      if(scan){
        // A scan's unit half-width runs to the tips of its root flare; its cut face is about half that, and `size` is the
        // radius of the cut face.
        const s=item.size*1.75,tall=.85+(item.yaw*3.7%1)*.35,top=scan.variant.size.y*s*tall;
        dummy.position.set(item.x,base-.05,item.z);dummy.rotation.set(0,item.yaw,0);dummy.scale.set(s,s*tall,s);
        place(scan.definition,2);
        if(updateColliders)nextSolid.push({kind:'capsule',ax:item.x,az:item.z,bx:item.x,bz:item.z,radius:s*.5,minY:base-.1,maxY:base+top,tag:'stump',surfaceHeight:surfaceFor(item,scan.definition.geometry)});
        continue;
      }
      dummy.position.set(item.x,base-.06,item.z);dummy.rotation.set(0,item.yaw,0);dummy.scale.set(item.size,height,item.size);
      place(stumps[type],2);
      if(updateColliders)nextSolid.push({kind:'capsule',ax:item.x,az:item.z,bx:item.x,bz:item.z,radius:item.size*.91,minY:base-.1,maxY:base+height*(type===1?1.25:1.04),tag:'stump',surfaceHeight:surfaceFor(item,stumps[type].geometry)});
    }
    if(updateColliders){
      // Swapped in whole, so the collision world never sees half a forest.
      colliders.length=0;solidColliders.length=0;
      for(const c of nextColliders)colliders.push(c);
      for(const c of nextSolid)solidColliders.push(c);
      lastPosition.copy(player);collisionVersion++;
    }
    if (rendering) {
      vegetation.end();
      buffers[1-shown].visible=true;buffers[shown].visible=false;shown=1-shown;
      lastRenderPosition.copy(player);
      group.userData.species=entries.map(e=>({name:e.model.name,count:[...e.definitions.values()].reduce((n,d)=>n+vegetation.count(d),0)}));
    }
    group.userData.cells=cells.size;
  }
  runToEnd(build(spawn.clone(),true,true,false));
  let disposed = false;
  return {
    colliders,solidColliders,get collisionVersion(){return collisionVersion;},
    /** Dev: the near-to-light crown band in metres (x start, y end), live. */
    crownBand:crownBand.value,
    warmupTextures(renderer: THREE.WebGLRenderer) {
      // These scanned rock variants can first enter the camera on a ring
      // refresh. Upload their maps while the loading veil is still visible.
      for (const material of stoneMaterials.slice(1)) {
        for (const map of [material.map, material.normalMap, material.roughnessMap]) {
          if (map && map.image?.width > 0) renderer.initTexture(map);
        }
      }
      // Every other map the forest owns (bark, birch and oak, needles, broadleaf, litter) reaches the GPU in the same frames: left to the
      // first draw, each one stalls the frame in which the first birch or oak comes into view for 50-100 ms.
      if (perfOn('streamWarmup')) for (const map of textures) if (map.image?.width > 0 && map.image?.complete !== false) renderer.initTexture(map);
    },
    update(time: number, player: THREE.Vector3) {
      if(disposed)return false;
      windTime.value = time;
      forestEye.value.copy(player);
      if(!job){
        const changed=rescan||player.distanceToSquared(lastPosition)>20;
        const rebuilt=rescan||nearDirty||player.distanceToSquared(lastRenderPosition)>FOREST_STEP**2;rescan=false;
        if(changed||rebuilt){job=build(player.clone(),changed,rebuilt,perfOn('slicedForest'));jobVisuals=rebuilt;}
      }
      let swapped=false;
      const worked=!!job;
      if(job){
        // The trees on screen only reach the edge of the fog while the player is within FOREST_BUFFER of where they were placed.
        // Past that (a jump, flying, or a very low frame rate) the rest of the rebuild is done now rather than show the gap.
        const late=player.distanceToSquared(lastRenderPosition)>(FOREST_BUFFER-.25)**2;
        if(late)runToEnd(job);
        if(late||runSlice(job,slice)){swapped=jobVisuals;job=undefined;}
      }
      undergrowth.update(time, player, worked);
      return swapped;
    },
    dispose() {
      if (disposed) return; disposed = true; job = undefined; undergrowth.dispose(); scene.remove(group); for (const b of batchers) b.dispose(); geometries.forEach(g => g.dispose()); textures.forEach(t => t.dispose());
      for (const map of [stonesMaterial.map, stonesMaterial.normalMap, stonesMaterial.roughnessMap]) map?.dispose();
      [bark, logBark, ...stoneMaterials, leafMaterial, woodMaterial, ...natureMaterials].forEach(m => m.dispose());alderMaterials?.dispose();cells.clear();
    },
  };
}
