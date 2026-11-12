export type StaminaHudFrame = {
  /** False while paused, loading, taken or flying: the bar is gone at once. */
  allowed: boolean;
  /** 1 full .. 0 empty (game/sim/player/stamina.ts). */
  value: number;
  /** Out of breath and locked out of sprinting: drawn dimmer. */
  exhausted: boolean;
};

/** The bar's two fills are colours the objective corner already uses: its title and its hint. Nothing new. */
const FILL = '#dcd8c9', FILL_SPENT = '#8b8c80';
/** The bar's width is written in steps this fine, so a steady frame writes nothing to the page. */
const STEPS = 200;

/**
 * A thin bar low on the screen, between the interaction prompt and the bottom edge, that only exists while stamina is below
 * full: it fades up when sprinting starts to cost something and fades away once the bar has refilled. It is the same quiet
 * look as the objective corner (the prompt's pale text colour and soft shadow), and it takes no clicks. Call `update` once a
 * frame; the DOM is written only when something differs from what is already there.
 */
export function createStaminaHud(container: HTMLElement) {
  const doc = container.ownerDocument, make = () => doc.createElement('div');
  const el = make(), fill = make();
  el.setAttribute('aria-hidden', 'true');
  // Beneath the pause button's corner (z 4) and every overlay, like the objective corner, so a menu or the death card covers it.
  el.style.cssText = 'position:absolute;left:50%;bottom:max(28px,calc(env(safe-area-inset-bottom) + 18px));width:104px;height:3px;transform:translateX(-50%);pointer-events:none;z-index:3;opacity:0;background:rgba(220,216,201,.16);box-shadow:0 1px 3px #000,0 0 14px rgba(0,0,0,.75);border-radius:2px;overflow:hidden';
  fill.style.cssText = `width:100%;height:100%;transform-origin:0 50%;transform:scaleX(1);background:${FILL}`;
  el.appendChild(fill);
  container.appendChild(el);

  // What the DOM already holds.
  let opacity = '0', transition = '', scale = STEPS, color = FILL;

  function update({ allowed, value, exhausted }: StaminaHudFrame) {
    const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
    const visible = allowed && v < 1;
    // Quick up when sprinting starts to cost something, a slow fade once it is back to full; a menu or death card cuts it at once.
    const nextTransition = !allowed ? 'none' : visible ? 'opacity 200ms ease' : 'opacity 700ms ease';
    if (nextTransition !== transition) { transition = nextTransition; el.style.transition = transition; }
    const nextOpacity = visible ? '1' : '0';
    if (nextOpacity !== opacity) { opacity = nextOpacity; el.style.opacity = opacity; }
    // While it is fading out at full the fill stays where it was, rather than snapping to a full bar and back.
    if (v < 1) {
      const nextScale = Math.round(v * STEPS);
      if (nextScale !== scale) { scale = nextScale; fill.style.transform = `scaleX(${scale / STEPS})`; }
      const nextColor = exhausted ? FILL_SPENT : FILL;
      if (nextColor !== color) { color = nextColor; fill.style.background = color; }
    }
  }

  return {
    update,
    /** True while it is up or fading up. */
    get shown() { return opacity === '1'; },
    /** The fill, 0..1. */
    get fill() { return scale / STEPS; },
    dispose() { el.remove(); },
  };
}

export type StaminaHud = ReturnType<typeof createStaminaHud>;
