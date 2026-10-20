// A question card asks the sessions view to open the Ask panel on its question.
// Announced on `window` (like the draft card's open event) because the card
// lives in permission-modal, which must not import the view that owns the FAB.

import type { Question } from "./permission-modal/types";

/** `detail: { text }` - the prefill for Ask's input. */
export const ASK_OPEN_EVENT = "cc-ask-open";

/** One-line prefill naming the question and its options, ending where the
 *  user types what they actually want clarified. Single-line because Ask's
 *  input is a one-line field. */
export function askContextText(q: Question): string {
  const opts = (q.options ?? [])
    .map((o) => (o.description ? `${o.label} (${o.description})` : o.label))
    .join("; ");
  const head = `About this question: "${q.question}"`;
  return `${head}${opts ? ` Options: ${opts}.` : ""} My question: `;
}
