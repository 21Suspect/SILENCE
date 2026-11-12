import '../../helpers/register-ts-hooks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {buildTreeGroundMask,treeGroundInfluence,treeGroundRadius} = await import('../../../game/sim/world/tree-ground.ts');
const {createNaturalLayout} = await import('../../../game/sim/world/placement.ts');
const {heightAt,vegetationExclusion,biomeAt,riverX,riverPresence,roadZ,WORLD_RADIUS} = await import('../../../game/sim/world/world.ts');

test('root litter has a soft irregular edge around the exact trunk footprint',()=>{
  const tree={x:3,z:7,width:1.35,yaw:.73,seed:8192};
  assert.equal(treeGroundInfluence(tree,tree.x,tree.z),1);
  const values=[];
  for(let i=0;i<32;i++){
    const a=i*Math.PI/16,r=treeGroundRadius(tree)*.72;
    values.push(treeGroundInfluence(tree,tree.x+Math.cos(a)*r,tree.z+Math.sin(a)*r));
    assert.equal(treeGroundInfluence(tree,tree.x+Math.cos(a)*5,tree.z+Math.sin(a)*5),0);
  }
  assert.ok(Math.max(...values)-Math.min(...values)>.1,'the edge should not be a circular decal');
  assert.ok(values.every(v=>v>0&&v<1),'the transition must feather between soil and moss');
});

test('root-mask chunks agree on all shared border vertices, including trees in neighbouring cells',()=>{
  const layout=createNaturalLayout({heightAt,exclusion:vegetationExclusion,biomeAt,riverX,riverPresence,roadZ,radius:WORLD_RADIUS});
  let affectedSeamVertices=0;
  for(let cz=-2;cz<=2;cz++)for(let cx=-2;cx<=2;cx++){
    const a=buildTreeGroundMask(layout,32,48,cx*32,cz*32);
    const right=buildTreeGroundMask(layout,32,48,(cx+1)*32,cz*32);
    const below=buildTreeGroundMask(layout,32,48,cx*32,(cz+1)*32);
    for(let i=0;i<=48;i++){
      assert.equal(a[i*49+48],right[i*49]);
      assert.equal(a[48*49+i],below[i]);
      affectedSeamVertices+=Number(a[i*49+48]>0)+Number(a[48*49+i]>0);
    }
    assert.ok(a.every(v=>Number.isFinite(v)&&v>=0&&v<=1));
  }
  assert.ok(affectedSeamVertices>100,'test must actually cross accepted trees and their litter');
  assert.ok(buildTreeGroundMask({cell:()=>({trees:[]})},32,48,0,0).every(v=>v===0),'no tree means no phantom dirt patch');
});

