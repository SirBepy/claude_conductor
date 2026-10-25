// The AUQ card's innerHTML-building render loop, split out of question-ui.ts
// (ai_todo 451) to match the directory's per-concern file split. Takes its
// dependencies explicitly instead of closing over question-ui.ts's scope.
// HTML builders live in question-ui-templates.ts (ai_todo 600) - this file
// keeps only the stateful render/event-wiring orchestration.

import { escapeHtml } from "../../../shared/escape-html";
import { handleTicketHover, handleTicketHoverOut, linkifyTickets } from "../../../shared/chat/ticket-refs";
import { renderCardShell } from "./host";
import {
  collapsedHtml, nextArrowDisabled, pagerHtml, panelHtml, summaryPanelHtml,
} from "./question-ui-templates";
import type { QuestionRenderState } from "./question-ui-templates";
import { focusActivePanel } from "./question-keyboard";
import { createAnswerBarSync } from "./question-ui-answer-bar";
import { createQuestionCardLayout } from "./question-ui-layout";
import { attachQuestionSwipe } from "./question-swipe";
import { attachOptionPreviews } from "./option-previews";
import { createPreviewFullscreen } from "./preview-fullscreen";
import type { AuqAttachmentsController } from "./attachments";
import type { AuqSlashPopupController } from "./slash-popup";
import { ASK_OPEN_EVENT, askContextText } from "../ask-open-event";
import type { Question, QuestionUIOpts, Selection } from "./types";

export type { QuestionRenderState };

export interface QuestionRenderDeps {
  host: HTMLElement;
  opts: QuestionUIOpts;
  questions: Question[];
  hasSummary: boolean;
  totalPanels: number;
  noneLabel: string;
  selections: Map<number, Selection>;
  freeText: Map<number, string>;
  state: QuestionRenderState;
  auqAttachments: AuqAttachmentsController;
  slashPopup: AuqSlashPopupController;
  messagesEl: HTMLElement | null;
  answeredAt: (qi: number) => boolean;
  answerPreview: (qi: number) => string;
  submit: () => void;
  cancel: () => void;
  notifyDraftChange: () => void;
}

export interface QuestionCardRenderer {
  render: () => void;
  goToTab: (target: number) => void;
  togglePick: (qi: number, label: string) => void;
  /** Patches just the attachments strip in place - for a paste-driven attach
   *  while the free-text field is focused, where a full render() would
   *  recreate that (still-focused) textarea and drop focus/cursor mid-paste. */
  refreshAttachments: () => void;
  /** Collapses the card to its bar. Returns false when it already was one,
   *  so a back press can fall through to the next handler. */
  minimize: () => boolean;
  /** Rebuilds the answer bar for the other side of the 768px breakpoint. */
  onViewportCrossing: () => void;
  /** Card teardown: drops the fullscreen preview, which lives outside the host. */
  dispose: () => void;
}

export function createQuestionCardRenderer(deps: QuestionRenderDeps): QuestionCardRenderer {
  const {
    host, opts, questions, hasSummary, totalPanels, noneLabel, selections, freeText,
    state, auqAttachments, slashPopup, messagesEl, answeredAt, answerPreview, submit,
    cancel, notifyDraftChange,
  } = deps;

  let minimized = false;
  let firstRender = true;
  // Same ticket links + hover cards as a chat bubble. Delegated on the host,
  // which outlives every innerHTML rebuild; same function refs dedupe when a
  // later card reuses the host.
  host.addEventListener("mouseover", handleTicketHover);
  host.addEventListener("mouseout", handleTicketHoverOut);
  attachQuestionSwipe(host, state, goToTab);
  // Picks from fullscreen skip applyPick's auto-advance: the fullscreen view
  // moves on itself, to the NEXT question rather than the next unanswered one.
  const fullscreen = createPreviewFullscreen({
    questions, selections, hasSummary, sessionId: opts.sessionId, answeredAt,
    pick: (qi, label) => applyPick(qi, label, true, false),
    toggle: (qi, label) => {
      const set = selections.get(qi) as Set<string> | undefined;
      applyPick(qi, label, !set?.has(label), false);
    },
    goToTab: (target) => goToTab(target),
  });
  // "Choose this" on a preview stage picks exactly like tapping the row.
  const previews = attachOptionPreviews({
    host, questions, selections, choose: (qi, label) => applyPick(qi, label, true, true),
    expand: (qi, label) => fullscreen.open(qi, label),
    sessionId: opts.sessionId,
  });
  const { showPasteHint, paintAttachmentStrips, syncMessagesPadding, positionTrack } =
    createQuestionCardLayout(host, state, messagesEl, auqAttachments);

  // Single source for the footer's primary button: Next on any question
  // panel, Submit only on review (or on the lone question when there's no
  // review panel at all).
  function updatePrimaryButton(): void {
    const btn = host.querySelector<HTMLButtonElement>('[data-act="primary"]');
    if (!btn) return;
    const isSubmitMode = !hasSummary || state.activeTab === questions.length;
    // Unlike Next (which still requires the current question answered before
    // advancing), Submit is never blocked - an unanswered question becomes
    // NO_ANSWER_TEXT in the payload rather than silently vanishing.
    btn.disabled = isSubmitMode
      ? false
      : nextArrowDisabled(state.activeTab, totalPanels, questions, answeredAt);
    btn.innerHTML = `<i class="ph ${isSubmitMode ? opts.submitIcon : "ph-caret-right"}"></i> ${escapeHtml(isSubmitMode ? opts.submitLabel : "Next")}`;
    btn.onclick = isSubmitMode ? submit : advance;
  }

  const syncAnswerBar = createAnswerBarSync({
    host, opts, questions, hasSummary, totalPanels, freeText, state, auqAttachments,
    slashPopup, answeredAt, notifyDraftChange, syncMessagesPadding, showPasteHint,
    updatePrimaryButton,
  });

  // Step-only nav: patches the track/dots/arrows/footer in place instead of
  // rebuilding host.innerHTML, so .prompt-track's transition has a real "from"
  // position to slide from. Only for moves that don't change any panel's
  // rendered content - see goToTab.
  function stepTab(prevTab: number): void {
    positionTrack(false);
    host.querySelector(`.prompt-panel[data-panel="${prevTab}"]`)?.classList.remove("is-active");
    host.querySelector(`.prompt-panel[data-panel="${state.activeTab}"]`)?.classList.add("is-active");
    host.querySelectorAll<HTMLElement>(".prompt-dot").forEach((dot) => {
      dot.classList.toggle("is-current", Number(dot.dataset.dot) === state.activeTab);
    });
    const prevArrow = host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="-1"]');
    if (prevArrow) prevArrow.disabled = state.activeTab === 0;
    const nextArrow = host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="1"]');
    if (nextArrow) nextArrow.disabled = nextArrowDisabled(state.activeTab, totalPanels, questions, answeredAt);
    updatePrimaryButton();
    syncAnswerBar();
    syncMessagesPadding();
    notifyDraftChange();
  }

  // All nav funnels through here so review - whose panel summarizes live
  // answers - always gets a full rebuild on entry, never the no-rebuild slide
  // path (which would show whatever it looked like at the last full render).
  function goToTab(target: number): void {
    const clamped = Math.min(Math.max(target, 0), totalPanels - 1);
    if (clamped === state.activeTab) return;
    if (hasSummary && clamped === questions.length) {
      state.activeTab = clamped;
      render();
      return;
    }
    const prevTab = state.activeTab;
    state.activeTab = clamped;
    stepTab(prevTab);
  }

  const advance = () => goToTab(state.activeTab + 1);

  function applyPick(qi: number, label: string, checked: boolean, autoAdvance: boolean): void {
    const q = questions[qi];
    if (!q) return;
    if (q.multiSelect) {
      const set = (selections.get(qi) as Set<string> | undefined) ?? new Set<string>();
      if (label === noneLabel) {
        // Exclusive: picking "None of the above" clears every other pick.
        set.clear();
        if (checked) set.add(noneLabel);
      } else if (checked) {
        set.delete(noneLabel);
        set.add(label);
      } else {
        set.delete(label);
      }
      selections.set(qi, set);
    } else if (checked) {
      selections.set(qi, label);
    }
    // Single-select: auto-advance to next unanswered panel.
    if (autoAdvance && !q.multiSelect && questions.length > 1) {
      const next = questions.findIndex((_, i) => i !== qi && !answeredAt(i));
      if (next >= 0) state.activeTab = next;
    }
    render();
  }

  // Keyboard Space: same selection rules as a click, minus the single-select
  // auto-advance, and re-picking the current single-select answer clears it
  // like a re-click does.
  function togglePick(qi: number, label: string): void {
    const q = questions[qi];
    if (!q) return;
    if (q.multiSelect) {
      const set = selections.get(qi) as Set<string> | undefined;
      applyPick(qi, label, !set?.has(label), false);
    } else if (selections.get(qi) === label) {
      selections.delete(qi);
      render();
    } else {
      applyPick(qi, label, true, false);
    }
  }

  const render = () => {
    // The old textareas (and the popups anchored to them) are about to be
    // thrown away by the innerHTML rebuild below - drop the popups' own
    // document-level listeners explicitly first, since DOM removal alone
    // doesn't do that.
    slashPopup.destroyAll();
    state.activeTab = Math.min(Math.max(state.activeTab, 0), totalPanels - 1);
    // The rebuild destroys a focused option, which would drop keyboard
    // navigation back to <body> after every pick.
    const prevFocus = document.activeElement;
    const focusedOption = prevFocus instanceof HTMLInputElement && host.contains(prevFocus) && prevFocus.closest(".prompt-q__opts")
      ? { qi: Number(prevFocus.closest<HTMLElement>(".prompt-panel")?.dataset.panel), label: prevFocus.dataset.label }
      : null;

    if (minimized) {
      host.innerHTML = collapsedHtml(hasSummary, state.activeTab, questions, totalPanels);
      host.querySelector(".prompt-collapsed")?.addEventListener("click", () => { minimized = false; render(); });
    } else {
      // ph-flask-round is not a Phosphor 2.1.1 name, so this painted nothing
      // until 2026-08-22 (ai_todo 737).
      const degradedBadge = opts.degradedBuiltin
        ? `<i class="ph-fill ph-flask question-card-degraded-badge" title="Answered via the disabled legacy AskUserQuestion path"></i>`
        : "";
      // Not a NEW duplicate - an older question for this same chat was left
      // open (the model moved on, then circled back to it) and had no way to
      // say so until now.
      const olderPendingBadge = opts.hasOlderPending
        ? `<i class="ph-fill ph-clock-counter-clockwise question-card-degraded-badge" title="An earlier question in this chat is still open too - this one isn't a repeat of what you just answered"></i>`
        : "";
      // Overrides the caller's icon rather than relying on that 0.45-opacity
      // badge: unplugged glyph = this card did not come from the MCP tool.
      const titleIcon = opts.degradedBuiltin ? "ph-plugs" : (opts.titleIcon || "ph-chat-circle-dots");
      // The back arrow and the "Question" label only show on the phone's
      // fullscreen page (permission-modal-shell.css); desktop keeps the icon.
      const titleHtml = `<button type="button" class="icon-btn-sq prompt-icon-btn prompt-card__back" data-act="back" title="Back to chat"><i class="ph ph-arrow-left"></i></button><span class="prompt-card__title"><i class="ph ${titleIcon}"></i><span class="prompt-card__title-text">Question</span></span>`;
      const headerHtml = `${titleHtml}${pagerHtml(totalPanels, hasSummary, questions, answeredAt, state.activeTab)}<span class="prompt-head__spacer"></span>${opts.rightChipHtml ?? ""}${olderPendingBadge}${degradedBadge}<button type="button" class="icon-btn-sq prompt-icon-btn" data-act="ask" title="Ask about this question"><i class="ph ph-chat-teardrop-dots"></i></button><button type="button" class="icon-btn-sq prompt-icon-btn" data-act="minimize" title="Minimize"><i class="ph ph-minus"></i></button>`;
      const panelsHtml = questions.map((q, qi) => panelHtml(q, qi, state.activeTab, selections, noneLabel, opts)).join("")
        + (hasSummary ? summaryPanelHtml(questions, state.activeTab, answeredAt, answerPreview, opts, auqAttachments) : "");
      const footerHtml = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-primary" data-act="primary"></button>
      `;
      host.innerHTML = renderCardShell(headerHtml, `<div class="prompt-track-viewport"><div class="prompt-track">${panelsHtml}</div></div>`, footerHtml);

      void linkifyTickets(host, opts.cwd ?? undefined);

      const card = host.querySelector<HTMLElement>(".prompt-card");
      if (!firstRender) card?.classList.add("prompt-card--no-anim");

      // Flex's auto cross-size is the TALLEST sibling panel's height, so a
      // 2-option question next to a long one rendered as tall as the long
      // one - positionTrack pins the track's height to just the active
      // panel's own content instead.
      positionTrack(true);
      updatePrimaryButton();

      host.querySelectorAll<HTMLButtonElement>(".prompt-dot").forEach((dot) => {
        dot.addEventListener("click", () => {
          const idx = Number(dot.dataset.dot);
          if (Number.isFinite(idx)) goToTab(idx);
        });
      });
      host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="-1"]')
        ?.addEventListener("click", () => goToTab(state.activeTab - 1));
      host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="1"]')
        ?.addEventListener("click", advance);
      // Only announces; the card is left exactly as it is, so a half-typed
      // answer and the pending prompt survive the detour.
      host.querySelector<HTMLButtonElement>('[data-act="ask"]')?.addEventListener("click", () => {
        const q = questions[Math.min(state.activeTab, questions.length - 1)];
        if (q) window.dispatchEvent(new CustomEvent(ASK_OPEN_EVENT, { detail: { text: askContextText(q) } }));
      });
      host.querySelectorAll<HTMLButtonElement>('[data-act="minimize"], [data-act="back"]')
        .forEach((btn) => btn.addEventListener("click", () => { minimize(); }));

      host.querySelectorAll<HTMLInputElement>(".prompt-q__opts input").forEach((input) => {
        input.addEventListener("change", () => {
          const qi = Number(input.closest<HTMLElement>(".prompt-panel")?.dataset.panel);
          applyPick(qi, input.dataset.label ?? "", input.checked, true);
        });
      });

      // Radios don't fire "change" when re-clicking the option that's already
      // checked (no state change to report), so re-selecting the current answer
      // is a native no-op. Listen on "click" instead to detect that specific
      // case and clear the answer, letting a re-click deselect it.
      host.querySelectorAll<HTMLInputElement>('.prompt-q__opts input[type="radio"]').forEach((input) => {
        input.addEventListener("click", () => {
          const qi = Number(input.closest<HTMLElement>(".prompt-panel")?.dataset.panel);
          const label = input.dataset.label ?? "";
          if (selections.get(qi) !== label) return;
          selections.delete(qi);
          render();
        });
      });

      syncAnswerBar();

      paintAttachmentStrips();
      previews.sync();
      fullscreen.sync();

      host.querySelector<HTMLButtonElement>('[data-act="cancel"]')
        ?.addEventListener("click", cancel);
      host.querySelectorAll<HTMLButtonElement>('[data-summary-tab]').forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.summaryTab);
          if (Number.isFinite(idx)) goToTab(idx);
        });
      });

      if (focusedOption) {
        const same = focusedOption.qi === state.activeTab
          ? Array.from(host.querySelectorAll<HTMLInputElement>(`.prompt-panel[data-panel="${state.activeTab}"] .prompt-q__opts input`))
            .find((el) => el.dataset.label === focusedOption.label)
          : undefined;
        if (same) same.focus();
        else focusActivePanel(host, state.activeTab, hasSummary && state.activeTab === questions.length);
      }
    }
    firstRender = false;

    requestAnimationFrame(() => syncMessagesPadding());
    if (!state.resizeObs && messagesEl && typeof ResizeObserver !== "undefined") {
      const cardEl = host.querySelector<HTMLElement>(".prompt-card, .prompt-collapsed");
      if (cardEl) {
        state.resizeObs = new ResizeObserver(() => syncMessagesPadding());
        state.resizeObs.observe(cardEl);
      }
    }
    notifyDraftChange();
  };

  const refreshAttachments = (): void => {
    paintAttachmentStrips();
    syncMessagesPadding();
  };

  function minimize(): boolean {
    // The phone's back press lands here: it leaves fullscreen first.
    if (fullscreen.isOpen()) { fullscreen.close(); return true; }
    if (minimized) return false;
    minimized = true;
    render();
    return true;
  }

  // The answer bar's markup is picked from the viewport when it is built, so a
  // 768px crossing with the card open rebuilds it. The typed text survives in
  // freeText / state.additionalMessage; focus and caret are carried by hand.
  const onViewportCrossing = (): void => {
    const bar = host.querySelector<HTMLElement>(".prompt-card__answer-bar");
    if (!bar) return;
    const focused = document.activeElement;
    const caret = focused instanceof HTMLTextAreaElement && bar.contains(focused)
      ? [focused.selectionStart, focused.selectionEnd] as const
      : null;
    syncAnswerBar();
    paintAttachmentStrips();
    syncMessagesPadding();
    if (!caret) return;
    const field = bar.querySelector<HTMLTextAreaElement>("textarea");
    if (!field) return;
    field.focus();
    field.setSelectionRange(caret[0], caret[1]);
  };

  return { render, goToTab, togglePick, refreshAttachments, minimize, onViewportCrossing, dispose: fullscreen.close };
}
