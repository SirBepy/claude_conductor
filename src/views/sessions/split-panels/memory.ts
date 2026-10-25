// What the split remembers in localStorage: which panel each chat had in the
// split (leave a chat on Drafts, come back, Drafts is still there, across
// restarts too), and the divider's position, which is one width for every
// chat the way the pane windows' size was.

import type { PanelKey } from "../pane-windows/panels";

const ACTIVE_KEY = "cc.split.active";
const FRACTION_KEY = "cc.split.fraction";
/** Oldest chats fall off first past 60; one untouched that long is not coming back. */
const MAX_CHATS = 60;
/** Half and half, as Joe picked it in the split mockup. */
const DEFAULT_FRACTION = 0.5;

type ActiveMap = Record<string, { panel: PanelKey; at: number }>;

function readActive(): ActiveMap {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeActive(map: ActiveMap): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(map));
  } catch {
    /* quota or disabled storage: the choice just won't be remembered */
  }
}

export function recallActive(sessionId: string): PanelKey | null {
  return readActive()[sessionId]?.panel ?? null;
}

export function rememberActive(sessionId: string, panel: PanelKey): void {
  const map = readActive();
  if (map[sessionId]?.panel === panel) return;
  map[sessionId] = { panel, at: Date.now() };
  const ids = Object.keys(map);
  if (ids.length > MAX_CHATS) {
    ids
      .sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
      .slice(0, ids.length - MAX_CHATS)
      .forEach((id) => delete map[id]);
  }
  writeActive(map);
}

export function forgetActive(sessionId: string): void {
  const map = readActive();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  writeActive(map);
}

/** The panel's share of the width beside the strip, 0..1. */
export function loadFraction(): number {
  const n = Number(localStorage.getItem(FRACTION_KEY));
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_FRACTION;
}

export function saveFraction(fraction: number): void {
  try {
    localStorage.setItem(FRACTION_KEY, String(fraction));
  } catch {
    /* ignore */
  }
}
