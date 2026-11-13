import * as THREE from 'three';
import { loadTextureArray } from './texture-array';

/**
 * The mountains' surface: four CC0 scans from Poly Haven (public/textures/mountain/attribution.json), packed like the forest
 * floor's (colour with height in alpha; normal and roughness), in two texture arrays shared by the island's range (terrain.ts)
 * and the far range (far-range.ts).
 *   0 alpine  aerial_rocks_04    80 m: grass and outcrops seen from above, for the slopes the eye looks down on
 *   1 face    rock_face_03       2.7 m: the rock's grain on the faces, read at 8 m
 *   2 snow    snow_field_aerial  80 m: snow with rock breaking through
 *   3 cliff   cliff_side         1.83 m: layered strata, read at 22 m as ledges (normals only) on the steepest faces
 * Linear means, measured from the packed images: alpine .104/.069/.023, face .207/.130/.074 (lum .142), snow lum .248 (its AO is
 * baked in; fresh snow is near .8, so it is scaled up), cliff lum .107.
 */
export const MOUNTAIN_LAYERS = ['alpine', 'face', 'snow', 'cliff'] as const;

type Layers = { color: THREE.DataArrayTexture; surface: THREE.DataArrayTexture; ready: Promise<unknown> };
const loaded = new WeakMap<THREE.WebGLRenderer, Layers>();
/** The two arrays, loaded once per renderer for every material that uses them. Without one (tests, tools), 1-pixel stand-ins. */
export function mountainLayers(renderer?: THREE.WebGLRenderer): Layers {
  if (!renderer) {
    const blank = (srgb: boolean) => { const t = new THREE.DataArrayTexture(new Uint8Array(4 * MOUNTAIN_LAYERS.length).fill(128), 1, 1, MOUNTAIN_LAYERS.length); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t; };
    return { color: blank(true), surface: blank(false), ready: Promise.resolve() };
  }
  let shared = loaded.get(renderer);
  if (!shared) {
    const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const url = (kind: string, ext: string) => MOUNTAIN_LAYERS.map(n => `/textures/mountain/${n}-${kind}.${ext}`);
    const color = loadTextureArray(renderer, url('color', 'webp'), { size: 2048, srgb: true, anisotropy });
    const surface = loadTextureArray(renderer, url('surface', 'jpg'), { size: 1024, anisotropy });
    shared = { color: color.texture as THREE.DataArrayTexture, surface: surface.texture as THREE.DataArrayTexture, ready: Promise.all([color.ready, surface.ready]) };
    loaded.set(renderer, shared);
  }
  return shared;
}

/**
 * mountainLook(p, n, k, lines): the albedo, shading normal (world), roughness and snow cover of mountain ground at world p with
 * geometric normal n. k is the land's scale (1 the island's range, larger for the far range: its zones and macro textures grow
 * with it); lines.x is the tree line and lines.y the snow line, in metres.
 *   Faces (steeper than about 50 degrees) are rock: the face scan's grain, desaturated to an alpine grey, its tone broken by the
 *   cliff scan's strata at 22 m (x k), whose normals also cut ledges across them. Ground the eye looks down on takes the aerial
 *   alpine scan, its grass dried to brown scree above the tree line. Conifer canopy below the tree line where trees can stand.
 *   Snow above a wandering snow line where the slope holds it, and on the high shelves wherever the snow scan's relief does.
 * Normals: Golus's UDN triplanar blend of the scans' tangent normals over the geometric normal.
 */
export const mountainGLSL = `
  uniform sampler2DArray uMountainColor,uMountainSurface;
  struct Mountain{vec3 albedo;vec3 normal;float roughness;float snow;};
  float mtnHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float mtnNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(mtnHash(i),mtnHash(i+vec2(1.,0.)),f.x),mix(mtnHash(i+vec2(0.,1.)),mtnHash(i+vec2(1.,1.)),f.x),f.y);}
  vec3 mtnDesat(vec3 c,float s){return mix(vec3(dot(c,vec3(.2126,.7152,.0722))),c,s);}
  vec2 mtnTangent(vec4 s,float strength){return (s.rg*2.-1.)*strength;}
  // A scan read without its repeat (after Inigo Quilez's "texture repetition", technique 3): a slow noise over the texture's
  // own coordinates picks one of eight offsets of the whole scan, and its fraction crossfades to the next, so no two tiles side by
  // side are the same crop and no grid of repeats lines up across a face. Two reads per scan; the surface map takes the same two.
  struct MtnTile{vec2 a;vec2 b;float t;vec2 dx;vec2 dy;};
  MtnTile mtnTile(vec2 uv,float seed){
    MtnTile o;float l=mtnNoise(uv*.43+seed)*8.,i=floor(l);
    o.a=uv+sin(vec2(3.,7.)*i+seed);o.b=uv+sin(vec2(3.,7.)*(i+1.)+seed);o.t=smoothstep(.25,.75,fract(l));
    o.dx=dFdx(uv);o.dy=dFdy(uv);return o;
  }
  vec4 mtnRead(sampler2DArray s,MtnTile o,float layer){
    return mix(textureGrad(s,vec3(o.a,layer),o.dx,o.dy),textureGrad(s,vec3(o.b,layer),o.dx,o.dy),o.t);
  }
  Mountain mountainLook(vec3 p,vec3 n,float k,vec2 lines){
    Mountain m;
    vec3 w=pow(abs(n),vec3(6.));w/=max(dot(w,vec3(1.)),1e-4);
    float slope=1.-n.y,wx=w.x/max(w.x+w.z,1e-4),wz=1.-wx,eye=length(p-cameraPosition);
    vec2 q=p.xz;
    float n1=mtnNoise(q/(260.*k)),n2=mtnNoise(q/(60.*k)+7.),n3=mtnNoise(q/(17.*k)-3.);
    // Faces: grain at 8 m, strata at 22 m (x k), each on the two upright projections.
    // The strata wander up and down by a third of their spacing (level bands read as terraces) and only show on real faces.
    float wander=(mtnNoise(q/(90.*k)+11.)-.5)*14.*k;
    MtnTile fx=mtnTile(p.zy/8.,1.3),fz=mtnTile(p.xy/8.,4.1),cx=mtnTile(vec2(p.z,p.y+wander)/(22.*k),2.7),cz=mtnTile(vec2(p.x,p.y+wander)/(22.*k),6.2);
    vec3 face=mtnRead(uMountainColor,fx,1.).rgb*wx+mtnRead(uMountainColor,fz,1.).rgb*wz;
    // Far off, the grain's tone is its mean: its light and dark patches only shimmer at a few pixels each.
    face=mix(face,vec3(.207,.13,.074),smoothstep(150.,600.,eye)*.7);
    // Alpine granite and gneiss, not desert sandstone: the face scan's warm brown taken to a grey-brown (the reference's rock), in broad patches of lighter
    // and darker rock over tens of metres. The cliff scan gives no colour: its strata, banded in colour or even as ledges on any
    // slope short of a face, followed the contours and drew sedimentary terraces and a canyon.
    // Outcrops and slabs 25 to 60 m across, light and dark (the face of a real massif seen from half a kilometre is a patchwork,
    // not one tone): the scan's grain is gone at that range, so this is what the eye reads as rock.
    float slabs=mtnNoise(q/(26.*k)+vec2(p.y/(26.*k),5.))*.6+mtnNoise(q/(9.*k)-vec2(p.y/(9.*k),2.))*.4;
    vec3 rock=mtnDesat(face,.3)*vec3(1.,.97,.92)*1.15*(.5+.45*n2+.25*n1)*mix(.55,1.3,slabs);
    // Ground seen from above: alpine grass and outcrops, dried to scree high up.
    MtnTile ta=mtnTile(q/(80.*k),3.3),tsn=mtnTile(q/(80.*k)+vec2(.37,.11),5.9);
    vec4 al=mtnRead(uMountainColor,ta,0.),sn=mtnRead(uMountainColor,tsn,2.);
    float high=smoothstep(lines.x,mix(lines.x,lines.y,.7),p.y);
    // The aerial grass is a warm olive; alpine turf is cooler and greener, and high up it gives way to grey scree.
    // Mostly scree and thin turf: a mountain reads as rock, not as a green hill (the aerial scan's grass taken nearly grey).
    vec3 alpine=mtnDesat(al.rgb,.28)*vec3(.98,.97,.92)*1.25*(.75+.4*n3);
    alpine=mix(alpine,mtnDesat(al.rgb,.1)*vec3(.98,.97,.95)*1.45,high*.85);
    float steep=smoothstep(.22,.45,slope+(n2-.5)*.16);
    vec3 col=mix(alpine,rock,steep);
    // Conifers up to the tree line on anything short of a face, reaching higher up the gullies (noise), and above it in clumps
    // on the ledges, thinning towards the summits: the dark flecks on the reference's rock.
    float tree=(1.-smoothstep(lines.x-20.*k,lines.x+30.*k,p.y+(n1-.5)*70.*k))*(1.-smoothstep(.62,.8,slope+(n3-.5)*.1));
    float clumps=smoothstep(.55,.66,mtnNoise(q/(22.*k)+3.1)*.65+n3*.35)*(1.-smoothstep(.5,.74,slope))*(1.-smoothstep(lines.x,lines.x+(lines.y-lines.x)*.6,p.y));
    tree=max(tree,clumps);
    // Conifer canopy seen from afar: dark, broken into crowns and shadowed gaps (it was one flat olive and read as moss).
    float crowns=mtnNoise(q/(6.*k))*.5+mtnNoise(q/(19.*k)+4.)*.5;
    vec3 canopy=mix(vec3(.012,.02,.014),vec3(.04,.054,.032),crowns);
    col=mix(col,canopy,tree);
    float line=lines.y+(n1-.5)*lines.y*.22-(n2-.5)*40.*k;
    float snow=smoothstep(line,line+25.*k,p.y+(n3-.5)*30.*k)*(1.-smoothstep(.36,.6,slope-(n2-.5)*.2));
    snow=max(snow,smoothstep(line+90.*k,line+220.*k,p.y)*(1.-smoothstep(.55,.78,slope))*smoothstep(.15,.45,sn.a));
    snow*=1.-tree;
    col=mix(col,mtnDesat(sn.rgb,.5)*3.2,snow);
    m.albedo=col;m.snow=snow;
    // Normals: the face and strata maps on the sides, the alpine or snow map on top, each over the geometric normal (UDN). The
    // grain's normals fade out between 120 and 500 m, where they would only alias; the strata's ledges and the aerial maps stay.
    float grain=1.-smoothstep(120.,500.,eye);
    vec4 sfx=mtnRead(uMountainSurface,fx,1.),sfz=mtnRead(uMountainSurface,fz,1.);
    vec4 scx=mtnRead(uMountainSurface,cx,3.),scz=mtnRead(uMountainSurface,cz,3.);
    vec4 st=mix(mtnRead(uMountainSurface,ta,0.),mtnRead(uMountainSurface,tsn,2.),snow);
    float ledges=.7*smoothstep(.5,.78,slope);
    vec2 tx=mtnTangent(sfx,.9*grain)+mtnTangent(scx,ledges),tz=mtnTangent(sfz,.9*grain)+mtnTangent(scz,ledges),ty=mtnTangent(st,1.);
    vec3 nX=vec3(abs(n.x),tx.y+n.y,tx.x+n.z),nY=vec3(ty.x+n.x,abs(n.y),ty.y+n.z),nZ=vec3(tz.x+n.x,tz.y+n.y,abs(n.z));
    nX.x*=sign(n.x);nY.y*=sign(n.y);nZ.z*=sign(n.z);
    m.normal=normalize(nX*w.x+nY*w.y+nZ*w.z);
    m.roughness=mix(mix(.92,sfx.b*wx+sfz.b*wz,.5),.6,snow);
    return m;
  }
`;
