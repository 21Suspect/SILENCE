import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Model-space branching is shared by the wood and leaves, so crowns have real structure. */
export function branchSpec(kind:number,index:number) {
  const species=Math.floor(kind/2),j=index,k=(index+.45)/36;
  const angle=j*2.399963+kind*.83+Math.sin(j*4.1+kind)*.23;
  if(species===0)return {height:17.2+k*13.2,length:3.55*(1-k*.8)+Math.sin(j*3.7)*.18,angle,rise:-.03+k*.31};
  if(species===1)return {height:6.2+k*24.1,length:4.1*Math.pow(1-k,.78)+.32,angle,rise:-.18+k*.46};
  if(species===2)return {height:11.0+k*18.9,length:(2.1+Math.sin(k*Math.PI)*2.5)*(1-k*.42),angle,rise:.4+k*.24};
  return {height:8.0+k*21.7,length:(3.2+Math.sin(k*Math.PI)*3.1)*(1-k*.55),angle,rise:.32+k*.43};
}

/** A stable set of photographed boughs, anchored to the same branches as the bark. */
export const crownBranches=Array.from({length:36},(_,branch)=>branch).filter(branch=>branch%4!==3);

export function crownGeometry(kind:number,bough:THREE.BufferGeometry) {
  const parts:THREE.BufferGeometry[]=[],matrix=new THREE.Matrix4();
  const radial=new THREE.Vector3(),across=new THREE.Vector3(),normal=new THREE.Vector3(),center=new THREE.Vector3(),offset=new THREE.Vector3();
  for(const branch of crownBranches){
    const {angle,height,length,rise}=branchSpec(kind,branch);
    radial.set(Math.cos(angle),rise,Math.sin(angle)).normalize();
    across.set(-Math.sin(angle),0,Math.cos(angle));normal.crossVectors(across,radial).normalize();
    const orientation=matrix.makeBasis(across,radial,normal).clone();
    matrix.scale(center.setScalar(length));
    center.copy(radial).multiplyScalar(length*.52);center.y+=height;
    matrix.setPosition(center);
    const part=bough.clone(),leaves=part.getAttribute('leafCenter');
    if(!leaves)part.applyMatrix4(matrix);
    else{
      const position=part.getAttribute('position');
      for(let i=0;i<position.count;i++){
        center.fromBufferAttribute(leaves,i);
        offset.fromBufferAttribute(position,i).sub(center).applyMatrix4(orientation);
        center.applyMatrix4(matrix);
        leaves.setXYZ(i,center.x,center.y,center.z);
        offset.add(center);position.setXYZ(i,offset.x,offset.y,offset.z);
      }
      part.computeVertexNormals();
    }
    parts.push(part);
  }
  const geometry=mergeGeometries(parts)!;
  for(const part of parts)part.dispose();
  geometry.computeBoundingBox();
  return geometry;
}

/** Small, curved leaf sprays distributed over a complete bough. The shader
 * cancels only the spray's branch scaling, keeping leaves a plausible physical
 * size while preserving the full crown volume and branch locations. */
export function broadleafGeometry(shootCount:number) {
  const parts:THREE.BufferGeometry[]=[];
  for(let i=0;i<shootCount;i++){
    const twig=i%10,rank=Math.floor(i/10),ranks=Math.ceil((shootCount-twig)/10),a=i*2.399963;
    const t=.34+Math.min(twig,8)/8*.61,side=twig%2?1:-1;
    const size=.83+.19*Math.sin(i*4.73+2),width=.29*size,height=.58*size;
    const g=new THREE.PlaneGeometry(width,height,1,2),p=g.attributes.position,uv=g.attributes.uv;
    const colors=new Float32Array(p.count*3);
    for(let n=0;n<p.count;n++){
      const f=(p.getY(n)+height*.5)/height;
      p.setZ(n,Math.sin(f*Math.PI)*height*.065+p.getX(n)*(f-.5)*.18);
      // The clean right-hand twig excludes the atlas's bark islands and broad
      // torn polygon scraps. Most individual leaves span roughly 5–15 cm.
      uv.setXY(n,.55+uv.getX(n)*.30,.365+uv.getY(n)*.60);
      const shade=.86+.12*Math.sin(i*1.71+2);colors.set([shade,Math.min(1,shade*1.035),shade*.91],n*3);
    }
    // Attach each spray at its stem end to the existing woody secondary
    // branches. Fixed-size leaves must not float in the old scaled ring.
    g.translate(0,height*.46,0);g.rotateY(a);g.rotateZ(-side*(.64+Math.sin(a)*.24));g.rotateX(Math.cos(a)*.30);
    const f=.22+(rank+.5)/Math.max(1,ranks)*.78;
    const center=twig===9?new THREE.Vector3(0,.31+f*.17,-.025*f):new THREE.Vector3((.045+(1-t)*.22)*side*f,t-.56+f*.08,Math.sin(t*5)*.025*f);
    g.translate(center.x,center.y,center.z);
    const centers=new Float32Array(p.count*3);for(let n=0;n<p.count;n++)centers.set(center.toArray(),n*3);
    g.setAttribute('leafCenter',new THREE.BufferAttribute(centers,3));g.setAttribute('color',new THREE.BufferAttribute(colors,3));
    g.computeVertexNormals();parts.push(g);
  }
  const g=mergeGeometries(parts)!;parts.forEach(p=>p.dispose());return g;
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
