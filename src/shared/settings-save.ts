/**
 * Ported from src/modules/settings.js saveSettings().
 * Reads every DOM field defensively. When a subview isn't mounted, falls back
 * to whatever is already in currentSettings so round-trips don't drop data.
 */

import { getSettings, type SettingsShape } from "./state";
import { updateSettings } from "./settings-update";
import { showToast } from "./toast";

// True while a pass reads no controls at all, so every field resolves to what the
// given settings alone say it is (see `buildManaged`).
let domless = false;

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return domless ? null : (document.getElementById(id) as T | null);
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
  if (domless || !Object.keys(notifCards).length) {
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

function valOr(id: string, fallback: string): string {
  const el = byId<HTMLInputElement | HTMLSelectElement>(id);
  return el ? el.value : fallback;
}

function chkOr(id: string, fallback: boolean): boolean {
  const el = byId<HTMLInputElement>(id);
  return el ? el.checked : fallback;
}

// The fields this page manages, as the controls hold them (or as `prev` says,
// where a control is not mounted or `domless`). `prev` is the full settings
// object from a fresh `get_settings` read.
function buildManaged(prev: SettingsShape): SettingsShape {
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

    return {
      theme: (() => {
      // Theme is stored as a flat id ("void" | "void-light"); the DOM carries it
      // as the styleguide 2D pair (data-theme=<palette> + data-mode=light|dark).
      const el = document.documentElement;
      const palette = domless ? undefined : el.dataset.theme;
      if (!palette) return (prev.theme as string) || "void";
      return el.dataset.mode === "light" ? `${palette}-light` : palette;
    })(),
    // DOM id stays "launchAtLogin" (see subviews/power/power.ts); the
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
    // Default on: absent key or unmounted subview both resolve to true.
    pushShowChatName: chkOr("pushShowChatNameSwitch", prev.pushShowChatName !== false),
    // Default off: opt-in.
    hideInMeeting: chkOr("hideInMeetingSwitch", !!prev.hideInMeeting),
    characterSoundSlots,
    // Default off: opt-in "play select when clicking a session row".
    selectOnSessionClick: chkOr("selectOnSessionClickSwitch", !!prev.selectOnSessionClick),
    voiceDictationEnabled: chkOr("voiceDictationSwitch", prev.voiceDictationEnabled === true),
    notifications: gatherNotifSettings(prev),
    projectAliases: prev.projectAliases || {},
    projectBlacklist: prev.projectBlacklist || [],
    projects: prev.projects,
    };
}

/** What the controls showed when they were last in step with the settings: set
 *  when a page mounts and after each save. A control still holding this value
 *  has not been edited, however far the live settings have moved on (a peer's
 *  synced change), so it must not write. `null` until a page has mounted. */
let controlsBaseline: SettingsShape | null = null;

function managedFromSettings(settings: SettingsShape): SettingsShape {
  domless = true;
  try {
    return buildManaged(settings);
  } finally {
    domless = false;
  }
}

/** Call right before a settings page renders, which is when its controls read
 *  the settings cache. */
export function captureControlsBaseline(): void {
  controlsBaseline = managedFromSettings(getSettings());
}

const UNCHANGED = Symbol("unchanged");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The value to write for one field, or UNCHANGED to leave `raw` (the live
 *  value, possibly absent) alone. A control is an edit only when it differs
 *  from the live value (`live`, what the settings would give with no controls)
 *  AND from what it showed when it last matched (`shown`): the first rules out
 *  writing a default over an absent key (a fresh install's first save would
 *  stamp a look nobody chose), the second a stale control reverting a peer's
 *  change. Objects are compared key by key, so editing one colour leaves the
 *  other controls of the same setting to the live values. */
function pickEdit(dom: unknown, live: unknown, shown: unknown, hasShown: boolean, raw: unknown): unknown {
  if (same(dom, live) || (hasShown && same(dom, shown))) return UNCHANGED;
  if (isPlainObject(dom) && isPlainObject(live)) {
    const out: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {};
    let edited = false;
    const shownObj = isPlainObject(shown) ? shown : {};
    for (const k of Object.keys(dom)) {
      const r = pickEdit(dom[k], live[k], shownObj[k], hasShown && isPlainObject(shown), out[k]);
      if (r !== UNCHANGED) {
        out[k] = r;
        edited = true;
      }
    }
    return edited ? out : UNCHANGED;
  }
  return dom;
}

export function saveSettings(): void {
  // Runs inside `updateSettings`'s mutate callback, on a FRESH read of
  // backend settings rather than the frontend's own `currentSettings` cache -
  // a save built from that cache is exactly the stale-snapshot bug
  // `updateSettings` closes. Re-run (up to 3x) on a SETTINGS_STALE rejection, each time against
  // whatever is current at that moment, so the DOM fields (the user's real
  // edit) always land on top of the latest daemon-owned state rather than a
  // stale one.
  let nextBaseline: SettingsShape | null = null;
  const buildFromDom = (prev: SettingsShape): SettingsShape => {
    // Round-trip every field the page doesn't edit. `save_settings` is a
    // FULL-REPLACE write (no server-side merge), so any key omitted here would
    // reset to its serde default on save - silently wiping things the Settings
    // page never touches (hooks_registered, default_account_id, retention,
    // sessionCharacters, overlayX/Y, ...). Only a control the user changed
    // overrides the live value (see `pickEdit`).
    const dom = buildManaged(prev);
    const live = managedFromSettings(prev);
    const out: SettingsShape = { ...prev };
    for (const key of Object.keys(dom)) {
      const hasShown = controlsBaseline !== null && key in controlsBaseline;
      const r = pickEdit(dom[key], live[key], controlsBaseline?.[key], hasShown, prev[key]);
      if (r !== UNCHANGED) out[key] = r;
    }
    nextBaseline = controlsBaseline && dom;
    return out;
  };

  // The DOM already reflects the user's edit, and `updateSettings` updates
  // the settings cache on success, so there is nothing to show optimistically
  // here - only a failure needs surfacing.
  void updateSettings(buildFromDom).then(() => {
    // The controls now show what was just saved, whatever else moved meanwhile.
    if (nextBaseline) controlsBaseline = nextBaseline;
  }).catch((err) => {
    console.error("[settings-save] save_settings failed", err);
    showToast("Couldn't save settings - your last change wasn't saved. Try again.");
  });
  const w = window as unknown as {
    renderHistory?: (h: unknown) => void;
    lastHistory?: unknown;
  };
  if (typeof w.renderHistory === "function") w.renderHistory(w.lastHistory);
}

// Back-compat: expose on window for any legacy callers (stats.js, dashboard.js).
(window as unknown as { saveSettings?: () => void }).saveSettings = saveSettings;
