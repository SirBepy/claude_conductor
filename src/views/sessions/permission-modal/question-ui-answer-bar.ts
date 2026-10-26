// The AUQ card's inline answer bar (footer, next to Skip/Next): fills and wires
// the shared textarea for the active tab. Split out of question-ui-render.ts.

import {
  extraMessageZoneHtml, nextArrowDisabled, ownZoneHtml,
} from "./question-ui-templates";
import type { QuestionRenderState } from "./question-ui-templates";
import type { AuqAttachmentsController } from "./attachments";
import type { AuqSlashPopupController } from "./slash-popup";
import type { Question, QuestionUIOpts } from "./types";
import { isMobileViewport } from "../../../shared/mobile-viewport";

export interface AnswerBarDeps {
  host: HTMLElement;
  opts: QuestionUIOpts;
  questions: Question[];
  hasSummary: boolean;
  totalPanels: number;
  freeText: Map<number, string>;
  state: QuestionRenderState;
  auqAttachments: AuqAttachmentsController;
  slashPopup: AuqSlashPopupController;
  answeredAt: (qi: number) => boolean;
  notifyDraftChange: () => void;
  syncMessagesPadding: () => void;
  showPasteHint: (bar: HTMLElement, message: string) => void;
  updatePrimaryButton: () => void;
}

// Fills + wires the inline answer bar for the active tab: one shared textarea
// swapped on every tab change instead of one per panel. Called by both
// render() and the no-rebuild stepTab() path.
export function createAnswerBarSync(deps: AnswerBarDeps): () => void {
  const {
    host, questions, hasSummary, totalPanels, freeText, state, auqAttachments,
    slashPopup, answeredAt, notifyDraftChange, syncMessagesPadding, showPasteHint,
    updatePrimaryButton,
  } = deps;

  return function syncAnswerBar(): void {
    const bar = host.querySelector<HTMLElement>(".prompt-card__answer-bar");
    if (!bar) return;
    // Old textarea's popup/auto-resize core is about to be discarded along
    // with the DOM node below - drop its document-level listeners first.
    slashPopup.destroyAll();
    const isSummary = hasSummary && state.activeTab === questions.length;
    // Exactly one text box on screen, always. A one-question
    // card has no review panel, so it shows only its own answer field - typed
    // prose there already rides along with the picked option (computeAnswer).
    // The phone's fullscreen question page (permission-modal-shell.css's
    // :has(.prompt-pager) scope, never the --viewport fallback host).
    const page = isMobileViewport() && !host.classList.contains("prompt-card-host--viewport");
    // Review keeps the footer to the one Submit button (Joe, 2026-10-26): its
    // optional message lives in the panel, under the last answer, behind an
    // "Add a note" row until tapped or already holding text.
    const noteSlot = isSummary
      ? host.querySelector<HTMLElement>(`.prompt-panel[data-panel="${questions.length}"] .prompt-summary__note`)
      : null;
    bar.innerHTML = isSummary ? "" : ownZoneHtml(state.activeTab, freeText, page);
    if (noteSlot) {
      const open = state.reviewNoteOpen || state.additionalMessage.trim() !== "";
      noteSlot.innerHTML = open
        ? extraMessageZoneHtml(state.additionalMessage, false)
        : `<button type="button" class="prompt-summary__add-note" data-act="add-note"><i class="ph ph-plus"></i>Add a note</button>`;
      noteSlot.querySelector('[data-act="add-note"]')?.addEventListener("click", () => {
        state.reviewNoteOpen = true;
        syncAnswerBar();
        syncMessagesPadding();
        noteSlot.querySelector<HTMLTextAreaElement>(".prompt-extra-input")?.focus();
      });
    }
    const fieldHost = noteSlot ?? bar;
    // One way forward per step: on desktop the footer's Next/Submit is it, so
    // the answer box drops its own send arrow (Joe, 2026-10-26: an arrow AND
    // a Next read as two different actions), and the review note never had a
    // send of its own to offer.
    if (!page || noteSlot) fieldHost.querySelector(".prompt-answer-send")?.remove();
    // On the phone page the footer buttons are hidden (permission-modal-
    // shell.css), so the arrow IS Next/Submit, mirroring the primary's label
    // and disabled state so it never looks live while the click would do
    // nothing.
    const sendBtn = fieldHost.querySelector<HTMLButtonElement>(".prompt-answer-send");
    const primary = (): HTMLButtonElement | null =>
      host.querySelector<HTMLButtonElement>('.prompt-card__footer [data-act="primary"]');
    sendBtn?.addEventListener("click", () => primary()?.click());
    sendBtn?.classList.toggle("is-submit", isSummary || !hasSummary);
    const syncSend = (): void => {
      if (!sendBtn) return;
      const p = primary();
      sendBtn.disabled = !!p?.disabled;
      const label = p?.textContent?.trim();
      if (label) sendBtn.title = label;
    };

    const wireField = (el: HTMLTextAreaElement, isExtraField: boolean): void => {
      syncSend();
      const highlightEl = el.parentElement?.querySelector<HTMLElement>(".composer-highlight") ?? null;
      // Enter is the footer button's keyboard twin. Off the phone page it
      // waits for typed text, so a stray Enter in an empty box never advances.
      slashPopup.attach(el, highlightEl, () => {
        const p = primary();
        if (p && !p.disabled && (page || el.value.trim() !== "")) p.click();
      });
      if (isExtraField) {
        el.addEventListener("input", () => {
          state.additionalMessage = el.value;
          syncMessagesPadding();
          notifyDraftChange();
        });
      } else {
        const qi = state.activeTab;
        el.addEventListener("input", () => {
          freeText.set(qi, el.value);
          host.querySelector<HTMLElement>(`.prompt-dot[data-dot="${qi}"]`)
            ?.classList.toggle("is-answered", answeredAt(qi));
          if (hasSummary) {
            const allAnsweredNow = questions.every((_, i) => answeredAt(i));
            host.querySelector<HTMLElement>(`.prompt-dot[data-dot="${questions.length}"]`)
              ?.classList.toggle("is-answered", allAnsweredNow);
          }
          const nextArrow = host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="1"]');
          if (nextArrow) nextArrow.disabled = nextArrowDisabled(state.activeTab, totalPanels, questions, answeredAt);
          updatePrimaryButton();
          syncMessagesPadding();
          notifyDraftChange();
        });
      }
      // After the handlers above, so it reads the primary button's state
      // updatePrimaryButton just set for this keystroke.
      el.addEventListener("input", () => syncSend());
      // Always wired - handleAttachmentPaste itself decides and reports back.
      el.addEventListener("paste", (e) => {
        void auqAttachments.handleAttachmentPaste(e).then((msg) => {
          if (msg) showPasteHint(fieldHost, msg);
        });
      });
    };

    const ownEl = bar.querySelector<HTMLTextAreaElement>(".prompt-q__other-input");
    const extraEl = noteSlot?.querySelector<HTMLTextAreaElement>(".prompt-extra-input") ?? null;
    if (ownEl) wireField(ownEl, false);
    if (extraEl) wireField(extraEl, true);
  };
}
