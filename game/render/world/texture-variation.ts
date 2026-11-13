import * as THREE from 'three';
import { perfOn } from '../../core/perf-flags';
import { barkReliefGLSL, barkReliefBegin, barkReliefCavity, shadeDirectionalLights, type BarkRelief } from './bark-relief';

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
  // The ground layers read their patches through a height blend. The plain blend (cubed weights) lays two or three random crops
  // of the scan over one another wherever two or three weights are alive: a quarter to a third of the near ground shows over
  // 1.5 copies of the scan at once, 1.4 on average (measured by tools/ghosting). Here the taps' own heights (the colour's alpha)
  // decide: each tap stands at its height plus how much it is wanted, and within patchBand of the highest the taps share, so one
  // crop shows and the edge between two follows the relief (a stone in one crop stands over the soil of the next): 1.1 copies on
  // average. The weights are written back into the patch, so the surface read after it uses the same ones and skips the taps that
  // have none. patchBand 0 is the plain blend. relief-math.ts has the same maths in TypeScript.
  float patchBand=0.;
  void patchHeightBlend(inout TexturePatch p,vec3 heights){
    vec3 score=heights*.7+p.w;
    vec3 b=max(score-(max(score.x,max(score.y,score.z))-patchBand),0.);
    p.w=b/max(b.x+b.y+b.z,1e-5);
  }
  /** Move a patch's reads by d in its own (unrotated) texture units: the cells, taps and weights stay, and so do its gradients. */
  void shiftPatch(inout TexturePatch p,vec2 d){p.a+=patchRotate(d,p.ra);p.b+=patchRotate(d,p.rb);p.c+=patchRotate(d,p.rc);}
  // The same for one layer of a texture array (game/render/world/ground-layers.ts).
  vec4 samplePatchLayer(sampler2DArray source,inout TexturePatch p,float layer){
    if(patchBand>0.){
      // Most of a patch is one tap. A weight over .93 cannot lose to the others (they would need a height over a whole unit
      // above its own, with the band at .16), so only that tap is read.
      if(p.w.x>.93){p.w=vec3(1,0,0);return textureGrad(source,vec3(p.a,layer),patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra));}
      if(p.w.y>.93){p.w=vec3(0,1,0);return textureGrad(source,vec3(p.b,layer),patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb));}
      if(p.w.z>.93){p.w=vec3(0,0,1);return textureGrad(source,vec3(p.c,layer),patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc));}
      vec4 a=textureGrad(source,vec3(p.a,layer),patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra));
      vec4 b=textureGrad(source,vec3(p.b,layer),patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb));
      vec4 c=textureGrad(source,vec3(p.c,layer),patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc));
      patchHeightBlend(p,vec3(a.w,b.w,c.w));
      return a*p.w.x+b*p.w.y+c*p.w.z;
    }
    return textureGrad(source,vec3(p.a,layer),patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra))*p.w.x
      +textureGrad(source,vec3(p.b,layer),patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb))*p.w.y
      +textureGrad(source,vec3(p.c,layer),patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc))*p.w.z;
  }
  /** A surface layer packed as normal x, normal y, roughness: the normal (xyz, z rebuilt) and the roughness (w). */
  vec4 samplePatchLayerSurface(sampler2DArray source,TexturePatch p,float layer){
    vec3 a=vec3(.5,.5,0.),b=a,c=a;
    // A tap with no weight is not read (always the case in the interior of a height-blended patch).
    if(p.w.x>0.)a=textureGrad(source,vec3(p.a,layer),patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra)).xyz;
    if(p.w.y>0.)b=textureGrad(source,vec3(p.b,layer),patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb)).xyz;
    if(p.w.z>0.)c=textureGrad(source,vec3(p.c,layer),patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc)).xyz;
    vec2 na=patchRotate(a.xy*2.-1.,vec2(p.ra.x,-p.ra.y)),nb=patchRotate(b.xy*2.-1.,vec2(p.rb.x,-p.rb.y)),nc=patchRotate(c.xy*2.-1.,vec2(p.rc.x,-p.rc.y));
    vec2 n=na*p.w.x+nb*p.w.y+nc*p.w.z;
    return vec4(normalize(vec3(n,sqrt(max(1.-dot(n,n),.02)))),a.z*p.w.x+b.z*p.w.y+c.z*p.w.z);
  }

`;

/**
 * Preserve directional bark/wood grain while removing repeated knots and bands. With a `relief` (bark-relief.ts) the bark also
 * has depth: parallax, the sun's self-shadows in its fissures, and cavity occlusion of the indirect light. `perfOn('barkRelief')`
 * is read twice: when the program is built (off: no relief code at all, the shader from before, for an A/B that includes the
 * cost of the extra code; set it, then `material.needsUpdate` or reload) and every frame (a uniform that skips the work at once).
 */
export function varyDirectionalTexture(material: THREE.MeshStandardMaterial, relief?: BarkRelief) {
  const previous = material.onBeforeCompile;
  // Depth, self-shadow and cavity strength: kept on the material so they can be tuned in a running game.
  const strengths = new THREE.Vector3(relief?.depth, relief?.shadow ?? .85, relief?.cavity ?? 1);
  if (relief) material.userData.barkRelief = strengths;
  const reliefOn = () => !!relief && perfOn('barkRelief');
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    const on = reliefOn();
    if (on) {
      shader.uniforms.uBarkHeight = { value: relief!.height };
      shader.uniforms.uBarkRelief = { value: strengths };
      shader.uniforms.uBarkOn = { get value() { return perfOn('barkRelief') ? 1 : 0; } };
      shader.uniforms.uBarkLod = { get value() { return perfOn('barkReliefSteps') ? 1 : 0; } };
    }
    shader.vertexShader = `varying vec2 vMaterialSeed;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 materialOrigin=vec4(0.,0.,0.,1.);
        #ifdef USE_INSTANCING
          materialOrigin=instanceMatrix*materialOrigin;
        #endif
        vMaterialSeed=(modelMatrix*materialOrigin).xz;`);
    shader.fragmentShader = `${on ? '#define BARK_RELIEF\n' : ''}varying vec2 vMaterialSeed;\n${textureVariationGLSL}\n${on ? barkReliefGLSL : ''}\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', `
        TexturePatch grainPatch=texturePatch(vMapUv+patchHash(vMaterialSeed)*19.3);
        ${on ? barkReliefBegin : ''}
        diffuseColor*=samplePatch(map,grainPatch);
        float grainWeather=surfaceNoise(vMapUv*vec2(.23,.085)+vMaterialSeed*.13);
        diffuseColor.rgb*=mix(vec3(.82,.85,.78),vec3(1.08,1.05,1.01),grainWeather);`)
      .replace('#include <roughnessmap_fragment>', THREE.ShaderChunk.roughnessmap_fragment
        .replace('texture2D( roughnessMap, vRoughnessMapUv )', 'samplePatch(roughnessMap,grainPatch)'))
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps
        .replace('texture2D( normalMap, vNormalMapUv )', 'samplePatch(normalMap,grainPatch)'));
    if (on) shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', shadeDirectionalLights(THREE.ShaderChunk.lights_fragment_begin))
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${barkReliefCavity}`);
  };
  // The relief changes the program, never the shaders of the depth passes (the shadow maps see the bare trunk).
  material.customProgramCacheKey = () => `silence-directional-patches-v1-${material.vertexColors}${reliefOn() ? '-relief-v1' : ''}`;
}
