import { POI_PLACEMENTS, LANDING_PAD, placeLocal } from '../../sim/world/world-layout';
import type { Placement, PoiAsset } from './pois';
import { seatPlacement } from './pois';
import worldAssets from '../../data/world-assets.json';

/**
 * The extra places the run needs, set beside what the layout already placed (the landing pad itself is the layout's 'landing-pad',
 * pushed in world-layout.ts so the terrain is levelled and the trees stand back from it):
 *   - the pad's generator, a few metres from its junction box, turned so its cable end faces the box;
 *   - the crate that is the pad's bank, and the crate that is the relay hut's;
 *   - the second notice board, beside the cabin's door (the board that lists the helicopter's parts);
 *   - the cabin's chest (a crate: there is no chest model yet), which stands on the cabin's floor and so is not a layout placement.
 * Everything here is data and a little maths; world-v2.ts hands the placements to createPois.
 */
export const PAD_ID = 'landing-pad', PAD_GENERATOR_ID = 'pad-generator', PAD_CRATE_ID = 'pad-crate', RELAY_CRATE_ID = 'relay-crate', CABIN_BOARD_ID = 'cabin-board';
const assets = worldAssets as unknown as Record<string, PoiAsset>;
const find = (id: string) => POI_PLACEMENTS.find(p => p.id === id);

/** The pad's own frame: the pad-local point as a world x/z. */
export const padPoint = (lx: number, lz: number) => placeLocal(LANDING_PAD, lx, lz);

/** The generator's place in the pad's frame, and the junction box (hook `cable_in`) it feeds, as a model-local point of the pad. */
const GENERATOR_AT: readonly [number, number] = [10.2, 3.4];
/** Which end of the generator the cable leaves from, in its own frame (its long side, x). */
export const GENERATOR_CABLE_END: readonly [number, number, number] = [1.1, .5, 0];

export function runPlacements(): Placement[] {
  const out: Placement[] = [];
  const [gx, gz] = padPoint(GENERATOR_AT[0], GENERATOR_AT[1]);
  const hook = assets.helipad?.hooks?.cable_in;
  if (hook) {
    const [bx, bz] = padPoint(hook[0], hook[2]);
    // Its local +x turns to the junction box: placeLocal sends local +x to world (cos yaw, -sin yaw).
    out.push({ id: PAD_GENERATOR_ID, asset: 'generator', x: gx, z: gz, yaw: Math.atan2(-(bz - gz), bx - gx), footprint: { cx: 0, cz: 0, hx: 1.15, hz: .55 } });
  }
  const [cx, cz] = padPoint(9.2, -3.6);
  out.push({ id: PAD_CRATE_ID, asset: 'crate', x: cx, z: cz, yaw: LANDING_PAD.yaw + .35 });
  const hut = find('relay-hut');
  if (hut) { const [x, z] = placeLocal(hut, -3.5, .6); out.push({ id: RELAY_CRATE_ID, asset: 'crate', x, z, yaw: hut.yaw + Math.PI / 2 }); }
  const cabin = find('cabin');
  if (cabin) {
    // Beside the door's left, off the porch: the board is 2.5 m across and faces out from the cabin's front.
    const [x, z] = placeLocal(cabin, -5.7, 4.6);
    out.push({ id: CABIN_BOARD_ID, asset: 'noticeboard', x, z, yaw: cabin.yaw, footprint: { cx: 0, cz: 0, hx: 1.5, hz: .35 } });
  }
  return out;
}

/** Where the cabin's chest stands (the back corner opposite the bed, on the floor, 42 cm above the ground). */
export function chestSite(heightAt: (x: number, z: number) => number) {
  const cabin = find('cabin'), def = assets.cabin;
  if (!cabin || !def) return undefined;
  const ground = seatPlacement(def, cabin, heightAt).ground, [x, z] = placeLocal(cabin, -2.55, -1.8);
  return { x, z, y: ground + .42, yaw: cabin.yaw + .12 };
}
