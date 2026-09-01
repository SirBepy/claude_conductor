import { html, type TemplateResult } from "lit-html";
import { applyBackgroundFx } from "../../../../../../shared/background-fx";
import { getSettings, setSettings } from "../../../../../../shared/state";
import { saveSettings } from "../../../../../../shared/settings-save";
import { toggleRow } from "../../../../ui";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function backgroundSection(): TemplateResult {
  return html`
    <div class="kit-section">
      <div class="kit-section-title">Background</div>
      ${toggleRow({ label: "Animated background", inputId: "backgroundFxEnabled", checked: false, tooltip: "A subtle moving background behind the app and your chats. Pure CSS, no extra CPU/GPU cost while idle." })}
      <div class="kit-row">
        <span class="kit-row-label">Style</span>
        <select id="backgroundFxVariant">
          <option value="pattern">Pattern (stars)</option>
          <option value="gradient">Gradient (aurora)</option>
        </select>
      </div>
    </div>
  `;
}

export function hydrateBackgroundFx(): void {
  const enabledEl = $("backgroundFxEnabled") as HTMLInputElement | null;
  const variantEl = $("backgroundFxVariant") as HTMLSelectElement | null;
  if (!enabledEl || !variantEl) return;

  const s = getSettings();
  enabledEl.checked = !!s.backgroundEnabled;
  variantEl.value = s.backgroundVariant === "gradient" ? "gradient" : "pattern";
  variantEl.disabled = !enabledEl.checked;

  const apply = () => {
    variantEl.disabled = !enabledEl.checked;
    const variant = variantEl.value === "gradient" ? "gradient" : "pattern";
    const cur = getSettings();
    cur.backgroundEnabled = enabledEl.checked;
    cur.backgroundVariant = variant;
    setSettings(cur);
    saveSettings();
    applyBackgroundFx(enabledEl.checked, variant);
  };
  enabledEl.addEventListener("change", apply);
  variantEl.addEventListener("change", apply);
}
