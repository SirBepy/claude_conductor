import { html, render } from "lit-html";
import { saveSettings, NOTIF_TYPES } from "../../../../shared/settings-save";
import { getSettings, setSettings } from "../../../../shared/state";
import { isRemote } from "../../../../shared/transport";
import { invoke } from "../../../../shared/ipc";
import { PHONE_SOUNDS_KEY, phoneSoundsEnabled } from "../../../../shared/remote-voiceline";
import { settingsHeader, toggleRow } from "../../ui";
import {
  buildNotifCards,
  renderNotifCard,
  loadPiperVoices,
  primeWebVoices,
  populateVoicePreview,
} from "./notif-cards";
import { populateDevicePicker } from "./audio-devices";
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
  // The phone's own sounds toggle is local-storage-only and stays live.
  if (!isRemote()) {
    const muteAllSwitch = $("muteAllSwitch") as HTMLInputElement | null;
    const muteSoundsSwitch = $("muteSoundsSwitch") as HTMLInputElement | null;
    const pauseInMeetingSwitch = $("pauseInMeetingSwitch") as HTMLInputElement | null;
    const voicePreviewProjectRow = $("voicePreviewProjectRow");

    if (muteAllSwitch && muteSoundsSwitch) {
      muteAllSwitch.checked = !!s.muteAll;
      muteSoundsSwitch.checked = !!s.muteSounds;
      applyMuteAllVisual();

      muteAllSwitch.addEventListener("change", () => { applyMuteAllVisual(); saveSettings(); });
      muteSoundsSwitch.addEventListener("change", saveSettings);

      if (pauseInMeetingSwitch) {
        // Default on when the key is absent.
        pauseInMeetingSwitch.checked = s.pauseInMeeting !== false;
        pauseInMeetingSwitch.addEventListener("change", saveSettings);
      }
    }

    const showNameSwitch = $("pushShowChatNameSwitch") as HTMLInputElement | null;
    if (showNameSwitch) {
      // Default on when the key is absent.
      showNameSwitch.checked = s.pushShowChatName !== false;
      showNameSwitch.addEventListener("change", saveSettings);
    }

    buildNotifCards();
    const notifs = (s.notifications as Record<string, Record<string, unknown>>) || {};
    await Promise.all(NOTIF_TYPES.map((t) => renderNotifCard(t.key, notifs[t.key] || {})));
    await populateVoicePreview();
    await loadPiperVoices();
    primeWebVoices();

    if (voicePreviewProjectRow) voicePreviewProjectRow.style.display = "flex";

    await populateDevicePicker();
  }

  // Phone: same toggle as the desktop one, but saveSettings is refused there,
  // so it goes through the dedicated single-key RPC instead.
  if (isRemote()) {
    const phoneSounds = $("phoneSoundsSwitch") as HTMLInputElement | null;
    if (phoneSounds) {
      phoneSounds.checked = phoneSoundsEnabled();
      phoneSounds.addEventListener("change", () => {
        try { localStorage.setItem(PHONE_SOUNDS_KEY, phoneSounds.checked ? "on" : "off"); }
        catch { /* ignore */ }
      });
    }
    const phoneShowName = $("pushShowChatNamePhoneSwitch") as HTMLInputElement | null;
    if (phoneShowName) {
      phoneShowName.checked = s.pushShowChatName !== false;
      phoneShowName.addEventListener("change", () => {
        const wanted = phoneShowName.checked;
        invoke("set_push_show_chat_name", { value: wanted }).then(() => {
          // The view hydrates from this cache on its next mount.
          setSettings({ ...getSettings(), pushShowChatName: wanted });
        }).catch((e) => {
          console.error("[notifications] set_push_show_chat_name failed", e);
          phoneShowName.checked = !wanted;
        });
      });
    }
  }
}

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

function template() {
  return html`
    <div class="view view-settings-notifications">
      ${settingsHeader("Notifications")}
      <div class="view-body">
        ${isRemote() ? html`
        <div class="kit-section" id="phoneSoundsSection">
          <div class="kit-section-title">This phone</div>
          ${toggleRow({ label: "Play sounds on this phone", inputId: "phoneSoundsSwitch", checked: true })}
          <div class="settings-caption">Character voice lines play on this phone when a chat finishes or asks a question. Off keeps this phone silent; the PC still plays them.</div>
        </div>
        ` : ""}
        <div class="kit-section" id="push-section" style="display:none">
          <div class="kit-section-title">Push to this phone</div>
          <div id="push-web-rows">
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
          ${toggleRow({ label: "Show chat name in notifications", inputId: "pushShowChatNamePhoneSwitch", checked: true })}
          <div class="settings-caption">Off sends a generic "A chat is waiting on you", so no chat title shows on a lock screen.</div>
        </div>
        ${isRemote() ? "" : html`
        <div class="kit-section" id="phonePushSection">
          <div class="kit-section-title">Phone notifications</div>
          ${toggleRow({ label: "Show chat name in notifications", inputId: "pushShowChatNameSwitch", checked: true })}
          <div class="settings-caption">Off sends a generic "A chat is waiting on you" to the phone's web push and the Android app, so no chat title shows on a lock screen.</div>
        </div>
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

        ${isRemote() ? "" : html`
        <div class="kit-section">
          <div class="kit-section-title">Sound output</div>
          <div class="kit-row">
            <span class="kit-row-label">Output device</span>
            <select id="audioOutputDevice">
              <option value="">System default</option>
            </select>
          </div>
          <div class="settings-caption">"System default" follows your computer's default output - if you switch the default device, sounds follow automatically.</div>
        </div>
        `}
      </div>
    </div>
  `;
}
