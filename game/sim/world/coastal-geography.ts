/** Original coastal watershed shared by terrain, rendering, placement and physics.
 * +Z is inland: alpine headwaters feed a lake, whose outlet reaches the southern sea.
 */
import { noise, fbm, riverX, waterHeightAt, smooth } from './world-noise';
import { gradientNoise, erosionFilter } from './mountain-noise';

export const SEA_LEVEL = -5.2;
export const LAKE_LEVEL = .6;
export const LAKE_CENTER = { x: riverX(100) + 15, z: 100 };
/** Conservative bounds for water tessellation, not an ellipse defining its shape. */
export const LAKE_RADII = { x: 100, z: 150 };

/** Bays and headlands at several scales, without a radial island or enclosing ring. */
export function coastZ(x: number) {
  return -359 + 34 * Math.sin(x * .009 + .7) + 18 * Math.sin(x * .021 - 1.1)
    + 8 * Math.sin(x * .049 + .4) + 31 * Math.exp(-(((x + 185) / 100) ** 2))
    - 25 * Math.exp(-(((x - 275) / 115) ** 2));
}
const eastShore=(z:number)=>535+62*Math.sin(z*.007+.4)+28*Math.sin(z*.021+1.1)-170*smooth(-z,100,440)-100*smooth(z,440,730);
const westShore=(z:number)=>532+68*Math.sin(z*.008-1.2)+28*Math.sin(z*.024)-205*smooth(-z,80,440)-115*smooth(z,440,730);
const northShore=(x:number)=>650+40*Math.sin(x*.008)+18*Math.sin(x*.019+.7)-70*smooth(Math.abs(x),280,600);
const joinCoasts=(a:number,b:number)=>{const h=Math.max(32-Math.abs(a-b),0)/32;return Math.min(a,b)-h*h*8;};
/** Shoreline wraps around the headlands before the finite terrain ends. The
 * hidden backshore lies behind the snowy range, so offshore views see water
 * beyond all land instead of an exposed square terrain edge. */
export function coastDistance(x: number, z: number) {
  const southSlope=coastZ(x+.5)-coastZ(x-.5);
  const eastSlope=eastShore(z+.5)-eastShore(z-.5),westSlope=westShore(z+.5)-westShore(z-.5);
  const northSlope=northShore(x+.5)-northShore(x-.5);
  const south=(z-coastZ(x))/Math.hypot(1,southSlope);
  const east=(eastShore(z)-x)/Math.hypot(1,eastSlope),west=(x+westShore(z))/Math.hypot(1,westSlope);
  const north=(northShore(x)-z)/Math.hypot(1,northSlope);
  return joinCoasts(joinCoasts(south,north),joinCoasts(east,west));
}
/** Sheltered coves hold wide sand; exposed headlands have narrow beaches. */
export function beachWidth(x:number,z:number){
  return 8+34*Math.pow(.5+.5*Math.sin(x*.011+z*.007+1.3),2)+12*(.5+.5*Math.sin(x*.029-z*.017));
}
/** Approximate signed shoreline distance in metres, positive on land. */
export function lakeDistance(x: number, z: number) {
  const dx=x-LAKE_CENTER.x, dz=z-100;
  const ellipse=(cx:number,cz:number,rx:number,rz:number)=>
    (Math.hypot((dx-cx+(dz-cz)*.11)/rx,(dz-cz)/rz)-1)*Math.min(rx,rz);
  const join=(a:number,b:number)=>{const h=Math.max(12-Math.abs(a-b),0)/12;return Math.min(a,b)-h*h*3;};
  // Three offset glacial basins join through broad necks. The eastern lobes
  // and intervening headland avoid the silhouette of an elongated circle.
  const basin=join(join(ellipse(0,0,70,80),ellipse(38,77,48,62)),ellipse(22,-75,36,58));
  return basin+2.2*Math.sin(x*.12+z*.045)+1.4*Math.sin(z*.135-x*.037);
}
/**
 * The lake's shore where a river runs into it. Taken alone, the lake's own shore passes a few metres beside the river's mouth and
 * leaves a bar of beach between the two, so the river and the lake read as two bodies of water with a sand strip along the
 * seam. Joined, the shore is pulled out to meet the river's waterline wherever the two are within JOIN_REACH of each other: one
 * outline runs around the lake and up into the river, and the ground under it (the lake's floor, the beach, the bank) all
 * follow that single line. Deep inside the lake and far along the river it changes nothing.
 */
export const JOIN_REACH = 26;
export const RIVER_WATERLINE = 3.3;
export function riverEdgeDistance(x: number, z: number) {
  const s = riverX(z + .5) - riverX(z - .5);
  return Math.abs(x - riverX(z)) / Math.hypot(1, s) - RIVER_WATERLINE;
}
export function joinShore(shore: number, x: number, z: number) {
  if (shore > 14 || shore < -8) return shore;
  const h = Math.max(JOIN_REACH - Math.abs(shore - riverEdgeDistance(x, z)), 0) / JOIN_REACH;
  if (h <= 0) return shore;
  return shore - h * h * JOIN_REACH * .25 * (1 - smooth(shore, 2, 12)) * smooth(shore, -8, 0);
}
export const lakeOutline = (x: number, z: number) => joinShore(lakeDistance(x, z), x, z);
/**
 * Where a river runs into the sea or the lake its banks do not meet the shore at a corner: they round off into it. `distance` is
 * the land's distance from the channel's middle; the result is that distance pulled in, smoothly, where the channel's bank and the
 * shore are about the same distance away, which fillets the inside corner between them (a radius of MOUTH_ROUND metres). It
 * leaves everything beyond a few metres of the channel alone, so the river itself is no wider anywhere.
 */
export const MOUTH_ROUND = 36;
/** How far, at most, the fillet pulls the bank in. The river's water ribbon is wider than this plus its bank (see river.ts), so the
 * rounded water is never cut off by the ribbon's own straight edge. */
export const MOUTH_PULL = 6.5;
export function mouthRound(distance: number, x: number, z: number) {
  if (distance > 16) return distance;
  const shore = Math.min(coastDistance(x, z) - 3, lakeDistance(x, z));
  const h = Math.max(MOUTH_ROUND - Math.abs(distance - shore), 0) / MOUTH_ROUND;
  if (h <= 0) return distance;
  return Math.max(0, distance - h * h * MOUTH_PULL * (1 - smooth(distance, 6, 15)));
}
export function broadWaterLevelAt(x: number, z: number): number | undefined {
  if (coastDistance(x, z) <= 3) return SEA_LEVEL;
  if (lakeOutline(x, z) <= 0) return LAKE_LEVEL;
  return undefined;
}
export function mountainFoot(x: number) {
  return 342 + Math.sin(x * .009 + .2) * 29 + Math.sin(x * .027 + 1) * 11;
}
/**
 * The island's range: six massifs, 120 to 175 m, joined by a lower crest, then carved by the erosion filter (mountain-noise.ts).
 * Real mountains are broad masses about three times as wide as they are high, with rounded, broken summits, cut into gullies
 * that run down the fall line and branch, with ribs and buttresses between them. The first range (smooth ellipse ridges) read
 * as grey hills; the second (three-faced horns with ridged crags) as needles and combs. Each massif is a bell (a convex summit
 * over a concave foot) on a warped, turned ellipse; the gullies are 190 m apart at their widest and up to 24 m deep (at 150 m and 40 m the ribs between them stood up
 * as needles seen end-on and the flanks read as blocks), less on
 * the lower slopes and none on the crest; three octaves only (finer ones fluted the faces like clay badlands and sawed the crest; the
 * rock's own detail is the surface's job, mountain-surface.ts) (60 m deep and five octaves fine, they fluted the faces into organ pipes and the skyline into spires).
 */
const MASSIFS = [
  [-345, 532, 130, 330, 240, -.4], [-185, 552, 165, 330, 255, .3], [-38, 522, 120, 290, 215, -.6],
  [118, 572, 175, 350, 260, .6], [287, 525, 145, 315, 240, -.2], [420, 580, 130, 300, 250, .8],
] as const;
const smax=(a:number,b:number,k:number)=>Math.max(a,b)+Math.log(1+Math.exp(-Math.abs(a-b)/k))*k;
const warp=(x:number,z:number,o:number)=>{let s=0,a=.5,f=1,t=0;for(let i=0;i<o;i++){s+=a*gradientNoise(x*f+i*31.7,z*f-i*17.3);t+=a;a*=.5;f*=2.03;}return s/t;};
function massifs(x:number,z:number){
  const ux=warp(x/310,z/310,3)*.22,uz=warp(x/310-7,z/310+5,3)*.22;
  let h=0;
  for(const [mx,mz,hh,rx,rz,turn] of MASSIFS){
    const dx=x+rx*ux-mx,dz=z+rz*uz-mz,c=Math.cos(turn),s=Math.sin(turn);
    const u2=((dx*c+dz*s)/rx)**2+((-dx*s+dz*c)/rz)**2;
    if(u2<4)h=smax(h,hh*Math.exp(-u2*2.4),18);
  }
  const crest=60*Math.exp(-(((z-548-30*gradientNoise(x/260,3.1))/85)**2))*(.6+.4*warp(x/200,9,2));
  h=smax(h,crest,14);
  // Broad, uneven summits rather than sharp crest lines: a smooth swell, not ridged noise (whose crests the gullies cut into combs).
  return Math.max(0,h*(1+.14*warp(x/260+3,z/260-1,3)));
}
/** Rugged asymmetric ranges. Steep lower scarps are actual impassable terrain. */
export function mountainRelief(x: number, z: number) {
  const foot = mountainFoot(x), north = smooth(z, foot - 65, foot + 105) ** 2;
  const sideLine = 460 + 24 * Math.sin(z * .012 + .4) + 13 * Math.sin(z * .033);
  const side = Math.abs(x + 16 * Math.sin(z * .007)) - sideLine;
  if(north<=0 && side<=0)return 0;
  const scarp = 14 * smooth(z, foot - 45, foot + 115);
  // The massifs rise behind the foot, not on it: reaching down to it they stood 60 to 100 m over the road's mouths, which then
  // ran into vertical cuttings that high (fins from across the lake). Their feet now start 30 m north of the foot.
  const rise=(z2:number)=>smooth(z2-foot,30,200);
  const lifted=(x2:number,z2:number)=>massifs(x2,z2)*rise(z2);
  const base=lifted(x,z),e=2,sx=(lifted(x+e,z)-lifted(x-e,z))/(2*e),sz=(lifted(x,z+e)-lifted(x,z-e))/(2*e);
  const peak=Math.max(0,base+erosionFilter(x,z,sx,sz,190,24*Math.min(1,base/110),3));
  const range=scarp+peak*north;
  const valleyDistance=Math.abs(x-riverX(z));
  const valleyWidth=34+13*Math.sin(z*.019)+8*Math.sin(z*.047);
  const valleyBlend=smooth(valleyDistance,8,valleyWidth+85);
  const valleyFloor=waterHeightAt(z)+2+valleyDistance*.20;
  const drained=Math.min(range,valleyFloor+(range-valleyFloor)*valleyBlend);
  const headlands = (36 + 15 * noise(x * .018, z * .018)) * smooth(side, 0, 85)
    + 19 * smooth(side, 25, 90) * (1 - Math.abs(fbm(x * .028, z * .028, 2)));
  return Math.max(drained, headlands);
}
/** Shape shores before placement so props and route grading see the same dry land. */
export function coastalTerrain(x: number, z: number, forest: number) {
  const coast = coastDistance(x, z);
  if(coast <= 0)return SEA_LEVEL - .12 - Math.min(46,-coast * (.045+.10*smooth(-coast,18,95)));
  let height = forest + mountainRelief(x, z);
  const lake = lakeOutline(x, z);
  if (lake < 28) {
    const bed = LAKE_LEVEL - .08 + lake * .135 + .18 * noise(x * .08, z * .08);
    const shore = LAKE_LEVEL + Math.max(lake, 0) * .16;
    height = lake <= 0 ? Math.min(LAKE_LEVEL - .06, bed)
      : shore + (height - shore) * smooth(lake, 5, 28);
  }
  if (coast < 105) {
    const width=beachWidth(x,z);
    const dune = (1.1+1.8*noise(x*.035+31,z*.035))*Math.exp(-Math.pow((coast-width*.92)/9,2))*(.35+.65*noise(x*.065,z*.065))*smooth(coast,3,15);
    const sand = dune + SEA_LEVEL - .12 + coast * (.035+.025*(1-smooth(width,12,50))) + (noise(x * .09, z * .09) - .5) * .22 * smooth(Math.abs(coast), 0, 12);
    const shelf = SEA_LEVEL - .1 - Math.min(46, Math.max(0, -coast) * .17);
    height = coast <= 0 ? shelf : sand + (height - sand) * smooth(coast, width, width+55);
  }
  return height;
}
// The island's massifs are bare rock to their summits (140 to 200 m, as broad as the reference lake country's), as alpine
// lake country is in summer; the far range carries the snow (far-range.ts).
export function snowCoverage(x: number, z: number, height: number, slope = 0) {
  const line = 330 + 8 * Math.sin(x * .037 + z * .019) + 5 * Math.sin(z * .063);
  return smooth(height, line, line + 22) * (1 - smooth(slope, .65, 1.5));
}
/** No noise-helper dependency: can also be used by the water material. */
export const coastalGLSL = `
  float coastZ(float x){return -359.+34.*sin(x*.009+.7)+18.*sin(x*.021-1.1)+8.*sin(x*.049+.4)+31.*exp(-pow(abs((x+185.)/100.),2.))-25.*exp(-pow(abs((x-275.)/115.),2.));}
  float eastShore(float z){return 535.+62.*sin(z*.007+.4)+28.*sin(z*.021+1.1)-170.*smoothstep(100.,440.,-z)-100.*smoothstep(440.,730.,z);}
  float westShore(float z){return 532.+68.*sin(z*.008-1.2)+28.*sin(z*.024)-205.*smoothstep(80.,440.,-z)-115.*smoothstep(440.,730.,z);}
  float northShore(float x){return 650.+40.*sin(x*.008)+18.*sin(x*.019+.7)-70.*smoothstep(280.,600.,abs(x));}
  float joinCoasts(float a,float b){float h=max(32.-abs(a-b),0.)/32.;return min(a,b)-h*h*8.;}
  float coastDistance(vec2 p){float s=coastZ(p.x+.5)-coastZ(p.x-.5),e=eastShore(p.y+.5)-eastShore(p.y-.5),w=westShore(p.y+.5)-westShore(p.y-.5),n=northShore(p.x+.5)-northShore(p.x-.5);return joinCoasts(joinCoasts((p.y-coastZ(p.x))/sqrt(1.+s*s),(northShore(p.x)-p.y)/sqrt(1.+n*n)),joinCoasts((eastShore(p.y)-p.x)/sqrt(1.+e*e),(p.x+westShore(p.y))/sqrt(1.+w*w)));}
  float beachWidth(vec2 p){return 8.+34.*pow(.5+.5*sin(p.x*.011+p.y*.007+1.3),2.)+12.*(.5+.5*sin(p.x*.029-p.y*.017));}
  float lakeEllipse(vec2 d,vec2 c,vec2 r){vec2 q=d-c;return (length(vec2((q.x+q.y*.11)/r.x,q.y/r.y))-1.)*min(r.x,r.y);}
  float lakeJoin(float a,float b){float h=max(12.-abs(a-b),0.)/12.;return min(a,b)-h*h*3.;}
  float lakeDistance(vec2 p){vec2 d=p-vec2(${LAKE_CENTER.x.toFixed(8)},100.);float basin=lakeJoin(lakeJoin(lakeEllipse(d,vec2(0.),vec2(70.,80.)),lakeEllipse(d,vec2(38.,77.),vec2(48.,62.))),lakeEllipse(d,vec2(22.,-75.),vec2(36.,58.)));return basin+2.2*sin(p.x*.12+p.y*.045)+1.4*sin(p.y*.135-p.x*.037);}
  float mouthRound(float d,vec2 p){if(d>16.)return d;float shore=min(coastDistance(p)-3.,lakeDistance(p));float h=max(${MOUTH_ROUND.toFixed(1)}-abs(d-shore),0.)/${MOUTH_ROUND.toFixed(1)};return max(0.,d-h*h*${MOUTH_PULL.toFixed(2)}*(1.-smoothstep(6.,15.,d)));}
  float snowCoverage(vec3 p,vec3 n){float line=330.+8.*sin(p.x*.037+p.z*.019)+5.*sin(p.z*.063);float slope=length(n.xz)/max(.01,abs(n.y));return smoothstep(line,line+22.,p.y)*(1.-smoothstep(.65,1.5,slope));}
`;
/** GLSL twin of {@link lakeOutline}; the including shader must already define streamCentre. */
export const lakeOutlineGLSL = `
  float lakeOutline(vec2 p){
    float shore=lakeDistance(p);
    if(shore>14.||shore<-8.)return shore;
    float s=streamCentre(p.y+.5)-streamCentre(p.y-.5);
    float river=abs(p.x-streamCentre(p.y))/sqrt(1.+s*s)-${RIVER_WATERLINE.toFixed(1)};
    float h=max(${JOIN_REACH.toFixed(1)}-abs(shore-river),0.)/${JOIN_REACH.toFixed(1)};
    return shore-h*h*${(JOIN_REACH*.25).toFixed(2)}*(1.-smoothstep(2.,12.,shore))*smoothstep(-8.,0.,shore);
  }
`;
