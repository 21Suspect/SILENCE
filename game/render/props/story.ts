import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createRockGeometry, createRockMaterial, createWeatheredWoodMaterial } from '../world/surfaces';
import { varyDirectionalTexture } from '../world/texture-variation';
import type { SolidCollider } from '../../sim/world/collision';
import { WORLD_V2 } from '../../sim/world/world-flags';
import { structureClearance, vegetationExclusion } from '../../sim/world/world';

/** Quiet, unmarked traces of people who used to visit this part of the forest. */
export function createStory(scene: THREE.Scene, heightAt: (x: number, z: number) => number) {
  let seed = 83192;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];
  const root = new THREE.Group();
  const solidColliders:SolidCollider[]=[];
  root.name = 'Traces';
  scene.add(root);

  const wood = createWeatheredWoodMaterial();
  const endWood = createWeatheredWoodMaterial();
  endWood.color.set(0xf0e3c4);
  const rust = new THREE.MeshStandardMaterial({ color: 0x6e4a2f, roughness: .88, metalness: .28 });
  const stone = createRockMaterial();
  materials.push(wood, endWood, rust, stone);
  for (const material of [wood, endWood, stone]) {
    for (const texture of [material.map, material.normalMap, material.roughnessMap]) if (texture) textures.push(texture);
  }
  const batches = new Map<string,{material:THREE.Material,geometries:THREE.BufferGeometry[]}>();
  const chunks:THREE.Mesh[]=[];
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, position: THREE.Vector3, rotation = new THREE.Euler()) => {
    geometry.applyMatrix4(new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(1, 1, 1)));
    const key=`${material.uuid}:${Math.floor(position.x/32)},${Math.floor(position.z/32)}`;
    let batch=batches.get(key);if(!batch){batch={material,geometries:[]};batches.set(key,batch);}batch.geometries.push(geometry);
  };
  const timber = (a: THREE.Vector3, b: THREE.Vector3, width: number, depth = width, material: THREE.Material = wood) => {
    const direction = b.clone().sub(a);
    const length = direction.length();
    solidColliders.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:Math.max(width,depth)*.5,minY:Math.min(a.y,b.y)-Math.max(width,depth)*.5,maxY:Math.max(a.y,b.y)+Math.max(width,depth)*.5,tag:'weathered timber'});
    const bevel = Math.min(width, depth) * .13;
    const g = new RoundedBoxGeometry(width, length, depth, 2, bevel);
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    const grainU = random() * 8, grainV = random() * 8, warp = (random() - .5) * .018;
    const chipEnd = random() > .5 ? 1 : -1;
    const chipPhase = random() * 20;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const t = y / length + .5;
      const end = Math.pow(Math.abs(y) / (length * .5), 20);
      const chipped = Math.sin(x * 107 + z * 167 + chipPhase) * Math.min(.022, length * .015) * end;
      const notch = Math.exp(-Math.pow((t - .82) * 13, 2)) * bevel * 1.7;
      p.setXYZ(i,
        x + Math.sin(t * Math.PI) * warp - Math.max(0, x / (width * .5)) * notch,
        y + chipped * chipEnd,
        z + Math.sin(t * Math.PI * 1.3 + chipPhase) * Math.min(depth * .08, .004),
      );
      // Every exposed face has physical-scale scanned grain running along its timber.
      if (Math.abs(n.getY(i)) > .75) uv.setXY(i, x / .5 + grainU, z / .5 + grainV);
      else if (Math.abs(n.getX(i)) > Math.abs(n.getZ(i))) uv.setXY(i, z / .5 + grainU, y / .5 + grainV);
      else uv.setXY(i, x / .5 + grainU, y / .5 + grainV);
    }
    g.computeVertexNormals();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    add(g, material, a.clone().add(b).multiplyScalar(.5));
  };

  // The lean-to sits off the trail. A gap in its roof exposes the empty bench.
  // The rebuilt world replaces it with the cabin, so this one stands well out of sight.
  const sx = WORLD_V2 ? 9000 : -18, sz = WORLD_V2 ? 9000 : -46, yaw = .22;
  const floor = heightAt(sx, sz) + .02;
  const point = (x: number, y: number, z: number) => new THREE.Vector3(
    sx + x * Math.cos(yaw) + z * Math.sin(yaw), floor + y,
    sz - x * Math.sin(yaw) + z * Math.cos(yaw),
  );
  for (const x of [-1.57, 1.57]) {
    for (const z of [-.94, .94]) {
      const top = z > 0 ? 2.55 : 1.96;
      const p = point(x, 0, z); p.y = heightAt(p.x, p.z) - .1;
      timber(p, point(x + .025, top, z - .02), .115, .135);
    }
    timber(point(x, 2.58, 1.12), point(x, 1.91, -1.12), .105, .13);
    timber(point(x, 1.58, -.92), point(x > 0 ? x - .6 : x + .6, 1.98, -.92), .075, .09);
  }
  timber(point(-1.72, 2.5, .94), point(1.72, 2.5, .94), .125, .13);
  timber(point(-1.72, 1.96, -.94), point(1.72, 1.96, -.94), .125, .13);
  const roofY = (z: number) => 2.25 + z * .3;
  for (let i = 0; i < 18; i++) {
    if ([4, 5, 11, 15].includes(i)) continue;
    const x = -1.78 + i * .21;
    let za = -1.22, zb = 1.23;
    if (i === 6) zb = -.05;
    if (i === 12) za = .48;
    timber(point(x, roofY(za) + .06, za), point(x + (random() - .5) * .03, roofY(zb) + .06, zb), .19, .028);
    for (const z of [-.94, .94]) {
      if (z < za || z > zb) continue;
      add(new THREE.SphereGeometry(.008, 5, 3), rust, point(x, roofY(z) + .081, z));
    }
  }
  // A few remaining windbreak boards, each warped a little differently.
  for (let i = 0; i < 6; i++) {
    const x0 = i === 4 ? -.88 : -1.59;
    const x1 = i === 2 ? .44 : 1.59;
    timber(point(x0, .65 + i * .17, -.94), point(x1, .65 + i * .17 + (random() - .5) * .026, -.94), .143, .023);
  }
  for (const x of [-1.03, 1.03]) {
    for (const z of [-.57, -.18]) {
      const bottom = point(x, 0, z); bottom.y = heightAt(bottom.x, bottom.z) - .06;
      timber(bottom, point(x + .035, .48, z), .085, .085);
    }
    timber(point(x, .44, -.66), point(x, .44, -.08), .065, .09);
  }
  for (const z of [-.56, -.36, -.16]) timber(point(-1.43, .51, z), point(1.43, .51, z + .016), .035, .17);
  timber(point(-1.1, .25, -.56), point(1.1, .25, -.56), .065, .065);
  // Collapsed boards have sunk partly into the leaf litter.
  for (let i = 0; i < 3; i++) {
    const a = point(-.7 + i * .6, 0, .28 + i * .23), b = point(.24 + i * .5, 0, 1.45 + i * .12);
    a.y = heightAt(a.x, a.z) + .027; b.y = heightAt(b.x, b.z) + .024;
    timber(a, b, .17, .025);
  }
  // Two rusted straps remain where the front beam was once reinforced.
  for (const x of [-1.56, 1.56]) add(new THREE.BoxGeometry(.13, .22, .008), rust, point(x, 2.4, 1.015), new THREE.Euler(0, yaw, 0));

  // These traces stand at fixed spots laid out for the first world. In the rebuilt one a building or a yard may stand there now
  // (the cabin was built over the last three boundary stones, one poking through its floor): nothing is placed within a metre of
  // a building's footprint or on a path or trodden yard. (The waymarker and the heath fence below are clear of all of them.)
  const clear = (x: number, z: number) => !WORLD_V2 || (structureClearance(x, z) > 1 && vegetationExclusion(x, z) < .5);
  // An old line of small boundary stones no longer quite follows the path.
  for (let i = 0; i < 8; i++) {
    const x = -10.8 - i * .57 + (random() - .5) * .4, z = -22 - i * 2.6;
    const radius = .15 + random() * .16, tall = .24 + random() * .18;
    if (!clear(x, z)) { random(); random(); random(); continue; }
    const g = createRockGeometry(813 + i * 51);
    g.scale(radius, tall, radius * .81);
    solidColliders.push({kind:'capsule',ax:x,az:z,bx:x,bz:z,radius,minY:heightAt(x,z)-tall*.61,maxY:heightAt(x,z)+tall*1.39,tag:'boundary stone'});
    add(g, stone, new THREE.Vector3(x, heightAt(x, z) + tall * .39, z), new THREE.Euler((random() - .5) * .4, random() * 6, (random() - .5) * .4));
  }

  const loader = new THREE.TextureLoader();
  const barkMap = loader.load('/textures/bark-diff.jpg'); barkMap.colorSpace = THREE.SRGBColorSpace;
  const barkNormal = loader.load('/textures/bark-normal.jpg');
  for (const t of [barkMap, barkNormal]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(.7, 2.2); t.anisotropy = 8; textures.push(t); }
  const bark = new THREE.MeshStandardMaterial({ map: barkMap, normalMap: barkNormal, normalScale: new THREE.Vector2(.7, .7), color: 0xc7cbb9, roughness: .94 });
  varyDirectionalTexture(bark);
  materials.push(bark);
  const px = -4, pz = -18, py = heightAt(px, pz);
  solidColliders.push({kind:'capsule',ax:px,az:pz,bx:px-.12,bz:pz-.06,radius:.105,minY:py-.1,maxY:py+2.1,tag:'broken waymarker'});
  const stake = new THREE.CylinderGeometry(.058, .105, 2.05, 7, 5);
  const sp = stake.attributes.position;
  for (let i = 0; i < sp.count; i++) if (sp.getY(i) > 1) sp.setY(i, sp.getY(i) + Math.sin(sp.getX(i) * 50 + sp.getZ(i) * 30) * .11);
  stake.computeVertexNormals();
  add(stake, bark, new THREE.Vector3(px, py + .96, pz), new THREE.Euler(.03, .4, -.06));
  // Splintered pale scoring on the near face is visible only at close range.
  for (let i = 0; i < 3; i++) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -.022 + i * .024, 1.21, .075, -.014 + i * .022, 1.19, .079,
      -.005 + i * .021, .91 - i * .022, .088,
    ], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, .5, 0], 2));
    add(g, endWood, new THREE.Vector3(px + .05, py, pz));
  }

  // A frayed scrap caught around the post; its shape hangs under its own weight.
  const clothCanvas = document.createElement('canvas'); clothCanvas.width = 128; clothCanvas.height = 256;
  const cc = clothCanvas.getContext('2d')!;
  cc.fillStyle = '#6d6a58'; cc.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 1900; i++) {
    cc.fillStyle = `rgba(34,35,25,${random() * .19})`;
    cc.fillRect(random() * 128, random() * 256, random() * 5 + .3, random() * 15 + 1);
  }
  const clothMap = new THREE.CanvasTexture(clothCanvas); clothMap.colorSpace = THREE.SRGBColorSpace; textures.push(clothMap);
  const cloth = new THREE.MeshStandardMaterial({ map: clothMap, color: 0xd0c9b3, roughness: 1, side: THREE.DoubleSide });
  materials.push(cloth);
  const cg = new THREE.PlaneGeometry(.21, .62, 10, 24), cp = cg.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const t = (.31 - cp.getY(i)) / .62, u = cp.getX(i) / .21;
    cp.setXYZ(i,
      cp.getX(i) * (.28 + t * .65) + Math.sin(t * 3.7) * .045,
      cp.getY(i) + (t > .95 ? Math.sin(u * 57) * .024 : 0),
      .08 + Math.sin(t * 4) * .07 + Math.sin(u * 13 + t * 5) * .012 * t,
    );
  }
  cg.computeVertexNormals();
  add(cg, cloth, new THREE.Vector3(px - .07, py + 1.21, pz + .025), new THREE.Euler(0, .15, -.15));
  add(new THREE.TorusGeometry(.076, .011, 4, 12), cloth, new THREE.Vector3(px - .08, py + 1.53, pz), new THREE.Euler(Math.PI / 2, .03, -.06));

  // A moss-filled foundation at the edge of the distant grove, with a collapsed
  // wall and an open doorway. Every stone has a matching physical footprint.
  const ruinX=176,ruinZ=-214;
  for(let side=0;side<(WORLD_V2?0:3);side++)for(let i=0;i<14;i++){
    if(side===0&&i>5&&i<9)continue;
    const x=ruinX+(side===1?-3.2:side===2?3.2:-3.2+i*.49);
    const z=ruinZ+(side===0?-3.2:-3.2+i*.49);
    const layers=1+Math.floor(random()*3);
    let support=heightAt(x,z)-.025;
    for(let j=0;j<layers;j++){
      const rx=x+(random()-.5)*.12,rz=z+(random()-.5)*.12;
      const g=createRockGeometry(2201+side*181+i*17+j);g.scale(.34,.22,.29);g.computeBoundingBox();
      const ry=support-g.boundingBox!.min.y-.045,minY=ry+g.boundingBox!.min.y;support=ry+g.boundingBox!.max.y;
      add(g,stone,new THREE.Vector3(rx,ry,rz),new THREE.Euler(0,random()*6,0));
      solidColliders.push({kind:'capsule',ax:rx,az:rz,bx:rx,bz:rz,radius:.32,minY,maxY:support,tag:'ruined stone wall'});
    }
  }
  // Rotting fencing on the open heath provides another unmarked destination.
  for(let i=0;i<9;i++){
    const x=-235+i*2.4,z=167+Math.sin(i*.65)*1.2,y=heightAt(x,z);
    const a=new THREE.Vector3(x,y-.12,z),b=new THREE.Vector3(x+.15,y+.85+random()*.3,z+.08);
    timber(a,b,.11);
    if(i<8&&i!==3)for(const h of [.37,.74]){
      const nx=-235+(i+1)*2.4,nz=167+Math.sin((i+1)*.65)*1.2;
      timber(new THREE.Vector3(x,y+h,z),new THREE.Vector3(nx,heightAt(nx,nz)+h-(i===5?.4:0),nz),.085,.035);
    }
  }

  for (const {material, geometries} of batches.values()) {
    // Normalize attributes so indexed boxes, cylinders, and hand-cut splinters can share a draw.
    const normalized = geometries.map(g => g.index ? g.toNonIndexed() : g);
    const geometry = mergeGeometries(normalized, false);
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true;
      geometry.computeBoundingSphere();chunks.push(mesh);root.add(mesh);
    }
    for (const g of geometries) g.dispose();
    for (const g of normalized) if (!geometries.includes(g)) g.dispose();
  }
  return {
    solidColliders,
    update(player:THREE.Vector3){let changed=false;for(const mesh of chunks){const center=mesh.geometry.boundingSphere!.center;const visible=Math.hypot(center.x-player.x,center.z-player.z)<130;if(mesh.visible!==visible){mesh.visible=visible;changed=true;}}return changed;},
    dispose() {
      root.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      scene.remove(root);
    },
  };
}
