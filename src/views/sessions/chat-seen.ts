// The chat heads' viewed marks: when Joe last had each chat on screen, on any of his devices.
// The daemon keeps them (daemon/methods/chat_seen.rs), so a view on the PC clears a chat's
// purple and green badge on the phone and the Mac too. This module is this window's copy:
// a view clears the badge here at once (the local clock), and the daemon's own answer replaces
// that guess. A device that was offline, or a mark made on another device, arrives through
// `refreshViewed`, which reads the list again now and then.

import { invoke } from "../../shared/ipc";

/** A chat just marked is not marked again inside this window: leaving and re-entering it, or a
 *  chat answering while it is open, would otherwise send a call per render. */
const MARK_GAP_MS = 2000;
/** How often the other devices' marks are read again. */
const LIST_GAP_MS = 4000;
const MAX_IDS = 400;

export interface SeenApi {
  mark(sessionId: string): Promise<number>;
  list(sessionIds: string[]): Promise<Record<string, number>>;
}

const daemonApi: SeenApi = {
  async mark(sessionId) {
    const out = await invoke<{ viewed_at?: number }>("chat_seen_mark", { sessionId }, { background: true });
    return Number(out?.viewed_at ?? 0);
  },
  async list(sessionIds) {
    const out = await invoke<Record<string, number>>("chat_seen_list", { sessionIds });
    return out && typeof out === "object" ? out : {};
  },
};

let api: SeenApi = daemonApi;
const marks = new Map<string, number>();
const markedAt = new Map<string, number>();
const trailing = new Map<string, ReturnType<typeof setTimeout>>();
let listedAt = 0;
let listing = false;
let onChange: (() => void) | null = null;
let isOpen: ((sessionId: string) => boolean) | null = null;
let changePending = false;

/** The viewed mark of a chat in ms, 0 when it was never viewed (or not yet read). */
export function viewedAtOf(sessionId: string): number {
  return marks.get(sessionId) ?? 0;
}

/** A callback for when any mark changed, so the heads draw again. One listener: the sidebar. */
export function onViewedChange(cb: (() => void) | null): void {
  onChange = cb;
}

/** Asked before the mark waiting for the gap goes out: a chat Joe has since left is not marked then. */
export function setViewedOpenCheck(fn: ((sessionId: string) => boolean) | null): void {
  isOpen = fn;
}

function set(sessionId: string, at: number): void {
  if (marks.get(sessionId) === at) return;
  marks.set(sessionId, at);
  // A mark made while the heads are being drawn must not draw them again inside that draw.
  if (changePending || !onChange) return;
  changePending = true;
  queueMicrotask(() => { changePending = false; onChange?.(); });
}

/** Joe has `sessionId` on screen now. The local mark moves at once; the daemon's answer (its own
 *  clock, the one the answers' times come from) replaces it. `force` skips the gap: leaving a chat
 *  marks what arrived while Joe was in it. */
export function markViewed(sessionId: string, now = Date.now(), force = false): void {
  if (!sessionId) return;
  if (force) {
    // Leaving the chat: a mark still waiting for the gap to end would mark what arrived after Joe left.
    const t = trailing.get(sessionId);
    if (t !== undefined) clearTimeout(t);
    trailing.delete(sessionId);
  }
  const since = now - (markedAt.get(sessionId) ?? 0);
  if (!force && since < MARK_GAP_MS) {
    // A row that lands while the chat is open, inside the gap, is seen as it lands: one more mark
    // goes out when the gap ends, or the other devices would keep it unread.
    if (!trailing.has(sessionId)) {
      trailing.set(sessionId, setTimeout(() => {
        trailing.delete(sessionId);
        const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
        if (visible && (!isOpen || isOpen(sessionId))) markViewed(sessionId, Date.now());
      }, MARK_GAP_MS - since + 20));
    }
    return;
  }
  markedAt.set(sessionId, now);
  const guess = now > viewedAtOf(sessionId) ? now : null;
  if (guess !== null) set(sessionId, guess);
  // The daemon's answer replaces this call's own guess (its clock is the one the answers use) but
  // never lowers a mark that is already higher: two calls in flight can answer out of order.
  void api.mark(sessionId).then((at) => { if (at > viewedAtOf(sessionId) || (at > 0 && viewedAtOf(sessionId) === guess)) set(sessionId, at); }).catch((err) => {
    // The mark stays local: the next view, or the next list, settles it.
    console.warn("[chat-seen] chat_seen_mark failed", err);
  });
}

/** Reads the daemon's marks for `ids` (no faster than every few seconds), so a view on another
 *  device, or one made while this one was offline, clears the badge here. Marks only move forward. */
export function refreshViewed(ids: readonly string[], now = Date.now()): void {
  if (listing || ids.length === 0 || now - listedAt < LIST_GAP_MS) return;
  listedAt = now;
  listing = true;
  void api.list(ids.slice(0, MAX_IDS)).then((got) => {
    for (const [id, at] of Object.entries(got)) if (Number(at) > viewedAtOf(id)) set(id, Number(at));
  }).catch((err) => {
    // Tried again at the next gap, which is how a device that was offline catches up.
    console.warn("[chat-seen] chat_seen_list failed", err);
  }).finally(() => { listing = false; });
}

/** Reading a chat sends no event, so without this the daemon's idle rule (daemon/auto_hide.rs)
 *  would count a chat Joe has had open for ten quiet minutes as unwatched and hide it under him. */
const HEARTBEAT_MS = 60_000;
let heartbeat: ReturnType<typeof setInterval> | undefined;

/** Renews the mark of the chats `openIds` names every minute while the window shows. Starts once;
 *  the sidebar runs it only while a chat is open, so a view with no chat open owns no timer. */
export function startViewedHeartbeat(openIds: () => readonly string[]): void {
  if (heartbeat !== undefined) return;
  heartbeat = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    for (const id of openIds()) markViewed(id);
  }, HEARTBEAT_MS);
}

export function stopViewedHeartbeat(): void {
  if (heartbeat !== undefined) clearInterval(heartbeat);
  heartbeat = undefined;
}

/** Test seam: a fake daemon, or null to put the real calls back. Clears every mark. */
export function setSeenApi(next: SeenApi | null): void {
  api = next ?? daemonApi;
  isOpen = null;
  stopViewedHeartbeat();
  marks.clear();
  markedAt.clear();
  for (const t of trailing.values()) clearTimeout(t);
  trailing.clear();
  listedAt = 0;
  listing = false;
  changePending = false;
}
