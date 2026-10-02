import { html, render } from "lit-html";
import { saveSettings, NOTIF_TYPES } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { isRemote } from "../../../../shared/transport";
import { settingsHeader, toggleRow } from "../../ui";
import {
  buildNotifCards,
  renderNotifCard,
  loadPiperVoices,
  primeWebVoices,
  populateVoicePreview,
} from "./notif-cards";
import { populateDevicePicker, populateMicPicker, wirePttCapture } from "./audio-devices";
import { wirePushSection } from "./push-section";
import "./notifications.css";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function applyMuteAllVisual(): void {
  const muteAllSwitch = $("muteAllSwitch") as HTMLInputElement | null;
  const muteSection = $("muteSection");
  if (!muteAllSwitch || !muteSection) return;
  muteSection.classList.toggle("mute-all-on", muteAllSwitch.checked);
}

async function hydrateNotifications(): Promise<void> {
  const s = getSettings();

  // Everything in this block persists via saveSettings(), which the daemon
  // refuses from the phone (todo 1023) - the template omits these sections
  // there, so run their wiring only when the elements can actually exist.
  // Mic picker + push-to-talk below are local-storage-only and stay live.
  if (!isRemote()) {
    const muteAllSwitch = $("muteAllSwitch") as HTMLInputElement | null;
    const muteSoundsSwitch = $("muteSoundsSwitch") as HTMLInputElement | null;
    const muteSystemSwitch = $("muteSystemSwitch") as HTMLInputElement | null;
    const pauseInMeetingSwitch = $("pauseInMeetingSwitch") as HTMLInputElement | null;
    const voicePreviewProjectRow = $("voicePreviewProjectRow");

    if (muteAllSwitch && muteSoundsSwitch && muteSystemSwitch) {
      muteAllSwitch.checked = !!s.muteAll;
      muteSoundsSwitch.checked = !!s.muteSounds;
      muteSystemSwitch.checked = !!s.muteSystemNotifications;
      applyMuteAllVisual();

      muteAllSwitch.addEventListener("change", () => { applyMuteAllVisual(); saveSettings(); });
      muteSoundsSwitch.addEventListener("change", saveSettings);

      if (pauseInMeetingSwitch) {
        // Default on when the key is absent.
        pauseInMeetingSwitch.checked = s.pauseInMeeting !== false;
        pauseInMeetingSwitch.addEventListener("change", saveSettings);
      }
    }

    buildNotifCards();
    const notifs = (s.notifications as Record<string, Record<string, unknown>>) || {};
    await Promise.all(NOTIF_TYPES.map((t) => renderNotifCard(t.key, notifs[t.key] || {})));
    await populateVoicePreview();
    await loadPiperVoices();
    primeWebVoices();

    if (voicePreviewProjectRow) voicePreviewProjectRow.style.display = "flex";

    await populateDevicePicker();

    // Per-slot character-sound toggles. Each defaults ON when its key is absent.
    const slots = (s.characterSoundSlots as Record<string, boolean | undefined>) || {};
    for (const [id, key] of CHARACTER_SLOT_SWITCHES) {
      const el = $(id) as HTMLInputElement | null;
      if (!el) continue;
      el.checked = slots[key] !== false;
      el.addEventListener("change", saveSettings);
    }
    const voiceSwitch = $("voiceDictationSwitch") as HTMLInputElement | null;
    if (voiceSwitch) {
      voiceSwitch.checked = s.voiceDictationEnabled === true;
      voiceSwitch.addEventListener("change", saveSettings);
    }
    const selectOnClick = $("selectOnSessionClickSwitch") as HTMLInputElement | null;
    if (selectOnClick) {
      // Default off.
      selectOnClick.checked = s.selectOnSessionClick === true;
      selectOnClick.addEventListener("change", saveSettings);
    }
  }

  await populateMicPicker();
  wirePttCapture();
}

// [checkbox id, settings key] for the six character-sound slot toggles.
const CHARACTER_SLOT_SWITCHES: Array<[string, string]> = [
  ["soundSlotWorkFinished", "workFinished"],
  ["soundSlotQuestionAsked", "questionAsked"],
  ["soundSlotReady", "ready"],
  ["soundSlotSelect", "select"],
  ["soundSlotDeath", "death"],
  ["soundSlotAnnoyed", "annoyed"],
];

// Back-compat window binding.
(window as unknown as { renderNotificationSettings?: () => Promise<void> }).renderNotificationSettings = hydrateNotifications;

export async function renderNotificationsView(
  root: HTMLElement,
): Promise<() => void> {
  render(template(), root);

  wirePushSection(root);

  try { await hydrateNotifications(); }
  catch (e) { console.error("[notifications] render failed", e); }

  return () => { /* no teardown */ };
}

function characterSlotRow(id: string, label: string) {
  return toggleRow({ label, inputId: id, checked: true });
}

function template() {
  return html`
    <div class="view view-settings-notifications">
      ${settingsHeader("Notifications & Sound")}
      <div class="view-body">
        <div class="kit-section" id="push-section" style="display:none">
          <div class="kit-section-title">Push to this phone</div>
          <div class="kit-row">
            <span class="kit-row-label">Notify me when Claude is blocked (PC idle)</span>
            <label class="kit-toggle">
              <input type="checkbox" id="push-enabled">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <p class="ra-caption push-status-caption" id="push-status">
            Get a push on this phone when a chat needs a permission or a question answered and you've stepped away from the PC.
          </p>
        </div>
        ${isRemote() ? "" : html`
        <div class="kit-section" id="muteSection">
          <div class="kit-section-title">Mute</div>
          <div class="kit-row">
            <span class="kit-row-label">Mute all notifications</span>
            <label class="kit-toggle">
              <input type="checkbox" id="muteAllSwitch">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div class="kit-row mute-child">
            <span class="kit-row-label">Mute sounds</span>
            <label class="kit-toggle">
              <input type="checkbox" id="muteSoundsSwitch">
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          <div class="kit-row mute-child is-disabled" title="Coming soon - OS toasts aren't implemented yet">
            <span class="kit-row-label">Mute system notifications <span class="coming-soon-label">(coming soon)</span></span>
            <label class="kit-toggle">
              <input type="checkbox" id="muteSystemSwitch" disabled>
              <span class="kit-toggle-track"></span>
            </label>
          </div>
          ${toggleRow({ label: "Pause sounds during meetings", inputId: "pauseInMeetingSwitch", checked: true })}
          <div class="settings-caption">Silences sounds and voice while your camera or mic is in use, or a meeting app (Teams, Zoom, Discord...) is in a call. Windows only.</div>
        </div>
        <template id="notifCardTemplate">
          <div class="kit-section notif-card">
            <div class="kit-section-title notif-title"></div>
            <div class="kit-row">
              <span class="kit-row-label">Enabled</span>
              <label class="kit-toggle">
                <input type="checkbox" class="notif-enabled">
                <span class="kit-toggle-track"></span>
              </label>
            </div>
            <div class="kit-row notif-body" style="display:none">
              <span class="kit-row-label notif-dim-label">Type</span>
              <div class="notif-mode-options">
                <label class="notif-mode-label"><input type="radio" class="notif-mode" value="sound"> Sound</label>
                <label class="notif-mode-label"><input type="radio" class="notif-mode" value="voice"> Voice</label>
              </div>
            </div>
            <div class="kit-row notif-sound-row" style="display:none">
              <span class="kit-row-label notif-dim-label">Sound</span>
              <div class="notif-sound-controls">
                <select class="notif-sound-file"></select>
                <button class="btn-secondary notif-sound-preview notif-preview-btn"><i class="ph ph-play"></i></button>
              </div>
            </div>
            <div class="notif-voice-rows" style="display:none">
              <div class="kit-row notif-row-plain">
                <span class="kit-row-label notif-dim-label">Voice</span>
                <select class="notif-voice-select"></select>
              </div>
              <div class="kit-row notif-message-row">
                <span class="kit-row-label notif-template-label">Message</span>
                <div class="notif-message-input-row">
                  <input type="text" class="notif-template">
                  <button class="btn-secondary notif-voice-preview notif-preview-btn"><i class="ph ph-play"></i></button>
                </div>
                <span class="notif-template-hint"></span>
              </div>
            </div>
          </div>
        </template>
        <div id="notifCards"></div>
        <div class="kit-row" id="voicePreviewProjectRow" style="display:none">
          <span class="kit-row-label notif-dim-label">Preview with project</span>
          <select id="voicePreviewProject" class="notif-preview-project-select"></select>
        </div>
        `}

        <div class="kit-section">
          <div class="kit-section-title">Audio</div>
          ${isRemote() ? "" : html`
          ${toggleRow({ label: "Voice dictation", inputId: "voiceDictationSwitch", checked: false })}
          <div class="settings-caption">Shows the mic and push-to-talk in chats. While on, opening a chat loads the speech model (about 1.4 GB of RAM) so the first recording starts instantly.</div>
          <div class="kit-row">
            <span class="kit-row-label">Output device</span>
            <select id="audioOutputDevice">
              <option value="">System default</option>
            </select>
          </div>
          <div class="settings-caption">"System default" follows your computer's default output - if you switch the default device, sounds follow automatically.</div>
          `}
          <div class="kit-row">
            <span class="kit-row-label">Microphone</span>
            <select id="audioInputDevice">
              <option value="">System default</option>
            </select>
          </div>
          <div class="settings-caption">Microphone used for voice input. Device labels appear after granting microphone permission.</div>
          <div class="kit-row">
            <span class="kit-row-label">Push-to-talk</span>
            <div class="ptt-controls">
              <button type="button" id="pttCaptureBtn" class="btn-secondary">Click to set</button>
              <button type="button" id="pttClearBtn" class="btn-secondary ptt-clear" title="Clear binding" aria-label="Clear binding"><i class="ph ph-x"></i></button>
            </div>
          </div>
          <div class="settings-caption">Hold this button (while Conductor is focused) to record voice, release to stop. Click Set, then press a key or mouse side-button. Tip: pick a mouse side-button or a non-printing key so it doesn't type into the box.</div>
        </div>

        ${isRemote() ? "" : html`
        <div class="kit-section" id="characterSoundsSection">
          <div class="kit-section-title">Character sounds</div>
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
