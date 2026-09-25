// Shared "loading transcript" overlay for chat panes. Used by both the Sessions
// view (cache-miss on opening a live session) and the History view (opening a
// past session).
//
// On the phone this carries a real percentage: the transcript arrives as a
// single `load_history_page` RPC whose response has a Content-Length, so
// load-progress.ts can report measured bytes rather than a spinner. Desktop
// keeps the plain indeterminate ring - its Tauri pipe exposes no byte stream to
// measure, and the load is local anyway.

import { createLoadCopy, createLoadDial, driveLoadDial } from "../load-dial";
import { activeLoad, type LoadSnapshot } from "../load-progress";
import { isRemote } from "../transport";

/** The RPC the chat transcript actually waits on - see
 *  event-store-pagination.ts's loadInitial. */
const TRANSCRIPT_METHOD = "load_history_page";

/** Overlay plus the frame loop driving it, so a caller that unmounts mid-load
 *  can stop the loop instead of leaking an rAF chain. */
export interface ChatLoadingOverlay {
  el: HTMLElement;
  remove: () => void;
}

/** Snapshot shown before this overlay's own RPC has been dispatched. */
const PENDING: LoadSnapshot = {
  phase: "waiting",
  fraction: null,
  etaMs: null,
  receivedBytes: 0,
  totalBytes: null,
  elapsedMs: 0,
};

/**
 * Snapshot source for the transcript load.
 *
 * The overlay is mounted BEFORE `load_history_page` is dispatched (the callers
 * put it up, then await the event store), so at mount time `activeLoad` either
 * returns nothing or returns the PREVIOUS chat's finished tracker. Binding to
 * that stale one would paint an instant 100%. Capturing it and waiting for a
 * different object to appear is what makes the dial track this open rather than
 * the last one.
 */
function transcriptSource(): () => LoadSnapshot {
  const stale = activeLoad(TRANSCRIPT_METHOD);
  return () => {
    const current = activeLoad(TRANSCRIPT_METHOD);
    if (!current || current === stale) return PENDING;
    return current.snapshot();
  };
}

/**
 * Show a centered loading indicator over `pane`.
 *
 * Ensures `pane` is a positioning context so the overlay centers correctly.
 * The returned handle's `remove` cancels the paint loop as well as dropping the
 * DOM, so dropping the element alone leaves an rAF chain running until the load
 * settles on its own.
 */
export function mountChatLoadingOverlay(pane: HTMLElement): ChatLoadingOverlay {
  pane.querySelector(".chat-loading-overlay")?.remove();
  if (getComputedStyle(pane).position === "static") {
    pane.style.position = "relative";
  }
  const overlay = document.createElement("div");
  overlay.className = "chat-loading-overlay";

  if (!isRemote()) {
    overlay.innerHTML = '<div class="chat-loading-ring"></div><div>Loading transcript&hellip;</div>';
    pane.appendChild(overlay);
    return { el: overlay, remove: () => overlay.remove() };
  }

  const dial = createLoadDial();
  const copy = createLoadCopy("Loading transcript");
  overlay.append(dial, copy);
  pane.appendChild(overlay);
  const stop = driveLoadDial(dial, transcriptSource(), copy);
  return {
    el: overlay,
    remove: () => {
      stop();
      overlay.remove();
    },
  };
}
