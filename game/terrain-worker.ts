import { buildTerrainTile, packTerrainTile, type PreparedTerrainTile, type TerrainTile } from './terrain-geometry';
import { naturalLayout } from './placement';
import { biomeAt, heightAt, riverPresence, riverX, roadZ, terrainBlock, vegetationExclusion, WORLD_RADIUS } from './world';

const layout = naturalLayout({heightAt,exclusion:vegetationExclusion,biomeAt,riverX,riverPresence,roadZ,radius:WORLD_RADIUS});

self.addEventListener('message',(event:MessageEvent<TerrainTile>)=>{
  const tile=event.data;
  const geometry=buildTerrainTile(tile,layout);
  const heights=terrainBlock(tile.x,tile.z).slice();
  const data:PreparedTerrainTile={...packTerrainTile(tile,geometry),heights,layout:layout.cell(tile.x,tile.z)};
  self.postMessage(data,{transfer:[data.index.buffer,heights.buffer,...data.arrays.map(array=>array.buffer)] as ArrayBuffer[]});
});
