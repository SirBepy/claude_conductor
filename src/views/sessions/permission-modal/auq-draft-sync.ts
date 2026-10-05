// AUQ half of cross-surface draft sync. Debounces `set_auq_draft` pushes and
// wraps `get_session_drafts`/`clear_auq_draft` for the card's own lifecycle
// (question-ui.ts owns the flush-on-hidden and focused-input guard, since only
// it has the live freeText/selections state to reconcile into).

import { debounce, type Debounced } from "../../../shared/debounce";
import { getSessionDrafts, setAuqDraft, clearAuqDraft } from "../../../shared/chat/session-draft-sync";
import { deserializeQuestionDraft, loadQuestionDraftMeta, serializeQuestionDraft } from "./draft-persistence";
import type { QuestionDraft } from "./types";

const PUSH_DEBOUNCE_MS = 500;

/** What the daemon holds for a prompt, as far as this client last knew: its
 *  serialized payload plus the daemon's OWN `updated_at` for it. The live poll
 *  only ever compares daemon timestamps against daemon timestamps - comparing
 *  one against this device's clock let a PC clock running ahead of the phone's
 *  win every newest-wins race, yanking the card back a step after each pick. */
let daemonCopy: { promptId: string; json: string; updatedAt: string | null } | null = null;
let pushQueued = false;
let pushesInFlight = 0;

const pushDebounced: Debounced<[sessionId: string, promptId: string, draft: QuestionDraft]> = debounce(
  (sessionId, promptId, draft) => {
    pushQueued = false;
    const payload = serializeQuestionDraft(draft);
    const json = JSON.stringify(payload);
    // A just-adopted remote draft re-renders the card, which re-notifies; pushing
    // it back would stamp a stale copy newer than a third edit racing it.
    if (daemonCopy?.promptId === promptId && daemonCopy.json === json) return;
    pushesInFlight++;
    void setAuqDraft(sessionId, promptId, payload)
      .then((r) => { daemonCopy = { promptId, json, updatedAt: r?.updated_at ?? null }; })
      .catch((e) => console.warn("[auq-sync] set_auq_draft failed:", e))
      .finally(() => { pushesInFlight--; });
  },
  PUSH_DEBOUNCE_MS,
);

/** Only one AUQ card is ever live at a time (question-state.ts's activeCard),
 *  so a single module-level debounce is safe - no per-prompt keying needed. */
export function scheduleAuqPush(sessionId: string | undefined, promptId: string, draft: QuestionDraft): void {
  if (!sessionId) return;
  pushQueued = true;
  pushDebounced(sessionId, promptId, draft);
}

export function flushAuqPush(): void {
  pushDebounced.flush();
}

export function cancelAuqPush(): void {
  pushQueued = false;
  pushDebounced.cancel();
}

/** Local edits the daemon hasn't acknowledged yet - anything the daemon
 *  returns meanwhile is older than what's on screen. */
function localPushPending(): boolean {
  return pushQueued || pushesInFlight > 0;
}

/** Live-poll step for an open card: the daemon's draft, but only when ANOTHER
 *  client changed it since this one last looked. Null while this card has an
 *  unacknowledged push, when the daemon's `updated_at` hasn't moved, or when
 *  the change is this card's own echo. */
export async function pollRemoteAuqChange(sessionId: string | undefined, promptId: string): Promise<QuestionDraft | null> {
  if (localPushPending()) return null;
  const remote = await fetchRemoteAuqDraftMeta(sessionId, promptId);
  // A pick made during the round trip queued a push; this result predates it.
  if (!remote || localPushPending()) return null;
  const prev = daemonCopy?.promptId === promptId ? daemonCopy : null;
  const json = JSON.stringify(serializeQuestionDraft(remote.draft));
  daemonCopy = { promptId, json, updatedAt: remote.updatedAt };
  if (prev && (prev.updatedAt === remote.updatedAt || prev.json === json)) return null;
  return remote.draft;
}

/** Test-only: forget what the daemon was last known to hold. */
export function resetAuqSyncForTests(): void {
  cancelAuqPush();
  daemonCopy = null;
  pushesInFlight = 0;
}

/** Explicit discard (submit/cancel) - never called on blur or navigate-away. */
export async function clearAuqPush(sessionId: string | undefined, promptId: string): Promise<void> {
  cancelAuqPush();
  if (daemonCopy?.promptId === promptId) daemonCopy = null;
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
  // Read local AFTER awaiting remote, not before: a stale pre-click snapshot
  // read here would out-age a fresh local write made while the remote round
  // trip was in flight, sending mergeFreshDraft a draft older than what's
  // already on screen (the click-answer flash-back-a-tab bug).
  const remote = await fetchRemoteAuqDraftMeta(sessionId, promptId);
  const local = loadQuestionDraftMeta(promptId);
  if (!remote) return local?.draft ?? null;
  if (!local || local.updatedAt === null) return remote.draft;
  return remote.updatedAt > local.updatedAt ? remote.draft : local.draft;
}
