// AUQ half of cross-surface draft sync. Debounces `set_auq_draft` pushes and
// wraps `get_session_drafts`/`clear_auq_draft` for the card's own lifecycle
// (question-ui.ts owns the flush-on-hidden and focused-input guard, since only
// it has the live freeText/selections state to reconcile into).

import { debounce, type Debounced } from "../../../shared/debounce";
import { getSessionDrafts, setAuqDraft, clearAuqDraft } from "../../../shared/chat/session-draft-sync";
import { deserializeQuestionDraft, loadQuestionDraftMeta, serializeQuestionDraft } from "./draft-persistence";
import type { QuestionDraft } from "./types";

const PUSH_DEBOUNCE_MS = 500;

const pushDebounced: Debounced<[sessionId: string, promptId: string, draft: QuestionDraft]> = debounce(
  (sessionId, promptId, draft) => {
    void setAuqDraft(sessionId, promptId, serializeQuestionDraft(draft))
      .catch((e) => console.warn("[auq-sync] set_auq_draft failed:", e));
  },
  PUSH_DEBOUNCE_MS,
);

/** Only one AUQ card is ever live at a time (question-state.ts's activeCard),
 *  so a single module-level debounce is safe - no per-prompt keying needed. */
export function scheduleAuqPush(sessionId: string | undefined, promptId: string, draft: QuestionDraft): void {
  if (!sessionId) return;
  pushDebounced(sessionId, promptId, draft);
}

export function flushAuqPush(): void {
  pushDebounced.flush();
}

export function cancelAuqPush(): void {
  pushDebounced.cancel();
}

/** Explicit discard (submit/cancel) - never called on blur or navigate-away. */
export async function clearAuqPush(sessionId: string | undefined, promptId: string): Promise<void> {
  pushDebounced.cancel();
  if (!sessionId) return;
  try {
    await clearAuqDraft(sessionId, promptId);
  } catch (e) {
    console.warn("[auq-sync] clear_auq_draft failed:", e);
  }
}

/** Like fetchRemoteAuqDraft, but also returns the daemon's `updated_at` so
 *  callers can compare freshness against a local copy. */
async function fetchRemoteAuqDraftMeta(sessionId: string | undefined, promptId: string): Promise<{ draft: QuestionDraft; updatedAt: string } | null> {
  if (!sessionId) return null;
  try {
    const drafts = await getSessionDrafts(sessionId);
    if (drafts.auq?.prompt_id !== promptId) return null;
    const draft = deserializeQuestionDraft(drafts.auq.payload);
    if (!draft) return null;
    return { draft, updatedAt: drafts.auq.updated_at };
  } catch (e) {
    console.warn("[auq-sync] get_session_drafts failed:", e);
    return null;
  }
}

export async function fetchRemoteAuqDraft(sessionId: string | undefined, promptId: string): Promise<QuestionDraft | null> {
  return (await fetchRemoteAuqDraftMeta(sessionId, promptId))?.draft ?? null;
}

/** Reload-time reconciliation: newest-wins by timestamp (mirrors
 *  ComposerDraftSync.reconcile), not "first non-null" - the daemon's push is
 *  debounced up to 500ms and could otherwise beat a fresher local draft. */
export async function fetchFreshestAuqDraft(sessionId: string | undefined, promptId: string): Promise<QuestionDraft | null> {
  const local = loadQuestionDraftMeta(promptId);
  const remote = await fetchRemoteAuqDraftMeta(sessionId, promptId);
  if (!remote) return local?.draft ?? null;
  if (!local || local.updatedAt === null) return remote.draft;
  return remote.updatedAt > local.updatedAt ? remote.draft : local.draft;
}
