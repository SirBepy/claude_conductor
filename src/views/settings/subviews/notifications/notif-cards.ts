// Per-type notification cards (sound or voice) plus the Piper/web voice lists
// that feed their voice selects. Split out of notifications.ts, which owns
// hydration order and the template these cards clone from.

import { basename } from "../../../../shared/path-utils";
import {
  saveSettings,
  notifCards,
  resetNotifCards,
  NOTIF_TYPES,
} from "../../../../shared/settings-save";
import type { NotifCardRef } from "../../../../shared/settings-save";
import { api } from "../../../../shared/api";

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

export async function renderNotifCard(
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

export function buildNotifCards(): void {
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

export async function loadPiperVoices(): Promise<void> {
  try {
    const status = await api.piperStatus();
    if (status) piperStatusCache = status;
    refreshAllVoiceSelects();
  } catch (e) {
    console.error("[piper] populate failed:", e);
  }
}

export function primeWebVoices(): void {
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

export async function populateVoicePreview(): Promise<void> {
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
