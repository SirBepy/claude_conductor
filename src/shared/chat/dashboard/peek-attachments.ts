// What the opened sub view's Attachments tab draws (src/views/sessions/chat-dashboard/sub-peek.ts).
// A sub's transcript is not open in a renderer the way the main chat's is, so the Links and Files tabs
// read the newest page of its history (the same row converter the transcript uses) and the Images tab
// the daemon's image list. The card itself is the dashboard's own (dashboard-zones.ts `attachTabs`),
// fed the same `LinksState`. Pure: no DOM, no IPC.

import type { ChatEvent, PreviewMeta } from "../../../types/ipc.generated";
import { eventToRenderedMessage } from "../chat-event-to-message";
import type { RenderedMessage } from "../chat-classifiers";
import { localTime } from "../../formatters";
import { ATTACH_TABS, type DashImage, type LinksState } from "./dashboard-model";
import { extractFiles, extractLinks } from "./links-model";

/** One transcript image as the daemon lists it (`list_session_images`), oldest first. */
export interface PeekImage {
  id: string;
  at_ms?: number | null;
}

/** History events as the rows the Links and Files extractors read, in order. */
export function peekRows(events: readonly ChatEvent[]): RenderedMessage[] {
  const out: RenderedMessage[] = [];
  for (const ev of events) {
    const m = eventToRenderedMessage(ev);
    if (m) out.push(m);
  }
  return out;
}

/** The Images tab's rows, newest first. `index` is the picture's place in the daemon's list (oldest
 *  first), so a row maps back to its id without the bytes ever entering the model. */
export function peekImages(images: readonly PeekImage[]): DashImage[] {
  const rows = images.map((img, i): DashImage => ({
    index: i,
    title: `Image ${i + 1}`,
    label: typeof img.at_ms === "number" && img.at_ms > 0 ? localTime(new Date(img.at_ms)) : "",
    size: i,
  }));
  return rows.reverse();
}

/** The one sub's own previews, newest first; the family's other chats' previews are not this view's. */
export function peekPreviews(list: readonly PreviewMeta[], subId: string): PreviewMeta[] {
  return list.filter((m) => m.session_id === subId);
}

/** How many things the Attachments tab holds, the number on its label. */
export function attachTotal(s: LinksState): number {
  return s.links.length + s.files.length + (s.previews?.own.length ?? 0) + s.images.length;
}

/** The Attachments card's state for one sub. Every tab stays (muted when empty) so the strip never moves. */
export function peekLinksState(events: readonly ChatEvent[], images: readonly PeekImage[], previews: readonly PreviewMeta[], subId: string): LinksState {
  const rows = peekRows(events);
  const own = peekPreviews(previews, subId);
  return {
    links: extractLinks(rows),
    files: extractFiles(rows),
    previews: own.length > 0 ? { own, others: [], otherCount: 0 } : null,
    images: peekImages(images),
    tabs: [...ATTACH_TABS],
  };
}
