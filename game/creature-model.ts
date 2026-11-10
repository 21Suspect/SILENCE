import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {createArticulationPose,updateArticulationPose,createSpiderGaze,advanceSpiderGaze,type CreatureAttention} from './creature-articulation';

type RestBone={bone:THREE.Bone;direction:THREE.Vector3;quaternion:THREE.Quaternion;length:number;localQuaternion:THREE.Quaternion};
/** Original Blender voxel sculpt: continuous skin with a small emissive eye draw.
 * The procedural gait supplies joint positions; this module only deforms skin. */
export function createCreatureModel(parent:THREE.Group){
  const rest=new Map<string,RestBone>();
  const contacts:{label:string;mesh:THREE.SkinnedMesh;index:number}[]=[];let model:THREE.Group|undefined,disposed=false;
  const direction=new THREE.Vector3(),quaternion=new THREE.Quaternion(),desiredMatrix=new THREE.Matrix4(),inverseParent=new THREE.Matrix4(),scale=new THREE.Vector3();
  const restLengths:Record<string,number>={};
  const gazeState=createSpiderGaze(),pose=createArticulationPose(),jointEuler=new THREE.Euler(0,0,0,'YXZ'),jointBody=new THREE.Quaternion(),jointLocal=new THREE.Quaternion(),jointTarget=new THREE.Quaternion();
  const articulatedSamples:{name:string;mesh:THREE.SkinnedMesh;index:number;bind:THREE.Vector3}[]=[];
  const loader=new GLTFLoader();
  loader.load('/creature/silence-creature.glb',gltf=>{
    if(disposed){gltf.scene.traverse(o=>{if(o instanceof THREE.Mesh)o.geometry.dispose();});return;}
    model=gltf.scene;model.name='Sculpted creature anatomy';model.updateMatrixWorld(true);
    model.traverse(object=>{
      if(object instanceof THREE.Bone){
        const q=object.getWorldQuaternion(new THREE.Quaternion());
        rest.set(object.name,{bone:object,direction:new THREE.Vector3(0,1,0).applyQuaternion(q),quaternion:q,length:1,localQuaternion:object.quaternion.clone()});
      }
      if(object instanceof THREE.Mesh){
        object.castShadow=true;object.receiveShadow=true;object.frustumCulled=false;
        for(const material of Array.isArray(object.material)?object.material:[object.material]){
          if(material instanceof THREE.MeshStandardMaterial){
            material.vertexColors=false;
            if(material.name==='Cold ivory eyes'){
              // Emissive surface stays visible in the fog without acting like headlights.
              material.color.set(0xd0ded4);material.emissive.set(0xc5ded6);material.emissiveIntensity=2.1;material.roughness=.24;
            }else{
              // Albedo already contains the intended bone/tendon/rot variation.
              material.color.set(0xffffff);material.roughness=.94;material.normalScale.set(.83,.83);
            }
            for(const map of [material.map,material.normalMap,material.roughnessMap])if(map)map.anisotropy=4;
          }
        }
      }
    });
    // Blender bones keep their local +Y axis along the limb after glTF's Y-up conversion.
    for(const side of [-1,1])for(let i=0;i<3;i++){
      const label=(side<0?'L':'R')+i;
      const base=new THREE.Vector3(side*.25,1.88,.38-i*.52),shoulder=new THREE.Vector3(side*(.85+i*.1),2.43+(i===1?.38:0),.8-i*.85);
      for(const [name,length] of [[`hip_${label}`,base.distanceTo(shoulder)],[`upper_${label}`,1.5],[`lower_${label}`,3.1],[`toe_${label}`,Math.hypot(.10,.018,.13)]] as const){const r=rest.get(name);if(r){r.length=length;restLengths[name]=length;}}
    }
    for(const side of [-1,1])for(let i=0;i<3;i++){
      const label=(side<0?'L':'R')+i,target=new THREE.Vector3(side*(2.22+i*.16)+side*.10,.017,1.85-i*1.8+.13);let nearest=Infinity,sample:{label:string;mesh:THREE.SkinnedMesh;index:number}|undefined;
      model.traverse(o=>{if(o instanceof THREE.SkinnedMesh){const p=o.geometry.attributes.position,v=new THREE.Vector3();for(let j=0;j<p.count;j++){v.fromBufferAttribute(p,j).applyMatrix4(o.matrixWorld);const d=v.distanceToSquared(target);if(d<nearest){nearest=d;sample={label,mesh:o,index:j};}}}});if(sample)contacts.push(sample);
    }
    // Track skin vertices rather than bones alone, so QA can verify real deformation.
    const sampleNames=['neck','head','jaw','wrist_L','wrist_R',...['L','R'].flatMap(side=>Array.from({length:4},(_,i)=>`tip_${side}${i}`))];
    for(const name of sampleNames){let best=-Infinity,sample:typeof articulatedSamples[number]|undefined;
      model.traverse(o=>{if(!(o instanceof THREE.SkinnedMesh))return;const boneIndex=o.skeleton.bones.findIndex(b=>b.name===name);if(boneIndex<0)return;
        const weights=o.geometry.attributes.skinWeight,joints=o.geometry.attributes.skinIndex,positions=o.geometry.attributes.position,v=new THREE.Vector3(),r=rest.get(name);if(!r)return;
        for(let i=0;i<positions.count;i++){let weight=0;for(let j=0;j<4;j++)if(joints.getComponent(i,j)===boneIndex)weight+=weights.getComponent(i,j);if(weight<.65)continue;
          v.fromBufferAttribute(positions,i).applyMatrix4(o.matrixWorld);const score=weight*3+v.distanceTo(r.bone.getWorldPosition(new THREE.Vector3()));if(score>best){best=score;sample={name,mesh:o,index:i,bind:v.clone()};}}
      });if(sample)articulatedSamples.push(sample);
    }
    parent.add(model);parent.userData.sculptReady=true;
    let triangles=0,draws=0;model.traverse(o=>{if(o instanceof THREE.Mesh){triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;draws++;}});parent.userData.sculptStats={triangles,draws,bones:rest.size};
  },undefined,error=>{console.error('SILENCE: sculpted creature could not load.',error);});
  function setBone(name:string,a:THREE.Vector3,b:THREE.Vector3,worldLocked=false){
    const r=rest.get(name);if(!r)return;
    direction.subVectors(b,a);const length=direction.length();direction.normalize();
    if(worldLocked)direction.transformDirection(parent.matrixWorld);
    quaternion.setFromUnitVectors(r.direction,direction).multiply(r.quaternion);
    // Joint positions carry tiny breathing offsets; scaling a parent bone would
    // introduce shear into descendants and make a planted toe drift.
    scale.set(1,1,1);desiredMatrix.compose(worldLocked?a.clone().applyMatrix4(parent.matrixWorld):a,quaternion,scale);
    if(!worldLocked)desiredMatrix.premultiply(parent.matrixWorld);
    if(r.bone.parent){inverseParent.copy(r.bone.parent.matrixWorld).invert();desiredMatrix.premultiply(inverseParent);}
    desiredMatrix.decompose(r.bone.position,r.bone.quaternion,r.bone.scale);r.bone.updateMatrixWorld(true);
  }
  return {
    get ready(){return !!model;},
    setLeg(label:string,base:THREE.Vector3,shoulder:THREE.Vector3,knee:THREE.Vector3,foot:THREE.Vector3,toe:THREE.Vector3){setBone(`hip_${label}`,base,shoulder);setBone(`upper_${label}`,shoulder,knee);setBone(`lower_${label}`,knee,foot);setBone(`toe_${label}`,foot,toe,true);},
    secondary(time:number,running:number,dt:number,attention?:CreatureAttention){
      const gaze=attention?.lookTarget?advanceSpiderGaze(gazeState,attention.lookTarget,attention.turnRate??0,running,time,dt):undefined;
      updateArticulationPose(pose,time,running,gaze?{...attention,gazeAngles:gaze}:attention);
      for(const [name,angle] of Object.entries(pose)){
        const r=rest.get(name);if(!r)continue;
        // Convert anatomical body axes to each bone's bind axes. This keeps
        // jaw hinges and finger curls consistent despite glTF bone orientation.
        jointEuler.set(angle.x,angle.y,angle.z,'YXZ');jointBody.setFromEuler(jointEuler);
        jointLocal.copy(r.quaternion).invert().multiply(jointBody).multiply(r.quaternion);
        jointTarget.copy(r.localQuaternion).multiply(jointLocal);
        const damping=name==='head'?16:name==='neck'?4.2:name==='jaw'?10:name.startsWith('tip')?12:name.startsWith('finger')?9:6;
        r.bone.quaternion.slerp(jointTarget,1-Math.exp(-Math.max(0,Math.min(dt,.1))*damping));
        r.bone.updateMatrixWorld(true);
      }
    },
    inspect(){return {ready:!!model,...parent.userData.sculptStats,articulation:{targets:pose,joints:Object.keys(pose).map(name=>{const r=rest.get(name);return {name,angle:r?r.localQuaternion.angleTo(r.bone.quaternion):0,rotation:r?.bone.quaternion.toArray()};}),samples:articulatedSamples.map(c=>{const p=new THREE.Vector3().fromBufferAttribute(c.mesh.geometry.attributes.position,c.index);c.mesh.applyBoneTransform(c.index,p);p.applyMatrix4(c.mesh.matrixWorld);return {name:c.name,position:p.toArray(),bind:c.bind.toArray()};})},contacts:contacts.map(c=>{const p=new THREE.Vector3().fromBufferAttribute(c.mesh.geometry.attributes.position,c.index);c.mesh.applyBoneTransform(c.index,p);p.applyMatrix4(c.mesh.matrixWorld);return {label:c.label,position:p.toArray()};})};},
    dispose(){disposed=true;if(model){parent.remove(model);const textures=new Set<THREE.Texture>(),materials=new Set<THREE.Material>();model.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();if(o instanceof THREE.SkinnedMesh)o.skeleton.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const value of Object.values(m))if(value instanceof THREE.Texture)textures.add(value);}}});textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());}rest.clear();},
  };
}
