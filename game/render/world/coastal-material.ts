/** Sand, snow and leaf litter share two sampler slots, including their roughness. */
export const coastalMaterialGLSL = `
  uniform sampler2D uCoastalMap,uCoastalNormal;
  // Dry beach sand before the scan's grain (mean .51): about .36 reflectance (.43/.36/.24), a real beach's tan. .88/.76/.56 was
  // as bright but near grey, and with the forest-anchored eye the beach read as snow.
  const vec3 SAND_ALBEDO=vec3(.84,.7,.47);
  vec2 coastAtlasUV(vec2 uv,float layer){
    return vec2((fract(uv.x)*1024.+16.)/1056.,(fract(uv.y)*1024.+16.+layer*1056.)/3168.);
  }
  vec4 coastSample(sampler2D tex,vec2 uv,vec2 dx,vec2 dy,float layer){
    return textureGrad(tex,coastAtlasUV(uv,layer),dx*vec2(1024./1056.,1024./3168.),dy*vec2(1024./1056.,1024./3168.));
  }
  vec4 coastPatch(sampler2D tex,TexturePatch p,float layer){
    return coastSample(tex,p.a,patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra),layer)*p.w.x
      +coastSample(tex,p.b,patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb),layer)*p.w.y
      +coastSample(tex,p.c,patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc),layer)*p.w.z;
  }
  vec3 coastNormal(TexturePatch p,float layer){
    vec3 a=coastSample(uCoastalNormal,p.a,patchRotate(p.dx,p.ra),patchRotate(p.dy,p.ra),layer).xyz*2.-1.;
    vec3 b=coastSample(uCoastalNormal,p.b,patchRotate(p.dx,p.rb),patchRotate(p.dy,p.rb),layer).xyz*2.-1.;
    vec3 c=coastSample(uCoastalNormal,p.c,patchRotate(p.dx,p.rc),patchRotate(p.dy,p.rc),layer).xyz*2.-1.;
    a.xy=patchRotate(a.xy,vec2(p.ra.x,-p.ra.y));b.xy=patchRotate(b.xy,vec2(p.rb.x,-p.rb.y));c.xy=patchRotate(c.xy,vec2(p.rc.x,-p.rc.y));
    return normalize(a*p.w.x+b*p.w.y+c*p.w.z);
  }
`;
