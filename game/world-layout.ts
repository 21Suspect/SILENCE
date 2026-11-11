/**
 * Generates where everything stands, from the world seed. Deterministic and free of three.js,
 * because the terrain worker runs it too and multiplayer clients must all arrive at one world.
 *
 * Places are chosen for reasons, not scattered: the cabin near the start and beside the trail, the
 * relay on the highest ground, the logging yard off the road in thick timber, the camp by water,
 * the mine where the land climbs. Footpaths are then routed across the real slopes to each door.
 */
import { WORLD_SEED, channelOffset, sideChannelOffset, hash, noise, pathX, riverX, roadZ, rockMask, treeDensity, warped } from './world-noise';
import { landform, landSlope } from './world-landform';
import { waterHeightAt } from './world-noise';
import worldAssets from './world-assets.json';
import { lakeDistance, coastDistance, coastZ, mountainFoot } from './coastal-geography';
import { WORLD_V2 } from './world-flags';

export type PoiPad = { radius: number; falloff: number; rise?: number; fixed?: boolean };
export type PoiFootprint = { cx: number; cz: number; hx: number; hz: number };
export type GroundFit = 'tilt' | 'level' | 'run';
export type PoiPlacement = {
  id: string; asset: string; x: number; z: number; yaw: number;
  pad?: PoiPad; footprint?: PoiFootprint; entrance?: [number, number]; clearing?: number; draw?: number; fit?: GroundFit;
  scale?: number;
  /** Stands at this height, not on the ground: a bridge deck. */
  y?: number;
};
/** A patch of ground levelled for something, with no object of its own. */
export type GroundPad = { x: number; z: number; radius: number; falloff: number; level?: number };

/** Model-local to world, the same transform three.js applies for rotation.y = yaw. */
export function placeLocal(p: { x: number; z: number; yaw: number }, lx: number, lz: number): [number, number] {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return [p.x + lx * c + lz * s, p.z + lz * c - lx * s];
}
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const r = (i: number) => hash(WORLD_SEED * .0173 + i * 3.7, i * 1.3 + WORLD_SEED * .0091);
// The inhabited forest follows dry land; it no longer occupies a circular basin.
const dryLand = (x:number,z:number,margin=12) => !WORLD_V2 || (lakeDistance(x,z)>margin && coastDistance(x,z)>margin);
const buildable = (x:number,z:number,margin=18) => WORLD_V2 ? dryLand(x,z,margin) && landSlope(x,z,5)<.65 && Math.abs(x)<440 && z<410 : Math.hypot(x,z)<415;
export const SPAWN = { x: pathX(12), z: 12 };
/** The walked trail ends at the dry beach and below the mountain face. */
export const MAIN_TRAIL_BOUNDS = (() => {
  if(!WORLD_V2)return {south:-430,north:430};
  let south=-340;
  for(let i=0;i<8;i++)south=coastZ(pathX(south))+14;
  return {south,north:332};
})();
const offPath = (x: number, z: number) => Math.abs(x - pathX(z));
const offRoad = (x: number, z: number) => Math.abs(z - roadZ(x));
const offRiver = (x: number, z: number) => channelOffset(x, z);
const smoothCarve = (v: number, a: number, b: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const offMainStream = (x: number, z: number) => Math.abs(x - riverX(z)) / Math.hypot(1, (riverX(z + .6) - riverX(z - .6)) / 1.2);

/** Best-scoring buildable spot on a coarse grid. A site needs level ground and must not crowd another. */
function bestSite(score: (x: number, z: number) => number, taken: { x: number; z: number }[], apart: number, seedIndex: number) {
  let best = -Infinity, at = { x: 0, z: 0 };
  for (let attempt = 0; attempt < 3 && best === -Infinity; attempt++) {
    const spacing = apart * Math.pow(.72, attempt);
    for (let gx = -40; gx <= 40; gx++) for (let gz = -40; gz <= 40; gz++) {
      const x = gx * 11 + (hash(gx + seedIndex, gz) - .5) * 8, z = gz * 11 + (hash(gz - seedIndex, gx + 3) - .5) * 8;
      if (!buildable(x,z,26) || offRiver(x, z) < 30 || sideChannelOffset(x, z) < 42 || offRoad(x, z) < 16 || offPath(x, z) < 12) continue;
      if (taken.some(t => dist(t, { x, z }) < spacing)) continue;
      const s = score(x, z) + hash(gx * 2.1 + seedIndex, gz * 1.7) * .4;
      if (s > best) { best = s; at = { x, z }; }
    }
  }
  return at;
}
/** Nearest point on the road or main trail: the side of a place people would have approached from. */
function nearestRoute(x: number, z: number): [number, number] {
  let best = Infinity, out: [number, number] = [x, z];
  for (let d = -60; d <= 60; d += 3) {
    const pz = z + d, px = pathX(pz), rx = x + d, rz = roadZ(rx);
    const a = Math.hypot(px - x, pz - z), b = Math.hypot(rx - x, rz - z);
    if (a < best && (WORLD_V2 ? dryLand(px,pz,5) && pz>=MAIN_TRAIL_BOUNDS.south && pz<=MAIN_TRAIL_BOUNDS.north : Math.hypot(px,pz)<430)) { best = a; out = [px, pz]; }
    if (b < best) { best = b; out = [rx, rz]; }
  }
  return out;
}
/** Yaw that turns a model-local "front" direction to face a world point. */
function facing(from: { x: number; z: number }, to: [number, number], frontX: number, frontZ: number) {
  return Math.atan2(to[0] - from.x, to[1] - from.z) - Math.atan2(frontX, frontZ);
}

/**
 * Where the road goes into the mountain at each end of the valley: a tunnel mouth, shut by a rockfall. `yaw` turns the
 * portal's front (local +z) back down the road, into the valley.
 */
export const ROAD_ENDS = [1, -1].map(side => {
  let x = side * 400;
  while (!WORLD_V2 && Math.abs(x) < 520 && Math.hypot(x, roadZ(x)) < 466) x += side * .5;
  const z = roadZ(x), inX = x - side * 10;
  return { side, x, z, yaw: Math.atan2(inX - x, roadZ(inX) - z) };
});

function generate() {
  const taken: { x: number; z: number }[] = [SPAWN];
  const claim = (s: { x: number; z: number }) => { taken.push(s); return s; };
  const flat = (x: number, z: number) => 1 - Math.min(1, landSlope(x, z, 6) * 5);
  const pois: PoiPlacement[] = [];

  // Where the trail leaves the road. The notice board goes here, so the cabin must not.
  let cross = -83;
  for (let z = -140; z < -20; z += 1) if (Math.abs(z - roadZ(pathX(z))) < Math.abs(cross - roadZ(pathX(cross)))) cross = z;
  // Place on the verge using the road normal, with the board facing the road.
  const boardSide=r(5)>.5?1:-1;
  let bx=pathX(cross)+boardSide*18;
  // Following the road normal can point back into the curved trail. Keep the
  // whole board beyond the junction before choosing its final road-parallel yaw.
  for(let i=0;i<8;i++){
    const m=roadZ(bx+.5)-roadZ(bx-.5), l=Math.hypot(1,m), x=bx-m/l*7, z=roadZ(bx)+7/l;
    if(offPath(x,z)>6.5)break;
    bx+=boardSide*4;
  }
  const roadSlope = (roadZ(bx + .5) - roadZ(bx - .5));
  const roadLength = Math.hypot(1, roadSlope);
  const board = { x: bx - roadSlope / roadLength * 7, z: roadZ(bx) + 7 / roadLength };
  const boardYaw = Math.PI - Math.atan2(roadSlope, 1);
  // The cabin: the first shelter you reach, a short way off the trail, near the start.
  let cabin = { x: 0, z: 0 }, cabinScore = -Infinity;
  for (let pz = -75; pz <= 60; pz += 4) for (const side of [-1, 1]) for (const out of [13, 17, 22]) {
    const x = pathX(pz) + side * out, z = pz;
    if (!buildable(x,z,18) || offRiver(x, z) < 17 || offRoad(x, z) < 17 || Math.hypot(x - board.x, z - board.z) < 30) continue;
    const away = Math.hypot(x - SPAWN.x, z - SPAWN.z);
    const s = flat(x, z) * 2 - Math.abs(away - 42) / 40 + r(pz + 90 + side) * .5;
    if (s > cabinScore) { cabinScore = s; cabin = { x, z }; }
  }
  claim(cabin);
  const cabinPlace: PoiPlacement = { id: 'cabin', asset: 'cabin', ...cabin, yaw: facing(cabin, [pathX(cabin.z), cabin.z], 0, 1), pad: { radius: 7, falloff: 10 }, footprint: { cx: 0, cz: 1.55, hx: 4.4, hz: 4.4 }, entrance: [-.7, 6.2] };
  pois.push(cabinPlace);

  // A notice board where the trail leaves the road.
  claim(board);
  pois.push({ id: 'trailhead-board', asset: 'noticeboard', ...board, yaw: boardYaw, pad: { radius: 2.2, falloff: 4 }, footprint: { cx: 0, cz: 0, hx: 1.5, hz: .35 }, entrance: [0, 1.5] });

  // The relay stands on the highest ground within a long walk of the road.
  const relay = claim(bestSite((x, z) => {
    const away = Math.hypot(x - SPAWN.x, z - SPAWN.z);
    return away < 120 || away > 340 || (WORLD_V2&&z>285) ? -99 : landform(x, z) * .2 - landSlope(x, z, 8) - Math.max(0, offRoad(x, z) - 90) * .01;
  }, taken, 150, 11));
  const toRelay = nearestRoute(relay.x, relay.z);
  const relayYaw = facing(relay, toRelay, .39, .92) + .4;
  const relayPart = (dx: number, dz: number): [number, number] => placeLocal({ ...relay, yaw: relayYaw - .4 }, dx, dz);
  const [hx, hz] = relayPart(10, -6), [gx, gz] = relayPart(8.5, -1);
  pois.push({ id: 'relay-mast', asset: 'mast', ...relay, yaw: relayYaw, pad: { radius: 17, falloff: 26 }, footprint: { cx: 0, cz: 0, hx: 1.7, hz: 1.7 }, clearing: 17, draw: 420 });
  pois.push({ id: 'relay-hut', asset: 'hut', x: hx, z: hz, yaw: relayYaw, footprint: { cx: 0, cz: .35, hx: 2.5, hz: 2.2 }, entrance: [-.9, 3.4] });
  pois.push({ id: 'relay-generator', asset: 'generator', x: gx, z: gz, yaw: relayYaw + 1.2, footprint: { cx: 0, cz: 0, hx: 1.15, hz: .55 } });

  // The fire tower commands the far bank.
  const lookout = claim(bestSite((x, z) => {
    const away = Math.hypot(x - SPAWN.x, z - SPAWN.z);
    return x < riverX(z) + 20 || away < 130 || away > 360 ? -99 : landform(x, z) * .22 - landSlope(x, z, 8);
  }, taken, 170, 23));
  pois.push({ id: 'lookout', asset: 'lookout', ...lookout, yaw: facing(lookout, nearestRoute(lookout.x, lookout.z), -.12, -.99), pad: { radius: 7, falloff: 20, rise: 3 }, footprint: { cx: 0, cz: 0, hx: 2.8, hz: 2.8 }, entrance: [-.48, -5.4], clearing: 15, draw: 420 });

  // Logging needed a truck: just off the road, on level ground, in thick timber.
  const yard = claim(bestSite((x, z) => {
    const d = offRoad(x, z), away = Math.hypot(x - SPAWN.x, z - SPAWN.z);
    return d < 26 || d > 58 || away < 80 ? -99 : flat(x, z) * 2 + treeDensity(x, z);
  }, taken, 120, 37));
  pois.push({ id: 'logging-camp', asset: 'logstack', ...yard, yaw: facing(yard, nearestRoute(yard.x, yard.z), 0, 1), pad: { radius: 16, falloff: 18, fixed:true }, footprint: { cx: 0, cz: 0, hx: 10.2, hz: 10.6 }, entrance: [-.2, 11.4] });

  // Hunters camp near water, away from the road.
  const camp = claim(bestSite((x, z) => {
    const w = offRiver(x, z);
    return w < 30 || w > 58 || offRoad(x, z) < 70 ? -99 : flat(x, z) * 2 - treeDensity(x, z) * .5;
  }, taken, 130, 53));
  pois.push({ id: 'hunter-camp', asset: 'camp', ...camp, yaw: facing(camp, [riverX(camp.z), camp.z], -.45, .89), pad: { radius: 6.5, falloff: 10 }, footprint: { cx: -.3, cz: -.6, hx: 4.5, hz: 3.9 }, entrance: [-1.9, 6.4] });

  // The chapel served whoever lived along the road: a clearing some way back from it.
  const chapel = claim(bestSite((x, z) => {
    const d = offRoad(x, z), away = Math.hypot(x - SPAWN.x, z - SPAWN.z);
    return d < 28 || d > 80 || away < 150 ? -99 : flat(x, z) * 2 - treeDensity(x, z) * .4;
  }, taken, 170, 67));
  pois.push({ id: 'chapel', asset: 'chapel', ...chapel, yaw: facing(chapel, nearestRoute(chapel.x, chapel.z), 0, 1), pad: { radius: 17, falloff: 12 }, footprint: { cx: -4.8, cz: 0, hx: 8.2, hz: 7.2 }, entrance: [0, 7.2] });

  // The mine goes where the land climbs, its mouth looking back down the slope.
  const mountainMine=()=>{
    let best=-Infinity,site={x:-210,z:385};
    for(let x=-310;x<=-80;x+=7)for(let z=340;z<=435;z+=7){
      const h=landform(x,z),slope=landSlope(x,z,14);
      if(coastDistance(x,z)<110||offRiver(x,z)<35||offRoad(x,z)<70||h<22||h>65||slope>1.35||taken.some(p=>dist(p,{x,z})<60))continue;
      const score=-Math.abs(h-32)*.06-Math.abs(slope-.5)*3;
      if(score>best){best=score;site={x,z};}
    }
    return site;
  };
  const mine = claim(WORLD_V2?mountainMine():bestSite((x,z)=>{
    const away=Math.hypot(x,z);
    return away<190||away>400||offPath(x,z)<62?-99:Math.min(landSlope(x,z,14)*6,1.6)+landform(x,z)*.05;
  },taken,150,79));
  const up = [landform(mine.x + 12, mine.z) - landform(mine.x - 12, mine.z), landform(mine.x, mine.z + 12) - landform(mine.x, mine.z - 12)];
  const mineYaw = Math.atan2(-up[0], -up[1]);
  const mineSite = { ...mine, yaw: mineYaw };
  pois.push({ id: 'mine', asset: 'mine', ...mineSite, pad: { radius: 15, falloff: 32, fixed:true, rise: WORLD_V2 ? -Math.max(0,Math.min(12,landform(mine.x,mine.z)-landform(mine.x+Math.sin(mineYaw)*18,mine.z+Math.cos(mineYaw)*18))) : 0 }, footprint: { cx: 0, cz: .5, hx: 2.3, hz: 8.0 }, entrance: [0, 9.6] });
  pois.push({ id: 'mine-rock', asset: 'minerock', ...mineSite, clearing: 20 });

  // ---- The second generation of places. Every route now ends at something, and the empty quarters have a reason
  // to be walked into. Each is sited on ground that is already nearly level, so little has to be flattened for it.
  /** The flattest spot beside the trail or the road near a point along it, and the point on the route it faces. */
  const beside = (kind: 'path' | 'road', at: number, span: number, outs: number[], apart: number, index: number) => {
    let best = -Infinity, spot = { x: 0, z: 0 }, toward: [number, number] = [0, 0];
    for (let d = -span; d <= span; d += 3) for (const side of [-1, 1]) for (const out of outs) {
      const along = at + d;
      const x = kind === 'path' ? pathX(along) + side * out : along, z = kind === 'path' ? along : roadZ(along) + side * out;
      if (!buildable(x,z,18) || offRiver(x, z) < 22 || sideChannelOffset(x, z) < 30 || (kind === 'path' ? offRoad(x, z) < 22 : offPath(x, z) < 22)) continue;
      if (taken.some(t => dist(t, { x, z }) < apart)) continue;
      const s = flat(x, z) * 2 - landSlope(x, z, 3) * 4 - Math.abs(d) / span * .5 + hash(along * .31 + index, side * 7.7 + out) * .3;
      if (s > best) { best = s; spot = { x, z }; toward = kind === 'path' ? [pathX(along), along] : [along, roadZ(along)]; }
    }
    if(best===-Infinity){
      spot=bestSite((x,z)=>-Math.hypot(x-(kind==='path'?pathX(at):at),z-(kind==='path'?at:roadZ(at))),taken,apart,index+200);
      toward=nearestRoute(spot.x,spot.z);
    }
    return { spot: claim(spot), toward };
  };
  /** The flattest spot in a box of the map, away from the routes: something to be found, not passed. */
  const within = (x0: number, x1: number, z0: number, z1: number, index: number) => claim(bestSite((x, z) =>
    x < x0 || x > x1 || z < z0 || z > z1 ? -99 : flat(x, z) * 2 - landSlope(x, z, 4) * 4, taken, 60, index));

  // A well where the trail climbs north of the cabin: the first thing you find by simply walking on.
  const well = beside('path', 128, 26, [8, 10.5], 45, 1);
  pois.push({ id: 'well', asset: 'well', ...well.spot, yaw: facing(well.spot, well.toward, 0, 1), pad: { radius: 2.2, falloff: 4 }, footprint: { cx: 0, cz: 0, hx: 1.35, hz: 1.35 }, entrance: [0, 2.0] });
  // A homestead that burned, south along the trail.
  const ruin = beside('path', -236, 30, [15, 19], 60, 2);
  pois.push({ id: 'ruin', asset: 'ruin', ...ruin.spot, yaw: facing(ruin.spot, ruin.toward, .15, 1), pad: { radius: 6.2, falloff: 8 }, footprint: { cx: 0, cz: 0, hx: 4.9, hz: 3.5 }, entrance: [.9, 4.3], clearing: 8 });
  // The trail's south end: the pump house on the old water main.
  const pump = beside('path', WORLD_V2 ? coastZ(pathX(-330))+48 : -416, 20, [8.5, 11, 16], 40, 3);
  pois.push({ id: 'pumphouse', asset: 'pumphouse', ...pump.spot, yaw: facing(pump.spot, pump.toward, .2, 1), pad: { radius: 4.2, falloff: 6 }, footprint: { cx: .3, cz: .35, hx: 2.9, hz: 2.5 }, entrance: [.55, 3.3], clearing: 6 });
  // Its north end: the trail runs straight into a ring of stones somebody still tends.
  const shrine = beside('path', WORLD_V2 ? 308 : 421, 20, [8, 12], 35, 7).spot;
  pois.push({ id: 'shrine', asset: 'shrine', ...shrine, yaw: facing(shrine, [pathX(shrine.z-12), shrine.z-12], 0, 1), pad: { radius: 6.6, falloff: 9 }, footprint: { cx: 0, cz: 0, hx: 3.9, hz: 3.9 }, entrance: [0, 9.5], clearing: 7 });
  // The north-west had nothing in it: a burial plot in the birches, and the water tower beyond.
  const graves = within(-235, -95, 105, 235, 91);
  pois.push({ id: 'graves', asset: 'graves', ...graves, yaw: facing(graves, nearestRoute(graves.x, graves.z), 0, 1), pad: { radius: 4.8, falloff: 7 }, footprint: { cx: 0, cz: 0, hx: 3.5, hz: 2.7 }, entrance: [0, 6.2], clearing: 6 });
  // The water tower stands by the road west of the trailhead, where the logging trucks filled up: seen from a long way off.
  const towerAt = beside('road', -128, 42, [13, 16], 50, 4), tower = towerAt.spot;
  pois.push({ id: 'watertower', asset: 'watertower', ...tower, yaw: facing(tower, towerAt.toward, .9, .4), pad: { radius: 3.8, falloff: 6 }, footprint: { cx: 0, cz: 0, hx: 2.5, hz: 2.5 }, entrance: [3.5, 1.4], clearing: 7, draw: 420 });
  // South-east, below the road: an old stone fold, and what has been put up in the middle of it.
  const fold = within(105, 245, -280, -165, 103);
  pois.push({ id: 'fold', asset: 'effigy', ...fold, yaw: facing(fold, nearestRoute(fold.x, fold.z), 0, 1), pad: { radius: 2, falloff: 4 }, footprint: { cx: 0, cz: 0, hx: 1, hz: 1 }, entrance: [0, 10.5], clearing: 10 });

  // Further out in the same quarter, a hunter's high seat nobody has climbed in years: the far point of the south-east loop.
  const hide = within(285, 405, -310, -175, 109);
  pois.push({ id: 'hide', asset: 'deerstand', ...hide, yaw: facing(hide, [fold.x, fold.z], 0, 1), pad: { radius: 1.9, falloff: 3 }, footprint: { cx: 0, cz: 0, hx: 1.3, hz: 1.3 }, entrance: [0, 3.2], clearing: 4 });

  // The road goes into the mountain at both ends. Each mouth is shut by a fall; the barrier stands a little way back
  // from it, and on the east side the bus used to turn round here.
  for (const end of ROAD_ENDS) {
    const name = end.side > 0 ? 'east' : 'west';
    claim({ x: end.x, z: end.z });
    pois.push({ id: `tunnel-${name}`, asset: 'tunnel', x: end.x, z: end.z, yaw: end.yaw, footprint: { cx: 0, cz: -1, hx: 9.6, hz: 9.4 }, clearing: 19, draw: 240 });
    pois.push({ id: `tunnel-rock-${name}`, asset: 'tunnelrock', x: end.x, z: end.z, yaw: end.yaw, clearing: 24, draw: 240 });
    const [gx, gz] = placeLocal(end, 0, 12);
    pois.push({ id: `gate-${name}`, asset: 'gate', x: gx, z: gz, yaw: end.yaw, footprint: { cx: 0, cz: 0, hx: 6.4, hz: .5 }, clearing: 8 });
    if (end.side > 0) {
      const rx=end.x-end.side*55, rz=roadZ(rx), tangent=roadZ(rx+.5)-roadZ(rx-.5), norm=Math.hypot(1,tangent);
      const [bx,bz]=WORLD_V2?[rx-tangent/norm*10,rz+10/norm]:placeLocal(end,9.2,44);
      const stop = claim({ x: bx, z: bz });
      pois.push({ id: 'busstop', asset: 'busstop', ...stop, yaw: facing(stop, WORLD_V2?[rx,rz]:placeLocal(end, 0, 44), 0, 1), pad: { radius: 4, falloff: 10, fixed: true }, footprint: { cx: 0, cz: .1, hx: 2.2, hz: 1.4 }, entrance: [0, 3.1], clearing: 5 });
    }
  }
  return pois;
}

/** Where the road meets the stream, and the level its bridge has to carry it across at. */
export const ROAD_CROSSING = (() => {
  let x = 39, gap = Infinity;
  for (let px = -60; px < 200; px += .25) { const d = Math.abs(px - riverX(roadZ(px))); if (d < gap) { gap = d; x = px; } }
  const z = roadZ(x), yaw = -Math.atan2(roadZ(x + 2) - roadZ(x - 2), 4);
  const ground = (landform(x - 27, roadZ(x - 27)) + landform(x + 27, roadZ(x + 27))) / 2;
  return { x, z, yaw, level: Math.max(waterHeightAt(z) + 3.6, ground) };
})();

const levelled: GroundPad[] = [];
export const POI_PLACEMENTS: PoiPlacement[] = generate();
POI_PLACEMENTS.push({ id: 'road-bridge', asset: 'roadbridge', x: ROAD_CROSSING.x, z: ROAD_CROSSING.z, yaw: ROAD_CROSSING.yaw, y: ROAD_CROSSING.level, clearing: 28, draw: 300 });
for (const side of [-1, 1]) levelled.push({ x: ROAD_CROSSING.x + side * 24, z: roadZ(ROAD_CROSSING.x + side * 24), radius: 10, falloff: 16, level: ROAD_CROSSING.level });
/** Patches of ground levelled for something: the bridge approaches, then each small building. */
export const GROUND_PADS = levelled;
const poi = (id: string) => POI_PLACEMENTS.find(p => p.id === id)!;
const entranceOf = (id: string) => { const p = poi(id); return placeLocal(p, p.entrance![0], p.entrance![1]); };

// ---- footpaths ---------------------------------------------------------------------------------
/** Paths between places, so that a walk closes into a loop and does not end in the trees. */
const LINKS: [string, string][] = [['shrine', 'graves'], ['pumphouse', 'chapel'], ['fold', 'relay-hut'], ['lookout', 'mine'], ['hide', 'busstop']];
const CELL = 7, HALF = 66, SIZE = HALF * 2 + 1;
const cellOf = (v: number) => Math.round(v / CELL) + HALF;
const key = (i: number, j: number) => j * SIZE + i;

/** A path begins exactly on the road, the trail, a bridge end or another path, not merely near one. */
function snapToRoute(at: [number, number], lines: [number, number][][]): [number, number] {
  let best = Infinity, out = at;
  const consider = (x: number, z: number) => { if(!dryLand(x,z,7))return; const d = Math.hypot(x - at[0], z - at[1]); if (d < best) { best = d; out = [x, z]; } };
  for (let d = -9; d <= 9; d += .25) {
    const z=at[1]+d;
    if(z>=MAIN_TRAIL_BOUNDS.south&&z<=MAIN_TRAIL_BOUNDS.north)consider(pathX(z),z);
    consider(at[0] + d, roadZ(at[0] + d));
  }
  consider(riverX(-35) + 12, -35); consider(riverX(-35) - 12, -35);
  for (const line of lines) for (const q of line) consider(q[0], q[1]);
  return out;
}

/** Routes a path across the real ground: it prefers contours, stays out of the water, and joins a route that already exists. */
function routePaths() {
  const network = new Set<number>(), blocked = new Uint8Array(SIZE * SIZE), wet = new Uint8Array(SIZE * SIZE), height = new Float32Array(SIZE * SIZE);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const x = (i - HALF) * CELL, z = (j - HALF) * CELL;
    const off = offRiver(x, z), ground = landform(x, z), bank = waterHeightAt(z) + 1.2, relief = Math.max(0, ground - bank) * 1.4;
    height[key(i, j)] = off < 19 + relief ? bank + (ground - bank) * smoothCarve(off, 9, 19 + relief) : ground;
    if (Math.abs(x)>450 || z>430 || !dryLand(x,z,10) || offMainStream(x, z) < 10) blocked[key(i, j)] = 1;
    wet[key(i, j)] = offRiver(x, z) < 7 ? 1 : 0;
  }
  for (const p of POI_PLACEMENTS) {
    if (!p.footprint) continue;
    const [fx, fz] = placeLocal(p, p.footprint.cx, p.footprint.cz), reach = Math.hypot(p.footprint.hx, p.footprint.hz);
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    for (let j = cellOf(fz - reach); j <= cellOf(fz + reach); j++) for (let i = cellOf(fx - reach); i <= cellOf(fx + reach); i++) {
      if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) continue;
      const dx = (i - HALF) * CELL - fx, dz = (j - HALF) * CELL - fz;
      // A loop path passing a place keeps clear of it by a couple of metres more than the path to its own door does.
      const keep = p.id === 'lookout' ? 3.2 : p.id==='graves'?3.2:1;
      if (Math.abs(dx * c - dz * s) < p.footprint.hx + keep && Math.abs(dx * s + dz * c) < p.footprint.hz + keep) blocked[key(i, j)] = 1;
    }
  }
  // The hillside and rock behind the mine are a wall: its path has to come up the yard, to the front.
  {
    const m = poi('mine'), c = Math.cos(m.yaw), s = Math.sin(m.yaw);
    for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
      const dx = (i - HALF) * CELL - m.x, dz = (j - HALF) * CELL - m.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (lz < 7 && Math.hypot(lx, lz) < 30 && Math.abs(lx) > 2.5 || lz < 3 && Math.hypot(lx, lz) < 30) blocked[key(i, j)] = 1;
    }
  }
  const mark = (x: number, z: number) => { const i = cellOf(x), j = cellOf(z); if (i >= 0 && j >= 0 && i < SIZE && j < SIZE && !blocked[key(i, j)]) network.add(key(i, j)); };
  for (let z = MAIN_TRAIL_BOUNDS.south; z <= MAIN_TRAIL_BOUNDS.north; z += 3) mark(pathX(z), z);
  for (let x = -430; x <= 430; x += 3) mark(x, roadZ(x));
  mark(riverX(-35) + 12, -35); mark(riverX(-35) - 12, -35);

  const lines: [number, number][][] = [];
  type Job = { from: string; to?: string };
  const jobs: Job[] = [...['cabin', 'trailhead-board', 'logging-camp', 'relay-hut', 'hunter-camp', 'lookout', 'chapel', 'mine', 'well', 'ruin', 'pumphouse', 'shrine', 'graves', 'watertower', 'fold', 'busstop'].map(from => ({ from })), { from: 'hide', to: 'fold' }, ...LINKS.map(([from, to]) => ({ from, to }))];
  for (const { from: id, to } of jobs) {
    const [ex, ez] = entranceOf(id);
    // A path approaches the open side of a doorway/board, rather than taking
    // the shortest route through the back of the object.
    const apron:Record<string,[number,number]>={'trailhead-board':[0,4.5],'relay-hut':[-.9,6.4],'graves':[0,12.2]};
    const approach=apron[id]?placeLocal(poi(id),...apron[id]):[ex,ez];
    const si=cellOf(approach[0]),sj=cellOf(approach[1]);
    // A link runs door to door and may follow paths that already exist; only its new ground becomes a path.
    const target = to ? entranceOf(to) : undefined, goal = target ? key(cellOf(target[0]), cellOf(target[1])) : -1;
    // Dijkstra outward from the door until it meets anything already walked.
    const best = new Float32Array(SIZE * SIZE).fill(Infinity), prev = new Int32Array(SIZE * SIZE).fill(-1), heap: [number, number][] = [];
    const push = (item: [number, number]) => {
      heap.push(item);
      for (let n = heap.length - 1; n > 0;) { const up = (n - 1) >> 1; if (heap[up][0] <= heap[n][0]) break; [heap[up], heap[n]] = [heap[n], heap[up]]; n = up; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let n = 0; ;) {
          const a = n * 2 + 1, b = a + 1; let least = n;
          if (a < heap.length && heap[a][0] < heap[least][0]) least = a;
          if (b < heap.length && heap[b][0] < heap[least][0]) least = b;
          if (least === n) break;
          [heap[least], heap[n]] = [heap[n], heap[least]]; n = least;
        }
      }
      return top;
    };
    push([0, key(si, sj)]);
    best[key(si, sj)] = 0;
    let end = -1;
    while (heap.length) {
      const [d, c] = pop();
      if (d > best[c]) continue;
      if (to ? c === goal : network.has(c) && c !== key(si, sj)) { end = c; break; }
      const j = Math.floor(c / SIZE), i = c - j * SIZE;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= SIZE || nj >= SIZE) continue;
        const n = key(ni, nj);
        if (blocked[n] && n !== key(si, sj) && n !== goal) continue;
        const run = Math.hypot(di, dj) * CELL, slope = Math.abs(height[n] - height[c]) / run;
        // People go round wet hollows and thickets: this is what stops a path being a ruled line.
        // A side stream can be waded, but nobody does it without a reason.
        const cost = run * (1 + 42 * slope * slope + noise(ni * .22 + WORLD_SEED, nj * .22) ** 2 * 3.2 + wet[n] * 9) * (to && network.has(n) ? .35 : 1);
        if (d + cost < best[n]) { best[n] = d + cost; prev[n] = c; push([best[n], n]); }
      }
    }
    if (end < 0) continue;
    const chain: number[] = [];
    for (let c = end; c !== -1; c = prev[c]) chain.push(c);
    const at = (c: number): [number, number] => { const j = Math.floor(c / SIZE), i = c - j * SIZE; return [(i - HALF) * CELL, (j - HALF) * CELL]; };
    // A spur is the whole chain. A link is cut into the stretches that are not already a path, each with a foot on one.
    const runs: number[][] = [];
    if (!to) runs.push(chain);
    else {
      let run: number[] = [];
      chain.forEach((c, k) => {
        const walked = network.has(c) && k !== 0 && k !== chain.length - 1;
        if (!walked) { if (!run.length && k > 0) run.push(chain[k - 1]); run.push(c); }
        else if (run.length) { run.push(c); runs.push(run); run = []; }
      });
      if (run.length) runs.push(run);
    }
    for (const run of runs) {
    // A stretch of two or three cells is the door's own cell meeting a path that is already there, not a new path.
    if (run.length < (to ? 4 : 2)) continue;
    // Both landmarks already have spurs. Only retain additional links reaching
    // one of their doors; disconnected middle fragments create dead-end tracks.
    if(to&&!run.includes(goal)&&!run.includes(key(si,sj)))continue;
    // Every line runs from the route it joins to a door, when it has a door at either end.
    if (to && run[0] === goal && run[run.length - 1] !== key(si, sj)) run.reverse();
    const cells: [number, number][] = run.map(at);
    for (const c of run) network.add(c);
    if (run[run.length - 1] === key(si, sj)) {
      cells[cells.length - 1]=[approach[0],approach[1]];
      if(apron[id])cells.push([ex,ez]);
    }
    else cells[cells.length - 1] = snapToRoute(cells[cells.length - 1], lines);
    if (to && run[run.length - 1] === goal) cells[cells.length - 1] = target!;
    cells[0] = to && run[0] === goal ? target! : snapToRoute(cells[0], lines);
    // Rounded by corner cutting, so a grid never shows through in the walked line.
    let line = cells;
    for (let pass = 0; pass < 2; pass++) {
      const next: [number, number][] = [line[0]];
      for (let i = 0; i < line.length - 1; i++) {
        const [ax, az] = line[i], [bx, bz] = line[i + 1];
        const a:[number,number]=[ax*.75+bx*.25,az*.75+bz*.25], b:[number,number]=[ax*.25+bx*.75,az*.25+bz*.75];
        next.push(dryLand(a[0],a[1],7)?a:[ax,az],dryLand(b[0],b[1],7)?b:[bx,bz]);
      }
      next.push(line[line.length - 1]);
      line = next;
    }
    const distance = [0];
    for (let i = 1; i < line.length; i++) distance.push(distance[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const total = distance[distance.length - 1];
    line = line.map(([x, z], i) => {
      if (!i || i === line.length - 1) return [x, z];
      const [ax, az] = line[i - 1], [bx, bz] = line[i + 1], length = Math.hypot(bx - ax, bz - az) || 1;
      const taper = Math.min(1, distance[i] / 9, (total - distance[i]) / 9);
      const offset = taper * (Math.sin(distance[i] * .21 + lines.length * 1.7) * 1.15 + Math.sin(distance[i] * .47 + lines.length) * .32);
      const nx = x - (bz - az) / length * offset, nz = z + (bx - ax) / length * offset;
      const ci = cellOf(nx), cj = cellOf(nz);
      return ci >= 0 && cj >= 0 && ci < SIZE && cj < SIZE && !blocked[key(ci, cj)] ? [nx, nz] : [x, z];
    });
    lines.push(line);
    }
  }
  return lines;
}
/** Each route, from where it joins a road or trail to the door it serves. */
export const TRAIL_LINES: [number, number][][] = routePaths();
export const TRAILS = TRAIL_LINES;
function distanceToTrails(x:number,z:number){
  let d=Infinity;
  for(const line of TRAIL_LINES)for(let i=0;i<line.length-1;i++){
    const [ax,az]=line[i],[bx,bz]=line[i+1],ux=bx-ax,uz=bz-az;
    const t=Math.max(0,Math.min(1,((x-ax)*ux+(z-az)*uz)/(ux*ux+uz*uz||1)));
    d=Math.min(d,Math.hypot(x-ax-ux*t,z-az-uz*t));
  }
  return d;
}

type Item = [asset: string, lx: number, lz: number, yaw?: number, fit?: GroundFit];
/** Each place tells one small story with a handful of objects. Stop there; negative space is the point. */
const CLUSTERS: [string, Item[]][] = [
  ['cabin', [['chair', 1.7, 7.0, 1.2, 'tilt'], ['bucket', 2.7, 6.3, .4, 'tilt'], ['wheelbarrow', 5.7, 1.5, 2.6, 'tilt'], ['shovel', 5.6, -1.9, 1.3, 'tilt'], ['outhouse', -3.4, -11, .15], ['canline', -9.5, -7, 1.1, 'tilt']]],
  ['trailhead-board', [['picnic_table', 7, 0, 0]]],
  ['relay-hut', [['pallet', 3.6, 1.4, .5, 'tilt'], ['crate', 3.7, 1.5, .2, 'tilt'], ['drum', 3.5, -.4, 0], ['drum', 4.25, -.1, 2], ['toolbox', 1.9, 3.1, 1.4, 'tilt']]],
  ['lookout', [['crate', 3.8, -2, .3, 'tilt'], ['chair', -4.2, -3.5, .8, 'tilt']]],
  ['logging-camp', [['sawhorse', 3.8, 3.4, .4], ['stump_axe', -2.4, 2.4, 2], ['firewood', 6.2, 1.2, .4], ['wheelbarrow', -1.4, .2, 1.2, 'tilt'], ['pallet', -.4, -2, .9, 'tilt'], ['drum', 11, 5, .4], ['tire', 11, 8, 0, 'tilt']]],
  ['hunter-camp', [['antler_post', 2.6, 3.4, .5], ['bottles', 3.6, 1.0, 0, 'tilt'], ['chair', 2.9, -2.9, 2.5, 'tilt'], ['firewood', -7.4, 1.8, 1.4], ['canline', -11, -3, .3, 'tilt'], ['canline', 9.5, 7, -.5, 'tilt']]],
  ['chapel', [['totem', 2.6, 9.6, 0], ['totem', -2.8, 9.8, .4], ['bucket', -4.2, 2, .8, 'tilt'], ['shovel', -8.5, 4.6, 2, 'tilt']]],
  ['pumphouse', [['drum', -2.6, 1.2, .3], ['drum', -3.3, .7, 1.4], ['pallet', -2.9, 2.6, .5, 'tilt'], ['wheelbarrow', 3.4, 3.4, 2.2, 'tilt']]],
  ['well', [['bucket', 1.3, 1.4, .6, 'tilt']]],
  ['ruin', [['shovel', 5.6, 2.2, 1.1, 'tilt'], ['bucket', -4.6, 3.2, .3, 'tilt'], ['wheelbarrow', 6.2, -1.4, .8, 'tilt']]],
  ['graves', [['shovel', 2.1, 5.8, .4, 'tilt']]],
  ['watertower', [['drum', 3.6, -2.4, .2], ['crate', -3.4, 2.6, .7, 'tilt']]],
  ['mine', [['toolbox', 2.4, 1.6, .4, 'tilt'], ['bucket', -2, 3.1, 1.4, 'tilt'], ['wheelbarrow', -5.8, 4.6, 2, 'tilt'], ['shovel', 2.6, 6.2, .8, 'tilt'], ['drum', 5.2, 6.4, .3]]],
];

function scatter(): PoiPlacement[] {
  const out: PoiPlacement[] = [];
  const clearOfPlaces = (x: number, z: number, margin: number) => !POI_PLACEMENTS.some(p => p.pad && Math.hypot(p.x - x, p.z - z) < p.pad.radius + margin);
  // The power line serves the road and nothing else.
  let n = 0;
  for (let x = -380; x <= 380; x += 34) {
    const z = roadZ(x) + 5.4;
    if (offRiver(x, z) < 11 || Math.abs(x - ROAD_CROSSING.x) < 50 || !clearOfPlaces(x, z, 4)) continue;
    out.push({ id: `pole-${n++}`, asset: 'pole', x, z, yaw: -Math.atan2(roadZ(x + 4) - roadZ(x - 4), 8) + (hash(x, 3) - .5) * .06, draw: 220 });
  }
  // Bedrock breaks the surface only where the soil is really thin, in small groups.
  const CELLR = 70, rocks = ['rock_a', 'rock_b', 'rock_c', 'rock_d'];
  for (let gx = -6; gx <= 6; gx++) for (let gz = -6; gz <= 6; gz++) {
    const cx = (gx + .15 + hash(gx, gz) * .7) * CELLR, cz = (gz + .15 + hash(gz + 7, gx) * .7) * CELLR;
    const [u, v] = warped(cx, cz);
    if (!buildable(cx,cz,14) || rockMask(u, v) < .55) continue;
    const count = 1 + Math.floor(hash(gx * 5, gz * 3) * 3);
    for (let i = 0; i < count; i++) {
      const a = hash(gx + i, gz * 2) * 6.28, d = i ? 9 + hash(gz + i, gx) * 11 : 0, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (offRoad(x, z) < 12 || offRiver(x, z) < 14 || offPath(x, z) < 9 || !clearOfPlaces(x, z, 12)) continue;
      if (TRAIL_LINES.some(l => l.some(q => Math.hypot(q[0] - x, q[1] - z) < 9))) continue;
      if (out.some(o => o.asset.startsWith('rock_') && Math.hypot(o.x - x, o.z - z) < 11)) continue;
      out.push({ id: `rock-${gx}-${gz}-${i}`, asset: rocks[Math.floor(hash(gx + 11, gz - 5 + i) * 4)], x, z, yaw: hash(gx, gz + 31 + i) * 6.28, draw: 170 });
    }
  }
  // Road furniture belongs at the junctions.
  TRAIL_LINES.forEach((line, t) => {
    const [x, z] = line[0];
    if (offRoad(x, z) < 6) {
      const side = hash(t, 9) > .5 ? 1 : -1;
      const sx = x + 3 * side, sz = roadZ(x + 3 * side) + (z > roadZ(x) ? 4.2 : -4.2), altX = x - 5 * side, altZ = roadZ(x - 5 * side) + (z > roadZ(x) ? 4.2 : -4.2), onPath = (a: number, b: number) => TRAIL_LINES.some(l => l.some(q => Math.hypot(q[0] - a, q[1] - b) < 1.6));
      const signAt = onPath(sx, sz) ? [altX, altZ] : [sx, sz];
      out.push({ id: `sign-${t}`, asset: 'roadsign', x: signAt[0], z: signAt[1], yaw: hash(t, 4) * .4 + (z > roadZ(x) ? Math.PI : 0) });
      if (t % 2 === 0) out.push({ id: `mailbox-${t}`, asset: 'mailbox', x: x - 4.5 * side, z: roadZ(x - 4.5 * side) + (z > roadZ(x) ? 3.5 : -3.5), yaw: z > roadZ(x) ? Math.PI : 0 });
    }
    // One waymark where a path leaves the main route; a cairn only on a long walk.
    let markerIndex=1,markerRun=0;
    while(markerIndex<line.length-1&&markerRun<6){markerRun+=Math.hypot(line[markerIndex][0]-line[markerIndex-1][0],line[markerIndex][1]-line[markerIndex-1][1]);markerIndex++;}
    const step=line[markerIndex],before=line[markerIndex-1],dx=step[0]-before[0],dz=step[1]-before[1],l=Math.hypot(dx,dz)||1;
    const mx=step[0]-dz/l*2.2,mz=step[1]+dx/l*2.2;
    const roomy = !out.some(o => Math.hypot(o.x - mx, o.z - mz) < 1.5) && !POI_PLACEMENTS.some(p => { if (!p.footprint) return false; const [fx, fz] = placeLocal(p, p.footprint.cx, p.footprint.cz); return Math.hypot(fx - mx, fz - mz) < Math.hypot(p.footprint.hx, p.footprint.hz) + 1; });
    if (landSlope(mx, mz, 2) < .5 && roomy && distanceToTrails(mx,mz)>1.0) out.push({ id: `mark-${t}`, asset: 'trailmarker', x: mx, z: mz, yaw: Math.atan2(dx, dz) + 1.57, fit: 'level' });
    let length = 0; for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (length > 150) {
      const q = line[Math.floor(line.length * .55)], p = line[Math.floor(line.length * .55) + 1] ?? q, ux = p[0] - q[0], uz = p[1] - q[1], ul = Math.hypot(ux, uz) || 1;
      const cx = q[0] - uz / ul * 2, cz = q[1] + ux / ul * 2;
      if (landSlope(cx, cz, .5) < .12) out.push({ id: `cairn-${t}`, asset: 'cairn', x: cx, z: cz, yaw: hash(t, 2) * 6, fit: 'level' });
    }
    // Somewhere to sit on a long walk, facing the path, on the first level spot past half way.
    if (length > 200) {
      const lumpy = (x: number, z: number) => { let lo = Infinity, hi = -Infinity; for (let a = 0; a < 8; a++) { const h = landform(x + Math.cos(a * .785) * 1.2, z + Math.sin(a * .785) * 1.2); lo = Math.min(lo, h); hi = Math.max(hi, h); } return hi - lo; };
      search: for (const at of [.76, .7, .82, .64, .88, .58]) {
        const k = Math.floor(line.length * at), q = line[k], p = line[k + 1] ?? q, ux = p[0] - q[0], uz = p[1] - q[1], ul = Math.hypot(ux, uz) || 1;
        for (const side of [1, -1]) {
          const bx = q[0] + uz / ul * 2.5 * side, bz = q[1] - ux / ul * 2.5 * side;
          if (offRiver(bx, bz) < 12 || offRoad(bx, bz) < 8 || lumpy(bx, bz) > .16 || !clearOfPlaces(bx, bz, 4) || out.some(o => Math.hypot(o.x - bx, o.z - bz) < 4)) continue;
          // The mine's added hillside is applied after normal terrain levelling.
          if (Math.hypot(poi('mine').x-bx,poi('mine').z-bz)<80)continue;
          // Not on the made-up ground of a raised site, which is broken on purpose.
          if (POI_PLACEMENTS.some(p => p.pad?.rise && Math.hypot(p.x - bx, p.z - bz) < p.pad.radius + p.pad.falloff + 3)) continue;
          out.push({ id: `bench-${t}`, asset: 'bench', x: bx, z: bz, yaw: Math.atan2(-uz / ul * side, ux / ul * side) });
          levelled.push({ x: bx, z: bz, radius: 1.5, falloff: 2.5 });
          break search;
        }
      }
    }
    // A hunter's stand overlooks a long path, back in the trees.
    if (length > 170) {
      const q = line[Math.floor(line.length * .35)], p = line[Math.floor(line.length * .35) + 1] ?? q, ux = p[0] - q[0], uz = p[1] - q[1], ul = Math.hypot(ux, uz) || 1;
      const sx = q[0] + uz / ul * 13, sz = q[1] - ux / ul * 13;
      for (let attempt = 0; attempt < 80; attempt++) {
        const angle = attempt * 2.399963, radius = attempt ? 1.4 * Math.sqrt(attempt) : 0;
        const x = sx + Math.cos(angle) * radius, z = sz + Math.sin(angle) * radius;
        if (offRiver(x,z) < 24 || offRoad(x,z) < 16 || offPath(x,z) < 7 || !clearOfPlaces(x,z,12)) continue;
        if (TRAIL_LINES.some(l=>l.some(q=>Math.hypot(q[0]-x,q[1]-z)<8))) continue;
        const samples = Array.from({length: 8}, (_, k) => landform(x + Math.cos(k * Math.PI / 4) * 2, z + Math.sin(k * Math.PI / 4) * 2));
        if (Math.max(...samples) - Math.min(...samples) > .13 || out.some(o=>Math.hypot(o.x-x,o.z-z)<8)) continue;
        out.push({id: `stand-${t}`, asset: 'deerstand', x, z, yaw: Math.atan2(ux, uz) + 1.57});
        break;
      }
    }
  });
  // Crash rail where the road meets the stream, the only place anyone spent money on it. Each run picks up where the
  // bridge's own rail stops, closes in to the road edge, and ends turned down into the ground.
  for (const side of [-1, 1]) for (const dir of [-1, 1]) {
    const PANEL = 7.8, LENGTHS = 2;
    let [ax, az] = placeLocal(ROAD_CROSSING, dir * 18.9, side * 4.22);
    for (let m = 0; m < LENGTHS; m++) {
      const towards = ax + dir * PANEL, edge = 4.22 + (3.4 - 4.22) * Math.min(1, (m + 1) / 2);
      const wantX = towards - ax, wantZ = roadZ(towards) + side * edge - az, length = Math.hypot(wantX, wantZ);
      const ux = wantX / length, uz = wantZ / length, ex = ax + ux * PANEL, ez = az + uz * PANEL;
      let yaw = Math.atan2(-uz, ux), asset = 'guardrail';
      // Local +Z is the road face: (sin, cos) in world x, z.
      const flipped = Math.cos(yaw) * -side < 0;
      if (flipped) yaw += Math.PI;
      if (m === LENGTHS - 1) asset = flipped ? 'guardrail_endr' : 'guardrail_end';
      out.push({ id: `rail-${side}-${dir}-${m}`, asset, x: (ax + ex) / 2, z: (az + ez) / 2, yaw, fit: 'run' });
      ax = ex; az = ez;
    }
  }
  // Broken stone collects at the foot of the bank, never as floating shelves
  // halfway up the cut. Keep the open channel and bridge piers clear.
  for (let i = 0; i < 20; i++) {
    const bank = i % 2 ? 1 : -1, side = (i >> 1) % 2 ? 1 : -1;
    const [, z] = placeLocal(ROAD_CROSSING, 0, side * (12 + Math.floor(i / 4) * 8 + hash(i, 43) * 3));
    const x = riverX(z) + bank * (7.2 + hash(i, 41) * .5);
    if (offRiver(x, z) < 6.8) continue;
    out.push({id: `riprap-${i}`, asset: ['rock_a', 'rock_b', 'rock_c', 'rock_d'][i % 4], x, z,
      yaw: hash(i, 47) * 6.28, scale: .12 + hash(i, 49) * .1, draw: 170});
  }
  // Each object looks for the closest spot that actually works: off the path, on ground it can stand on, not in
  // something else. On another seed the ground differs, so nothing here can be trusted to a fixed coordinate.
  const REACH: Record<string, number> = { outhouse: 1.3, picnic_table: 1.5, canline: 3.8, totem: 1.4, fence: 2.4, wheelbarrow: 1.1, firewood: 1.3, sawhorse: 1.4, pallet: .9, crate: .6, drum: .45, chair: .7, bucket: .3, shovel: .9, bottles: .75, toolbox: .75, tire: .6, stump_axe: .7, antler_post: .6 };
  const standing = new Set(['outhouse', 'picnic_table', 'totem', 'antler_post', 'firewood']);
  const trail=distanceToTrails;
  const uneven = (x: number, z: number, reach: number) => { let lo = Infinity, hi = -Infinity; for (let a = 0; a < 8; a++) { const h = landform(x + Math.cos(a * .785) * reach, z + Math.sin(a * .785) * reach); lo = Math.min(lo, h); hi = Math.max(hi, h); } return hi - lo; };
  const sited: { x: number; z: number; r: number; asset: string }[] = [];
  const usable = (x: number, z: number, asset: string, reach: number, fit: GroundFit | undefined, host: PoiPlacement) => {
    if(!dryLand(x,z,reach+3)||landSlope(x,z,3)>.65)return false;
    if (trail(x, z) < reach + 1.1) return false;
    if(z>=MAIN_TRAIL_BOUNDS.south&&z<=MAIN_TRAIL_BOUNDS.north&&offPath(x,z)<reach+2.6)return false;
    if(host.id==='trailhead-board'){
      const slope=(roadZ(x+.5)-roadZ(x-.5));
      if(Math.abs(z-roadZ(x))/Math.hypot(1,slope)<reach+6.6)return false;
    }
    // A host's footprint can contain open ground, but its posts, graves and walls
    // still occupy space. Test the exported solids before placing loose props.
    const dx = x - host.x, dz = z - host.z, c = Math.cos(host.yaw), n = Math.sin(host.yaw);
    const lx = dx * c - dz * n, lz = dx * n + dz * c;
    const catalog=worldAssets as Record<string,{colliders?:{kind:string; x?:number; z?:number; yaw?:number; halfX?:number; halfZ?:number; ax?:number; az?:number; bx?:number; bz?:number; radius?:number; minY:number}[]}>;
    // The mine's roof and side rock are a separate mesh sharing its transform.
    const solids=[...(catalog[host.asset]?.colliders??[]),...(host.id==='mine'?catalog.minerock?.colliders??[]:[])];
    for (const solid of solids) {
      if (solid.minY > .6) continue;
      let distance: number;
      if (solid.kind === 'box') {
        const co = Math.cos(solid.yaw ?? 0), si = Math.sin(solid.yaw ?? 0), u = lx - solid.x!, v = lz - solid.z!;
        distance = Math.hypot(Math.max(0, Math.abs(u * co - v * si) - solid.halfX!), Math.max(0, Math.abs(u * si + v * co) - solid.halfZ!));
      } else {
        const ux = solid.bx! - solid.ax!, uz = solid.bz! - solid.az!, t = Math.max(0, Math.min(1, ((lx - solid.ax!) * ux + (lz - solid.az!) * uz) / (ux * ux + uz * uz || 1)));
        distance = Math.hypot(lx - solid.ax! - ux * t, lz - solid.az! - uz * t) - solid.radius!;
      }
      if (distance < reach + .08) return false;
    }

    if (sited.some(o => Math.hypot(o.x - x, o.z - z) < o.r + reach + .25 && !(new Set([o.asset, asset]).has('pallet') && new Set([o.asset, asset]).has('crate')))) return false;
    if (POI_PLACEMENTS.some(p => { if (p === host || !p.footprint) return false; const [fx, fz] = placeLocal(p, p.footprint.cx, p.footprint.cz); return Math.hypot(fx - x, fz - z) < Math.hypot(p.footprint.hx, p.footprint.hz) + reach; })) return false;
    if (standing.has(asset)) return true;       // these get a small levelled patch of their own
    return fit === 'tilt' ? landSlope(x, z, 1.5) < .42 : uneven(x, z, reach) < .32;
  };
  for (const [id, items] of CLUSTERS) {
    const p = poi(id);
    items.forEach(([asset, lx, lz, yaw, fit], i) => {
      const reach = REACH[asset] ?? .6, [x0, z0] = placeLocal(p, lx, lz);
      let spot: [number, number] | undefined;
      for (let ring = 0; ring <= 8 && !spot; ring++) for (let k = 0; k < (ring ? 10 : 1); k++) {
        const a = k * .628 + ring, d = ring * .8, x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d;
        if (usable(x, z, asset, reach, fit, p)) { spot = [x, z]; break; }
      }
      if (!spot) return;
      sited.push({ x: spot[0], z: spot[1], r: reach, asset });
      if (standing.has(asset)) levelled.push({ x: spot[0], z: spot[1], radius: reach + .5, falloff: 3,
        ...(asset==='picnic_table'?{level:landform(spot[0],spot[1])}:{}) });
      out.push({ id: `${id}:${asset}:${i}`, asset, x: spot[0], z: spot[1], yaw: id==='trailhead-board'?Math.PI-Math.atan2(roadZ(spot[0]+.5)-roadZ(spot[0]-.5),1):p.yaw + (yaw ?? 0), fit });
    });
  }
  // The fold: a ring of dry stone wall round the thing in the middle, open towards the way in, down in two places.
  {
    const f = poi('fold'), R = 7.15, N = 10;
    for (let k = 0; k < N; k++) {
      if (k === 2) continue;   // the gateway, which faces local +z
      const a = (k + .5) / N * Math.PI * 2, [x, z] = placeLocal(f, Math.cos(a) * R, Math.sin(a) * R);
      out.push({ id: `fold-wall-${k}`, asset: k === 6 || k === 9 ? 'wall_gap' : 'wall', x, z, yaw: f.yaw - (a + Math.PI / 2), fit: 'run' });
    }
  }
  // An old boundary wall crosses the main trail half way up the north leg, with the gap the path has always used.
  {
    const z0 = 232, dx = pathX(z0 + 3) - pathX(z0 - 3), l = Math.hypot(dx, 6), tx = dx / l, tz = 6 / l, nx = tz, nz = -tx;
    for (const side of [-1, 1]) for (let k = 0; k < 4; k++) {
      const d = side * (3.6 + k * 4.42), x = pathX(z0) + nx * d, z = z0 + nz * d;
      if (offRiver(x, z) < 12 || !clearOfPlaces(x, z, 3)) break;
      out.push({ id: `boundary-${side}-${k}`, asset: (k === 1 && side < 0) || (k === 3 && side > 0) ? 'wall_gap' : 'wall', x, z, yaw: Math.atan2(-nz, nx), fit: 'run' });
    }
    // The same on the south leg: a bench where the trail tops the rise before the pump house.
    const zb = WORLD_V2 ? poi('pumphouse').z+30 : -332, bx = pathX(zb) + 2.4, bdx = pathX(zb + 2) - pathX(zb - 2);
    if (offRiver(bx, zb) > 12 && landSlope(bx, zb, 1.5) < .35) { out.push({ id: 'bench-south', asset: 'bench', x: bx, z: zb, yaw: -Math.PI / 2 - Math.atan2(bdx, 4) }); levelled.push({ x: bx, z: zb, radius: 1.3, falloff: 2.5 }); }
  }
  // The closer the trail gets to the stones at its north end, the more of these stand beside it.
  (WORLD_V2 ? [poi('shrine').z-80,poi('shrine').z-55,poi('shrine').z-30,poi('shrine').z-15] : [318,352,380,402]).forEach((z, k) => {
    const side = k % 2 ? 1 : -1, x = pathX(z) + side * (3.1 + hash(z, 5) * .8);
    if (offRiver(x, z) < 12 || !clearOfPlaces(x, z, 2) || distanceToTrails(x,z)<2 || out.some(p=>Math.hypot(p.x-x,p.z-z)<4)) return;
    out.push({ id: `effigy-${k}`, asset: 'effigy', x, z, yaw: hash(z, 9) * 6.28 });
    levelled.push({ x, z, radius: 1.3, falloff: 2.5 });
  });
  // A lamp where the road has a reason for one: the tunnel mouths, the bus stop, the bridge, each junction.
  {
    const at = new Set<number>([...ROAD_ENDS.map(e => e.x - e.side * 22), ROAD_ENDS[0].x - 46, ROAD_CROSSING.x - 26, ROAD_CROSSING.x + 26, pathX(roadZ(0)) + 9, poi('watertower').x + 10]);
    TRAIL_LINES.forEach(line => { const [x, z] = line[0]; if (offRoad(x, z) < 6) at.add(x + 7); });
    [...at].sort((a, b) => a - b).forEach((x, k, all) => {
      if (k && x - all[k - 1] < 30) return;
      const side = -1, z = roadZ(x) + side * 4.8;
      if (offRiver(x, z) < 12 || offPath(x, z) < 3 || !clearOfPlaces(x, z, 2) || TRAIL_LINES.some(l => l.some(q => Math.hypot(q[0] - x, q[1] - z) < 2))) return;
      out.push({ id: `streetlight-${k}`, asset: 'streetlight', x, z, yaw: Math.atan2(0, -side) + Math.atan2(roadZ(x + 2) - roadZ(x - 2), 4) * side, draw: 320 });
    });
  }
  // Hunters levelled the ground under their stands before anything else.
  for (const s of out) if (s.asset === 'deerstand') levelled.push({ x: s.x, z: s.z, radius: 1.6, falloff: 3 });
  // Keep scattered props above the shoreline, including the margins of their
  // physical footprint. Small gravel at the river is deliberately exempt.
  return out.filter(p => dryLand(p.x,p.z,p.id.startsWith('riprap-')?0:2) && landSlope(p.x,p.z,2)<.85);
}

export const SCATTER_PLACEMENTS: PoiPlacement[] = scatter();
