// src/shared/shortcuts.ts

import { isFormControlElement } from "./text-entry";
import { createModifierHintTracker, type ModifierHint } from "./modifier-hint";

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
  { id: "new-chat",   defaultKeys: "ctrl+n",       label: "New chat",       description: "Open project picker to start a chat",   context: "sessions", suppressInInput: true },
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
  { id: "close-chat",  defaultKeys: "ctrl+w", label: "Cancel active turn",  description: "Cancel the current running turn in the focused chat", context: "sessions", suppressInInput: true },
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

export function findConflict(keys: string, excludeId?: string): ShortcutDef | null {
  const overrides = loadBindings();
  for (const def of SHORTCUT_DEFS) {
    if (def.id === excludeId) continue;
    const current = overrides[def.id] ?? def.defaultKeys;
    if (current === keys) return def;
  }
  return null;
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
  return overrides[id] ?? def.defaultKeys;
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

  document.addEventListener("keydown", (e) => {
    modifierHint.keydown(e);
    if (e.key === "Control" || e.key === "Meta") return;

    if (isAnyModalOpen?.()) return;

    const combo = normalizeEvent(e);
    if (!combo) return;

    const overrides = loadBindings();
    const def = SHORTCUT_DEFS.find(d => {
      const binding = overrides[d.id] ?? d.defaultKeys;
      return binding === combo;
    });
    if (!def) return;

    if (def.suppressInInput && isFormControlElement(document.activeElement)) return;

    if (def.context && getActiveView && getActiveView() !== def.context) return;

    const handler = handlers.get(def.id);
    if (!handler) return;

    e.preventDefault();
    void handler();
  });

  document.addEventListener("keyup", (e) => modifierHint.keyup(e));

  window.addEventListener("blur", () => modifierHint.reset());
}

if (typeof document !== "undefined") {
  _init();
}
