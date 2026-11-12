import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
const file=fs.readFileSync(new URL('../../../public/creature/silence-creature.glb',import.meta.url));
const jsonLength=file.readUInt32LE(12),gltf=JSON.parse(file.subarray(20,20+jsonLength).toString());
const bin=file.subarray(28+jsonLength),bodyMesh=gltf.meshes.findIndex(m=>m.primitives.some(p=>gltf.accessors[p.indices].count>30000)),primitive=gltf.meshes[bodyMesh].primitives[0];
const components={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
const types={5121:[1,'getUint8'],5123:[2,'getUint16'],5125:[4,'getUint32'],5126:[4,'getFloat32']};
function accessor(index){const a=gltf.accessors[index],v=gltf.bufferViews[a.bufferView],type=types[a.componentType],n=components[a.type],stride=v.byteStride??n*type[0],start=(v.byteOffset??0)+(a.byteOffset??0),view=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);return Array.from({length:a.count},(_,i)=>Array.from({length:n},(_,j)=>view[type[1]](start+i*stride+j*type[0],true)));}
function nodeMatrix(index){const n=gltf.nodes[index];const m=n.matrix?new THREE.Matrix4().fromArray(n.matrix):new THREE.Matrix4().compose(new THREE.Vector3().fromArray(n.translation??[0,0,0]),new THREE.Quaternion().fromArray(n.rotation??[0,0,0,1]),new THREE.Vector3().fromArray(n.scale??[1,1,1]));const p=gltf.nodes.findIndex(n=>n.children?.includes(index));return p>=0?nodeMatrix(p).multiply(m):m;}
const meshNode=gltf.nodes.findIndex(n=>n.mesh===bodyMesh),matrix=nodeMatrix(meshNode),skin=gltf.skins[gltf.nodes[meshNode].skin];
const positions=accessor(primitive.attributes.POSITION),weights=accessor(primitive.attributes.WEIGHTS_0),joints=accessor(primitive.attributes.JOINTS_0);
test('sculpt exports a bounded skin and eye draw with normalized weights',()=>{
  assert.equal(gltf.meshes.length,2);assert.equal(gltf.meshes[bodyMesh].primitives.length,1);assert.equal(skin.joints.length,50);
  const triangles=gltf.accessors[primitive.indices].count/3;assert.ok(triangles>50000&&triangles<80000);
  for(const w of weights)assert.ok(Math.abs(w.reduce((a,b)=>a+b,0)-1)<1e-5);
});
test('all six actual contact tips are rigidly attached to their toe bones',()=>{
  const p=new THREE.Vector3();
  for(const side of [-1,1])for(let leg=0;leg<3;leg++){
    const label=(side<0?'L':'R')+leg,target=new THREE.Vector3(side*(2.22+leg*.16)+side*.1,.017,1.85-leg*1.8+.13);let best=Infinity,index=-1;
    positions.forEach((v,i)=>{p.fromArray(v).applyMatrix4(matrix);const d=p.distanceToSquared(target);if(d<best){best=d;index=i;}});
    assert.ok(best<.01,`${label} actual tip stays close to its bind contact`);
    const dominant=weights[index].indexOf(Math.max(...weights[index])),boneName=gltf.nodes[skin.joints[joints[index][dominant]]].name;
    assert.equal(boneName,`toe_${label}`);assert.ok(weights[index][dominant]>.99999,`${label} tip must not slide with another bone`);
  }
});
test('the baked skin surface has no open edges, including knees and attachments',()=>{
  const edges=new Map(),ids=new Map(),vertexIds=positions.map(p=>{const key=p.map(v=>Math.round(v*1e6)).join(',');if(!ids.has(key))ids.set(key,ids.size);return ids.get(key);});
  const indices=accessor(primitive.indices).flat();for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){const a=vertexIds[indices[i+j]],b=vertexIds[indices[i+(j+1)%3]];if(a===b)continue;const key=a<b?`${a}:${b}`:`${b}:${a}`;edges.set(key,(edges.get(key)??0)+1);}
  for(const count of edges.values())assert.equal(count,2);
});

test('eyes are independently emissive and skin includes baked roughness',()=>{
  const eyes=gltf.materials.find(m=>m.name==='Cold ivory eyes');
  assert.ok(eyes?.emissiveFactor?.every(v=>v>0.4),'glowing eyes retain cold ivory emission');
  const body=gltf.materials[primitive.material];
  assert.ok(body.pbrMetallicRoughness.baseColorTexture);
  assert.ok(body.normalTexture);
  assert.ok(body.pbrMetallicRoughness.metallicRoughnessTexture,'skin specularity varies across the anatomy');
});

function descendantsOf(node,ancestor){let n=node;while(n>=0){if(n===ancestor)return true;n=gltf.nodes.findIndex(p=>p.children?.includes(n));}return false;}
const inverses=accessor(skin.inverseBindMatrices).map(m=>new THREE.Matrix4().fromArray(m));
function skinPoint(index,boneName,angle){
  const target=gltf.nodes.findIndex(n=>n.name===boneName),pivot=new THREE.Vector3().setFromMatrixPosition(nodeMatrix(target));
  const delta=new THREE.Matrix4().makeTranslation(pivot.x,pivot.y,pivot.z).multiply(new THREE.Matrix4().makeRotationX(angle)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));
  const result=new THREE.Vector3(),point=new THREE.Vector3();
  for(let j=0;j<4;j++){const w=weights[index][j];if(!w)continue;const k=joints[index][j],node=skin.joints[k],m=nodeMatrix(node);if(descendantsOf(node,target))m.premultiply(delta);m.multiply(inverses[k]);point.fromArray(positions[index]).applyMatrix4(m);result.addScaledVector(point,w);}return result;
}
test('jaw, wrists and both joints of every finger deform weighted skin',()=>{
  const names=['neck','head','jaw','wrist_L','wrist_R',...['L','R'].flatMap(side=>Array.from({length:4},(_,i)=>[`finger_${side}${i}`,`tip_${side}${i}`]).flat())];
  for(const name of names){
    const bone=gltf.nodes.findIndex(n=>n.name===name),joint=skin.joints.indexOf(bone);let affected=0,displacement=0;
    for(let i=0;i<positions.length;i++){const weight=weights[i].reduce((sum,w,j)=>sum+(joints[i][j]===joint?w:0),0);if(weight<.65)continue;affected++;displacement=Math.max(displacement,skinPoint(i,name,.25).distanceTo(skinPoint(i,name,0)));}
    assert.ok(affected>=4,`${name} needs real weighted surface vertices`);assert.ok(displacement>.004,`${name} must visibly deform skin, not only a bone`);
  }
});
test('eyes remain rigidly attached to the articulated head',()=>{
  const eyeMesh=gltf.meshes.findIndex(m=>m!==gltf.meshes[bodyMesh]),eye=gltf.meshes[eyeMesh].primitives[0];
  const ni=gltf.nodes.findIndex(n=>n.mesh===eyeMesh),eyeSkin=gltf.skins[gltf.nodes[ni].skin],w=accessor(eye.attributes.WEIGHTS_0),j=accessor(eye.attributes.JOINTS_0);
  for(let i=0;i<w.length;i++){const dominant=w[i].indexOf(Math.max(...w[i]));assert.equal(gltf.nodes[eyeSkin.joints[j[i][dominant]]].name,'head');assert.ok(w[i][dominant]>.99999);}
});
