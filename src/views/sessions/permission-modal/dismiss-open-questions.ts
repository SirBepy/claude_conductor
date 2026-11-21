// Chat menu "Dismiss open questions": the way out for question cards that stay
// "awaiting answer" with nothing left that could answer them (a card from before
// an app update, a question Claude moved on from). Each card is settled exactly
// as its own Skip would settle it, so the mark survives a reload.

import { getTransport } from "../../../shared/transport";
import { invoke } from "../../../shared/ipc";
import { flushRenderNow } from "../../../shared/chat/flush-scheduler";
import { needsCardSkipMark, skipQuestionCard } from "../../../shared/chat/chat-question-card";
import { cardQuestionTexts, isDaemonPromptId, questionTextsOf, sameQuestions } from "../../../shared/chat/question-texts";
import { isOpenQuestion } from "../../../shared/chat/dashboard/dashboard-model";
import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import type { ChatRenderer } from "../../../shared/chat/chat-renderer";
import { state } from "../state";
import { findPendingPromptsForSession } from "./remote-prompt-poll";
import { clearPendingPromptById, markPendingPromptAnswered } from "./gating";
import { dismissQuestionCard } from "./question-state";
import { rerenderSidebar, takeQueuedSiblingQuestionById } from "./index";
import type { QuestionRequestedPayload } from "./types";
import { QUESTION_SETTLED_EVENT } from "../chat-dashboard/question-liveness";

/** The open question cards of the chat on screen, when `sessionId` is it. */
export function openQuestionCards(sessionId: string): RenderedMessage[] {
  const r = state.renderer;
  if (!r || r.sessionId !== sessionId) return [];
  return r.messages.filter(isOpenQuestion);
}

/** Skip every open question card in `sessionId`'s transcript. A card the daemon
 *  still holds is settled under the daemon's own prompt id (matched by id, or by
 *  what it asks for a prompt from before the ids matched); any other card under
 *  its own id, which leaves the durable mark. Returns how many were dismissed. */
export async function dismissOpenQuestions(sessionId: string): Promise<number> {
  const r = state.renderer;
  const cards = openQuestionCards(sessionId);
  if (!r || cards.length === 0) return 0;
  let held: QuestionRequestedPayload[] = [];
  try {
    const recs = findPendingPromptsForSession(await getTransport().call("list_pending_prompts"), sessionId);
    held = recs.filter((p) => p.kind === "question").map((p) => p.payload as QuestionRequestedPayload);
  } catch (e) {
    // Without the daemon's list every card settles under its own id: the
    // transcript still clears, and a prompt the daemon held pops up again.
    console.warn("[perm-gate] list_pending_prompts (dismiss open questions) failed:", e);
  }
  let dismissed = 0;
  for (const card of cards) {
    if (!card.id) continue;
    const asked = cardQuestionTexts(card);
    const prompt = held.find((p) => p.id === card.id)
      ?? held.find((p) => isDaemonPromptId(p.id) && sameQuestions(asked, questionTextsOf(p.questions)));
    if (prompt) held = held.filter((p) => p !== prompt);
    if (await settleQuestionCard(r, sessionId, card.id, asked, prompt?.id ?? card.id)) dismissed++;
  }
  if (state.renderer === r) flushRenderNow(r);
  rerenderSidebar();
  return dismissed;
}

/** Settle one open card exactly as its own Skip would, under `promptId` (the
 *  daemon's prompt id when it holds one, else the card's own `cardId`): the
 *  parked slot, the queued sibling and the card on screen go, and the durable
 *  skip mark is written so a reload keeps it settled. True when the card's row
 *  was marked skipped in `r` (a row only in the history prefix is settled by the
 *  mark alone). */
export async function settleQuestionCard(r: ChatRenderer, sessionId: string, cardId: string, asked: readonly string[], promptId: string): Promise<boolean> {
  markPendingPromptAnswered(sessionId, promptId);
  clearPendingPromptById(promptId);
  takeQueuedSiblingQuestionById(sessionId, promptId);
  dismissQuestionCard(promptId);
  // The held prompt under its own id; a prompt from before the ids matched
  // also under the card's, or the card's mark would name an id no card has.
  for (const settle of needsCardSkipMark(promptId, cardId) ? [promptId, cardId] : [promptId]) {
    try {
      await invoke("respond_question", { id: settle, sessionId, answers: {}, skipped: true });
    } catch (e) {
      console.warn("[perm-gate] respond_question (settle question card) failed:", e);
    }
  }
  return state.renderer === r && skipQuestionCard(r, cardId, asked) !== null;
}

/** A card Joe clicked that cannot be reopened (no daemon prompt, none to rebuild
 *  from the transcript) is dead: clear it, wherever its row lives, instead of
 *  leaving it under Waiting on you. False when nothing was cleared (the chat on screen changed). */
export async function clearUnreopenableCard(sessionId: string, cardId: string): Promise<boolean> {
  const r = state.renderer;
  if (!r || r.sessionId !== sessionId) return false;
  const row = r.messages.find((m) => m.kind === "question" && m.id === cardId);
  await settleQuestionCard(r, sessionId, cardId, row ? cardQuestionTexts(row) : [], cardId);
  flushRenderNow(r);
  rerenderSidebar();
  window.dispatchEvent(new CustomEvent(QUESTION_SETTLED_EVENT, { detail: { sessionId, id: cardId } }));
  return true;
}
