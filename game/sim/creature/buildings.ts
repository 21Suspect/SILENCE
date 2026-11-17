/**
 * The buildings the Listener besieges (docs/gameplay-plan.md, "Indoors"): a footprint on the ground, where the walls stand, in
 * the world's frame. Pure geometry with no three.js; creature-brain.ts uses it to tell that a noise came from inside, to
 * go round the walls at a distance, and to find the way out of a doorway.
 *
 * A building is the placement's frame (x, z and yaw, as in world-layout.ts: local x runs (cos yaw, -sin yaw), local z runs
 * (sin yaw, cos yaw)) and the rectangle in it, centred (cx, cz) with half extents (hx, hz).
 */
export type Building = { id: string; x: number; z: number; yaw: number; cx: number; cz: number; hx: number; hz: number };
/** A way in: a doorway (or window) the arms can reach through when it is open. */
export type Opening = {
  id: string;
  /** The building it belongs to (Building.id). */
  building: string;
  /** The middle of the gap, world metres. */
  x: number; z: number;
  /** 0 shut .. 1 wide open. */
  open: number;
  /** A bar lies across it (it holds longer). */
  barred: boolean;
  kind?: 'door' | 'window';
};

/** World point to the building's frame, relative to the middle of its rectangle. */
export function toLocal(b: Building, x: number, z: number) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw), dx = x - b.x, dz = z - b.z;
  return { x: dx * c - dz * s - b.cx, z: dx * s + dz * c - b.cz };
}
/** The building's frame (relative to the middle of its rectangle) to a world point. */
export function toWorld(b: Building, lx: number, lz: number) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw), px = lx + b.cx, pz = lz + b.cz;
  return { x: b.x + px * c + pz * s, z: b.z - px * s + pz * c };
}
/** Inside the walls, `margin` metres in (negative: that far out). */
export function insideBuilding(b: Building, x: number, z: number, margin = 0) {
  const l = toLocal(b, x, z);
  return Math.abs(l.x) <= b.hx - margin && Math.abs(l.z) <= b.hz - margin;
}
/** The building around a point, if any. */
export function buildingAt(buildings: readonly Building[], x: number, z: number, margin = 0): Building | undefined {
  for (const b of buildings) if (insideBuilding(b, x, z, margin)) return b;
  return undefined;
}
/** The angle (radians, 0 along local +z, turning toward +x) of a world point seen from the middle of the building. */
export function bearingOf(b: Building, x: number, z: number) {
  const l = toLocal(b, x, z);
  return Math.atan2(l.x, l.z);
}
/**
 * The point on the rectangle `distance` metres outside the walls, along the ray from the middle at `bearing`: a ring to walk
 * round the building on, at a steady distance from the walls.
 */
export function ringPoint(b: Building, bearing: number, distance: number) {
  const sx = Math.sin(bearing), sz = Math.cos(bearing), hx = b.hx + distance, hz = b.hz + distance;
  const t = Math.min(Math.abs(sx) > 1e-9 ? hx / Math.abs(sx) : Infinity, Math.abs(sz) > 1e-9 ? hz / Math.abs(sz) : Infinity);
  return toWorld(b, sx * t, sz * t);
}
/** The unit vector pointing out of the building at a point on or near its wall (world frame): the wall it is nearest to. */
export function outwardAt(b: Building, x: number, z: number) {
  const l = toLocal(b, x, z), ex = Math.abs(l.x) / b.hx, ez = Math.abs(l.z) / b.hz;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const lx = ex >= ez ? Math.sign(l.x) || 1 : 0, lz = ex >= ez ? 0 : Math.sign(l.z) || 1;
  return { x: lx * c + lz * s, z: -lx * s + lz * c };
}
/** Where it stands to work at an opening: `distance` metres out from it, away from the building. */
export function standAt(b: Building, o: { x: number; z: number }, distance: number) {
  const out = outwardAt(b, o.x, o.z);
  return { x: o.x + out.x * distance, z: o.z + out.z * distance };
}

type PlacementLike = { id: string; asset: string; x: number; z: number; yaw: number; footprint?: { cx: number; cz: number; hx: number; hz: number } };
type AssetLike = { doors?: unknown[]; colliders?: { kind: string; x?: number; z?: number; halfX?: number; halfZ?: number; tag?: string }[] };

/**
 * The besiegeable buildings among the placements: those whose asset has doors. The rectangle is the bounds of the asset's wall
 * colliders (the true walls: a declared footprint also takes in steps and porches), else the placement's footprint.
 */
export function creatureBuildings(placements: readonly PlacementLike[], assets: Record<string, AssetLike>): Building[] {
  const out: Building[] = [];
  for (const p of placements) {
    const asset = assets[p.asset];
    if (!asset || !Array.isArray(asset.doors) || !asset.doors.length) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const c of asset.colliders ?? []) {
      if (c.kind !== 'box' || !c.tag?.endsWith('wall')) continue;
      x0 = Math.min(x0, c.x! - c.halfX!); x1 = Math.max(x1, c.x! + c.halfX!); z0 = Math.min(z0, c.z! - c.halfZ!); z1 = Math.max(z1, c.z! + c.halfZ!);
    }
    if (x1 > x0 && z1 > z0) out.push({ id: p.id, x: p.x, z: p.z, yaw: p.yaw, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 });
    else if (p.footprint) out.push({ id: p.id, x: p.x, z: p.z, yaw: p.yaw, ...p.footprint });
  }
  return out;
}
