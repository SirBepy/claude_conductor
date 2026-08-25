/** Ambient background (see background-fx.css). Both variant DOM trees are
 * built once and left in place; toggling just flips display via CSS, which
 * also halts the animation - there's no timer here to pause. */

import "./background-fx.css";

const CONTAINER_ID = "cc-bgfx";

function ensureMounted(): HTMLElement {
  let el = document.getElementById(CONTAINER_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = CONTAINER_ID;
  el.innerHTML = `
    <div id="cc-bgfx-pattern"><div class="cc-bgfx-pattern-fade"></div></div>
    <div id="cc-bgfx-gradient">
      <div class="cc-bgfx-blob cc-bgfx-blob-1"></div>
      <div class="cc-bgfx-blob cc-bgfx-blob-2"></div>
      <div class="cc-bgfx-blob cc-bgfx-blob-3"></div>
      <div class="cc-bgfx-blob cc-bgfx-blob-4"></div>
    </div>
  `;
  document.body.insertBefore(el, document.body.firstChild);
  return el;
}

export type BackgroundFxVariant = "pattern" | "gradient";

export function applyBackgroundFx(enabled: boolean, variant: BackgroundFxVariant): void {
  const el = ensureMounted();
  el.classList.toggle("cc-bgfx-on", enabled);
  el.dataset.variant = variant;
}
