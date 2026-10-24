import { html, render } from "lit-html";
import { attachTooltips } from "../../../../shared/row-tooltip";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { isRemote } from "../../../../shared/transport";
import { settingsHeader, toggleRow } from "../../ui";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function hydrateUsageMeter(): void {
  const s = getSettings();

  const colorApplyDashboard = $("colorApplyDashboard") as HTMLInputElement | null;
  const colorApplyOverlay = $("colorApplyOverlay") as HTMLInputElement | null;
  const paceBand = $("paceBand") as HTMLInputElement | null;
  const paceColorUnder = $("paceColorUnder") as HTMLInputElement | null;
  const paceColorNearSafe = $("paceColorNearSafe") as HTMLInputElement | null;
  const paceColorNearOver = $("paceColorNearOver") as HTMLInputElement | null;
  const paceColorOver = $("paceColorOver") as HTMLInputElement | null;
  if (!colorApplyDashboard || !colorApplyOverlay) return;
  if (!paceBand) return;
  if (!paceColorUnder || !paceColorNearSafe || !paceColorNearOver || !paceColorOver) return;

  const cat = (s.colorApplyTo as Record<string, boolean | undefined>) || {};
  colorApplyDashboard.checked = cat.dashboard !== false;
  colorApplyOverlay.checked = cat.overlay !== false;
  paceBand.value = String(s.paceBand ?? 10);
  const pc = (s.paceColors as Record<string, string | undefined>) || {};
  paceColorUnder.value = pc.under || "#27ae60";
  paceColorNearSafe.value = pc.nearSafe || "#f1c40f";
  paceColorNearOver.value = pc.nearOver || "#e67e22";
  paceColorOver.value = pc.over || "#e74c3c";

  for (const el of [colorApplyDashboard, colorApplyOverlay, paceBand, paceColorUnder, paceColorNearSafe, paceColorNearOver, paceColorOver]) {
    el.addEventListener("change", saveSettings);
  }

  attachTooltips(document.getElementById("app") || document.body, { placement: "above" });

  const overlayBackgroundStyle = $("overlayBackgroundStyle") as HTMLSelectElement | null;
  if (overlayBackgroundStyle) {
    overlayBackgroundStyle.value = s.overlayBackgroundStyle === "card" ? "card" : "circles";
    overlayBackgroundStyle.addEventListener("change", saveSettings);
  }

  const overlayOpacity = $("overlayOpacity") as HTMLInputElement | null;
  const overlayOpacityValue = $("overlayOpacityValue");
  if (overlayOpacity) {
    const pct = Math.round(Math.max(0, Math.min(1, (s.overlayOpacity as number) ?? 0.72)) * 100);
    overlayOpacity.value = String(pct);
    if (overlayOpacityValue) overlayOpacityValue.textContent = `${pct}%`;
    overlayOpacity.addEventListener("input", () => {
      if (overlayOpacityValue) overlayOpacityValue.textContent = `${overlayOpacity.value}%`;
    });
    overlayOpacity.addEventListener("change", saveSettings);
  }
}

export async function renderUsageMeterView(root: HTMLElement): Promise<() => void> {
  render(template(), root);
  try { hydrateUsageMeter(); }
  catch (e) { console.error("[usage-meter] render failed", e); }
  return () => { /* no teardown */ };
}

// Every control here persists via saveSettings(), which the daemon refuses
// from the phone, so the phone gets an empty page.
function template() {
  return html`
    <div class="view view-settings-usage-meter">
      ${settingsHeader("Usage meter")}
      <div class="view-body">
        ${isRemote() ? "" : html`
        <div class="kit-section">
          <div class="kit-section-title">Usage colors</div>
          <div id="paceSection">
            <div class="kit-row">
              <span class="kit-row-label"><span class="info-wrap">Band %<i class="ph ph-info info-icon"></i><span class="info-tooltip">How close to the safe pace line before the color changes (e.g. 10% means within 10 points)</span></span></span>
              <input type="number" id="paceBand" value="10" min="0" max="50" style="width:60px">
            </div>
            <div class="kit-section-title" style="margin-top:10px">Colors</div>
            <div class="kit-row">
              <span class="kit-row-label">Under</span>
              <input type="color" id="paceColorUnder" value="#27ae60">
            </div>
            <div class="kit-row">
              <span class="kit-row-label">Near (safe side)</span>
              <input type="color" id="paceColorNearSafe" value="#f1c40f">
            </div>
            <div class="kit-row">
              <span class="kit-row-label">Near (over side)</span>
              <input type="color" id="paceColorNearOver" value="#e67e22">
            </div>
            <div class="kit-row">
              <span class="kit-row-label">Over</span>
              <input type="color" id="paceColorOver" value="#e74c3c">
            </div>
          </div>
          ${toggleRow({ label: "Colour numbers on Dashboard", inputId: "colorApplyDashboard", checked: true, tooltip: "Colors the percentage numbers shown in the dashboard" })}
          ${toggleRow({ label: "Colour numbers in overlay", inputId: "colorApplyOverlay", checked: true, tooltip: "Colors the usage numbers shown in the floating multi-account overlay window" })}
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Overlay</div>
          <div class="kit-row">
            <span class="kit-row-label"><span class="info-wrap">Background style<i class="ph ph-info info-icon"></i><span class="info-tooltip">Circles: each account dial sits on its own round backing. Card: one shared rounded card behind the whole row.</span></span></span>
            <select id="overlayBackgroundStyle">
              <option value="circles">Circles</option>
              <option value="card">Shared card</option>
            </select>
          </div>
          <div class="kit-row">
            <span class="kit-row-label"><span class="info-wrap">Overlay Opacity<i class="ph ph-info info-icon"></i><span class="info-tooltip">How opaque each account card's background becomes when you hover it - off-hover the overlay is fully transparent to the desktop</span></span></span>
            <div style="display:flex;align-items:center;gap:8px;flex:1;max-width:220px">
              <input type="range" id="overlayOpacity" min="0" max="100" step="5" style="flex:1">
              <span id="overlayOpacityValue" style="font-size: var(--fs-body);color:var(--sb-muted);width:36px;text-align:right">72%</span>
            </div>
          </div>
        </div>
        `}
      </div>
    </div>
  `;
}
