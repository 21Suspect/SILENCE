import type {SolidCollider} from './collision';
import {createSurfaceClimb} from './surface-climb';

type Point={x:number;y:number;z:number};
type Query={nearby:(x:number,z:number,radius?:number)=>SolidCollider[]};
const walkableTags=new Set(['rock','river stone','fallen log','twig','stump','bridge timber','boundary stone','cabin floor','chapel floor','hut floor','step']);
/** Clearance to the actual horizontal capsule/box footprint, in metres. */
export function obstacleClearance(c:SolidCollider,x:number,z:number){
  if(c.kind==='capsule'){
    const vx=c.bx-c.ax,vz=c.bz-c.az,l=vx*vx+vz*vz,t=l>0?Math.max(0,Math.min(1,((x-c.ax)*vx+(z-c.az)*vz)/l)):0;
    return Math.hypot(x-c.ax-vx*t,z-c.az-vz*t)-c.radius;
  }
  const co=Math.cos(c.yaw),si=Math.sin(c.yaw),dx=x-c.x,dz=z-c.z,lx=Math.abs(dx*co-dz*si)-c.halfX,lz=Math.abs(dx*si+dz*co)-c.halfZ;
  return Math.hypot(Math.max(0,lx),Math.max(0,lz))+Math.min(0,Math.max(lx,lz));
}
const ignored=(c:SolidCollider)=>c.tag?.startsWith('creature');
/** Where a collider can be at all: x0, x1, z0, z1 (a box is taken at its widest turn). Anything outside this, whatever its margin, is clear of it. */
const boundsOf=(c:SolidCollider):[number,number,number,number]=>{
  if(c.kind==='capsule')return[Math.min(c.ax,c.bx)-c.radius,Math.max(c.ax,c.bx)+c.radius,Math.min(c.az,c.bz)-c.radius,Math.max(c.az,c.bz)+c.radius];
  const co=Math.abs(Math.cos(c.yaw)),si=Math.abs(Math.sin(c.yaw)),ex=co*c.halfX+si*c.halfZ,ez=si*c.halfX+co*c.halfZ;
  return[c.x-ex,c.x+ex,c.z-ez,c.z+ez];
};
const near=(b:[number,number,number,number],x:number,z:number,r:number)=>x>=b[0]-r&&x<=b[1]+r&&z>=b[2]-r&&z<=b[3]+r;
export function creatureCanClimb(c:SolidCollider,heightAt:(x:number,z:number)=>number){
  const x=c.kind==='capsule'?(c.ax+c.bx)*.5:c.x,z=c.kind==='capsule'?(c.az+c.bz)*.5:c.z;
  return walkableTags.has(c.tag??'')&&(!!c.surfaceHeight||c.maxY-heightAt(x,z)<2.5);
}
/** One spatial query serves body planning and the rig's contacts. Navigation is only
 * active during an encounter; static geometry is never rebuilt for the agent. */
export function createCreatureNavigation(heightAt:(x:number,z:number)=>number,world:Query={nearby:()=>[]},waterSurfaceAt?:(x:number,z:number)=>number|undefined,bodyScale=1){
  const radius=2.6*bodyScale,hardRadius=.85*bodyScale;
  /** m/s squared: how fast a body that has lost its route eases down when nothing slower was asked for. */
  const COAST_BRAKE=9,COAST_BRAKE_MAX=45,COAST_LOOK=7,APPROACH_BRAKE=8,ROUTE_END_REPLAN=4;
  const MAX_ROUTE_ITERATIONS=900;
  let climb:ReturnType<typeof createSurfaceClimb>,climbCooldown=0;
  let solids:SolidCollider[]=[],blockers:SolidCollider[]=[],supports:SolidCollider[]=[],layers:SolidCollider[]=[],cacheX=Infinity,cacheZ=Infinity,cacheAge=1;
  // Each list's bounds, so the many questions asked of them (a route search asks thousands) only look at what is near the point.
  let blockerBounds:[number,number,number,number][]=[],supportBounds:[number,number,number,number][]=[],layerBounds:[number,number,number,number][]=[];
  let route:{x:number;z:number}[]=[],goal={x:0,z:0},lastHeading={x:0,z:0},replanIn=0,replans=0,lastBlocked=false,routeRadius=radius;
  let travelSpeed=0,heading=0,headingReady=false,angularVelocity=0,lastDesiredSpeed=0,referenceY:number|undefined;
  // Footholds that could not be found, by where they were asked for, for a moment: a foot with nowhere to go is asked
  // about every frame, and each failed search tries nearly a hundred places against every obstacle near.
  let clock=0;const failed=new Map<string,number>();
  const baseSurfaceAt=(x:number,z:number)=>Math.max(heightAt(x,z),waterSurfaceAt?.(x,z)??-Infinity);
  function refresh(x:number,z:number,dt=0,force=false){
    clock+=dt;cacheAge+=dt;if(!force&&cacheAge<.3&&Math.hypot(x-cacheX,z-cacheZ)<2)return;
    cacheX=x;cacheZ=z;cacheAge=0;solids=world.nearby(x,z,27).filter(c=>!ignored(c));layers=solids.filter(c=>c.tag==='bridge deck'||c.tag==='bridge timber'||c.tag==='climb roof');const layered=new Set(layers);supports=solids.filter(c=>!layered.has(c)&&creatureCanClimb(c,heightAt));const climbable=new Set(supports);blockers=solids.filter(c=>!climbable.has(c)&&!layered.has(c));
    blockerBounds=blockers.map(boundsOf);supportBounds=supports.map(boundsOf);layerBounds=layers.map(boundsOf);
  }
  function clear(x:number,z:number,r=radius){
    for(let i=0;i<blockers.length;i++)if(near(blockerBounds[i],x,z,r)&&obstacleClearance(blockers[i],x,z)<r)return false;
    let floor:number|undefined;
    for(let i=0;i<layers.length;i++){
      if(!near(layerBounds[i],x,z,r))continue;
      const c=layers[i];floor??=supportAt(x,z);
      if(c.maxY>floor+.18&&c.minY<floor+2.8&&obstacleClearance(c,x,z)<r)return false;
    }
    return true;
  }
  function segmentClear(ax:number,az:number,bx:number,bz:number,r=radius){
    const steps=Math.max(1,Math.ceil(Math.hypot(bx-ax,bz-az)/.35));
    for(let i=0;i<=steps;i++)if(!clear(ax+(bx-ax)*i/steps,az+(bz-az)*i/steps,r))return false;return true;
  }
  function supportAt(x:number,z:number,includeLayers=true){
    let y=baseSurfaceAt(x,z);
    for(let i=0;i<supports.length;i++){
      const c=supports[i];if(!near(supportBounds[i],x,z,.035))continue;
      if(obstacleClearance(c,x,z)>.035||c.maxY<=y)continue;
      // Geometry supplies a top intersection, avoiding an invisible flat rock lid.
      const exact=c.surfaceHeight?.(x,z);
      if(c.surfaceHeight){if(exact!==undefined)y=Math.max(y,exact);}
      else if(c.kind==='capsule'&&(c.tag==='rock'||c.tag==='river stone')){
        const d=Math.max(0,obstacleClearance(c,x,z)+c.radius)/c.radius;
        y=Math.max(y,(c.minY+c.maxY)*.5+(c.maxY-c.minY)*.5*Math.sqrt(Math.max(0,1-d*d)));
      }else y=Math.max(y,c.maxY);
    }
    // Bridge decks are reachable layers, not terrain. A creature approaching
    // beneath follows the water/ground; one already on a ramp can stay on top.
    const from=referenceY??baseSurfaceAt(x,z);
    for(let i=0;includeLayers&&i<layers.length;i++){
      const c=layers[i];if(!near(layerBounds[i],x,z,.02))continue;
      if(obstacleClearance(c,x,z)>.02||c.maxY<=y)continue;
      const top=c.surfaceHeight?c.surfaceHeight(x,z):c.maxY;
      if(top!==undefined&&top<=from+.65&&top>y)y=top;
    }
    return y;
  }
  function ceilingAt(x:number,z:number,reach=2.6){
    const floor=supportAt(x,z);let ceiling=Infinity;
    for(const c of layers)if(c.minY>floor+2.7&&obstacleClearance(c,x,z)<reach)ceiling=Math.min(ceiling,c.minY);
    return ceiling;
  }
  function findFoot(x:number,z:number,rootX:number,rootZ:number,fromX?:number,fromZ?:number){
    const key=`${Math.round(x*5)},${Math.round(z*5)},${Math.round(rootX*5)},${Math.round(rootZ*5)},${fromX===undefined?'':Math.round(fromX*5)},${fromZ===undefined?'':Math.round(fromZ*5)},${referenceY===undefined?'':Math.round(referenceY*5)}`;
    if((failed.get(key)??-Infinity)>clock)return fromX!==undefined&&fromZ!==undefined?{x:fromX,y:supportAt(fromX,fromZ)+.035,z:fromZ}:{x,y:supportAt(x,z)+.035,z};
    const found=searchFoot(x,z,rootX,rootZ,fromX,fromZ);
    if(found.failed){if(failed.size>512)failed.clear();failed.set(key,clock+.3);}
    return found.foot;
  }
  function searchFoot(x:number,z:number,rootX:number,rootZ:number,fromX?:number,fromZ?:number):{foot:Point;failed?:boolean}{
    const ok=(p:Point)=>({foot:p});
    const reachable=(tx:number,tz:number)=>clear(tx,tz,.22)&&(referenceY===undefined||supportAt(tx,tz)>=referenceY-1.35)&&segmentClear(rootX,rootZ,tx,tz,.20)&&(fromX===undefined||fromZ===undefined||segmentClear(fromX,fromZ,tx,tz,.18));
    if(reachable(x,z))return ok({x,y:supportAt(x,z)+.035,z});
    // Fold a foot toward the body before reaching around the tree; the target
    // stays fixed after lift-off, so there is no last-moment sliding correction.
    for(let ring=1;ring<=8;ring++)for(let i=0;i<12;i++){
      const angle=Math.atan2(rootZ-z,rootX-x)+(i%2?-1:1)*Math.ceil(i/2)*Math.PI/6,r=ring*.16;
      const tx=x+Math.cos(angle)*r,tz=z+Math.sin(angle)*r;
      if(reachable(tx,tz))return ok({x:tx,y:supportAt(tx,tz)+.035,z:tz});
    }
    // A foot left far behind (the body outran it, or it is still against bark) gets no toe route: that search is for
    // a step round one trunk, and over a long stride it would weigh every obstacle on the way, every frame.
    if(fromX!==undefined&&fromZ!==undefined&&Math.hypot(x-fromX,z-fromZ)<5.5){
      // Route a toe around a trunk when a turn put the desired foothold on the
      // other side. A short intermediate step is preferable to dragging a leg.
      let best:{x:number;z:number}|undefined,bestScore=Infinity;
      for(const obstacle of blockers){
        if(obstacleClearance(obstacle,(fromX+x)*.5,(fromZ+z)*.5)>Math.hypot(x-fromX,z-fromZ)*.6+1)continue;
        const cx=obstacle.kind==='capsule'?(obstacle.ax+obstacle.bx)*.5:obstacle.x,cz=obstacle.kind==='capsule'?(obstacle.az+obstacle.bz)*.5:obstacle.z;
        const r=obstacle.kind==='capsule'?obstacle.radius+Math.hypot(obstacle.ax-obstacle.bx,obstacle.az-obstacle.bz)*.5+.32:Math.hypot(obstacle.halfX,obstacle.halfZ)+.32;
        for(let i=0;i<24;i++){
          const tx=cx+Math.cos(i*Math.PI/12)*r,tz=cz+Math.sin(i*Math.PI/12)*r;
          if(!clear(tx,tz,.22)||!segmentClear(rootX,rootZ,tx,tz,.20)||!segmentClear(fromX,fromZ,tx,tz,.2))continue;
          const reachGoal=segmentClear(tx,tz,x,z,.2),score=Math.hypot(tx-fromX,tz-fromZ)+Math.hypot(tx-x,tz-z)+(reachGoal?0:3);
          if(Math.hypot(tx-fromX,tz-fromZ)>.12&&score<bestScore){best={x:tx,z:tz};bestScore=score;}
        }
      }
      if(best)return ok({x:best.x,y:supportAt(best.x,best.z)+.035,z:best.z});
    }
    if(fromX!==undefined&&fromZ!==undefined)return{foot:{x:fromX,y:supportAt(fromX,fromZ)+.035,z:fromZ},failed:true};
    return{foot:{x,y:supportAt(x,z)+.035,z},failed:true};
  }
  function roundRoute(start:{x:number;z:number},nodes:{x:number;z:number}[],clearance:number){
    const result:{x:number;z:number}[]=[];
    const append=(p:{x:number;z:number})=>{const last=result[result.length-1];if(!last||Math.hypot(last.x-p.x,last.z-p.z)>.015)result.push(p);};
    for(let i=0;i<nodes.length;i++){
      const a=i?nodes[i-1]:start,b=nodes[i],c=nodes[i+1];
      if(!c){append(b);continue;}
      const inLength=Math.hypot(b.x-a.x,b.z-a.z),outLength=Math.hypot(c.x-b.x,c.z-b.z);
      if(inLength<.1||outLength<.1){append(b);continue;}
      const ix=(b.x-a.x)/inLength,iz=(b.z-a.z)/inLength,ox=(c.x-b.x)/outLength,oz=(c.z-b.z)/outLength;
      if(ix*ox+iz*oz>.996){append(b);continue;}
      let cut=Math.min(2.8,inLength*.38,outLength*.38),curve:{x:number;z:number}[]|undefined;
      // Round only where the full arc has physical clearance. Cutting across
      // an inner trunk corner is forbidden, even if the centreline looks smooth.
      for(let attempt=0;attempt<6&&cut>.09;attempt++,cut*=.56){
        const p={x:b.x-ix*cut,z:b.z-iz*cut},q={x:b.x+ox*cut,z:b.z+oz*cut},samples=Math.max(6,Math.ceil(cut*9)),points=[p];let valid=true;
        for(let j=1;j<=samples;j++){const t=j/samples,u=1-t;const point={x:u*u*p.x+2*u*t*b.x+t*t*q.x,z:u*u*p.z+2*u*t*b.z+t*t*q.z};const prev=points[points.length-1];if(!segmentClear(prev.x,prev.z,point.x,point.z,Math.max(hardRadius+.04,clearance-.24))){valid=false;break;}points.push(point);}
        if(valid){curve=points;break;}
      }
      if(curve)for(const point of curve)append(point);else append(b);
    }
    return result;
  }
  // Exact gap centres supplement the grid: a narrow passage can fall between
  // grid samples. Edges still sweep the entire body; no trunk is ignored.
  function gapRoute(x:number,z:number,clearance:number){
    const trees=blockers.filter(c=>c.kind==='capsule'&&c.tag==='tree');
    const nodes=[{x,z},goal],seen=new Set<string>();
    for(let i=0;i<trees.length;i++)for(let j=i+1;j<trees.length;j++){
      const a=trees[i],b=trees[j];if(a.kind!=='capsule'||b.kind!=='capsule')continue;
      const dx=b.ax-a.ax,dz=b.az-a.az,d=Math.hypot(dx,dz),gap=d-a.radius-b.radius;
      if(gap<clearance*2+.02||gap>7)continue;
      const t=(a.radius+gap*.5)/d,p={x:a.ax+dx*t,z:a.az+dz*t};
      const key=`${Math.round(p.x*10)},${Math.round(p.z*10)}`;
      if(!seen.has(key)&&Math.hypot(p.x-x,p.z-z)<23&&clear(p.x,p.z,clearance)){seen.add(key);nodes.push(p);}
    }
    const candidates=nodes.slice(2).sort((a,b)=>Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z)).slice(0,180);
    nodes.splice(2,nodes.length-2,...candidates);
    const cost=nodes.map(()=>Infinity),prev=nodes.map(()=>-1),closed=new Set<number>();cost[0]=0;let best=0,bestH=17;
    for(let iteration=0;iteration<nodes.length;iteration++){
      let at=-1,score=Infinity;for(let i=0;i<nodes.length;i++){const f=cost[i]+Math.hypot(nodes[i].x-goal.x,nodes[i].z-goal.z);if(!closed.has(i)&&f<score){score=f;at=i;}}
      if(at<0)break;closed.add(at);const a=nodes[at],h=Math.hypot(a.x-goal.x,a.z-goal.z);if(h<bestH){best=at;bestH=h;}if(at===1||h<.65)break;
      for(let i=1;i<nodes.length;i++){
        if(closed.has(i)||i===at)continue;const b=nodes[i],distance=Math.hypot(a.x-b.x,a.z-b.z);
        if(distance>8&&i!==1||!segmentClear(a.x,a.z,b.x,b.z,clearance))continue;
        if(Math.abs(baseSurfaceAt(a.x,a.z)-baseSurfaceAt(b.x,b.z))>distance*.75)continue;
        const next=cost[at]+distance;if(next<cost[i]){cost[i]=next;prev[i]=at;}
      }
    }
    const result:{x:number;z:number}[]=[];for(let i=best;i>0;i=prev[i])result.push(nodes[i]);
    return {nodes:result.reverse(),remaining:bestH};
  }
  /**
   * Plan a short local route.  This is deliberately a bounded operation: the
   * encounter update runs on the render thread and a blocked first route must
   * not recursively rebuild the same grid without a budget.  At most three
   * staged envelopes (2.6, 2.25, .95 m) are attempted; subsequent frames can
   * replan if that corridor becomes blocked.
   */
  function plan(x:number,z:number,hx:number,hz:number,clearance=radius){
    routeRadius=clearance;replans++;goal={x:x+hx*17,z:z+hz*17};lastHeading={x:hx,z:hz};replanIn=.8;
    if(segmentClear(x,z,goal.x,goal.z,clearance)){route=[goal];return;}
    // An inflated endpoint inside bark cannot be reached by any A* search.
    // Try the next stance immediately instead of exhausting thousands of nodes.
    if(clearance>1&&(!clear(x,z,clearance)||!clear(goal.x,goal.z,clearance))){plan(x,z,hx,hz,clearance>2.3?2.25:.95);return;}
    // A wall descent may finish between porch posts inside the preferred
    // planning margin. Leave using the real body envelope, then widen again.
    if(clearance<1.1&&!clear(x,z,clearance)&&clear(x,z,hardRadius+.025)){
      let escape:{x:number;z:number}|undefined,score=Infinity;
      for(let r=.4;r<=3.2;r+=.4)for(let i=0;i<24;i++){
        const angle=i*Math.PI/12,tx=x+Math.cos(angle)*r,tz=z+Math.sin(angle)*r;
        if(!clear(tx,tz,clearance)||!segmentClear(x,z,tx,tz,hardRadius+.025))continue;
        const cost=r+Math.hypot(tx-goal.x,tz-goal.z);
        if(cost<score){score=cost;escape={x:tx,z:tz};}
      }
      if(escape){routeRadius=hardRadius+.025;route=[escape];return;}
    }
    if(clearance<1.1){const gap=gapRoute(x,z,clearance);if(gap.nodes.length){route=roundRoute({x,z},gap.nodes,clearance);return;}}
    // Bounded local A*: comfortably outside the 17 m goal, with a real swept
    // clearance test on every edge (no diagonal corner cutting through trunks).
    const spacing=clearance<radius?.75:1.05,half=clearance<radius?29:21,n=half*2+1,count=n*n,start=half*n+half;
    // Keep route smoothness informed by only the nearby obstacles that can
    // influence this 17 m local plan.  The old per-node full-blocker reduction
    // was the dominant first-route cost in a streamed forest.
    const routeBlockers=blockers.map(c=>({c,d:Math.min(obstacleClearance(c,x,z),obstacleClearance(c,goal.x,goal.z))}))
      .filter(item=>item.d<22).sort((a,b)=>a.d-b.d).slice(0,32).map(item=>item.c);
    const g=new Float64Array(count);g.fill(Infinity);g[start]=0;
    const previous=new Int32Array(count);previous.fill(-1);
    const done=new Uint8Array(count),open=[start],occupancy=new Int8Array(count);occupancy.fill(-1);
    const px=(index:number)=>x+(index%n-half)*spacing,pz=(index:number)=>z+(Math.floor(index/n)-half)*spacing;
    const heuristic=(index:number)=>Math.hypot(px(index)-goal.x,pz(index)-goal.z);
    let best=start,bestH=heuristic(start),iterations=0;
    while(open.length&&iterations++<MAX_ROUTE_ITERATIONS){
      let at=0,f=Infinity;for(let i=0;i<open.length;i++){const v=g[open[i]]+heuristic(open[i])*1.04;if(v<f){f=v;at=i;}}
      const current=open[at];open[at]=open[open.length-1];open.pop();if(done[current])continue;done[current]=1;
      const h=heuristic(current);if(h<bestH){best=current;bestH=h;}if(h<1.25)break;
      const cx=current%n,cz=Math.floor(current/n);
      for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){
        if(!dx&&!dz)continue;const nx=cx+dx,nz=cz+dz;if(nx<0||nz<0||nx>=n||nz>=n)continue;
        const next=nz*n+nx;if(done[next])continue;
        if(occupancy[next]<0)occupancy[next]=clear(px(next),pz(next),clearance)?1:0;
        if(!occupancy[next]||!segmentClear(px(current),pz(current),px(next),pz(next),clearance))continue;
        const elevation=Math.abs(baseSurfaceAt(px(next),pz(next))-baseSurfaceAt(px(current),pz(current)));if(elevation>1.35)continue;
        // Occupancy and swept edge checks enforce the complete body envelope;
        // this short list adds a small cost preference for open space without
        // rescanning every streamed blocker at every node.
        const margin=clearance<1.6?routeBlockers.reduce((v,c)=>Math.min(v,obstacleClearance(c,px(next),pz(next))),4):4;
        const nextG=g[current]+Math.hypot(dx,dz)*spacing*(1+(clearance<1.6?.12/Math.max(.12,margin-clearance+.12):0))+elevation*.35;
        if(nextG<g[next]){g[next]=nextG;previous[next]=current;open.push(next);}
      }
    }
    const nodes:{x:number;z:number}[]=[];for(let at=best;at!==start&&at>=0;at=previous[at])nodes.push({x:px(at),z:pz(at)});nodes.reverse();
    // Line-of-sight string pulling makes the path a smooth corridor, not a grid walk.
    route=[];let anchor={x,z};for(let i=0;i<nodes.length;){let far=i;for(let j=i+1;j<nodes.length;j++)if(segmentClear(anchor.x,anchor.z,nodes[j].x,nodes[j].z,clearance))far=j;route.push(nodes[far]);anchor=nodes[far];i=far+1;}
    if(bestH>1.5&&clearance>1){
      // One staged fallback handles a trunk corridor while bounding worst-case
      // work to three searches instead of the old 2.6 -> 2.25 -> 1.5 -> .95
      // recursion chain.
      plan(x,z,hx,hz,clearance>2.3?2.25:.95);
    }
    else route=roundRoute({x,z},route,clearance);
  }
  return {
    refresh,
    get climbing(){return climb;},
    supportAt,
    ceilingAt,
    findFoot,
    footClearance(x:number,z:number){return blockers.reduce((min,c)=>Math.min(min,obstacleClearance(c,x,z)),Infinity);},
    limbClearance(a:Point,b:Point){
      const minX=Math.min(a.x,b.x)-.35,maxX=Math.max(a.x,b.x)+.35,minZ=Math.min(a.z,b.z)-.35,maxZ=Math.max(a.z,b.z)+.35;
      const mx=(a.x+b.x)*.5,mz=(a.z+b.z)*.5,length=Math.hypot(a.x-b.x,a.z-b.z),steps=Math.max(1,Math.ceil(length/.20));let nearest=Infinity;
      for(const c of blockers){
        const co=c.kind==='box'?Math.abs(Math.cos(c.yaw)):1,si=c.kind==='box'?Math.abs(Math.sin(c.yaw)):0;
        const cx0=c.kind==='capsule'?Math.min(c.ax,c.bx)-c.radius:c.x-(co*c.halfX+si*c.halfZ),cx1=c.kind==='capsule'?Math.max(c.ax,c.bx)+c.radius:c.x+(co*c.halfX+si*c.halfZ);
        const cz0=c.kind==='capsule'?Math.min(c.az,c.bz)-c.radius:c.z-(si*c.halfX+co*c.halfZ),cz1=c.kind==='capsule'?Math.max(c.az,c.bz)+c.radius:c.z+(si*c.halfX+co*c.halfZ);
        if(cx1<minX||cx0>maxX||cz1<minZ||cz0>maxZ)continue;
        if(obstacleClearance(c,mx,mz)>length*.5+.5||c.maxY<Math.min(a.y,b.y)||c.minY>Math.max(a.y,b.y))continue;
        for(let i=0;i<=steps;i++){const t=i/steps,y=a.y+(b.y-a.y)*t;if(y<c.minY||y>c.maxY)continue;nearest=Math.min(nearest,obstacleClearance(c,a.x+(b.x-a.x)*t,a.z+(b.z-a.z)*t));}
      }
      // Height-aware overhead clearance participates in knee selection, while
      // the same horizontal deck may be a support when approached from above.
      for(const c of layers){
        if(obstacleClearance(c,mx,mz)>length*.5+.3||c.maxY<Math.min(a.y,b.y)-.08)continue;
        for(let i=0;i<=steps;i++){const t=i/steps,x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t,y=a.y+(b.y-a.y)*t;if(obstacleClearance(c,x,z)>.10)continue;if(y<c.minY)nearest=Math.min(nearest,c.minY-y);else if(y<c.maxY)nearest=Math.min(nearest,-Math.min(y-c.minY,c.maxY-y));}
      }
      return nearest;
    },
    get stanceWidth(){return routeRadius<1.1?.40:routeRadius<1.6?.57:routeRadius<radius?.88:1;},
    get shoulderWidth(){return routeRadius<1.1?.65:routeRadius<1.6?.82:1;},
    get squeezing(){return routeRadius<1.6;},
    /** The last move ran into something and stopped dead. */
    get blocked(){return lastBlocked;},
    canEscape(x:number,z:number,hx:number,hz:number){referenceY=undefined;refresh(x,z,0,true);plan(x,z,hx,hz);const end=route[route.length-1];const ok=!!end&&Math.hypot(end.x-x,end.z-z)>7;route=[];replanIn=0;return ok;},
    replan(){route=[];replanIn=0;},
    reset(initialSpeed=0){climb=undefined;climbCooldown=0;route=[];cacheAge=1;replanIn=0;routeRadius=radius;travelSpeed=initialSpeed;angularVelocity=0;headingReady=false;referenceY=undefined;},
    safeSpawn(x:number,z:number){
      referenceY=undefined;refresh(x,z,0,true);
      // Keep spawn placement bounded.  The old 289 samples were repeated for
      // each candidate around a player, even after the full limb envelope had
      // already found a viable point.  Sixteen angular samples preserve the
      // deterministic ring search while covering the same useful radius.
      for(let ring=0;ring<13;ring++)for(let i=0;i<(ring?16:1);i++){
        const angle=i*Math.PI/8,tx=x+Math.cos(angle)*ring*.8,tz=z+Math.sin(angle)*ring*.8;
        if(clear(tx,tz,radius+.15)&&Math.abs(heightAt(tx+.5,tz)-heightAt(tx-.5,tz))<.9&&Math.abs(heightAt(tx,tz+.5)-heightAt(tx,tz-.5))<.9){route=[];return{x:tx,y:Math.max(baseSurfaceAt(tx,tz),supportAt(tx,tz)-.5),z:tz};}
      }
      return undefined;
    },
    /** `brake` (m/s²) is the least deceleration toward a lower speed; a flinch stops harder than a walk. */
    move(position:Point,hx:number,hz:number,speed:number,dt:number,brake=2.2){
      referenceY=position.y;refresh(position.x,position.z,dt);replanIn-=dt;
      const len=Math.hypot(hx,hz)||1;hx/=len;hz/=len;
      climbCooldown=Math.max(0,climbCooldown-dt);
      if(climb?.done){climb=undefined;climbCooldown=3;route=[];replanIn=0;}
      if(!climb&&climbCooldown===0&&speed>.4){
        for(const c of layers){
          if(c.tag!=='climb roof'||c.kind!=='box'||obstacleClearance(c,position.x,position.z)>4.5)continue;
          const candidate=createSurfaceClimb(c,position,hx,hz,(x,z)=>supportAt(x,z,false));
          if(candidate){
            // A tree in the approach corridor is still a solid obstruction.
            let safe=true;for(let d=0;d<4;d+=.3)for(const b of blockers)if(b.tag==='tree'&&obstacleClearance(b,position.x+hx*d,position.z+hz*d)<hardRadius)safe=false;
            if(safe){climb=candidate;route=[];break;}
          }
        }
      }
      if(climb){
        const pace=Math.min(speed,4.5);travelSpeed+=(pace-travelSpeed)*(1-Math.exp(-dt*5));
        const next=climb.advance(position,travelSpeed,dt);heading=Math.atan2(hx,hz);headingReady=true;lastBlocked=false;
        return{...next,yaw:heading,turnRate:0,speed:travelSpeed,desiredSpeed:pace};
      }
      const goalChange=hx*lastHeading.x+hz*lastHeading.z<.94;
      // A route that stops short of its goal (the way on is shut) is planned again as its end comes near, not only after it has been
      // used up: from a few metres on the planner often sees a way round.
      const shortEnd=(()=>{const e=route[route.length-1];return !!e&&Math.hypot(e.x-goal.x,e.z-goal.z)>1.5;})();
      if(speed>.001&&(goalChange||(!route.length&&replanIn<=0)||Math.hypot(goal.x-position.x,goal.z-position.z)<3||(shortEnd&&replanIn<=0&&Math.hypot(route[route.length-1].x-position.x,route[route.length-1].z-position.z)<ROUTE_END_REPLAN)))plan(position.x,position.z,hx,hz);
      while(route.length&&Math.hypot(route[0].x-position.x,route[0].z-position.z)<.035)route.shift();
      if(!headingReady){heading=Math.atan2(route[0]?route[0].x-position.x:hx,route[0]?route[0].z-position.z:hz);headingReady=true;}
      if(speed<=.001&&travelSpeed<.001){
        angularVelocity=0;lastDesiredSpeed=0;
        return{...position,y:Math.max(baseSurfaceAt(position.x,position.z),supportAt(position.x,position.z)-.48),yaw:heading,turnRate:0,speed:0,desiredSpeed:0};
      }
      // Curvature can ease the pace, but never creates a stop-and-pivot at each
      // waypoint. Acceleration is bounded independently from frame frequency.
      let remaining=.9+speed*.22,anchor={x:position.x,z:position.z},look=anchor,sharpness=0,lastAngle:number|undefined,routeLength=0;
      for(const point of route){const distance=Math.hypot(point.x-anchor.x,point.z-anchor.z);routeLength+=distance;if(distance<.001){anchor=point;continue;}const angle=Math.atan2(point.x-anchor.x,point.z-anchor.z);if(lastAngle!==undefined)sharpness+=Math.abs(Math.atan2(Math.sin(angle-lastAngle),Math.cos(angle-lastAngle)));lastAngle=angle;if(distance>=remaining){look={x:anchor.x+(point.x-anchor.x)*remaining/distance,z:anchor.z+(point.z-anchor.z)*remaining/distance};break;}remaining-=distance;look=point;anchor=point;}
      // A route that has run out (the planner found no way on: a wall of trunks, a gap too narrow) is not a wall in
      // front of the body. Moving, it coasts on along its heading and eases down: to the pace it was asked to
      // slow to (a stun's eased stop) or, with none asked, at COAST_BRAKE. It never stops dead from a run.
      const coasting=!route.length&&travelSpeed>.3;
      const curvaturePace=1/(1+sharpness*.22);
      let desiredSpeed=route.length?speed*Math.max(.68,curvaturePace):coasting&&speed<travelSpeed?speed:0;
      // Fast bursts ease through tight turns before the support feet cross under
      // the body. Straight, open ground retains the full requested pace.
      desiredSpeed=Math.min(desiredSpeed,Math.max(4.5,9/Math.max(.001,Math.abs(angularVelocity))));
      // Running up to the end of a route that stops short of its goal, it eases down to arrive at a standstill: the end of the
      // route is where the planner could take it, and it is not a place to arrive at a run.
      const endPoint=route[route.length-1];
      if(endPoint&&Math.hypot(endPoint.x-goal.x,endPoint.z-goal.z)>1.5)desiredSpeed=Math.min(desiredSpeed,Math.sqrt(2*APPROACH_BRAKE*Math.max(0,routeLength-.3)));
      // Coasting, it brakes in time for whatever is in the way: just hard enough to stop short of the bark, never a collision.
      let coastBrake=0;
      if(coasting){
        let free=COAST_LOOK;for(let d=.3;d<=COAST_LOOK;d+=.3)if(!clear(position.x+Math.sin(heading)*d,position.z+Math.cos(heading)*d,hardRadius+.08)){free=d-.3;break;}
        coastBrake=Math.max(COAST_BRAKE,Math.min(COAST_BRAKE_MAX,travelSpeed*travelSpeed/(2*Math.max(.05,free-.15))));
      }
      const acceleration=desiredSpeed>travelSpeed?Math.max(1.5,speed*1.8):Math.max(brake,speed*2.2,coastBrake);
      travelSpeed+=Math.max(-acceleration*dt,Math.min(acceleration*dt,desiredSpeed-travelSpeed));lastDesiredSpeed=desiredSpeed;
      if(coasting){look={x:position.x+Math.sin(heading)*5,z:position.z+Math.cos(heading)*5};route=[{x:position.x+Math.sin(heading)*(travelSpeed*dt+.6),z:position.z+Math.cos(heading)*(travelSpeed*dt+.6)}];}
      let budget=travelSpeed*dt,x=position.x,z=position.z,lastDX=Math.sin(heading),lastDZ=Math.cos(heading);lastBlocked=false;
      // Consume distance continuously across small arc samples. Reaching a
      // waypoint never discards the remaining motion for this frame.
      for(let iteration=0;iteration<48&&budget>1e-7&&route.length;iteration++){
        const target=route[0],dx=target.x-x,dz=target.z-z,distance=Math.hypot(dx,dz);if(distance<1e-6){route.shift();continue;}
        const step=Math.min(budget,distance,.12),nx=x+dx/distance*step,nz=z+dz/distance*step;
        if(!clear(nx,nz,hardRadius)){lastBlocked=true;route=[];replanIn=0;travelSpeed=0;break;}
        x=nx;z=nz;budget-=step;lastDX=dx/distance;lastDZ=dz/distance;if(distance<=step+1e-6)route.shift();
      }
      if(coasting)route=[];
      const futureAngle=Math.atan2(look.x-position.x,look.z-position.z),stepAngle=Math.atan2(lastDX,lastDZ),anticipation=Math.atan2(Math.sin(futureAngle-stepAngle),Math.cos(futureAngle-stepAngle));
      const desiredHeading=stepAngle+Math.max(-.32,Math.min(.32,anticipation*.65));
      const error=Math.atan2(Math.sin(desiredHeading-heading),Math.cos(desiredHeading-heading));
      const desiredAngular=Math.max(-2.4,Math.min(2.4,error*8));
      angularVelocity+=(desiredAngular-angularVelocity)*(1-Math.exp(-dt*10));
      if(Math.abs(error)<Math.abs(angularVelocity*dt)){heading=desiredHeading;angularVelocity=0;}else heading+=angularVelocity*dt;
      const ahead=Math.min(.9,travelSpeed*.25),floor=baseSurfaceAt(x,z),support=Math.max(supportAt(x,z),supportAt(x+lastDX*ahead,z+lastDZ*ahead)-.12);
      const targetY=Math.max(floor,support-.48),rise=targetY-position.y,maxRise=Math.max(1.4,travelSpeed)*dt;
      const fraction=Math.min(1,maxRise/Math.max(maxRise,Math.abs(rise)));
      x=position.x+(x-position.x)*fraction;z=position.z+(z-position.z)*fraction;
      const y=position.y+Math.max(-maxRise,Math.min(maxRise,rise)),moved=Math.hypot(x-position.x,z-position.z)/Math.max(dt,.001);
      return{x,y,z,yaw:heading,turnRate:angularVelocity,speed:moved,desiredSpeed};
    },
    inspect(){return{route:route.map(p=>({...p})),replans,blockers:blockers.length,solids:solids.length,blocked:lastBlocked,radius:routeRadius,hardRadius,travelSpeed,desiredSpeed:lastDesiredSpeed,turnRate:angularVelocity,ceiling:ceilingAt(cacheX,cacheZ),referenceY};},
  };
}
