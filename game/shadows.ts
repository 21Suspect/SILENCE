import * as THREE from 'three';

/** Snap the moving light's projection to whole shadow texels. A fixed time of
 * day retains an identical sampling phase even across hilly terrain. */
export function createStableSunShadow(sun: THREE.DirectionalLight, maxTextureSize: number) {
  // Concentrate the same 4K budget around the player. The renderer uses
  // PCFSoftShadowMap: its sub-texel interpolation removes the old 17-level
  // staircase without adding a larger depth texture or another render pass.
  let size = Math.min(4096, maxTextureSize);const span=72;let texel=span/size;
  const offset=new THREE.Vector3(25,37,-68),backward=offset.clone().normalize();
  const right=new THREE.Vector3(),up=new THREE.Vector3(),center=new THREE.Vector3();
  const lastAnchor=new THREE.Vector3(Infinity,Infinity,Infinity),lastDirection=new THREE.Vector3();
  let directionReady=false;
  const basis=()=>{right.crossVectors(THREE.Object3D.DEFAULT_UP,backward);if(right.lengthSq()<.0001)right.set(1,0,0);else right.normalize();up.crossVectors(backward,right).normalize();};basis();
  sun.shadow.mapSize.set(size,size);
  Object.assign(sun.shadow.camera,{left:-span/2,right:span/2,top:span/2,bottom:-span/2,near:.5,far:230});sun.shadow.camera.updateProjectionMatrix();
  // Bias is in shadow-camera depth units. The former values detached contact
  // shadows by centimetres, especially at low sun angles and boulder edges.
  sun.shadow.bias=-.000012;sun.shadow.normalBias=.004;sun.shadow.radius=1;
  return {
    get size(){return size;},get texel(){return texel;},
    setQuality(scale:number,requested=4096){const next=Math.min(maxTextureSize,requested,scale<.6?2048:4096);if(next===size)return false;size=next;texel=span/size;sun.shadow.mapSize.set(size,size);sun.shadow.map?.dispose();sun.shadow.map=null;lastAnchor.set(Infinity,Infinity,Infinity);return true;},
    update(position:THREE.Vector3,direction?:THREE.Vector3){
      let rotated=false;
      if(direction){
        // Follow the continuous solar direction every rendered frame; angular
        // quantisation caused the visible ticking during accelerated days.
        if(!directionReady||lastDirection.distanceToSquared(direction)>1e-18){
          directionReady=true;lastDirection.copy(direction);backward.copy(direction).normalize();offset.copy(backward).multiplyScalar(105);basis();rotated=true;
        }
      }
      if(!rotated&&position.distanceToSquared(lastAnchor)<4)return false;
      lastAnchor.copy(position);
      const x=Math.round(position.dot(right)/texel)*texel,y=Math.round(position.dot(up)/texel)*texel,z=Math.round(position.dot(backward)/.5)*.5;
      center.copy(right).multiplyScalar(x).addScaledVector(up,y).addScaledVector(backward,z);
      sun.target.position.copy(center);sun.position.copy(center).add(offset);sun.target.updateMatrixWorld();sun.updateMatrixWorld();
      return true;
    }
  };
}
