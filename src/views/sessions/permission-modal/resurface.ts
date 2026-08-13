/**
 * Prompt-resurfacing: replaying/re-parking a permission or question prompt
 * for a session that just came into (or dropped out of) focus, or had
 * auto-accept toggled on. Split out of index.ts (ai_todo 517) - pure move,
 * no behavior change.
 */

import { getTransport } from "../../../shared/transport";
import { findPendingPromptsForSession } from "./remote-prompt-poll";
import { extractQuestions } from "./question-ui";
import {
  allowPermission,
  autoAllowIfRemembered,
  isAutoAccept,
  markLatestQuestion,
  storePendingPrompt,
  takePendingPrompt,
  peekPendingPrompt,
} from "./gating";
import type { PendingPrompt } from "./gating";
import { showPermissionCard } from "./permission-card";
import { rerenderSidebar, showQuestionCard, dismissQuestionCard } from "./index";

/**
 * Drain a parked permission prompt for a session that just had auto-accept
 * toggled ON: allow it immediately and clear the sidebar attention dot. A
 * parked question (never auto-answered) is left in place. No-op if nothing is
 * parked. Called from the auto-accept toggle so flipping it on retroactively
 * clears an already-waiting prompt instead of leaving the dot until switch-back.
 */
export function autoAcceptParked(sessionId: string): void {
  const pending = takePendingPrompt(sessionId);
  if (!pending) return;
  if (pending.kind === "permission" && extractQuestions(pending.payload.input) === null) {
    allowPermission(pending.payload, "flush respond_permission");
    rerenderSidebar();
    return;
  }
  // Can't auto-answer (question / AskUserQuestion-shaped): leave it parked.
  storePendingPrompt(sessionId, pending);
}

/**
 * Replay a parked permission/question prompt for a session the user just
 * selected. Mirrors the arrival path (auto-accept, remembered-rule auto-allow,
 * then the card) so a switch-back surfaces exactly what would have shown had
 * the chat been focused when the tool fired. False if nothing is parked, so the
 * caller can fall back to {@link rehydratePendingPrompts}.
 *
 * Called from selectSession AFTER the pane is mounted so the card anchors over
 * the right composer.
 */
export function replayPendingPrompt(sessionId: string): boolean {
  const pending = takePendingPrompt(sessionId);
  if (!pending) return false;
  rerenderSidebar(); // clear the attention marker now that we're surfacing it
  surfacePending(pending);
  return true;
}

/** Shared tail of replay/reopen: render the parked prompt's card, applying the
 *  arrival path's auto-accept / remembered-rule shortcuts. */
function surfacePending(pending: PendingPrompt): void {
  if (pending.kind === "question") {
    void showQuestionCard(pending.payload, pending.draft);
    return;
  }
  const payload = pending.payload;
  if (
    payload.session_id
    && isAutoAccept(payload.session_id)
    && extractQuestions(payload.input) === null
  ) {
    allowPermission(payload, "replay respond_permission");
    return;
  }
  void (async () => {
    if (await autoAllowIfRemembered(payload)) return;
    showPermissionCard(payload);
  })();
}

/** Ask the DAEMON what it is still waiting on for `sessionId` and re-park it.
 *  The push path sends each id once, so a park lost with its webview is never
 *  re-sent - pull instead. No-op if already parked (may hold a live draft). */
export async function rehydratePendingPrompts(sessionId: string): Promise<boolean> {
  if (!sessionId || peekPendingPrompt(sessionId)) return false;
  let prompts: unknown;
  try {
    prompts = await getTransport().call("list_pending_prompts");
  } catch (e) {
    console.warn("[perm-gate] rehydrate failed:", e);
    return false;
  }
  // One park per session, so take the longest-waiting if the daemon holds two.
  const [rec] = findPendingPromptsForSession(prompts, sessionId);
  if (!rec) return false;
  // This window may never have seen the live event (fresh reload) - seed the
  // stale-question tracker from the daemon's own record too.
  if (rec.kind === "question") markLatestQuestion(sessionId, rec.payload.id);
  storePendingPrompt(sessionId, rec.kind === "question"
    ? { kind: "question", payload: rec.payload }
    : { kind: "permission", payload: rec.payload });
  rerenderSidebar();
  return true;
}

/** Put the real card back up for a transcript card the user clicked: local park
 *  first, then the daemon's store. False when nothing is open for this chat, so
 *  the caller can say so - silently doing nothing is the whole complaint. */
export async function reopenPendingPrompt(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  let pending = takePendingPrompt(sessionId);
  if (!pending) {
    await rehydratePendingPrompts(sessionId);
    pending = takePendingPrompt(sessionId);
  }
  if (!pending) return false;
  // Only safe to drop what's on screen now we hold a replacement.
  dismissQuestionCard();
  rerenderSidebar();
  surfacePending(pending);
  return true;
}
