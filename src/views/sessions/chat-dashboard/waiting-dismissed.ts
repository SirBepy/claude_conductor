// The Waiting on you items Joe removed by hand (the x on a blocker or to-do,
// or Clear all), and the Result he said Got it to, per chat. Kept in localStorage so a removed blocker stays
// removed after the chat window or the app reopens (Joe, 2026-11-13: "i cant
// even ... remove it"); in memory it would come back on every reopen, which is
// the stale-info problem this exists to fix. The transcript keeps every card.

const KEY = "cc.dashWaitingDismissed";
/** Chats kept; the oldest touched falls off first. */
const MAX_CHATS = 100;
/** Keys kept per chat, newest last; a chat sends far fewer blockers than this. */
const MAX_KEYS = 200;

type Store = Record<string, { at: number; keys: string[] }>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

/** The keys (dashboard-model.ts waitingKey) Joe removed in this chat. */
export function dismissedFor(sessionId: string | null | undefined): Set<string> {
  if (!sessionId) return new Set();
  const keys = read()[sessionId]?.keys;
  return new Set(Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : []);
}

/** Removes these items from the chat's Waiting cards for good. */
export function dismiss(sessionId: string | null | undefined, keys: readonly string[]): void {
  if (!sessionId || keys.length === 0) return;
  const all = read();
  const merged = [...new Set([...(all[sessionId]?.keys ?? []), ...keys])].slice(-MAX_KEYS);
  all[sessionId] = { at: Date.now(), keys: merged };
  const kept = Object.entries(all).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, MAX_CHATS);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage full or blocked: the dashboard's own copy still hides it until the window closes */
  }
}
