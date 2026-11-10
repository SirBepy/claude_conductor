// Holds a question card on screen while its answer waits out the send grace
// window (shared/chat/send-grace.ts): the card goes inert and the grace Undo
// button covers the control that was pressed, the way it covers the composer's
// Send. Undo hands the card back exactly as it was, nothing is rebuilt.
import "../../../shared/chat/send-grace.css";

export interface CardFreeze {
  /** Where the Undo button goes: a box laid over the pressed control. */
  cover: HTMLElement;
  /** Remove the cover and make the card live again. */
  thaw: () => void;
}

/** Selectors for the control a submit presses, widest-visible first: the answer
 *  box's arrow when the box is up, else the footer's Submit button. */
export const SUBMIT_CONTROLS = ['.prompt-answer-send.is-submit', '[data-act="primary"]'];
/** Skip lives on the minimized bar. */
export const SKIP_CONTROLS = ['.prompt-collapsed [data-act="cancel"]'];

export function freezeCard(host: HTMLElement, controls: string[]): CardFreeze {
  const cover = document.createElement("span");
  cover.className = "send-grace-cover";
  // Outside the host, which is inert and may be rebuilt: the button must stay clickable.
  document.body.appendChild(cover);

  const place = (): void => {
    const target = controls
      .map((s) => host.querySelector<HTMLElement>(s))
      .find((el) => el && el.offsetWidth > 0);
    if (target) {
      const r = target.getBoundingClientRect();
      Object.assign(cover.style, {
        left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
        right: "", bottom: "",
      });
      return;
    }
    // No such control on screen (Ctrl+Enter on a card shown as its bar): corner of the card.
    const r = host.getBoundingClientRect();
    Object.assign(cover.style, {
      left: "", top: "", width: "var(--control-h)", height: "var(--control-h)",
      right: `${window.innerWidth - r.right + 8}px`, bottom: `${window.innerHeight - r.bottom + 8}px`,
    });
  };
  place();
  host.inert = true;
  host.classList.add("prompt-card-host--held");
  // The card is anchored to the composer, which grows as the next message is
  // typed during the window, so the cover follows it every frame (a few seconds
  // of one rect read per frame).
  let frame = 0;
  const follow = (): void => {
    place();
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);

  return {
    cover,
    thaw: () => {
      cancelAnimationFrame(frame);
      cover.remove();
      host.inert = false;
      host.classList.remove("prompt-card-host--held");
    },
  };
}
