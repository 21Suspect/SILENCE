import * as THREE from 'three';

// A continuous triangular blend of randomly offset texture patches. Explicit
// gradients preserve mip selection at patch boundaries and at grazing angles.
// The same coordinates/weights are used for colour, normals and roughness.
export const textureVariationGLSL = `
  vec2 patchHash(vec2 p) {
    vec3 q=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));
    q+=dot(q,q.yzx+33.33);
    return fract((q.xx+q.yz)*q.zy);
  }
  float surfaceNoise(vec2 p) {
    vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(patchHash(i).x,patchHash(i+vec2(1,0)).x,f.x),
      mix(patchHash(i+vec2(0,1)).x,patchHash(i+vec2(1,1)).x,f.x),f.y);
  }
  vec2 patchRotate(vec2 v,vec2 r){return vec2(r.x*v.x-r.y*v.y,r.y*v.x+r.x*v.y);}
  vec2 patchRotation(vec2 cell,float rotate){
    float k=floor(patchHash(cell+73.).x*4.)*rotate;
    return k<.5?vec2(1,0):k<1.5?vec2(0,1):k<2.5?vec2(-1,0):vec2(0,-1);
  }
  struct TexturePatch {vec2 a;vec2 b;vec2 c;vec3 w;vec2 dx;vec2 dy;vec2 ra;vec2 rb;vec2 rc;};
  TexturePatch texturePatch(vec2 uv,float rotate) {
    vec2 skew=vec2(uv.x-uv.y*.577350269,uv.y*1.154700538)*.72;
    vec2 cell=floor(skew),f=fract(skew),a,b,c;vec3 w;
    if(f.x+f.y<1.) {a=cell;b=cell+vec2(1,0);c=cell+vec2(0,1);w=vec3(1.-f.x-f.y,f.x,f.y);}
    else {a=cell+vec2(1,1);b=cell+vec2(0,1);c=cell+vec2(1,0);w=vec3(f.x+f.y-1.,1.-f.x,1.-f.y);}
    // Most of a patch retains the sharp source scan; only its edges crossfade.
    w=pow(max(w,vec3(0.)),vec3(3.));w/=max(dot(w,vec3(1.)),.0001);
    vec2 ra=patchRotation(a,rotate),rb=patchRotation(b,rotate),rc=patchRotation(c,rotate);
    return TexturePatch(patchRotate(uv,ra)+patchHash(a)*31.7,patchRotate(uv,rb)+patchHash(b)*31.7,
      patchRotate(uv,rc)+patchHash(c)*31.7,w,dFdx(uv),dFdy(uv),ra,rb,rc);
  }
  TexturePatch texturePatch(vec2 uv){return texturePatch(uv,0.);}
  TexturePatch groundTexturePatch(vec2 uv){return texturePatch(uv,1.);}
  vec4 samplePatch(sampler2D source,TexturePatch p) {
    return textureGrad(source,p.a,patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra))*p.w.x
      +textureGrad(source,p.b,patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb))*p.w.y
      +textureGrad(source,p.c,patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc))*p.w.z;
  }
  /** The normal (xyz) and the roughness in the alpha channel (w) of a normal-rough map, from one set of reads. */
  vec4 samplePatchNormalRough(sampler2D source,TexturePatch p){
    vec4 a=textureGrad(source,p.a,patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra));
    vec4 b=textureGrad(source,p.b,patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb));
    vec4 c=textureGrad(source,p.c,patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc));
    vec3 na=a.xyz*2.-1.,nb=b.xyz*2.-1.,nc=c.xyz*2.-1.;
    na.xy=patchRotate(na.xy,vec2(p.ra.x,-p.ra.y));
    nb.xy=patchRotate(nb.xy,vec2(p.rb.x,-p.rb.y));
    nc.xy=patchRotate(nc.xy,vec2(p.rc.x,-p.rc.y));
    return vec4(normalize(na*p.w.x+nb*p.w.y+nc*p.w.z),a.w*p.w.x+b.w*p.w.y+c.w*p.w.z);
  }
  vec3 samplePatchNormal(sampler2D source,TexturePatch p){
    vec3 a=textureGrad(source,p.a,patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra)).xyz*2.-1.;
    vec3 b=textureGrad(source,p.b,patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb)).xyz*2.-1.;
    vec3 c=textureGrad(source,p.c,patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc)).xyz*2.-1.;
    // Bring tangent-space normals back into the unrotated ground basis.
    a.xy=patchRotate(a.xy,vec2(p.ra.x,-p.ra.y));
    b.xy=patchRotate(b.xy,vec2(p.rb.x,-p.rb.y));
    c.xy=patchRotate(c.xy,vec2(p.rc.x,-p.rc.y));
    return normalize(a*p.w.x+b*p.w.y+c*p.w.z);
  }

`;

/** Preserve directional bark/wood grain while removing repeated knots and bands. */
export function varyDirectionalTexture(material: THREE.MeshStandardMaterial) {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    shader.vertexShader = `varying vec2 vMaterialSeed;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 materialOrigin=vec4(0.,0.,0.,1.);
        #ifdef USE_INSTANCING
          materialOrigin=instanceMatrix*materialOrigin;
        #endif
        vMaterialSeed=(modelMatrix*materialOrigin).xz;`);
    shader.fragmentShader = `varying vec2 vMaterialSeed;\n${textureVariationGLSL}\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', `
        TexturePatch grainPatch=texturePatch(vMapUv+patchHash(vMaterialSeed)*19.3);
        diffuseColor*=samplePatch(map,grainPatch);
        float grainWeather=surfaceNoise(vMapUv*vec2(.23,.085)+vMaterialSeed*.13);
        diffuseColor.rgb*=mix(vec3(.82,.85,.78),vec3(1.08,1.05,1.01),grainWeather);`)
      .replace('#include <roughnessmap_fragment>', THREE.ShaderChunk.roughnessmap_fragment
        .replace('texture2D( roughnessMap, vRoughnessMapUv )', 'samplePatch(roughnessMap,grainPatch)'))
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps
        .replace('texture2D( normalMap, vNormalMapUv )', 'samplePatch(normalMap,grainPatch)'));
  };
  material.customProgramCacheKey = () => `silence-directional-patches-v1-${material.vertexColors}`;
}
