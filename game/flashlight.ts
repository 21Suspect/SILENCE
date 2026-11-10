import * as THREE from 'three';
import { solidContact, type SolidCollider } from './collision';

/** A worn metal torch on the shelter bench; no icon, outline or pickup HUD. */
export function createFlashlight(scene:THREE.Scene,camera:THREE.PerspectiveCamera,heightAt:(x:number,z:number)=>number,world:{nearby:(x:number,z:number,r?:number)=>SolidCollider[]},click:()=>void){
  const yaw=.22,seat=new THREE.Vector3(-18+.6*Math.cos(yaw)-.36*Math.sin(yaw),heightAt(-18,-46)+.02+.60,-46-.6*Math.sin(yaw)-.36*Math.cos(yaw));
  const group=new THREE.Group();group.name='Bench flashlight';group.position.copy(seat);scene.add(group);
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;const ctx=canvas.getContext('2d')!;
  ctx.fillStyle='#555957';ctx.fillRect(0,0,256,128);
  for(let i=0;i<1900;i++){const x=(i*47.13)%256,y=(i*29.71)%128;ctx.fillStyle=i%11===0?'#b3b1a2':i%3?'#44443b':'#727164';ctx.fillRect(x,y,i%11===0?4:1,1);}
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;map.wrapS=map.wrapT=THREE.RepeatWrapping;
  const metal=new THREE.MeshStandardMaterial({map,color:0x91958e,metalness:.82,roughness:.38});
  const rubber=new THREE.MeshStandardMaterial({map,color:0x35372f,roughness:.88});
  const reflector=new THREE.MeshStandardMaterial({color:0xd7d6c8,metalness:.9,roughness:.22});
  const lens=new THREE.MeshStandardMaterial({color:0x9eafb0,metalness:.3,roughness:.12,emissive:0xffe4bd,emissiveIntensity:0});
  const geometries:THREE.BufferGeometry[]=[];
  function part(g:THREE.BufferGeometry,m:THREE.Material,z:number){g.rotateX(Math.PI/2);const mesh=new THREE.Mesh(g,m);mesh.position.z=z;mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);geometries.push(g);return mesh;}
  part(new THREE.CylinderGeometry(.036,.037,.23,24,1),metal,0);
  for(let i=0;i<9;i++)part(new THREE.CylinderGeometry(.039,.039,.009,24),rubber,.07-i*.015);
  part(new THREE.CylinderGeometry(.037,.063,.07,32),metal,-.15);
  part(new THREE.CylinderGeometry(.057,.057,.008,32),reflector,-.188);
  part(new THREE.CylinderGeometry(.051,.051,.004,32),lens,-.194);
  part(new THREE.CylinderGeometry(.04,.04,.025,24),metal,.123);
  const switchMesh=part(new THREE.SphereGeometry(.013,12,8),rubber,.045);switchMesh.position.y=.037;switchMesh.scale.y=.45;
  for(let i=0;i<5;i++)part(new THREE.TorusGeometry(.049+i*.002,.0015,6,48).rotateX(-Math.PI/2),metal,-.137-i*.009);
  for(let i=0;i<24;i++){const rib=part(new THREE.BoxGeometry(.002,.14,.002),rubber,0);rib.rotation.set(0,0,0);rib.position.set(Math.cos(i*Math.PI/12)*.038,Math.sin(i*Math.PI/12)*.038,0);/* part() already rotates the geometry onto the barrel axis. */}
  group.rotation.set(0,1.1,Math.PI*.03);
  const beamCanvas=document.createElement('canvas');beamCanvas.width=beamCanvas.height=256;const bc=beamCanvas.getContext('2d')!;
  const gradient=bc.createRadialGradient(128,128,0,128,128,126);gradient.addColorStop(0,'#fff6e5');gradient.addColorStop(.18,'#fff1d8');gradient.addColorStop(.45,'#9e988b');gradient.addColorStop(.82,'#2c2d29');gradient.addColorStop(1,'#000000');bc.fillStyle=gradient;bc.fillRect(0,0,256,256);
  const cookie=new THREE.CanvasTexture(beamCanvas);cookie.colorSpace=THREE.SRGBColorSpace;
  const light=new THREE.SpotLight(0xffecd2,0,48,Math.PI/6,.8,1.35);light.map=cookie;light.castShadow=true;light.shadow.autoUpdate=false;light.shadow.mapSize.set(1024,1024);light.shadow.camera.near=.06;light.shadow.bias=-.00002;light.shadow.normalBias=.015;
  scene.add(light,light.target);const direction=new THREE.Vector3(),target=new THREE.Vector3(),offset=new THREE.Vector3();
  const shadowPosition=new THREE.Vector3(Infinity,Infinity,Infinity),shadowDirection=new THREE.Vector3();
  let owned=false,on=false,wanted=false,equip=0,lastUpdate=performance.now();
  function canPick(){
    camera.getWorldDirection(direction);target.copy(seat).sub(camera.position);const distance=target.length();
    if(distance>2.4||target.normalize().dot(direction)<.86)return false;
    for(let t=.15;t<distance-.18;t+=.12){offset.copy(camera.position).addScaledVector(target,t);for(const c of world.nearby(offset.x,offset.z,.02))if(offset.y>c.minY&&offset.y<c.maxY&&solidContact(c,offset.x,offset.z,.01).depth>0)return false;}
    return true;
  }
  return {
    light,
    interact(pickupOnly=false){if(!owned){if(!canPick())return false;owned=true;wanted=true;group.name='Carried flashlight';group.traverse(o=>{if(o instanceof THREE.Mesh)o.castShadow=false;});}else if(pickupOnly)return false;else wanted=!wanted;if(!wanted&&on){on=false;click();}return true;},
    // WORLD_V2 only: game/interaction.ts owns the pickup prompt, so pickup and switch are separate calls
    // here instead of interact()'s combined silent behaviour, and the rebuilt cabin can relocate the bench.
    get owned(){return owned;},
    setSeat(position:THREE.Vector3){seat.copy(position);if(!owned)group.position.copy(seat);},
    canPickNow(){return !owned&&canPick();},
    pickUp(){if(owned)return false;owned=true;wanted=true;group.name='Carried flashlight';group.traverse(o=>{if(o instanceof THREE.Mesh)o.castShadow=false;});return true;},
    toggle(){if(!owned)return false;wanted=!wanted;if(!wanted&&on){on=false;click();}return true;},
    update(time:number,speed:number){
      const now=performance.now(),dt=Math.min((now-lastUpdate)/1000,.05);lastUpdate=now;
      equip=THREE.MathUtils.clamp(equip+(wanted?1:-1)*dt/0.48,0,1);
      const raised=equip*equip*(3-2*equip);
      if(owned&&wanted&&equip===1&&!on){on=true;click();}
      group.visible=!owned||equip>0;
      if(owned){group.position.set(Math.min(.24,camera.aspect*.18),-.26-(1-raised)*.65,-.48+(1-raised)*.2);group.position.y+=Math.sin(time*7)*Math.min(speed,2)*.003;group.position.applyQuaternion(camera.quaternion).add(camera.position);group.quaternion.copy(camera.quaternion);group.rotateX(-(1-raised)*.6);}
      light.visible=owned&&on;light.intensity=on?24:0;lens.emissiveIntensity=owned&&on?1.8:0;
      camera.getWorldDirection(direction);
      // Emit just beyond the physical lens, not from behind the torch housing.
      // That avoids lighting its own barrel into a distracting white silhouette.
      light.position.copy(group.position).addScaledVector(direction,.205);light.target.position.copy(camera.position).addScaledVector(direction,16);light.target.updateMatrixWorld();
      scene.userData.flashlight=light.visible?light:null;
    },
    /** A restarted night: the torch lies on its bench again, switched off. */
    reset(){owned=false;wanted=false;on=false;equip=0;group.name='Bench flashlight';group.position.copy(seat);group.rotation.set(0,1.1,Math.PI*.03);group.visible=true;group.traverse(o=>{if(o instanceof THREE.Mesh)o.castShadow=true;});light.visible=false;light.intensity=0;lens.emissiveIntensity=0;},
    /** Dev capture only: skip the pickup and raise the torch immediately. */
    devEquip(){owned=true;wanted=true;equip=1;group.traverse(o=>{if(o instanceof THREE.Mesh)o.castShadow=false;});},
    inspect(){return {owned,on,pickupPosition:seat.toArray(),canPick:!owned&&canPick()};},
    get active(){return owned&&on;},
    updateShadow(castersChanged:boolean){
      direction.subVectors(light.target.position,light.position).normalize();
      const moved=light.position.distanceToSquared(shadowPosition)>.004**2||direction.distanceToSquared(shadowDirection)>.001**2;
      light.shadow.needsUpdate=light.visible&&(castersChanged||moved||light.shadow.map===null);
      if(light.shadow.needsUpdate){shadowPosition.copy(light.position);shadowDirection.copy(direction);}
    },
    dispose(){scene.remove(group,light,light.target);geometries.forEach(g=>g.dispose());[metal,rubber,reflector,lens].forEach(m=>m.dispose());map.dispose();cookie.dispose();light.dispose();delete scene.userData.flashlight;}
  };
}
