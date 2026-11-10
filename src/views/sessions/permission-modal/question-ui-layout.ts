// Card geometry and attachment-strip painting for the AUQ card: the sliding
// track's position/height, the chat-scroll padding that keeps the last message
// clear of the card, and the per-panel attachment strips. Split out of
// question-ui-render.ts, which keeps the render/event-wiring orchestration.

import { isElNearBottom } from "../../../shared/chat/chat-dom-renderer";
import type { AuqAttachmentsController } from "./attachments";
import { CHAT_VIEW_CHANGED } from "../chat-dashboard/chat-view-pref";
import { PEEK_SETTLED_EVENT } from "./drag-handle";
import type { QuestionRenderState } from "./question-ui-templates";

export interface QuestionCardLayout {
  showPasteHint: (bar: HTMLElement, message: string) => void;
  paintAttachmentStrips: () => void;
  syncMessagesPadding: () => void;
  positionTrack: (instant: boolean, slideFrom?: number) => void;
  /** Card teardown: drops the document listener that follows the chat view setting. */
  dispose: () => void;
}

/** The scroller the card pads so nothing hides under it: the card's own pane
 *  first (the document's first .session-messages can belong to another view),
 *  and in that pane the chat dashboard's body while it shows, since the
 *  transcript is display:none then and measures nothing. */
export function cardPaddedScroller(host: HTMLElement): HTMLElement | null {
  const pane = host.closest<HTMLElement>(".session-pane");
  const dash = pane?.getAttribute("data-chat-view") === "dashboard" ? pane.querySelector<HTMLElement>(".cdash-body") : null;
  return dash ?? pane?.querySelector<HTMLElement>(".session-messages") ?? document.querySelector<HTMLElement>(".session-messages");
}

export function createQuestionCardLayout(
  host: HTMLElement,
  state: QuestionRenderState,
  fallbackScroller: HTMLElement | null,
  auqAttachments: AuqAttachmentsController,
): QuestionCardLayout {
  let hintTimer: number | undefined;

  // Brief feedback for a paste that couldn't attach (see attachments.ts's
  // handleAttachmentPaste) - one reused node per card, auto-clears itself.
  function showPasteHint(bar: HTMLElement, message: string): void {
    bar.querySelector(".prompt-paste-hint")?.remove();
    window.clearTimeout(hintTimer);
    const hint = document.createElement("div");
    hint.className = "prompt-paste-hint";
    hint.textContent = message;
    bar.appendChild(hint);
    hintTimer = window.setTimeout(() => hint.remove(), 2500);
  }

  // Each strip renders only the panel it belongs to (data-attach-panel), so a
  // pasted image stays on the step it was pasted into.
  function paintAttachmentStrips(): void {
    host.querySelectorAll<HTMLElement>(".prompt-attachments").forEach((el) => {
      const panel = Number(el.dataset.attachPanel);
      if (Number.isFinite(panel)) auqAttachments.renderAttachmentsStrip(el, panel);
    });
  }

  // The scroller this card last padded. The Dashboard / Messages switch swaps which
  // scroller shows while the card stays open, so the padding follows the live one
  // and the old one is cleared (else it keeps a band of empty space nobody sees).
  let padded: HTMLElement | null = null;
  const syncMessagesPadding = (): void => {
    const target = cardPaddedScroller(host) ?? fallbackScroller;
    if (!target) return;
    if (padded && padded !== target) padded.style.paddingBottom = "";
    padded = target;
    // Broadened to the minimized bar too - it replaces .prompt-card wholesale
    // rather than living inside it, so the old ".prompt-card"-only selector
    // would stop measuring anything once minimized.
    const card = host.querySelector<HTMLElement>(".prompt-card, .prompt-collapsed");
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    // A card whose pane is display:none (a chat switch parks it, a ResizeObserver
    // still fires) reports an all-zero rect. Read as "top = 0" that covers the
    // whole transcript, so the padding jumped to ~1300px, the composer scrolled
    // off the bottom and the pane's ancestor scrolled; it stuck until a reload.
    // An unmeasurable card leaves the last good padding alone.
    if (cardRect.width === 0 && cardRect.height === 0) return;
    // Only re-pin to bottom if the user was already there - otherwise typing
    // in the free-text box (which grows the card via ResizeObserver) yanks
    // someone who scrolled up to reread earlier messages back down every
    // keystroke.
    const wasNearBottom = isElNearBottom(target);
    // Measured as the card's overlap with the transcript, not its height: an
    // open question card sits over the composer too, so only the part above the
    // composer hides messages. A peek moves the card by transform, which the
    // rect already reflects, so a peeked card uncovers the latest messages
    // instead of leaving an empty band. Peeking is the permission card's, and
    // a question card's on the --viewport fallback host; the phone's
    // fullscreen question page has no handle.
    const covered = Math.max(0, target.getBoundingClientRect().bottom - cardRect.top);
    target.style.paddingBottom = `${covered + 12}px`;
    if (wasNearBottom) target.scrollTop = target.scrollHeight - target.clientHeight;
  };
  // A peek moves the card by transform, which no ResizeObserver sees.
  host.addEventListener(PEEK_SETTLED_EVENT, syncMessagesPadding);
  // Switching view in Settings changes which scroller shows; the card's own resize
  // observer fires on neither, so re-pad on the switch (after the pane's attribute flips).
  const onViewChanged = (): void => {
    queueMicrotask(syncMessagesPadding);
  };
  document.addEventListener(CHAT_VIEW_CHANGED, onViewChanged);

  // Moves the persistent track to the current activeTab. `instant` skips the
  // transition (full rebuild - a fresh node has no prior position to slide
  // from); the animated path is only for step-only nav on the SAME node.
  // `slideFrom` is for a full rebuild that still wants the slide (entering
  // review): the fresh track is parked at that panel first, then animated.
  function positionTrack(instant: boolean, slideFrom?: number): void {
    const track = host.querySelector<HTMLElement>(".prompt-track");
    if (!track) return;
    if (slideFrom !== undefined) {
      track.style.transition = "none";
      track.style.transform = `translateX(-${slideFrom * 100}%)`;
      void track.offsetHeight;
      track.style.transition = "";
      track.style.transform = `translateX(-${state.activeTab * 100}%)`;
    } else if (instant) {
      track.style.transition = "none";
      track.style.transform = `translateX(-${state.activeTab * 100}%)`;
      void track.offsetHeight;
      track.style.transition = "";
    } else {
      track.style.transform = `translateX(-${state.activeTab * 100}%)`;
    }
    const activePanel = track.querySelector<HTMLElement>(`.prompt-panel[data-panel="${state.activeTab}"]`);
    // getBoundingClientRect(), not offsetHeight: offsetHeight rounds to the
    // nearest integer pixel, and at a fractional DPI scale that rounding can
    // land under the panel's real height, clipping the last option's
    // bottom border against the viewport's overflow:clip.
    if (activePanel) track.style.height = `${activePanel.getBoundingClientRect().height}px`;

    // .prompt-track-viewport clips rather than scrolls vertically (see its CSS
    // doc comment), so a height snapshot going stale after this tick (webfont
    // swap-in, markdown reflow) cuts the last option's text off mid-line.
    // Keep it live while this panel stays active.
    state.panelResizeObs?.disconnect();
    if (activePanel && typeof ResizeObserver !== "undefined") {
      state.panelResizeObs = new ResizeObserver(() => {
        track.style.height = `${activePanel.getBoundingClientRect().height}px`;
      });
      state.panelResizeObs.observe(activePanel);
    }
  }

  // The scroller padded last may not be the one the card opened over (a view
  // switch moved the padding), and teardown only restores the opening one.
  const dispose = (): void => {
    document.removeEventListener(CHAT_VIEW_CHANGED, onViewChanged);
    if (padded) padded.style.paddingBottom = "";
  };

  return { showPasteHint, paintAttachmentStrips, syncMessagesPadding, positionTrack, dispose };
}
