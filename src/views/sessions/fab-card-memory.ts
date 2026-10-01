// Which FAB card each chat had open, and where (Joe, 2026-10-01): leaving a
// chat with the card parked top-right and coming back finds it still there,
// across chat switches and app restarts. Closing the card forgets the chat.

import type { CardRect } from "./fab-card-window";

export type RememberedPanel = "ask" | "todos" | "drafts";

export interface RememberedCard {
  panel: RememberedPanel;
  /** null = never dragged, so it re-centres. */
  rect: CardRect | null;
  at: number;
}

const KEY = "cc.fabCard.chats";
/** Oldest entries fall off first; a chat untouched this long is not coming back. */
const MAX_CHATS = 60;
const PANELS: readonly string[] = ["ask", "todos", "drafts"];

type Store = Record<string, RememberedCard>;

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota or disabled storage: the card just won't be remembered */
  }
}

function validRect(r: unknown): r is CardRect {
  const o = r as CardRect | null;
  return !!o && [o.x, o.y, o.w, o.h].every((n) => Number.isFinite(n));
}

export function recallCard(sessionId: string): RememberedCard | null {
  const hit = read()[sessionId];
  if (!hit || !PANELS.includes(hit.panel)) return null;
  return { panel: hit.panel, rect: validRect(hit.rect) ? hit.rect : null, at: hit.at };
}

export function rememberCard(sessionId: string, panel: RememberedPanel, rect: CardRect | null): void {
  const store = read();
  store[sessionId] = { panel, rect, at: Date.now() };
  const ids = Object.keys(store);
  if (ids.length > MAX_CHATS) {
    ids
      .sort((a, b) => (store[a]?.at ?? 0) - (store[b]?.at ?? 0))
      .slice(0, ids.length - MAX_CHATS)
      .forEach((id) => delete store[id]);
  }
  write(store);
}

export function forgetCard(sessionId: string): void {
  const store = read();
  if (!(sessionId in store)) return;
  delete store[sessionId];
  write(store);
}
