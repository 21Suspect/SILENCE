import type { LayoutTree } from './placement';

type TreeLayout={cell:(x:number,z:number)=>{trees:LayoutTree[]}};
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const smooth=(v:number)=>{const t=clamp(v);return t*t*(3-2*t);};
export function treeGroundRadius(tree:Pick<LayoutTree,'width'>){return 1.68*tree.width+.42;}
/** An irregular, softly feathered litter pocket around the actual trunk/root
 * footprint. Seed and yaw are from the same deterministic tree as the mesh. */
export function treeGroundInfluence(tree:Pick<LayoutTree,'x'|'z'|'width'|'yaw'|'seed'>,x:number,z:number){
  const dx=x-tree.x,dz=z-tree.z,c=Math.cos(tree.yaw),s=Math.sin(tree.yaw);
  const lx=(dx*c-dz*s)/1.07,lz=(dx*s+dz*c)/.94,angle=Math.atan2(lz,lx),phase=(tree.seed%997)*.017;
  const edge=1+.085*Math.sin(angle*3+phase)+.05*Math.sin(angle*7-phase*.71);
  const distance=Math.hypot(lx,lz)/edge,outer=treeGroundRadius(tree),inner=.76*tree.width;
  return 1-smooth((distance-inner)/(outer-inner));
}
/** Stamp only the vertices touched by neighbouring trunks. Chunk border
 * vertices see the same accepted layout cells and produce identical weights. */
export function buildTreeGroundMask(layout:TreeLayout,size:number,segments:number,ox:number,oz:number){
  const result=new Float32Array((segments+1)**2),step=size/segments,x0=ox-size*.5,z0=oz-size*.5,pad=5;
  for(let cz=Math.floor((z0-pad)/32);cz<=Math.floor((z0+size+pad)/32);cz++)for(let cx=Math.floor((x0-pad)/32);cx<=Math.floor((x0+size+pad)/32);cx++){
    for(const tree of layout.cell(cx,cz).trees){
      const reach=treeGroundRadius(tree)*1.25;
      const ix0=Math.max(0,Math.ceil((tree.x-reach-x0)/step)),ix1=Math.min(segments,Math.floor((tree.x+reach-x0)/step));
      const iz0=Math.max(0,Math.ceil((tree.z-reach-z0)/step)),iz1=Math.min(segments,Math.floor((tree.z+reach-z0)/step));
      for(let iz=iz0;iz<=iz1;iz++)for(let ix=ix0;ix<=ix1;ix++){
        const i=iz*(segments+1)+ix,weight=treeGroundInfluence(tree,Math.fround(x0+ix*step),Math.fround(z0+iz*step));
        result[i]=Math.max(result[i],weight);
      }
    }
  }
  return result;
}
