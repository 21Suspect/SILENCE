import type { ObjectiveText } from './objective-text';

/** Shows or hides the objective. Fixed rather than rebindable; the engine stands aside if a player has bound it to something else. */
export const OBJECTIVE_KEY = 'KeyO';
/** Seconds the objective stays up after it appears or changes, before it fades down on its own. */
export const OBJECTIVE_HOLD = 7;
/** Seconds a fade takes, in and out. */
export const OBJECTIVE_FADE = .8;
const SWAP = .45;

export type ObjectiveHudOptions = {
  /** Touch screens have no key: a tap on the corner does the job of O, and the hint says so. Default: a coarse pointer. */
  touch?: boolean;
  /** The saved "objective hint" setting. While it is false the element never shows, not even when the objective changes. */
  enabled?: () => boolean;
  /** What the key is called in the hint. */
  keyName?: string;
};
export type ObjectiveHudFrame = {
  /** Milliseconds, any steady clock (the animation frame's). */
  now: number;
  /** False while paused, loading, taken or out of the window: the objective is gone at once and its timer waits. */
  allowed: boolean;
  text: ObjectiveText | undefined;
};

/**
 * The objective in the top-left corner: small and quiet, in the interaction prompt's type. It fades up when play starts and
 * whenever the step or its progress changes, stays about seven seconds, then fades away. O (or a tap on touch) pins it up;
 * once more and it fades out and goes back to appearing on its own. Call `update` once a frame; the DOM is only written when
 * something differs from what is already there.
 */
export function createObjectiveHud(container: HTMLElement, options: ObjectiveHudOptions = {}) {
  const touch = options.touch ?? (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  const enabled = options.enabled ?? (() => true), verb = touch ? 'Tap' : options.keyName ?? 'O';
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

  let key = '', hold = 0, pinned = false, intro = true, allowedNow = false, wasOn = enabled(), lastNow: number | undefined, swap = false;
  // What the DOM already holds, so a frame that changes nothing writes nothing.
  let opacity = '0', transition = fade, events = 'none', hintOpacity = '0', hintText = '';

  function update({ now, allowed, text }: ObjectiveHudFrame) {
    const dt = lastNow === undefined ? 0 : Math.min(.25, Math.max(0, (now - lastNow) / 1000)); lastNow = now; allowedNow = allowed;
    // The text that changed under a visible element dipped out last frame; bring it back up.
    if (swap) { swap = false; body.style.transition = `opacity ${SWAP * 1000}ms ease`; body.style.opacity = '1'; }
    const on = enabled();
    if (!on) { pinned = false; hold = 0; } else if (!wasOn) hold = OBJECTIVE_HOLD; // switched back on: show it once
    wasOn = on;
    if (text) {
      const next = `${text.title}\n${text.detail ?? ''}`;
      if (next !== key) {
        const showing = opacity === '1' && key !== '';
        key = next;
        if (text.title !== title.textContent) title.textContent = text.title;
        if ((text.detail ?? '') !== detail.textContent) detail.textContent = text.detail ?? '';
        if (showing) { body.style.transition = 'none'; body.style.opacity = '0'; swap = true; } // not a pop: the new words fade up
        if (on) hold = OBJECTIVE_HOLD;
      }
    }
    // The timer only runs while it can be seen: a pause or a death does not eat it.
    if (on && allowed && !pinned && hold > 0) { hold = Math.max(0, hold - dt); if (hold === 0) intro = false; }
    const visible = on && allowed && (pinned || hold > 0);
    // Fading is for the player's own pace; going behind a menu or the death card is immediate.
    const nextTransition = on && allowed ? fade : 'none', nextOpacity = visible ? '1' : '0';
    if (nextTransition !== transition) { transition = nextTransition; el.style.transition = transition; }
    if (nextOpacity !== opacity) { opacity = nextOpacity; el.style.opacity = opacity; }
    const line = pinned ? `${verb} to hide` : intro ? `${verb} to keep` : '';
    if (line && line !== hintText) { hintText = line; hint.textContent = line; }
    const nextHint = line ? '1' : '0';
    if (nextHint !== hintOpacity) { hintOpacity = nextHint; hint.style.opacity = hintOpacity; }
    // On touch the corner is the button, even while the words are faded out; nowhere else is it in the way.
    const nextEvents = touch && on && allowed ? 'auto' : 'none';
    if (nextEvents !== events) { events = nextEvents; el.style.pointerEvents = events; }
  }

  /** O, or a tap: pin it up, or let it go. False when there was nothing to toggle (disabled, paused). */
  function toggle() {
    if (!enabled() || !allowedNow) return false;
    if (pinned) { pinned = false; hold = 0; intro = false; } else pinned = true;
    return true;
  }

  if (touch) {
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup']) el.addEventListener(type, e => e.stopPropagation());
    el.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  }

  return {
    update, toggle,
    get pinned() { return pinned; },
    /** True while it is up or fading up. */
    get shown() { return opacity === '1'; },
    get title() { return title.textContent ?? ''; },
    get detail() { return detail.textContent ?? ''; },
    get hint() { return hintOpacity === '1' ? hintText : ''; },
    dispose() { el.remove(); },
  };
}

export type ObjectiveHud = ReturnType<typeof createObjectiveHud>;
