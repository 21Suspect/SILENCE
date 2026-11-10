import terrainWorkerUrl from './terrain-worker.ts?worker&url';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRiver } from './river';
import { textureVariationGLSL } from './texture-variation';
import { createRockGeometry, createRockMaterial, createWeatheredWoodMaterial } from './surfaces';
import { roadSurface } from './road-surface';

import { WORLD_EXTENT, WORLD_RADIUS, TERRAIN_CHUNK, TERRAIN_STEP, hash, noise, pathX, riverX, roadZ, riverPresence, biomeAt, cacheTerrainBlock, heightAt, vegetationExclusion, worldGeographyGLSL, waterHeightAt } from './world';
import type { SolidCollider } from './collision';
import { createMeshSurface } from './surface-support';
import { naturalLayout, groundedOrigin, type LayoutScatter } from './placement';
import { WORLD_V2, WORLD_SEED } from './world-flags';
import { groundGeometry, buildTerrainTile, unpackTerrainTile, type TerrainTile, type PreparedTerrainTile } from './terrain-geometry';
export { hash, noise, pathX, riverX, roadZ, roadDistance, heightAt } from './world';

export const exclusion=vegetationExclusion;
const DETAIL_RADIUS=112, TRANSITION_WIDTH=18, PREFETCH_RADIUS=144, RETAIN_RADIUS=160;
const horizonColor=0x99998f;
const horizonTextureGLSL=`
  vec3 horizonTexture(sampler2D tex,vec3 p,vec3 n){
    vec3 w=pow(abs(normalize(n)),vec3(4.));w/=max(dot(w,vec3(1.)),.0001);
    return texture2D(tex,p.zy/3.).rgb*w.x+texture2D(tex,p.xz/3.).rgb*w.y+texture2D(tex,p.xy/3.).rgb*w.z;
  }
`;

function tileDistanceSquared(x:number,z:number,px:number,pz:number) {
  const minX=x*TERRAIN_CHUNK,minZ=z*TERRAIN_CHUNK;
  const dx=Math.max(0,minX-px,px-minX-TERRAIN_CHUNK);
  const dz=Math.max(0,minZ-pz,pz-minZ-TERRAIN_CHUNK);
  return dx*dx+dz*dz;
}

export function createTerrain(scene: THREE.Scene, spawn: THREE.Vector3) {
  const loader = new THREE.TextureLoader();
  const textures:THREE.Texture[]=[];
  const solidColliders:SolidCollider[]=[];
  const distantProps:{object:THREE.Object3D;x:number;z:number;radius:number}[]=[];
  const texture = (name: string, srgb = false) => {
    const t = loader.load(name.startsWith('/')?name:`/textures/${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(200, 200); t.anisotropy = scene.userData.maxAnisotropy??8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    return t;
  };
  const layout=naturalLayout({heightAt,exclusion,biomeAt,riverX,riverPresence,roadZ,radius:WORLD_RADIUS});
  const nearCenter=new THREE.Vector2(),nearCoverage={value:DETAIL_RADIUS};
  const distantTint=new THREE.Color(horizonColor);
  const material = new THREE.MeshStandardMaterial({
    map: texture('ground-diff', true), normalMap: texture('ground-normal'), roughnessMap: texture('ground-rough'),
    normalScale: new THREE.Vector2(.75, .75), roughness: .94, color: 0x9b9c87,
  });
  // Pack roughness in normal-map alpha to leave texture units for flashlight shadows/cookie on 16-unit mobile GPUs.
  const riverbedMap=texture('riverbed-diff',true),riverbedNormal=texture('/textures/riverbed-normal-rough.png');
  const roadMap=texture('road-diff',true),roadNormal=texture('/textures/road-normal-rough.png');
  const leavesMap=texture('leaves-diff',true),leavesNormal=texture('leaves-normal');
  const stoneMap=texture('/plantassets/forest-variety/granite-diff.jpg',true),stoneNormal=texture('/plantassets/forest-variety/granite-normal.jpg');
  material.onBeforeCompile = (shader) => {
    // The rebuilt world's road is worked out in game/road-surface.ts; the original keeps its narrow dirt track.
    const road=WORLD_V2?roadSurface():undefined;
    shader.uniforms.uNearCenter={value:nearCenter};shader.uniforms.uNearCoverage=nearCoverage;shader.uniforms.uDistantTint={value:distantTint};
    shader.uniforms.uRoadMap={value:roadMap};shader.uniforms.uRoadNormal={value:roadNormal};
    shader.uniforms.uLeavesMap={value:leavesMap};shader.uniforms.uLeavesNormal={value:leavesNormal};
    shader.uniforms.uStoneMap={value:stoneMap};shader.uniforms.uStoneNormal={value:stoneNormal};
    shader.uniforms.uBedMap={value:riverbedMap};shader.uniforms.uBedNormal={value:riverbedNormal};
    shader.vertexShader = `uniform vec2 uNearCenter;uniform float uNearCoverage;attribute float horizonY;attribute float treeGround;attribute vec4 biome;varying float vTreeGround;varying vec4 vBiome;varying vec3 vGroundPosition;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float edge=length(position.xz-uNearCenter);
      transformed.y=mix(transformed.y,horizonY,smoothstep(max(uNearCoverage*.65,uNearCoverage-${TRANSITION_WIDTH}.),uNearCoverage+.001,edge));
    `).replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;vBiome=biome;vTreeGround=treeGround;');
    shader.fragmentShader = `varying vec3 vGroundPosition;varying vec4 vBiome;varying float vTreeGround;
      uniform sampler2D uBedMap,uBedNormal,uRoadMap,uRoadNormal,uLeavesMap,uLeavesNormal,uStoneMap,uStoneNormal;
      uniform vec2 uNearCenter;uniform float uNearCoverage;uniform vec3 uDistantTint;
      ${textureVariationGLSL}
      ${worldGeographyGLSL}
      ${horizonTextureGLSL}
      ${road?road.functions:`float roadHalfWidth(float x){return 1.55+worldNoise(vec2(x*.047,118.))*.65+worldNoise(vec2(x*.17,72.))*.15;}
      float roadWeight(vec3 p){
        float width=roadHalfWidth(p.x);
        float erosion=(surfaceNoise(p.xz*.8)-.5)*.24+(surfaceNoise(p.xz*2.3)-.5)*.1;
        return (1.-smoothstep(width-.55,width+.48,abs(p.z-roadCenter(p.x))+erosion))*roadPresence(p.xz);
      }`}
      float bedWeight(vec3 p){float edge=1.-smoothstep(2.7,8.,streamOffset(p.xz));float damp=1.-smoothstep(.10,1.35,p.y-streamHeight(p.z));return clamp(edge*damp*streamPresence(p.z),0.,1.);}
      ${shader.fragmentShader}`.replace('#include <map_fragment>', `
      vec2 p=vGroundPosition.xz;
      float detailDistance=length(p-uNearCenter);
      if(detailDistance>=uNearCoverage)discard;
      float distantBlend=smoothstep(max(uNearCoverage*.65,uNearCoverage-${TRANSITION_WIDTH}.),uNearCoverage,detailDistance);
      vec2 groundUv=p*vec2(1.,-1.);
      // Mild smooth distortion and stochastic patches have no world-space tile grid.
      groundUv+=vec2(surfaceNoise(p*.18),surfaceNoise(p*.18+27.))*.38;
      TexturePatch soilPatch=groundTexturePatch(groundUv/2.4);
      TexturePatch leafPatch=groundTexturePatch(groundUv/1.3+vec2(57.,9.));
      vec3 slopeNormal=abs(normalize(cross(dFdx(vGroundPosition),dFdy(vGroundPosition))));
      vec3 stoneWeights=pow(slopeNormal,vec3(4.));stoneWeights/=max(dot(stoneWeights,vec3(1.)),.0001);
      TexturePatch stoneX=groundTexturePatch(vGroundPosition.zy/3.+vec2(21.,48.));
      TexturePatch stoneY=groundTexturePatch(vGroundPosition.xz/3.+vec2(21.,48.));
      TexturePatch stoneZ=groundTexturePatch(vGroundPosition.xy/3.+vec2(21.,48.));
      float rootBlend=smoothstep(.025,.96,vTreeGround)*(.84+surfaceNoise(p*3.1+19.)*.16);
      float leafBlend=clamp(max(vBiome.y+vBiome.z*.55,rootBlend*.68),0.,1.);
      float stoneBlend=clamp(vBiome.w+vBiome.z*.24+(1.-slopeNormal.y)*vBiome.w*.3,0.,1.);
      TexturePatch roadPatch=groundTexturePatch(groundUv/2.+vec2(47.,13.));
      TexturePatch gravelPatch=groundTexturePatch(groundUv/2.2+vec2(9.,31.));
      ${road?road.mask:'float road=roadWeight(vGroundPosition),bank=bedWeight(vGroundPosition);'}
      vec3 groundColor=vec3(0.),leafColor=vec3(0.);
      if(bank<1.){
        groundColor=samplePatch(map,soilPatch).rgb*diffuseColor.rgb;
        leafColor=samplePatch(uLeavesMap,leafPatch).rgb;
        if(leafBlend>.002)groundColor=mix(groundColor,leafColor*.74,leafBlend);
        if(stoneBlend>.002){
          vec3 stoneTone=(samplePatch(uStoneMap,stoneX).rgb*stoneWeights.x+samplePatch(uStoneMap,stoneY).rgb*stoneWeights.y+samplePatch(uStoneMap,stoneZ).rgb*stoneWeights.z)*.85;
          ${WORLD_V2?'stoneTone*=mix(vec3(.34,.35,.31),vec3(.56,.57,.47),surfaceNoise(p*.3+11.));stoneTone=mix(stoneTone,vec3(.05,.07,.025)+stoneTone*.35,smoothstep(.56,.8,surfaceNoise(p*.55+3.))*slopeNormal.y);':''}
          groundColor=mix(groundColor,stoneTone,stoneBlend);
        }
      }
      float broad=surfaceNoise(p*.065+5.)*.65+surfaceNoise(p*.19)*.35;
      groundColor*=mix(vec3(.73,.78,.66),vec3(1.13,1.08,.97),broad);
      float worn=(1.-smoothstep(trailWidth(p.y)*.42,trailWidth(p.y)+surfaceNoise(p*2.1)*.26,trailDistance(p)))*trailPresence(p);
      // Reuse the scanned mud/litter surface at its physical scale. Broad wear
      // masks must never replace photographic detail with a flat brown colour.
      vec3 dirt=leafColor*vec3(.76,.70,.59);
      float dirtCoverage=worn*.82*(1.-road)*(1.-bank);
      // Root litter is part of the ground itself: no offset surface or decal.
      // Photographic litter and damp soil soften the moss-to-root transition.
      vec3 rootLitter=mix(leafColor*vec3(.73,.67,.55),dirt*.88,.27);
      groundColor=mix(groundColor,rootLitter,rootBlend*.76*(1.-road)*(1.-bank));
      groundColor=mix(groundColor,dirt,dirtCoverage);
      ${WORLD_V2?`
      float trod=smoothstep(.34,.72,vBiome.x+(surfaceNoise(p*1.7)-.5)*.42+(surfaceNoise(p*7.)-.5)*.16);
      float padCoverage=trod*(1.-road)*(1.-bank)*.92;
      dirtCoverage=max(dirtCoverage,padCoverage);
      groundColor=mix(groundColor,dirt,padCoverage);
      `:''}
      ${road?road.colour:`if(road>.001){
        float roadDistance=abs(p.y-roadCenter(p.x));
        float roadWidth=roadHalfWidth(p.x);
        float shoulder=smoothstep(roadWidth*.42,roadWidth+.2,roadDistance);
        float roadMoss=smoothstep(.36,.76,surfaceNoise(p*.23))*(.12+shoulder*.72);
        float tracks=exp(-pow((roadDistance-roadWidth*.48)/.23,2.));
        vec3 asphalt=samplePatch(uRoadMap,roadPatch).rgb*.78;
        asphalt*=.86+surfaceNoise(p*.09+71.)*.26;
        asphalt*=1.-tracks*.09;
        // Real litter and soil reclaim the shoulders; no flat green paint.
        vec3 reclaimed=mix(groundColor,leafColor*vec3(.68,.63,.53),.32);
        vec3 roadSurface=mix(asphalt,reclaimed,roadMoss);
        float sediment=shoulder*smoothstep(.36,.7,surfaceNoise(p*.61+vec2(8.,31.)))*.42;
        roadSurface=mix(roadSurface,leafColor*vec3(.66,.6,.49),sediment);
        groundColor=mix(groundColor,roadSurface,road*.94);
      }`}
      if(bank>.001){
        vec3 pebbles=samplePatch(uBedMap,gravelPatch).rgb;
        pebbles*=mix(vec3(.86,.88,.79),vec3(1.08,1.03,.97),surfaceNoise(p*.21+36.));
        float wetness=1.-smoothstep(.02,.55,vGroundPosition.y-streamHeight(vGroundPosition.z));
        groundColor=mix(groundColor,pebbles*mix(.78,.52,wetness),bank);
      }
      if(distantBlend>0.){
        vec3 baseNormal=inverseTransformDirection(normalize(vNormal),viewMatrix);
        groundColor=mix(groundColor,uDistantTint*horizonTexture(uStoneMap,vGroundPosition,baseNormal),distantBlend);
      }
      diffuseColor.rgb=groundColor;
      `).replace('#include <roughnessmap_fragment>',`
      float roughnessFactor=roughness;
      if(bank<1.)roughnessFactor*=samplePatch(roughnessMap,soilPatch).g;
      roughnessFactor=mix(roughnessFactor,.89,max(leafBlend,dirtCoverage));roughnessFactor=mix(roughnessFactor,.92,stoneBlend);
      ${road?road.roughness:'if(road>.001)roughnessFactor=mix(roughnessFactor,samplePatch(uRoadNormal,roadPatch).a*.82+.08,road);'}
      if(bank>.001)roughnessFactor=mix(roughnessFactor,samplePatch(uBedNormal,gravelPatch).a*.72+.12,bank);
      roughnessFactor=mix(roughnessFactor,.98,distantBlend);
      `).replace('#include <normal_fragment_maps>',`
      vec3 detailNormal=vec3(0.,0.,1.);
      if(bank<1.)detailNormal=samplePatchNormal(normalMap,soilPatch);
      detailNormal.xy*=normalScale;
      float litterNormalBlend=max(leafBlend,dirtCoverage);
      if(litterNormalBlend>.002){vec3 n=samplePatchNormal(uLeavesNormal,leafPatch);n.xy*=.72;detailNormal=mix(detailNormal,n,litterNormalBlend);}
      ${road?road.normal:'if(road>.001){vec3 n=samplePatchNormal(uRoadNormal,roadPatch);n.xy*=.5;detailNormal=mix(detailNormal,n,road);}'}
      if(bank>.001){vec3 n=samplePatchNormal(uBedNormal,gravelPatch);n.xy*=.65;detailNormal=mix(detailNormal,n,bank);}
      vec3 worldGroundNormal=inverseTransformDirection(normal,viewMatrix);
      vec3 groundTangent=normalize(vec3(worldGroundNormal.y,-worldGroundNormal.x,0.));
      vec3 groundBitangent=normalize(cross(worldGroundNormal,groundTangent));
      vec3 surfaceNormal=normalize(groundTangent*detailNormal.x+groundBitangent*detailNormal.y+worldGroundNormal*detailNormal.z);
      if(stoneBlend>.002){
        vec3 nx=samplePatchNormal(uStoneNormal,stoneX),ny=samplePatchNormal(uStoneNormal,stoneY),nz=samplePatchNormal(uStoneNormal,stoneZ);
        nx.xy*=.8;ny.xy*=.8;nz.xy*=.8;
        vec3 nX=vec3(worldGroundNormal.x*abs(nx.z),worldGroundNormal.y+nx.y,worldGroundNormal.z+nx.x);
        vec3 nY=vec3(worldGroundNormal.x+ny.x,worldGroundNormal.y*abs(ny.z),worldGroundNormal.z+ny.y);
        vec3 nZ=vec3(worldGroundNormal.x+nz.x,worldGroundNormal.y+nz.y,worldGroundNormal.z*abs(nz.z));
        vec3 stoneDetail=normalize(nX*stoneWeights.x+nY*stoneWeights.y+nZ*stoneWeights.z);
        surfaceNormal=normalize(mix(surfaceNormal,stoneDetail,stoneBlend*(1.-road)*(1.-bank)*(1.-dirtCoverage)));
      }
      normal=normalize(mat3(viewMatrix)*mix(surfaceNormal,worldGroundNormal,distantBlend));
      `);
  };
  material.customProgramCacheKey=()=> `silence-ground-natural-road-v10${WORLD_V2?`-w2-${WORLD_SEED}`:''}`;
  const terrainChunks=new Map<string,{tile:TerrainTile;mesh:THREE.Mesh}>();
  // The low-detail distant surface preserves the mountain silhouette and covers
  // teleports while near chunks stream. It is below the exact walkable surface.
  const horizonMaterial=new THREE.MeshStandardMaterial({map:stoneMap,color:horizonColor,roughness:.98});
  horizonMaterial.onBeforeCompile=shader=>{
    shader.uniforms.uNearCenter={value:nearCenter};
    shader.uniforms.uNearCoverage=nearCoverage;
    shader.vertexShader=`varying vec3 vHorizon;varying vec3 vRidgeNormal;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvHorizon=(modelMatrix*vec4(transformed,1.)).xyz;vRidgeNormal=normalize(mat3(modelMatrix)*normal);');
    shader.fragmentShader=`uniform vec2 uNearCenter;uniform float uNearCoverage;varying vec3 vHorizon;varying vec3 vRidgeNormal;\n${horizonTextureGLSL}\n${shader.fragmentShader}`.replace('#include <map_fragment>',`
      if(length(vHorizon.xz-uNearCenter)<uNearCoverage)discard;
      diffuseColor.rgb*=horizonTexture(map,vHorizon,vRidgeNormal);
    `);
  };
  const horizon=new THREE.Mesh(groundGeometry(WORLD_EXTENT*2,384,0,0),horizonMaterial);
  // The mountain silhouette is retained in the main view (layer 2 is enabled
  // by the game camera), but does not need a duplicate draw in the water's
  // layer-0 reflection. Reflected terrain fades into the same fog/sky before
  // this coarse horizon contributes a visible landmark.
  horizon.name='Distant mountain basin';horizon.renderOrder=2;horizon.layers.set(2);scene.add(horizon);
  let worker:Worker|undefined;
  let requested:TerrainTile|undefined,prepared:PreparedTerrainTile|undefined;
  let pendingChunks=0,lastCoverageUpdate=performance.now();
  const tileKey=({x,z}:TerrainTile)=>`${x},${z}`;
  function addTile(tile:TerrainTile,geometry:THREE.BufferGeometry){
    const mesh=new THREE.Mesh(geometry,material);
    mesh.receiveShadow=true;mesh.name='Streamed forest terrain';mesh.visible=false;
    scene.add(mesh);terrainChunks.set(tileKey(tile),{tile,mesh});
  }
  function stopWorker(){
    worker?.terminate();worker=undefined;requested=undefined;prepared=undefined;
  }
  function updateChunks(player:THREE.Vector3,initial=false) {
    nearCenter.set(player.x,player.z);
    if(prepared){
      const {tile}=prepared;
      if(tileDistanceSquared(tile.x,tile.z,player.x,player.z)<RETAIN_RADIUS**2){
        cacheTerrainBlock(tile.x,tile.z,prepared.heights);
        layout.cacheCell(tile.x,tile.z,prepared.layout);
        addTile(tile,unpackTerrainTile(prepared));
      }
      prepared=undefined;requested=undefined;
    }
    let coverage2=DETAIL_RADIUS**2,next:TerrainTile|undefined,nextDistance2=Infinity;
    pendingChunks=0;
    const minX=Math.floor((player.x-PREFETCH_RADIUS)/TERRAIN_CHUNK),maxX=Math.floor((player.x+PREFETCH_RADIUS)/TERRAIN_CHUNK);
    const minZ=Math.floor((player.z-PREFETCH_RADIUS)/TERRAIN_CHUNK),maxZ=Math.floor((player.z+PREFETCH_RADIUS)/TERRAIN_CHUNK);
    for(let z=minZ;z<=maxZ;z++)for(let x=minX;x<=maxX;x++){
      const distance2=tileDistanceSquared(x,z,player.x,player.z);
      if(distance2>=PREFETCH_RADIUS**2||terrainChunks.has(`${x},${z}`))continue;
      const inWorld=x>=-WORLD_EXTENT/TERRAIN_CHUNK&&x<WORLD_EXTENT/TERRAIN_CHUNK&&z>=-WORLD_EXTENT/TERRAIN_CHUNK&&z<WORLD_EXTENT/TERRAIN_CHUNK;
      if(initial&&inWorld&&distance2<DETAIL_RADIUS**2){
        const tile={x,z};addTile(tile,buildTerrainTile(tile,layout));continue;
      }
      // A single missing tile limits where the coarse surface can be clipped.
      coverage2=Math.min(coverage2,distance2);
      if(!inWorld)continue;
      pendingChunks++;
      if(distance2<nextDistance2){nextDistance2=distance2;next={x,z};}
    }
    if(!initial&&!requested&&next){
      if(worker){
        requested=next;worker.postMessage(next);
      }else{
        // The same geometry is available in browsers that block workers.
        addTile(next,buildTerrainTile(next,layout));
      }
    }
    const now=performance.now(),coverage=Math.sqrt(coverage2);
    // Normal movement stays inside the prefetched window. After a jump to an
    // uncached area, reveal the complete detail outward over the coarse ground.
    nearCoverage.value=initial?coverage:Math.min(coverage,nearCoverage.value+Math.min(now-lastCoverageUpdate,50)*.16);
    lastCoverageUpdate=now;
    for(const [key,{tile,mesh}] of terrainChunks){
      const distance2=tileDistanceSquared(tile.x,tile.z,player.x,player.z);
      mesh.visible=distance2<nearCoverage.value**2;
      if(distance2>RETAIN_RADIUS**2){scene.remove(mesh);mesh.geometry.dispose();terrainChunks.delete(key);}
    }
  }
  updateChunks(spawn,true);
  try{
    const url=new URL(terrainWorkerUrl,import.meta.url);
    url.search=typeof location!=='undefined'?location.search:'?classic-world';
    worker=new Worker(url,{type:'module'});
    worker.onmessage=(event:MessageEvent<PreparedTerrainTile>)=>{prepared=event.data;};
    worker.onerror=stopWorker;
    worker.onmessageerror=stopWorker;
  }catch{
    // Keep streaming from the deterministic builder if the browser blocks it.
  }
  const river=createRiver(scene,riverX,heightAt);
  const boulderGeo=createRockGeometry(49),boulderMat=createRockMaterial(true);
  const riverStones=new THREE.InstancedMesh(boulderGeo,boulderMat,420);
  riverStones.name='Stream gravel and waterworn stones';
  const stoneDummy=new THREE.Object3D();
  const riverRockMatrices=new WeakMap<LayoutScatter,{matrix:THREE.Matrix4;collider:SolidCollider}>();
  let collisionVersion=0;
  const activeColliders:SolidCollider[]=[];
  const lastRockPosition=new THREE.Vector3(999,0,999);
  function riverStone(item:LayoutScatter){
    const cached=riverRockMatrices.get(item);if(cached)return cached;
    const {x,z,size,yaw,variant}=item;
    stoneDummy.rotation.set((variant-.5)*.6,yaw,(hash(x,z)-.5)*.5);stoneDummy.scale.set(size*(.7+hash(x+9,z)*.6),size*.65,size);
    const p=boulderGeo.attributes.position,v=new THREE.Vector3(),samples:{x:number;y:number;z:number}[]=[];let minY=Infinity,maxY=-Infinity,radius=0;
    for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).multiply(stoneDummy.scale).applyQuaternion(stoneDummy.quaternion);minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);radius=Math.max(radius,Math.hypot(v.x,v.z));if(p.getY(i)<-.3)samples.push({x:v.x,y:v.y,z:v.z});}
    const y=groundedOrigin(samples,x,z,heightAt,.016);stoneDummy.position.set(x,y,z);stoneDummy.updateMatrix();
    const result={matrix:stoneDummy.matrix.clone(),collider:{kind:'capsule' as const,ax:x,az:z,bx:x,bz:z,radius,minY:y+minY,maxY:y+maxY,tag:'river stone',surfaceHeight:createMeshSurface(boulderGeo,stoneDummy.matrix)}};riverRockMatrices.set(item,result);return result;
  }
  riverStones.receiveShadow=true;riverStones.castShadow=true;scene.add(riverStones);
  // Old chipped stone verge markers. Their painted cap is worn into the
  // aggregate, rather than a second perfectly rectangular black mesh.
  const markerMat=createRockMaterial();
  markerMat.color.set(0xb9b5a4);
  const markerGeometries:THREE.BufferGeometry[]=[];
  for(let i=0;i<13;i++){
    const x=-99+i*16.5,z=roadZ(x)+(i%2?3.6:-3.6);if(Math.abs(x-riverX(z))<9)continue;
    const geo=new THREE.CylinderGeometry(.105,.14,.69,18,12,false);
    const p=geo.attributes.position;
    const colors=new Float32Array(p.count*3);
    for(let k=0;k<p.count;k++){
      const px=p.getX(k),py=p.getY(k),pz=p.getZ(k);
      const wear=noise(px*31+2,py*37+pz*9);
      p.setXYZ(k,px*(.93+wear*.15),py+(py>.30?(wear-.5)*.065:0),pz*(.94+wear*.1));
      const band=py>.13&&py<.24;
      const shade=band&&wear>.29 ? .20+wear*.16 : .62+wear*.32;
      colors[k*3]=shade;colors[k*3+1]=shade*.99;colors[k*3+2]=shade*.91;
    }
    geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.computeVertexNormals();
    const post=new THREE.Mesh(geo,markerMat);markerMat.vertexColors=true;
    post.position.set(x,heightAt(x,z)+.24,z);post.rotation.z=(hash(i,7)-.5)*.5;post.rotation.y=hash(i,6)*6.3;
    post.castShadow=true;post.receiveShadow=true;scene.add(post);markerGeometries.push(geo);
    distantProps.push({object:post,x,z,radius:.5});
    solidColliders.push({kind:'capsule',ax:x,az:z,bx:x,bz:z,radius:.16,minY:post.position.y-.36,maxY:post.position.y+.39,tag:'road marker'});
  }
  // A rotting footbridge beside the stream: something has dragged one plank away.
  // Both landings reach beyond the widest bank blend (8.5m), so the first
  // visible board is a small step from dry ground, not a ledge over the slope.
  const bridgeZ=-35, bridgeX=riverX(bridgeZ),bridgeHalf=12;
  const plankCount=76,plankSpacing=bridgeHalf*2/plankCount,plankWidth=plankSpacing-.015,plankDepth=.095,missingPlank=46;
  const bridgeGroup=new THREE.Group();bridgeGroup.name='Footbridge';scene.add(bridgeGroup);
  distantProps.push({object:bridgeGroup,x:bridgeX,z:bridgeZ,radius:bridgeHalf});
  const wood=createWeatheredWoodMaterial();
  const leftDeck=heightAt(bridgeX-bridgeHalf,bridgeZ)+.075,rightDeck=heightAt(bridgeX+bridgeHalf,bridgeZ)+.075;
  const crown=Math.max(waterHeightAt(bridgeZ)+4.3,(leftDeck+rightDeck)*.5+.4);
  const bridgeY=(x:number)=>{
    const t=THREE.MathUtils.clamp((x-bridgeX+bridgeHalf)/(bridgeHalf*2),0,1);
    return THREE.MathUtils.lerp(leftDeck,rightDeck,t)+Math.sin(t*Math.PI)*(crown-(leftDeck+rightDeck)*.5);
  };
  const plankX=(i:number)=>bridgeX-bridgeHalf+(i+.5)*plankSpacing;
  const plankY=(i:number)=>bridgeY(plankX(i))+Math.sin(i*.67)*.008;
  const bridgeGeometries:THREE.BufferGeometry[]=[];
  function timber(a:THREE.Vector3,b:THREE.Vector3,width:number,depth:number,tag='bridge timber'){
    const g=new RoundedBoxGeometry(width,a.distanceTo(b),depth,2,Math.min(width,depth)*.10);
    const uv=g.attributes.uv,p=g.attributes.position,n=g.attributes.normal;
    const grainU=hash(a.x*7.1,a.z)*13.7,grainV=hash(b.x,b.z*3.3)*19.3;
    for(let i=0;i<p.count;i++){
      if(Math.abs(n.getY(i))>.7)uv.setXY(i,p.getX(i)*2,p.getZ(i)*2);
      else if(Math.abs(n.getX(i))>Math.abs(n.getZ(i)))uv.setXY(i,p.getZ(i)*2,p.getY(i)*2);
      else uv.setXY(i,p.getX(i)*2,p.getY(i)*2);
      uv.setXY(i,uv.getX(i)+grainU,uv.getY(i)+grainV);
    }
    const mesh=new THREE.Mesh(g,wood);mesh.position.copy(a).add(b).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),b.clone().sub(a).normalize());mesh.castShadow=true;mesh.receiveShadow=true;bridgeGroup.add(mesh);bridgeGeometries.push(g);
    mesh.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(mesh);
    solidColliders.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:Math.max(width,depth)*.5,minY:bounds.min.y,maxY:bounds.max.y,tag,surfaceHeight:createMeshSurface(g,mesh.matrixWorld)});
  }
  for(let i=0;i<plankCount;i++) {
    if(i===missingPlank)continue;
    const x=plankX(i),y=plankY(i);
    timber(new THREE.Vector3(x,y,bridgeZ-.80),new THREE.Vector3(x+(hash(i,7)-.5)*.025,y+.005,bridgeZ+.80),plankWidth,plankDepth,'bridge deck');
  }
  for(const dz of [-.59,.59]){
    // Segmented stringers follow the raised deck rather than cutting straight
    // through the passage below it. Posts sit outside the stream's clear span.
    for(let i=0;i<12;i++){
      const ax=bridgeX-bridgeHalf+i*2,bx=ax+2;
      timber(new THREE.Vector3(ax,bridgeY(ax)-.14,bridgeZ+dz),new THREE.Vector3(bx,bridgeY(bx)-.14,bridgeZ+dz),.16,.18);
    }
    for(const dx of [-5.1,5.1]){
      const x=bridgeX+dx,z=bridgeZ+dz;
      const foot=heightAt(x,z)-.18;
      timber(new THREE.Vector3(x,foot,z),new THREE.Vector3(x+.025,bridgeY(x)-.08,z),.23,.23,'bridge support');
      const braceX=x+Math.sign(dx)*1.45;
      timber(new THREE.Vector3(x,foot+.5,z),new THREE.Vector3(braceX,bridgeY(braceX)-.19,z),.16,.16,'bridge support');
    }
  }
  // Every weathered board retains its own UVs and exact collision surface, but
  // static timber shares one draw call (also in the shadow/reflection passes).
  const transformedTimbers=bridgeGroup.children.map(object=>{
    const mesh=object as THREE.Mesh;return mesh.geometry.clone().applyMatrix4(mesh.matrix);
  });
  const combinedTimbers=mergeGeometries(transformedTimbers,false)!;
  for(const geometry of transformedTimbers)geometry.dispose();
  bridgeGeometries.push(combinedTimbers);bridgeGroup.clear();
  const combinedBridge=new THREE.Mesh(combinedTimbers,wood);combinedBridge.castShadow=true;combinedBridge.receiveShadow=true;bridgeGroup.add(combinedBridge);
  return {
    water:river,
    get solidColliders(){return activeColliders;},
    get collisionVersion(){return collisionVersion;},
    get streamingStats(){return {nearChunks:terrainChunks.size,pendingChunks,detailRadius:nearCoverage.value,worker:!!worker,heightVertexSpacing:TERRAIN_STEP};},
    update(time:number,player:THREE.Vector3,darkness:number) {
      river.update(time,player,darkness);
      const changed=lastRockPosition.distanceToSquared(player)>9;
      if(changed){
        activeColliders.length=0;activeColliders.push(...solidColliders);
        let count=0;const cx=Math.floor(player.x/32),cz=Math.floor(player.z/32);
        if(Math.abs(player.x-riverX(player.z))<70)for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(const item of layout.cell(cx+dx,cz+dz).river){
          if((item.x-player.x)**2+(item.z-player.z)**2<43**2&&count<420){const stone=riverStone(item);riverStones.setMatrixAt(count++,stone.matrix);activeColliders.push(stone.collider);}
        }
        collisionVersion++;
        riverStones.count=count;riverStones.instanceMatrix.needsUpdate=true;riverStones.computeBoundingSphere();lastRockPosition.copy(player);
      }
      let propsChanged=false;
      for(const prop of distantProps){
        // Fog fully conceals this range; hysteresis avoids toggling shadows when
        // the player walks along the culling boundary. The bridge stays whole.
        const range=(prop.object.visible?118:108)+prop.radius;
        const visible=(prop.x-player.x)**2+(prop.z-player.z)**2<range*range;
        if(prop.object.visible!==visible){prop.object.visible=visible;propsChanged=true;}
      }
      updateChunks(player);
      return changed||propsChanged;
    },
    bridgeHeight(x:number,z:number) {
      if(Math.abs(z-bridgeZ)>.8||Math.abs(x-bridgeX)>bridgeHalf+.18)return -Infinity;
      const nearest=Math.floor((x-bridgeX+bridgeHalf)/plankSpacing);
      let support=-Infinity;
      for(let i=Math.max(0,nearest-1);i<=Math.min(plankCount-1,nearest+1);i++){
        if(i===missingPlank)continue;
        // The player's foot can straddle the missing board by touching an
        // adjacent real board; the gap itself has no floor or hidden ramp.
        if(Math.abs(x-plankX(i))<=plankWidth*.5+.18)support=Math.max(support,plankY(i)+.005+plankDepth*.5);
      }
      return support;
    },
    dispose() {stopWorker();for(const {mesh} of terrainChunks.values()){scene.remove(mesh);mesh.geometry.dispose();}terrainChunks.clear();scene.remove(horizon);horizon.geometry.dispose();horizonMaterial.dispose();for(const t of textures)t.dispose();for(const g of bridgeGeometries)g.dispose();material.dispose();river.dispose();boulderGeo.dispose();boulderMat.dispose();markerMat.dispose();for(const g of markerGeometries)g.dispose();wood.dispose();}
  };
}
