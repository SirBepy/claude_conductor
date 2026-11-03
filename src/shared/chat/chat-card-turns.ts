// Which message cards are old enough to shrink to a mini card. Derived from the
// transcript on every render, never stored: a card is old once a LATER turn has
// a visible send_message row (a card or a legacy bubble, not an ack). Two cards
// in the same turn both stay full size.
//
// One function, called from the two places every path goes through:
// flushRender (live append, history bulk load, resync, chat switch) and the
// paginator's prependEvents (older pages). It only toggles a class on the
// card's root; chat-message-cards.css does the rest.

import type { RenderedMessage } from "./chat-classifiers";
import { isVisibleMessage } from "./chat-message-kinds";
import { startsTurn } from "./chat-next-actions";

const OLD = "is-old";
// Switches the height transition off for a card that was never seen at full
// size (a history load, an older page), so opening a chat does not play the
// shrink for every earlier turn.
const STILL = "mc-still";

/** `animate` is true only for a card that is on screen at full size right now,
 *  i.e. a live append while the user is watching the chat. */
export function sweepOldCards(messages: readonly RenderedMessage[], els: readonly (HTMLElement | undefined)[], animate: boolean): void {
  let laterTurnSpoke = false;
  let thisTurnSpoke = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "message") {
      if (isVisibleMessage(m)) thisTurnSpoke = true;
      const el = els[i];
      if (m.card && el?.classList.contains("mc-root")) setOld(el, laterTurnSpoke, animate);
    }
    // Walking backwards, a turn-starting row is where the turn above it begins to
    // count as "later" for everything before it.
    if (startsTurn(m)) {
      laterTurnSpoke ||= thisTurnSpoke;
      thisTurnSpoke = false;
    }
  }
}

function setOld(el: HTMLElement, old: boolean, animate: boolean): void {
  if (el.classList.contains(OLD) === old) return;
  if (old && !animate) el.classList.add(STILL);
  else if (!old) el.classList.remove(STILL);
  el.classList.toggle(OLD, old);
}
