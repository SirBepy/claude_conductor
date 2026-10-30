/** The phone's last-known newest history page per chat, kept in localStorage
 *  so a chat tapped after a reload paints before the tunnel answers
 *  `load_history_page` (its signal drops often). Phone only: the desktop's
 *  local pipe answers in milliseconds. Pages carry transcript text, never a
 *  secret the transcript itself doesn't already show on screen. */

import type { ChatEvent, ContentBlock, HistoryPage } from "../../types/ipc.generated";

const PREFIX = "cc_history_page_v1:";
const INDEX_KEY = "cc_history_page_v1_index";
/** Most recently written chats kept; older ones are evicted. */
const MAX_CHATS = 8;
/** Per chat. A page is up to 200 events (history_page.rs MAX_PAGE_EVENTS) and
 *  8 x 160KB stays well inside the ~5MB localStorage quota. */
const MAX_BYTES = 160_000;

/** The slice of a HistoryPage loadInitial needs to resume pagination. */
export interface CachedPage {
  events: ChatEvent[];
  oldestSeq: number;
  hasMore: boolean;
  continuesFrom: string | null;
}

/** Last JSON written per chat, so the reconcile heartbeat re-saving an
 *  unchanged page skips the storage write. */
const lastWritten = new Map<string, string>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readIndex(ls: Storage): string[] {
  try {
    const parsed: unknown = JSON.parse(ls.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Image blocks are base64 and can be megabytes. Message images are dropped
// rather than replaced by a placeholder: delivery.sigOf reads only text
// blocks, so the stripped copy keeps the same sig and reconcileLatest does not
// re-append the page's copy beside it. The image itself comes back on the next
// full rebuild. A tool result's output is a single block, keyed by id, so it
// gets a text stand-in instead of an empty bubble.
function stripImages(ev: ChatEvent): ChatEvent {
  if (ev.type === "user_message" || ev.type === "assistant_message") {
    if (!ev.content.some((b) => b.type === "image")) return ev;
    return { ...ev, content: ev.content.filter((b) => b.type !== "image") };
  }
  // An elided placeholder (empty data) is already tiny and keeps its
  // full_seq, so the cached page can still lazy-load it; only real bytes go.
  if (ev.type === "tool_result" && ev.output.type === "image" && ev.output.data !== "") {
    const stand: ContentBlock = { type: "text", text: "[image]" };
    return { ...ev, output: stand };
  }
  return ev;
}

// ChatEvent timestamps are typed bigint (ts-rs) but arrive as JSON numbers;
// the replacer only matters if a real bigint ever reaches here.
function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

export function loadCachedPage(sessionId: string): CachedPage | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedPage>;
    if (!Array.isArray(parsed.events) || typeof parsed.oldestSeq !== "number") return null;
    return {
      events: parsed.events,
      oldestSeq: parsed.oldestSeq,
      hasMore: !!parsed.hasMore,
      continuesFrom: typeof parsed.continuesFrom === "string" ? parsed.continuesFrom : null,
    };
  } catch {
    return null;
  }
}

export function saveCachedPage(sessionId: string, page: HistoryPage): void {
  const ls = storage();
  if (!ls) return;
  // An empty page (a transcript with nothing rendered yet) carries no window
  // to resume from; painting it would only hide that the first fetch is owed.
  if (page.events.length === 0) return;
  const entry: CachedPage = {
    events: page.events.map(stripImages),
    oldestSeq: Number(page.oldest_seq),
    hasMore: page.has_more,
    continuesFrom: page.continues_from ?? null,
  };
  const json = toJson(entry);
  if (lastWritten.get(sessionId) === json) return;
  const key = PREFIX + sessionId;
  try {
    // Trimming events off the front would leave oldestSeq pointing past
    // them and loadOlder would skip them, so an oversized page is simply not
    // cached; that chat waits for the network like before.
    if (json.length > MAX_BYTES) {
      ls.removeItem(key);
      lastWritten.delete(sessionId);
      return;
    }
    const index = [sessionId, ...readIndex(ls).filter((id) => id !== sessionId)];
    for (const old of index.splice(MAX_CHATS)) {
      ls.removeItem(PREFIX + old);
      lastWritten.delete(old);
    }
    ls.setItem(key, json);
    ls.setItem(INDEX_KEY, JSON.stringify(index));
    lastWritten.set(sessionId, json);
  } catch {
    // Quota or private mode: the next open just waits for the network.
  }
}
