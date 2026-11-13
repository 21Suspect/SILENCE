import type { Slot } from '../sim/objectives/objectives';

/** Opens and closes the backpack. Fixed rather than rebindable, like O; the engine stands aside if a player has bound I to something else. */
export const INVENTORY_KEY = 'KeyI';
/** Three across, four down: an upright column takes less of the view than a wide row. */
export const INVENTORY_COLUMNS = 3, INVENTORY_ROWS = 4;
/** Seconds the panel takes to slide and fade in or out. */
export const INVENTORY_FADE = .32;

export type InventoryItem = { id: string; name: string; icon: string };
export type InventoryView = { hasPack: boolean; hand: InventoryItem | null; slots: (InventoryItem | null)[] };
export type InventoryOptions = {
  /** What is carried right now. Read whenever the panel opens and after every move or drop. */
  read: () => InventoryView;
  /** Rearrange: the item at `from` goes to `to`, swapping with what is there. */
  move: (from: Slot, to: Slot) => void;
  /** Put the item at `slot` down in the world, in front of the player. */
  drop: (slot: Slot) => void;
  /** Called as it opens and closes, so the engine can free the mouse and take it back. */
  onOpenChange?: (open: boolean) => void;
};

/**
 * The backpack: a panel that slides in from the right over a plain Gaussian blur (no tint) that covers that side, reaches past
 * the panel and fades out beyond it, so the panel always sits inside the blur and the wood stays sharp on the left. The hand is
 * its own slot above a 3 x 4 grid. Drag an item onto another slot to
 * rearrange (they swap), drag it out of the panel onto the wood to put it down. Pointer events only, so a mouse and a finger
 * both work. Without a backpack the grid is shown locked, and says so.
 */
export function createInventory(container: HTMLElement, o: InventoryOptions) {
  const style = document.createElement('style');
  style.textContent = `
  .sl-inv{position:absolute;inset:0 0 0 auto;width:min(100%,460px);z-index:6;pointer-events:none;font:400 13px/1.4 system-ui,sans-serif;letter-spacing:.05em;color:#dcd8c9}
  .sl-inv::before{content:"";position:absolute;inset:0;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
    -webkit-mask-image:linear-gradient(to left,#000 calc(100% - 150px),transparent);mask-image:linear-gradient(to left,#000 calc(100% - 150px),transparent);
    opacity:0;transition:opacity ${INVENTORY_FADE}s ease}
  .sl-inv-body{position:absolute;right:max(36px,env(safe-area-inset-right));top:50%;width:min(236px,calc(100% - 72px));transform:translate(48px,-50%);opacity:0;
    transition:transform ${INVENTORY_FADE}s cubic-bezier(.2,.8,.2,1),opacity ${INVENTORY_FADE}s ease;text-shadow:0 1px 3px #000}
  .sl-inv.open{pointer-events:auto}.sl-inv.open::before{opacity:1}.sl-inv.open .sl-inv-body{transform:translate(0,-50%);opacity:1}
  .sl-inv h2{margin:0 0 14px;font:500 12px/1 system-ui,sans-serif;letter-spacing:.28em;text-transform:uppercase;color:#cfcab8}
  .sl-inv-label{margin:0 0 6px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#8b8c80}
  .sl-inv-grid{display:grid;grid-template-columns:repeat(${INVENTORY_COLUMNS},1fr);gap:7px}
  .sl-inv-hand{width:calc((100% - 14px)/3);margin-bottom:16px}
  .sl-inv-slot{position:relative;aspect-ratio:1;border:1px solid rgba(220,216,201,.16);border-radius:5px;background:rgba(20,21,18,.42);box-shadow:inset 0 0 14px rgba(0,0,0,.45);
    transition:border-color .12s,background .12s;touch-action:none}
  .sl-inv-slot.hover{border-color:rgba(232,214,160,.7);background:rgba(60,56,40,.42)}
  .sl-inv-slot img{position:absolute;inset:8%;width:84%;height:84%;object-fit:contain;filter:drop-shadow(0 2px 3px rgba(0,0,0,.7));cursor:grab;user-select:none;-webkit-user-drag:none}
  .sl-inv-slot.lifted img{opacity:.25}
  .sl-inv-name{position:absolute;left:4px;right:4px;bottom:2px;font-size:9px;letter-spacing:.06em;color:#a9a89b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
  .sl-inv-grid.locked{opacity:.35}
  .sl-inv-note{margin-top:12px;font-size:11px;color:#a9a89b;min-height:1.4em}
  .sl-inv-hint{margin-top:6px;font-size:10px;letter-spacing:.12em;color:#7d7e73}
  .sl-inv-ghost{position:fixed;z-index:7;width:64px;height:64px;pointer-events:none;transform:translate(-50%,-50%);filter:drop-shadow(0 4px 8px rgba(0,0,0,.8));opacity:.95}`;
  document.head.appendChild(style);

  const root = document.createElement('div'); root.className = 'sl-inv'; root.setAttribute('aria-hidden', 'true');
  const body = document.createElement('div'); body.className = 'sl-inv-body';
  const title = document.createElement('h2'); title.textContent = 'Backpack';
  const handLabel = document.createElement('div'); handLabel.className = 'sl-inv-label'; handLabel.textContent = 'In hand';
  const hand = slotElement('hand'); hand.classList.add('sl-inv-hand');
  const packLabel = document.createElement('div'); packLabel.className = 'sl-inv-label'; packLabel.textContent = 'Pack';
  const grid = document.createElement('div'); grid.className = 'sl-inv-grid';
  const cells = Array.from({ length: INVENTORY_COLUMNS * INVENTORY_ROWS }, (_, i) => slotElement(i));
  grid.append(...cells);
  const note = document.createElement('div'); note.className = 'sl-inv-note';
  const hint = document.createElement('div'); hint.className = 'sl-inv-hint'; hint.textContent = 'Drag to rearrange · drag out to drop · I to close';
  body.append(title, handLabel, hand, packLabel, grid, note, hint);
  root.append(body);
  container.appendChild(root);

  let open = false, view: InventoryView = { hasPack: false, hand: null, slots: [] };
  function slotElement(slot: Slot) { const el = document.createElement('div'); el.className = 'sl-inv-slot'; el.dataset.slot = String(slot); return el; }
  const elementOf = (slot: Slot) => slot === 'hand' ? hand : cells[slot];
  const itemAt = (slot: Slot) => slot === 'hand' ? view.hand : view.slots[slot] ?? null;
  const slotOf = (el: Element | null): Slot | undefined => {
    const cell = el?.closest?.('.sl-inv-slot') as HTMLElement | null;
    if (!cell || !root.contains(cell)) return undefined;
    return cell.dataset.slot === 'hand' ? 'hand' : Number(cell.dataset.slot);
  };

  function paint(el: HTMLElement, item: InventoryItem | null) {
    const key = item ? `${item.id}|${item.icon}` : '';
    if (el.dataset.item === key) return;
    el.dataset.item = key; el.replaceChildren();
    if (!item) { el.title = ''; return; }
    const img = document.createElement('img'); img.src = item.icon; img.alt = item.name; img.draggable = false;
    const name = document.createElement('div'); name.className = 'sl-inv-name'; name.textContent = item.name;
    el.title = item.name; el.append(img, name);
  }
  function refresh() {
    view = o.read();
    paint(hand, view.hand);
    cells.forEach((cell, i) => paint(cell, view.hasPack ? view.slots[i] ?? null : null));
    grid.classList.toggle('locked', !view.hasPack);
    title.textContent = view.hasPack ? 'Backpack' : 'Carrying';
    note.textContent = view.hasPack ? '' : 'No backpack: you can carry one thing. There was one in the cabin.';
  }

  // --- drag and drop ------------------------------------------------------------------------------------------------
  let drag: { from: Slot; pointer: number; ghost: HTMLImageElement; over?: Slot } | undefined;
  const setHover = (slot: Slot | undefined) => {
    if (drag?.over !== undefined) elementOf(drag.over).classList.remove('hover');
    if (drag) drag.over = slot;
    if (slot !== undefined) elementOf(slot).classList.add('hover');
  };
  const outside = (x: number) => x < body.getBoundingClientRect().left - 24;
  function down(e: PointerEvent) {
    if (!open || drag || e.button > 0) return;
    const from = slotOf(e.target as Element), item = from === undefined ? null : itemAt(from);
    if (from === undefined || !item || (from !== 'hand' && !view.hasPack)) return;
    e.preventDefault();
    const ghost = document.createElement('img'); ghost.className = 'sl-inv-ghost'; ghost.src = item.icon; ghost.alt = '';
    ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`;
    document.body.appendChild(ghost);
    drag = { from, pointer: e.pointerId, ghost };
    elementOf(from).classList.add('lifted');
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function moveTo(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.ghost.style.left = `${e.clientX}px`; drag.ghost.style.top = `${e.clientY}px`;
    const over = slotOf(document.elementFromPoint(e.clientX, e.clientY));
    const allowed = over !== undefined && over !== drag.from && (over === 'hand' || view.hasPack) ? over : undefined;
    if (allowed !== drag.over) setHover(allowed);
    // Out over the wood: what is let go there is put down.
    drag.ghost.style.opacity = outside(e.clientX) ? '.6' : '.95';
  }
  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const { from, over, ghost } = drag, out = outside(e.clientX);
    setHover(undefined);
    elementOf(from).classList.remove('lifted');
    ghost.remove(); drag = undefined;
    if (e.type === 'pointercancel') return;
    if (over !== undefined) o.move(from, over);
    else if (out) o.drop(from);
    refresh();
  }
  root.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', moveTo);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  function setOpen(next: boolean) {
    if (next === open) return;
    open = next;
    if (open) refresh();
    else if (drag) { drag.ghost.remove(); elementOf(drag.from).classList.remove('lifted'); setHover(undefined); drag = undefined; }
    root.classList.toggle('open', open);
    root.setAttribute('aria-hidden', String(!open));
    o.onOpenChange?.(open);
  }

  return {
    get open() { return open; },
    toggle() { setOpen(!open); },
    show() { setOpen(true); },
    close() { setOpen(false); },
    /** Redraw from `read()`: call when carried things change while the panel is open (a pickup, a drop with Q). */
    refresh() { if (open) refresh(); },
    dispose() {
      setOpen(false);
      root.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', moveTo);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      root.remove(); style.remove();
    },
  };
}
