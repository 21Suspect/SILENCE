import * as THREE from 'three';

/** Exact vertical mesh contacts. Build a small projected triangle grid lazily:
 * only props the creature actually steps on pay for the acceleration data. */
export function createMeshSurface(geometry:THREE.BufferGeometry,transform:THREE.Matrix4){
  if(!geometry.boundingBox)geometry.computeBoundingBox();
  const matrix=transform.clone(),bounds=geometry.boundingBox!.clone().applyMatrix4(matrix);
  const resolution=12,spanX=Math.max(.001,bounds.max.x-bounds.min.x),spanZ=Math.max(.001,bounds.max.z-bounds.min.z);
  let vertices:Float64Array|undefined,bins:number[][]|undefined;
  const gridX=(x:number)=>Math.max(0,Math.min(resolution-1,Math.floor((x-bounds.min.x)/spanX*resolution)));
  const gridZ=(z:number)=>Math.max(0,Math.min(resolution-1,Math.floor((z-bounds.min.z)/spanZ*resolution)));
  function prepare(){
    const position=geometry.attributes.position,index=geometry.index,count=index?index.count:position.count,v=new THREE.Vector3();
    vertices=new Float64Array(count*3);bins=Array.from({length:resolution*resolution},()=>[]);
    for(let i=0;i<count;i++){v.fromBufferAttribute(position,index?index.getX(i):i).applyMatrix4(matrix);vertices.set([v.x,v.y,v.z],i*3);}
    for(let i=0;i<count*3;i+=9){
      const p=vertices,ax=p[i],az=p[i+2],bx=p[i+3],bz=p[i+5],cx=p[i+6],cz=p[i+8];
      if(Math.abs((bz-cz)*(ax-cx)+(cx-bx)*(az-cz))<1e-10)continue;
      const x0=gridX(Math.min(ax,bx,cx)),x1=gridX(Math.max(ax,bx,cx)),z0=gridZ(Math.min(az,bz,cz)),z1=gridZ(Math.max(az,bz,cz));
      for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++)bins[z*resolution+x].push(i);
    }
  }
  return (x:number,z:number):number|undefined=>{
    if(x<bounds.min.x||x>bounds.max.x||z<bounds.min.z||z>bounds.max.z)return undefined;
    if(!vertices)prepare();
    const p=vertices!;let top=-Infinity;
    for(const i of bins![gridZ(z)*resolution+gridX(x)]){
      const ax=p[i],az=p[i+2],bx=p[i+3],bz=p[i+5],cx=p[i+6],cz=p[i+8];
      const det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);
      const a=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/det,b=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/det,c=1-a-b;
      if(a>=-1e-7&&b>=-1e-7&&c>=-1e-7)top=Math.max(top,a*p[i+1]+b*p[i+4]+c*p[i+7]);
    }
    return Number.isFinite(top)?top:undefined;
  };
}
