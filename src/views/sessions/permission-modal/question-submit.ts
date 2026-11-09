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
  displayIdOf,
  isLatestQuestion,
  resolveCwdForSession,
  storePendingPrompt,
  takePendingPrompt,
  savePendingPromptDraft,
  clearPendingPromptById,
  markPendingPromptAnswered,
  markPromptDeferred,
  peekPendingPrompt,
  selectionGuard,
  isForSelectedSession,
  gateDiag,
} from "./gating";
import { askerChips } from "./askers";
import type { Answers, Question, QuestionDraft, QuestionRequestedPayload, QuestionUIOpts } from "./types";
import { rerenderSidebar, surfaceNextForDisplay, surfaceParkedPrompt } from "./index";
import { dropIfAlreadyAnswered } from "./answered-gate";
import { setLiveQuestionProgress } from "../question-progress";
import { startGrace, graceLabel, floatingGraceMount } from "../../../shared/chat/send-grace";

/** Mirror per-question answered/unanswered progress into the chat transcript's
 *  question card while the floating card is still being answered. No-op for a
 *  prompt with no session, or when its session isn't the one on screen. */
function syncQuestionProgress(sessionId: string | undefined, promptId: string, questions: Question[], draft: QuestionDraft): void {
  // The sidebar ring reads this for ANY chat with a card, selected or not.
  if (sessionId && setLiveQuestionProgress(sessionId, promptId, questions, draft)) rerenderSidebar();
  if (!sessionId || state.selectedId !== sessionId) return;
  const liveAnswered = questions.map((q, i) =>
    isQuestionAnswered(q, draft.freeText.get(i) ?? "", draft.selections.get(i))
  );
  state.renderer?.updateQuestionProgress(promptId, liveAnswered);
}

/** Prompt ids whose answer or skip is waiting out its grace window. */
const heldForGrace = new Set<string>();

/** One line of what was picked or typed, for the Undo bar. */
function answerSummary(answers: Answers): string {
  return Object.values(answers)
    .map((a) => (Array.isArray(a) ? a.join(", ") : a))
    .filter(Boolean)
    .join(" / ");
}

/** `reopened`: clicked in the transcript, so it is deliberately answered out
 *  of order and the isLatestQuestion drop below must not fire. */
export interface ShowQuestionCardOpts { reopened?: boolean }

/** What a hidden sub is told when Joe skips its card. A skip normally sends the
 *  model nothing, which is fine for a chat Joe is reading, but the sub's turn
 *  ended when the card posted and nobody reads the sub: without a line it would
 *  sit idle for good. */
export const SUB_SKIP_MESSAGE = "Joe skipped this. Pick the safest default, or finish and report it as blocked.";

/** True when this card was asked by a hidden sub and shows in its main chat. */
function isSubPrompt(payload: QuestionRequestedPayload): boolean {
  const shownOn = displayIdOf(payload);
  return !!shownOn && !!payload.session_id && shownOn !== payload.session_id;
}

/** Deliver the skip line straight to the sub, never through the main chat: the
 *  main agent is not woken and its transcript gains nothing. A sub still
 *  mid-turn holds it on its queue, like an answer does. */
async function tellSubSkipped(sid: string): Promise<void> {
  const blocks: ContentBlock[] = [{ type: "text", text: SUB_SKIP_MESSAGE }];
  try {
    await invoke("send_message", { sessionId: sid, cwd: resolveCwdForSession(sid) ?? ".", blocks });
  } catch (e) {
    if (isSessionBusyError(e) && (await holdWhileBusy(sid, blocks))) return;
    console.warn("[perm-relay] send_message (skip notice) failed:", e);
    showToast(`Skip notice failed: ${e}`);
  }
}

/** Queues a line for a chat that is mid-turn, on whichever page is open. The
 *  held-message queue object only exists once a chat composer has mounted, and a
 *  Skip pressed from the dashboard page has none: the daemon's own held list
 *  takes the line then, and delivers it at the sub's next step. */
async function holdWhileBusy(sid: string, blocks: ContentBlock[]): Promise<boolean> {
  if (state.heldMessages?.stageFor(sid, blocks)) return true;
  try {
    await invoke("add_held_message", { sessionId: sid, blocks });
    return true;
  } catch (e) {
    console.warn("[perm-relay] add_held_message (skip notice) failed:", e);
    return false;
  }
}

/** The picker's click: park the card on screen with its draft, then show the
 *  chosen asker's. The parked slot keeps the half-typed answers, so switching
 *  back finds them. */
function pickAsker(fromAskerId: string, toAskerId: string): void {
  if (fromAskerId === toAskerId) return;
  const draft = snapshotActiveCardDraft(fromAskerId);
  if (draft) savePendingPromptDraft(fromAskerId, draft);
  const target = takePendingPrompt(toAskerId);
  if (!target) return;
  if (target.kind !== "question") {
    // A held-back permission: it takes the window, and the question card it
    // displaces keeps its slot and its saved draft, to come back when it is done.
    const from = peekPendingPrompt(fromAskerId);
    if (from) markPromptDeferred(from.payload.id);
    surfaceParkedPrompt(target);
    return;
  }
  void showQuestionCard(target.payload, target.draft);
}

// Exported for resurface.ts (split out of this file, ai_todo 517).
export async function showQuestionCard(
  payload: QuestionRequestedPayload,
  restoredDraft?: QuestionDraft,
  opts: ShowQuestionCardOpts = {},
): Promise<void> {
  // Every show path funnels through here, so this is the last line of defence
  // against re-presenting a question that was already answered.
  if (heldForGrace.has(payload.id)) return;
  if (dropIfAlreadyAnswered(payload.session_id, payload.id)) return;
  // Park the prompt while it's on screen so switching chats and back re-surfaces
  // it (a card torn down by navigation is otherwise lost while the daemon turn
  // hangs). Cleared when the prompt resolves (`prompt-resolved` listener).
  if (payload.session_id) {
    storePendingPrompt(payload.session_id, { kind: "question", payload });
    // The only place a question card mounts, so the one place that can refuse
    // a card for a chat that is not on screen. Callers check the selection at
    // their own moment, which a later await of theirs can outlive; the park
    // above is what shows the card when that chat is opened again.
    if (!isForSelectedSession(displayIdOf(payload))) {
      console.warn("[perm-gate] DROPPED question card mount for a chat that is not selected (parked)", { eventSessionId: payload.session_id, ...gateDiag() });
      rerenderSidebar();
      return;
    }
  }
  const questions: Question[] = Array.isArray(payload.questions)
    ? payload.questions
    : [payload.questions];

  // Priority: in-memory snapshot (switch-away/back, always freshest), then
  // whichever of daemon/localStorage is NEWER by timestamp (fetchFreshestAuqDraft).
  const stillSelected = selectionGuard();
  const initialDraft = restoredDraft
    ?? (payload.session_id ? snapshotActiveCardDraft(payload.session_id, payload.id) : undefined)
    ?? (await fetchFreshestAuqDraft(payload.session_id, payload.id))
    ?? undefined;
  // Switched chats during the draft fetch: the park stored above replays this
  // card on switch-back, so showing it now would only put it on the wrong chat.
  if (!stillSelected()) {
    rerenderSidebar();
    return;
  }

  // Seed the ring now so a restored draft shows its answered segments before
  // the first edit.
  if (payload.session_id) setLiveQuestionProgress(payload.session_id, payload.id, questions, initialDraft);
  const askerId = payload.session_id;
  const shownOn = displayIdOf(payload);
  const fromSub = isSubPrompt(payload);
  const daemonCard = payload.daemon_card === true;
  // The answer's real delivery. Runs after the grace window, so everything that
  // marks the prompt answered waits with it and an Undo leaves the card as it was.
  const deliverAnswer: QuestionUIOpts["onSubmit"] = async (answers, extras) => {
    // Mark the slot answered NOW, synchronously, before any
    // await below - the daemon's `prompt-resolved` poll that would
    // otherwise clear this slot can lag a full round trip behind a
    // same-turn sibling's arrival, and handleQuestionRequested's sibling
    // gate needs this flag to tell "answered, poll hasn't caught up" apart
    // from "still genuinely open" by more than id-inequality alone.
    if (payload.session_id) markPendingPromptAnswered(payload.session_id, payload.id);
    // Several chats can have a card in this window (a sub per card): the next
    // one comes up now, not after the daemon's resolve poll.
    if (shownOn) surfaceNextForDisplay(shownOn);
    // NOT cleared here (ai_todo 820): the card tears down before this runs,
    // so localStorage is the only surviving draft. Cleared per-branch below.
    void clearAuqPush(payload.session_id, payload.id);
    const sid = payload.session_id;
    // A daemon card answers daemon code and nothing else. Its `session_id` is
    // the main chat it shows in, so every branch below (the answer message, the
    // extras, the chat's composer draft and held queue) would reach that chat's
    // model. It settles the card and stops, whether or not the oneshot was still
    // there: a card withdrawn before the click has no model to tell.
    if (daemonCard) {
      try {
        await invoke("respond_question", { id: payload.id, sessionId: payload.session_id, answers, skipped: false });
      } catch (e) {
        console.warn("respond_question (daemon card) failed:", e);
        clearPendingPromptById(payload.id);
        rerenderSidebar();
      }
      clearQuestionDraft(payload.id);
      return;
    }
    // Settle the daemon card + learn whether a live oneshot was resolved:
    // delivered=true means the answer already reached the model in-band.
    // `=== true`, never truthiness: the daemon's raw envelope would
    // otherwise read as delivered and drop the answer block.
    let delivered = false;
    try {
      delivered = (await invoke<boolean>("respond_question", { id: payload.id, sessionId: payload.session_id, answers, skipped: false })) === true;
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
      // This id was ITSELF superseded (a ghost swap) - not merely
      // that a sibling card exists (an earlier bug dropped it for that).
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
        // A backgrounded session still mid-turn refuses the write.
        // The answer belongs on its held queue, not in a failure toast: the
        // idle sweep in sidebar.ts sends it the moment that turn ends.
        if (isSessionBusyError(e) && (await holdWhileBusy(sid, [...answerBlocks, ...cardExtraBlocks]))) {
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
  };

  const deliverSkip = async (): Promise<void> => {
    // Fire-and-forget skip: the asking turn already ended, so just settle
    // the card (drop the durable prompt + clear "Input Needed"). No message
    // is sent - with no blocking waiter the model never sees a skip signal.
    // Marked answered too - a skip settles the slot exactly like
    // a submit does, same stale-vs-open ambiguity while the resolve poll
    // hasn't caught up yet.
    if (payload.session_id) markPendingPromptAnswered(payload.session_id, payload.id);
    if (shownOn) surfaceNextForDisplay(shownOn);
    clearQuestionDraft(payload.id);
    void clearAuqPush(payload.session_id, payload.id);
    try {
      await invoke("respond_question", { id: payload.id, sessionId: payload.session_id, answers: {}, skipped: true });
    } catch (e) {
      console.warn("respond_question (skip settle) failed:", e);
      clearPendingPromptById(payload.id);
      rerenderSidebar();
    }
    // Only a sub's Skip says anything: every other chat's stays silent.
    if (fromSub && payload.session_id) await tellSubSkipped(payload.session_id);
  };

  // Several chats can have a card at once; each holds its own answer.
  const graceKey = shownOn ?? payload.session_id ?? payload.id;
  const withGrace = (label: string, fire: () => Promise<void> | void): Promise<void> => {
    // Parked replays (a chat switch back) must not re-show a card whose answer is on hold.
    heldForGrace.add(payload.id);
    return startGrace({
      key: graceKey,
      label,
      mount: floatingGraceMount(),
      fire: () => { heldForGrace.delete(payload.id); return fire(); },
      onUndo: () => { heldForGrace.delete(payload.id); void showQuestionCard(payload, undefined, opts); },
    });
  };

  renderQuestionUI({
    id: payload.id,
    sessionId: payload.session_id,
    displayId: shownOn,
    questions,
    // Joe does not read the sub, so its card names it and its one-line job.
    from: fromSub
      ? { name: payload.sub_name || state.sessions.find((s) => s.session_id === askerId)?.name?.trim() || "Subchat", task: payload.sub_task }
      : undefined,
    askers: askerId && shownOn ? () => askerChips(shownOn, askerId) : undefined,
    onPickAsker: askerId ? (to) => pickAsker(askerId, to) : undefined,
    initialDraft,
    cwd: resolveCwdForSession(payload.session_id),
    titleIcon: "ph-chat-circle-dots",
    submitLabel: "Submit",
    submitIcon: "ph-paper-plane-right",
    cancelLabel: "Skip",
    // Only this flow delivers an extra message / pasted images to Claude -
    // the built-in-tool flow in permission-card.ts settles via deny.message.
    supportsExtras: !daemonCard,
    daemonCard,
    finalStamp: payload.final_stamp,
    // Lives on the PROMPT PAYLOAD (question.rs), never the model's tool_use
    // input - the one place this is actually readable.
    degradedBuiltin: payload.degraded_builtin === true,
    hasOlderPending: payload.has_older_pending === true,
    onDraftChange: (draft) => {
      saveQuestionDraft(payload.id, draft);
      scheduleAuqPush(payload.session_id, payload.id, draft);
      syncQuestionProgress(payload.session_id, payload.id, questions, draft);
    },
    onSubmit: (answers, extras) => withGrace(graceLabel("Answer", answerSummary(answers)), () => deliverAnswer(answers, extras)),
    onCancel: () => withGrace("Skipping this question", deliverSkip),
  });
}
