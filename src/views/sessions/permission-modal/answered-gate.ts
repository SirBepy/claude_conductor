/**
 * "Was this question already answered?" - the one check every show path runs
 * before a question card is mounted or re-parked. A question can be answered
 * from a place the card never hears about: another window, the phone, or a
 * previous app run whose daemon still lists the prompt. Without this gate such
 * a prompt pops again as if open (and again on every switch-back), because the
 * only memory of the answer was a flag on a park that a reload throws away.
 *
 * Three independent sources, any one is enough:
 *  - the in-memory settled set (this window answered or skipped it),
 *  - the parked entry's own `answered` flag,
 *  - the session's loaded transcript carrying `<auq-answer id="<prompt id>"/>`
 *    (the fire-and-forget answer message; the id is the DAEMON prompt id, so it
 *    survives a reload and a daemon restart where the first two do not).
 */

import { invoke } from "../../../shared/ipc";
import { sessionEvents } from "../../../shared/chat/event-store";
import { extractAuqAnswerCardId } from "../../../shared/chat/chat-transforms";
import { clearPendingPromptById, isQuestionSettled, markPendingPromptAnswered, peekPendingPrompt } from "./gating";
import { rerenderSidebar } from "./index";

type AnsweredBy = "settled" | "parked" | "transcript";

function transcriptCarriesAnswer(sessionId: string, promptId: string): boolean {
  return sessionEvents.events(sessionId).some(
    (ev) => ev.type === "user_message" && extractAuqAnswerCardId(ev.content) === promptId,
  );
}

function answeredBy(sessionId: string | undefined, promptId: string): AnsweredBy | null {
  if (isQuestionSettled(promptId)) return "settled";
  if (!sessionId) return null;
  const parked = peekPendingPrompt(sessionId);
  if (parked?.kind === "question" && parked.payload.id === promptId && parked.answered) return "parked";
  return transcriptCarriesAnswer(sessionId, promptId) ? "transcript" : null;
}

/** The gate plus its cleanup: true means the prompt must not be shown. A
 *  transcript-proven answer means the daemon may still list the prompt, so it
 *  is settled there too (a skip only settles; the answer already reached
 *  Claude as a message) or it would keep being served on every reload. A
 *  "settled"/"parked" answer already went through respond_question. */
export function dropIfAlreadyAnswered(sessionId: string | undefined, promptId: string): boolean {
  const by = answeredBy(sessionId, promptId);
  if (!by) return false;
  clearPendingPromptById(promptId);
  if (by === "transcript" && sessionId) {
    markPendingPromptAnswered(sessionId, promptId);
    void invoke("respond_question", { id: promptId, sessionId, answers: {}, skipped: true })
      .catch((e) => console.warn("[perm-gate] respond_question (settle already-answered) failed:", e));
  }
  rerenderSidebar();
  return true;
}
