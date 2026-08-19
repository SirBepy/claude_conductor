// Post-reconcile staleness check for ChatRenderer, split out of
// chat-renderer.ts (ai_todo 694) so the orchestrator keeps only the wiring.

import { sessionEvents } from "./event-store";
import { visibleMessageSigs } from "./chat-transcript-sig";
import { isNearBottom } from "./chat-dom-renderer";
import type { ChatRenderer } from "./chat-renderer";

/** Staleness check against the authoritative transcript (event-store's
 *  tailWatchers). The store only recovers what the CACHE lacks; a message it
 *  HAS but this renderer never painted used to need a manual reload. */
export function onTranscriptTail(r: ChatRenderer, sigs: string[]): void {
  if (!r.sessionId || r._resyncing) return;
  // liveBuffer owns the event flow mid-load / while parked off-screen, and a
  // retained pane reconciles again on remount.
  if (r.liveBuffer !== null) return;
  // Mid-stream bubble: the next heartbeat catches it 15s later.
  if (r.streamingIndex !== null) return;
  const have = visibleMessageSigs(r.messages);
  const missing = sigs.filter((s) => !have.has(s));
  if (missing.length === 0) {
    r._resyncFailedFor = null;
    return;
  }
  const key = missing.join("|");
  if (r._resyncFailedFor === key) return;
  const sid = r.sessionId;
  const cwd = r.paginator.cwdHint;
  const wasNearBottom = isNearBottom(r);
  const prevScrollTop = r.container.scrollTop;
  r._resyncing = true;
  console.warn(
    `[chat-resync] ${sid}: transcript has ${missing.length} message(s) this chat never painted - rebuilding`,
    missing,
  );
  void (async () => {
    try {
      // force: the cache is the suspect, so don't trust loadInitial's
      // idempotent cache-hit path.
      await sessionEvents.loadInitial(sid, cwd, { force: true });
      if (r.sessionId !== sid) return;
      await r.loadFromStore(cwd);
      if (r.sessionId !== sid) return;
      // A rebuild otherwise lands at the bottom, yanking a user reading back.
      if (!wasNearBottom) r.container.scrollTop = prevScrollTop;
      const after = visibleMessageSigs(r.messages);
      const stillMissing = missing.filter((s) => !after.has(s));
      r._resyncFailedFor = stillMissing.length > 0 ? key : null;
      if (stillMissing.length > 0) {
        console.error(
          `[chat-resync] ${sid}: still missing after a full rebuild - the drop is on the paint path, not in the cache`,
          stillMissing,
        );
      }
    } catch (err) {
      console.warn(`[chat-resync] ${sid}: rebuild failed`, err);
    } finally {
      r._resyncing = false;
    }
  })();
}
