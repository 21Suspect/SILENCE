import type { ObjectiveText } from '../sim/objectives/objective-text';

/** Shows or hides the objective. Fixed rather than rebindable; the engine stands aside if a player has bound it to something else. */
export const OBJECTIVE_KEY = 'KeyO';
/** Seconds of being on screen during which the corner also says which key hides it. The objective itself never times out. */
export const OBJECTIVE_HINT_SECONDS = 7;
/** Seconds a fade takes, in and out. */
export const OBJECTIVE_FADE = .8;
const SWAP = .45;

export type ObjectiveHudOptions = {
  /** Touch screens have no key: a tap on the corner does the job of O, and the hint says so. Default: a coarse pointer. */
  touch?: boolean;
  /**
   * Whether the objective is shown. This is the saved "objective hint" setting: on by default, and the one thing O (or a tap)
   * flips, so the choice survives a reload. Default: an in-memory flag that starts on.
   */
  enabled?: () => boolean;
  /** Called with the new value when O or a tap hides or shows it; the owner of the setting stores it. Default: the in-memory flag. */
  setEnabled?: (on: boolean) => void;
  /** What the key is called in the hint. */
  keyName?: string;
};
export type ObjectiveHudFrame = {
  /** Milliseconds, any steady clock (the animation frame's). */
  now: number;
  /** False while paused, loading, taken or out of the window: the objective is gone at once. */
  allowed: boolean;
  text: ObjectiveText | undefined;
};

/**
 * The objective in the top-left corner: small and quiet, in the interaction prompt's type. It is always there during play:
 * it fades up when play starts and stays, with the words swapping softly whenever the step or its progress changes. O (or a
 * tap on touch) hides it, and O again shows it; the choice is the saved setting, so it is still hidden or shown after a
 * reload. Menus, the death card and loading cover it at once. For its first few seconds on screen it also says which key
 * hides it. Call `update` once a frame; the DOM is only written when something differs from what is already there.
 */
export function createObjectiveHud(container: HTMLElement, options: ObjectiveHudOptions = {}) {
  const touch = options.touch ?? (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  let local = true;
  const isOn = options.enabled ?? (() => local), setOn = options.setEnabled ?? ((on: boolean) => { local = on; });
  const verb = touch ? 'Tap' : options.keyName ?? 'O';
  const doc = container.ownerDocument, make = () => doc.createElement('div');
  const el = make(), body = make(), title = make(), detail = make(), hint = make();
  const fade = `opacity ${OBJECTIVE_FADE * 1000}ms ease`;
  el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  // The prompt's face, a notch smaller. Beneath the pause button's corner (z 4) and every overlay, so a menu or the death card covers it.
  el.style.cssText = `position:absolute;left:max(16px,env(safe-area-inset-left));top:max(14px,env(safe-area-inset-top));max-width:calc(100% - 96px);pointer-events:none;z-index:3;opacity:0;transition:${fade};font:400 13px/1.4 system-ui,sans-serif;letter-spacing:.05em;color:#dcd8c9;text-shadow:0 1px 3px #000,0 0 14px rgba(0,0,0,.75);touch-action:manipulation`;
  detail.style.cssText = 'font-size:12px;color:#a9a89b';
  hint.style.cssText = `margin-top:5px;font-size:10px;letter-spacing:.14em;color:#8b8c80;opacity:0;transition:${fade}`;
  body.appendChild(title); body.appendChild(detail); el.appendChild(body); el.appendChild(hint);
  container.appendChild(el);

  // `seen` is the seconds the corner has been on screen, up to the hint's allowance.
  let key = '', seen = 0, allowedNow = false, lastNow: number | undefined, swap = false;
  // What the DOM already holds, so a frame that changes nothing writes nothing.
  let opacity = '0', transition = fade, events = 'none', hintOpacity = '0', hintText = '';

  function update({ now, allowed, text }: ObjectiveHudFrame) {
    const dt = lastNow === undefined ? 0 : Math.min(.25, Math.max(0, (now - lastNow) / 1000)); lastNow = now; allowedNow = allowed;
    // The text that changed under a visible element dipped out last frame; bring it back up.
    if (swap) { swap = false; body.style.transition = `opacity ${SWAP * 1000}ms ease`; body.style.opacity = '1'; }
    if (text) {
      const next = `${text.title}\n${text.detail ?? ''}`;
      if (next !== key) {
        const showing = opacity === '1' && key !== '';
        key = next;
        if (text.title !== title.textContent) title.textContent = text.title;
        if ((text.detail ?? '') !== detail.textContent) detail.textContent = text.detail ?? '';
        if (showing) { body.style.transition = 'none'; body.style.opacity = '0'; swap = true; } // not a pop: the new words fade up
      }
    }
    // Shown whenever the player wants it and play is going on; there is nothing to show until the first words arrive.
    const visible = isOn() && allowed && key !== '';
    if (visible) seen = Math.min(OBJECTIVE_HINT_SECONDS, seen + dt);
    // Fading is for the player's own pace (O, or the start of play); going behind a menu or the death card is immediate.
    const nextTransition = allowed ? fade : 'none', nextOpacity = visible ? '1' : '0';
    if (nextTransition !== transition) { transition = nextTransition; el.style.transition = transition; }
    if (nextOpacity !== opacity) { opacity = nextOpacity; el.style.opacity = opacity; }
    const line = visible && seen < OBJECTIVE_HINT_SECONDS ? `${verb} to hide` : '';
    if (line && line !== hintText) { hintText = line; hint.textContent = line; }
    const nextHint = line ? '1' : '0';
    if (nextHint !== hintOpacity) { hintOpacity = nextHint; hint.style.opacity = hintOpacity; }
    // On touch the corner is the button, even while the words are hidden, or there would be no way to bring them back; nowhere else is it in the way.
    const nextEvents = touch && allowed ? 'auto' : 'none';
    if (nextEvents !== events) { events = nextEvents; el.style.pointerEvents = events; }
  }

  /** O, or a tap: hide it if it is up, show it if it is hidden. False when there was nothing to toggle (paused, loading, taken). */
  function toggle() {
    if (!allowedNow) return false;
    setOn(!isOn());
    // Whoever pressed it knows the key already: no hint on the way back.
    seen = OBJECTIVE_HINT_SECONDS;
    return true;
  }

  if (touch) {
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup']) el.addEventListener(type, e => e.stopPropagation());
    el.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  }

  return {
    update, toggle,
    /** True while the player has it hidden. */
    get hidden() { return !isOn(); },
    /** True while it is up or fading up. */
    get shown() { return opacity === '1'; },
    get title() { return title.textContent ?? ''; },
    get detail() { return detail.textContent ?? ''; },
    get hint() { return hintOpacity === '1' ? hintText : ''; },
    dispose() { el.remove(); },
  };
}

export type ObjectiveHud = ReturnType<typeof createObjectiveHud>;
