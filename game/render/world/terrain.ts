import terrainWorkerUrl from './terrain-worker.ts?worker&url';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRiver } from './river';
import { createGroundLayers } from './ground-layers';
import { textureVariationGLSL } from './texture-variation';
import { perfOn } from '../../core/perf-flags';
import { createRockGeometry, createRockMaterial, createWeatheredWoodMaterial } from './surfaces';
import { roadSurface } from './road-surface';
import { roadMarkerSpot } from '../../sim/world/road-geometry';
import { coastalGLSL } from '../../sim/world/coastal-geography';
import { coastalMaterialGLSL } from './coastal-material';

import { WORLD_EXTENT, WORLD_RADIUS, TERRAIN_CHUNK, TERRAIN_STEP, hash, noise, pathX, riverX, roadZ, riverPresence, biomeAt, cacheTerrainBlock, releaseTerrainBlock, heightAt, vegetationExclusion, worldGeographyGLSL, waterHeightAt } from '../../sim/world/world';
import type { SolidCollider } from '../../sim/world/collision';
import { createMeshSurface } from './surface-support';
import { naturalLayout, groundedOrigin, type LayoutScatter } from '../../sim/world/placement';
import { WORLD_V2, WORLD_SEED } from '../../sim/world/world-flags';
import { groundGeometry, buildTerrainTile, unpackTerrainTile, type TerrainTile, type PreparedTerrainTile } from './terrain-geometry';
export { hash, noise, pathX, riverX, roadZ, roadDistance, heightAt } from '../../sim/world/world';

export const exclusion=vegetationExclusion;
const DETAIL_RADIUS=112, TRANSITION_WIDTH=18, PREFETCH_RADIUS=144, RETAIN_RADIUS=160;
const horizonColor=0x99998f;
const horizonTextureGLSL=`
  vec3 horizonTexture(sampler2D tex,vec3 p,vec3 n){
    vec3 w=pow(abs(normalize(n)),vec3(4.));w/=max(dot(w,vec3(1.)),.0001);
    // Rotated, offset scan patches preserve physical scale without kilometre-long tile grids.
    TexturePatch px=groundTexturePatch(p.zy/3.+vec2(21.,48.));
    TexturePatch py=groundTexturePatch(p.xz/3.+vec2(21.,48.));
    TexturePatch pz=groundTexturePatch(p.xy/3.+vec2(21.,48.));
    vec3 stone=samplePatch(tex,px).rgb*w.x+samplePatch(tex,py).rgb*w.y+samplePatch(tex,pz).rgb*w.z;
    float strata=surfaceNoise(p.xz*.025+vec2(p.y*.017,43.))*.65+surfaceNoise(p.xz*.11+vec2(p.y*.04,9.))*.35;
    return stone*mix(vec3(.73,.77,.79),vec3(1.12,1.06,.97),strata);
  }
`;

function tileDistanceSquared(x:number,z:number,px:number,pz:number) {
  const minX=x*TERRAIN_CHUNK,minZ=z*TERRAIN_CHUNK;
  const dx=Math.max(0,minX-px,px-minX-TERRAIN_CHUNK);
  const dz=Math.max(0,minZ-pz,pz-minZ-TERRAIN_CHUNK);
  return dx*dx+dz*dz;
}

export function createTerrain(scene: THREE.Scene, spawn: THREE.Vector3, renderer?: THREE.WebGLRenderer) {
  const loader = new THREE.TextureLoader();
  const textures:THREE.Texture[]=[];
  const solidColliders:SolidCollider[]=[];
  const distantProps:{object:THREE.Object3D;x:number;z:number;radius:number}[]=[];
  const texture = (name: string, srgb = false) => {
    const t = loader.load(name.startsWith('/')?name:`/textures/${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(200, 200); t.anisotropy = scene.userData.maxAnisotropy??8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    return t;
  };
  const layout=naturalLayout({heightAt,exclusion,biomeAt,riverX,riverPresence,roadZ,radius:WORLD_RADIUS});
  const nearCenter=new THREE.Vector2(),nearCoverage={value:DETAIL_RADIUS};
  // Parallax occlusion on the near ground (1 on, 0 off): a uniform, so it can be switched and measured without a recompile.
  const parallax={value:1};
  const zenith=new THREE.Vector3(0,1,0),sunDirection={get value(){return (scene.userData.sunDirection as THREE.Vector3|undefined)??zenith;}};
  const distantTint=new THREE.Color(horizonColor);
  // The forest floor: seven scanned layers in two texture arrays (colour + height, normal + roughness); see ground-layers.ts.
  const groundLayers=createGroundLayers(renderer);textures.push(groundLayers.color,groundLayers.surface);
  // Shared with the forest's scanned rocks, which take the lichen-rock layer as their close-up detail (forest.ts rockDetail).
  scene.userData.groundLayers=groundLayers;
  const material = new THREE.MeshStandardMaterial({ roughness: 1, color: 0xffffff });
  // Pack roughness in normal-map alpha to leave texture units for flashlight shadows/cookie on 16-unit mobile GPUs.
  const riverbedMap=texture('riverbed-diff',true),riverbedNormal=texture('/textures/riverbed-normal-rough.png');
  const roadMap=texture('road-diff',true),roadNormal=texture('/textures/road-normal-rough.png');
  const stoneMap=texture('/plantassets/forest-variety/granite-diff.jpg',true);
  const coastalMap=texture('/textures/coastal-diff.webp',true),coastalNormal=texture('/textures/coastal-normal-rough.png');
  // Read when the shader is built: a dev switch for measuring the ground's texture reads with and without the savings.
  let GROUND_TAPS=perfOn('groundTaps');
  material.onBeforeCompile = (shader) => {
    GROUND_TAPS=perfOn('groundTaps');
    // The rebuilt world's road is worked out in game/render/world/road-surface.ts; the original keeps its narrow dirt track.
    const road=WORLD_V2?roadSurface():undefined;
    shader.uniforms.uNearCenter={value:nearCenter};shader.uniforms.uNearCoverage=nearCoverage;shader.uniforms.uDistantTint={value:distantTint};
    shader.uniforms.uRoadMap={value:roadMap};shader.uniforms.uRoadNormal={value:roadNormal};
    shader.uniforms.uStoneMap={value:stoneMap};
    shader.uniforms.uGroundColor={value:groundLayers.color};shader.uniforms.uGroundSurface={value:groundLayers.surface};
    shader.uniforms.uParallax=parallax;shader.uniforms.uSunDirection=sunDirection;
    shader.uniforms.uCoastalMap={value:coastalMap};shader.uniforms.uCoastalNormal={value:coastalNormal};
    shader.uniforms.uBedMap={value:riverbedMap};shader.uniforms.uBedNormal={value:riverbedNormal};
    shader.vertexShader = `uniform vec2 uNearCenter;uniform float uNearCoverage;attribute float horizonY;attribute float treeGround;attribute vec4 biome;varying float vTreeGround;varying vec4 vBiome;varying vec3 vGroundPosition;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float edge=length(position.xz-uNearCenter);
      transformed.y=mix(transformed.y,horizonY,smoothstep(max(uNearCoverage*.65,uNearCoverage-${TRANSITION_WIDTH}.),uNearCoverage+.001,edge));
    `).replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;vBiome=biome;vTreeGround=treeGround;');
    shader.fragmentShader = `varying vec3 vGroundPosition;varying vec4 vBiome;varying float vTreeGround;
      uniform sampler2D uBedMap,uBedNormal,uRoadMap,uRoadNormal,uStoneMap;
      uniform sampler2DArray uGroundColor,uGroundSurface;
      uniform vec2 uNearCenter;uniform float uNearCoverage;uniform vec3 uDistantTint;uniform float uParallax;uniform vec3 uSunDirection;
      ${textureVariationGLSL}
      // Where each ground layer's patches sit (offset in xy) and how large its scan is (1/size in z), as the layer reads
      // below, and how deep its relief is in metres (w): the depth its height map spans.
      vec4 groundLayerFrame(int layer){
        // The scans' height maps use a narrow band of their range (standard deviation .06 to .17), so these depths put the
        // typical relief at 1.5 to 2.5 cm, with the tallest needle mats, roots and stones at 10 to 20 cm.
        if(layer==1)return vec4(57.,9.,1./3.,.14);
        if(layer==2)return vec4(13.,71.,1./1.67,.13);
        if(layer==3)return vec4(91.,37.,1./1.5,.1);
        if(layer==4)return vec4(29.,5.,1./2.17,.2);
        if(layer==5)return vec4(63.,44.,1./2.,.22);
        return vec4(0.,0.,1./2.5,.16);
      }
      ${worldGeographyGLSL}
      ${coastalMaterialGLSL}
      ${horizonTextureGLSL}
      ${road?road.functions:`float roadHalfWidth(float x){return 1.55+worldNoise(vec2(x*.047,118.))*.65+worldNoise(vec2(x*.17,72.))*.15;}
      float roadWeight(vec3 p){
        float width=roadHalfWidth(p.x);
        float erosion=(surfaceNoise(p.xz*.8)-.5)*.24+(surfaceNoise(p.xz*2.3)-.5)*.1;
        return (1.-smoothstep(width-.55,width+.48,abs(p.z-roadCenter(p.x))+erosion))*roadPresence(p.xz);
      }`}
      float bedWeight(vec3 p){
        float edge=1.-smoothstep(2.7,8.,streamOffset(p.xz));
        float damp=1.-smoothstep(.10,1.35,p.y-streamHeight(p.z));
        float gravel=edge*damp*streamPresence(p.z);
        ${WORLD_V2?'gravel=max(gravel,(1.-smoothstep(-1.,6.,lakeDistance(p.xz)))*(1.-smoothstep(.1,1.2,p.y-.6)));':''}
        return clamp(gravel,0.,1.);
      }
      ${shader.fragmentShader}`.replace('#include <map_fragment>', `
      vec2 p=vGroundPosition.xz;
      float detailDistance=length(p-uNearCenter);
      if(detailDistance>=uNearCoverage)discard;
      float distantBlend=smoothstep(max(uNearCoverage*.65,uNearCoverage-${TRANSITION_WIDTH}.),uNearCoverage,detailDistance);
      vec2 groundUv=p*vec2(1.,-1.);
      // Mild smooth distortion and stochastic patches have no world-space tile grid.
      groundUv+=vec2(surfaceNoise(p*.18),surfaceNoise(p*.18+27.))*.38;
      vec3 slopeNormal=abs(normalize(cross(dFdx(vGroundPosition),dFdy(vGroundPosition))));
      vec3 stoneWeights=pow(slopeNormal,vec3(4.));stoneWeights/=max(dot(stoneWeights,vec3(1.)),.0001);
      ${GROUND_TAPS?`// A rock face is drawn from three projections. One that carries under 3% of the blend is let go (the
      // others are scaled up to make up for it, and the hand-over is gradual), so flat ground pays for one, not three.
      stoneWeights=max(stoneWeights-.03,0.);stoneWeights/=max(dot(stoneWeights,vec3(1.)),.0001);`:''}
      TexturePatch stoneX=groundTexturePatch(vGroundPosition.zy/2.+vec2(21.,48.));
      TexturePatch stoneY=groundTexturePatch(vGroundPosition.xz/2.+vec2(21.,48.));
      TexturePatch stoneZ=groundTexturePatch(vGroundPosition.xy/2.+vec2(21.,48.));
      // vTreeGround is stored per terrain vertex, so on its own its edge follows the mesh's triangles: a straight-sided ring
      // round every trunk. Moving the threshold by noise at the pixel lets the root mat fray out into the floor instead.
      float rootBlend=smoothstep(.02,.9,vTreeGround+(surfaceNoise(p*1.7+5.)-.5)*.32+(surfaceNoise(p*6.1)-.5)*.14)*(.84+surfaceNoise(p*3.1+19.)*.16);
      float leafBlend=clamp(max(vBiome.y+vBiome.z*.55,rootBlend*.68),0.,1.);
      float stoneBlend=clamp(vBiome.w+vBiome.z*.24+(1.-slopeNormal.y)*vBiome.w*.3,0.,1.);
      TexturePatch roadPatch=groundTexturePatch(groundUv/2.+vec2(47.,13.));
      TexturePatch gravelPatch=groundTexturePatch(groundUv/2.2+vec2(9.,31.));
      ${road?road.mask:'float road=roadWeight(vGroundPosition),bank=bedWeight(vGroundPosition);'}
      float worn=(1.-smoothstep(trailWidth(p.y)*.42,trailWidth(p.y)+surfaceNoise(p*2.1)*.26,trailDistance(p)))*trailPresence(p);
      float dirtCoverage=worn*.82*(1.-road)*(1.-bank),trod=0.;
      ${WORLD_V2?`
      trod=smoothstep(.34,.72,vBiome.x+(surfaceNoise(p*1.7)-.5)*.42+(surfaceNoise(p*7.)-.5)*.16);
      dirtCoverage=max(dirtCoverage,trod*(1.-road)*(1.-bank)*.92);
      `:''}
      // ---- The forest floor in layers (game/render/world/ground-layers.ts): scanned CC0 sets in two texture arrays, each with
      // its height in the colour's alpha. Masks say where each layer belongs; heights decide the edge between them, so moss
      // fills hollows, stones stand out of the litter and a path frays into the needles instead of fading.
      float steep=1.-smoothstep(.6,.84,slopeNormal.y);
      float flatGround=smoothstep(.8,.96,slopeNormal.y);
      float damp=smoothstep(.5,.82,surfaceNoise(p*.043+40.)*.65+surfaceNoise(p*.19+3.)*.35);
      float open=1.-clamp(vBiome.y*1.3+rootBlend,0.,1.);
      float ground=(1.-road)*(1.-bank);
      float wRock=stoneBlend*steep*ground;
      // Gravel shows at a path's edge only as a trace: on this damp floor the margin is moss and needles, and a full band of
      // the pale scan read as a dry gravel verge.
      float wRocky=(stoneBlend*(1.-steep)*.9+worn*(1.-worn)*.45)*ground;
      float wPath=dirtCoverage;
      float wRoots=rootBlend*.7*ground*(1.-dirtCoverage);
      // The base floor is a damp conifer floor: moss mats with lanes of needles between them. Broadleaf groves drop leaves
      // over it, and wherever the ground is level and holds water, the moss closes into a carpet.
      float wLitter=clamp(leafBlend*(.62+.38*surfaceNoise(p*.08+12.)),0.,1.)*ground*(1.-dirtCoverage*.7);
      float level=smoothstep(.7,.93,slopeNormal.y);
      // Moss is never a whole carpet with an outline: a broken mask over several scales, held below full cover, so the height
      // blend lets it fill the hollows between the needle mats first and the floor shows through its edges.
      float mossField=damp*.55+surfaceNoise(p*.31+77.)*.2+surfaceNoise(p*1.3+11.)*.15+surfaceNoise(p*4.7)*.1;
      float wMoss=.72*smoothstep(.22,.78,mossField)*level*(1.-vBiome.w)*ground*(1.-dirtCoverage)*(1.-leafBlend*.45);
      float wFloor=max(.08,1.-max(max(max(wRock,wRocky),max(wPath,wRoots)),max(wLitter,wMoss)));
      // ---- Parallax occlusion on the near ground. The view ray is marched down into the leading layer's height (the colour's
      // alpha), and every layer is then read where the ray meets that relief: needle mats, roots and stones stand above the
      // soil and hide what lies behind them as the view moves. One texture read a step (the patch's strongest tap: its
      // weights are sharpened, so most of a patch is one tap), ten steps, faded out between 6 and 10 m, where the relief is
      // smaller than a pixel. The masks above stay where they were: only what each layer shows moves.
      float parallaxHeight=1.,reliefShade=1.;
      if(uParallax>0.){
        vec3 toEye=cameraPosition-vGroundPosition;float eyeDistance=length(toEye);
        float reach=uParallax*(1.-smoothstep(6.,10.,eyeDistance))*(1.-steep)*ground*(1.-distantBlend);
        if(reach>.01){
          int lead=0;float strongest=wFloor;
          if(wLitter>strongest){lead=1;strongest=wLitter;}
          if(wRoots>strongest){lead=2;strongest=wRoots;}
          if(wMoss>strongest){lead=3;strongest=wMoss;}
          if(wPath>strongest){lead=4;strongest=wPath;}
          if(wRocky>strongest){lead=5;strongest=wRocky;}
          vec4 frame=groundLayerFrame(lead);
          TexturePatch hp=groundTexturePatch(groundUv*frame.z+frame.xy);
          vec2 tapUv=hp.a,tapTurn=hp.ra;
          if(hp.w.y>hp.w.x&&hp.w.y>=hp.w.z){tapUv=hp.b;tapTurn=hp.rb;}else if(hp.w.z>hp.w.x&&hp.w.z>hp.w.y){tapUv=hp.c;tapTurn=hp.rc;}
          vec2 gx=patchRotate(hp.dx,tapTurn),gy=patchRotate(hp.dy,tapTurn);
          vec3 view=toEye/eyeDistance;
          // Shift of the read point (in this layer's texture units) per tenth of the relief's depth, as the ray descends.
          vec2 stepUv=-view.xz/max(view.y,.3)*frame.w*reach*vec2(1.,-1.)*frame.z*.1;
          vec2 shift=vec2(0.);float depth=0.,h=textureGrad(uGroundColor,vec3(tapUv,float(lead)),gx,gy).a,lastH=h,lastDepth=0.;
          for(int i=0;i<10;i++){
            if(1.-h<=depth)break;
            lastH=h;lastDepth=depth;shift+=stepUv;depth+=.1;
            h=textureGrad(uGroundColor,vec3(tapUv+patchRotate(shift,tapTurn),float(lead)),gx,gy).a;
          }
          // Between the last step above the relief and the first below it, where the two lines cross.
          float below=depth-(1.-h),above=(1.-lastH)-lastDepth,t=above/max(above+below,1e-4);
          vec2 hit=depth>0.?shift-stepUv*(1.-t):vec2(0.);
          groundUv+=hit/frame.z;
          float hitH=mix(lastH,h,t);
          parallaxHeight=mix(1.,hitH,reach);
          // Relief shadows: from where the view ray met the relief, toward the sun. A ridge between the point and the sun
          // that stands above the sunbeam shades it, softly by how far above; this is what makes relief read in a still.
          vec3 sun=normalize(uSunDirection);
          if(sun.y>.05){
            vec2 toward=normalize(sun.xz+1e-5)*vec2(1.,-1.);
            float rise=sun.y/max(length(sun.xz),.05);
            vec2 at=tapUv+patchRotate(hit,tapTurn);float blocked=0.;
            for(int i=1;i<=6;i++){
              float run=.012*float(i*i)/3.;   // 4 mm to 12 cm out, closer steps near the point
              float hs=textureGrad(uGroundColor,vec3(at+patchRotate(toward*run*frame.z,tapTurn),float(lead)),gx,gy).a;
              blocked=max(blocked,(hs-hitH)*frame.w-run*rise);
            }
            reliefShade=1.-reach*smoothstep(0.,.025,blocked)*.85;
          }
        }
      }
      TexturePatch floorP=groundTexturePatch(groundUv/2.5),litterP=groundTexturePatch(groundUv/3.+vec2(57.,9.)),rootsP=groundTexturePatch(groundUv/1.67+vec2(13.,71.));
      TexturePatch mossP=groundTexturePatch(groundUv/1.5+vec2(91.,37.)),pathP=groundTexturePatch(groundUv/2.17+vec2(29.,5.)),rockyP=groundTexturePatch(groundUv/2.+vec2(63.,44.));
      vec4 cFloor=samplePatchLayer(uGroundColor,floorP,0.);
      vec4 cLitter=cFloor,cRoots=cFloor,cMoss=cFloor,cPath=cFloor,cRocky=cFloor,cRock=cFloor;
      if(wLitter>.02||road>.001)cLitter=samplePatchLayer(uGroundColor,litterP,1.);
      // The roots scan is pale, dry dirt; on this floor the soil round a trunk is dark and damp.
      if(wRoots>.02){cRoots=samplePatchLayer(uGroundColor,rootsP,2.);cRoots.rgb*=vec3(.74,.72,.68);}
      if(wMoss>.02)cMoss=samplePatchLayer(uGroundColor,mossP,3.);
      if(wPath>.02||road>.001)cPath=samplePatchLayer(uGroundColor,pathP,4.);
      if(wRocky>.02){cRocky=samplePatchLayer(uGroundColor,rockyP,5.);cRocky.rgb*=vec3(.66,.66,.64);}
      if(wRock>.02){
        cRock=vec4(0.);
        if(stoneWeights.x>0.)cRock+=samplePatchLayer(uGroundColor,stoneX,6.)*stoneWeights.x;
        if(stoneWeights.y>0.)cRock+=samplePatchLayer(uGroundColor,stoneY,6.)*stoneWeights.y;
        if(stoneWeights.z>0.)cRock+=samplePatchLayer(uGroundColor,stoneZ,6.)*stoneWeights.z;
      }
      // Height blend: each layer stands at its own height plus how much it is wanted; within a short band of the highest, layers share.
      float hFloor=cFloor.a*.7+wFloor,hLitter=wLitter>.02?cLitter.a*.7+wLitter:-9.,hRoots=wRoots>.02?cRoots.a*.7+wRoots:-9.,hMoss=wMoss>.02?cMoss.a*.7+wMoss:-9.;
      float hPath=wPath>.02?cPath.a*.7+wPath:-9.,hRocky=wRocky>.02?cRocky.a*.7+wRocky:-9.,hRock=wRock>.02?cRock.a*.7+wRock:-9.;
      float top=max(max(max(hFloor,hLitter),max(hRoots,hMoss)),max(max(hPath,hRocky),hRock))-.16;
      float bFloor=max(hFloor-top,0.),bLitter=max(hLitter-top,0.),bRoots=max(hRoots-top,0.),bMoss=max(hMoss-top,0.),bPath=max(hPath-top,0.),bRocky=max(hRocky-top,0.),bRock=max(hRock-top,0.);
      float bSum=bFloor+bLitter+bRoots+bMoss+bPath+bRocky+bRock+1e-5;
      vec3 groundColor=(cFloor.rgb*bFloor+cLitter.rgb*bLitter+cRoots.rgb*bRoots+cMoss.rgb*bMoss+cPath.rgb*bPath+cRocky.rgb*bRocky+cRock.rgb*bRock)/bSum;
      float groundHeight=(cFloor.a*bFloor+cLitter.a*bLitter+cRoots.a*bRoots+cMoss.a*bMoss+cPath.a*bPath+cRocky.a*bRocky+cRock.a*bRock)/bSum;
      vec3 leafColor=cLitter.rgb,dirt=cPath.rgb;
      // The stony layer's scan is the palest of the set; on this island the stones are dark and damp.
      float stoneShare=bRock/bSum;
      // Broad variation over tens of metres: patches of sun-bleached and damp ground, never a visible repeat.
      float broad=surfaceNoise(p*.065+5.)*.65+surfaceNoise(p*.19)*.35;
      groundColor*=mix(vec3(.84,.87,.8),vec3(1.07,1.05,.98),broad);
      ${road?road.colour:`if(road>.001){
        float roadDistance=abs(p.y-roadCenter(p.x));
        float roadWidth=roadHalfWidth(p.x);
        float shoulder=smoothstep(roadWidth*.42,roadWidth+.2,roadDistance);
        float roadMoss=smoothstep(.36,.76,surfaceNoise(p*.23))*(.12+shoulder*.72);
        float tracks=exp(-pow((roadDistance-roadWidth*.48)/.23,2.));
        vec3 asphalt=samplePatch(uRoadMap,roadPatch).rgb*.78;
        asphalt*=.86+surfaceNoise(p*.09+71.)*.26;
        asphalt*=1.-tracks*.09;
        // Real litter and soil reclaim the shoulders; no flat green paint.
        vec3 reclaimed=mix(groundColor,leafColor*vec3(.68,.63,.53),.32);
        vec3 roadSurface=mix(asphalt,reclaimed,roadMoss);
        float sediment=shoulder*smoothstep(.36,.7,surfaceNoise(p*.61+vec2(8.,31.)))*.42;
        roadSurface=mix(roadSurface,leafColor*vec3(.66,.6,.49),sediment);
        groundColor=mix(groundColor,roadSurface,road*.94);
      }`}
      if(bank>.001){
        vec3 pebbles=samplePatch(uBedMap,gravelPatch).rgb;
        pebbles*=mix(vec3(.86,.88,.79),vec3(1.08,1.03,.97),surfaceNoise(p*.21+36.));
        float wetness=1.-smoothstep(.02,.55,vGroundPosition.y-streamHeight(vGroundPosition.z));
        groundColor=mix(groundColor,pebbles*mix(.78,.52,wetness),bank);
      }
      if(distantBlend>0.){
        vec3 baseNormal=inverseTransformDirection(normalize(vNormal),viewMatrix);
        groundColor=mix(groundColor,uDistantTint*horizonTexture(uStoneMap,vGroundPosition,baseNormal),distantBlend);
      }
      float sandCover=0.,snowCover=0.;
      TexturePatch coastDetail=groundTexturePatch(groundUv/.85+vec2(17.,63.));
      ${WORLD_V2?`
      float coast=coastDistance(p),lake=lakeDistance(p);
      float brokenEdge=(surfaceNoise(p*.22)-.5)*4.+(surfaceNoise(p*1.1)-.5)*1.3;
      sandCover=max(1.-smoothstep(beachWidth(p)*.65,beachWidth(p)+8.,coast+brokenEdge),
        (1.-smoothstep(2.,8.,lake+brokenEdge*.4))*.65);
      sandCover*=smoothstep(.55,.9,slopeNormal.y)*(1.-road);
      snowCover=snowCoverage(vGroundPosition,slopeNormal);
      float wet=1.-smoothstep(.05,.65,vGroundPosition.y+5.2);
      if(sandCover>.001){
        vec3 scan=coastPatch(uCoastalMap,coastDetail,0.).rgb;
        // Preserve photographed grain while giving quartz sand its pale albedo.
        float grain=clamp(dot(scan,vec3(.2126,.7152,.0722))*1.25+.38,.42,.9);
        vec3 sand=vec3(.88,.76,.56)*grain;
        sand*=mix(1.,.46,wet);
        groundColor=mix(groundColor,sand,sandCover);
      }
      if(snowCover>.001)groundColor=mix(groundColor,coastPatch(uCoastalMap,coastDetail,1.).rgb*vec3(.88,.94,1.),snowCover);
      `:''}
      diffuseColor.rgb=groundColor;
      `).replace('#include <roughnessmap_fragment>',`
      // The layers' normals and roughness, from the second array, for the layers the colour blend used.
      vec4 sFloor=samplePatchLayerSurface(uGroundSurface,floorP,0.);
      vec4 groundSurface=sFloor*bFloor;
      if(bLitter>0.)groundSurface+=samplePatchLayerSurface(uGroundSurface,litterP,1.)*bLitter;
      if(bRoots>0.)groundSurface+=samplePatchLayerSurface(uGroundSurface,rootsP,2.)*bRoots;
      if(bMoss>0.)groundSurface+=samplePatchLayerSurface(uGroundSurface,mossP,3.)*bMoss;
      if(bPath>0.)groundSurface+=samplePatchLayerSurface(uGroundSurface,pathP,4.)*bPath;
      if(bRocky>0.)groundSurface+=samplePatchLayerSurface(uGroundSurface,rockyP,5.)*bRocky;
      groundSurface/=max(bSum-bRock,1e-5);
      float roughnessFactor=clamp(groundSurface.w,.35,1.);
      ${road?road.roughness:'if(road>.001)roughnessFactor=mix(roughnessFactor,samplePatch(uRoadNormal,roadPatch).a*.82+.08,road);'}
      if(bank>.001)roughnessFactor=mix(roughnessFactor,samplePatch(uBedNormal,gravelPatch).a*.72+.12,bank);
      roughnessFactor=mix(roughnessFactor,.98,distantBlend);
      if(sandCover>.001)roughnessFactor=mix(roughnessFactor,coastPatch(uCoastalNormal,coastDetail,0.).a*.72+.15,sandCover);
      if(snowCover>.001)roughnessFactor=mix(roughnessFactor,.94,snowCover);
      `).replace('#include <normal_fragment_maps>',`
      vec3 detailNormal=normalize(vec3(groundSurface.xy,max(groundSurface.z,.05)));
      ${road?road.normal:'if(road>.001){vec3 n=samplePatchNormal(uRoadNormal,roadPatch);n.xy*=.5;detailNormal=mix(detailNormal,n,road);}'}
      if(bank>.001){vec3 n=samplePatchNormal(uBedNormal,gravelPatch);n.xy*=.65;detailNormal=mix(detailNormal,n,bank);}
      if(sandCover>.001)detailNormal=mix(detailNormal,normalize(mix(vec3(0.,0.,1.),coastNormal(coastDetail,0.),.62)),sandCover);
      if(snowCover>.001)detailNormal=mix(detailNormal,coastNormal(coastDetail,1.),snowCover*.7);
      vec3 worldGroundNormal=inverseTransformDirection(normal,viewMatrix);
      vec3 groundTangent=normalize(vec3(worldGroundNormal.y,-worldGroundNormal.x,0.));
      vec3 groundBitangent=normalize(cross(worldGroundNormal,groundTangent));
      vec3 surfaceNormal=normalize(groundTangent*detailNormal.x+groundBitangent*detailNormal.y+worldGroundNormal*detailNormal.z);
      if(stoneShare>.002){
        vec3 nx=vec3(0.,0.,1.),ny=vec3(0.,0.,1.),nz=vec3(0.,0.,1.);
        if(stoneWeights.x>0.)nx=samplePatchLayerSurface(uGroundSurface,stoneX,6.).xyz;
        if(stoneWeights.y>0.)ny=samplePatchLayerSurface(uGroundSurface,stoneY,6.).xyz;
        if(stoneWeights.z>0.)nz=samplePatchLayerSurface(uGroundSurface,stoneZ,6.).xyz;
        nx.xy*=.8;ny.xy*=.8;nz.xy*=.8;
        vec3 nX=vec3(worldGroundNormal.x*abs(nx.z),worldGroundNormal.y+nx.y,worldGroundNormal.z+nx.x);
        vec3 nY=vec3(worldGroundNormal.x+ny.x,worldGroundNormal.y*abs(ny.z),worldGroundNormal.z+ny.y);
        vec3 nZ=vec3(worldGroundNormal.x+nz.x,worldGroundNormal.y+nz.y,worldGroundNormal.z*abs(nz.z));
        vec3 stoneDetail=normalize(nX*stoneWeights.x+nY*stoneWeights.y+nZ*stoneWeights.z);
        surfaceNormal=normalize(mix(surfaceNormal,stoneDetail,stoneShare*(1.-sandCover)*(1.-snowCover)));
      }
      normal=normalize(mat3(viewMatrix)*mix(surfaceNormal,worldGroundNormal,distantBlend));
      `).replace('#include <lights_fragment_end>',`
      #include <lights_fragment_end>
      // The relief's own shadows (see the parallax above) take the direct light only: sky light still reaches the hollows.
      reflectedLight.directDiffuse*=reliefShade;reflectedLight.directSpecular*=reliefShade;
      `);
  };
  material.userData.parallax=parallax;
  material.customProgramCacheKey=()=> `silence-ground-layers-v3${WORLD_V2?`-w2-${WORLD_SEED}`:''}-${perfOn('groundTaps')?'taps':'all'}`;
  const terrainChunks=new Map<string,{tile:TerrainTile;mesh:THREE.Mesh}>();
  // The low-detail distant surface preserves the mountain silhouette and covers
  // teleports while near chunks stream. It is below the exact walkable surface.
  const horizonMaterial=new THREE.MeshStandardMaterial({map:stoneMap,color:horizonColor,roughness:.98});
  horizonMaterial.onBeforeCompile=shader=>{
    shader.uniforms.uNearCenter={value:nearCenter};
    shader.uniforms.uNearCoverage=nearCoverage;
    shader.uniforms.uCoastalMap={value:coastalMap};shader.uniforms.uCoastalNormal={value:coastalNormal};
    shader.vertexShader=`varying vec3 vHorizon;varying vec3 vRidgeNormal;\n${shader.vertexShader}`.replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvHorizon=(modelMatrix*vec4(transformed,1.)).xyz;vRidgeNormal=normalize(mat3(modelMatrix)*normal);');
    shader.fragmentShader=`uniform vec2 uNearCenter;uniform float uNearCoverage;varying vec3 vHorizon;varying vec3 vRidgeNormal;\n${textureVariationGLSL}\n${horizonTextureGLSL}\n${coastalGLSL}\n${coastalMaterialGLSL}\n${shader.fragmentShader}`.replace('#include <map_fragment>',`
      if(length(vHorizon.xz-uNearCenter)<uNearCoverage)discard;
      diffuseColor.rgb*=horizonTexture(map,vHorizon,vRidgeNormal);
      ${WORLD_V2?`
      TexturePatch detail=groundTexturePatch(vHorizon.xz/2.1);
      float snow=snowCoverage(vHorizon,normalize(vRidgeNormal));
      float sand=(1.-smoothstep(beachWidth(vHorizon.xz)*.65,beachWidth(vHorizon.xz)+8.,coastDistance(vHorizon.xz)))*smoothstep(.55,.9,vRidgeNormal.y);
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.88,.76,.56)*clamp(dot(coastPatch(uCoastalMap,detail,0.).rgb,vec3(.2126,.7152,.0722))*1.25+.38,.42,.9),sand);
      diffuseColor.rgb=mix(diffuseColor.rgb,coastPatch(uCoastalMap,detail,1.).rgb*vec3(.88,.94,1.),snow);
      `:''}
    `);
  };
  const horizon=new THREE.Mesh(groundGeometry(WORLD_EXTENT*2,384,0,0),horizonMaterial);
  // The mountain silhouette is retained in the main view (layer 2 is enabled
  // by the game camera), but does not need a duplicate draw in the water's
  // layer-0 reflection. Reflected terrain fades into the same fog/sky before
  // this coarse horizon contributes a visible landmark.
  horizon.name='Coastal headlands and alpine skyline';horizon.renderOrder=2;horizon.layers.set(2);scene.add(horizon);
  let worker:Worker|undefined;
  let requested:TerrainTile|undefined,prepared:PreparedTerrainTile|undefined;
  let pendingChunks=0,lastCoverageUpdate=performance.now();
  const tileKey=({x,z}:TerrainTile)=>`${x},${z}`;
  function addTile(tile:TerrainTile,geometry:THREE.BufferGeometry){
    // Its heights stay cached for as long as the tile is built (game/sim/world/world.ts): the forest and props round the player read them.
    cacheTerrainBlock(tile.x,tile.z);
    const mesh=new THREE.Mesh(geometry,material);
    mesh.receiveShadow=true;mesh.name='Streamed forest terrain';mesh.visible=false;
    // The ground is drawn after the forest (render order 1): grass, trunks and rocks cover much of it, and drawn first their
    // depth rejects the ground's pixels behind them before its parallax shader runs. Every forest material can discard (its
    // distance dissolve), so the GPU cannot hide them for free the other way round. Measured at 1920x1080: -1.2 ms at the
    // canopy station, -0.45 ms at spawn (interleaved A/B, work/perf/ov.js).
    if(perfOn('terrainLast'))mesh.renderOrder=1;
    scene.add(mesh);terrainChunks.set(tileKey(tile),{tile,mesh});
  }
  function stopWorker(){
    worker?.terminate();worker=undefined;requested=undefined;prepared=undefined;
  }
  function updateChunks(player:THREE.Vector3,initial=false) {
    nearCenter.set(player.x,player.z);
    if(prepared){
      const {tile}=prepared;
      if(tileDistanceSquared(tile.x,tile.z,player.x,player.z)<RETAIN_RADIUS**2){
        cacheTerrainBlock(tile.x,tile.z,prepared.heights);
        layout.cacheCell(tile.x,tile.z,prepared.layout);
        addTile(tile,unpackTerrainTile(prepared));
      }
      prepared=undefined;requested=undefined;
    }
    let coverage2=DETAIL_RADIUS**2,next:TerrainTile|undefined,nextDistance2=Infinity;
    pendingChunks=0;
    const minX=Math.floor((player.x-PREFETCH_RADIUS)/TERRAIN_CHUNK),maxX=Math.floor((player.x+PREFETCH_RADIUS)/TERRAIN_CHUNK);
    const minZ=Math.floor((player.z-PREFETCH_RADIUS)/TERRAIN_CHUNK),maxZ=Math.floor((player.z+PREFETCH_RADIUS)/TERRAIN_CHUNK);
    for(let z=minZ;z<=maxZ;z++)for(let x=minX;x<=maxX;x++){
      const distance2=tileDistanceSquared(x,z,player.x,player.z);
      if(distance2>=PREFETCH_RADIUS**2||terrainChunks.has(`${x},${z}`))continue;
      const inWorld=x>=-WORLD_EXTENT/TERRAIN_CHUNK&&x<WORLD_EXTENT/TERRAIN_CHUNK&&z>=-WORLD_EXTENT/TERRAIN_CHUNK&&z<WORLD_EXTENT/TERRAIN_CHUNK;
      if(initial&&inWorld&&distance2<DETAIL_RADIUS**2){
        const tile={x,z};addTile(tile,buildTerrainTile(tile,layout));continue;
      }
      // A single missing tile limits where the coarse surface can be clipped.
      coverage2=Math.min(coverage2,distance2);
      if(!inWorld)continue;
      pendingChunks++;
      if(distance2<nextDistance2){nextDistance2=distance2;next={x,z};}
    }
    if(!initial&&!requested&&next){
      if(worker){
        requested=next;worker.postMessage(next);
      }else{
        // The same geometry is available in browsers that block workers.
        addTile(next,buildTerrainTile(next,layout));
      }
    }
    const now=performance.now(),coverage=Math.sqrt(coverage2);
    // Normal movement stays inside the prefetched window. After a jump to an
    // uncached area, reveal the complete detail outward over the coarse ground.
    nearCoverage.value=initial?coverage:Math.min(coverage,nearCoverage.value+Math.min(now-lastCoverageUpdate,50)*.16);
    lastCoverageUpdate=now;
    for(const [key,{tile,mesh}] of terrainChunks){
      const distance2=tileDistanceSquared(tile.x,tile.z,player.x,player.z);
      mesh.visible=distance2<nearCoverage.value**2;
      if(distance2>RETAIN_RADIUS**2){scene.remove(mesh);mesh.geometry.dispose();terrainChunks.delete(key);releaseTerrainBlock(tile.x,tile.z);}
    }
  }
  updateChunks(spawn,true);
  try{
    const url=new URL(terrainWorkerUrl,import.meta.url);
    url.search=typeof location!=='undefined'?location.search:'?classic-world';
    worker=new Worker(url,{type:'module'});
    worker.onmessage=(event:MessageEvent<PreparedTerrainTile>)=>{prepared=event.data;};
    worker.onerror=stopWorker;
    worker.onmessageerror=stopWorker;
  }catch{
    // Keep streaming from the deterministic builder if the browser blocks it.
  }
  const river=createRiver(scene,riverX,heightAt);
  const boulderGeo=createRockGeometry(49),boulderMat=createRockMaterial(true);
  const riverStones=new THREE.InstancedMesh(boulderGeo,boulderMat,420);
  riverStones.name='Stream gravel and waterworn stones';
  const stoneDummy=new THREE.Object3D();
  const riverRockMatrices=new WeakMap<LayoutScatter,{matrix:THREE.Matrix4;collider:SolidCollider}>();
  let collisionVersion=0;
  const activeColliders:SolidCollider[]=[];
  const lastRockPosition=new THREE.Vector3(999,0,999);
  function riverStone(item:LayoutScatter){
    const cached=riverRockMatrices.get(item);if(cached)return cached;
    const {x,z,size,yaw,variant}=item;
    stoneDummy.rotation.set((variant-.5)*.6,yaw,(hash(x,z)-.5)*.5);stoneDummy.scale.set(size*(.7+hash(x+9,z)*.6),size*.65,size);
    const p=boulderGeo.attributes.position,v=new THREE.Vector3(),samples:{x:number;y:number;z:number}[]=[];let minY=Infinity,maxY=-Infinity,radius=0;
    for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).multiply(stoneDummy.scale).applyQuaternion(stoneDummy.quaternion);minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);radius=Math.max(radius,Math.hypot(v.x,v.z));if(p.getY(i)<-.3)samples.push({x:v.x,y:v.y,z:v.z});}
    const y=groundedOrigin(samples,x,z,heightAt,.016);stoneDummy.position.set(x,y,z);stoneDummy.updateMatrix();
    const result={matrix:stoneDummy.matrix.clone(),collider:{kind:'capsule' as const,ax:x,az:z,bx:x,bz:z,radius,minY:y+minY,maxY:y+maxY,tag:'river stone',surfaceHeight:createMeshSurface(boulderGeo,stoneDummy.matrix)}};riverRockMatrices.set(item,result);return result;
  }
  riverStones.receiveShadow=true;riverStones.castShadow=true;scene.add(riverStones);
  // Old chipped stone verge markers. Their painted cap is worn into the
  // aggregate, rather than a second perfectly rectangular black mesh.
  const markerMat=createRockMaterial();
  markerMat.color.set(0xb9b5a4);
  const markerGeometries:THREE.BufferGeometry[]=[];
  for(let i=0;i<13;i++){
    const {x,z}=roadMarkerSpot(i);if(Math.abs(x-riverX(z))<9)continue;
    const geo=new THREE.CylinderGeometry(.105,.14,.69,18,12,false);
    const p=geo.attributes.position;
    const colors=new Float32Array(p.count*3);
    for(let k=0;k<p.count;k++){
      const px=p.getX(k),py=p.getY(k),pz=p.getZ(k);
      const wear=noise(px*31+2,py*37+pz*9);
      p.setXYZ(k,px*(.93+wear*.15),py+(py>.30?(wear-.5)*.065:0),pz*(.94+wear*.1));
      const band=py>.13&&py<.24;
      const shade=band&&wear>.29 ? .20+wear*.16 : .62+wear*.32;
      colors[k*3]=shade;colors[k*3+1]=shade*.99;colors[k*3+2]=shade*.91;
    }
    geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.computeVertexNormals();
    const post=new THREE.Mesh(geo,markerMat);markerMat.vertexColors=true;
    post.position.set(x,heightAt(x,z)+.24,z);post.rotation.z=(hash(i,7)-.5)*.5;post.rotation.y=hash(i,6)*6.3;
    post.castShadow=true;post.receiveShadow=true;scene.add(post);markerGeometries.push(geo);
    distantProps.push({object:post,x,z,radius:.5});
    solidColliders.push({kind:'capsule',ax:x,az:z,bx:x,bz:z,radius:.16,minY:post.position.y-.36,maxY:post.position.y+.39,tag:'road marker'});
  }
  // A rotting footbridge beside the stream: something has dragged one plank away.
  // Both landings reach beyond the widest bank blend (8.5m), so the first
  // visible board is a small step from dry ground, not a ledge over the slope.
  const bridgeZ=-35, bridgeX=riverX(bridgeZ),bridgeHalf=12;
  const plankCount=76,plankSpacing=bridgeHalf*2/plankCount,plankWidth=plankSpacing-.015,plankDepth=.095,missingPlank=46;
  const bridgeGroup=new THREE.Group();bridgeGroup.name='Footbridge';scene.add(bridgeGroup);
  distantProps.push({object:bridgeGroup,x:bridgeX,z:bridgeZ,radius:bridgeHalf});
  const wood=createWeatheredWoodMaterial();
  const leftDeck=heightAt(bridgeX-bridgeHalf,bridgeZ)+.075,rightDeck=heightAt(bridgeX+bridgeHalf,bridgeZ)+.075;
  const crown=Math.max(waterHeightAt(bridgeZ)+4.3,(leftDeck+rightDeck)*.5+.4);
  const bridgeY=(x:number)=>{
    const t=THREE.MathUtils.clamp((x-bridgeX+bridgeHalf)/(bridgeHalf*2),0,1);
    return THREE.MathUtils.lerp(leftDeck,rightDeck,t)+Math.sin(t*Math.PI)*(crown-(leftDeck+rightDeck)*.5);
  };
  const plankX=(i:number)=>bridgeX-bridgeHalf+(i+.5)*plankSpacing;
  const plankY=(i:number)=>bridgeY(plankX(i))+Math.sin(i*.67)*.008;
  const bridgeGeometries:THREE.BufferGeometry[]=[];
  function timber(a:THREE.Vector3,b:THREE.Vector3,width:number,depth:number,tag='bridge timber'){
    const g=new RoundedBoxGeometry(width,a.distanceTo(b),depth,2,Math.min(width,depth)*.10);
    const uv=g.attributes.uv,p=g.attributes.position,n=g.attributes.normal;
    const grainU=hash(a.x*7.1,a.z)*13.7,grainV=hash(b.x,b.z*3.3)*19.3;
    for(let i=0;i<p.count;i++){
      if(Math.abs(n.getY(i))>.7)uv.setXY(i,p.getX(i)*2,p.getZ(i)*2);
      else if(Math.abs(n.getX(i))>Math.abs(n.getZ(i)))uv.setXY(i,p.getZ(i)*2,p.getY(i)*2);
      else uv.setXY(i,p.getX(i)*2,p.getY(i)*2);
      uv.setXY(i,uv.getX(i)+grainU,uv.getY(i)+grainV);
    }
    const mesh=new THREE.Mesh(g,wood);mesh.position.copy(a).add(b).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),b.clone().sub(a).normalize());mesh.castShadow=true;mesh.receiveShadow=true;bridgeGroup.add(mesh);bridgeGeometries.push(g);
    mesh.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(mesh);
    solidColliders.push({kind:'capsule',ax:a.x,az:a.z,bx:b.x,bz:b.z,radius:Math.max(width,depth)*.5,minY:bounds.min.y,maxY:bounds.max.y,tag,surfaceHeight:createMeshSurface(g,mesh.matrixWorld)});
  }
  for(let i=0;i<plankCount;i++) {
    if(i===missingPlank)continue;
    const x=plankX(i),y=plankY(i);
    timber(new THREE.Vector3(x,y,bridgeZ-.80),new THREE.Vector3(x+(hash(i,7)-.5)*.025,y+.005,bridgeZ+.80),plankWidth,plankDepth,'bridge deck');
  }
  for(const dz of [-.59,.59]){
    // Segmented stringers follow the raised deck rather than cutting straight
    // through the passage below it. Posts sit outside the stream's clear span.
    for(let i=0;i<12;i++){
      const ax=bridgeX-bridgeHalf+i*2,bx=ax+2;
      timber(new THREE.Vector3(ax,bridgeY(ax)-.14,bridgeZ+dz),new THREE.Vector3(bx,bridgeY(bx)-.14,bridgeZ+dz),.16,.18);
    }
    for(const dx of [-5.1,5.1]){
      const x=bridgeX+dx,z=bridgeZ+dz;
      const foot=heightAt(x,z)-.18;
      timber(new THREE.Vector3(x,foot,z),new THREE.Vector3(x+.025,bridgeY(x)-.08,z),.23,.23,'bridge support');
      const braceX=x+Math.sign(dx)*1.45;
      timber(new THREE.Vector3(x,foot+.5,z),new THREE.Vector3(braceX,bridgeY(braceX)-.19,z),.16,.16,'bridge support');
    }
  }
  // Every weathered board retains its own UVs and exact collision surface, but
  // static timber shares one draw call (also in the shadow/reflection passes).
  const transformedTimbers=bridgeGroup.children.map(object=>{
    const mesh=object as THREE.Mesh;return mesh.geometry.clone().applyMatrix4(mesh.matrix);
  });
  const combinedTimbers=mergeGeometries(transformedTimbers,false)!;
  for(const geometry of transformedTimbers)geometry.dispose();
  bridgeGeometries.push(combinedTimbers);bridgeGroup.clear();
  const combinedBridge=new THREE.Mesh(combinedTimbers,wood);combinedBridge.castShadow=true;combinedBridge.receiveShadow=true;bridgeGroup.add(combinedBridge);
  return {
    water:river,
    get solidColliders(){return activeColliders;},
    get collisionVersion(){return collisionVersion;},
    get streamingStats(){return {nearChunks:terrainChunks.size,pendingChunks,detailRadius:nearCoverage.value,worker:!!worker,heightVertexSpacing:TERRAIN_STEP};},
    update(time:number,player:THREE.Vector3,darkness:number) {
      river.update(time,player,darkness);
      const changed=lastRockPosition.distanceToSquared(player)>9;
      if(changed){
        activeColliders.length=0;activeColliders.push(...solidColliders);
        let count=0;const cx=Math.floor(player.x/32),cz=Math.floor(player.z/32);
        if(Math.abs(player.x-riverX(player.z))<70)for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(const item of layout.cell(cx+dx,cz+dz).river){
          if((item.x-player.x)**2+(item.z-player.z)**2<43**2&&count<420){const stone=riverStone(item);riverStones.setMatrixAt(count++,stone.matrix);activeColliders.push(stone.collider);}
        }
        collisionVersion++;
        riverStones.count=count;riverStones.instanceMatrix.needsUpdate=true;riverStones.computeBoundingSphere();lastRockPosition.copy(player);
      }
      let propsChanged=false;
      for(const prop of distantProps){
        // Fog fully conceals this range; hysteresis avoids toggling shadows when
        // the player walks along the culling boundary. The bridge stays whole.
        const range=(prop.object.visible?118:108)+prop.radius;
        const visible=(prop.x-player.x)**2+(prop.z-player.z)**2<range*range;
        if(prop.object.visible!==visible){prop.object.visible=visible;propsChanged=true;}
      }
      updateChunks(player);
      return changed||propsChanged;
    },
    bridgeHeight(x:number,z:number) {
      if(Math.abs(z-bridgeZ)>.8||Math.abs(x-bridgeX)>bridgeHalf+.18)return -Infinity;
      const nearest=Math.floor((x-bridgeX+bridgeHalf)/plankSpacing);
      let support=-Infinity;
      for(let i=Math.max(0,nearest-1);i<=Math.min(plankCount-1,nearest+1);i++){
        if(i===missingPlank)continue;
        // The player's foot can straddle the missing board by touching an
        // adjacent real board; the gap itself has no floor or hidden ramp.
        if(Math.abs(x-plankX(i))<=plankWidth*.5+.18)support=Math.max(support,plankY(i)+.005+plankDepth*.5);
      }
      return support;
    },
    dispose() {stopWorker();for(const {tile,mesh} of terrainChunks.values()){scene.remove(mesh);mesh.geometry.dispose();releaseTerrainBlock(tile.x,tile.z);}terrainChunks.clear();scene.remove(horizon);horizon.geometry.dispose();horizonMaterial.dispose();for(const t of textures)t.dispose();for(const g of bridgeGeometries)g.dispose();material.dispose();river.dispose();boulderGeo.dispose();boulderMat.dispose();markerMat.dispose();for(const g of markerGeometries)g.dispose();wood.dispose();}
  };
}
