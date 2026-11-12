import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {WORLD_RADIUS, TERRAIN_CHUNK, TERRAIN_SEGMENTS, TERRAIN_STEP, cacheTerrainBlock, terrainBlock, heightAt, rawHeight, biomeAt, pathX, pathWidth, riverX, waterHeightAt, waterGradeAt, riverSurfaceAt, terrainHeightStats} = await import('../../../game/sim/world/world.ts');
const {createCollisionWorld, moveCharacter} = await import('../../../game/sim/world/collision.ts');

test('walkable terrain samples the rendered float32 lattice across chunk seams',()=>{
  for(const [ix,iz] of [[-49,-1],[-1,-49],[0,0],[48,48],[768,-768]]){
    const x=ix*TERRAIN_STEP,z=iz*TERRAIN_STEP;
    assert.ok(Math.abs(heightAt(x,z)-Math.fround(rawHeight(x,z)))<1e-5);
    for(const delta of [-1e-7,1e-7])assert.ok(Math.abs(heightAt(x+delta,z-delta)-heightAt(x,z))<1e-5);
    const fx=.27,fz=.31,a=Math.fround(rawHeight(x,z)),b=Math.fround(rawHeight(x+TERRAIN_STEP,z)),c=Math.fround(rawHeight(x,z+TERRAIN_STEP));
    assert.ok(Math.abs(heightAt(x+fx*TERRAIN_STEP,z+fz*TERRAIN_STEP)-(a+(b-a)*fx+(c-a)*fz))<1e-5);
  }
});

test('prefetched terrain uses the same collision lattice and retains any existing block',()=>{
  const bx=-5,bz=6,n=TERRAIN_SEGMENTS+1;
  const prefetched=Float32Array.from({length:n*n},(_,i)=>
    rawHeight(bx*TERRAIN_CHUNK+(i%n)*TERRAIN_STEP,bz*TERRAIN_CHUNK+Math.floor(i/n)*TERRAIN_STEP));
  cacheTerrainBlock(bx,bz,prefetched);
  assert.equal(terrainBlock(bx,bz),prefetched);
  cacheTerrainBlock(bx,bz,prefetched.slice());
  assert.equal(terrainBlock(bx,bz),prefetched);
  assert.equal(heightAt(bx*TERRAIN_CHUNK,bz*TERRAIN_CHUNK),prefetched[0]);
});

test('a continuous physical mountain ring stops walking without a radius clamp',()=>{
  const collisions=createCollisionWorld();
  for(let sector=0;sector<24;sector++){
    const a=sector*Math.PI/12,dx=Math.cos(a),dz=Math.sin(a);let p={x:dx*475,z:dz*475,y:heightAt(dx*475,dz*475)};
    for(let step=0;step<450;step++)p=moveCharacter(p,dx*.8,dz*.8,1.75,heightAt,collisions);
    assert.ok(Math.hypot(p.x,p.z)<WORLD_RADIUS-30,`walk escaped the steep ring in sector ${sector}`);
  }
});

test('biomes overlap continuously, and the stream closes before the mountain wall',()=>{
  for(let z=-580;z<=580;z+=29)for(let x=-580;x<=580;x+=29){
    const b=biomeAt(x,z),near=biomeAt(x+.1,z+.1);
    assert.ok(Math.abs(Object.values(b).reduce((a,v)=>a+v,0)-1)<1e-8);
    for(const key in b){assert.ok(b[key]>=0&&b[key]<=1);assert.ok(Math.abs(b[key]-near[key])<.01);}
  }
  for(const sign of [-1,1]){
    assert.ok(heightAt(riverX(sign*405),sign*405)<waterHeightAt(sign*405));
    assert.ok(heightAt(riverX(sign*465),sign*465)>0);
  }
  assert.ok(Math.abs(pathX(25)-pathX(0))>10);
  assert.ok(pathWidth(0)<.8&&pathWidth(100)<.8);
  assert.ok(terrainHeightStats().blocks<=terrainHeightStats().limit);
  assert.ok(terrainHeightStats().bytes<2_000_000);
});

test('graded shallow river has continuous downhill flow, dry banks and matching water support',()=>{
  let low=Infinity,high=-Infinity;
  for(let z=-400;z<=400;z+=2){
    const x=riverX(z),level=waterHeightAt(z),depth=level-heightAt(x,z);
    assert.ok(depth>.30&&depth<.72,`shallow stream depth ${depth} at ${z}`);
    const grade=(waterHeightAt(z+.01)-waterHeightAt(z-.01))/.02;
    assert.ok(grade>.003&&grade<.012,'flow always descends towards -Z');
    assert.ok(Math.abs(grade-waterGradeAt(z))<1e-8);
    assert.equal(riverSurfaceAt(x,z),level);
    for(const dx of [-8,8]){
      assert.ok(heightAt(x+dx,z)>level,'both sides meet dry banks before water mesh edges');
      assert.equal(riverSurfaceAt(x+dx,z),undefined);
    }
    low=Math.min(low,level);high=Math.max(high,level);
  }
  assert.ok(high-low>5,'water surface follows the valley instead of one flat plane');
  for(const z of [-470,470])assert.equal(riverSurfaceAt(riverX(z),z),undefined);
});
