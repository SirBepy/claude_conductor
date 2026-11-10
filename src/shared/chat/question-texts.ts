// Telling two copies of one ask apart from two different asks. A card in the
// transcript is keyed by Claude's tool_use id, and the daemon's prompt by its own
// id; prompts from before the two ids were the same can only be matched to their
// card by what they ask.

import type { RenderedMessage } from "./chat-classifiers";

/** The `question` strings of an ask's `questions` list (a tool_use input's or a
 *  prompt payload's), in order. */
export function questionTextsOf(questions: unknown): string[] {
  const list = Array.isArray(questions) ? questions : [questions];
  return list.flatMap((q) => (q && typeof q === "object" && typeof (q as { question?: unknown }).question === "string"
    ? [(q as { question: string }).question] : []));
}

/** The question strings a transcript question card asks. */
export function cardQuestionTexts(m: RenderedMessage): string[] {
  return questionTextsOf((m.input as { questions?: unknown } | null)?.questions);
}

/** Same questions, in the same order. Two empty lists are not a match: nothing
 *  is known about either ask. */
export function sameQuestions(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  return a.every((q, i) => q.trim() === b[i]!.trim());
}

/** The daemon's own random prompt id, which no transcript card carries: what
 *  every prompt was keyed by before its id became the card's tool_use id. */
const DAEMON_PROMPT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A prompt keyed by a random daemon id: only such a prompt may be matched to
 *  its card by what it asks. */
export function isDaemonPromptId(id: string): boolean {
  return DAEMON_PROMPT_UUID.test(id);
}

/** The open transcript card a prompt stands for: the one with its id, else
 *  (a prompt keyed by a random daemon id, from before the ids matched) the
 *  newest open card asking the same questions. -1 when there is none, or when
 *  the card with the id is settled or not loaded, so a caller never settles
 *  some other card that happens to ask the same thing. */
export function findOpenCardForPrompt(messages: readonly RenderedMessage[], id: string, questions: readonly string[]): number {
  const open = (m: RenderedMessage): boolean => m.kind === "question" && m.text === undefined && !m.failed;
  const byId = messages.findIndex((m) => m.kind === "question" && m.id === id);
  if (byId >= 0) return open(messages[byId]!) ? byId : -1;
  if (!isDaemonPromptId(id)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (open(m) && sameQuestions(cardQuestionTexts(m), questions)) return i;
  }
  return -1;
}
