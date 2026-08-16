// The AUQ card's innerHTML-building render loop, split out of question-ui.ts
// (ai_todo 451) to match the directory's per-concern file split. Takes its
// dependencies explicitly instead of closing over question-ui.ts's scope.
// HTML builders live in question-ui-templates.ts (ai_todo 600) - this file
// keeps only the stateful render/event-wiring orchestration.

import { escapeHtml } from "../../../shared/escape-html";
import { isElNearBottom } from "../../../shared/chat/chat-dom-renderer";
import { renderCardShell } from "./host";
import {
  collapsedHtml, extraMessageZoneHtml, nextArrowDisabled, ownZoneHtml, pagerHtml,
  panelHtml, summaryPanelHtml,
} from "./question-ui-templates";
import type { QuestionRenderState } from "./question-ui-templates";
import type { AuqAttachmentsController } from "./attachments";
import type { AuqSlashPopupController } from "./slash-popup";
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
}

export function createQuestionCardRenderer(deps: QuestionRenderDeps): QuestionCardRenderer {
  const {
    host, opts, questions, hasSummary, totalPanels, noneLabel, selections, freeText,
    state, auqAttachments, slashPopup, messagesEl, answeredAt, answerPreview, submit,
    cancel, notifyDraftChange,
  } = deps;

  let minimized = false;
  let firstRender = true;
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
    messagesEl.style.paddingBottom = `${card.offsetHeight + 12}px`;
    if (wasNearBottom) messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight;
  };

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
    if (activePanel) track.style.height = `${activePanel.offsetHeight}px`;
  }

  // Single source for the footer's primary button: Next on any question
  // panel, Submit only on review (or on the lone question when there's no
  // review panel at all).
  function updatePrimaryButton(): void {
    const btn = host.querySelector<HTMLButtonElement>('[data-act="primary"]');
    if (!btn) return;
    const isSubmitMode = !hasSummary || state.activeTab === questions.length;
    btn.disabled = isSubmitMode
      ? !questions.every((_, i) => answeredAt(i))
      : nextArrowDisabled(state.activeTab, totalPanels, questions, answeredAt);
    btn.innerHTML = `<i class="ph ${isSubmitMode ? opts.submitIcon : "ph-caret-right"}"></i> ${escapeHtml(isSubmitMode ? opts.submitLabel : "Next")}`;
    btn.onclick = isSubmitMode ? submit : advance;
  }

  // Fills + wires the fixed answer bar for the active tab: one shared
  // textarea swapped on every tab change instead of one per panel, so the
  // input stays pinned below the scrolling content. Called by both render()
  // and the no-rebuild stepTab() path.
  function syncAnswerBar(): void {
    const bar = host.querySelector<HTMLElement>(".prompt-card__answer-bar");
    if (!bar) return;
    // Old textarea's popup/auto-resize core is about to be discarded along
    // with the DOM node below - drop its document-level listeners first.
    slashPopup.destroyAll();
    const isSummary = hasSummary && state.activeTab === questions.length;
    bar.innerHTML = isSummary
      ? (opts.supportsExtras ? extraMessageZoneHtml(state.additionalMessage) : "")
      : ownZoneHtml(state.activeTab, freeText);

    const otherEl = bar.querySelector<HTMLTextAreaElement>(".prompt-q__other-input, .prompt-extra-input");
    if (!otherEl) return;
    const highlightEl = otherEl.parentElement?.querySelector<HTMLElement>(".cc-typing-highlight") ?? null;
    slashPopup.attach(otherEl, highlightEl);

    if (isSummary) {
      otherEl.addEventListener("input", () => {
        state.additionalMessage = otherEl.value;
        syncMessagesPadding();
        notifyDraftChange();
      });
    } else {
      const qi = state.activeTab;
      otherEl.addEventListener("input", () => {
        freeText.set(qi, otherEl.value);
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
    // Always wired - handleAttachmentPaste itself decides and reports back.
    otherEl.addEventListener("paste", (e) => {
      void auqAttachments.handleAttachmentPaste(e).then((msg) => {
        if (msg) showPasteHint(bar, msg);
      });
    });
  }

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

  const render = () => {
    // The old textareas (and the popups anchored to them) are about to be
    // thrown away by the innerHTML rebuild below - drop the popups' own
    // document-level listeners explicitly first, since DOM removal alone
    // doesn't do that.
    slashPopup.destroyAll();
    state.activeTab = Math.min(Math.max(state.activeTab, 0), totalPanels - 1);

    if (minimized) {
      host.innerHTML = collapsedHtml(hasSummary, state.activeTab, questions, totalPanels);
      host.querySelector(".prompt-collapsed")?.addEventListener("click", () => { minimized = false; render(); });
    } else {
      // Reuses tool-views.ts's own class/icon/title so the live and historical
      // transcript cards show the identical diagnostic marker.
      const degradedBadge = opts.degradedBuiltin
        ? `<i class="ph-fill ph-flask-round question-card-degraded-badge" title="Answered via the disabled legacy AskUserQuestion path"></i>`
        : "";
      // Previously-dead QuestionUIOpts fields (ai_todo 646); rightChipHtml is
      // only set by permission-card.ts's flow, distinguishing it from MCP questions.
      const titleIcon = opts.titleIcon || "ph-chat-circle-dots";
      const titleText = opts.titleText || "Claude is asking";
      const titleHtml = `<span class="prompt-card__title"><i class="ph ${titleIcon}"></i>${escapeHtml(titleText)}</span>`;
      const headerHtml = `${titleHtml}${pagerHtml(totalPanels, hasSummary, questions, answeredAt, state.activeTab)}<span class="prompt-head__spacer"></span>${opts.rightChipHtml ?? ""}${degradedBadge}<button type="button" class="prompt-icon-btn" data-act="minimize" title="Minimize"><i class="ph ph-minus"></i></button>`;
      const panelsHtml = questions.map((q, qi) => panelHtml(q, qi, state.activeTab, selections, noneLabel, opts, auqAttachments)).join("")
        + (hasSummary ? summaryPanelHtml(questions, state.activeTab, answeredAt, answerPreview, opts, auqAttachments) : "");
      const footerHtml = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-primary" data-act="primary"></button>
      `;
      host.innerHTML = renderCardShell(headerHtml, `<div class="prompt-track-viewport"><div class="prompt-track">${panelsHtml}</div></div>`, footerHtml);

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
      host.querySelector<HTMLButtonElement>('[data-act="minimize"]')
        ?.addEventListener("click", () => { minimized = true; render(); });

      host.querySelectorAll<HTMLInputElement>(".prompt-q__opts input").forEach((input) => {
        input.addEventListener("change", () => {
          const qi = Number(input.closest<HTMLElement>(".prompt-panel")?.dataset.panel);
          const q = questions[qi];
          if (!q) return;
          const label = input.dataset.label ?? "";
          if (q.multiSelect) {
            const set = (selections.get(qi) as Set<string> | undefined) ?? new Set<string>();
            if (label === noneLabel) {
              // Exclusive: picking "None of the above" clears every other pick.
              set.clear();
              if (input.checked) set.add(noneLabel);
            } else if (input.checked) {
              set.delete(noneLabel);
              set.add(label);
            } else {
              set.delete(label);
            }
            selections.set(qi, set);
          } else if (input.checked) {
            selections.set(qi, label);
          }
          // Single-select: auto-advance to next unanswered panel.
          if (!q.multiSelect && questions.length > 1) {
            const next = questions.findIndex((_, i) => i !== qi && !answeredAt(i));
            if (next >= 0) state.activeTab = next;
          }
          render();
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

      host.querySelectorAll<HTMLElement>(".prompt-attachments").forEach((el) => auqAttachments.renderAttachmentsStrip(el));

      host.querySelector<HTMLButtonElement>('[data-act="cancel"]')
        ?.addEventListener("click", cancel);
      host.querySelectorAll<HTMLButtonElement>('[data-summary-tab]').forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.summaryTab);
          if (Number.isFinite(idx)) goToTab(idx);
        });
      });
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

  return { render, goToTab };
}
