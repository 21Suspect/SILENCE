import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.location={search:'?world-v2'};
const g=await import('../../../game/sim/world/coastal-geography.ts');
const w=await import('../../../game/sim/world/world.ts');
const n=await import('../../../game/sim/world/world-noise.ts');
const l=await import('../../../game/sim/world/world-layout.ts');

test('headwaters descend continuously through a level lake into the sea',()=>{
  let last=n.waterHeightAt(-700);
  for(let z=-699;z<600;z++){
    const level=n.waterHeightAt(z);
    assert.ok(level>=last,`uphill flow at ${z}`);
    assert.ok(level-last<2.3,`discontinuous stream at ${z}`);
    last=level;
  }
  for(let z=-45;z<=245;z++)assert.equal(n.waterHeightAt(z),g.LAKE_LEVEL);
  assert.equal(n.waterHeightAt(-330),g.SEA_LEVEL);
});
test('the river has no dry barrier between source lake and outlet',()=>{
  for(let z=-330;z<=540;z+=3){
    const x=n.riverX(z);
    assert.ok(w.heightAt(x,z)<n.waterHeightAt(z),`dry river at ${x},${z}`);
    assert.notEqual(w.riverSurfaceAt(x,z),undefined,`missing wet support ${z}`);
  }
});
test('lake and sea have submerged beds while spawn remains dry',()=>{
  assert.ok(w.heightAt(g.LAKE_CENTER.x,100)<g.LAKE_LEVEL-3);
  assert.equal(w.riverSurfaceAt(g.LAKE_CENTER.x,100),g.LAKE_LEVEL);
  for(let x=-450;x<=450;x+=50){
    const z=g.coastZ(x)-30;
    assert.ok(w.heightAt(x,z)<g.SEA_LEVEL);
    assert.equal(w.riverSurfaceAt(x,z),g.SEA_LEVEL);
    assert.equal(w.vegetationExclusion(x,z),1);
  }
  assert.equal(w.riverSurfaceAt(l.SPAWN.x,l.SPAWN.z),undefined);
  assert.ok(w.heightAt(l.SPAWN.x,l.SPAWN.z)>g.LAKE_LEVEL);
});
test('coast has bays while snow is confined to high inland terrain',()=>{
  const shores=Array.from({length:19},(_,i)=>g.coastZ(i*50-450));
  assert.ok(Math.max(...shores)-Math.min(...shores)>60);
  assert.equal(g.snowCoverage(0,0,10),0);
  assert.ok(g.snowCoverage(116,548,210)>.95);
  assert.equal(g.snowCoverage(116,548,210,2.5),0);
  assert.ok(w.rawHeight(-185,532)>160);
  assert.ok(w.rawHeight(0,-550)<g.SEA_LEVEL,'no southern mountain ring');
});

test('upper snowmelt cascade is physically too steep to walk uphill',()=>{
  let steepest=0;
  for(let z=470;z<530;z+=2){const a=w.heightAt(n.riverX(z),z),b=w.heightAt(n.riverX(z+2),z+2);steepest=Math.max(steepest,(b-a)/Math.hypot(2,n.riverX(z+2)-n.riverX(z)));}
  assert.ok(steepest>1.2,`headwater approach slope ${steepest}`);
  assert.ok(n.waterHeightAt(535)<90,'headwaters no longer rise in an 80m wall');
});


test('coast wraps all finite terrain edges into open water',()=>{
  for(let axis=-768;axis<=768;axis+=32)for(const [x,z] of [[axis,-768],[axis,768],[-768,axis],[768,axis]]){
    assert.ok(g.coastDistance(x,z)<-20,`land reaches terrain edge ${x},${z}`);
    assert.ok(w.rawHeight(x,z)<g.SEA_LEVEL,`exposed terrain edge ${x},${z}`);
    assert.equal(w.riverSurfaceAt(x,z),g.SEA_LEVEL);
  }
});

test('developer coastal viewpoints are dry and trail ends before sea and cliffs',()=>{
  for(const p of w.COASTAL_DESTINATIONS){assert.equal(w.riverSurfaceAt(p.x,p.z),undefined,p.name);assert.ok(g.coastDistance(p.x,p.z)>4);assert.ok(g.lakeDistance(p.x,p.z)>3);}
  assert.equal(w.trailPresence(n.pathX(l.MAIN_TRAIL_BOUNDS.south-1),l.MAIN_TRAIL_BOUNDS.south-1),0);
  assert.equal(w.trailPresence(n.pathX(l.MAIN_TRAIL_BOUNDS.north+1),l.MAIN_TRAIL_BOUNDS.north+1),0);
  assert.ok(w.trailPresence(l.SPAWN.x,l.SPAWN.z)>.99);
});

 test('beaches vary in width and the foothill is a gradual transition',()=>{
  const widths=Array.from({length:40},(_,i)=>g.beachWidth(i*20-400,g.coastZ(i*20-400)));
  assert.ok(Math.max(...widths)-Math.min(...widths)>25);
  for(let x=-300;x<=300;x+=30){const z=g.mountainFoot(x);assert.ok(Math.abs(g.mountainRelief(x,z+10)-g.mountainRelief(x,z-10))<20,`foot wall ${x}`);}
});


test('sand dunes meet the underwater shelf without a height seam',()=>{
  // Bisect the southern waterline, including the narrowest beaches.
  for(let x=-440;x<=440;x+=8){
    let lo=-520,hi=-250;
    for(let i=0;i<30;i++){const z=(lo+hi)/2;if(g.coastDistance(x,z)<0)lo=z;else hi=z;}
    const z=(lo+hi)/2;
    const sea=g.coastalTerrain(x,z-.02,8),sand=g.coastalTerrain(x,z+.02,8);
    assert.ok(Math.abs(sand-sea)<.02,`shoreline seam at ${x},${z}: ${sand-sea}`);
    assert.ok(Math.abs(g.coastalTerrain(x,z+1,8)-sand)<.16,`steep waterline at ${x}`);
  }
});

test('mine and closed road portals are inland in the mountain foothills',()=>{
  const mine=l.POI_PLACEMENTS.find(p=>p.id==='mine');
  for(const p of [mine,...l.ROAD_ENDS]){
    assert.ok(g.coastDistance(p.x,p.z)>g.beachWidth(p.x,p.z)+40,`coastal portal ${p.x},${p.z}`);
    assert.ok(p.z>g.mountainFoot(p.x),`portal below mountain belt ${p.x},${p.z}`);
    // The road is graded up to its mouths (see road-grade.ts): a floor of 9 m is well above the beaches, which top out near +3 m.
    assert.ok(w.rawHeight(p.x,p.z)>8,`portal at beach elevation ${p.x},${p.z}`);
  }
});
