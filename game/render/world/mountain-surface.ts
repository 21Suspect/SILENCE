import * as THREE from 'three';
import { loadTextureArray } from './texture-array';

/**
 * The mountains' surface: four CC0 scans from Poly Haven (public/textures/mountain/attribution.json), packed like the forest
 * floor's (colour with height in alpha; normal and roughness), in two texture arrays shared by the island's range (terrain.ts)
 * and the far range (far-range.ts).
 *   0 alpine  aerial_rocks_04       80 m: grass and outcrops seen from above, for the slopes the eye looks down on
 *   1 crag    mountainside          7.2 m of a shattered, layered mountainside, rendered flat from the scanned model
 *                                   (tools/assets/mountain): the faces' broken rock, read at 80, 24 and 7.2 m
 *   2 snow    snow_field_aerial     80 m: snow with rock breaking through
 *   3 blocks  namaqualand_cliff_02  6.5 m of jointed granite blocks, rendered the same way: the cliffs' joints at 20 and 6 m,
 *                                   and seen from above at 9 m, the talus and rubble
 * Linear means, measured from the packed images: alpine .104/.069/.023, crag luminance .099, snow lum .248 (its AO is baked in;
 * fresh snow is near .8, so it is scaled up), blocks luminance .127.
 */
export const MOUNTAIN_LAYERS = ['alpine', 'crag', 'snow', 'blocks'] as const;

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
 * mountainLook(p, n, k, lines, geo): the albedo, shading normal (world), roughness and snow cover of mountain ground at world p
 * with geometric normal n. k is the land's scale (1 the island's range, 6 the far range: its zones and macro textures grow with
 * it); lines.x is the tree line and lines.y the snow line, in metres; geo the geology masks (sim/world/mountain-masks.ts:
 * ridge map, drainage, fallen debris, relief), baked from the final heightfield, which decide what grows and lies where:
 *   Rock on faces steeper than about 35 degrees, cliffs from about 50: real broken rock, the scanned faces at several sizes
 *   (mtnRock), a neutral grey-brown, darker and wet in the runnels.
 *   Talus and scree where the debris mask has rock come to rest (at the cliffs' feet, below the couloirs): lighter than cliff
 *   or forest, as in every photograph of a real range.
 *   Conifer forest below a tree line that climbs the gullies and drops on the spurs and crests, on slopes under about 50
 *   degrees, stopped by cliffs and scree, cut by avalanche chutes (the drainage lines on 25 to 40 degree slopes, left as pale
 *   alder and grass): a dark blue-green forest floor (albedo .02 to .04) with the trees stood on it (mountain-impostors.ts).
 *   Above the tree line: thin turf and scree, tan and yellow-green, between outcrops.
 *   Snow above a snow line that drops on the shaded north faces and in the couloirs, and lifts on the convex ridges.
 * The first surface chose all of this from noise and height alone; its tree line was a smooth olive ramp up every massif.
 * Normals: Golus's UDN triplanar blend of the scans' tangent normals over the geometric normal.
 */
export const mountainGLSL = `
  uniform sampler2DArray uMountainColor,uMountainSurface;
  struct Mountain{vec3 albedo;vec3 normal;float roughness;float snow;float forest;};
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
    // A narrow seam (a tenth of the cell): a wide crossfade averaged two unrelated crops over half of every face and left a grey
    // mush; a short one reads as one more joint in the rock.
    o.a=uv+sin(vec2(3.,7.)*i+seed);o.b=uv+sin(vec2(3.,7.)*(i+1.)+seed);o.t=smoothstep(.45,.55,fract(l));
    o.dx=dFdx(uv);o.dy=dFdy(uv);return o;
  }
  vec4 mtnRead(sampler2DArray s,MtnTile o,float layer){
    return mix(textureGrad(s,vec3(o.a,layer),o.dx,o.dy),textureGrad(s,vec3(o.b,layer),o.dx,o.dy),o.t);
  }
  // One size of a rock scan on one of a face's upright projections: its light and dark (as a ratio to the scan's mean, so each
  // size adds structure, not colour) into tone, its normal into t (in the projection's frame), its roughness into r. Each size
  // is turned by its own angle, so the sizes' layers and cracks never line up into stripes.
  void mtnRockScale(vec2 uv,float size,float turn,float seed,float layer,float mean,float weight,inout float tone,inout vec2 t,inout float r){
    float c=cos(turn),s=sin(turn);mat2 R=mat2(c,s,-s,c);
    MtnTile o=mtnTile(R*uv/size,seed);
    vec4 col=mtnRead(uMountainColor,o,layer),sf=mtnRead(uMountainSurface,o,layer);
    // The scan's light and dark, and its crevices darker still by its own height (alpha): the joints between the broken pieces
    // are what make a face read as rock from far off.
    tone*=mix(1.,dot(col.rgb,vec3(.2126,.7152,.0722))/mean*mix(.55,1.15,smoothstep(.15,.7,col.a)),weight);
    t+=transpose(R)*(sf.rg*2.-1.)*weight;
    r=mix(r,sf.b,weight*.5);
  }
  // A face's rock on one upright projection (uv: across the face, up it): the shattered mountainside scan at 80, 24 and 7.2 m
  // (x k), and on the cliffs the jointed-granite scan at 20 and 6 m; sizes too small for the screen (a tile under about twelve
  // pixels) are not read at all. Real rock is self-similar: the same broken face photographed at three sizes reads as broken rock
  // from the lake and from the road alike, which no noise did (it drew smooth grey bands and stripes).
  void mtnRock(vec2 uv,float k,float pixel,float cliff,inout float tone,inout vec2 t,inout float r){
    // The largest size's light and dark at .6: at full strength its blotches (a tone range of ten) drowned the sun's light and
    // shade (a range of two or three), and the faces read as mottled stone with no form; its normals keep their full strength.
    mtnRockScale(uv,80.*k,.6,1.7,1.,.099,.6,tone,t,r);
    if(24.*k>pixel*12.)mtnRockScale(uv+vec2(31.,7.),24.*k,-.45,4.3,1.,.099,.8,tone,t,r);
    if(7.2*k>pixel*12.)mtnRockScale(uv+vec2(-13.,5.),7.2*k,.25,2.9,1.,.099,.7,tone,t,r);
    if(cliff>.02){
      mtnRockScale(uv+vec2(5.,-9.),20.*k,0.,6.1,3.,.127,cliff,tone,t,r);
      if(6.*k>pixel*12.)mtnRockScale(uv+vec2(9.,2.),6.*k,.1,3.7,3.,.127,cliff*.8,tone,t,r);
    }
  }
  Mountain mountainLook(vec3 p,vec3 n,float k,vec2 lines,vec4 geo){
    Mountain m;
    vec3 w=pow(abs(n),vec3(6.));w/=max(dot(w,vec3(1.)),1e-4);
    float slope=1.-n.y,wx=w.x/max(w.x+w.z,1e-4),wz=1.-wx,eye=length(p-cameraPosition);
    // Metres per pixel here: detail smaller than a few pixels is faded to its mean rather than left to shimmer.
    float pixel=max(length(fwidth(p)),1e-3);
    vec2 q=p.xz;
    // The island's bake carries its forest cover in geo.w (mountain-bake.ts); the far range's carries the relief.
    float ridge=geo.x*2.-1.,flow=geo.y,debris=geo.z,relief=k<2.?0.:geo.w*2.-1.;
    float n1=mtnNoise(q/(260.*k)),n2=mtnNoise(q/(60.*k)+7.),n3=mtnNoise(q/(17.*k)-3.);
    // ---- What lies where (geo masks first, noise only to fray the edges). mountain-impostors.ts repeats the forest's rule.
    // Cliff: steeper than about 50 degrees (n.y under .64), a little less on the crests, whose soil the wind and frost strip.
    float cliff=smoothstep(.7,.6,n.y+(n3-.5)*.07-max(ridge,0.)*.05);
    // Scree and talus where fallen rock has come to rest, on anything short of a cliff.
    float scree=smoothstep(.12,.45,debris+(n3-.5)*.12)*(1.-cliff);
    // The tree line: higher up the gullies and hollows (shelter, soil, water), lower on the spurs and crests, frayed by stands.
    float treeLine=lines.x+(-ridge*16.-relief*22.+flow*30.+(n1-.5)*44.+(n2-.5)*18.)*k;
    // Up to about 50 degrees: the heightfield's 4 m facets are steeper than a real slope's mean, and conifers hold to 40 or more.
    float forest=(1.-smoothstep(treeLine-6.*k,treeLine+6.*k,p.y))*smoothstep(.58,.66,n.y+(n3-.5)*.06);
    // Krummholz: clumps of stunted trees above the line, on the ledges and hollows, thinning towards the crests.
    float clumps=smoothstep(.6,.7,mtnNoise(q/(14.*k)+3.1)*.6+n3*.4-max(ridge,0.)*.3)*smoothstep(.7,.8,n.y)*(1.-smoothstep(treeLine,treeLine+50.*k,p.y));
    forest=max(forest,clumps);
    // Avalanche chutes: the drainage lines on 25 to 40 degree slopes run straight through the forest as bare strips.
    float chute=smoothstep(.5,.66,flow+(n2-.5)*.1)*smoothstep(.68,.76,n.y)*(1.-smoothstep(.89,.93,n.y));
    // Fresh talus and the cliffs themselves hold no trees; old, settled debris low down is forested over.
    forest*=(1.-smoothstep(.4,.8,scree))*(1.-smoothstep(.3,.8,cliff))*(1.-chute*.92);
    // On the island the bake decided it, with the same rule, so the trees stood on it (mountain-impostors.ts) match.
    if(k<2.)forest=smoothstep(.04,.4,geo.w+(n3-.5)*.08);
    // ---- Rock: real broken faces (mtnRock), on the face's one or two upright projections.
    float rockTone=0.,rockR=0.;vec2 tx=vec2(0.),tz=vec2(0.);
    if(wx>.04){float tn=1.,r=.9;mtnRock(vec2(p.z*sign(n.x),p.y),k,pixel,cliff,tn,tx,r);rockTone+=tn*wx;rockR+=r*wx;tx.x*=sign(n.x);}
    if(wz>.04){float tn=1.,r=.9;mtnRock(vec2(-p.x*sign(n.z),p.y),k,pixel,cliff,tn,tz,r);rockTone+=tn*wz;rockR+=r*wz;tz.x*=-sign(n.z);}
    rockTone/=max(wx*step(.04,wx)+wz*step(.04,wz),1e-3);rockR/=max(wx*step(.04,wx)+wz*step(.04,wz),1e-3);
    // Granite and gneiss, a neutral grey-brown (the scans are desert stone, taken to grey in pack_faces.py and here), lighter
    // where it broke off lately and darker and lichened where it has stood long, over tens of metres.
    // Darker than the first pass (.13, which read pale grey in the noon sun beside the reference's warm dark rock), warm grey.
    vec3 rock=vec3(.104,.097,.086)*clamp(rockTone,.45,1.6)*(.84+.16*n2+.08*n1);
    // Gullies sit in shade and wet, ribs and crests stand lit: the erosion's ridge map, strong enough to read from the lake.
    rock*=mix(.62,1.14,smoothstep(-.6,.6,ridge));
    // Wet and dark in the runnels the water takes off the faces (drainage).
    rock*=1.-.3*smoothstep(.45,.75,flow)*(1.-smoothstep(.85,.95,n.y));
    // ---- The ground the eye looks down on: the aerial scan, as turf high up and as rubble in the scree.
    MtnTile ta=mtnTile(q/(80.*k),3.3);
    vec4 al=mtnRead(uMountainColor,ta,0.);
    // Alpine turf: tan and yellow-green, thin, with grey outcrops (the scan's grass taken most of the way to grey).
    vec3 turf=mtnDesat(al.rgb,.42)*vec3(1.04,1.,.84)*1.35*(.8+.35*n3);
    float stony=smoothstep(.3,.7,n1*.5+n2*.5+max(ridge,0.)*.4);
    // Rubble and talus: the jointed-granite scan seen from above at 9 m (x k) reads as a field of broken blocks.
    float boulders=max(scree,stony*.7)*(1.-forest);
    float stoneTone=1.;vec2 ts=vec2(0.);
    if(boulders>.02){float r=.9;mtnRockScale(q+vec2(3.,8.),9.*k,.3,8.3,3.,.127,1.,stoneTone,ts,r);}
    vec3 rubble=mtnDesat(al.rgb,.08)*vec3(1.,.98,.95)*.9*(.85+.3*n3)*clamp(stoneTone,.2,2.5);
    vec3 col=mix(turf,rubble,stony);
    // The steep: rock; then the talus, paler than either.
    float rockCover=max(cliff,smoothstep(.22,.4,slope+(n2-.5)*.12));
    col=mix(col,rock,rockCover);
    col=mix(col,rubble*mix(.95,1.2,n2),scree);
    // The chutes: alder and grass, a paler, yellower green than the forest round them, where the forest would be.
    float underChute=chute*(1.-smoothstep(treeLine,treeLine+30.*k,p.y))*(1.-cliff);
    col=mix(col,mtnDesat(al.rgb,.7)*vec3(.9,1.05,.7)*1.2,underChute*.8);
    // ---- Forest floor under the stands, seen between the trees (mountain-impostors.ts stands the trees themselves on it): dark,
    // blue-green, in stands 30 to 100 m across, spruce and fir darkest, pine and larch lighter and warmer.
    float stand=mtnNoise(q/(70.*k)+5.)*.7+mtnNoise(q/(23.*k)-8.)*.3;
    vec3 canopy=mix(vec3(.016,.025,.022),vec3(.03,.039,.025),smoothstep(.35,.75,stand))*mix(.8,1.15,mtnNoise(q/(5.*k)));
    col=mix(col,canopy,forest);
    // ---- Snow: lower on the faces turned from the sun (+z is north, away from it) and in the couloirs, higher on the crests.
    float line=lines.y+(n1-.5)*lines.y*.2-(n2-.5)*40.*k-max(n.z,0.)*90.*k-flow*70.*k+ridge*45.*k;
    float snow=smoothstep(line,line+25.*k,p.y+(n3-.5)*30.*k)*(1.-smoothstep(.36,.6,slope-(n2-.5)*.2));
    MtnTile tsn=mtnTile(q/(80.*k)+vec2(.37,.11),5.9);
    vec4 sn=vec4(0.);
    if(snow>.001||p.y>line+60.*k){
      sn=mtnRead(uMountainColor,tsn,2.);
      snow=max(snow,smoothstep(line+90.*k,line+220.*k,p.y)*(1.-smoothstep(.55,.78,slope))*smoothstep(.15,.45,sn.a));
    }
    snow*=1.-forest;
    // Rock breaks through the snow where it stands proud and on its steepest facets.
    snow*=mix(1.,smoothstep(.55,1.1,rockTone)*(1.-smoothstep(.5,.9,length(tx+tz))),rockCover);
    col=mix(col,mtnDesat(sn.rgb,.5)*3.2,snow);
    m.albedo=col;m.snow=snow;m.forest=forest;
    // Normals: the rock scans on the sides, the alpine or snow map (and the boulders) on top, each over the geometric normal
    // (Golus's UDN blend). The scans' own sizes keep them from aliasing: each is read only while its tile spans a dozen pixels.
    vec4 st=mtnRead(uMountainSurface,ta,0.);
    if(snow>.001)st=mix(st,mtnRead(uMountainSurface,tsn,2.),snow);
    float bare=(1.-forest)*(1.-snow*.7);
    // The faces' relief is what the raking sun draws: the scans' normals at a little over full strength.
    tx*=1.25*bare;tz*=1.25*bare;
    vec2 ty=mtnTangent(st,1.-forest)+ts*.8*boulders*(1.-snow);
    vec3 nX=vec3(abs(n.x),tx.y+n.y,tx.x+n.z),nY=vec3(ty.x+n.x,abs(n.y),ty.y+n.z),nZ=vec3(tz.x+n.x,tz.y+n.y,abs(n.z));
    nX.x*=sign(n.x);nY.y*=sign(n.y);nZ.z*=sign(n.z);
    m.normal=normalize(nX*w.x+nY*w.y+nZ*w.z);
    m.roughness=mix(mix(mix(.92,rockR,.5*rockCover),.6,snow),.95,forest);
    return m;
  }
`;
