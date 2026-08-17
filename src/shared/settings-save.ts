/**
 * Ported from src/modules/settings.js saveSettings().
 * Reads every DOM field defensively. When a subview isn't mounted, falls back
 * to whatever is already in currentSettings so round-trips don't drop data.
 */

import { getSettings, setSettings } from "./state";
import type { SettingsShape } from "./state";
import { api } from "./api";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export interface NotifCardRef {
  enabled: HTMLInputElement;
  modes: NodeListOf<HTMLInputElement>;
  soundFile: HTMLSelectElement;
  voiceSelect: HTMLSelectElement;
  template: HTMLInputElement;
}

export const NOTIF_TYPES: Array<{
  key: string; title: string; hint: string; defaultSound: string; defaultTemplate: string;
}> = [
  { key: "workFinished",  title: "Done (Work Finished)",     hint: "Supports {name}", defaultSound: "sound1.mp3", defaultTemplate: "{name} is done" },
  { key: "questionAsked", title: "Waiting (Question Asked)", hint: "Supports {name}", defaultSound: "sound3.mp3", defaultTemplate: "{name} is waiting" },
];

// Shared registry used by the notifications subview to publish card refs.
export const notifCards: Record<string, NotifCardRef> = {};

export function resetNotifCards(): void {
  for (const k of Object.keys(notifCards)) delete notifCards[k];
}

function gatherNotifSettings(prev: SettingsShape): Record<string, unknown> {
  if (!Object.keys(notifCards).length) {
    return (prev.notifications as Record<string, unknown>) || {};
  }
  const out: Record<string, unknown> = {};
  for (const t of NOTIF_TYPES) {
    const c = notifCards[t.key];
    if (!c) {
      out[t.key] = { enabled: true, mode: "sound", soundFile: t.defaultSound, voiceName: null, template: t.defaultTemplate };
      continue;
    }
    const mode = Array.from(c.modes).find((r) => r.checked)?.value || "sound";
    out[t.key] = {
      enabled: c.enabled.checked,
      mode,
      soundPack: "default",
      soundFile: c.soundFile.value,
      voiceName: c.voiceSelect.value || c.voiceSelect.dataset.desired || null,
      template: c.template.value || t.defaultTemplate,
    };
  }
  return out;
}

export function saveSettings(): void {
  const prev = getSettings();
  const valOr = (id: string, fallback: string): string => {
    const el = byId<HTMLInputElement | HTMLSelectElement>(id);
    return el ? el.value : fallback;
  };
  const chkOr = (id: string, fallback: boolean): boolean => {
    const el = byId<HTMLInputElement>(id);
    return el ? el.checked : fallback;
  };

  const prevColorApply = (prev.colorApplyTo as Record<string, boolean | undefined>) || {};
  const prevPace = (prev.paceColors as Record<string, string | undefined>) || {};
  // Per-slot character-sound toggles. Default ON (absent key or unmounted Sound
  // subview both resolve to true) so existing users keep hearing every slot.
  const prevSlots = (prev.characterSoundSlots as Record<string, boolean | undefined>) || {};
  const characterSoundSlots = {
    workFinished: chkOr("soundSlotWorkFinished", prevSlots.workFinished !== false),
    questionAsked: chkOr("soundSlotQuestionAsked", prevSlots.questionAsked !== false),
    select: chkOr("soundSlotSelect", prevSlots.select !== false),
    ready: chkOr("soundSlotReady", prevSlots.ready !== false),
    death: chkOr("soundSlotDeath", prevSlots.death !== false),
    annoyed: chkOr("soundSlotAnnoyed", prevSlots.annoyed !== false),
  };

  const settings: SettingsShape = {
    // Round-trip every field this function doesn't manage. `prev` is the full
    // settings object from Rust `get_settings`, and `save_settings` is a
    // FULL-REPLACE write (no server-side merge), so any key omitted here would
    // reset to its serde default on save - silently wiping things the Settings
    // page never touches (hooks_registered, default_account_id, retention,
    // sessionCharacters, remote_access_enabled, overlayX/Y, ...). The named
    // fields below override this spread with the current DOM values.
    ...prev,
    theme: (() => {
      // Theme is stored as a flat id ("void" | "void-light"); the DOM carries it
      // as the styleguide 2D pair (data-theme=<palette> + data-mode=light|dark).
      const el = document.documentElement;
      const palette = el.dataset.theme;
      if (!palette) return (prev.theme as string) || "void";
      return el.dataset.mode === "light" ? `${palette}-light` : palette;
    })(),
    // DOM id stays "launchAtLogin" (see subviews/system/system.ts); the
    // destination field is the Rust-typed `autostart` (src-tauri/src/lib.rs
    // reads settings.autostart for tauri_plugin_autostart). The old
    // `launchAtLogin` extra-bag key was never read by anything - dropped.
    autostart: chkOr("launchAtLogin", !!prev.autostart),
    autoUpdate: (() => {
      const el = byId<HTMLSelectElement>("autoUpdate");
      if (el && (el.value === "never" || el.value === "onStartup" || el.value === "immediate")) return el.value;
      const p = prev.autoUpdate;
      if (p === true) return "immediate";
      if (p === false) return "never";
      if (typeof p === "string" && (p === "never" || p === "onStartup" || p === "immediate")) return p;
      return "immediate";
    })(),
    // Dashboard widget layout (multi-account milestone 05, replaces the old
    // pinnedCards enum) - the dashboard view owns writing/migrating it. Only
    // carry it through if it already exists: unlike pinnedCards, "absent" is
    // a meaningful state here (resolveDashboardWidgets' one-time pinnedCards
    // migration trigger) - defaulting a never-visited dashboard to `[]` would
    // permanently skip that migration. `undefined` is dropped by JSON
    // serialization, so this omits the key entirely when there's nothing to
    // preserve yet.
    dashboardWidgets: Array.isArray(prev.dashboardWidgets) ? prev.dashboardWidgets : undefined,
    colorApplyTo: {
      dashboard: chkOr("colorApplyDashboard", prevColorApply.dashboard !== false),
      overlay: chkOr("colorApplyOverlay", prevColorApply.overlay !== false),
    },
    overlayOpacity: (() => {
      const el = byId<HTMLInputElement>("overlayOpacity");
      const prevOpacity = typeof prev.overlayOpacity === "number" ? prev.overlayOpacity : 0.72;
      if (!el) return prevOpacity;
      const pct = parseFloat(el.value);
      return Number.isFinite(pct) ? pct / 100 : prevOpacity;
    })(),
    overlayBackgroundStyle: (() => {
      const el = byId<HTMLSelectElement>("overlayBackgroundStyle");
      const prevStyle = prev.overlayBackgroundStyle === "card" ? "card" : "circles";
      if (!el) return prevStyle;
      return el.value === "card" ? "card" : "circles";
    })(),
    paceBand: parseInt(valOr("paceBand", String(prev.paceBand ?? 10)), 10) || 10,
    paceColors: {
      under: valOr("paceColorUnder", prevPace.under || "#27ae60"),
      nearSafe: valOr("paceColorNearSafe", prevPace.nearSafe || "#f1c40f"),
      nearOver: valOr("paceColorNearOver", prevPace.nearOver || "#e67e22"),
      over: valOr("paceColorOver", prevPace.over || "#e74c3c"),
    },
    audioOutputDevice: (() => {
      const el = byId<HTMLSelectElement>("audioOutputDevice");
      if (!el) return prev.audioOutputDevice ?? null;
      return el.value !== "" ? el.value : null;
    })(),
    muteAll: chkOr("muteAllSwitch", !!prev.muteAll),
    muteSounds: chkOr("muteSoundsSwitch", !!prev.muteSounds),
    muteSystemNotifications: chkOr("muteSystemSwitch", !!prev.muteSystemNotifications),
    // Default on: absent key or unmounted subview both resolve to true.
    pauseInMeeting: chkOr("pauseInMeetingSwitch", prev.pauseInMeeting !== false),
    // Default off: opt-in.
    hideInMeeting: chkOr("hideInMeetingSwitch", !!prev.hideInMeeting),
    characterSoundSlots,
    // Default off: opt-in "play select when clicking a session row".
    selectOnSessionClick: chkOr("selectOnSessionClickSwitch", !!prev.selectOnSessionClick),
    notifications: gatherNotifSettings(prev),
    projectAliases: prev.projectAliases || {},
    projectBlacklist: prev.projectBlacklist || [],
    // Preserve unknown extras
    projects: prev.projects,
  };

  setSettings(settings);
  void api.saveSettings(settings);
  const w = window as unknown as {
    renderHistory?: (h: unknown) => void;
    lastHistory?: unknown;
  };
  if (typeof w.renderHistory === "function") w.renderHistory(w.lastHistory);
}

// Back-compat: expose on window for any legacy callers (stats.js, dashboard.js).
(window as unknown as { saveSettings?: () => void }).saveSettings = saveSettings;
