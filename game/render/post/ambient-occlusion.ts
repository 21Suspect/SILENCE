import * as THREE from 'three';
import { perfOn } from '../../core/perf-flags';
import { AO_RADIUS, AO_THIN, AO_FADE_FAR, aoQuality } from './ambient-occlusion-math';

/**
 * Horizon-based ambient occlusion (GTAO, Jimenez et al. 2016) from the depth the opaque pass already writes, at half resolution.
 *
 * Output texture (RGBA half float, half size): r = visibility 0..1 (1 open), g = fraction of the pixel's light that is direct sun,
 * b = linear view depth in metres of the texel's own surface. The resolve shader in atmosphere.ts upsamples it joint-bilateral
 * on b and multiplies the HDR colour before fog, weighted by g (see ambient-occlusion-math.ts for why).
 *
 * Why this and not a lights-chunk override (aomap_fragment) with a depth prepass: the forest is alpha-tested foliage, a prepass would
 * draw every leaf card twice (their vertex shaders carry the fade and wind work), and the ambient light here is one hemisphere light,
 * so the after-the-fact multiply loses little. What it gets wrong: the torch and emissive lamps are darkened in creases too.
 *
 * Artifact control, because trunks against fog and sky are where AO goes wrong:
 *  - A sample further than the radius from the pixel contributes nothing (the horizon falls back to open), so a trunk never
 *    darkens the far surface behind it, and a pixel beside a trunk never darkens from a far background.
 *  - Normals come from the nearer of the two depth neighbours on each axis, so they do not bend across silhouettes.
 *  - Noise is interleaved gradient noise on the screen grid, turned a little every frame (golden-ratio steps), and the result is
 *    accumulated over frames (below). Fixed in screen space, its remainder after the blur stayed put on the screen while the world
 *    moved under it, and the half-resolution grid crawled along silhouettes: a static view looked right and a moving one showed
 *    dark edges sliding off what cast them.
 *  - Temporal accumulation: last frame's result is reprojected through the camera's motion (depth to world to the previous
 *    view), dropped where the depth disagrees (newly uncovered ground keeps no stale shade), and clamped to the current
 *    neighbourhood's range (so it cannot drag a ghost), then blended in at 85%. A depth-aware separable blur removes the rest.
 *  - The sky (depth 1) and anything past AO_FADE_FAR is left alone, so nothing can halo against the horizon.
 */
export function createAmbientOcclusion(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, shared: Record<string, { value: unknown }>) {
  const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } as const;
  const targetA = new THREE.WebGLRenderTarget(1, 1, opts), targetB = new THREE.WebGLRenderTarget(1, 1, opts);
  const size = new THREE.Vector2(1, 1);
  const uniforms = {
    tDepth: shared.tDepth, cameraWorld: shared.cameraWorld, sunDirection: shared.sunDirection, sunMatrix: shared.sunMatrix, sunShadow: shared.sunShadow,
    shadowTexel: shared.shadowTexel, sunLevel: shared.sunLevel,
    aoSize: { value: size }, projScale: { value: new THREE.Vector2(1, 1) }, nearFar: { value: new THREE.Vector2(.1, 1000) },
    slices: { value: 3 }, steps: { value: 8 }, hasShadow: { value: 0 }, frame: { value: 0 },
  };
  const vertexShader = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, depthTest: false, depthWrite: false, fragmentShader: `
    precision highp float;
    uniform sampler2D tDepth,sunShadow;uniform mat4 cameraWorld,sunMatrix;uniform vec3 sunDirection;
    uniform vec2 aoSize,projScale,nearFar;uniform float shadowTexel,sunLevel,hasShadow,slices,steps,frame;
    varying vec2 vUv;
    const float PI=3.14159265,HALF_PI=1.57079633,RADIUS=${AO_RADIUS.toFixed(2)},THIN=${AO_THIN.toFixed(2)},FADE_FAR=${AO_FADE_FAR.toFixed(1)};
    // Linear view distance along the view axis (positive), from the depth buffer's 0..1.
    float linearZ(float d){float n=nearFar.x,f=nearFar.y;return 2.*n*f/((f+n)-(2.*d-1.)*(f-n));}
    vec3 viewPos(vec2 uv,float d){float z=linearZ(d);return vec3((uv*2.-1.)*z/projScale,-z);}
    vec3 viewAt(vec2 uv){return viewPos(uv,texture2D(tDepth,uv).r);}
    void main(){
      float d0=texture2D(tDepth,vUv).r;
      float z0=linearZ(d0);
      if(d0>=1.||z0>FADE_FAR){gl_FragColor=vec4(1.,0.,z0,1.);return;}
      vec3 P=viewPos(vUv,d0),V=normalize(-P);
      // Normal from the nearer neighbour on each axis, so it never bends across a silhouette.
      vec2 px=1./aoSize;
      vec3 l=viewAt(vUv-vec2(px.x,0.)),r=viewAt(vUv+vec2(px.x,0.)),dn=viewAt(vUv-vec2(0.,px.y)),up=viewAt(vUv+vec2(0.,px.y));
      vec3 dx=abs(l.z-P.z)<abs(r.z-P.z)?P-l:r-P,dy=abs(dn.z-P.z)<abs(up.z-P.z)?P-dn:up-P;
      vec3 N=normalize(cross(dx,dy));if(dot(N,V)<0.)N=-N;
      // Screen radius of RADIUS metres in half-res pixels, capped so a trunk at arm's length does not stride over the whole screen.
      float radiusPx=min(RADIUS*projScale.y*.5*aoSize.y/z0,90.);
      float noiseDir=fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715)))+.618034*frame);
      float noiseStep=fract(noiseDir*7.+.5*fract(dot(floor(gl_FragCoord.xy),vec2(.3183,.7071)))+.754878*frame);
      float visibility=1.;
      if(radiusPx>1.5){
        visibility=0.;
        for(int i=0;i<4;i++){
          if(float(i)>=slices)break;
          float phi=(float(i)+noiseDir)/slices*PI;
          vec2 dir2=vec2(cos(phi),sin(phi));vec3 dir=vec3(dir2,0.);
          vec3 ortho=dir-dot(dir,V)*V,axis=cross(dir,V),projN=N-axis*dot(N,axis);
          float projLen=length(projN);
          if(projLen<1e-4){visibility+=1.;continue;}
          float cosN=clamp(dot(projN,V)/projLen,-1.,1.),signN=sign(dot(ortho,projN));
          float n=signN*acos(cosN),sinN=signN*sqrt(1.-cosN*cosN);
          // Horizons start at the tangent plane and only rise.
          float low0=cos(n+HALF_PI),low1=cos(n-HALF_PI),h0=low0,h1=low1;
          for(int s=0;s<8;s++){
            if(float(s)>=steps)break;
            float t=(float(s)+noiseStep)/steps;
            // Squared spacing: dense taps near the pixel, where creases are.
            vec2 off=dir2*max(t*t*radiusPx,1.5)*px;
            for(int side=0;side<2;side++){
              vec2 uv=vUv+(side==0?off:-off);
              if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.)continue;
              vec3 delta=viewAt(uv)-P;float dist=length(delta);
              // Full weight inside 0.6 R, none at R: anything further is a different object (the trunk against the far wood). The
              // distance along the view axis counts (1 + THIN) times (thin-occluder compensation, see AO_THIN).
              float falloffDist=length(vec3(delta.xy,delta.z*(1.+THIN)));
              float w=clamp((RADIUS-falloffDist)/(RADIUS*.4),0.,1.);
              float shc=dot(delta/max(dist,1e-4),V);
              if(side==0)h0=max(h0,mix(low0,shc,w));else h1=max(h1,mix(low1,shc,w));
            }
          }
          float a0=n+clamp(-acos(h1)-n,-HALF_PI,HALF_PI),a1=n+clamp(acos(h0)-n,-HALF_PI,HALF_PI);
          float arc0=(cosN+2.*a0*sinN-cos(2.*a0-n))*.25,arc1=(cosN+2.*a1*sinN-cos(2.*a1-n))*.25;
          visibility+=projLen*(arc0+arc1);
        }
        // A power above 2 pulls the mid greys down so creases read; open ground stays at 1.
        visibility=pow(clamp(visibility/slices,0.,1.),1.2);
      }
      // Direct sun on this pixel, from the sun's level, the shadow map and the surface's angle to the sun.
      float sunFrac=0.;
      if(sunLevel>.01){
        vec3 Pw=(cameraWorld*vec4(P,1.)).xyz,Nw=normalize(mat3(cameraWorld)*N);
        float cosine=clamp(dot(Nw,sunDirection),0.,1.),lit=1.;
        if(hasShadow>.5){
          vec4 pr=sunMatrix*vec4(Pw+Nw*.12,1.);vec3 uv=pr.xyz/pr.w;
          if(uv.z>0.&&uv.z<1.&&uv.x>0.&&uv.x<1.&&uv.y>0.&&uv.y<1.){
            float dd=dot(texture2D(sunShadow,uv.xy),vec4(255./256.,255./65536.,255./16777216.,1./16777216.));
            lit=smoothstep(uv.z-.0014,uv.z+.0004,dd);
            float border=min(min(uv.x,1.-uv.x),min(uv.y,1.-uv.y));lit=mix(1.,lit,smoothstep(0.,.055,border));
          }
        }
        sunFrac=clamp(sunLevel,0.,1.)*lit*cosine;
      }
      gl_FragColor=vec4(visibility,sunFrac,z0,1.);
    }` });
  const blurUniforms = { tSrc: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() }, axis: { value: new THREE.Vector2(1, 0) } };
  const blur = new THREE.ShaderMaterial({ uniforms: blurUniforms, vertexShader, depthTest: false, depthWrite: false, fragmentShader: `
    precision highp float;
    uniform sampler2D tSrc;uniform vec2 texel,axis;varying vec2 vUv;
    void main(){
      vec4 c=texture2D(tSrc,vUv);
      float dc=max(c.b,.1);
      vec2 sum=c.rg;float total=1.;
      for(int k=1;k<=3;k++){
        float g=exp(-float(k*k)*.25);
        for(int s=0;s<2;s++){
          vec4 v=texture2D(tSrc,vUv+axis*texel*float(k)*(s==0?-1.:1.));
          float rel=(v.b-dc)/dc;
          // Tight in relative depth: 2.5% at 3 px already halves the weight, so slanted ground blurs and a trunk edge does not.
          float w=g*exp(-rel*rel*900.);
          sum+=v.rg*w;total+=w;
        }
      }
      gl_FragColor=vec4(sum/total,c.b,1.);
    }` });
  // ---- Temporal accumulation (see the module comment). History is r visibility, g sun fraction, b view depth of its surface.
  const history = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, opts));
  let current = 0, frame = 0, fresh = true;
  const prevView = new THREE.Matrix4(), prevViewProj = new THREE.Matrix4(), lastEye = new THREE.Vector3(Infinity, 0, 0), eye = new THREE.Vector3();
  const temporalUniforms = {
    tCurrent: { value: null as THREE.Texture | null }, tHistory: { value: null as THREE.Texture | null }, texel: blurUniforms.texel,
    cameraWorld: shared.cameraWorld, projScale: uniforms.projScale, prevView: { value: prevView }, prevViewProj: { value: prevViewProj }, fresh: { value: 1 },
  };
  const temporal = new THREE.ShaderMaterial({ uniforms: temporalUniforms, vertexShader, depthTest: false, depthWrite: false, fragmentShader: `
    precision highp float;
    uniform sampler2D tCurrent,tHistory;uniform vec2 texel,projScale;uniform mat4 cameraWorld,prevView,prevViewProj;uniform float fresh;varying vec2 vUv;
    void main(){
      vec4 c=texture2D(tCurrent,vUv);
      float z=c.b;
      if(fresh>.5||z>=${AO_FADE_FAR.toFixed(1)}){gl_FragColor=c;return;}
      // Where this surface was on the screen last frame, and how far it was from the eye.
      vec3 world=(cameraWorld*vec4((vUv*2.-1.)*z/projScale,-z,1.)).xyz;
      vec4 clip=prevViewProj*vec4(world,1.);vec2 prevUv=clip.xy/clip.w*.5+.5;float prevZ=-(prevView*vec4(world,1.)).z;
      if(clip.w<=0.||prevUv.x<0.||prevUv.x>1.||prevUv.y<0.||prevUv.y>1.){gl_FragColor=c;return;}
      vec4 h=texture2D(tHistory,prevUv);
      // A different surface was there (it has just come into view, or the history is of the trunk in front): start afresh.
      if(abs(h.b-prevZ)>.04*prevZ+.03){gl_FragColor=c;return;}
      // Clamped to what this neighbourhood shows now, so history can only smooth noise, never hold shade that has moved away.
      float lo=c.r,hi=c.r;
      for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){float v=texture2D(tCurrent,vUv+vec2(float(i),float(j))*texel).r;lo=min(lo,v);hi=max(hi,v);}
      float past=clamp(h.r,lo-.02,hi+.02);
      gl_FragColor=vec4(mix(past,c.r,.15),c.g,z,1.);
    }` });
  const quadScene = new THREE.Scene(), quadCamera = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material); quad.frustumCulled = false; quadScene.add(quad);
  return {
    get texture() { return history[current].texture as THREE.Texture; }, size,
    resize(width: number, height: number, level: number) {
      const q = aoQuality(level), w = Math.max(1, Math.ceil(width * q.scale)), h = Math.max(1, Math.ceil(height * q.scale));
      targetA.setSize(w, h); targetB.setSize(w, h); for (const t of history) t.setSize(w, h); size.set(w, h); blurUniforms.texel.value.set(1 / w, 1 / h);
      uniforms.slices.value = q.slices; uniforms.steps.value = q.steps; fresh = true;
    },
    render() {
      uniforms.projScale.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
      uniforms.nearFar.value.set(camera.near, camera.far);
      uniforms.hasShadow.value = shared.sunShadow.value ? 1 : 0;
      uniforms.frame.value = frame++ % 4096;
      const previous = renderer.getRenderTarget();
      quad.material = material; renderer.setRenderTarget(targetA); renderer.render(quadScene, quadCamera);
      quad.material = blur;
      blurUniforms.tSrc.value = targetA.texture; blurUniforms.axis.value.set(1, 0); renderer.setRenderTarget(targetB); renderer.render(quadScene, quadCamera);
      blurUniforms.tSrc.value = targetB.texture; blurUniforms.axis.value.set(0, 1); renderer.setRenderTarget(targetA); renderer.render(quadScene, quadCamera);
      // A teleport or a cut: nothing on screen was where the history says.
      camera.getWorldPosition(eye);
      if (eye.distanceTo(lastEye) > 3) fresh = true; lastEye.copy(eye);
      const next = 1 - current;
      temporalUniforms.tCurrent.value = targetA.texture; temporalUniforms.tHistory.value = history[current].texture;
      temporalUniforms.fresh.value = fresh || !perfOn('aoTemporal') ? 1 : 0;
      quad.material = temporal; renderer.setRenderTarget(history[next]); renderer.render(quadScene, quadCamera);
      current = next; fresh = false;
      shared.tAO.value = history[current].texture;
      prevView.copy(camera.matrixWorldInverse); prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      renderer.setRenderTarget(previous);
    },
    dispose() { targetA.dispose(); targetB.dispose(); for (const t of history) t.dispose(); material.dispose(); blur.dispose(); temporal.dispose(); quad.geometry.dispose(); },
  };
}
