import { html, render } from "lit-html";
import { attachTooltips } from "../../../../shared/row-tooltip";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { isRemote } from "../../../../shared/transport";
import { LS_ANIM } from "../../../sessions/sidebar-anim";
import { settingsHeader, toggleRow } from "../../ui";
import { backgroundSection, hydrateBackgroundFx } from "./components/background/background";
import { hydrateThemePicker, themePickerSection } from "./theme-picker";
import "./appearance.css";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── Usage colors / overlay / interface (ported from subviews/visuals/visuals.ts) ──

async function hydrateUsageColorsAndInterface(): Promise<void> {
  const s = getSettings();

  // Sidebar animations is a local-storage-only control (not a settings write),
  // so it stays live on the phone even though the save_settings-backed
  // sections below are gated out of the template there (todo 1023: the
  // daemon refuses settings writes from the phone and saveSettings() just
  // toasts "Couldn't save settings" every time).
  const sidebarAnimations = $("sidebarAnimations") as HTMLInputElement | null;
  if (sidebarAnimations) {
    try { sidebarAnimations.checked = localStorage.getItem(LS_ANIM) !== "off"; }
    catch { sidebarAnimations.checked = true; }
    sidebarAnimations.addEventListener("change", () => {
      try { localStorage.setItem(LS_ANIM, sidebarAnimations.checked ? "on" : "off"); }
      catch { /* ignore */ }
    });
  }

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

  for (const el of [colorApplyDashboard, colorApplyOverlay]) {
    el.addEventListener("change", saveSettings);
  }
  paceBand.addEventListener("change", saveSettings);
  paceColorUnder.addEventListener("change", saveSettings);
  paceColorNearSafe.addEventListener("change", saveSettings);
  paceColorNearOver.addEventListener("change", saveSettings);
  paceColorOver.addEventListener("change", saveSettings);

  attachTooltips(document.getElementById("app") || document.body, { placement: "above" });

  const hideInMeetingSwitch = $("hideInMeetingSwitch") as HTMLInputElement | null;
  if (hideInMeetingSwitch) {
    hideInMeetingSwitch.checked = !!s.hideInMeeting;
    hideInMeetingSwitch.addEventListener("change", saveSettings);
  }

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

export async function renderAppearanceView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  try {
    hydrateThemePicker();
    await hydrateUsageColorsAndInterface();
    hydrateBackgroundFx();
  } catch (e) { console.error("[appearance] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-appearance">
      ${settingsHeader("Appearance")}
      <div class="view-body">

        ${isRemote() ? "" : html`
        ${themePickerSection()}

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
          ${toggleRow({ label: "Dashboard", inputId: "colorApplyDashboard", checked: true, tooltip: "Colors the percentage numbers shown in the dashboard" })}
          ${toggleRow({ label: "Overlay", inputId: "colorApplyOverlay", checked: true, tooltip: "Colors the usage numbers shown in the floating multi-account overlay window" })}
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
          ${toggleRow({ label: "Hide from screen capture", inputId: "hideInMeetingSwitch", checked: false })}
          <div style="font-size: var(--fs-micro);color:var(--sb-muted);padding:2px 0 4px">Hides app windows from screen shares and recordings during meetings. Windows only.</div>
        </div>
        `}

        <div class="kit-section">
          <div class="kit-section-title">Interface</div>
          ${toggleRow({ label: "Sidebar animations", inputId: "sidebarAnimations", checked: true })}
        </div>

        ${isRemote() ? "" : backgroundSection()}

      </div>
    </div>
  `;
}
