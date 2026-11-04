// The AUQ card's minimize/expand state machine: the exit animation that plays
// before the collapsed bar replaces the card, and the mid-exit reopen. Owns
// only the exit-in-flight state; whether the card is minimized, and the render
// that paints it, stay with question-ui-render.ts and come in through deps.

export interface CollapseControllerDeps {
  host: HTMLElement;
  /** The fullscreen preview lives outside the host; back presses close it first. */
  fullscreen: { isOpen: () => boolean; close: () => void };
  isMinimized: () => boolean;
  setMinimized: (value: boolean) => void;
  /** Flags the one render() that follows, so the card rises out of the bar. */
  setExpanding: (value: boolean) => void;
  render: () => void;
}

export interface CollapseController {
  /** Collapses the card to its bar. Returns false when it already was one,
   *  so a back press can fall through to the next handler. */
  minimize: () => boolean;
  /** Re-opens a collapsed card. Returns false when it was already open. */
  expand: () => boolean;
}

// The card plays its exit before the bar replaces it. Must match
// prompt-card-out's duration in permission-modal-shell.css; the timer is only
// the fallback for an animationend that never fires (hidden tab).
const COLLAPSE_MS = 280;

export function createCollapseController(deps: CollapseControllerDeps): CollapseController {
  const { host, fullscreen, isMinimized, setMinimized, setExpanding, render } = deps;
  let collapsing = false;
  let collapseTimer: number | undefined;

  function minimize(): boolean {
    // The phone's back press lands here: it leaves fullscreen first.
    if (fullscreen.isOpen()) { fullscreen.close(); return true; }
    if (isMinimized()) return false;
    // A second press mid-exit is still consumed, so back never falls through
    // to leaving the chat while the card is on its way down.
    if (collapsing) return true;
    const card = host.querySelector<HTMLElement>(".prompt-card");
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const collapse = (): void => {
      setMinimized(true);
      render();
      host.querySelector(".prompt-collapsed")?.classList.add("prompt-collapsed--in");
    };
    if (!card || reduced) { collapse(); return true; }
    collapsing = true;
    card.classList.add("prompt-card--leaving");
    const finish = (): void => {
      if (!collapsing) return;
      collapsing = false;
      window.clearTimeout(collapseTimer);
      // The card may have been answered or swapped out during the exit.
      if (host.isConnected) collapse();
    };
    card.addEventListener("animationend", (e) => { if (e.target === card) finish(); });
    collapseTimer = window.setTimeout(finish, COLLAPSE_MS + 80);
    return true;
  }

  function expand(): boolean {
    if (collapsing) {
      // Re-opened mid-exit: stop the exit instead of finishing it. The timer
      // goes too, or it would cut a later exit short.
      collapsing = false;
      window.clearTimeout(collapseTimer);
      host.querySelector(".prompt-card--leaving")?.classList.remove("prompt-card--leaving");
      return true;
    }
    if (!isMinimized()) return false;
    setMinimized(false);
    setExpanding(true);
    render();
    setExpanding(false);
    return true;
  }

  return { minimize, expand };
}
