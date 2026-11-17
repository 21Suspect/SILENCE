import { placeAt } from '../sim/world/places';
import { idsKey, ringedPlaceIds, type MapItem } from '../sim/world/map-shapes';
import { loadMapData, loadMapDataNow, renderMap, runSliced, runNow, paintPencil, type MapSheet } from './map-art';

/** Seconds the sheet takes to unfold and fade in or out. */
export const MAP_FADE = .4;
/** The sheet is about 70% of the window's height (a map on the table, not the whole screen); its width is the island's own shape plus the legend strip (map-art.ts). */
export const SHEET_HEIGHT = .7, SHEET_MIN_HEIGHT = 480, STRIP = 236, ISLAND_ASPECT = 1.11;
export function sheetBox(cw: number, ch: number) {
  let h = Math.max(SHEET_MIN_HEIGHT, ch * SHEET_HEIGHT), w = h * ISLAND_ASPECT + STRIP;
  if (w > cw * .94) { w = cw * .94; h = (w - STRIP) / ISLAND_ASPECT; }
  if (h > ch * .94) { h = ch * .94; w = h * ISLAND_ASPECT + STRIP; }
  return { w: Math.round(w), h: Math.round(h) };
}

export type IslandMapOptions = {
  /** Called as it opens and closes, so the engine can free the mouse and take it back. */
  onOpenChange?: (open: boolean) => void;
};

/**
 * The paper map: opened and closed with M. It is the survey sheet of game/ui/map-art.ts, drawn from this run's layout, in slices after
 * start (so the first M finds it ready; if not, it is finished at once). What is shown is that picture and what changes: the pencil
 * rings round places that still hold a missing part and, only while the player stands inside a named place, a small cross there as
 * if read off its sign. It says nothing about where the player is anywhere else. The game goes on while it is open.
 */
export function createIslandMap(container: HTMLElement, o: IslandMapOptions = {}) {
  const style = document.createElement('style');
  style.textContent = `
  .sl-map{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;background:rgba(6,6,5,.62);opacity:0;pointer-events:none;transition:opacity ${MAP_FADE}s ease}
  .sl-map.open{opacity:1;pointer-events:auto}
  .sl-map canvas{display:block;transform:rotate(-.5deg) scale(.96);transition:transform ${MAP_FADE}s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 12px 28px rgba(0,0,0,.75))}
  .sl-map.open canvas{transform:rotate(-.5deg) scale(1)}`;
  document.head.appendChild(style);
  const root = document.createElement('div'); root.className = 'sl-map'; root.setAttribute('aria-hidden', 'true');
  const view = document.createElement('canvas');
  root.append(view); container.appendChild(root);

  let sheet: MapSheet | undefined, sheetKey = '', building: string | undefined, open = false, disposed = false;
  let ringKey = '', ringIds: Set<string> = new Set(), hereId: string | undefined, drawnKey = '#', started = false;

  const sheetSize = () => {
    const cw = Math.max(320, container.clientWidth || innerWidth), ch = Math.max(240, container.clientHeight || innerHeight);
    const { w, h } = sheetBox(cw, ch);
    // Pixels: as many as the screen shows, but not past ~2.6 M so the one-off drawing stays short on a big display.
    const dpr = Math.min(devicePixelRatio || 1, Math.sqrt(3e6 / (w * h)), 2);
    return { w: Math.round(w), h: Math.round(h), dpr };
  };
  const keyOf = (s: { w: number; h: number; dpr: number }) => `${s.w}x${s.h}@${s.dpr.toFixed(2)}`;
  const install = (s: ReturnType<typeof sheetSize>, made: MapSheet) => {
    sheet = made; sheetKey = keyOf(s);
    view.width = made.canvas.width; view.height = made.canvas.height; view.style.width = s.w + 'px'; view.style.height = s.h + 'px'; drawnKey = '#';
  };

  /** Draws the sheet in slices; if it is wanted now (`urgent`), at once. */
  function ensure(urgent: boolean) {
    const s = sheetSize(), key = keyOf(s);
    if (sheet && key === sheetKey) return;
    if (urgent) { building = undefined; install(s, runNow(g => renderMap(loadMapDataNow(), { ...s, style: 'sheet' }, g))); return; }
    if (building === key) return;
    building = key;
    void loadMapData().then(data => runSliced(g => renderMap(data, { ...s, style: 'sheet' }, g))).then(made => { if (!disposed && building === key) { building = undefined; install(s, made); if (open) paint(); } });
  }

  /** The picture on show: the cached sheet, the rings, the cross. One blit and a few strokes, and only when they change. */
  function paint() {
    if (!sheet) return;
    const key = `${ringKey}@${hereId ?? ''}`;
    if (key === drawnKey) return;
    drawnKey = key;
    const g = view.getContext('2d')!;
    g.clearRect(0, 0, view.width, view.height);
    g.drawImage(sheet.canvas, 0, 0);
    paintPencil(g, sheet, ringIds, hereId);
  }

  const api = {
    get isOpen() { return open; },
    open() {
      if (open || disposed) return;
      ensure(true); paint();
      open = true; root.classList.add('open'); root.setAttribute('aria-hidden', 'false'); o.onOpenChange?.(true);
    },
    close() {
      if (!open) return;
      open = false; root.classList.remove('open'); root.setAttribute('aria-hidden', 'true'); o.onOpenChange?.(false);
    },
    toggle() { if (open) api.close(); else api.open(); },
    /** The player's ground position and what the run holds; call a few times a second. Draws only when the rings or the cross change. */
    update(x: number, z: number, items?: Record<string, MapItem>) {
      const ids = ringedPlaceIds(items), key = idsKey(ids);
      if (key !== ringKey) { ringKey = key; ringIds = ids; }
      hereId = placeAt(x, z)?.id;
      if (!started && !disposed) { started = true; ensure(false); }
      if (open) paint();
    },
    dispose() {
      disposed = true;
      if (open) o.onOpenChange?.(false);
      root.remove(); style.remove();
    },
  };
  root.addEventListener('click', () => api.close());
  return api;
}
