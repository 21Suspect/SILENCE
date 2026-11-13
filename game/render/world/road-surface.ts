import { roadZ, roadSlope, ROAD_NORM } from '../../sim/world/world-noise';
import { ROAD, roadArcTable } from '../../sim/world/road-profile';
import { ROAD_CROSSING, BRIDGE_HALF_SPAN } from '../../sim/world/world-layout';

/**
 * The valley road as ground shading: an old two-lane asphalt carriageway, its worn paint, and a verge that crumbles away into
 * gravel, moss and grass. Everything is drawn by the terrain's fragment shader from the road's own centre line, so it has no
 * mesh, no decal and no texture of its own beyond the scanned aggregate it borrows.
 *
 * Three pieces are spliced into game/render/world/terrain.ts: `functions` (before main), `mask` (the road's coverage, early on) and
 * `colour` (its look, once the ground underneath has been worked out). `roughness` and `normal` finish the job in their own
 * chunks of the standard material. It expects `surfaceNoise`/`patchHash` (texture-variation) and `roadCenter`/`roadPresence`
 * (world.ts's geography) to be in scope.
 *
 * In the road's own coordinates `a` is metres across from the centre line and `s` metres along it. A noisy pixel footprint
 * (`fp`, metres) fades the finest detail with distance so nothing shimmers.
 */
export function roadSurface() {
  const arc = roadArcTable(roadZ, roadSlope).map(v => v.toFixed(3)).join(',');
  const functions = `
  const float ROAD_HALF=${ROAD.half.toFixed(2)};
  // The bridge carries the road at a fixed level; the ground it spans (the stream bed and its banks) is metres below the deck.
  const float BRIDGE_X=${ROAD_CROSSING.x.toFixed(2)};
  const float BRIDGE_LEVEL=${ROAD_CROSSING.level.toFixed(2)};
  const float BRIDGE_HALF=${BRIDGE_HALF_SPAN.toFixed(2)};
  const float ROAD_ARC[${ROAD.arcCount}]=float[${ROAD.arcCount}](${arc});
  // Arc length of the centre line up to x: the paint is laid out along the road, so it neither stretches nor smears on the diagonals.
  // The table is uniform in x, so on the steep stretches its nodes lie far apart along the road: a cubic through the length and
  // the exact rate of growth (sqrt(1+slope^2)) at both ends of the cell, as roadArcAt in road-profile.ts does.
  float roadArc(float x){
    float u=clamp((x-(${ROAD.arcFrom.toFixed(1)}))/${ROAD.arcStep.toFixed(1)},0.,${(ROAD.arcCount - 1.001).toFixed(3)});int i=int(u);float t=u-float(i);
    float d0=length(vec2(1.,roadPlanGen(${ROAD.arcFrom.toFixed(1)}+float(i)*${ROAD.arcStep.toFixed(1)}).y)),d1=length(vec2(1.,roadPlanGen(${ROAD.arcFrom.toFixed(1)}+float(i+1)*${ROAD.arcStep.toFixed(1)}).y));
    float t2=t*t,t3=t2*t;
    return (2.*t3-3.*t2+1.)*ROAD_ARC[i]+(t3-2.*t2+t)*${ROAD.arcStep.toFixed(1)}*d0+(3.*t2-2.*t3)*ROAD_ARC[i+1]+(t3-t2)*${ROAD.arcStep.toFixed(1)}*d1;
  }
  // Where a ground point lies on the road: a across from the centre line (towards +z), s along it, t the road's direction. The
  // nearest point of the centre line is found by Gauss-Newton steps from the foot of the perpendicular to the tangent, exactly as
  // roadFoot does on the CPU, so the painted road and the graded ground cannot disagree even on a steep, curving stretch. False
  // (after one centre-line evaluation) when it cannot be on the road at all.
  bool roadFrame(vec2 p,out float a,out float s,out vec2 t){
    a=0.;s=0.;t=vec2(1.,0.);
    if(roadPresence(p)<.002)return false;
    vec2 c=roadPlanGen(p.x);
    float dz=p.y-c.x;
    if(abs(dz)>${(ROAD.reach * ROAD_NORM).toFixed(1)})return false;
    float xc=p.x+dz*c.y/(1.+c.y*c.y);
    for(int k=0;k<3;k++){c=roadPlanGen(xc);xc-=((xc-p.x)+(c.x-p.y)*c.y)/(1.+c.y*c.y);}
    c=roadPlanGen(xc);
    float r=inversesqrt(1.+c.y*c.y);
    a=((p.y-c.x)-c.y*(p.x-xc))*r;
    if(abs(a)>${ROAD.reach.toFixed(1)})return false;
    t=vec2(1.,c.y)*r;s=roadArc(xc);
    return true;
  }
  // How much of [lo,hi] a pixel [x-w,x+w] covers: exact antialiasing for thin paint.
  float roadBox(float x,float w,float lo,float hi){return clamp(min(x+w,hi)-max(x-w,lo),0.,2.*w)/(2.*w);}
  // The carriageway's edge wanders by a few centimetres, is gnawed away in stretches and has whole corners broken off. The
  // gravel shoulder runs on 0.6-1.2 m beyond it. Returns asphalt coverage.
  float roadAsphaltEdge(vec2 p,float aa,float s,float sd,float fp,out float edge,out float outer){
    float wobble=(surfaceNoise(vec2(s*.09,sd))-.5)*.3;
    float zone=smoothstep(.3,.7,surfaceNoise(vec2(s*.035,sd+5.)));
    float bite=smoothstep(.76,.92,surfaceNoise(vec2(s*.13,sd+11.)))*smoothstep(.25,.65,surfaceNoise(p*1.7+sd));
    float crumble=(surfaceNoise(p*1.7+3.)-.5)*.5*(1.-smoothstep(.4,1.4,fp))+(surfaceNoise(p*4.3)-.5)*.34*(1.-smoothstep(.2,.9,fp))+(surfaceNoise(p*9.7+4.)-.5)*.2*(1.-smoothstep(.04,.25,fp));
    edge=ROAD_HALF+wobble-bite*.7;
    outer=edge+.6+.6*surfaceNoise(vec2(s*.06,sd+23.));
    return 1.-smoothstep(-.05,.09,aa-edge+crumble*(.4+.6*zone));
  }
  // Patches of newer, darker tar: a lane's wheel path, a trench cut across the road, a blob. Irregular rectangles, none
  // bigger than their 16 m cell. Returns coverage; the bead is the sealed seam round it.
  float roadPatches(vec2 q,out float bead){
    bead=0.;
    float cell=floor(q.x/16.);
    vec2 h=patchHash(vec2(cell,5.));
    if(h.x>.6)return 0.;
    vec2 h2=patchHash(vec2(cell,19.)),h3=patchHash(vec2(cell,41.));
    float s0=(cell+.3+.4*h.y)*16.,side=h3.x<.5?-1.:1.;
    vec2 c,ext;
    if(h2.x<.4){c=vec2(s0,side*(1.4+h3.y*.4));ext=vec2(1.6+h2.y*2.8,1.15+h3.y*.35);}
    else if(h2.x<.75){c=vec2(s0,(h3.y-.5)*.8);ext=vec2(.35+h2.y*.55,3.1);}
    else{c=vec2(s0,side*(.7+h3.y*1.6));ext=vec2(.9+h2.y*.9,.7+h3.y*.5);}
    vec2 jag=vec2(surfaceNoise(q*vec2(.7,1.3)+cell)-.5,surfaceNoise(q*vec2(1.1,.9)+cell+9.)-.5)*.7;
    vec2 d2=abs(q+jag-c)-ext;float d=length(max(d2,vec2(0.)))+min(max(d2.x,d2.y),0.);
    bead=1.-smoothstep(0.,.08,abs(d));
    return 1.-smoothstep(-.03,.05,d);
  }
  // Potholes, in perhaps one 28 m stretch in two. Returns depth (1 at the middle), the crumbled rim, the bowl's slope in
  // (s,a) and whether it has water in it.
  float roadPothole(vec2 q,out float rim,out vec2 grad,out float wet){
    rim=0.;grad=vec2(0.);wet=0.;
    float cell=floor(q.x/28.);
    vec2 h=patchHash(vec2(cell,77.));
    if(h.x>.55)return 0.;
    vec2 h2=patchHash(vec2(cell,91.)),h3=patchHash(vec2(cell,113.));
    vec2 c=vec2((cell+.2+.6*h.y)*28.,(h3.x<.5?-1.:1.)*(.5+h2.x*2.4));
    float R=.2+h2.y*.3;
    vec2 d=q-c;float len=max(length(d),.001);
    float r=len*(1.+(surfaceNoise(d*3.5+cell*7.)-.5)*.9);
    float t=clamp(r/R,0.,1.);
    float depth=1.-smoothstep(0.,1.,t);
    rim=(1.-smoothstep(R,R*1.6,r))*smoothstep(R*.45,R,r);
    grad=d/len*(.07*6.*t*(1.-t)/R)*step(r,R);
    wet=step(.5,h3.y)*smoothstep(.0,.5,depth);
    return depth;
  }
  // Edges between the cells of a Voronoi diagram: alligator cracking.
  float roadCrackEdge(vec2 q){
    vec2 i=floor(q),f=fract(q);float d1=9.,d2=9.;
    for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
      vec2 g=vec2(float(x),float(y)),r=g+patchHash(i+g)-f;float d=dot(r,r);
      if(d<d1){d2=d1;d1=d;}else if(d<d2){d2=d;}
    }
    return sqrt(d2)-sqrt(d1);
  }
  // Fine cracks: crazing where the surface is worst (the wheel tracks, the edges) and the odd long crack down the road.
  float roadCracks(vec2 p,vec2 q,float aa,float wheel,float fade){
    if(fade<.01)return 0.;
    float bad=surfaceNoise(p*.55+19.)+(surfaceNoise(p*.07+vec2(14.,3.))-.5)*.9+wheel*.3+smoothstep(2.3,3.,aa)*.25;
    // The cell walls are bent by noise, so the cracks wander instead of running in straight hexagons, and only parts of them show.
    vec2 bend=vec2(surfaceNoise(p*3.3),surfaceNoise(p*3.3+17.))-.5;
    float wall=roadCrackEdge(p*1.6+bend*.7);
    float crazing=(1.-smoothstep(0.,.03+.035*surfaceNoise(p*5.+2.),wall))*smoothstep(.62,.82,bad)*smoothstep(.3,.62,surfaceNoise(p*2.1+5.));
    float seg=floor(q.x/21.);vec2 h=patchHash(vec2(seg,3.));
    float a0=(h.x-.5)*5.2,wob=(surfaceNoise(vec2(q.x*.35,seg))-.5)*.6;
    float lengthwise=(1.-smoothstep(.006,.022,abs(q.y-a0-wob)))*smoothstep(.0,.2,surfaceNoise(vec2(q.x*.07,seg+5.))-.35)*step(.4,h.y);
    return max(crazing,lengthwise)*fade;
  }
  `;

  // Early, where the plain ground gets its road weight. `road` is everything of the road (carriageway, shoulder and the
  // band where the verge takes over) and is what the forest-floor layers step back from.
  const mask = `
      vec2 pdx=dFdx(p),pdy=dFdy(p);float fp=max(length(pdx),length(pdy));
      // Road gravel is crushed stone: the stream's pebbles, at a little under half their size.
      TexturePatch roadGravelPatch=groundTexturePatch(groundUv/.9+vec2(5.,3.));
      float roadA,roadS;vec2 roadT;
      bool roadHere=roadFrame(p,roadA,roadS,roadT);
      float roadAbs=abs(roadA),roadSide=roadA<0.?13.:41.,roadEdge=ROAD_HALF,roadOuter=ROAD_HALF+.9,roadAsphalt=0.,road=0.,onDeck=0.;
      float roadRoughAdd=0.;vec2 roadSlope=vec2(0.);
      if(roadHere){
        // The deck is a prop above the stream: the ground below it is not road, so no asphalt, paint or verge is drawn there.
        float underBridge=(1.-smoothstep(26.,34.,abs(p.x-BRIDGE_X)))*smoothstep(1.,2.6,BRIDGE_LEVEL-vGroundPosition.y);
        float presence=roadPresence(p)*(1.-underBridge);
        roadAsphalt=roadAsphaltEdge(p,roadAbs,roadS,roadSide,fp,roadEdge,roadOuter)*presence;
        float verge=1.-smoothstep(roadOuter-.5,roadOuter+.35,roadAbs+(surfaceNoise(p*1.6)-.5)*.5);
        road=max(verge*presence,roadAsphalt);
        // The strip drawn over the bridge deck (terrain.ts) is concrete under grit to its kerbs: no forest floor, no grass.
        onDeck=(1.-smoothstep(BRIDGE_HALF-.4,BRIDGE_HALF+.6,abs(p.x-BRIDGE_X)))*smoothstep(BRIDGE_LEVEL-.4,BRIDGE_LEVEL-.1,vGroundPosition.y);
        road=max(road,onDeck);
      }
      float bank=bedWeight(vGroundPosition);`;

  // Everything the road adds to the colour; `groundColor`, `leafColor`, `dirt` and `trod` are the forest floor beside it.
  const colour = `
      if(road>.001){
        vec2 q=vec2(roadS,roadA),roadN=vec2(-roadT.y,roadT.x);
        float fpA=abs(dot(pdx,roadN))+abs(dot(pdy,roadN)),fpS=abs(dot(pdx,roadT))+abs(dot(pdy,roadT));
        float fade=1.-smoothstep(.03,.2,fp);
        float tone=surfaceNoise(p*.05+71.)*.5+surfaceNoise(p*.23+13.)*.3+surfaceNoise(p*1.1)*.2;
        vec3 pebbles=samplePatch(uBedMap,roadGravelPatch).rgb*vec3(.98,.94,.86)*mix(.72,1.05,surfaceNoise(p*.9+36.));
        // Crushed gravel and dust, not cobbles: the pebbles are taken well down and mixed with the soil's own colour.
        vec3 gravel=mix(pebbles*.58,leafColor*vec3(.78,.7,.58)*.8,.38)*mix(.78,1.1,tone);
        // The shoulder: gravel, and the forest floor creeping back over it a little more with every centimetre.
        vec3 verge=mix(groundColor,leafColor*vec3(.68,.63,.52),.28);
        float creep=smoothstep(roadEdge+.05,roadOuter+.25,roadAbs+(surfaceNoise(p*1.9)-.5)*1.1)*(.35+.65*smoothstep(.25,.75,surfaceNoise(p*.8+23.)));
        creep=max(creep,smoothstep(.55,.72,surfaceNoise(p*2.6+31.))*smoothstep(roadEdge-.1,roadEdge+.5,roadAbs)*.8);
        // On the deck the shoulder is the road's grit and dust gathered against the kerb, a few dead leaves in it.
        creep*=1.-onDeck;verge=mix(verge,mix(gravel*.85,leafColor*vec3(.62,.57,.46),.25),onDeck);
        vec3 roadSurface=mix(gravel,verge,clamp(creep*.9+.06,0.,1.));
        if(roadAsphalt>.001){
          // Old asphalt: dark, the scanned aggregate showing as pale stones and shadowed binder.
          float grain=dot(samplePatch(uRoadMap,roadPatch).rgb,vec3(.3,.59,.11));
          // Each stretch, and each lane of it, has weathered differently: some bleached grey, some still blackish.
          float age=.78+.5*surfaceNoise(vec2(roadS*.011,7.))+.2*surfaceNoise(vec2(roadS*.045,roadSide))-.1;
          vec3 asphalt=vec3(.072,.074,.079)*(.62+.75*tone)*(.5+grain*3.4)*age;
          float traffic=.55+.45*surfaceNoise(vec2(roadS*.021,3.));
          float wheelD=min(abs(roadAbs-.75),abs(roadAbs-2.3));
          float wheel=exp(-wheelD*wheelD/.08)*traffic;
          float oilD=(roadAbs-1.52)/.3;
          float oil=exp(-oilD*oilD)*smoothstep(.42,.78,surfaceNoise(vec2(roadS*.8,roadAbs*2.7)+5.))*(.55+.45*traffic);
          float wetP=smoothstep(.64,.8,surfaceNoise(p*.34+vec2(5.,17.)));
          float bead;float tar=roadPatches(q,bead);
          vec2 holeSlope;float rim,wetHole;float hole=roadPothole(q,rim,holeSlope,wetHole);
          float crack=roadCracks(p,q,roadAbs,wheel,fade)*(1.-tar*.9)*(1.-smoothstep(.1,.6,hole));
          asphalt*=1.+wheel*(1.-tar)*.7;
          asphalt=mix(asphalt,asphalt*vec3(.4,.4,.43),oil*(1.-tar));
          asphalt*=1.-wetP*.4;
          asphalt=mix(asphalt,vec3(.045,.046,.05)*(.75+grain*1.5)*(.85+.3*tone),tar*.85);
          asphalt*=1.-crack*.7;
          asphalt*=1.-bead*.4*fade;
          // Sun-bleached dust and loose stone along the edge; leaves and moss collect against it.
          float band=smoothstep(roadEdge-.8,roadEdge,roadAbs);
          asphalt=mix(asphalt,gravel*.75,band*.35*smoothstep(.3,.7,surfaceNoise(p*3.1+9.)));
          // Stones washed and kicked out over the edge.
          float scatter=smoothstep(roadEdge-.7,roadEdge+.1,roadAbs)*step(.62,surfaceNoise(p*9.+vec2(2.,14.)))*(1.-tar)*fade;
          asphalt=mix(asphalt,gravel*mix(.7,1.3,surfaceNoise(p*23.)),scatter);
          float litter=smoothstep(.35,.7,surfaceNoise(p*1.25+vec2(41.,7.)))*(.4+.6*surfaceNoise(p*3.7));
          asphalt=mix(asphalt,mix(leafColor*vec3(.62,.57,.46),gravel,.3),band*litter*.85*(1.-tar));
          float moss=smoothstep(.55,.8,surfaceNoise(p*.9+vec2(3.,60.)))*band;
          asphalt=mix(asphalt,vec3(.035,.055,.02)*(.7+tone*.6),moss*.7);
          // Mud walked and driven on from a trail that meets the road.
          asphalt=mix(asphalt,dirt*.85,trod*(.2+.35*surfaceNoise(p*2.1))*(1.-tar));
          // Potholes: dark and ragged, a crumbled rim, some holding water.
          vec3 holeColour=mix(vec3(.028,.024,.02),dirt*.42,.3+.7*surfaceNoise(p*9.))*(.7+.6*surfaceNoise(p*29.));
          asphalt=mix(asphalt,gravel*.7*(.8+.4*surfaceNoise(p*17.)),rim*.5);
          asphalt=mix(asphalt,holeColour*mix(1.,.45,wetHole),smoothstep(.04,.4,hole));
          // Paint: a dashed centre line (3 m of every 9) and a thin edge line that survives only in fragments, both worn,
          // flaking and gone in places.
          float u=roadS+2.7,dashCell=floor(u/9.);
          // Ragged ends: the paint has flaked back from them by a different amount every time.
          float dashPhase=u-dashCell*9.+(surfaceNoise(vec2(roadS*2.7,dashCell*5.))-.5)*.5*(1.-smoothstep(.1,.6,fpS));
          float wS=max(fpS*.5,.015),wA=max(fpA*.5,.012);
          float chip=smoothstep(.25,.62,surfaceNoise(vec2(roadS*2.3,roadA*8.)+dashCell*3.1));
          float fineChip=mix(1.,.55+.45*surfaceNoise(p*31.),1.-smoothstep(.01,.06,fp));
          float dashes=roadBox(dashPhase,wS,0.,3.);
          dashes=mix(dashes,3./9.,smoothstep(1.2,3.,fpS))*roadBox(roadAbs,wA,-.06,.06);
          float flake=mix(1.,smoothstep(.2,.65,surfaceNoise(vec2(roadS*5.3,roadA*23.)+dashCell*1.7)),1.-smoothstep(.1,.5,fpS));
          float centreLine=dashes*mix(.3,.85,patchHash(vec2(dashCell,31.)).x)*smoothstep(.16,.4,surfaceNoise(vec2(roadS*.028,17.)))*mix(.25,1.,chip)*mix(.4,1.,flake)*fineChip;
          float edgeFragments=smoothstep(.6,.76,surfaceNoise(vec2(roadS*.24,roadSide)))*smoothstep(.3,.68,surfaceNoise(vec2(roadS*2.6,roadSide+3.)+roadAbs*6.));
          float edgeLine=roadBox(abs(roadAbs-2.8),wA,-.05,.05)*edgeFragments*.6*fineChip;
          float paint=max(centreLine,edgeLine)*(1.-tar*.9)*(1.-smoothstep(.05,.3,hole))*(1.-wheel*.35)*(1.-scatter)*smoothstep(.5,.95,roadAsphalt);
          asphalt=mix(asphalt,vec3(.46,.45,.39)*(.8+.35*grain),paint);
          roadRoughAdd=-wheel*.12*(1.-tar)-tar*.3-oil*.3*(1.-tar)-wetP*.5-wetHole*.6+crack*.1-paint*.05+smoothstep(.1,.5,hole)*.2;
          // The bowl of a pothole leans the light.
          roadSlope=(holeSlope.x*roadT+holeSlope.y*roadN)*step(.01,hole);
          roadSurface=mix(roadSurface,asphalt,roadAsphalt);
        }
        groundColor=mix(groundColor,roadSurface,road);
      }`;

  const roughness = `
      if(road>.001){
        float asphaltRough=clamp(samplePatch(uRoadNormal,roadPatch).a*.82+.12+roadRoughAdd,.15,1.);
        float shoulderRough=samplePatch(uBedNormal,roadGravelPatch).a*.72+.14;
        roughnessFactor=mix(roughnessFactor,mix(shoulderRough,asphaltRough,roadAsphalt),road);
      }`;

  const normal = `
      if(road>.001){
        vec3 n=samplePatchNormal(uRoadNormal,roadPatch);n.xy*=.62;
        vec3 g=samplePatchNormal(uBedNormal,roadGravelPatch);g.xy*=.65;
        vec3 roadDetail=mix(g,n,roadAsphalt);
        roadDetail.xy+=vec2(-roadSlope.x,roadSlope.y);
        detailNormal=mix(detailNormal,normalize(roadDetail),road);
      }`;

  return { functions, mask, colour, roughness, normal };
}
