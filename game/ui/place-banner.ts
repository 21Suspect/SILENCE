/** The name that shows, centred near the top, when you walk into one of the island's named places. */
export const BANNER_SECONDS = 3;
/** Seconds away from a place before walking into it shows its name again. */
export const BANNER_AWAY = 60;

/**
 * When to show a name: on walking into a place (it differs from the one you were in), unless you were in it less than
 * BANNER_AWAY seconds ago. `lastIn` holds the last moment each place had you inside; walking out and straight back keeps it fresh.
 */
export function createBannerTracker(away = BANNER_AWAY) {
  const lastIn = new Map<string, number>();
  let current: string | undefined;
  return {
    /** The place the player stands in (or undefined) at `now` seconds: returns its id when its name should show. */
    update(id: string | undefined, now: number): string | undefined {
      if (id === current) { if (id) lastIn.set(id, now); return undefined; }
      current = id;
      if (!id) return undefined;
      const before = lastIn.get(id);
      lastIn.set(id, now);
      return before === undefined || now - before >= away ? id : undefined;
    },
  };
}

export function createPlaceBanner(container: HTMLElement) {
  const style = document.createElement('style');
  style.textContent = `
  @keyframes sl-place{0%{opacity:0;transform:translateX(-50%) translateY(-4px)}22%{opacity:1;transform:translateX(-50%)}74%{opacity:1}100%{opacity:0;transform:translateX(-50%)}}
  .sl-place{position:absolute;left:50%;top:max(12%,env(safe-area-inset-top));transform:translateX(-50%);opacity:0;pointer-events:none;z-index:3;white-space:nowrap;
    font:400 15px/1.3 Georgia,'Times New Roman',serif;font-variant:small-caps;letter-spacing:.34em;text-indent:.34em;color:#e4dfcf;text-shadow:0 1px 3px #000,0 0 18px rgba(0,0,0,.8)}
  .sl-place.on{animation:sl-place ${BANNER_SECONDS}s ease-in-out both}`;
  document.head.appendChild(style);
  const el = document.createElement('div'); el.className = 'sl-place'; el.setAttribute('aria-hidden', 'true');
  container.appendChild(el);
  return {
    /** Show `title`, restarting the fade if one is still on screen. */
    show(title: string) {
      el.textContent = title; el.classList.remove('on');
      void el.offsetWidth;
      el.classList.add('on');
    },
    dispose() { el.remove(); style.remove(); },
  };
}
