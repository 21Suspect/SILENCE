import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { solidContact, type SolidCollider } from '../../sim/world/collision';

const TORCH_MODEL = '/torch/small-plastic-torch.glb';

function disposeModel(model: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
}

/** The bench pickup and first-person pose share the same scanned torch. */
export function createFlashlight(scene:THREE.Scene,camera:THREE.PerspectiveCamera,heightAt:(x:number,z:number)=>number,world:{nearby:(x:number,z:number,r?:number)=>SolidCollider[]},click:()=>void){
  const yaw=.22,seat=new THREE.Vector3(-18+.6*Math.cos(yaw)-.36*Math.sin(yaw),heightAt(-18,-46)+.02+.60,-46-.6*Math.sin(yaw)-.36*Math.cos(yaw));
  const group=new THREE.Group();group.name='Bench flashlight';group.position.copy(seat);scene.add(group);
  group.rotation.y = 1.1;

  const inBrowser = typeof window !== 'undefined';
  const beamOrigin = new THREE.Vector3(0, 0, -.125);
  let model: THREE.Group | undefined;
  let lens: THREE.MeshStandardMaterial | undefined;
  let modelBottom = 0, benchClearance = .60 - (.51 + .035 / 2);
  let disposed = false;
  let owned=false,on=false,wanted=false,equip=0,lastUpdate=performance.now();

  function restOnBench() {
    group.position.copy(seat);
    if (model) group.position.y -= benchClearance + modelBottom + .001;
  }

  // Use the default loading manager so the startup fade waits for the GLB.
  if (inBrowser) {
    new GLTFLoader().load(TORCH_MODEL, ({ scene: asset }) => {
      if (disposed) {
        disposeModel(asset);
        return;
      }
      model = asset;
      model.name = 'Small Plastic Torch';
      // The source lens faces +Z. Our first-person mount points along -Z.
      model.rotation.y = Math.PI;
      const bounds = new THREE.Box3().setFromObject(model, true);
      modelBottom = bounds.min.y;
      beamOrigin.z = bounds.min.z - .009;
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const material = object.material;
        const glass = material instanceof THREE.MeshStandardMaterial && material.name === 'small_plastic_torch_glass';
        object.castShadow = !owned && !glass;
        object.receiveShadow = true;
        if (glass) {
          lens = material;
          material.opacity = .24;
          material.depthWrite = false;
          material.forceSinglePass = true;
          material.emissive.setHex(0xffe4bd);
          material.emissiveIntensity = 0;
        }
      });
      group.add(model);
      if (!owned) restOnBench();
    }, undefined, error => {
      if (!disposed) console.error('SILENCE: the bench torch could not load.', error);
    });
  }

  const beamCanvas=document.createElement('canvas');beamCanvas.width=beamCanvas.height=256;const bc=beamCanvas.getContext('2d')!;
  const gradient=bc.createRadialGradient(128,128,0,128,128,126);gradient.addColorStop(0,'#fff6e5');gradient.addColorStop(.18,'#fff1d8');gradient.addColorStop(.45,'#9e988b');gradient.addColorStop(.82,'#2c2d29');gradient.addColorStop(1,'#000000');bc.fillStyle=gradient;bc.fillRect(0,0,256,256);
  const cookie=new THREE.CanvasTexture(beamCanvas);cookie.colorSpace=THREE.SRGBColorSpace;
  const light=new THREE.SpotLight(0xffecd2,0,48,Math.PI/6,.8,1.35);light.map=cookie;light.castShadow=true;light.shadow.autoUpdate=false;light.shadow.mapSize.set(1024,1024);light.shadow.camera.near=.06;light.shadow.bias=-.00002;light.shadow.normalBias=.015;
  scene.add(light,light.target);const direction=new THREE.Vector3(),target=new THREE.Vector3(),offset=new THREE.Vector3();
  const shadowPosition=new THREE.Vector3(Infinity,Infinity,Infinity),shadowDirection=new THREE.Vector3();
  const available = () => !inBrowser || model !== undefined;
  function canPick(){
    if (!available()) return false;
    camera.getWorldDirection(direction);target.copy(seat).sub(camera.position);const distance=target.length();
    if(distance>2.4||target.normalize().dot(direction)<.86)return false;
    for(let t=.15;t<distance-.18;t+=.12){offset.copy(camera.position).addScaledVector(target,t);for(const c of world.nearby(offset.x,offset.z,.02))if(offset.y>c.minY&&offset.y<c.maxY&&solidContact(c,offset.x,offset.z,.01).depth>0)return false;}
    return true;
  }
  function pickUp() {
    if (owned || !available()) return false;
    owned = true;
    wanted = true;
    group.name = 'Carried flashlight';
    group.traverse(object => { if (object instanceof THREE.Mesh) object.castShadow = false; });
    return true;
  }
  function toggle() {
    if (!owned) return false;
    wanted = !wanted;
    if (!wanted && on) {
      on = false;
      click();
    }
    return true;
  }
  return {
    light,
    interact(pickupOnly=false){return owned ? !pickupOnly && toggle() : canPick() && pickUp();},
    // WORLD_V2 only: game/render/props/interaction.ts owns the pickup prompt, so pickup and switch are separate calls
    // here instead of interact()'s combined silent behaviour, and the rebuilt cabin can relocate the bench.
    get owned(){return owned;},
    get available(){return available();},
    setSeat(position: THREE.Vector3) {
      seat.copy(position);
      // The cabin hook is 8 cm above the centre of its 4.5 cm planks.
      benchClearance = .08 - .045 / 2;
      if (!owned) restOnBench();
    },
    canPickNow(){return !owned&&canPick();},
    pickUp,
    toggle,
    update(time:number,speed:number){
      const now=performance.now(),dt=Math.min((now-lastUpdate)/1000,.05);lastUpdate=now;
      equip=THREE.MathUtils.clamp(equip+(wanted?1:-1)*dt/0.48,0,1);
      const raised=equip*equip*(3-2*equip);
      if(owned&&wanted&&equip===1&&!on){on=true;click();}
      group.visible=!owned||equip>0;
      if(owned){group.position.set(Math.min(.24,camera.aspect*.18),-.26-(1-raised)*.65,-.48+(1-raised)*.2);group.position.y+=Math.sin(time*7)*Math.min(speed,2)*.003;group.position.applyQuaternion(camera.quaternion).add(camera.position);group.quaternion.copy(camera.quaternion);group.rotateX(-(1-raised)*.6);}
      light.visible=owned&&on;light.intensity=on?24:0;
      if (lens) lens.emissiveIntensity = light.visible ? 1.8 : 0;
      camera.getWorldDirection(direction);
      // Emit just beyond the physical lens, not from behind the torch housing.
      // That avoids lighting its own barrel into a distracting white silhouette.
      light.position.copy(beamOrigin).applyQuaternion(group.quaternion).add(group.position);
      light.target.position.copy(camera.position).addScaledVector(direction,16);light.target.updateMatrixWorld();
      scene.userData.flashlight=light.visible?light:null;
    },
    /** A restarted night: the torch lies on its bench again, switched off. */
    reset(){
      owned=false;wanted=false;on=false;equip=0;lastUpdate=performance.now();
      group.name='Bench flashlight';restOnBench();group.rotation.set(0,1.1,0);group.visible=available();
      group.traverse(o=>{if(o instanceof THREE.Mesh)o.castShadow=!(o.material instanceof THREE.MeshStandardMaterial&&o.material===lens);});
      light.visible=false;light.intensity=0;if(lens)lens.emissiveIntensity=0;scene.userData.flashlight=null;
    },
    /** Dev capture only: skip the pickup and raise the torch immediately. */
    devEquip(){if(owned||pickUp()){wanted=true;equip=1;}},
    inspect(){return {owned,on,modelReady:!!model,modelVisible:!!model&&group.visible,pickupPosition:seat.toArray(),canPick:!owned&&canPick()};},
    get active(){return owned&&on;},
    updateShadow(castersChanged:boolean){
      direction.subVectors(light.target.position,light.position).normalize();
      const moved=light.position.distanceToSquared(shadowPosition)>.004**2||direction.distanceToSquared(shadowDirection)>.001**2;
      light.shadow.needsUpdate=light.visible&&(castersChanged||moved||light.shadow.map===null);
      if(light.shadow.needsUpdate){shadowPosition.copy(light.position);shadowDirection.copy(direction);}
    },
    dispose() {
      disposed = true;
      scene.remove(group, light, light.target);
      if (model) disposeModel(model);
      cookie.dispose();
      light.dispose();
      delete scene.userData.flashlight;
    }
  };
}
