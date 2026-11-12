import * as THREE from 'three';

/** The old procedural crowns' branch layout. The game grows its trees in conifer.ts and broadleaf.ts now; the headless
 * playtest world (tools/playtest/world.mjs) still takes its rough crown heights from here. */
export function branchSpec(kind:number,index:number) {
  const species=Math.floor(kind/2),j=index,k=(index+.45)/36;
  const angle=j*2.399963+kind*.83+Math.sin(j*4.1+kind)*.23;
  if(species===0)return {height:17.2+k*13.2,length:3.55*(1-k*.8)+Math.sin(j*3.7)*.18,angle,rise:-.03+k*.31};
  if(species===1)return {height:6.2+k*24.1,length:4.1*Math.pow(1-k,.78)+.32,angle,rise:-.18+k*.46};
  if(species===2)return {height:11.0+k*18.9,length:(2.1+Math.sin(k*Math.PI)*2.5)*(1-k*.42),angle,rise:.4+k*.24};
  return {height:8.0+k*21.7,length:(3.2+Math.sin(k*Math.PI)*3.1)*(1-k*.55),angle,rise:.32+k*.43};
}

/** Root flares, cut grain, a splintered snag, and a hollow decayed stump. */
export function stumpGeometry(variant:number) {
  const p:number[]=[],uv:number[]=[],idx:number[]=[],N=28,rings=7;
  const top=(a:number)=>variant===0?1+.035*Math.sin(a*3):variant===1?1+.20*Math.sin(a*7)+.12*Math.sin(a*13):1+.13*Math.sin(a*5)+.05*Math.sin(a*11);
  const radius=(a:number,t:number)=>(.79+.30*Math.exp(-t*5)+.40*Math.pow(Math.max(0,Math.sin(a*5+variant)),6)*Math.exp(-t*4))*(1+.04*Math.sin(a*9));
  for(let j=0;j<=rings;j++)for(let i=0;i<=N;i++){
    const a=i/N*Math.PI*2,t=j/rings,r=radius(a,t);p.push(Math.cos(a)*r,t*top(a),Math.sin(a)*r);uv.push(i/N*2,t*1.2);
    if(j<rings&&i<N){const x=j*(N+1)+i;idx.push(x,x+N+1,x+1,x+1,x+N+1,x+N+2);}
  }
  const barkEnd=idx.length,outer=p.length/3;
  // In a hollow stump the inner wall descends to a dark floor, not an open hole.
  for(let ring=0;ring<3;ring++)for(let i=0;i<=N;i++){
    const a=i/N*Math.PI*2,r=radius(a,1)*(ring===0?1:variant===2?.66:0);
    const y=ring===2&&variant===2?.24:top(a)-.012;
    p.push(Math.cos(a)*r,y,Math.sin(a)*r);uv.push(.5+Math.cos(a)*r*.48,.5+Math.sin(a)*r*.48);
    if(ring<2&&i<N){const x=outer+ring*(N+1)+i;idx.push(x,x+1,x+N+1,x+1,x+N+2,x+N+1);}
  }
  if(variant===2){const c=p.length/3;p.push(0,.24,0);uv.push(.5,.5);for(let i=0;i<N;i++)idx.push(c,outer+2*(N+1)+i+1,outer+2*(N+1)+i);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.addGroup(0,barkEnd,0);g.addGroup(barkEnd,idx.length-barkEnd,1);g.computeVertexNormals();return g;
}
