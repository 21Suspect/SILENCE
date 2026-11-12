import * as THREE from 'three';
import { textureVariationGLSL, varyDirectionalTexture } from './texture-variation';

// Rock and timber variants share their scans instead of uploading another copy
// for every wet/dry material, bridge, marker and shelter.
const scannedMaps=new Map<string,THREE.Texture>();
function scannedMap(name: string, color = false) {
  const key=`${name}:${color}`;
  const cached=scannedMaps.get(key);if(cached)return cached;
  const texture = new THREE.TextureLoader().load(`/textures/${name}.jpg`);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  scannedMaps.set(key,texture);
  texture.addEventListener('dispose',()=>{if(scannedMaps.get(key)===texture)scannedMaps.delete(key);});
  return texture;
}

/** Softly eroded, asymmetric stone: 1,656 triangles, with no repeated flat facets. */
export function createRockGeometry(seed = 1): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 36, 24);
  const vertices = geometry.attributes.position;
  const phase = Math.sin(seed * 12.9898) * 123.23;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    const broad = Math.sin(x * 2.7 + phase) * Math.cos(z * 3.1 - phase) * .14
      + Math.sin(y * 3.3 + x * 1.7 + phase * .6) * .10;
    const erosion = Math.sin(x * 8.1 + y * 3.5 + phase) * Math.sin(z * 6.3 - y * 2.7) * .027;
    const r = 1 + broad + erosion;
    vertices.setXYZ(i,
      x * r * (1.06 + Math.sin(phase) * .1) + y * y * .055,
      Math.max(-.67, y * r * .83),
      z * r * (.88 + Math.cos(phase * .7) * .09) + x * y * .075,
    );
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Scanned moss and stone, projected at real-world scale without stretched poles. */
export function createRockMaterial(wet = false): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: scannedMap('rock-diff', true),
    normalMap: scannedMap('rock-normal'),
    roughnessMap: scannedMap('rock-rough'),
    normalScale: new THREE.Vector2(.76, .76),
    color: wet ? 0xc6cac4 : 0xf7f7ee,
    roughness: wet ? .48 : 1,
    metalness: 0,
  });
  material.name = wet ? 'Wet scanned mossy stone' : 'Scanned mossy stone';
  material.onBeforeCompile = shader => {
    shader.vertexShader = `varying vec3 vStoneWorld; varying vec3 vStoneNormal;\n${shader.vertexShader}`
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
        vStoneNormal = inverseTransformDirection(transformedNormal, viewMatrix);`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 stonePosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          stonePosition = instanceMatrix * stonePosition;
        #endif
        vStoneWorld = (modelMatrix * stonePosition).xyz;`);
    shader.fragmentShader = `varying vec3 vStoneWorld; varying vec3 vStoneNormal;\n${textureVariationGLSL}\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', `
        vec3 stoneWeights = pow(abs(normalize(vStoneNormal)), vec3(4.));
        stoneWeights /= max(dot(stoneWeights, vec3(1.)), .0001);
        vec3 stonePosition = vStoneWorld * .72;
        TexturePatch stoneX=texturePatch(stonePosition.zy),stoneY=texturePatch(stonePosition.xz),stoneZ=texturePatch(stonePosition.xy);
        vec4 stoneColor=samplePatch(map,stoneX)*stoneWeights.x+samplePatch(map,stoneY)*stoneWeights.y+samplePatch(map,stoneZ)*stoneWeights.z;
        stoneColor.rgb*=mix(vec3(.79,.84,.73),vec3(1.10,1.07,1.01),surfaceNoise(vStoneWorld.xz*.43+vStoneWorld.y*.12));
        diffuseColor *= stoneColor;`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        float stoneRoughness = samplePatch(roughnessMap,stoneX).g * stoneWeights.x
          + samplePatch(roughnessMap,stoneY).g * stoneWeights.y
          + samplePatch(roughnessMap,stoneZ).g * stoneWeights.z;
        roughnessFactor *= stoneRoughness;`)
      .replace('#include <normal_fragment_maps>', `
        vec3 stoneBase = normalize(vStoneNormal);
        vec3 stoneNX = samplePatch(normalMap,stoneX).xyz * 2. - 1.;
        vec3 stoneNY = samplePatch(normalMap,stoneY).xyz * 2. - 1.;
        vec3 stoneNZ = samplePatch(normalMap,stoneZ).xyz * 2. - 1.;
        stoneNX.xy *= normalScale;
        stoneNY.xy *= normalScale;
        stoneNZ.xy *= normalScale;
        vec3 stoneNormalX = vec3(stoneBase.x * abs(stoneNX.z), stoneBase.y + stoneNX.y, stoneBase.z + stoneNX.x);
        vec3 stoneNormalY = vec3(stoneBase.x + stoneNY.x, stoneBase.y * abs(stoneNY.z), stoneBase.z + stoneNY.y);
        vec3 stoneNormalZ = vec3(stoneBase.x + stoneNZ.x, stoneBase.y + stoneNZ.y, stoneBase.z * abs(stoneNZ.z));
        vec3 stoneNormal = normalize(stoneNormalX * stoneWeights.x + stoneNormalY * stoneWeights.y + stoneNormalZ * stoneWeights.z);
        normal = normalize(mat3(viewMatrix) * stoneNormal);`);
  };
  material.customProgramCacheKey = () => 'silence-stone-triplanar-patches-v2';
  return material;
}

/** Natural, pale weathered timber. UVs should use .5m per repeat along the grain. */
export function createWeatheredWoodMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: scannedMap('wood-diff', true),
    normalMap: scannedMap('wood-normal'),
    roughnessMap: scannedMap('wood-rough'),
    color: 0xffffff,
    normalScale: new THREE.Vector2(.62, .62),
    roughness: .97,
    metalness: 0,
  });
  material.name = 'Scanned weathered timber';
  varyDirectionalTexture(material);
  return material;
}
