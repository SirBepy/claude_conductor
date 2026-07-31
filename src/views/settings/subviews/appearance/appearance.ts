import { html, render } from "lit-html";
import { attachTooltips } from "../../../../shared/row-tooltip";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings, setSettings } from "../../../../shared/state";
import { LS_ANIM } from "../../../sessions/sidebar-anim";
import { LS_ROW_STYLE, loadRowStyle } from "../../../sessions/row-style";
import { settingsHeader, toggleRow } from "../../ui";
import "./appearance.css";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── Theme (ported from subviews/themes/themes.ts) ───────────────────────────

interface ThemeDef {
  id: string;
  label: string;
  darkColors: string[];
  lightColors: string[];
}

const THEMES: ThemeDef[] = [
  { id: "void",    label: "Void",    darkColors: ["#16151f", "#1e1d2b", "#9d7dfc", "#6e8fff", "#e2e0f0"], lightColors: ["#f0eff5", "#ffffff", "#7c5cdb", "#4a6bdf", "#1e1d2b"] },
  { id: "nebula",  label: "Nebula",  darkColors: ["#0f1629", "#172040", "#c084fc", "#a78bfa", "#e2dff0"], lightColors: ["#f2f0fa", "#ffffff", "#9333ea", "#7c3aed", "#1a1040"] },
  { id: "glacier", label: "Glacier", darkColors: ["#0c1a24", "#112430", "#38bdf8", "#22d3ee", "#e0f0f8"], lightColors: ["#eef6fa", "#ffffff", "#0284c7", "#0891b2", "#0c2430"] },
  { id: "cosmo",   label: "Cosmo",   darkColors: ["#1a0a1e", "#241430", "#f472b6", "#fb923c", "#f0e4f5"], lightColors: ["#faf0f4", "#ffffff", "#db2777", "#ea580c", "#2a1030"] },
];

function resolveThemeId(baseId: string, isLight: boolean): string {
  return isLight ? baseId + "-light" : baseId;
}

function parseThemeId(fullId: string): { baseId: string; isLight: boolean } {
  const isLight = fullId.endsWith("-light");
  return { baseId: isLight ? fullId.replace("-light", "") : fullId, isLight };
}

/**
 * Applies a flat theme id ("void" | "void-light") as the styleguide 2D pair:
 * data-theme="<palette>" + data-mode="light|dark". Storage stays the flat id.
 */
function applyThemeAttrs(fullId: string): void {
  const { baseId, isLight } = parseThemeId(fullId);
  const el = document.documentElement;
  el.dataset.theme = baseId;
  el.dataset.mode = isLight ? "light" : "dark";
}

function renderThemeCards(activeTheme: string): void {
  const themeGrid = $("themeGrid");
  const modeLabelDark = $("modeLabelDark");
  const modeLabelLight = $("modeLabelLight");
  if (!themeGrid) return;
  const { baseId: activeBase, isLight } = parseThemeId(activeTheme);
  const colorKey: "darkColors" | "lightColors" = isLight ? "lightColors" : "darkColors";
  themeGrid.innerHTML = "";
  for (const t of THEMES) {
    const card = document.createElement("div");
    card.className = "kit-palette-card" + (t.id === activeBase ? " kit-palette-card--active" : "");
    card.dataset.palette = t.id;
    card.innerHTML = `
      <span class="kit-palette-swatch">${t[colorKey].map((c) => `<span style="background:${c}"></span>`).join("")}</span>
      <span class="kit-palette-label">${t.label}</span>
    `;
    card.onclick = () => applyTheme(t.id);
    themeGrid.appendChild(card);
  }

  if (modeLabelDark) modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  if (modeLabelLight) modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

function applyTheme(baseId: string): void {
  const themeModToggle = $("themeModToggle") as HTMLInputElement | null;
  const isLight = themeModToggle ? themeModToggle.checked : false;
  const fullId = resolveThemeId(baseId, isLight);
  applyThemeAttrs(fullId);
  const s = getSettings();
  s.theme = fullId;
  setSettings(s);
  saveSettings();

  const themeGrid = $("themeGrid");
  if (themeGrid) {
    for (const card of themeGrid.querySelectorAll<HTMLElement>(".kit-palette-card")) {
      card.classList.toggle("kit-palette-card--active", card.dataset.palette === baseId);
    }
  }
  const modeLabelDark = $("modeLabelDark");
  const modeLabelLight = $("modeLabelLight");
  if (modeLabelDark) modeLabelDark.style.color = isLight ? "var(--text-dim)" : "var(--primary)";
  if (modeLabelLight) modeLabelLight.style.color = isLight ? "var(--primary)" : "var(--text-dim)";
}

function hydrateTheme(): void {
  const themeModToggle = $("themeModToggle") as HTMLInputElement | null;
  if (!themeModToggle) return;
  const s = getSettings();
  const savedTheme = (s.theme as string) || document.documentElement.dataset.theme || "void";
  themeModToggle.checked = savedTheme.endsWith("-light");
  renderThemeCards(savedTheme);

  themeModToggle.onchange = () => {
    const cur = getSettings();
    const { baseId } = parseThemeId((cur.theme as string) || "void");
    const isLight = themeModToggle.checked;
    const fullId = resolveThemeId(baseId, isLight);
    applyThemeAttrs(fullId);
    cur.theme = fullId;
    setSettings(cur);
    saveSettings();
    renderThemeCards(fullId);
  };
}

// ── Usage colors / overlay / interface (ported from subviews/visuals/visuals.ts) ──

async function hydrateUsageColorsAndInterface(): Promise<void> {
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

  for (const el of [colorApplyDashboard, colorApplyOverlay]) {
    el.addEventListener("change", saveSettings);
  }
  paceBand.addEventListener("change", saveSettings);
  paceColorUnder.addEventListener("change", saveSettings);
  paceColorNearSafe.addEventListener("change", saveSettings);
  paceColorNearOver.addEventListener("change", saveSettings);
  paceColorOver.addEventListener("change", saveSettings);

  attachTooltips(document.getElementById("app") || document.body, { placement: "above" });

  const chatRowStyle = $("chatRowStyle") as HTMLSelectElement | null;
  if (chatRowStyle) {
    chatRowStyle.value = loadRowStyle();
    chatRowStyle.addEventListener("change", () => {
      try { localStorage.setItem(LS_ROW_STYLE, chatRowStyle.value); }
      catch { /* ignore */ }
    });
  }

  const sessionStateStyle = $("sessionStateStyle") as HTMLSelectElement | null;
  if (sessionStateStyle) {
    try {
      sessionStateStyle.value = localStorage.getItem("cc_session_state_style") || "icons";
    } catch { /* ignore */ }
    sessionStateStyle.addEventListener("change", () => {
      try { localStorage.setItem("cc_session_state_style", sessionStateStyle.value); }
      catch { /* ignore */ }
    });
  }

  const sidebarAnimations = $("sidebarAnimations") as HTMLInputElement | null;
  if (sidebarAnimations) {
    try { sidebarAnimations.checked = localStorage.getItem(LS_ANIM) !== "off"; }
    catch { sidebarAnimations.checked = true; }
    sidebarAnimations.addEventListener("change", () => {
      try { localStorage.setItem(LS_ANIM, sidebarAnimations.checked ? "on" : "off"); }
      catch { /* ignore */ }
    });
  }

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
    hydrateTheme();
    await hydrateUsageColorsAndInterface();
  } catch (e) { console.error("[appearance] render failed", e); }

  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-appearance">
      ${settingsHeader("Appearance")}
      <div class="view-body">

        <div class="kit-section">
          <div class="kit-section-title">Theme</div>
          <div class="kit-row" style="justify-content: space-between;">
            <div class="option-label-row">
              <i class="ph ph-moon"></i>
              <span>Dark Mode</span>
            </div>
            <div class="mode-toggle-row">
              <span class="mode-toggle-label" id="modeLabelDark">Dark</span>
              <label class="kit-toggle">
                <input type="checkbox" id="themeModToggle">
                <span class="kit-toggle-track"></span>
              </label>
              <span class="mode-toggle-label" id="modeLabelLight">Light</span>
            </div>
          </div>
          <div class="kit-palette-grid" id="themeGrid"></div>
        </div>

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
              <span id="overlayOpacityValue" style="font-size:0.78rem;color:var(--text-dim);width:36px;text-align:right">72%</span>
            </div>
          </div>
          ${toggleRow({ label: "Hide from screen capture", inputId: "hideInMeetingSwitch", checked: false })}
          <div style="font-size:0.72rem;color:var(--text-dim);padding:2px 0 4px">Hides app windows from screen shares and recordings during meetings. Windows only.</div>
        </div>

        <div class="kit-section">
          <div class="kit-section-title">Interface</div>
          <div class="kit-row">
            <span class="kit-row-label"><span class="info-wrap">Chat row style<i class="ph ph-info info-icon"></i><span class="info-tooltip">Portrait: square character portrait, project name, and a battery for the model - the chat title moves to the hover tooltip. Classic: the original title-led row.</span></span></span>
            <select id="chatRowStyle">
              <option value="portrait">Portrait</option>
              <option value="classic">Classic</option>
            </select>
          </div>
          <div class="kit-row">
            <span class="kit-row-label">Session state style</span>
            <select id="sessionStateStyle">
              <option value="icons">Icons</option>
              <option value="dots">Dots</option>
            </select>
          </div>
          ${toggleRow({ label: "Sidebar animations", inputId: "sidebarAnimations", checked: true })}
        </div>

      </div>
    </div>
  `;
}
