import * as THREE from 'three';
import { loadMapData, renderMap, runSliced, paintPencil, type MapSheet } from '../../ui/map-art';
import { idsKey, ringedPlaceIds, type MapItem } from '../../sim/world/map-shapes';

/** Where the old baked poster hangs, in the noticeboard model's frame (tools/assets/world-v2/models_small.py noticeboard(): poster at (-.42, 1.62, .027), 1.18 m square, facing +z). */
const POSTER = { x: -.42, y: 1.62, z: .027, size: 1.18 };
/** A few millimetres proud of the poster, with a depth bias for the distance where that gap stops resolving. */
const STAND_OFF = .004;
/** Texels across the print: 870 to the metre, as sharp as the board is looked at. */
const SIZE = 1024;

export type BoardMapOptions = {
  pois: { objectOf(id: string): THREE.Object3D | undefined };
  /** Placement ids of the noticeboards that carry the map (the cabin's and the trailhead's). */
  boards: readonly string[];
  /** The board that also shows the pencil rings for the parts still lying out. */
  ringBoard: string;
  items: () => Record<string, MapItem>;
};

/**
 * The map on the notice boards: this run's own layout (the baked trail_map poster shows an old island), printed to a canvas in slices
 * after start and hung as a thin lit plane just over the poster, as a child of the board's own drawn copy so it is only ever there
 * when the board is. The cabin's board has the pencil rings too, redrawn only when the set of ringed places changes.
 */
export function createBoardMaps(o: BoardMapOptions) {
  let sheet: MapSheet | undefined, ringCanvas: HTMLCanvasElement | undefined, disposed = false, ringKey = '#', lastCheck = -1;
  const textures = new Map<string, THREE.CanvasTexture>(), planes = new Map<string, THREE.Mesh>();
  const geometry = new THREE.PlaneGeometry(POSTER.size, POSTER.size), materials: THREE.Material[] = [];

  const texture = (canvas: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    return t;
  };

  // Without a document (the world built under node for tests and the playtest bot) there is nothing to print on: the boards keep
  // their baked poster, and no slice is left running after a test has ended.
  if (typeof document !== 'undefined') void loadMapData().then(data => runSliced(g => renderMap(data, { w: SIZE, h: SIZE, dpr: 1, style: 'board' }, g))).then(made => {
    if (disposed) return;
    sheet = made;
    ringCanvas = document.createElement('canvas'); ringCanvas.width = made.canvas.width; ringCanvas.height = made.canvas.height;
    for (const id of o.boards) textures.set(id, texture(id === o.ringBoard ? ringCanvas : made.canvas));
    ringKey = '#'; lastCheck = -1;
  });

  function paintRings() {
    if (!sheet || !ringCanvas) return;
    const items = o.items(), ids = ringedPlaceIds(items), key = idsKey(ids);
    if (key === ringKey) return;
    ringKey = key;
    const g = ringCanvas.getContext('2d')!;
    g.clearRect(0, 0, ringCanvas.width, ringCanvas.height); g.drawImage(sheet.canvas, 0, 0);
    paintPencil(g, sheet, ids, undefined);
    const t = textures.get(o.ringBoard); if (t) t.needsUpdate = true;
  }

  return {
    /** Call each frame with the run's clock (seconds): hangs the print on each board as its model arrives, and keeps the rings current. */
    update(time: number) {
      if (!sheet || disposed) return;
      for (const id of o.boards) {
        if (planes.has(id)) continue;
        const board = o.pois.objectOf(id), tex = textures.get(id);
        if (!board || !tex) continue;
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: .93, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        materials.push(mat);
        const plane = new THREE.Mesh(geometry, mat);
        plane.name = 'Board map'; plane.position.set(POSTER.x, POSTER.y, POSTER.z + STAND_OFF); plane.receiveShadow = true;
        plane.updateMatrix(); plane.matrixAutoUpdate = false;
        board.add(plane); board.updateMatrixWorld(true); planes.set(id, plane);
      }
      if (time - lastCheck > .5 || time < lastCheck) { lastCheck = time; paintRings(); }
    },
    /** The cabin board's print, rings and all, for the board panel; undefined until it is drawn. */
    canvas(): HTMLCanvasElement | undefined { paintRings(); return ringCanvas; },
    dispose() {
      disposed = true;
      for (const plane of planes.values()) plane.removeFromParent();
      planes.clear(); for (const t of textures.values()) t.dispose(); textures.clear(); for (const m of materials) m.dispose(); geometry.dispose();
    },
  };
}
export type BoardMaps = ReturnType<typeof createBoardMaps>;
