import { isQuestionAnswered } from "./permission-modal/question-state";
import { peekPendingPrompt } from "./permission-modal/gating";
import type { Question, QuestionDraft, Selection } from "./permission-modal/types";

/** How far a chat's open question card has got, for the sidebar ring and the
 *  hover card. `answers[i]` is the text given for question i, or null while
 *  it is still open. */
export interface QuestionProgress {
  questions: Question[];
  answers: Array<string | null>;
  total: number;
  answered: number;
}

function answerText(freeText: string, selection: Selection | undefined): string {
  const typed = freeText.trim();
  const picked = selection instanceof Set ? [...selection].join(", ") : typeof selection === "string" ? selection : "";
  return [picked, typed].filter(Boolean).join(" + ");
}

/** Pure: progress of `questions` against a (possibly missing) draft. */
export function computeQuestionProgress(questions: Question[], draft: QuestionDraft | undefined): QuestionProgress {
  const answers = questions.map((q, i) => {
    const freeText = draft?.freeText.get(i) ?? "";
    const selection = draft?.selections.get(i);
    return isQuestionAnswered(q, freeText, selection) ? answerText(freeText, selection) : null;
  });
  return { questions, answers, total: questions.length, answered: answers.filter((a) => a !== null).length };
}

// The open card's draft only reaches the parked prompt when the user switches
// away (active-session.ts), so the selected chat's live progress is mirrored
// here on every edit instead. Keyed by session and tagged with the prompt id,
// so a stale entry from an earlier question is never read as the next one's.
const live = new Map<string, { promptId: string; progress: QuestionProgress }>();

/** Record the open card's progress. Returns whether the answered count moved,
 *  so the caller re-renders the sidebar only when the ring would change. */
export function setLiveQuestionProgress(
  sessionId: string,
  promptId: string,
  questions: Question[],
  draft: QuestionDraft | undefined,
): boolean {
  const next = computeQuestionProgress(questions, draft);
  const prev = live.get(sessionId);
  live.set(sessionId, { promptId, progress: next });
  return prev?.promptId !== promptId || prev.progress.answered !== next.answered || prev.progress.total !== next.total;
}

/** Progress for a chat with a question waiting, or null when none is parked.
 *  The live card wins; a card nobody has opened yet falls back to the parked
 *  prompt (and the draft saved when its chat was switched away from). */
export function questionProgressFor(sessionId: string): QuestionProgress | null {
  const parked = peekPendingPrompt(sessionId);
  if (!parked || parked.kind !== "question" || parked.answered) return null;
  const liveEntry = live.get(sessionId);
  if (liveEntry && liveEntry.promptId === parked.payload.id) return liveEntry.progress;
  const qs = Array.isArray(parked.payload.questions) ? parked.payload.questions : [parked.payload.questions];
  return computeQuestionProgress(qs, parked.draft);
}
