import * as THREE from 'three';
import { horizonGLSL } from './terrain-horizon';
import { farShadowGLSL, type FarShadow } from './far-shadow';
import { lodDitherGLSL } from './lod-dither';
import { perfOn } from '../../core/perf-flags';

/**
 * Impostors: the far levels of detail of the world's own models (trees, plants, rocks, logs). Each model is photographed at load
 * from eight sides into an atlas of colour and of normals, with its real materials' maps and colours, exactly as the streamed
 * level it stands in for draws it where it takes over (a tree's far trunk and light crown); far off, every instance of it is one
 * quad turned to the eye, showing its model from that side, lit by the sun and sky with the streamed model's own lighting,
 * shadowed by the island-wide shadow (far-shadow.ts) at its real surface, which it also casts into, turned to the sun. Nothing
 * about a thing changes with distance but how many pixels it gets.
 *
 * Each view is drawn at four times its frame's size and shrunk 4 x 4 to 1 with its cover kept as alpha (drawn at the frame's
 * own size a spruce's sprays came out as single pixels and the tree as a bare skeleton); normals are kept at half the colour's
 * size, light varying more slowly over a model than colour, averaged and not renormalised (how much they agree is part of how a
 * texel lights), with each texel's depth in front of or behind the model's axis in their alpha.
 *
 * The two views nearest the eye are blended, each reprojected by its depth to where the eye's ray meets the model (Brucks'
 * parallax between frames), so a limb is not shown twice half-way between views. A frame is fitted to its model, as wide as the
 * model turns and as tall as it is: a square frame round a tall narrow tree left three quarters of every quad empty, pixels that
 * were sampled and thrown away (fitted hulls shave such pixels in Brucks' and Usnul's impostors); it keeps its square of texels,
 * so a narrow model is photographed sharper across than up. A texel's cover goes to the multisampled target as coverage (alpha
 * to coverage), as a streamed crown's sub-pixel sprays cover part of a pixel. Measured against the streamed trees drawn out to
 * 220 m (dev ?tree-range=220, ?impostor-ab), the far band's tree pixels cover .602 of it against .604 and are within 2 to 6% in
 * colour.
 */
export const IMPOSTOR_VIEWS = 8;
const UP = new THREE.Vector3(0, 1, 0);

/** A model: its parts with their materials (`foliage` is kept for the callers; every part is baked by the same rules). */
export type ImpostorModel = { parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; foliage?: boolean }[] };
export type ImpostorAtlas = ReturnType<typeof createImpostorAtlas>;

/** One part's look for the bake: its colour (map x colour x vertex colour), or its normal in the model's frame, where it is solid. */
function bakeMaterial(source: THREE.Material, foliage: boolean, centreY: { value: number }) {
  const m = source as THREE.MeshStandardMaterial;
  return new THREE.ShaderMaterial({
    vertexColors: !!m.vertexColors, side: THREE.DoubleSide,
    uniforms: {
      uMap: { value: m.map ?? null }, uHasMap: { value: m.map ? 1 : 0 }, uAlpha: { value: m.alphaMap ?? null }, uHasAlpha: { value: m.alphaMap ? 1 : 0 },
      uColor: { value: m.color?.clone() ?? new THREE.Color(1, 1, 1) }, uMode: { value: 0 }, uCentreY: centreY, uFoliage: { value: foliage ? 1 : 0 },
      uCut: { value: Math.max(.3, m.alphaTest || 0) },
    },
    vertexShader: `varying vec2 vUv;varying vec3 vObjNormal,vObjPos,vTint;
      void main(){vUv=uv;vObjNormal=normal;vObjPos=position;
        #ifdef USE_COLOR
          vTint=color;
        #else
          vTint=vec3(1.);
        #endif
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform sampler2D uMap,uAlpha;uniform vec3 uColor;uniform float uHasMap,uHasAlpha,uMode,uCentreY,uFoliage,uCut;varying vec2 vUv;varying vec3 vObjNormal,vObjPos,vTint;
      void main(){
        if(uHasAlpha>.5&&texture2D(uAlpha,vUv).g<uCut)discard;
        if(uMode<.5){gl_FragColor=vec4((uHasMap>.5?texture2D(uMap,vUv).rgb:vec3(1.))*uColor*vTint,1.);return;}
        // Exactly the normal the streamed model shades with: its own (a crown's cards carry the crown's outward volume normal,
        // conifer.ts), turned to the eye on a card's back face as three does for double-sided materials.
        vec3 n=normalize(vObjNormal);if(!gl_FrontFacing)n=-n;
        gl_FragColor=vec4(n*.5+.5,1.);
      }`,
  });
}

/**
 * Whether every map is in. A loader's texture has no image at all until it arrives, so no image means not yet (counted as ready,
 * a fresh page baked the crowns before their alpha maps came and drew bare skeletons for the rest of the session). Past `patience`
 * milliseconds a map that never comes no longer holds the bake up.
 */
export function mapsLoaded(textures: Iterable<THREE.Texture | null | undefined>, since = 0, patience = 30000) {
  if (since && performance.now() - since > patience) return true;
  for (const t of textures) {
    if (!t) continue;
    const image = t.image as { width?: number; complete?: boolean } | undefined;
    if (!image || !(image.width! > 0) || image.complete === false) return false;
  }
  return true;
}

/** `frame` is the texels a view gets; `clear` the colour the edges' mip levels fade to (the models' own dark tone). */
export function createImpostorAtlas(renderer: THREE.WebGLRenderer, models: ImpostorModel[], { frame = 256, clear = [.035, .05, .03] as readonly [number, number, number], selfShade = false } = {}) {
  const count = models.length, width = frame * IMPOSTOR_VIEWS, height = frame * count;
  const target = (srgb: boolean, scale: number) => {
    const t = new THREE.WebGLRenderTarget(width * scale, height * scale, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    if (srgb) t.texture.colorSpace = THREE.SRGBColorSpace;
    // A narrow model's texels are finer across than up (fitted frames): anisotropic filtering keeps the finer axis.
    t.texture.anisotropy = 8;
    return t;
  };
  // Colour in sRGB bytes: dark foliage (linear .02 to .05) kept in linear bytes banded into a few steps.
  const albedo = target(true, 1), normals = target(false, .5);
  /** Per model, in model units: the frame's width and height, its centre's height and the model's reach from its axis. */
  const frames = Array.from({ length: count }, () => new THREE.Vector4());
  const textures = new Set<THREE.Texture>();
  for (const model of models) for (const part of model.parts) for (const material of Array.isArray(part.material) ? part.material : [part.material]) {
    const m = material as THREE.MeshStandardMaterial;
    for (const t of [m.map, m.alphaMap]) if (t) textures.add(t);
  }
  let baked = false;
  const created = performance.now();
  function bake() {
    const scene = new THREE.Scene(), centreY = { value: 0 };
    const meshes: THREE.Mesh[] = [];
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100);
    const saved = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
    renderer.autoClear = false;
    for (const t of [albedo, normals]) { t.texture.generateMipmaps = true; renderer.initRenderTarget(t); t.texture.generateMipmaps = false; }
    renderer.setRenderTarget(albedo); renderer.setClearColor(new THREE.Color(...clear), 0); renderer.clear();
    renderer.setRenderTarget(normals); renderer.setClearColor(new THREE.Color(.5, 1, .5), 0); renderer.clear();
    const fine = new THREE.WebGLRenderTarget(frame * 4, frame * 4, { type: THREE.HalfFloatType, depthBuffer: true });
    fine.depthTexture = new THREE.DepthTexture(frame * 4, frame * 4, THREE.UnsignedIntType);
    const shrink = new THREE.ShaderMaterial({
      uniforms: { uSource: { value: fine.texture }, uDepth: { value: fine.depthTexture }, uRange: { value: 1 }, uMode: { value: 0 }, uOrigin: { value: new THREE.Vector2() }, uFactor: { value: 4 }, uClear: { value: new THREE.Vector3(...clear) },
        uAspect: { value: 1 }, uNear: { value: 0 }, uAxis: { value: 1 }, uReach: { value: 1 }, uSelfShade: { value: selfShade ? 1 : 0 } },
      vertexShader: 'void main(){gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: `uniform sampler2D uSource,uDepth;uniform float uMode,uRange,uAspect,uNear,uAxis,uReach,uSelfShade;uniform vec2 uOrigin;uniform int uFactor;uniform vec3 uClear;
        void main(){
          ivec2 p=ivec2(gl_FragCoord.xy-uOrigin)*uFactor;vec3 sum=vec3(0.);float cover=0.;
          // The model's own shade: how far each texel lies behind the model's outer surface round it (the nearest depth within about
          // a metre), as the streamed models get it from the sun's shadow map and the ambient occlusion pass: a crown's inner
          // branches and sprays stand in its shade. Without it they were photographed in full light and washed the crowns khaki.
          float hull=1.;ivec2 size=textureSize(uDepth,0);
          if(uMode<.5)for(int r=1;r<=3;r++)for(int k=0;k<12;k++){
            // (Across, a texel is narrower than up by the frame's aspect: the same metres either way.)
            float a=float(k)*.5236+float(r)*.4,rad=float(r*r)*6.;
            ivec2 q=clamp(p+ivec2(cos(a)*rad*uAspect,sin(a)*rad),ivec2(0),size-1);hull=min(hull,texelFetch(uDepth,q,0).r);
          }
          float depth=0.;
          for(int y=0;y<8;y++){if(y>=uFactor)break;for(int x=0;x<8;x++){if(x>=uFactor)break;
            vec4 t=texelFetch(uSource,p+ivec2(x,y),0);
            float shade=1.,d=texelFetch(uDepth,p+ivec2(x,y),0).r;
            if(uMode<.5){hull=min(hull,d);shade=mix(1.,mix(.5,1.,exp(-max(d-hull,0.)*uRange/1.4)),uSelfShade);}
            // Normals carry the depth: metres behind (+) or in front of (-) the model's axis, over twice its reach.
            else depth+=t.a*clamp((uNear+d*uRange-uAxis)/(2.*uReach)+.5,0.,1.);
            sum+=t.rgb*t.a*shade;cover+=t.a;}}
          vec3 c=cover>0.?sum/cover:(uMode<.5?uClear:vec3(.5,1.,.5));
          // The normals are averaged and not renormalised: how long the mean is says how much the normals under a texel agree
          // (a smooth trunk's are one, a crown's sprays half of them flipped to the eye are short), and the lighting uses that.
          if(uMode>.5){gl_FragColor=vec4(c,cover>0.?depth/cover:.5);return;}
          gl_FragColor=vec4(c,cover/float(uFactor*uFactor));
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Scene(), quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quad.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shrink));
    const materials = new Map<string, THREE.ShaderMaterial>();
    const bakeOf = (m: THREE.Material, foliage: boolean) => { const key = `${m.uuid}|${foliage}`; let b = materials.get(key); if (!b) materials.set(key, b = bakeMaterial(m, foliage, centreY)); return b; };
    for (let m = 0; m < count; m++) {
      const model = models[m];
      for (const mesh of meshes) scene.remove(mesh);
      meshes.length = 0;
      const box = new THREE.Box3();
      let reach = 0;
      for (const part of model.parts) {
        part.geometry.computeBoundingBox(); box.union(part.geometry.boundingBox!);
        const position = part.geometry.getAttribute('position');
        for (let i = 0; i < position.count; i++) reach = Math.max(reach, Math.hypot(position.getX(i), position.getZ(i)));
        const mesh = new THREE.Mesh(part.geometry, Array.isArray(part.material) ? part.material.map(x => bakeOf(x, !!part.foliage)) : bakeOf(part.material, !!part.foliage)); scene.add(mesh); meshes.push(mesh);
      }
      // The axis is the model's own (x, z) origin, about which its instances turn: a frame round it as wide as the model's reach
      // holds every view without clipping a corner.
      const wide = reach * 2 * 1.04, tall = (box.max.y - box.min.y) * 1.04, cy = (box.min.y + box.max.y) / 2, back = Math.max(wide, tall) * 2;
      frames[m].set(wide, tall, cy, reach); centreY.value = cy;
      camera.left = -wide / 2; camera.right = wide / 2; camera.top = tall / 2; camera.bottom = -tall / 2; camera.near = .01; camera.far = back * 2; camera.updateProjectionMatrix();
      const u = shrink.uniforms; u.uAspect.value = tall / wide; u.uNear.value = camera.near; u.uAxis.value = back; u.uReach.value = Math.max(reach, 1e-3);
      for (let k = 0; k < IMPOSTOR_VIEWS; k++) {
        const a = k / IMPOSTOR_VIEWS * Math.PI * 2;
        camera.position.set(Math.sin(a) * back, cy, Math.cos(a) * back); camera.lookAt(0, cy, 0); camera.updateMatrixWorld();
        for (const [t, mode] of [[albedo, 0], [normals, 1]] as const) {
          for (const mat of materials.values()) mat.uniforms.uMode.value = mode;
          renderer.setRenderTarget(fine); renderer.setClearColor(new THREE.Color(0, 0, 0), 0); renderer.clear(); renderer.render(scene, camera);
          const f = mode ? frame / 2 : frame;
          shrink.uniforms.uMode.value = mode; shrink.uniforms.uOrigin.value.set(k * f, m * f); shrink.uniforms.uFactor.value = mode ? 8 : 4; shrink.uniforms.uRange.value = camera.far - camera.near;
          t.viewport.set(k * f, m * f, f, f); t.scissor.copy(t.viewport); t.scissorTest = true;
          renderer.setRenderTarget(t); renderer.render(quad, quadCamera);
        }
      }
    }
    // The mip levels, once, now that every frame is in.
    for (const t of [albedo, normals]) { t.scissorTest = false; t.viewport.set(0, 0, t.width, t.height); t.texture.generateMipmaps = true; renderer.setRenderTarget(t); renderer.render(new THREE.Scene(), camera); }
    renderer.setRenderTarget(saved.target); renderer.autoClear = saved.autoClear; renderer.setClearColor(saved.color, saved.alpha);
    for (const mat of materials.values()) mat.dispose();
    fine.depthTexture?.dispose(); fine.dispose(); shrink.dispose(); (quad.children[0] as THREE.Mesh).geometry.dispose();
    baked = true;
  }
  return {
    albedo, normals, frames, count, width, height,
    get baked() { return baked; },
    /** True once every map the models read has loaded. */
    ready: () => mapsLoaded(textures, created),
    bake,
    dispose() { albedo.dispose(); normals.dispose(); },
  };
}

export type ImpostorLook = {
  /** Metres from the eye over which they dissolve in (the streamed models dissolving out over the same band). */
  fadeIn: readonly [number, number];
  /** And out again, past where they are a pixel or two; none by default. */
  fadeOut?: readonly [number, number];
  /** How much light foliage lets through from behind, against the streamed crowns' (forest.ts foliageWind: 1); 0 none. */
  translucent?: number;
  /** A colour over the baked one, and how much the lower part stands in its neighbours' shade (0 none). */
  tint?: readonly [number, number, number]; standShade?: number;
  /** The share of a texel's cover below which it is cut out. */
  cut?: number;
  /** Sky light kept (stands and thickets block much of the sky). */
  sky?: number;
  /** Each instance carries its own bands (iFade: in from, in to, out from, out to, metres): plants of several kinds in one draw. */
  instanceFade?: boolean;
};

/** The impostors' material for one look; instances carry iPos, iShape (yaw, height, width, model), iTint, horizonA/B. */
export function impostorMaterial(atlas: ImpostorAtlas, scene: THREE.Scene, eye: { value: THREE.Vector3 }, look: ImpostorLook, farShadow?: FarShadow, key = '') {
  const { count, width, height } = atlas, [near, far] = look.fadeIn, out = look.fadeOut ?? [1e5, 1.1e5];
  const tint = look.tint ?? [1, 1, 1], cut = look.cut ?? .5, stand = look.standShade ?? 0, sky = look.sky ?? 1;
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .9, metalness: 0, alphaToCoverage: true });
  material.onBeforeCompile = shader => {
    shader.uniforms.uAlbedo = { value: atlas.albedo.texture }; shader.uniforms.uNormals = { value: atlas.normals.texture };
    shader.uniforms.uFrames = { value: atlas.frames }; shader.uniforms.uEye = eye;
    if (farShadow) Object.assign(shader.uniforms, farShadow.uniforms);
    shader.uniforms.uSunDirection = { get value() { return (scene.userData.sunDirection as THREE.Vector3 | undefined) ?? UP; } };
    shader.vertexShader = `attribute vec3 iPos,iTint;attribute vec4 iShape,iFade;attribute vec4 horizonA,horizonB;uniform vec4 uFrames[${count}];uniform vec3 uEye;
      varying vec2 vAtlasA,vAtlasB,vFade,vToEye,vCell,vViews;varying float vBlend,vYaw,vUp,vDepthScale,vRow,vReachW;varying vec4 vHorizonA,vHorizonB;varying vec3 vFFWorld,vTintI;\n${shader.vertexShader}`
      .replace('#include <beginnormal_vertex>', `
        // Turned to the eye about its own axis; the view of its model from the eye's side, in its own frame (its yaw undone).
        vec2 toEye=normalize(cameraPosition.xz-iPos.xz+vec2(1e-4,0.));
        vec3 bbRight=vec3(toEye.y,0.,-toEye.x);
        vec4 frame=uFrames[int(iShape.w+.5)];
        float cy=cos(iShape.x),sy=sin(iShape.x);
        vec2 inModel=vec2(toEye.x*cy-toEye.y*sy,toEye.x*sy+toEye.y*cy);
        float view=mod(atan(inModel.x,inModel.y)/6.2831853*${IMPOSTOR_VIEWS}.+${IMPOSTOR_VIEWS}.,${IMPOSTOR_VIEWS}.),k0=floor(view);
        vBlend=view-k0;vYaw=iShape.x;vTintI=iTint;
        vec2 cell=position.xy+.5;vUp=cell.y;
        vAtlasA=(vec2(k0,iShape.w)+cell)/vec2(${IMPOSTOR_VIEWS}.,${count}.);vAtlasB=(vec2(mod(k0+1.,${IMPOSTOR_VIEWS}.),iShape.w)+cell)/vec2(${IMPOSTOR_VIEWS}.,${count}.);
        vCell=cell;vViews=vec2(k0,mod(k0+1.,${IMPOSTOR_VIEWS}.));vRow=iShape.w;vReachW=2.*frame.w/frame.x;
        vec2 fromEye=iPos.xz-uEye.xz;float eye2=dot(fromEye,fromEye);
        // In across its band (complementary to the streamed model fading out over it, lod-dither.ts), out where it is a pixel or two.
        ${look.instanceFade ? 'vFade=vec2(smoothstep(iFade.x*iFade.x,iFade.y*iFade.y,eye2),1.-smoothstep(iFade.z*iFade.z,iFade.w*iFade.w,eye2));' : `vFade=vec2(smoothstep(${(near * near).toFixed(2)},${(far * far).toFixed(2)},eye2),1.-smoothstep(${(out[0] * out[0]).toFixed(1)},${(out[1] * out[1]).toFixed(1)},eye2));`}
        vHorizonA=horizonA;vHorizonB=horizonB;vToEye=toEye;vDepthScale=2.*frame.w*iShape.z;
        vec3 ffWorld=iPos+bbRight*(position.x*frame.x*iShape.z)+vec3(0.,(frame.z+position.y*frame.y)*iShape.y,0.);
        if(vFade.x<=0.||vFade.y<=0.)ffWorld=iPos;
        vFFWorld=ffWorld;
        vec3 objectNormal=vec3(toEye.x,0.,toEye.y);`)
      .replace('#include <begin_vertex>', 'vec3 transformed=ffWorld;');
    shader.fragmentShader = `uniform sampler2D uAlbedo,uNormals;uniform vec3 uSunDirection;varying vec2 vAtlasA,vAtlasB,vFade,vToEye,vCell,vViews;varying float vBlend,vYaw,vUp,vDepthScale,vRow,vReachW;varying vec3 vFFWorld,vTintI;\n${horizonGLSL}\n${farShadow ? farShadowGLSL : 'float farShadow(vec3 p,float b){return 1.;}'}\n${lodDitherGLSL}
      vec3 ffNormal,ffPoint;float ffLen=1.;
      // The same gradient noise as the hand-over dither, moved by a few pixels so the two decisions are not the same one.
      float ffRound(){return fract(52.9829189*fract(dot(floor(gl_FragCoord.xy)+vec2(17.,43.),vec2(.06711056,.00583715))));}
      vec2 ffAt(float k,vec2 c){return (vec2(k,vRow)+c)/vec2(${IMPOSTOR_VIEWS}.,${count}.);}
      // Where the eye's ray through this pixel meets the model as view k photographed it, turned turn radians from the eye: a
      // point x across and t towards the eye sits at x cos(turn) - t sin(turn) across view k. Its depth is read from the view
      // itself, twice (Brucks' parallax between frames): without it two views 45 degrees apart were blended pixel for pixel and
      // every limb showed twice, a pine's whorls smeared into flat slabs.
      vec2 ffView(float k,float turn,vec2 gx,vec2 gy){
        float cs=cos(turn),sn=sin(turn),x=(vCell.x-.5)*cs;vec2 c=vec2(.5+x,vCell.y);
        for(int i=0;i<2;i++){float t=-(textureGrad(uNormals,ffAt(k,c),gx,gy).a-.5)*vReachW;c.x=clamp(.5+x-t*sn,.002,.998);}
        return ffAt(k,c);
      }\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', `{
        // Between two views the two are blended, cover and colour (a per-pixel choice between them read as noise over every model).
        vec2 gx=dFdx(vAtlasA),gy=dFdy(vAtlasA),uvA=ffView(vViews.x,-vBlend*${(2 * Math.PI / IMPOSTOR_VIEWS).toFixed(6)},gx,gy),uvB=ffView(vViews.y,(1.-vBlend)*${(2 * Math.PI / IMPOSTOR_VIEWS).toFixed(6)},gx,gy);
        vec4 a0=textureGrad(uAlbedo,uvA,gx,gy),a1=textureGrad(uAlbedo,uvB,gx,gy);
        // The cover is the true fraction of each texel the model fills, and a texel is about a pixel where impostors stand in: it
        // goes to the multisampled target as coverage (alpha to coverage), as the streamed crowns' sub-pixel sprays cover part of
        // a pixel's samples. Cut and sharpened instead, every half-filled texel went solid and the far crowns came out a fifth
        // denser than the real ones. Its mip levels average it, which is still the true cover: nothing is raised for them, as an
        // alpha-tested texture's must be (Golus) because a threshold eats what averaging thins.
        // In whole samples of the four (between them the driver dithers coverage over neighbouring pixels, a visible half-tone),
        // rounded up or down by a dither so that on average it is the true cover: rounded to the nearest, a tree under an eighth
        // of a pixel was always rounded away, and far stands seen from above against the ground vanished in whole bands, where
        // the streamed trees' sub-pixel sprays still hit their share of a pixel's samples.
        float cover=mix(a0.a,a1.a,vBlend),samples=floor(cover*4.+ffRound());
        if(samples<=0.||lodFadeDiscard(vFade.x,vFade.y))discard;
        diffuseColor.a=min(samples*.25,1.);
        float w1=a1.a*vBlend,w0=a0.a*(1.-vBlend);
        diffuseColor.rgb*=(a0.rgb*w0+a1.rgb*w1)/max(w0+w1,1e-3)*vec3(${tint.map(v => v.toFixed(3)).join(',')})*vTintI;
        ${stand > 0 ? `diffuseColor.rgb*=mix(${(1 - stand).toFixed(3)},1.,smoothstep(.15,.75,vUp));` : ''}
        vec4 n0=textureGrad(uNormals,uvA,gx,gy),n1=textureGrad(uNormals,uvB,gx,gy),n=(n0*w0+n1*w1)/max(w0+w1,1e-3);
        ffNormal=n.xyz*2.-1.;ffLen=clamp(length(ffNormal),0.,1.);
        // The model's real surface under this pixel: in front of or behind the quad by the baked depth, towards or away from the eye.
        ffPoint=vFFWorld-vec3(vToEye.x,0.,vToEye.y)*(n.a-.5)*vDepthScale;
      }`)
      // The streamed model's own lighting (front light, and for foliage light through the leaf, forest.ts foliageWind), summed
      // over the normals a texel stands for: with a mean normal m of length |m|, the clamped cosine over them is about
      // (1 - |m|) / 4 + |m| max(0, cos) (its first spherical harmonics), so a texel of sprays facing every way lights as the
      // sprays do on average, and one of smooth bark as the bark.
      .replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment.replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
        `{float nl=dot( geometryNormal, directLight.direction ),spread=(1.-ffLen)*.25;
        reflectedLight.directDiffuse += ( spread + ffLen * max( nl, 0. ) ) * directLight.color * BRDF_Lambert( material.diffuseColor );
        ${look.translucent ? `reflectedLight.directDiffuse += ( spread + ffLen * max( - nl, 0. ) ) * directLight.color * BRDF_Lambert( material.diffuseColor ) * vec3( .6, .68, .3 ) * ${look.translucent.toFixed(3)};` : ''}}`))
      .replace('#include <normal_fragment_maps>', `{
        float c=cos(vYaw),s=sin(vYaw);
        normal=normalize((viewMatrix*vec4(ffNormal.x*c+ffNormal.z*s,ffNormal.y,-ffNormal.x*s+ffNormal.z*c,0.)).xyz);
      }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {float sh=horizonShadow(normalize(uSunDirection))*farShadow(ffPoint,1.2),sky=horizonSky()*${sky.toFixed(3)};reflectedLight.directDiffuse*=sh;reflectedLight.directSpecular*=sh;reflectedLight.indirectDiffuse*=sky;reflectedLight.indirectSpecular*=sky;}`);
  };
  material.customProgramCacheKey = () => `silence-impostor-v6-${key}-${near}-${far}-${out[0]}-${tint.join(',')}-${cut}-${stand}-${sky}-${look.translucent ?? 0}-${!!farShadow}-${count}-${!!look.instanceFade}`;
  return material;
}

/**
 * A chunk's place in the frame, by its distance d from the eye: nearest chunk first, between the ground (.5) and the distant
 * ground (2). Every chunk sat at the same render order with the same material and the same origin, so three.js drew them in the
 * order they were made, and a far chunk's trees were lit and then covered by a nearer chunk's. (A depth pass before the colour was
 * tried as well, 2026-11-14: 0.5 to 0.8 ms slower at every pose. Finding a card's cover, six parallax reads, is most of its cost.)
 */
export function orderImpostor(mesh: THREE.Mesh, d: number) {
  mesh.renderOrder = perfOn('impostorOrder') ? 1 + Math.min(d, 9000) * 1e-4 : 1;
}

/** Its cast into the island-wide shadow: the impostor turned to the sun, cut by the same cover as on screen. */
export function impostorCasterMaterial(atlas: ImpostorAtlas, sun: { value: THREE.Vector3 }) {
  const { count } = atlas;
  return new THREE.ShaderMaterial({
    uniforms: { uAlbedo: { value: atlas.albedo.texture }, uFrames: { value: atlas.frames }, uSun: sun },
    vertexShader: `attribute vec3 iPos;attribute vec4 iShape;uniform vec4 uFrames[${count}];uniform vec3 uSun;varying vec2 vAtlasA,vAtlasB;varying float vBlend;
      void main(){
        vec2 toSun=normalize(uSun.xz+vec2(1e-4,0.));vec3 bbRight=vec3(toSun.y,0.,-toSun.x);vec4 frame=uFrames[int(iShape.w+.5)];
        float cy=cos(iShape.x),sy=sin(iShape.x);vec2 inModel=vec2(toSun.x*cy-toSun.y*sy,toSun.x*sy+toSun.y*cy);
        float view=mod(atan(inModel.x,inModel.y)/6.2831853*${IMPOSTOR_VIEWS}.+${IMPOSTOR_VIEWS}.,${IMPOSTOR_VIEWS}.),k0=floor(view);vBlend=view-k0;vec2 cell=position.xy+.5;
        vAtlasA=(vec2(k0,iShape.w)+cell)/vec2(${IMPOSTOR_VIEWS}.,${count}.);vAtlasB=(vec2(mod(k0+1.,${IMPOSTOR_VIEWS}.),iShape.w)+cell)/vec2(${IMPOSTOR_VIEWS}.,${count}.);
        vec3 p=iPos+bbRight*(position.x*frame.x*iShape.z)+vec3(0.,(frame.z+position.y*frame.y)*iShape.y,0.);
        gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);
      }`,
    fragmentShader: `uniform sampler2D uAlbedo;varying vec2 vAtlasA,vAtlasB;varying float vBlend;
      void main(){if(mix(texture2D(uAlbedo,vAtlasA).a,texture2D(uAlbedo,vAtlasB).a,vBlend)<.3)discard;gl_FragColor=vec4(1.);}`,
    side: THREE.DoubleSide,
  });
}

/** One impostor: where it stands, its turn, its height and width scales (model units to metres), its model and a tint. */
export type ImpostorInstance = { x: number; y: number; z: number; yaw: number; height: number; width: number; model: number; tint?: number | readonly [number, number, number]; fade?: readonly [number, number, number, number] };

/**
 * Instances in by chunks (`chunk` metres) culled with the view, on the distant land's layers (2 the main view, 3 the water's far
 * reflection), drawn before the ground so its pixels behind them are spared. `horizons` (eight bytes each, terrain-horizon.ts) or
 * none (lit as on open ground). With `caster`, each chunk also casts into the island-wide shadow.
 */
export function buildImpostors(scene: THREE.Scene, items: ImpostorInstance[], horizons: Uint8Array | undefined, material: THREE.Material, name: string,
  { chunk = 128, tall = 36, caster, farShadow }: { chunk?: number; tall?: number; caster?: THREE.Material; farShadow?: FarShadow } = {}) {
  const groups = new Map<string, number[]>(), meshes: THREE.Mesh[] = [], casters: THREE.Mesh[] = [];
  items.forEach((q, i) => { const k = `${Math.floor(q.x / chunk)},${Math.floor(q.z / chunk)}`; let g = groups.get(k); if (!g) groups.set(k, g = []); g.push(i); });
  const quad = new THREE.PlaneGeometry(1, 1);
  for (const list of groups.values()) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index; geometry.setAttribute('position', quad.getAttribute('position')); geometry.setAttribute('uv', quad.getAttribute('uv')); geometry.setAttribute('normal', quad.getAttribute('normal'));
    const pos = new Float32Array(list.length * 3), shape = new Float32Array(list.length * 4), tint = new Float32Array(list.length * 3), fade = new Float32Array(list.length * 4), a = new Uint8Array(list.length * 4), b = new Uint8Array(list.length * 4);
    const box = new THREE.Box3(), v = new THREE.Vector3();
    list.forEach((n, i) => {
      const q = items[n], t = q.tint ?? 1;
      pos.set([q.x, q.y, q.z], i * 3); shape.set([q.yaw, q.height, q.width, q.model], i * 4); tint.set(typeof t === 'number' ? [t, t, t] : t, i * 3); fade.set(q.fade ?? [0, 0, 1e5, 1e5], i * 4);
      if (horizons) for (let k = 0; k < 4; k++) { a[i * 4 + k] = horizons[n * 8 + k]; b[i * 4 + k] = horizons[n * 8 + 4 + k]; }
      box.expandByPoint(v.set(q.x, q.y, q.z)).expandByPoint(v.set(q.x, q.y + tall * q.height, q.z));
    });
    geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3)); geometry.setAttribute('iShape', new THREE.InstancedBufferAttribute(shape, 4));
    geometry.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 3)); geometry.setAttribute('iFade', new THREE.InstancedBufferAttribute(fade, 4));
    geometry.setAttribute('horizonA', new THREE.InstancedBufferAttribute(a, 4, true)); geometry.setAttribute('horizonB', new THREE.InstancedBufferAttribute(b, 4, true));
    geometry.instanceCount = list.length;
    geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere()); geometry.boundingSphere.radius += Math.max(4, tall * .6);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name; mesh.matrixAutoUpdate = false;
    mesh.layers.set(2); mesh.layers.enable(3); mesh.renderOrder = 1;
    scene.add(mesh); meshes.push(mesh);
    if (caster && farShadow) { const c = new THREE.Mesh(geometry, caster); c.name = `${name} (shadow caster)`; c.matrixAutoUpdate = false; c.frustumCulled = false; farShadow.casters.add(c); casters.push(c); }
  }
  quad.dispose();
  if (caster && farShadow) farShadow.invalidate();
  return {
    meshes, casters,
    /**
     * Each chunk drawn only while some of it can show: not wholly inside `near` (where the streamed models stand in for every one
     * of its instances) nor wholly past `far` (where every one has dissolved), by horizontal distance from the eye, as the fades
     * themselves measure it. A chunk past its fade still ran four vertices an instance, and its draw call, every frame: the far
     * rocks, stumps, logs and branches drew some two hundred such chunks over the whole island.
     */
    cull(eye: THREE.Vector3, near: number, far = Infinity) {
      const culled = perfOn('impostorCull');
      for (const m of meshes) {
        const b = m.geometry.boundingSphere!, d = Math.hypot(b.center.x - eye.x, b.center.z - eye.z);
        m.visible = !culled || (d + b.radius > near && d - b.radius < far);
        orderImpostor(m, d);
      }
    },
    dispose() { for (const m of meshes) { scene.remove(m); m.geometry.dispose(); } for (const c of casters) c.removeFromParent(); },
  };
}
