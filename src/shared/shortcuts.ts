// src/shared/shortcuts.ts

import { isFormControlElement } from "./text-entry";
import { createModifierHintTracker, type ModifierHint } from "./modifier-hint";
import { modelShortcutHint } from "./model-shortcuts";

export interface ShortcutDef {
  id: string;
  defaultKeys: string;
  label: string;
  description: string;
  context?: string;
  suppressInInput: boolean;
  todo?: string;
}

const SHORTCUT_DEFS: ShortcutDef[] = [
  // Global
  { id: "new-chat",   defaultKeys: "ctrl+n",       label: "New chat",       description: "Open project picker to start a chat",   context: "sessions", suppressInInput: false },
  { id: "go-home",    defaultKeys: "ctrl+shift+h",  label: "Go to Home",     description: "Navigate to the Home view",              suppressInInput: true },
  { id: "go-chats",   defaultKeys: "ctrl+shift+c",  label: "Go to Chats",    description: "Navigate to the Chats view",             suppressInInput: true },

  // Chats view
  { id: "open-chat-1", defaultKeys: "ctrl+1", label: "Open chat 1", description: "Open the most recent chat",    context: "sessions", suppressInInput: false },
  { id: "open-chat-2", defaultKeys: "ctrl+2", label: "Open chat 2", description: "Open the 2nd most recent chat", context: "sessions", suppressInInput: false },
  { id: "open-chat-3", defaultKeys: "ctrl+3", label: "Open chat 3", description: "Open the 3rd most recent chat", context: "sessions", suppressInInput: false },
  { id: "open-chat-4", defaultKeys: "ctrl+4", label: "Open chat 4", description: "Open the 4th most recent chat", context: "sessions", suppressInInput: false },
  { id: "open-chat-5", defaultKeys: "ctrl+5", label: "Open chat 5", description: "Open the 5th most recent chat", context: "sessions", suppressInInput: false },
  { id: "open-chat-6", defaultKeys: "ctrl+6", label: "Open chat 6", description: "Open the 6th most recent chat", context: "sessions", suppressInInput: false },
  { id: "open-chat-7", defaultKeys: "ctrl+7", label: "Open chat 7", description: "Open the 7th most recent chat", context: "sessions", suppressInInput: false },
  { id: "open-chat-8", defaultKeys: "ctrl+8", label: "Open chat 8", description: "Open the 8th most recent chat", context: "sessions", suppressInInput: false },
  { id: "open-chat-9", defaultKeys: "ctrl+9", label: "Open chat 9", description: "Open the 9th most recent chat", context: "sessions", suppressInInput: false },
  { id: "close-chat",  defaultKeys: "ctrl+w", label: "Close chat",  description: "Close the focused chat (always asks to confirm)", context: "sessions", suppressInInput: false },
  { id: "toggle-wrap-up-on-done", defaultKeys: "ctrl+shift+w", label: "Toggle wrap up when done", description: "Have Claude self-verify, commit, and close the focused chat on its own once nothing more is needed from you", context: "sessions", suppressInInput: false },
  { id: "project-dashboard", defaultKeys: "ctrl+shift+d", label: "Project dashboard", description: "Show the focused chat's project dashboard", context: "sessions", suppressInInput: false },
  { id: "set-model-1", defaultKeys: "alt+1", label: "Model: Haiku",  description: "Switch the open chat or draft to the 1st model", context: "sessions", suppressInInput: false },
  { id: "set-model-2", defaultKeys: "alt+2", label: "Model: Sonnet", description: "Switch the open chat or draft to the 2nd model", context: "sessions", suppressInInput: false },
  { id: "set-model-3", defaultKeys: "alt+3", label: "Model: Opus",   description: "Switch the open chat or draft to the 3rd model", context: "sessions", suppressInInput: false },
  { id: "set-model-4", defaultKeys: "alt+4", label: "Model: Fable",  description: "Switch the open chat or draft to the 4th model", context: "sessions", suppressInInput: false },
  { id: "effort-up",   defaultKeys: "alt+arrowup",   label: "Effort up",   description: "Raise the open chat's or draft's effort one step",  context: "sessions", suppressInInput: false },
  { id: "effort-down", defaultKeys: "alt+arrowdown", label: "Effort down", description: "Lower the open chat's or draft's effort one step", context: "sessions", suppressInInput: false },
  { id: "blur-composer", defaultKeys: "escape", label: "Unfocus message box", description: "Move keyboard focus off the message input", context: "sessions", suppressInInput: false },

  // Code mode (src/views/sessions/code-mode/) - no view context: it also opens
  // from History and detached chat windows, and docks back from its own window.
  { id: "code-mode",        defaultKeys: "ctrl+shift+e", label: "Code mode",              description: "Enter or leave Code mode for the open chat",          suppressInInput: false },
  { id: "code-mode-popout", defaultKeys: "ctrl+shift+o", label: "Pop out Code mode",      description: "Move Code mode into its own window, or dock it back", suppressInInput: false },
  { id: "quick-open",       defaultKeys: "ctrl+p",       label: "Go to file",             description: "Search the open chat's project files and open one in Code mode", suppressInInput: false },

  // Chats view - new chat from a favourite project slot (see project-favorites.ts)
  { id: "new-chat-favorite-1", defaultKeys: "ctrl+shift+1", label: "New chat: favorite 1", description: "Start a new chat with the project pinned to favorite slot 1", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-2", defaultKeys: "ctrl+shift+2", label: "New chat: favorite 2", description: "Start a new chat with the project pinned to favorite slot 2", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-3", defaultKeys: "ctrl+shift+3", label: "New chat: favorite 3", description: "Start a new chat with the project pinned to favorite slot 3", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-4", defaultKeys: "ctrl+shift+4", label: "New chat: favorite 4", description: "Start a new chat with the project pinned to favorite slot 4", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-5", defaultKeys: "ctrl+shift+5", label: "New chat: favorite 5", description: "Start a new chat with the project pinned to favorite slot 5", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-6", defaultKeys: "ctrl+shift+6", label: "New chat: favorite 6", description: "Start a new chat with the project pinned to favorite slot 6", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-7", defaultKeys: "ctrl+shift+7", label: "New chat: favorite 7", description: "Start a new chat with the project pinned to favorite slot 7", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-8", defaultKeys: "ctrl+shift+8", label: "New chat: favorite 8", description: "Start a new chat with the project pinned to favorite slot 8", context: "sessions", suppressInInput: false },
  { id: "new-chat-favorite-9", defaultKeys: "ctrl+shift+9", label: "New chat: favorite 9", description: "Start a new chat with the project pinned to favorite slot 9", context: "sessions", suppressInInput: false },
];

// ── Storage ────────────────────────────────────────────────────────────────

const LS_KEY = "cc_shortcuts_bindings";

let _bindingsCache: Record<string, string> | null = null;

function loadBindings(): Record<string, string> {
  if (_bindingsCache) return _bindingsCache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    _bindingsCache = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch { _bindingsCache = {}; }
  return _bindingsCache;
}

function saveBindings(overrides: Record<string, string>): void {
  _bindingsCache = overrides;
  try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); }
  catch { /* ignore */ }
}

// ── Runtime state ──────────────────────────────────────────────────────────

const handlers = new Map<string, () => void | Promise<void>>();
const modifierHintCallbacks = new Set<(hint: ModifierHint) => void>();

// ── Pure helpers (exported for tests) ─────────────────────────────────────

const SHIFT_DIGIT_MAP: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
};

export function normalizeEvent(e: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
}): string {
  let key = e.key.toLowerCase();
  if (key === "control" || key === "shift" || key === "alt" || key === "meta") return "";
  // Shift+digit produces "!", "@", etc. on standard keyboards - normalize back to the digit.
  if (e.shiftKey) {
    const mapped = SHIFT_DIGIT_MAP[e.key];
    if (mapped) key = mapped;
  }
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(key);
  return parts.join("+");
}

/** A def's own override wins. Without one, its default holds unless another
 *  def has been rebound onto those keys: the rebind predates the default (a
 *  default added later is never checked against stored overrides), so the
 *  user's explicit choice keeps the keys and the newer default reads unbound. */
function effectiveBinding(def: ShortcutDef, overrides: Record<string, string>): string {
  const own = overrides[def.id];
  if (own !== undefined) return own;
  const taken = SHORTCUT_DEFS.some(
    other => other.id !== def.id && overrides[other.id] === def.defaultKeys,
  );
  return taken ? "" : def.defaultKeys;
}

export function findConflict(keys: string, excludeId?: string): ShortcutDef | null {
  const overrides = loadBindings();
  for (const def of SHORTCUT_DEFS) {
    if (def.id === excludeId) continue;
    if (effectiveBinding(def, overrides) === keys) return def;
  }
  return null;
}

/** The def a key combo fires, or null. At most one: see effectiveBinding. */
export function resolveCombo(combo: string): ShortcutDef | null {
  if (!combo) return null;
  const overrides = loadBindings();
  return SHORTCUT_DEFS.find(d => effectiveBinding(d, overrides) === combo) ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function register(id: string, handler: () => void | Promise<void>): void {
  handlers.set(id, handler);
}

export function unregister(id: string): void {
  handlers.delete(id);
}

/** Fires when the held modifiers change what should be revealed: Ctrl alone
 *  shows chat numbers, Ctrl+Shift shows the favourite slots. */
export function onModifierHint(cb: (hint: ModifierHint) => void): () => void {
  modifierHintCallbacks.add(cb);
  return () => modifierHintCallbacks.delete(cb);
}

export function getAll(): ShortcutDef[] {
  return [...SHORTCUT_DEFS];
}

export function getBinding(id: string): string {
  const overrides = loadBindings();
  const def = SHORTCUT_DEFS.find(d => d.id === id);
  if (!def) return "";
  return effectiveBinding(def, overrides);
}

export function setBinding(id: string, keys: string): void {
  const overrides = loadBindings();
  overrides[id] = keys;
  saveBindings(overrides);
}

export function resetBinding(id: string): void {
  const overrides = loadBindings();
  delete overrides[id];
  saveBindings(overrides);
}

export function hasOverride(id: string): boolean {
  const overrides = loadBindings();
  return Object.prototype.hasOwnProperty.call(overrides, id);
}

// ── Numbered ranges (Open chat 1-9, New chat: favorite 1-9) ────────────────
// The Settings list shows each family as one row. Slot N is always the shared
// modifiers plus the digit N, so a range is edited as "which modifiers".

export interface ShortcutRange {
  prefix: string;
  label: string;
  description: string;
}

export const SHORTCUT_RANGES: readonly ShortcutRange[] = [
  { prefix: "open-chat-", label: "Open chat 1-9", description: "Open the Nth most recent chat" },
  { prefix: "new-chat-favorite-", label: "New chat: favorite 1-9", description: "Start a new chat with the project pinned to favorite slot N" },
];

const RANGE_SLOTS = 9;

export function rangeIds(prefix: string): string[] {
  return Array.from({ length: RANGE_SLOTS }, (_, i) => `${prefix}${i + 1}`);
}

/** Modifiers of slot 1 ("ctrl", "ctrl+shift"); legacy per-slot overrides that
 *  disagree are ignored, and the next rebind overwrites them. */
export function getRangeModifiers(prefix: string): string {
  return getBinding(`${prefix}1`).split("+").slice(0, -1).join("+");
}

export function rangeHasOverride(prefix: string): boolean {
  return rangeIds(prefix).some(hasOverride);
}

export type RangeRebindResult =
  | { ok: true }
  | { ok: false; conflict: ShortcutDef }
  | { ok: false; conflict: null };

/** Takes only the modifiers of a captured combo and writes modifiers+N to all
 *  nine slots. Nothing is written if any slot would collide with a shortcut
 *  outside the range. A modifier-less combo is refused: bare digits would
 *  fire while typing in the composer. */
export function setRangeFromCombo(prefix: string, combo: string): RangeRebindResult {
  const mods = combo.split("+").slice(0, -1);
  if (mods.length === 0) return { ok: false, conflict: null };
  const ids = rangeIds(prefix);
  const overrides = loadBindings();
  const next = ids.map((_, i) => [...mods, String(i + 1)].join("+"));
  for (const keys of next) {
    for (const def of SHORTCUT_DEFS) {
      if (ids.includes(def.id)) continue;
      if (effectiveBinding(def, overrides) === keys) return { ok: false, conflict: def };
    }
  }
  const updated = { ...overrides };
  ids.forEach((id, i) => { updated[id] = [...mods, String(i + 1)].join("+"); });
  saveBindings(updated);
  return { ok: true };
}

export function resetRange(prefix: string): void {
  const overrides = { ...loadBindings() };
  for (const id of rangeIds(prefix)) delete overrides[id];
  saveBindings(overrides);
}

// ── Dispatcher (DOM — guarded for test environments) ──────────────────────

function _init(): void {
  const modifierHint = createModifierHintTracker((hint) => {
    for (const cb of modifierHintCallbacks) cb(hint);
  });

  // Lazy import avoids loading DOM-dependent navigation module in test environments.
  let getActiveView: (() => string) | null = null;
  void import("./navigation").then(m => { getActiveView = m.getActiveView; });
  let isAnyModalOpen: (() => boolean) | null = null;
  void import("./modal-input-lock").then(m => { isAnyModalOpen = m.isAnyModalOpen; });

  // Held Alt shows the model/effort keys as keycaps under the pane header's values
  // (config-bump.css), and keeps showing them through repeated Alt+Up/Down.
  // The model hint's range follows the live model list (config-bump.css reads
  // the custom property), so it never promises a slot with no model behind it.
  const setAltHeld = (on: boolean) => {
    const root = document.documentElement;
    if (on) root.style.setProperty("--alt-model-hint", JSON.stringify(modelShortcutHint()));
    root.classList.toggle("alt-held", on);
  };

  document.addEventListener("keydown", (e) => {
    setAltHeld(e.altKey && !e.ctrlKey && !e.metaKey);
    modifierHint.keydown(e);
    if (e.key === "Control" || e.key === "Meta") return;

    if (isAnyModalOpen?.()) return;

    const combo = normalizeEvent(e);
    if (!combo) return;

    const def = resolveCombo(combo);
    if (!def) return;

    if (def.suppressInInput && isFormControlElement(document.activeElement)) return;

    if (def.context && getActiveView && getActiveView() !== def.context) return;

    const handler = handlers.get(def.id);
    if (!handler) return;

    e.preventDefault();
    void handler();
  });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt") setAltHeld(false);
    modifierHint.keyup(e);
  });

  window.addEventListener("blur", () => {
    setAltHeld(false);
    modifierHint.reset();
  });
}

if (typeof document !== "undefined") {
  _init();
}
