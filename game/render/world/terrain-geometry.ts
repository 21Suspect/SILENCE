import * as THREE from 'three';
import { buildTreeGroundMask } from '../../sim/world/tree-ground';
import { smooth } from '../../sim/world/world-noise';
import { TERRAIN_CHUNK, TERRAIN_SEGMENTS, TERRAIN_STEP, biomeAt, groundMasks, heightAt, horizonHeightAt, rawHeight } from '../../sim/world/world';
import { WORLD_V2 } from '../../sim/world/world-flags';
import type { LayoutCell } from '../../sim/world/placement';

type TreeLayout = Parameters<typeof buildTreeGroundMask>[0];
export type TerrainTile = { x: number; z: number };
const attributes = ['position','normal','uv','treeGround','biome','horizonY'] as const;
const itemSizes = [3,3,2,1,4,1];
export type TerrainTileData = { tile: TerrainTile; index: Uint16Array; arrays: Float32Array[]; bounds:[number,number,number,number] };
export type PreparedTerrainTile = TerrainTileData & { heights:Float32Array; layout:LayoutCell };

export function groundGeometry(size:number,segments:number,ox:number,oz:number,layout?:TreeLayout) {
  const geo=new THREE.PlaneGeometry(size,size,segments,segments);geo.rotateX(-Math.PI/2);
  const pos=geo.attributes.position,uv=geo.attributes.uv;
  const biomes=layout?new Float32Array(pos.count*4):undefined,horizonHeights=layout?new Float32Array(pos.count):undefined;
  let maxMorph=0;
  for(let i=0;i<pos.count;i++){
    const x=Math.fround(pos.getX(i)+ox),z=Math.fround(pos.getZ(i)+oz);
    pos.setXYZ(i,x,layout?heightAt(x,z):rawHeight(x,z),z);uv.setXY(i,x/480,-z/480);
    if(biomes&&horizonHeights){
      horizonHeights[i]=horizonHeightAt(x,z);
      maxMorph=Math.max(maxMorph,Math.abs(pos.getY(i)-horizonHeights[i]));
      const b=biomeAt(x,z);biomes.set([b.forest,b.grove,b.heath,b.alpine],i*4);
      if(WORLD_V2){
        // Forest weight is unused by the shader, so it carries worn earth in this mode.
        const [worn,rock]=groundMasks(x,z),slope=Math.hypot(heightAt(x+1,z)-heightAt(x-1,z),heightAt(x,z+1)-heightAt(x,z-1))/2;
        biomes[i*4]=worn;biomes[i*4+3]=Math.max(b.alpine,rock*.7,smooth(slope,.5,.92));
      }
    }
  }
  geo.computeVertexNormals();
  // Identical central-difference normals on neighbouring chunk borders remove
  // the old lighting seams without changing the actual collision triangles.
  if(layout&&biomes&&horizonHeights){
    geo.setAttribute('treeGround',new THREE.BufferAttribute(buildTreeGroundMask(layout,size,segments,ox,oz),1));
    geo.setAttribute('biome',new THREE.BufferAttribute(biomes,4));geo.setAttribute('horizonY',new THREE.BufferAttribute(horizonHeights,1));
    const normals=geo.attributes.normal,normal=new THREE.Vector3();
    for(let row=0;row<=segments;row++)for(let col=0;col<=segments;col++){
      if(row!==0&&row!==segments&&col!==0&&col!==segments)continue;
      const i=row*(segments+1)+col,x=pos.getX(i),z=pos.getZ(i);
      normal.set(heightAt(x-TERRAIN_STEP,z)-heightAt(x+TERRAIN_STEP,z),2*TERRAIN_STEP,heightAt(x,z-TERRAIN_STEP)-heightAt(x,z+TERRAIN_STEP)).normalize();
      normals.setXYZ(i,normal.x,normal.y,normal.z);
    }
  }
  geo.computeBoundingSphere();
  // Keep both the exact surface and the shader's morphed edge inside the bound.
  geo.boundingSphere!.radius+=maxMorph;
  return geo;
}

export function buildTerrainTile(tile:TerrainTile,layout:TreeLayout) {
  return groundGeometry(TERRAIN_CHUNK,TERRAIN_SEGMENTS,(tile.x+.5)*TERRAIN_CHUNK,(tile.z+.5)*TERRAIN_CHUNK,layout);
}

export function packTerrainTile(tile:TerrainTile,geometry:THREE.BufferGeometry):TerrainTileData {
  const {center,radius}=geometry.boundingSphere!;
  return {tile,index:geometry.index!.array as Uint16Array,arrays:attributes.map(name=>geometry.attributes[name].array as Float32Array),bounds:[center.x,center.y,center.z,radius]};
}

export function unpackTerrainTile({index,arrays,bounds:[x,y,z,radius]}:TerrainTileData) {
  const geometry=new THREE.BufferGeometry();
  geometry.setIndex(new THREE.BufferAttribute(index,1));
  for (let i=0;i<attributes.length;i++) geometry.setAttribute(attributes[i],new THREE.BufferAttribute(arrays[i],itemSizes[i]));
  geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(x,y,z),radius);
  return geometry;
}
