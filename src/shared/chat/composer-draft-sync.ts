// Composer half of cross-surface draft sync: debounces `set_composer_draft`
// pushes, resolves `get_session_drafts` reconciles. One instance per Composer
// (itself constructed fresh per window/pane). The focused-input guard lives
// in composer.ts - only the caller knows whether its textarea is focused.

import { debounce, type Debounced } from "../debounce";
import { getSessionDrafts, setComposerDraft, clearComposerDraft } from "./session-draft-sync";
import { loadSyncBaseline, saveSyncBaseline } from "./composer-persistence";

const PUSH_DEBOUNCE_MS = 500;

// Last-write-wins baseline, keyed by session id and shared across every
// ComposerDraftSync instance, also persisted to localStorage so a reload
// seeds a real baseline instead of defaulting to "remote always wins".
const lastKnownUpdatedAt = new Map<string, string>();

/** Seeds the in-memory baseline from storage on first access per session. */
function getKnownUpdatedAt(sessionId: string): string | undefined {
  if (!lastKnownUpdatedAt.has(sessionId)) {
    const stored = loadSyncBaseline(sessionId);
    if (stored) lastKnownUpdatedAt.set(sessionId, stored);
  }
  return lastKnownUpdatedAt.get(sessionId);
}

function setKnownUpdatedAt(sessionId: string, updatedAt: string): void {
  lastKnownUpdatedAt.set(sessionId, updatedAt);
  saveSyncBaseline(sessionId, updatedAt);
}

/** Placeholder ids (prefix "pending-", see pending-flow.ts's makePlaceholderId)
 *  have no daemon-side session yet - the daemon rejects any draft RPC on one
 *  with -32602 unknown session_id. Same string check as state.ts/session-statusbar.ts. */
function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith("pending-");
}

export class ComposerDraftSync {
  private push: Debounced<[sessionId: string, text: string]>;

  constructor() {
    this.push = debounce((sessionId, text) => {
      void setComposerDraft(sessionId, text)
        .then((res) => { setKnownUpdatedAt(sessionId, res.updated_at); })
        .catch((e) => console.warn("[composer-sync] set_composer_draft failed:", e));
    }, PUSH_DEBOUNCE_MS);
  }

  /** A new session is mounted - drop any pending write for the old one (the
   *  caller flushes first if it wants that write to land). The last-write-wins
   *  baseline is NOT reset here - it's keyed by session id, not by instance. */
  setSession(): void {
    this.push.cancel();
  }

  /** Every keystroke: coalesced into one write per 500ms of inactivity.
   *  No-ops for a still-pending session (no daemon id to write against). */
  notifyTyped(sessionId: string, text: string): void {
    if (isPendingSessionId(sessionId)) return;
    this.push(sessionId, text);
  }

  /** Bypass the debounce - composer blur, visibilitychange hidden, or a
   *  session switch that must not lose the outgoing session's last edit. */
  flush(): void {
    this.push.flush();
  }

  cancelPending(): void {
    this.push.cancel();
  }

  async clear(sessionId: string): Promise<void> {
    this.push.cancel();
    if (isPendingSessionId(sessionId)) return;
    try {
      const res = await clearComposerDraft(sessionId);
      setKnownUpdatedAt(sessionId, res.updated_at);
    } catch (e) {
      console.warn("[composer-sync] clear_composer_draft failed:", e);
    }
  }

  /** Remote text only if it's newer (by server `updated_at`) than what this
   *  session last knew about - null otherwise, including on a failed call.
   *  Caller must still check focus before applying the result. */
  async reconcile(sessionId: string): Promise<string | null> {
    if (isPendingSessionId(sessionId)) return null;
    try {
      const drafts = await getSessionDrafts(sessionId);
      const remote = drafts.composer;
      if (!remote) return null;
      const known = getKnownUpdatedAt(sessionId);
      if (known && remote.updated_at <= known) return null;
      setKnownUpdatedAt(sessionId, remote.updated_at);
      return remote.text;
    } catch (e) {
      console.warn("[composer-sync] get_session_drafts failed:", e);
      return null;
    }
  }
}
