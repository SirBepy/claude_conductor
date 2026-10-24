import { html, render } from "lit-html";
import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { isRemote } from "../../../../shared/transport";
import { settingsHeader, toggleRow } from "../../ui";
import { populateMicPicker, wirePttCapture } from "../notifications/audio-devices";
import "./voice.css";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

async function hydrateVoice(): Promise<void> {
  // Voice dictation persists via saveSettings(), which the daemon refuses from
  // the phone, so its row only exists on the desktop. Mic picker
  // and push-to-talk are localStorage-only and stay live on the phone.
  if (!isRemote()) {
    const voiceSwitch = $("voiceDictationSwitch") as HTMLInputElement | null;
    if (voiceSwitch) {
      voiceSwitch.checked = getSettings().voiceDictationEnabled === true;
      voiceSwitch.addEventListener("change", saveSettings);
    }
  }
  await populateMicPicker();
  wirePttCapture();
}

export async function renderVoiceView(root: HTMLElement): Promise<() => void> {
  render(template(), root);
  try { await hydrateVoice(); }
  catch (e) { console.error("[voice] render failed", e); }
  return () => { /* no teardown */ };
}

function template() {
  return html`
    <div class="view view-settings-voice">
      ${settingsHeader("Voice & dictation")}
      <div class="view-body">
        <div class="kit-section">
          <div class="kit-section-title">Dictation</div>
          ${isRemote() ? "" : html`
          ${toggleRow({ label: "Voice dictation", inputId: "voiceDictationSwitch", checked: false })}
          <div class="settings-caption">Shows the mic and push-to-talk in chats. While on, opening a chat loads the speech model (about 1.4 GB of RAM) so the first recording starts instantly.</div>
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
      </div>
    </div>
  `;
}
