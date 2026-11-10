// A question card's Ask button: the chat dashboard's Answers card opens a thread
// about that question (docs/chat-dashboard-design.md, "Asking about a question
// card"). Announced on `window` because the card lives in permission-modal,
// which must not import the dashboard. The event is cancelable: the dashboard
// that takes it calls preventDefault, and only then does the card minimize, so
// a card with no dashboard to take it never hides itself for nothing.

import { splitAsk } from "./permission-modal/question-state";
import type { Question } from "./permission-modal/types";

export const QUESTION_ASK_EVENT = "cc-question-ask";

export interface QuestionAsk {
  /** Which card and question it is (prompt id plus question index), so asking
   *  about it again returns to its thread while a later card with the same
   *  words gets a fresh one. Falls back to `about` when the card has no id. */
  card: string;
  /** The question's final ask line: the thread's title. */
  title: string;
  /** The question and its options as markdown: the thread opens on it and the
   *  sidecar is told it is what Joe asks about. */
  about: string;
}

export function questionAsk(q: Question, promptId?: string, index = 0): QuestionAsk {
  const opts = (q.options ?? [])
    .map((o) => `- **${o.label}**${o.description ? `: ${o.description}` : ""}`)
    .join("\n");
  const question = q.question.trim();
  const about = opts ? `${question}\n\n${opts}` : question;
  return { card: promptId ? `${promptId}#${index}` : about, title: splitAsk(question).ask, about };
}

/** True when a dashboard took the ask. */
export function askAboutQuestion(q: Question, promptId?: string, index = 0): boolean {
  const ev = new CustomEvent<QuestionAsk>(QUESTION_ASK_EVENT, { detail: questionAsk(q, promptId, index), cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}
