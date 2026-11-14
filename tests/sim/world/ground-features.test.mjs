import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.location={search:'?world-v2'};
const f=await import('../../../game/sim/world/ground-features.ts');
const w=await import('../../../game/sim/world/world.ts');
const n=await import('../../../game/sim/world/world-noise.ts');
const g=await import('../../../game/sim/world/coastal-geography.ts');

const CHUNK=w.TERRAIN_CHUNK,TILES=Math.floor(w.WORLD_EXTENT/CHUNK);
// A fixed sequence, so a failure names the same point every run.
let seed=12345;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};

test('a tile without a feature has none of it anywhere inside (the shader built without it draws the same)',()=>{
  const count={0:0,[f.GROUND_ROAD]:0,[f.GROUND_BANK]:0,[f.GROUND_MOUNTAIN]:0};let tiles=0;
  for(let tz=-TILES;tz<TILES;tz+=2)for(let tx=-TILES;tx<TILES;tx+=2){
    const features=f.groundTileFeatures(tx,tz);
    // Land only: most of the square is open sea.
    if(Math.hypot((tx+.5)*CHUNK,(tz+.5)*CHUNK)<560){tiles++;if(features in count)count[features]++;}
    for(let k=0;k<60;k++){
      const x=(tx+random())*CHUNK,z=(tz+random())*CHUNK,at=`(${x.toFixed(1)}, ${z.toFixed(1)}) in tile ${tx},${tz}`;
      if(!(features&f.GROUND_ROAD))assert.ok(w.roadDistance(x,z)>f.GROUND_REACH.road,`road within reach at ${at}`);
      if(!(features&f.GROUND_BANK)){
        assert.ok(n.channelOffset(x,z)>f.GROUND_REACH.stream,`river bank at ${at}`);
        assert.ok(g.lakeDistance(x,z)>f.GROUND_REACH.lake,`lake shore at ${at}`);
      }
      if(!(features&f.GROUND_MOUNTAIN))assert.ok(!f.mountainPossible(x,z),`mountain at ${at}`);
    }
  }
  // The point of it: a third of the island is plain forest floor, and each feature has tiles of its own.
  assert.ok(count[0]>tiles*.25,`only ${count[0]} of ${tiles} tiles are plain`);
  for(const bit of [f.GROUND_ROAD,f.GROUND_BANK,f.GROUND_MOUNTAIN])assert.ok(count[bit]>0,`no tile has only feature ${bit}`);
});
