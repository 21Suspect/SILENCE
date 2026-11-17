/**
 * The ending, kept simple until a cutscene replaces it: the screen fades to black, a card says "You got off the island.", and the
 * caller is told when the card is up (the engine wins the run there). Above every other overlay, as the death card is. The card's
 * elements are made the first time it plays.
 */
export type EndingCardOptions = { title?: string; line?: string; fadeSeconds?: number; holdSeconds?: number };

export function createEndingCard(container: HTMLElement, options: EndingCardOptions = {}) {
  const doc = container.ownerDocument, fade = options.fadeSeconds ?? 3.2;
  let el: HTMLElement | undefined, title!: HTMLElement, line!: HTMLElement, timer: ReturnType<typeof setTimeout> | undefined, shown = false;
  function build() {
    el = doc.createElement('div'); title = doc.createElement('div'); line = doc.createElement('div');
    el.setAttribute('role', 'status');
    el.style.cssText = `position:absolute;inset:0;z-index:60;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#000;opacity:0;pointer-events:none;transition:opacity ${fade}s ease;color:#dcd8c9;text-align:center;font:400 15px/1.4 system-ui,sans-serif;letter-spacing:.2em`;
    title.textContent = options.title ?? 'You got off the island.';
    title.style.cssText = 'font-size:22px;letter-spacing:.14em;opacity:0;transition:opacity 2.4s ease 1.6s';
    line.textContent = options.line ?? '';
    line.style.cssText = 'font-size:12px;color:#8b8c80;opacity:0;transition:opacity 2.4s ease 3s';
    el.appendChild(title); el.appendChild(line); container.appendChild(el);
  }
  return {
    /** Fade out and show the card; `done` runs once the card is up. */
    play(done?: () => void) {
      if (shown) return; shown = true;
      if (!el) build();
      el!.style.display = 'flex'; el!.style.pointerEvents = 'auto'; void el!.offsetWidth;
      el!.style.opacity = '1'; title.style.opacity = '1'; line.style.opacity = '1';
      timer = setTimeout(() => { done?.(); }, (fade + (options.holdSeconds ?? 1.5)) * 1000);
    },
    get playing() { return shown; },
    reset() {
      clearTimeout(timer); shown = false; if (!el) return;
      el.style.transition = 'none'; el.style.opacity = '0'; title.style.opacity = '0'; line.style.opacity = '0'; el.style.display = 'none'; el.style.pointerEvents = 'none'; void el.offsetWidth; el.style.transition = `opacity ${fade}s ease`;
    },
    dispose() { clearTimeout(timer); el?.remove(); },
  };
}
export type EndingCard = ReturnType<typeof createEndingCard>;
