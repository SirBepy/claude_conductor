// Composer half of cross-surface draft sync: debounces `set_composer_draft`
// pushes, resolves `get_session_drafts` reconciles. One instance per Composer
// (itself constructed fresh per window/pane). The focused-input guard lives
// in composer.ts - only the caller knows whether its textarea is focused.

import { debounce, type Debounced } from "../debounce";
import { getSessionDrafts, setComposerDraft, clearComposerDraft } from "./session-draft-sync";

const PUSH_DEBOUNCE_MS = 500;

export class ComposerDraftSync {
  private lastKnownUpdatedAt: string | null = null;
  private push: Debounced<[sessionId: string, text: string]>;

  constructor() {
    this.push = debounce((sessionId, text) => {
      void setComposerDraft(sessionId, text)
        .then((res) => { this.lastKnownUpdatedAt = res.updated_at; })
        .catch((e) => console.warn("[composer-sync] set_composer_draft failed:", e));
    }, PUSH_DEBOUNCE_MS);
  }

  /** A new session is mounted - drop any pending write for the old one (the
   *  caller flushes first if it wants that write to land) and reset the
   *  last-write-wins baseline. */
  setSession(): void {
    this.push.cancel();
    this.lastKnownUpdatedAt = null;
  }

  /** Every keystroke: coalesced into one write per 500ms of inactivity. */
  notifyTyped(sessionId: string, text: string): void {
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
    try {
      const res = await clearComposerDraft(sessionId);
      this.lastKnownUpdatedAt = res.updated_at;
    } catch (e) {
      console.warn("[composer-sync] clear_composer_draft failed:", e);
    }
  }

  /** Remote text only if it's newer (by server `updated_at`) than what this
   *  instance last knew about - null otherwise, including on a failed call.
   *  Caller must still check focus before applying the result. */
  async reconcile(sessionId: string): Promise<string | null> {
    try {
      const drafts = await getSessionDrafts(sessionId);
      const remote = drafts.composer;
      if (!remote) return null;
      if (this.lastKnownUpdatedAt && remote.updated_at <= this.lastKnownUpdatedAt) return null;
      this.lastKnownUpdatedAt = remote.updated_at;
      return remote.text;
    } catch (e) {
      console.warn("[composer-sync] get_session_drafts failed:", e);
      return null;
    }
  }
}
