import { escapeHtml } from "../../../shared/escape-html";
import { registerOverlayBack } from "../../../shared/back-button";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import { clearHost, ensureHost, renderCardShell } from "./host";
import { createAuqAttachments } from "./attachments";
import { createAuqSlashPopup } from "./slash-popup";
import { LIGHTBOX_OVERLAY_CLASS } from "../../../shared/chat/lightbox";
import { isElNearBottom } from "../../../shared/chat/chat-dom-renderer";
import type { Answers, OptionBadge, Question, QuestionDomain, QuestionDraft, QuestionUIOpts, Selection } from "./types";
import {
  isQuestionAnswered,
  computeAnswer,
  splitAsk,
  setActiveCard,
  clearActiveCardIfCurrent,
} from "./question-state";

// Payload normalization, the active-card draft registry, the pure
// answer-completeness check, and the pure question-text helpers now live in
// ./question-state.ts; re-exported here so existing importers of this file
// keep working unchanged.
export { isQuestionAnswered, computeAnswer, formatAnswersAsMessage, extractQuestions, dismissQuestionCard, snapshotActiveCardDraft, splitAsk, questionTextHtml } from "./question-state";

// Synthetic option appended to every multiSelect question so "nothing
// applies" is an explicit, selectable answer instead of an implicit
// zero-selections state - lets isQuestionAnswered require a real choice
// (checkbox or free text) instead of treating an untouched question as done.
const NONE_LABEL = "None of the above";

const DOMAIN_META: Record<QuestionDomain, { icon: string; label: string }> = {
  ux: { icon: "ph-fill ph-paint-brush-broad", label: "User experience" },
  arch: { icon: "ph-fill ph-blueprint", label: "Architecture" },
  sec: { icon: "ph-fill ph-shield-check", label: "Security" },
  data: { icon: "ph-fill ph-database", label: "Data" },
  tooling: { icon: "ph-fill ph-wrench", label: "Tooling" },
  infra: { icon: "ph-fill ph-stack", label: "Infrastructure" },
  billing: { icon: "ph-fill ph-currency-circle-dollar", label: "Billing" },
};

const BADGE_META: Record<OptionBadge, { cls: string; icon: string; label: string }> = {
  recommended: { cls: "rec", icon: "ph-fill ph-star", label: "Recommended" },
  long_term: { cls: "long", icon: "ph-fill ph-tree", label: "Long-term best" },
  short_term: { cls: "short", icon: "ph-fill ph-lightning", label: "Short-term best" },
};

export function renderQuestionUI(opts: QuestionUIOpts): void {
  const { host } = ensureHost();
  const questions: Question[] = opts.questions.map((q) => {
    if (!q.multiSelect || !q.options?.length) return q;
    if (q.options.some((o) => o.label === NONE_LABEL)) return q;
    return { ...q, options: [...q.options, { label: NONE_LABEL }] };
  });

  // The recap/review step is only worth a panel when there's something to
  // review across multiple questions, or extras (message/attachments) to add -
  // a single bare question goes straight from its own panel to Submit.
  const hasSummary = Boolean(opts.supportsExtras) || questions.length > 1;
  const totalPanels = questions.length + (hasSummary ? 1 : 0);

  const selections = new Map<number, Selection>();
  const freeText = new Map<number, string>();
  if (opts.initialDraft) {
    opts.initialDraft.freeText.forEach((v, k) => freeText.set(k, v));
    opts.initialDraft.selections.forEach((v, k) => {
      selections.set(k, v instanceof Set ? new Set(v) : v);
    });
  }
  questions.forEach((q, i) => {
    if (q.multiSelect && !selections.has(i)) selections.set(i, new Set<string>());
  });

  // Review-step extra message + pasted-image attachments. Only ever populated
  // when opts.supportsExtras (the async MCP flow) - see QuestionUIOpts doc.
  let additionalMessage = opts.initialDraft?.additionalMessage ?? "";
  const auqAttachments = createAuqAttachments({
    sessionId: opts.sessionId,
    supportsExtras: opts.supportsExtras,
    initial: opts.initialDraft?.attachments,
    onChange: () => render(),
  });

  // "/" skill-suggestion popup + highlight backdrop - the same shared core
  // the composer uses (ai_todo 439), not a reimplementation.
  const slashPopup = createAuqSlashPopup(opts.cwd);

  const messagesEl = document.querySelector<HTMLElement>(".session-messages");
  const savedScrollTop = messagesEl?.scrollTop ?? 0;
  const savedPaddingBottom = messagesEl?.style.paddingBottom ?? "";
  let resizeObs: ResizeObserver | null = null;
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

  // Phone back button skips the question (same as Escape / the Skip button) so
  // the card never traps the user, and the prompt resolves rather than silently
  // hiding. Registered below once `cancel` exists; disposed on teardown.
  let backDisposer: (() => void) | null = null;

  let minimized = false;
  let activeTab = Math.min(Math.max(opts.initialDraft?.activeTab ?? 0, 0), totalPanels - 1);
  let firstRender = true;

  // Declared and wired BEFORE `teardown` (which closes over it) so there is no
  // forward reference in either direction - teardown used to be handed to
  // setActiveCard while keydownHandler was still ~70 lines below it in the
  // temporal dead zone, safe today only because nothing calls teardown
  // synchronously during setup.
  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      dismissUnlessOverlayAbove();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      triggerPrimaryShortcut();
    }
  };
  document.addEventListener("keydown", keydownHandler);

  const teardown = () => {
    backDisposer?.();
    backDisposer = null;
    slashPopup.destroyAll();
    slashPopup.stop();
    clearHost();
    document.removeEventListener("keydown", keydownHandler);
    if (resizeObs) { try { resizeObs.disconnect(); } catch { /* ignore */ } resizeObs = null; }
    if (messagesEl) {
      messagesEl.style.paddingBottom = savedPaddingBottom;
      messagesEl.scrollTop = savedScrollTop;
    }
    clearActiveCardIfCurrent(teardown);
  };
  const currentDraft = (): QuestionDraft => ({
    freeText: new Map(freeText),
    selections: new Map(
      Array.from(selections.entries()).map(([k, v]) => [k, v instanceof Set ? new Set(v) : v])
    ),
    activeTab,
    additionalMessage,
    attachments: [...auqAttachments.attachments],
  });
  if (opts.id) {
    setActiveCard({
      id: opts.id,
      sessionId: opts.sessionId,
      teardown,
      getDraft: currentDraft,
    });
  }

  // Per-question answer, normalized: multiSelect -> string[] (possibly empty,
  // always present), single-select/free-text -> string, string[] (pick +
  // typed combined), or null if unanswered. See computeAnswer for the rule.
  const answerFor = (qi: number): string | string[] | null =>
    computeAnswer(questions[qi], freeText.get(qi) ?? "", selections.get(qi));

  const submit = () => {
    const answers: Answers = {};
    questions.forEach((q, i) => {
      const a = answerFor(i);
      if (q.multiSelect) {
        answers[q.question] = a as string[];
      } else if (a != null) {
        answers[q.question] = a;
      }
    });
    teardown();
    void opts.onSubmit(answers, { additionalMessage: additionalMessage.trim(), attachments: [...auqAttachments.attachments] });
  };

  const cancel = () => {
    teardown();
    void opts.onCancel();
  };

  // A lightbox on top of this card has no overlay registration of its own,
  // so without this check Escape/back would also cancel the card - sending
  // NO answer at all (onCancel), unrecoverable for a keypress meant for the
  // image. One guarded path here so both dismiss triggers stay in sync.
  const dismissUnlessOverlayAbove = () => {
    if (document.querySelector(`.${LIGHTBOX_OVERLAY_CLASS}`)) return;
    cancel();
  };

  backDisposer = registerOverlayBack(() => {
    // Always consumes the press (returns true) even when it no-ops - with the
    // lightbox unregistered, falling through (false) would step the
    // view-navigation stack instead, an even bigger surprise than a no-op.
    dismissUnlessOverlayAbove();
    return true;
  });

  const answeredAt = (qi: number): boolean =>
    isQuestionAnswered(questions[qi], freeText.get(qi) ?? "", selections.get(qi));

  const answerPreview = (qi: number): string => {
    const a = answerFor(qi);
    if (Array.isArray(a)) return a.length ? a.join(", ") : "Not answered";
    return typeof a === "string" && a ? a : "Not answered";
  };

  // Ctrl/Cmd+Enter never skips review: it submits only from the review panel,
  // or when there is no review panel at all (single bare question).
  const triggerPrimaryShortcut = () => {
    if (!hasSummary) {
      if (answeredAt(0)) submit();
      return;
    }
    if (activeTab === questions.length) { submit(); return; }
    if (!answeredAt(activeTab)) return;
    const next = questions.findIndex((_, i) => !answeredAt(i));
    goToTab(next >= 0 ? next : questions.length);
  };

  function domainVar(domain?: QuestionDomain): string {
    return domain ? `var(--color-domain-${domain})` : "var(--color-primary)";
  }

  function domainChipHtml(domain?: QuestionDomain): string {
    if (!domain) return "";
    const meta = DOMAIN_META[domain];
    return `<span class="prompt-domain"><i class="${meta.icon}"></i>${meta.label}</span>`;
  }

  function badgesHtml(badges?: OptionBadge[]): string {
    if (!badges?.length) return "";
    const chips = badges.map((b) => {
      const m = BADGE_META[b];
      return `<span class="prompt-badge prompt-badge--${m.cls}"><i class="${m.icon}"></i>${m.label}</span>`;
    }).join("");
    return `<span class="prompt-badges">${chips}</span>`;
  }

  // Zones 1+2: splitAsk() already separates the leading context from the
  // final ask - zone 1 (dimmed context + domain chip) is omitted entirely
  // when there's no separate ask to highlight.
  function questionZonesHtml(q: Question): string {
    const { context, ask } = splitAsk(q.question);
    const ctxZone = context
      ? `<div class="prompt-zone prompt-zone--ctx">
          <span class="prompt-ctx__rail"><i class="ph ph-info"></i></span>
          <span class="prompt-ctx__body">
            <span class="prompt-ctx__head">
              <span class="prompt-ctx__label">Context</span>${domainChipHtml(q.domain)}
            </span>
            <div class="prompt-ctx__text prompt-q__context">${renderMarkdown(context)}</div>
          </span>
        </div>`
      : "";
    return `
      ${ctxZone}
      <div class="prompt-zone prompt-zone--ask">
        <i class="ph-fill ph-question prompt-ask__icon"></i>
        <div class="prompt-ask__text prompt-q__text">${renderMarkdown(ask)}</div>
      </div>
    `;
  }

  function optsRowsHtml(q: Question, qi: number): string {
    return (q.options ?? []).map((opt) => {
      const selected = q.multiSelect
        ? (selections.get(qi) as Set<string> | undefined)?.has(opt.label) ?? false
        : selections.get(qi) === opt.label;
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const desc = opt.description
        ? `<div class="prompt-opt__desc">${renderMarkdown(opt.description)}</div>`
        : "";
      const isNone = q.multiSelect && opt.label === NONE_LABEL;
      return `
        <label class="prompt-opt${selected ? " is-selected" : ""}${isNone ? " prompt-opt--none" : ""}">
          <input type="${inputType}" name="q-${qi}" data-label="${escapeHtml(opt.label)}" ${selected ? "checked" : ""} />
          <span class="prompt-opt__body">
            <span class="prompt-opt__top"><span class="prompt-opt__label">${escapeHtml(opt.label)}</span>${badgesHtml(opt.badges)}</span>
            ${desc}
          </span>
        </label>
      `;
    }).join("");
  }

  // The per-question free-text field keeps its `.prompt-q__other` wrapper
  // (unstyled by the new design) because slash-popup.ts anchors on
  // `ta.closest(".prompt-q__other")` and is not this task's file to touch.
  function ownZoneHtml(qi: number): string {
    const typedValue = freeText.get(qi) ?? "";
    return `
      <div class="prompt-sect"><i class="ph ph-pencil-simple"></i><span class="prompt-sect__label">Or answer in your own words</span><span class="prompt-sect__rule"></span></div>
      <div class="prompt-own">
        <label class="prompt-q__other">
          <div class="cc-typing-wrap">
            <div class="cc-typing-highlight cc-typing-highlight--auq" aria-hidden="true"></div>
            <textarea class="prompt-q__other-input cc-typing-input" rows="1" placeholder="Type your own answer...">${escapeHtml(typedValue)}</textarea>
          </div>
        </label>
      </div>
    `;
  }

  // Every panel renders its real content always (never virtualized) - the
  // horizontal track must show real questions on a drag/swipe, not blanks.
  // `.is-active` marks the current one for tests and active-only logic.
  function panelHtml(q: Question, qi: number): string {
    const isActive = qi === activeTab;
    const pickSect = q.options?.length
      ? `<div class="prompt-sect"><i class="ph ph-list-checks"></i><span class="prompt-sect__label">${q.multiSelect ? "Select all that apply" : "Pick one"}</span><span class="prompt-sect__rule"></span></div>
         <div class="prompt-q__opts">${optsRowsHtml(q, qi)}</div>`
      : "";
    const attachHtml = opts.supportsExtras && auqAttachments.attachments.length
      ? `<div class="prompt-attachments composer-attachments"></div>`
      : "";
    return `
      <section class="prompt-panel${isActive ? " is-active" : ""}" data-panel="${qi}" style="--dom:${domainVar(q.domain)}">
        ${questionZonesHtml(q)}
        ${pickSect}
        ${ownZoneHtml(qi)}
        ${attachHtml}
      </section>
    `;
  }

  function summaryPanelHtml(): string {
    const isActive = activeTab === questions.length;
    const rows = questions.map((sq, qi) => {
      const label = sq.header?.trim() || `Question ${qi + 1}`;
      const answered = answeredAt(qi);
      return `
        <button type="button" class="prompt-summary-row${answered ? "" : " is-unanswered"}" data-summary-tab="${qi}">
          <span class="prompt-summary-row__main">
            <span class="prompt-summary-row__label">${escapeHtml(label)}</span>
            <span class="prompt-summary-row__answer">${escapeHtml(answerPreview(qi))}</span>
          </span>
          <i class="ph ph-pencil-simple"></i>
        </button>
      `;
    }).join("");

    const attachmentsStripHtml = opts.supportsExtras && auqAttachments.attachments.length
      ? `<div class="prompt-attachments composer-attachments"></div>`
      : "";
    const extraMessageHtml = opts.supportsExtras
      ? `
        <label class="prompt-q__other prompt-extra-message">
          <span class="prompt-q__other-label">Add a message (optional):</span>
          <div class="cc-typing-wrap">
            <div class="cc-typing-highlight cc-typing-highlight--auq" aria-hidden="true"></div>
            <textarea class="prompt-extra-input cc-typing-input" rows="1" placeholder="Anything else to add...">${escapeHtml(additionalMessage)}</textarea>
          </div>
        </label>
      `
      : "";

    return `
      <section class="prompt-panel${isActive ? " is-active" : ""}" data-panel="${questions.length}" style="--dom:var(--color-primary)">
        <div class="prompt-summary" role="tabpanel">
          <div class="prompt-summary__intro">Review your answers before sending:</div>
          ${rows}
          ${extraMessageHtml}
          ${attachmentsStripHtml}
        </div>
      </section>
    `;
  }

  function pagerHtml(): string {
    const dots = Array.from({ length: totalPanels }, (_, i) => {
      const isSummaryDot = hasSummary && i === questions.length;
      const answered = isSummaryDot ? questions.every((_, qi) => answeredAt(qi)) : answeredAt(i);
      const label = isSummaryDot ? "Review" : `Question ${i + 1}`;
      return `<button type="button" class="prompt-dot${answered ? " is-answered" : ""}${i === activeTab ? " is-current" : ""}"
        data-dot="${i}" aria-label="${label}, ${answered ? "answered" : "unanswered"}"></button>`;
    }).join("");
    const dotsHtml = `<span class="prompt-dots">${dots}</span>`;
    if (totalPanels < 2) return `<span class="prompt-pager">${dotsHtml}</span>`;

    const nextDisabled = nextArrowDisabled();
    return `<span class="prompt-pager">
      <button type="button" class="prompt-icon-btn" data-nav="-1" ${activeTab === 0 ? "disabled" : ""}><i class="ph ph-caret-left"></i></button>
      ${dotsHtml}
      <button type="button" class="prompt-icon-btn" data-nav="1" ${nextDisabled ? "disabled" : ""}><i class="ph ph-caret-right"></i></button>
    </span>`;
  }

  function collapsedHtml(): string {
    const isSummary = hasSummary && activeTab === questions.length;
    const q = isSummary ? undefined : questions[activeTab];
    const dom = domainVar(q?.domain);
    const text = q ? splitAsk(q.question).ask : "Review your answers before sending";
    return `
      <div class="prompt-collapsed" style="--dom:${dom}">
        <span class="prompt-collapsed__dot"></span>
        <span class="prompt-collapsed__q">${escapeHtml(text)}</span>
        <span class="prompt-collapsed__step">${activeTab + 1}/${totalPanels}</span>
        <button type="button" class="prompt-icon-btn" data-act="restore" title="Restore"><i class="ph ph-caret-up"></i></button>
      </div>
    `;
  }

  // One definition of "can advance", shared by pagerHtml() and the two
  // in-place patch paths below (free-text keystroke, step-only nav).
  function nextArrowDisabled(): boolean {
    return activeTab >= totalPanels - 1 || (activeTab < questions.length && !answeredAt(activeTab));
  }

  // Moves the persistent track to the current activeTab. `instant` skips the
  // transition (full rebuild - a fresh node has no prior position to slide
  // from); the animated path is only for step-only nav on the SAME node.
  function positionTrack(instant: boolean): void {
    const track = host.querySelector<HTMLElement>(".prompt-track");
    if (!track) return;
    if (instant) {
      track.style.transition = "none";
      track.style.transform = `translateX(-${activeTab * 100}%)`;
      void track.offsetHeight;
      track.style.transition = "";
    } else {
      track.style.transform = `translateX(-${activeTab * 100}%)`;
    }
    const activePanel = track.querySelector<HTMLElement>(`.prompt-panel[data-panel="${activeTab}"]`);
    if (activePanel) track.style.height = `${activePanel.offsetHeight}px`;
  }

  // Single source for the footer's primary button: Next on any question
  // panel, Submit only on review (or on the lone question when there's no
  // review panel at all).
  function updatePrimaryButton(): void {
    const btn = host.querySelector<HTMLButtonElement>('[data-act="primary"]');
    if (!btn) return;
    const isSubmitMode = !hasSummary || activeTab === questions.length;
    btn.disabled = isSubmitMode ? !questions.every((_, i) => answeredAt(i)) : nextArrowDisabled();
    btn.innerHTML = `<i class="ph ${isSubmitMode ? opts.submitIcon : "ph-caret-right"}"></i> ${escapeHtml(isSubmitMode ? opts.submitLabel : "Next")}`;
    btn.onclick = isSubmitMode ? submit : advance;
  }

  // Step-only nav: patches the track/dots/arrows/footer in place instead of
  // rebuilding host.innerHTML, so .prompt-track's transition has a real "from"
  // position to slide from. Only for moves that don't change any panel's
  // rendered content - see goToTab.
  function stepTab(prevTab: number): void {
    positionTrack(false);
    host.querySelector(`.prompt-panel[data-panel="${prevTab}"]`)?.classList.remove("is-active");
    host.querySelector(`.prompt-panel[data-panel="${activeTab}"]`)?.classList.add("is-active");
    host.querySelectorAll<HTMLElement>(".prompt-dot").forEach((dot) => {
      dot.classList.toggle("is-current", Number(dot.dataset.dot) === activeTab);
    });
    const prevArrow = host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="-1"]');
    if (prevArrow) prevArrow.disabled = activeTab === 0;
    const nextArrow = host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="1"]');
    if (nextArrow) nextArrow.disabled = nextArrowDisabled();
    updatePrimaryButton();
    syncMessagesPadding();
    opts.onDraftChange?.(currentDraft());
  }

  // All nav funnels through here so review - whose panel summarizes live
  // answers - always gets a full rebuild on entry, never the no-rebuild slide
  // path (which would show whatever it looked like at the last full render).
  function goToTab(target: number): void {
    const clamped = Math.min(Math.max(target, 0), totalPanels - 1);
    if (clamped === activeTab) return;
    if (hasSummary && clamped === questions.length) {
      activeTab = clamped;
      render();
      return;
    }
    const prevTab = activeTab;
    activeTab = clamped;
    stepTab(prevTab);
  }

  const advance = () => goToTab(activeTab + 1);

  const render = () => {
    // The old textareas (and the popups anchored to them) are about to be
    // thrown away by the innerHTML rebuild below - drop the popups' own
    // document-level listeners explicitly first, since DOM removal alone
    // doesn't do that.
    slashPopup.destroyAll();
    activeTab = Math.min(Math.max(activeTab, 0), totalPanels - 1);

    if (minimized) {
      host.innerHTML = collapsedHtml();
      host.querySelector(".prompt-collapsed")?.addEventListener("click", () => { minimized = false; render(); });
    } else {
      const headerHtml = `${pagerHtml()}<span class="prompt-head__spacer"></span><button type="button" class="prompt-icon-btn" data-act="minimize" title="Minimize"><i class="ph ph-minus"></i></button>`;
      const panelsHtml = questions.map((q, qi) => panelHtml(q, qi)).join("") + (hasSummary ? summaryPanelHtml() : "");
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
        ?.addEventListener("click", () => goToTab(activeTab - 1));
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
            if (label === NONE_LABEL) {
              // Exclusive: picking "None of the above" clears every other pick.
              set.clear();
              if (input.checked) set.add(NONE_LABEL);
            } else if (input.checked) {
              set.delete(NONE_LABEL);
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
            if (next >= 0) activeTab = next;
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

      questions.forEach((_, qi) => {
        const panelEl = host.querySelector<HTMLElement>(`.prompt-panel[data-panel="${qi}"]`);
        const otherEl = panelEl?.querySelector<HTMLTextAreaElement>(".prompt-q__other-input") ?? null;
        if (!otherEl) return;
        const otherHighlightEl = otherEl.parentElement?.querySelector<HTMLElement>(".cc-typing-highlight") ?? null;
        // Attach the core (auto-resize + highlight + popup) BEFORE this input
        // listener below, so its own "input" listener - registered first -
        // resizes the textarea before syncMessagesPadding() measures the card.
        slashPopup.attach(otherEl, otherHighlightEl);
        otherEl.addEventListener("input", () => {
          // Deliberately NOT a full render(): rebuilding the DOM on every
          // keystroke would destroy and recreate this textarea, dropping
          // focus and cursor position mid-type.
          freeText.set(qi, otherEl.value);
          const dotEl = host.querySelector<HTMLElement>(`.prompt-dot[data-dot="${qi}"]`);
          if (dotEl) dotEl.classList.toggle("is-answered", answeredAt(qi));
          if (hasSummary) {
            const allAnsweredNow = questions.every((_, i) => answeredAt(i));
            const summaryDot = host.querySelector<HTMLElement>(`.prompt-dot[data-dot="${questions.length}"]`);
            if (summaryDot) summaryDot.classList.toggle("is-answered", allAnsweredNow);
          }
          if (qi === activeTab) {
            const nextArrow = host.querySelector<HTMLButtonElement>('.prompt-pager [data-nav="1"]');
            if (nextArrow) nextArrow.disabled = nextArrowDisabled();
            updatePrimaryButton();
          }
          // The free-text box's own auto-resize (ComposerCore, attached above)
          // already grew the textarea itself - but .prompt-track's height was
          // pinned to the panel's height as of the last tab change, so the
          // clipping viewport around it needs the same re-measure or the grown
          // box just scrolls inside a too-short window instead of showing.
          positionTrack(true);
          syncMessagesPadding();
          opts.onDraftChange?.(currentDraft());
        });
        if (opts.supportsExtras) {
          otherEl.addEventListener("paste", (e) => void auqAttachments.handleAttachmentPaste(e));
        }
      });

      const extraEl = host.querySelector<HTMLTextAreaElement>(".prompt-extra-input");
      if (extraEl) {
        const extraHighlightEl = extraEl.parentElement?.querySelector<HTMLElement>(".cc-typing-highlight") ?? null;
        slashPopup.attach(extraEl, extraHighlightEl);
        extraEl.addEventListener("input", () => {
          additionalMessage = extraEl.value;
          positionTrack(true);
          syncMessagesPadding();
          opts.onDraftChange?.(currentDraft());
        });
        extraEl.addEventListener("paste", (e) => void auqAttachments.handleAttachmentPaste(e));
      }

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
    if (!resizeObs && messagesEl && typeof ResizeObserver !== "undefined") {
      const cardEl = host.querySelector<HTMLElement>(".prompt-card, .prompt-collapsed");
      if (cardEl) {
        resizeObs = new ResizeObserver(() => syncMessagesPadding());
        resizeObs.observe(cardEl);
      }
    }
    opts.onDraftChange?.(currentDraft());
  };

  render();
}
