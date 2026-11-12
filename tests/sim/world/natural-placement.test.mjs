import './helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {createNaturalLayout,footprintsOverlap,groundedOrigin} = await import('../game/placement.ts');
const {roadMarkerSpot} = await import('../game/road-geometry.ts');
const {heightAt,rawHeight,horizonHeightAt,vegetationExclusion,biomeAt,riverX,riverPresence,roadZ,WORLD_RADIUS} = await import('../game/world.ts');
const geography={heightAt,exclusion:vegetationExclusion,biomeAt,riverX,riverPresence,roadZ,radius:WORLD_RADIUS};
test('natural solids have no intersections across cell borders, including river stones',()=>{
  const layout=createNaturalLayout(geography),cells=new Map();let rocks=0,river=0;
  for(let z=-4;z<=4;z++)for(let x=-4;x<=4;x++){const c=layout.cell(x,z);cells.set(`${x},${z}`,c);rocks+=c.rubble.length;river+=c.river.length;}
  for(let z=-3;z<=3;z++)for(let x=-3;x<=3;x++){
    const c=cells.get(`${x},${z}`),near=[];for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++)near.push(...cells.get(`${x+dx},${z+dz}`).footprints);
    for(const a of c.footprints)for(const b of near)if(a.id!==b.id)assert.equal(footprintsOverlap(a,b,.119),false,`${a.kind} ${a.id} intersects ${b.kind} ${b.id}`);
  }
  assert.ok(rocks>40,'rock variety must remain visible');assert.ok(rocks<81*8*.8,'minimum spacing must thin the reduced candidates');assert.ok(river>30);
  for(let i=0;i<13;i++){
    const {x,z}=roadMarkerSpot(i);if(Math.abs(x-riverX(z))<9)continue;
    const marker={ax:x,az:z,bx:x,bz:z,radius:.16};
    for(const cell of cells.values())for(const f of cell.footprints)assert.equal(footprintsOverlap(marker,f,0),false,'natural props must not intersect a fixed road marker');
  }
});
test('placement is independent of cell streaming order',()=>{
  const a=createNaturalLayout(geography),b=createNaturalLayout(geography),coords=[];
  for(let z=-1;z<=1;z++)for(let x=0;x<=2;x++)coords.push([x,z]);
  const expected=new Map(coords.map(([x,z])=>[`${x},${z}`,a.cell(x,z).footprints]));
  for(const [x,z] of coords.reverse())assert.deepEqual(b.cell(x,z).footprints,expected.get(`${x},${z}`));
});
test('prefetching a layout preserves existing placements and deterministic neighbours',()=>{
  const background=createNaturalLayout(geography),foreground=createNaturalLayout(geography);
  const prefetched=structuredClone(background.cell(-6,5));
  foreground.cacheCell(-6,5,prefetched);
  assert.equal(foreground.cell(-6,5),prefetched);
  foreground.cacheCell(-6,5,structuredClone(prefetched));
  assert.equal(foreground.cell(-6,5),prefetched);
  assert.deepEqual(foreground.cell(-5,5),background.cell(-5,5));
});
test('grounded rock undersides remain embedded on uneven and tilted ground',()=>{
  const samples=[];for(let i=0;i<24;i++){const a=i*Math.PI/12;samples.push({x:Math.cos(a)*.7,y:-.48+Math.sin(a)*.07,z:Math.sin(a)*.7});}
  const terrain=(x,z)=>.3*x+.07*Math.sin(z*3);
  const origin=groundedOrigin(samples,7,-3,terrain,.035);
  for(const p of samples)assert.ok(origin+p.y-terrain(7+p.x,-3+p.z)<=-.034999);
  assert.ok(origin+.83-terrain(7,-3)>.5,'grounding must retain an exposed stone body');
});
test('mountain skyline is lower and peaked, and distant LOD shares exact seam heights',()=>{
  let max=0,minPeak=Infinity,maxPeak=0;
  for(let sector=0;sector<96;sector++){
    const a=sector*Math.PI/48;let peak=0;
    for(let r=475;r<650;r+=2){const h=rawHeight(Math.cos(a)*r,Math.sin(a)*r);max=Math.max(max,h);peak=Math.max(peak,h);}
    minPeak=Math.min(minPeak,peak);maxPeak=Math.max(maxPeak,peak);
    assert.ok(rawHeight(Math.cos(a)*660,Math.sin(a)*660)<peak-20,'ridge must descend beyond the crest');
  }
  assert.ok(max<90,`peak too tall: ${max}`);assert.ok(maxPeak-minPeak>15,'skyline needs distinct peaks and saddles');
  for(let x=-560;x<=560;x+=8)for(const z of [-512,-480,480,512])assert.ok(Math.abs(horizonHeightAt(x,z)-heightAt(x,z))<1e-5);
});
