/**
 * The notice board at the cabin, read: a sheet of paper with the helicopter's parts, one line each, as boardLines(state) words them.
 * Shown over the game in the face of the other panels (inventory.ts): quiet type on a dark ground, here a pale sheet. E, Escape or a
 * click closes it, and so does walking away from the board. Nothing here moves the game on: the panel only reads.
 */
export type BoardPanelOptions = {
  lines: () => string[];
  /** Key codes that close it (the interact key, Escape). */
  closeKeys?: () => string[];
  /** The island's map as drawn for the board (the same print, pencil rings and all); shown beside the list when there is one. */
  map?: () => HTMLCanvasElement | undefined;
};

export function createBoardPanel(container: HTMLElement, options: BoardPanelOptions) {
  const doc = container.ownerDocument;
  // Built when it is first opened, not before: most runs read the board a few times and the world is built long before the first.
  let el!: HTMLElement, list!: HTMLElement, hint!: HTMLElement, mapView!: HTMLCanvasElement, built = false;
  function build() {
    built = true;
    el = doc.createElement('div'); const paper = doc.createElement('div'), column = doc.createElement('div'), title = doc.createElement('h2'); list = doc.createElement('ul'); hint = doc.createElement('div'); mapView = doc.createElement('canvas');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Notice board');
    el.style.cssText = 'position:absolute;inset:0;z-index:30;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);opacity:0;transition:opacity 180ms ease;font:400 14px/1.5 system-ui,sans-serif;letter-spacing:.04em;color:#2c2a22';
    paper.style.cssText = 'width:min(92%,880px);max-height:92%;overflow:auto;box-sizing:border-box;display:flex;flex-wrap:wrap;gap:26px;align-items:flex-start;justify-content:center;padding:26px 30px 20px;background:#d8d1b9;background-image:linear-gradient(rgba(120,100,60,.08),rgba(60,50,30,.18));border:1px solid #8b8466;box-shadow:0 10px 40px rgba(0,0,0,.7),inset 0 0 40px rgba(90,75,40,.28);transform:rotate(-.6deg)';
    title.textContent = 'Needed to get off the island';
    title.style.cssText = 'margin:0 0 14px;font:600 12px/1.2 system-ui,sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#4a4636';
    list.style.cssText = 'margin:0;padding:0;list-style:none';
    hint.style.cssText = 'margin-top:16px;font-size:10px;letter-spacing:.16em;color:#6f6a55;text-align:right';
    // The print on the left, square, so "around the chapel" can be found on it; the list on the right.
    mapView.style.cssText = 'display:none;flex:0 1 380px;width:380px;max-width:100%;aspect-ratio:1;box-shadow:0 3px 12px rgba(0,0,0,.45);border:1px solid rgba(70,60,40,.5)';
    column.style.cssText = 'flex:1 1 300px;min-width:260px;max-width:430px';
    column.appendChild(title); column.appendChild(list); column.appendChild(hint); paper.appendChild(mapView); paper.appendChild(column); el.appendChild(paper); container.appendChild(el);
  }

  let shown = false, openedAt = -Infinity;
  const keys = () => options.closeKeys?.() ?? ['KeyE', 'Escape'];
  const onKey = (e: KeyboardEvent) => {
    if (!shown || !keys().includes(e.code)) return;
    // Swallowed: the interact key must not also reach for whatever is behind the board, nor Escape pause the game.
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'keydown' && !e.repeat && Date.now() - openedAt > 150) close();
  };
  const onClick = (e: Event) => { e.stopPropagation(); close(); };

  function render() {
    list.textContent = '';
    const src = options.map?.();
    if (src) { mapView.width = src.width; mapView.height = src.height; mapView.getContext('2d')?.drawImage(src, 0, 0); mapView.style.display = 'block'; } else mapView.style.display = 'none';
    const lines = options.lines();
    for (const text of lines.length ? lines : ['Nothing is listed.']) {
      const li = doc.createElement('li');
      // "# Heading" starts a group (boardLines): a small caps line, no rule.
      if (text.startsWith('# ')) { li.textContent = text.slice(2); li.style.cssText = 'padding:12px 0 3px;font:600 11px/1.3 system-ui,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#4a4636'; list.appendChild(li); continue; }
      const cut = text.indexOf(':');
      li.style.cssText = 'padding:5px 0;border-bottom:1px dashed rgba(70,60,40,.35)';
      if (cut > 0) { const name = doc.createElement('b'), where = doc.createElement('span'); name.textContent = text.slice(0, cut + 1); name.style.cssText = 'font-weight:600;color:#2c2a22'; where.textContent = text.slice(cut + 1); where.style.color = '#4a4636'; li.appendChild(name); li.appendChild(where); }
      else li.textContent = text;
      list.appendChild(li);
    }
    hint.textContent = `${(keys()[0] ?? 'E').replace(/^Key/, '')} to close`;
  }
  function open() {
    if (shown) return;
    if (!built) build();
    shown = true; openedAt = Date.now(); render();
    el.style.display = 'flex'; void el.offsetWidth; el.style.opacity = '1';
    doc.defaultView?.addEventListener('keydown', onKey, true); doc.defaultView?.addEventListener('keyup', onKey, true);
    el.addEventListener('click', onClick);
  }
  function close() {
    if (!shown) return;
    shown = false; el.style.opacity = '0';
    doc.defaultView?.removeEventListener('keydown', onKey, true); doc.defaultView?.removeEventListener('keyup', onKey, true);
    el.removeEventListener('click', onClick);
    setTimeout(() => { if (!shown) el.style.display = 'none'; }, 200);
  }
  return {
    open, close,
    /** Close when the player walks off; refresh the lines while it is up. `distance` is metres to the board. */
    update(distance: number) { if (shown && distance > 4.2) close(); },
    get isOpen() { return shown; },
    get text() { return list.textContent ?? ''; },
    dispose() { close(); if (built) el.remove(); },
  };
}
export type BoardPanel = ReturnType<typeof createBoardPanel>;
