// LRU of fully-rendered chat panes. A retained chat keeps its ChatRenderer
// alive and subscribed plus the `.session-messages` element it rendered into,
// so re-selecting it is an element swap - not the replay + re-highlight +
// fade-in rebuild that, rather than the JSONL read, was the switch latency.

import type { ChatRenderer } from "../../shared/chat/chat-renderer";
import { isElNearBottom } from "../../shared/chat/chat-dom-renderer";

/** Hot chats kept warm; each costs a live renderer + a detached DOM tree. */
const CAPACITY = 5;

/** Parked-event count past which draining costs more than a cold reload, so
 *  the retained pane is dropped instead. */
const MAX_PARKED_EVENTS = 300;

export interface RetainedChat {
  renderer: ChatRenderer;
  /** The `.session-messages` element `renderer` owns and renders into. */
  messagesEl: HTMLElement;
  scrollTop: number;
  atBottom: boolean;
}

// Insertion-ordered, and every hit re-inserts, so the first key is always the
// least-recently-used one.
const retained = new Map<string, RetainedChat>();

/** The retained pane for `sessionId`, marked most-recently-used. Null on miss,
 *  or when it parked so many events that a cold reload is cheaper. */
export function takeRetainedChat(sessionId: string): RetainedChat | null {
  const hit = retained.get(sessionId);
  if (!hit) return null;
  if (hit.renderer.parkedEventCount > MAX_PARKED_EVENTS) {
    dropRetainedChat(sessionId);
    return null;
  }
  retained.delete(sessionId);
  retained.set(sessionId, hit);
  return hit;
}

export function isRetainedRenderer(renderer: ChatRenderer): boolean {
  for (const entry of retained.values()) {
    if (entry.renderer === renderer) return true;
  }
  return false;
}

export function retainChat(sessionId: string, renderer: ChatRenderer, messagesEl: HTMLElement): void {
  retained.delete(sessionId);
  retained.set(sessionId, { renderer, messagesEl, scrollTop: 0, atBottom: true });
  while (retained.size > CAPACITY) {
    const lru = retained.keys().next().value;
    if (lru === undefined) break;
    dropRetainedChat(lru);
  }
}

/** Snapshot scroll and park live rendering for a chat leaving the screen. MUST
 *  run before the pane's DOM is replaced: a detached element reports scrollTop
 *  0, so reading it later loses the user's position. */
export function backgroundRetainedChat(sessionId: string): void {
  const hit = retained.get(sessionId);
  if (!hit) return;
  const el = hit.messagesEl;
  hit.scrollTop = el.scrollTop;
  hit.atBottom = isElNearBottom(el);
  hit.renderer.pauseLiveRender();
}

/** Re-pin the transcript after its element is back in the document. A chat
 *  parked at the bottom follows whatever arrived while it was away. */
export function restoreRetainedScroll(hit: RetainedChat): void {
  const el = hit.messagesEl;
  el.scrollTop = hit.atBottom ? el.scrollHeight : hit.scrollTop;
}

export function dropRetainedChat(sessionId: string): void {
  const hit = retained.get(sessionId);
  if (!hit) return;
  retained.delete(sessionId);
  hit.renderer.detach();
  hit.messagesEl.remove();
}

/** Follow a session id change (pending placeholder -> real id, takeover).
 *  Carries the renderer's live subscription across via swapSubscription -
 *  without this the renderer stays bound to `oldId` in the event store and
 *  every future event for `newId` silently never reaches it. */
export async function rekeyRetainedChat(oldId: string, newId: string): Promise<void> {
  const hit = retained.get(oldId);
  if (!hit) return;
  dropRetainedChat(newId);
  // hit stays under oldId across this await so isRetainedRenderer keeps
  // seeing it as retained mid-swap - delete+reinsert only happen back-to-back
  // once the await settles, never straddling it.
  await hit.renderer.swapSubscription(newId);
  retained.delete(oldId);
  retained.set(newId, hit);
}

export function dropAllRetainedChats(): void {
  for (const id of [...retained.keys()]) dropRetainedChat(id);
}

/** Test seam: ids currently held, least-recently-used first. */
export function retainedChatIds(): string[] {
  return [...retained.keys()];
}
