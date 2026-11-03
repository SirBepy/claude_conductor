/**
 * Hovering any assistant bubble reveals its turn's tokens + time. The footer
 * is a later sibling of the bubbles it summarizes (pinned before the next user
 * message), so CSS alone cannot link them: a general-sibling selector would
 * light up every later turn's footer too. Delegated from the chat container.
 */

const HOT = "turn-footer--hot";

/** The first footer after `bubble` and before the next visible user message,
 *  i.e. the footer of the turn the bubble belongs to. Hidden author markers
 *  (a peer's message folded into the turn) do not end the turn. */
export function footerOfTurn(bubble: Element): HTMLElement | null {
  for (let n = bubble.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.classList.contains("turn-footer")) return n as HTMLElement;
    if (n.classList.contains("msg") && n.classList.contains("user") && !n.classList.contains("author-marker")) {
      return null;
    }
  }
  return null;
}

export function handleTurnMetaHover(e: MouseEvent): void {
  const bubble = (e.target as Element | null)?.closest?.(".msg.assistant");
  if (bubble) footerOfTurn(bubble)?.classList.add(HOT);
}

export function handleTurnMetaHoverOut(e: MouseEvent): void {
  const bubble = (e.target as Element | null)?.closest?.(".msg.assistant");
  if (!bubble) return;
  // Moving between a bubble's own children is not leaving it.
  const to = e.relatedTarget as Node | null;
  if (to && bubble.contains(to)) return;
  footerOfTurn(bubble)?.classList.remove(HOT);
}
