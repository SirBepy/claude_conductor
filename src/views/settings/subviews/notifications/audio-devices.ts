// Audio output/input pickers and the push-to-talk binding capture. Split out
// of notifications.ts. The output picker persists via saveSettings (desktop
// only); the mic and push-to-talk binding are localStorage-only, so they stay
// live on the phone.

import { saveSettings } from "../../../../shared/settings-save";
import { getSettings } from "../../../../shared/state";
import { api } from "../../../../shared/api";
import { populateAudioDevicePicker } from "../../../../../vendor/tauri_kit/frontend/audio/device-picker";
import { listMics, getSelectedMic, setSelectedMic } from "../../../../shared/chat/voice/voice-devices";
import {
  getPttBinding,
  setPttBinding,
  formatPttBinding,
  keyCodeLabel,
  mouseButtonLabel,
} from "../../../../shared/chat/voice/push-to-talk";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export async function populateDevicePicker(): Promise<void> {
  const sel = $("audioOutputDevice") as HTMLSelectElement | null;
  if (!sel) return;
  const current = (getSettings().audioOutputDevice as string | null) || "";
  const devices = await api.listAudioOutputDevices();
  populateAudioDevicePicker(sel, devices, current);
  sel.removeEventListener("change", saveSettings);
  sel.addEventListener("change", saveSettings);
}

export async function populateMicPicker(): Promise<void> {
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
export function wirePttCapture(): void {
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
