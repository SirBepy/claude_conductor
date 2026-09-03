// Visual-only hold over the chat pane while selectSession tears it down and
// rebuilds it for a /respawn successor - without it the swap blinks through
// an empty pane.

const FADE_MS = 160; // matches .pane-freeze's opacity transition

/** Nodes a clone can't carry - an iframe re-navigates, a canvas comes back blank. */
const UNCLONEABLE = "iframe, canvas, video, audio";

/** Pin a still frame of the transcript over `pane`. The returned release fades
 *  it out; both are no-ops when there is nothing to freeze. */
export function freezePane(pane: HTMLElement): () => void {
  const messages = pane.querySelector<HTMLElement>(".session-messages");
  if (!messages || messages.childElementCount === 0) return () => {};

  const still = document.createElement("div");
  still.className = "pane-freeze";
  const clone = messages.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(UNCLONEABLE).forEach((n) => n.remove());
  still.appendChild(clone);
  pane.appendChild(still);
  // After append, not before: a detached clone has no layout to scroll, and a
  // frame stuck at the top shows rows the real pane wasn't showing.
  clone.scrollTop = messages.scrollTop;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    still.classList.add("is-fading");
    setTimeout(() => still.remove(), FADE_MS);
  };
}
