import { html, render } from "lit-html";
import { basename } from "../../../../shared/path-utils";
import {
  saveSettings,
  notifCards,
  resetNotifCards,
  NOTIF_TYPES,
} from "../../../../shared/settings-save";
import type { NotifCardRef } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { isRemote } from "../../../../shared/transport";
import { pushSupported, pushEnabledLocally, enablePush, disablePush } from "../../../../shared/push";
import { populateAudioDevicePicker } from "../../../../../vendor/tauri_kit/frontend/audio/device-picker";
import { listMics, getSelectedMic, setSelectedMic } from "../../../../shared/chat/voice/voice-devices";
import {
  getPttBinding,
  setPttBinding,
  formatPttBinding,
  keyCodeLabel,
  mouseButtonLabel,
} from "../../../../shared/chat/voice/push-to-talk";
import { settingsHeader, toggleRow } from "../../ui";
import "./notifications.css";

const DEFAULT_SOUNDS: { id: string; label: string }[] = [
  { id: "sound1.mp3", label: "Sound 1" },
  { id: "sound2.mp3", label: "Sound 2" },
  { id: "sound3.mp3", label: "Sound 3" },
  { id: "sound4.mp3", label: "Sound 4" },
  { id: "sound5.mp3", label: "Sound 5" },
  { id: "sound6.mp3", label: "Sound 6" },
];

function populateDefaultSoundSelect(sel: HTMLSelectElement, currentSoundId: string | undefined): void {
  sel.innerHTML = DEFAULT_SOUNDS.map((s) => {
    const selected = s.id === currentSoundId ? " selected" : "";
    return `<option value="${s.id}"${selected}>${s.label}</option>`;
  }).join("");
}

interface PiperVoice { id: string; label: string; installed: boolean; [k: string]: unknown; }
interface PiperStatus { voices?: PiperVoice[]; [k: string]: unknown; }

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

let piperStatusCache: PiperStatus | null = null;

function getInstalledPiperVoices(): PiperVoice[] {
  return (piperStatusCache?.voices || []).filter((v) => v.installed);
}

function populateVoiceSelect(sel: HTMLSelectElement, selected: string | null): void {
  const webVoices = (window.speechSynthesis?.getVoices() || []).filter((v) => v.name && v.name !== "Matej");
  const piperVoices = getInstalledPiperVoices();
  const parts: string[] = [];
  if (piperVoices.length) {
    parts.push(`<optgroup label="High-quality (Piper)">${piperVoices.map((v) => `<option value="${v.id}"${v.id === selected ? " selected" : ""}>${v.label}</option>`).join("")}</optgroup>`);
  }
  if (webVoices.length) {
    parts.push(`<optgroup label="System voices">${webVoices.map((v) => `<option value="${v.name}"${v.name === selected ? " selected" : ""}>${v.name}</option>`).join("")}</optgroup>`);
  }
  if (!parts.length) parts.push(`<option value="">(loading voices...)</option>`);
  sel.innerHTML = parts.join("");
  if (selected) {
    const opt = Array.from(sel.options).find((o) => o.value === selected);
    if (opt) sel.value = selected;
  }
}

function refreshAllVoiceSelects(): void {
  for (const t of NOTIF_TYPES) {
    const c = notifCards[t.key];
    if (!c) continue;
    const desired = c.voiceSelect.dataset.desired || c.voiceSelect.value || null;
    populateVoiceSelect(c.voiceSelect, desired);
  }
}

interface FullNotifCardRef extends NotifCardRef {
  root: HTMLElement;
  body: HTMLElement;
  soundRow: HTMLElement;
  soundPreview: HTMLButtonElement;
  voiceRows: HTMLElement;
  voicePreview: HTMLButtonElement;
}

const fullCards: Record<string, FullNotifCardRef> = {};

function applyNotifCardVisibility(type: string): void {
  const c = fullCards[type];
  if (!c) return;
  const enabled = c.enabled.checked;
  const mode = Array.from(c.modes).find((r) => r.checked)?.value || "sound";
  c.body.style.display = enabled ? "flex" : "none";
  c.soundRow.style.display = (enabled && mode === "sound") ? "flex" : "none";
  c.voiceRows.style.display = (enabled && mode === "voice") ? "flex" : "none";
}

async function renderNotifCard(
  type: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  const c = fullCards[type];
  if (!c) return;
  const def = NOTIF_TYPES.find((n) => n.key === type);
  if (!def) return;
  c.enabled.checked = cfg.enabled !== false;
  const mode = cfg.mode === "voice" ? "voice" : "sound";
  c.modes.forEach((r) => { r.checked = r.value === mode; });

  const currentSound = (cfg.soundFile as string) || def.defaultSound;
  populateDefaultSoundSelect(c.soundFile, currentSound);

  c.template.value = (cfg.template as string) || def.defaultTemplate;
  if (cfg.voiceName) c.voiceSelect.dataset.desired = cfg.voiceName as string;
  populateVoiceSelect(c.voiceSelect, (cfg.voiceName as string) || null);
  applyNotifCardVisibility(type);
}

function wireNotifCard(type: string): void {
  const c = fullCards[type];
  const def = NOTIF_TYPES.find((n) => n.key === type);
  if (!c || !def) return;
  const onToggle = () => { applyNotifCardVisibility(type); saveSettings(); };
  c.enabled.addEventListener("change", onToggle);
  c.modes.forEach((r) => r.addEventListener("change", onToggle));
  c.soundFile.addEventListener("change", saveSettings);
  c.template.addEventListener("input", saveSettings);
  c.voiceSelect.addEventListener("change", () => {
    c.voiceSelect.dataset.desired = c.voiceSelect.value || "";
    saveSettings();
  });
  c.soundPreview.onclick = () => {
    api.playSoundPreview(c.soundFile.value).catch((e) => {
      console.error("[sound preview] failed", e);
    });
  };
  c.voicePreview.onclick = () => {
    const voicePreviewProject = $("voicePreviewProject") as HTMLSelectElement | null;
    const cwd = voicePreviewProject?.value || "";
    const rawName = cwd ? (basename(cwd) || "Project") : "Project";
    const name = rawName.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
    const text = (c.template.value || def.defaultTemplate)
      .replace(/\{name\}/g, name)
      .replace(/\{percent\}/g, "80%")
      .replace(/[_\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;
    void api.speakPreview({ text, voiceName: c.voiceSelect.value || null });
  };
}

function buildNotifCards(): void {
  const notifCardsRoot = $("notifCards");
  const notifCardTemplate = $("notifCardTemplate") as HTMLTemplateElement | null;
  if (!notifCardsRoot || !notifCardTemplate) {
    console.error("[notif] template or root missing");
    return;
  }
  resetNotifCards();
  for (const k of Object.keys(fullCards)) delete fullCards[k];
  notifCardsRoot.innerHTML = "";
  for (const t of NOTIF_TYPES) {
    const first = notifCardTemplate.content.firstElementChild;
    if (!first) continue;
    const node = first.cloneNode(true) as HTMLElement;
    const titleEl = node.querySelector<HTMLElement>(".notif-title");
    if (titleEl) titleEl.textContent = t.title;
    const hintEl = node.querySelector<HTMLElement>(".notif-template-hint");
    if (hintEl) hintEl.textContent = t.hint;
    node.querySelectorAll<HTMLInputElement>(".notif-mode").forEach((r) => { r.name = `notif-mode-${t.key}`; });
    notifCardsRoot.appendChild(node);
    const ref: FullNotifCardRef = {
      root: node,
      enabled: node.querySelector<HTMLInputElement>(".notif-enabled")!,
      body: node.querySelector<HTMLElement>(".notif-body")!,
      modes: node.querySelectorAll<HTMLInputElement>(".notif-mode"),
      soundRow: node.querySelector<HTMLElement>(".notif-sound-row")!,
      soundFile: node.querySelector<HTMLSelectElement>(".notif-sound-file")!,
      soundPreview: node.querySelector<HTMLButtonElement>(".notif-sound-preview")!,
      voiceRows: node.querySelector<HTMLElement>(".notif-voice-rows")!,
      voiceSelect: node.querySelector<HTMLSelectElement>(".notif-voice-select")!,
      template: node.querySelector<HTMLInputElement>(".notif-template")!,
      voicePreview: node.querySelector<HTMLButtonElement>(".notif-voice-preview")!,
    };
    fullCards[t.key] = ref;
    notifCards[t.key] = {
      enabled: ref.enabled,
      modes: ref.modes,
      soundFile: ref.soundFile,
      voiceSelect: ref.voiceSelect,
      template: ref.template,
    };
    wireNotifCard(t.key);
  }
}

async function loadPiperVoices(): Promise<void> {
  try {
    const status = await api.piperStatus();
    if (status) piperStatusCache = status;
    refreshAllVoiceSelects();
  } catch (e) {
    console.error("[piper] populate failed:", e);
  }
}

function primeWebVoices(): void {
  if (!window.speechSynthesis) return;
  let tries = 0;
  const tick = () => {
    const list = window.speechSynthesis.getVoices() || [];
    if (list.length > 0) { refreshAllVoiceSelects(); return; }
    if (tries++ < 30) setTimeout(tick, 100);
  };
  tick();
  window.speechSynthesis.addEventListener?.("voiceschanged", refreshAllVoiceSelects);
  window.speechSynthesis.onvoiceschanged = refreshAllVoiceSelects;
}

function applyMuteAllVisual(): void {
  const muteAllSwitch = $("muteAllSwitch") as HTMLInputElement | null;
  const muteSection = $("muteSection");
  if (!muteAllSwitch || !muteSection) return;
  muteSection.classList.toggle("mute-all-on", muteAllSwitch.checked);
}

async function populateVoicePreview(): Promise<void> {
  const voicePreviewProject = $("voicePreviewProject") as HTMLSelectElement | null;
  if (!voicePreviewProject) return;
  const history = (await api.getTokenHistory()) || [];
  const seen = new Set<string>();
  const projects: string[] = [];
  for (let i = history.length - 1; i >= 0 && projects.length < 5; i--) {
    const cwd = history[i]?.cwd;
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    projects.push(cwd);
  }
  voicePreviewProject.innerHTML = projects.length
    ? projects.map((p) => `<option value="${p}">${basename(p)}</option>`).join("")
    : `<option value="">No projects yet</option>`;
}

async function hydrateNotifications(): Promise<void> {
  const s = getSettings();
  const muteAllSwitch = $("muteAllSwitch") as HTMLInputElement | null;
  const muteSoundsSwitch = $("muteSoundsSwitch") as HTMLInputElement | null;
  const muteSystemSwitch = $("muteSystemSwitch") as HTMLInputElement | null;
  const pauseInMeetingSwitch = $("pauseInMeetingSwitch") as HTMLInputElement | null;
  const voicePreviewProjectRow = $("voicePreviewProjectRow");
  if (!muteAllSwitch || !muteSoundsSwitch || !muteSystemSwitch) return;

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

  buildNotifCards();
  const notifs = (s.notifications as Record<string, Record<string, unknown>>) || {};
  await Promise.all(NOTIF_TYPES.map((t) => renderNotifCard(t.key, notifs[t.key] || {})));
  await populateVoicePreview();
  await loadPiperVoices();
  primeWebVoices();

  if (voicePreviewProjectRow) voicePreviewProjectRow.style.display = "flex";

  await populateDevicePicker();
  await populateMicPicker();
  wirePttCapture();

  // Per-slot character-sound toggles. Each defaults ON when its key is absent.
  const slots = (s.characterSoundSlots as Record<string, boolean | undefined>) || {};
  for (const [id, key] of CHARACTER_SLOT_SWITCHES) {
    const el = $(id) as HTMLInputElement | null;
    if (!el) continue;
    el.checked = slots[key] !== false;
    el.addEventListener("change", saveSettings);
  }
  const selectOnClick = $("selectOnSessionClickSwitch") as HTMLInputElement | null;
  if (selectOnClick) {
    // Default off.
    selectOnClick.checked = s.selectOnSessionClick === true;
    selectOnClick.addEventListener("change", saveSettings);
  }
}

async function populateDevicePicker(): Promise<void> {
  const sel = $("audioOutputDevice") as HTMLSelectElement | null;
  if (!sel) return;
  const current = (getSettings().audioOutputDevice as string | null) || "";
  const devices = await api.listAudioOutputDevices();
  populateAudioDevicePicker(sel, devices, current);
  sel.removeEventListener("change", saveSettings);
  sel.addEventListener("change", saveSettings);
}

async function populateMicPicker(): Promise<void> {
  const sel = $("audioInputDevice") as HTMLSelectElement | null;
  if (!sel) return;
  const mics = await listMics();
  const current = getSelectedMic() || "";
  sel.innerHTML = '<option value="">System default</option>';
  for (const mic of mics) {
    const opt = document.createElement("option");
    opt.value = mic.deviceId;
    opt.textContent = mic.label;
    if (mic.deviceId === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.removeEventListener("change", onMicChange);
  sel.addEventListener("change", onMicChange);
}

function onMicChange(e: Event): void {
  const sel = e.target as HTMLSelectElement;
  setSelectedMic(sel.value || null);
}

// Push-to-talk binding capture: click "Set", then the next key or mouse
// side-button press becomes the hold-to-record binding. Left click is ignored
// during capture so re-clicking the button just toggles capture off.
function wirePttCapture(): void {
  const btn = $("pttCaptureBtn") as HTMLButtonElement | null;
  const clear = $("pttClearBtn") as HTMLButtonElement | null;
  if (!btn) return;

  let keyListener: ((e: KeyboardEvent) => void) | null = null;
  let mouseListener: ((e: MouseEvent) => void) | null = null;

  function refresh(): void {
    const b = getPttBinding();
    if (btn) btn.textContent = b ? formatPttBinding(b) : "Click to set";
    if (clear) clear.style.display = b ? "" : "none";
  }

  function stop(): void {
    if (keyListener) document.removeEventListener("keydown", keyListener, true);
    if (mouseListener) document.removeEventListener("mousedown", mouseListener, true);
    keyListener = null;
    mouseListener = null;
    refresh();
  }

  function start(): void {
    if (keyListener) { stop(); return; } // already capturing -> cancel
    if (btn) btn.textContent = "Press a key or mouse button… (Esc to cancel)";
    keyListener = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { stop(); return; }
      setPttBinding({ kind: "key", code: e.code, label: keyCodeLabel(e.code) });
      stop();
    };
    mouseListener = (e: MouseEvent) => {
      if (e.button === 0) return; // the activating left-click, not a binding
      e.preventDefault();
      e.stopPropagation();
      setPttBinding({ kind: "mouse", button: e.button, label: mouseButtonLabel(e.button) });
      stop();
    };
    document.addEventListener("keydown", keyListener, true);
    document.addEventListener("mousedown", mouseListener, true);
  }

  btn.addEventListener("click", (e) => { e.stopPropagation(); start(); });
  clear?.addEventListener("click", (e) => { e.stopPropagation(); setPttBinding(null); stop(); });
  refresh();
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

// Phone-only Web Push enrolment (ai_todo 119). The desktop drives OS notifs via
// the cards below; the phone instead subscribes to daemon-sent pushes for "Claude
// is blocked on you" while the PC is idle. Hidden entirely on desktop and on
// browsers without Push support.
function wirePushSection(root: HTMLElement): void {
  const section = root.querySelector<HTMLElement>("#push-section");
  if (!section) return;
  if (!isRemote() || !pushSupported()) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  const toggle = root.querySelector<HTMLInputElement>("#push-enabled");
  const statusEl = root.querySelector<HTMLElement>("#push-status");
  if (!toggle) return;
  toggle.checked = pushEnabledLocally();

  const setStatus = (msg: string) => { if (statusEl) statusEl.textContent = msg; };

  toggle.onchange = () => {
    void (async () => {
      toggle.disabled = true;
      if (toggle.checked) {
        const res = await enablePush();
        if (res.ok) {
          setStatus("On - your phone will buzz when Claude needs you and the PC is idle.");
        } else {
          toggle.checked = false;
          setStatus(
            res.reason === "denied"
              ? "Notification permission was blocked. Allow it in your browser settings, then try again."
              : res.reason === "unsupported"
                ? "This browser can't do push notifications."
                : "Couldn't enable push. Check the connection and try again.",
          );
        }
      } else {
        await disablePush();
        setStatus("Off.");
      }
      toggle.disabled = false;
    })();
  };
}

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

        <div class="kit-section">
          <div class="kit-section-title">Audio</div>
          <div class="kit-row">
            <span class="kit-row-label">Output device</span>
            <select id="audioOutputDevice">
              <option value="">System default</option>
            </select>
          </div>
          <div class="settings-caption">"System default" follows your computer's default output - if you switch the default device, sounds follow automatically.</div>
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
      </div>
    </div>
  `;
}
