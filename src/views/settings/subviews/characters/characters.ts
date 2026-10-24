import { html, render } from "lit-html";
import { api } from "../../../../shared/api";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { isRemote } from "../../../../shared/transport";
import { renderWhitelistEditor } from "../../../../shared/whitelist-editor";
import { settingsHeader, toggleRow } from "../../ui";
import "./characters.css";

// [checkbox id, settings key] for the six voice-line slot toggles.
const CHARACTER_SLOT_SWITCHES: Array<[string, string]> = [
  ["soundSlotWorkFinished", "workFinished"],
  ["soundSlotQuestionAsked", "questionAsked"],
  ["soundSlotReady", "ready"],
  ["soundSlotSelect", "select"],
  ["soundSlotDeath", "death"],
  ["soundSlotAnnoyed", "annoyed"],
];

function characterSlotRow(id: string, label: string) {
  return toggleRow({ label, inputId: id, checked: true });
}

function template() {
  return html`
    <div class="view view-settings-characters">
      ${settingsHeader("Characters")}
      <div class="view-body">
        <div class="kit-section">
          <div class="kit-section-title">Default characters</div>
          <p class="characters-hint">
            Default character whitelist for new projects. Each project starts by
            inheriting this list and can override it from its own Character whitelist screen.
          </p>
          <div id="default-whitelist-host"></div>
        </div>
        ${isRemote() ? "" : html`
        <div class="kit-section" id="characterSoundsSection">
          <div class="kit-section-title">Voice lines</div>
          ${characterSlotRow("soundSlotWorkFinished", "Work finished")}
          ${characterSlotRow("soundSlotQuestionAsked", "Question asked")}
          ${characterSlotRow("soundSlotReady", "Ready (new chat)")}
          ${characterSlotRow("soundSlotSelect", "Select (new chat / change)")}
          ${characterSlotRow("soundSlotDeath", "Death (chat closed)")}
          ${characterSlotRow("soundSlotAnnoyed", "Annoyed")}
          <div class="settings-caption">Mute individual character voice-line slots. Off here silences that slot everywhere. The tray "Mute Notifications" overrides all of these.</div>
          ${toggleRow({ label: "Play \"select\" when clicking a session", inputId: "selectOnSessionClickSwitch", checked: false })}
        </div>
        `}
      </div>
    </div>
  `;
}

// Both controls persist via saveSettings(), which the daemon refuses from the
// phone, so the section only exists on the desktop.
function hydrateVoiceLines(root: HTMLElement): void {
  const s = getSettings();
  // Each slot defaults ON when its key is absent.
  const slots = (s.characterSoundSlots as Record<string, boolean | undefined>) || {};
  for (const [id, key] of CHARACTER_SLOT_SWITCHES) {
    const el = root.querySelector<HTMLInputElement>(`#${id}`);
    if (!el) continue;
    el.checked = slots[key] !== false;
    el.addEventListener("change", saveSettings);
  }
  const selectOnClick = root.querySelector<HTMLInputElement>("#selectOnSessionClickSwitch");
  if (selectOnClick) {
    // Default off.
    selectOnClick.checked = s.selectOnSessionClick === true;
    selectOnClick.addEventListener("change", saveSettings);
  }
}

export async function renderCharactersSettingsView(root: HTMLElement): Promise<() => void> {
  render(template(), root);

  hydrateVoiceLines(root);

  const host = root.querySelector<HTMLElement>("#default-whitelist-host");
  if (!host) return () => { /* nothing */ };

  let current = await api.getDefaultWhitelist();
  // The settings default can't reference itself; if somehow stored as "default",
  // present it as "all" so the editor has a concrete starting point.
  if (current.mode === "default") current = { mode: "all" };

  await renderWhitelistEditor(host, {
    value: current,
    allowDefault: false,
    onChange: (wl) => {
      void api.setDefaultWhitelist(wl).catch((e) => {
        console.error("[settings-characters] setDefaultWhitelist failed", e);
      });
    },
  });

  return () => { /* nothing to tear down */ };
}
