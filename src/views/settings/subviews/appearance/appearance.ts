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

// ── Interface (ported from subviews/visuals/visuals.ts) ──

async function hydrateInterface(): Promise<void> {
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

  // Tooltips for the theme/background rows; the phone omits those sections.
  if (isRemote()) return;
  attachTooltips(document.getElementById("app") || document.body, { placement: "above" });

  const hideInMeetingSwitch = $("hideInMeetingSwitch") as HTMLInputElement | null;
  if (hideInMeetingSwitch) {
    hideInMeetingSwitch.checked = !!s.hideInMeeting;
    hideInMeetingSwitch.addEventListener("change", saveSettings);
  }
}

export async function renderAppearanceView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  try {
    hydrateThemePicker();
    await hydrateInterface();
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
        `}

        <div class="kit-section">
          <div class="kit-section-title">Interface</div>
          ${toggleRow({ label: "Sidebar animations", inputId: "sidebarAnimations", checked: true })}
          ${isRemote() ? "" : html`
          ${toggleRow({ label: "Hide from screen capture", inputId: "hideInMeetingSwitch", checked: false })}
          <div style="font-size: var(--fs-micro);color:var(--sb-muted);padding:2px 0 4px">Hides every app window from screen shares and recordings during meetings. Windows only.</div>
          `}
        </div>

        ${isRemote() ? "" : backgroundSection()}

      </div>
    </div>
  `;
}
