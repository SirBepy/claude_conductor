// The suggestion rows above the message box (a chat's quick-reply strip, a draft's
// dashboard chip row) are for an empty box. One place decides when they step aside,
// so a surface added later cannot forget the rule: any text or attachment in the
// box hides them, emptying it brings the same buttons straight back.
import { state } from "./state";

/** Every suggestion row a pane can hold; each one just takes `data-typing`. */
const SUGGESTION_ROWS = ".next-chip-slot, .pd-qa-host.is-draft:not(.pd-ghost)";

/** Whether the open pane's composer holds text or an attachment. */
export function isTyping(): boolean {
  return !!state.composer && !state.composer.isDraftEmpty();
}

/** Mirrors the composer's emptiness onto every suggestion row in `pane`. Cheap and
 *  idempotent; call it after anything that changes the draft or mounts a row. */
export function syncSuggestionRows(pane: ParentNode): void {
  const typing = isTyping();
  for (const row of pane.querySelectorAll<HTMLElement>(SUGGESTION_ROWS)) row.toggleAttribute("data-typing", typing);
}
