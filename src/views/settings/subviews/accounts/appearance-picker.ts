// Shared icon/colour appearance picker (T6 dedupe) - the icon-grid + colour
// swatches + custom-colour input used identically by the add-account
// wizard's finalize step (add-account-wizard-steps.ts) and the edit-account
// modal's Details tab (edit-account-modal.ts). Those two used to carry near-
// identical copies of this markup/wiring.
//
// Raw-DOM (innerHTML + querySelectorAll wiring), matching how both call sites
// already render - not lit-html. `renderAppearancePicker` owns just this
// sub-tree inside a caller-provided container and re-renders itself on every
// selection change, so callers don't need to blow away their whole
// step/modal body just to reflect an icon/colour pick.

import { escapeHtml } from "../../../../shared/escape-html";
import { ICON_POOL, COLOUR_POOL } from "./wizard-logic";
import "./appearance-picker.css";

export interface AppearanceState {
  icon: string;
  colour: string;
}

/**
 * Renders the icon-grid + colour-swatches into `container` (its full
 * innerHTML - give it a dedicated empty element) and wires click/input
 * handlers. `state` is mutated in place on every pick, so callers whose
 * `state` object is the same one they read from later (e.g. on
 * Save/Finalize) always see the latest values with no extra plumbing.
 *
 * `onChange` fires after every mutation, including live custom-colour drag
 * (an "input" event, before the OS picker is confirmed) - callers use it for
 * any side effect that lives OUTSIDE this component's own subtree (e.g. the
 * edit-modal's tab-underline colour, which reads `--acc` off an ancestor
 * this component doesn't own). This component's own `--acc`-dependent styles
 * (the selected icon tile) are scoped to `container` itself, so it does not
 * need that hook for its own rendering.
 */
export function renderAppearancePicker(
  container: HTMLElement,
  state: AppearanceState,
  onChange: (next: AppearanceState) => void,
): void {
  const customColour = !COLOUR_POOL.includes(state.colour);
  container.classList.add("appearance-picker");
  container.style.setProperty("--acc", state.colour);
  container.innerHTML = `
    <div class="field">
      <label>Icon</label>
      <div class="icon-grid">
        ${ICON_POOL.map((i) => `<button type="button" class="icon-tile${i === state.icon ? " sel" : ""}" data-icon="${escapeHtml(i)}"><i class="ph ph-${escapeHtml(i)}"></i></button>`).join("")}
      </div>
    </div>
    <div class="field">
      <label>Colour</label>
      <div class="swatches">
        ${COLOUR_POOL.map((c) => `<button type="button" class="swatch v-focusable${c === state.colour ? " sel" : ""}" data-colour="${escapeHtml(c)}" style="background:${escapeHtml(c)}" aria-label="${escapeHtml(c)} colour" aria-pressed="${c === state.colour}"></button>`).join("")}
        <label class="swatch custom${customColour ? " sel" : ""}" title="Custom colour" ${customColour ? `style="background:${escapeHtml(state.colour)}"` : ""}>
          <i class="ph ph-eyedropper"></i>
          <input type="color" class="ap-custom-colour" value="${escapeHtml(customColour ? state.colour : "#8888ff")}">
        </label>
      </div>
    </div>
  `;

  container.querySelectorAll<HTMLButtonElement>(".icon-tile").forEach((tile) => {
    tile.addEventListener("click", () => {
      state.icon = tile.dataset.icon ?? state.icon;
      onChange(state);
      renderAppearancePicker(container, state, onChange);
    });
  });

  container.querySelectorAll<HTMLElement>(".swatch[data-colour]").forEach((sw) => {
    sw.addEventListener("click", () => {
      state.colour = sw.dataset.colour ?? state.colour;
      onChange(state);
      renderAppearancePicker(container, state, onChange);
    });
  });

  const customEl = container.querySelector<HTMLInputElement>(".ap-custom-colour");
  // "input" fires live while the native picker is open - a full re-render
  // would destroy the input and close the picker, so live-preview in place
  // and only re-render on "change" (picker confirmed/closed).
  customEl?.addEventListener("input", () => {
    state.colour = customEl.value;
    container.style.setProperty("--acc", state.colour);
    container.querySelectorAll<HTMLElement>(".swatch").forEach((sw) => {
      sw.classList.remove("sel");
      if (sw.hasAttribute("aria-pressed")) sw.setAttribute("aria-pressed", "false");
    });
    const custom = customEl.closest<HTMLElement>(".swatch.custom");
    if (custom) {
      custom.classList.add("sel");
      custom.style.background = state.colour;
    }
    onChange(state);
  });
  customEl?.addEventListener("change", () => {
    state.colour = customEl.value;
    onChange(state);
    renderAppearancePicker(container, state, onChange);
  });
}
