// Card geometry and attachment-strip painting for the AUQ card: the sliding
// track's position/height, the chat-scroll padding that keeps the last message
// clear of the card, and the per-panel attachment strips. Split out of
// question-ui-render.ts, which keeps the render/event-wiring orchestration.

import { isElNearBottom } from "../../../shared/chat/chat-dom-renderer";
import type { AuqAttachmentsController } from "./attachments";
import { PEEK_SETTLED_EVENT, peekOffset } from "./drag-handle";
import type { QuestionRenderState } from "./question-ui-templates";

export interface QuestionCardLayout {
  showPasteHint: (bar: HTMLElement, message: string) => void;
  paintAttachmentStrips: () => void;
  syncMessagesPadding: () => void;
  positionTrack: (instant: boolean) => void;
}

export function createQuestionCardLayout(
  host: HTMLElement,
  state: QuestionRenderState,
  messagesEl: HTMLElement | null,
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

  const syncMessagesPadding = (): void => {
    if (!messagesEl) return;
    // Broadened to the minimized bar too - it replaces .prompt-card wholesale
    // rather than living inside it, so the old ".prompt-card"-only selector
    // would stop measuring anything once minimized.
    const card = host.querySelector<HTMLElement>(".prompt-card, .prompt-collapsed");
    if (!card) return;
    // Only re-pin to bottom if the user was already there - otherwise typing
    // in the free-text box (which grows the card via ResizeObserver) yanks
    // someone who scrolled up to reread earlier messages back down every
    // keystroke.
    const wasNearBottom = isElNearBottom(messagesEl);
    // Only the part of a peeked card still on screen covers the chat, so a
    // peek uncovers the latest messages instead of an empty band. Peeking is
    // the permission card's, and a question card's on the --viewport fallback
    // host; the phone's fullscreen question page has no handle.
    const covered = Math.max(0, card.offsetHeight - peekOffset(card));
    messagesEl.style.paddingBottom = `${covered + 12}px`;
    if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight;
  };
  // A peek moves the card by transform, which no ResizeObserver sees.
  host.addEventListener(PEEK_SETTLED_EVENT, syncMessagesPadding);

  // Moves the persistent track to the current activeTab. `instant` skips the
  // transition (full rebuild - a fresh node has no prior position to slide
  // from); the animated path is only for step-only nav on the SAME node.
  function positionTrack(instant: boolean): void {
    const track = host.querySelector<HTMLElement>(".prompt-track");
    if (!track) return;
    if (instant) {
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

  return { showPasteHint, paintAttachmentStrips, syncMessagesPadding, positionTrack };
}
