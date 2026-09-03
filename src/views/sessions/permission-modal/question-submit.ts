/** Question card submit/cancel/settle. Split out of index.ts (ai_todo 840),
 *  pure move, no behavior change. */

import { invoke } from "../../../shared/ipc";
import { isSessionBusyError } from "../../../shared/session-busy";
import { showToast } from "../../../shared/toast";
import { state } from "../state";
import { formatAnswersAsMessage, isQuestionAnswered, renderQuestionUI, snapshotActiveCardDraft } from "./question-ui";
import { auqAnswerSentinel, AUQ_EXTRA_SENTINEL } from "../../../shared/chat/chat-transforms";
import type { ContentBlock } from "../../../types/ipc.generated";
import { clearQuestionDraft, saveQuestionDraft } from "./draft-persistence";
import { scheduleAuqPush, clearAuqPush, fetchFreshestAuqDraft } from "./auq-draft-sync";
import {
  isLatestQuestion,
  resolveCwdForSession,
  storePendingPrompt,
  clearPendingPromptById,
} from "./gating";
import type { Question, QuestionDraft, QuestionRequestedPayload } from "./types";
import { rerenderSidebar } from "./index";

/** Mirror per-question answered/unanswered progress into the chat transcript's
 *  question card while the floating card is still being answered. No-op for a
 *  prompt with no session, or when its session isn't the one on screen. */
function syncQuestionProgress(sessionId: string | undefined, promptId: string, questions: Question[], draft: QuestionDraft): void {
  if (!sessionId || state.selectedId !== sessionId) return;
  const liveAnswered = questions.map((q, i) =>
    isQuestionAnswered(q, draft.freeText.get(i) ?? "", draft.selections.get(i))
  );
  state.renderer?.updateQuestionProgress(promptId, liveAnswered);
}

/** `reopened`: clicked in the transcript, so it is deliberately answered out
 *  of order and the isLatestQuestion drop below must not fire. */
export interface ShowQuestionCardOpts { reopened?: boolean }

// Exported for resurface.ts (split out of this file, ai_todo 517).
export async function showQuestionCard(
  payload: QuestionRequestedPayload,
  restoredDraft?: QuestionDraft,
  opts: ShowQuestionCardOpts = {},
): Promise<void> {
  // Park the prompt while it's on screen so switching chats and back re-surfaces
  // it (a card torn down by navigation is otherwise lost while the daemon turn
  // hangs). Cleared when the prompt resolves (`prompt-resolved` listener).
  if (payload.session_id) {
    storePendingPrompt(payload.session_id, { kind: "question", payload });
  }
  const questions: Question[] = Array.isArray(payload.questions)
    ? payload.questions
    : [payload.questions];

  // Priority: in-memory snapshot (switch-away/back, always freshest), then
  // whichever of daemon/localStorage is NEWER by timestamp (fetchFreshestAuqDraft).
  const initialDraft = restoredDraft
    ?? (payload.session_id ? snapshotActiveCardDraft(payload.session_id, payload.id) : undefined)
    ?? (await fetchFreshestAuqDraft(payload.session_id, payload.id))
    ?? undefined;

  renderQuestionUI({
    id: payload.id,
    sessionId: payload.session_id,
    questions,
    initialDraft,
    cwd: resolveCwdForSession(payload.session_id),
    titleIcon: "ph-chat-circle-dots",
    submitLabel: "Submit",
    submitIcon: "ph-paper-plane-right",
    cancelLabel: "Skip",
    // Only this flow delivers an extra message / pasted images to Claude -
    // the built-in-tool flow in permission-card.ts settles via deny.message.
    supportsExtras: true,
    // Lives on the PROMPT PAYLOAD (question.rs), never the model's tool_use
    // input - the one place this is actually readable.
    degradedBuiltin: payload.degraded_builtin === true,
    onDraftChange: (draft) => {
      saveQuestionDraft(payload.id, draft);
      scheduleAuqPush(payload.session_id, payload.id, draft);
      syncQuestionProgress(payload.session_id, payload.id, questions, draft);
    },
    onSubmit: async (answers, extras) => {
      // NOT cleared here (ai_todo 820): the card tears down before this runs,
      // so localStorage is the only surviving draft. Cleared per-branch below.
      void clearAuqPush(payload.session_id, payload.id);
      const sid = payload.session_id;
      // Settle the daemon card + learn whether a live oneshot was resolved:
      // delivered=true means the answer already reached the model in-band.
      // `=== true`, never truthiness: the daemon's raw envelope would
      // otherwise read as delivered and drop the answer block (todo 773).
      let delivered = false;
      try {
        delivered = (await invoke<boolean>("respond_question", { id: payload.id, answers, skipped: false })) === true;
      } catch (e) {
        // respond_question_inner has no error path of its own - this only
        // fires on a transport failure, so falling through to attempt
        // delivery below is intentional, not a missed `return`.
        console.warn("respond_question (settle) failed:", e);
        clearPendingPromptById(payload.id);
        rerenderSidebar();
      }
      if (!sid) { clearQuestionDraft(payload.id); return; }
      if (!opts.reopened && !isLatestQuestion(sid, payload.id)) {
        // This id was ITSELF superseded (a ghost swap, todo 833) - not merely
        // that a sibling card exists (todo 860 fixed that false drop).
        console.warn("[perm-relay] dropping stale question answer", payload.id, "for", sid);
        clearQuestionDraft(payload.id);
        return;
      }
      // bundleHeld/extractAuqAnswerText key off the AUQ_ANSWER_SENTINEL block
      // staying standalone (cca356d8), included only when NOT delivered
      // in-band. Names the card so the fold lands on THIS one, not the newest.
      const answerBlocks: ContentBlock[] = delivered
        ? []
        : [{ type: "text", text: `${auqAnswerSentinel(payload.id)}${formatAnswersAsMessage(questions, answers)}` }];
      // Tagged AUQ_EXTRA_SENTINEL so this folds into the SAME card (see
      // chat-question-card.ts's resolvePendingQuestionExtra), not a detached bubble.
      const cardExtraBlocks: ContentBlock[] = [];
      if (extras.additionalMessage) cardExtraBlocks.push({ type: "text", text: `${AUQ_EXTRA_SENTINEL}${extras.additionalMessage}` });
      for (const a of extras.attachments) {
        if (a.path) cardExtraBlocks.push({ type: "text", text: `<file:${a.path}::${a.filename}>` });
      }
      if (state.selectedId === sid && state.heldMessages) {
        // Unrelated to the card - staged as its own item so it joins any
        // already-queued prose, never merged with the card's own extras.
        const attach = state.heldMessages.getAttached();
        if (attach && !attach.isDraftEmpty()) {
          state.heldMessages.stage(attach.getDraftBlocks());
          attach.clearComposer();
        }
        // Its own held item so bundleHeld's sentinel-group check (held-messages.ts)
        // keeps the note+attachments intact, not merged into the queued prose.
        if (cardExtraBlocks.length) state.heldMessages.stage(cardExtraBlocks);
        try {
          await state.heldMessages.flushHeldWithDraft(answerBlocks);
          clearQuestionDraft(payload.id);
        } catch (e) {
          console.warn("[perm-relay] flushHeldWithDraft (answer delivery) failed:", e);
          showToast(`Answer delivery failed: ${e}`);
        }
      } else if (answerBlocks.length || cardExtraBlocks.length) {
        const cwd = resolveCwdForSession(sid) ?? ".";
        try {
          await invoke("send_message", { sessionId: sid, cwd, blocks: [...answerBlocks, ...cardExtraBlocks] });
          clearQuestionDraft(payload.id);
        } catch (e) {
          // A backgrounded session still mid-turn refuses the write (todo 873).
          // The answer belongs on its held queue, not in a failure toast: the
          // idle sweep in sidebar.ts sends it the moment that turn ends.
          if (isSessionBusyError(e) && state.heldMessages?.stageFor(sid, [...answerBlocks, ...cardExtraBlocks])) {
            clearQuestionDraft(payload.id);
            return;
          }
          console.warn("[perm-relay] send_message (answer delivery) failed:", e);
          showToast(`Answer delivery failed: ${e}`);
        }
      } else {
        // Nothing left to deliver (in-band via the oneshot, no extras): the
        // draft is safe to drop now.
        clearQuestionDraft(payload.id);
      }
    },
    onCancel: async () => {
      // Fire-and-forget skip: the asking turn already ended, so just settle
      // the card (drop the durable prompt + clear "Input Needed"). No message
      // is sent - with no blocking waiter the model never sees a skip signal.
      clearQuestionDraft(payload.id);
      void clearAuqPush(payload.session_id, payload.id);
      try {
        await invoke("respond_question", { id: payload.id, answers: {}, skipped: true });
      } catch (e) {
        console.warn("respond_question (skip settle) failed:", e);
        clearPendingPromptById(payload.id);
        rerenderSidebar();
      }
    },
  });
}
