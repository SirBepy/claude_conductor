import { escapeHtml } from "../../../shared/escape-html";
import { registerOverlayBack } from "../../../shared/back-button";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import { invoke } from "../../../shared/ipc";
import { blobToBase64 } from "../../../shared/chat/composer-attachments";
import { mimeToIcon } from "../../../shared/chat/attachment-hydrator";
import { openLightbox } from "../../../shared/chat/lightbox";
// See composer-attachments.ts's identical import for the valibot/ReDoS
// unreachability note - same plugin, same guarantee (only hasFiles/readFiles
// used here too).
import { hasFiles, readFiles } from "tauri-plugin-clipboard-api";
import { clearHost, ensureHost, renderCardShell } from "./host";
import type { Answers, AuqAttachment, Question, QuestionDraft, QuestionUIOpts, Selection } from "./types";
import {
  isQuestionAnswered,
  computeAnswer,
  setActiveCard,
  clearActiveCardIfCurrent,
} from "./question-state";

// Payload normalization, the active-card draft registry, and the pure
// answer-completeness check now live in ./question-state.ts; re-exported here
// so existing importers of this file keep working unchanged.
export { isQuestionAnswered, computeAnswer, formatAnswersAsMessage, extractQuestions, dismissQuestionCard, snapshotActiveCardDraft } from "./question-state";

// Synthetic option appended to every multiSelect question so "nothing
// applies" is an explicit, selectable answer instead of an implicit
// zero-selections state - lets isQuestionAnswered require a real choice
// (checkbox or free text) instead of treating an untouched question as done.
const NONE_LABEL = "None of the above";

/** Splits a body into context + the final "?"-terminated ask (cut at the
 *  nearest paragraph/sentence break before it), so the card can dim the
 *  former and highlight the latter. No "?", or a negligible context, falls
 *  back to {context: "", ask: whole string} - keeps terse questions as-is. */
function splitAsk(question: string): { context: string; ask: string } {
  const trimmed = question.trim();
  const lastQ = trimmed.lastIndexOf("?");
  if (lastQ === -1) return { context: "", ask: trimmed };
  const beforeAsk = trimmed.slice(0, lastQ);
  const paraBreak = beforeAsk.lastIndexOf("\n\n");
  const sentenceBreak = beforeAsk.lastIndexOf(". ");
  const cut = Math.max(paraBreak, sentenceBreak);
  const askStart = cut === -1 ? 0 : cut + 2;
  const context = trimmed.slice(0, askStart).trim();
  const ask = trimmed.slice(askStart, lastQ + 1).trim();
  if (!context || ask.length > trimmed.length * 0.85) return { context: "", ask: trimmed };
  return { context, ask };
}

/** Renders a question's body: markdown throughout, plus (when splitAsk finds
 *  a clear final ask) a dimmed context block above a highlighted ask line. */
function questionTextHtml(question: string): string {
  const { context, ask } = splitAsk(question);
  if (!context) return `<div class="prompt-q__text">${renderMarkdown(question)}</div>`;
  return `
    <div class="prompt-q__context">${renderMarkdown(context)}</div>
    <div class="prompt-q__ask"><i class="ph ph-arrow-bend-down-right"></i>${renderMarkdown(ask)}</div>
  `;
}

export function renderQuestionUI(opts: QuestionUIOpts): void {
  const { host } = ensureHost();
  const questions: Question[] = opts.questions.map((q) => {
    if (!q.multiSelect || !q.options?.length) return q;
    if (q.options.some((o) => o.label === NONE_LABEL)) return q;
    return { ...q, options: [...q.options, { label: NONE_LABEL }] };
  });

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
  const attachments: AuqAttachment[] = opts.initialDraft?.attachments
    ? [...opts.initialDraft.attachments]
    : [];

  async function attachBlob(blob: Blob, filename: string): Promise<void> {
    const data = await blobToBase64(blob);
    let path: string | null = null;
    if (opts.sessionId) {
      try {
        path = await invoke<string>("paste_attachment", {
          sessionId: opts.sessionId,
          base64Data: data,
          mime: blob.type || "application/octet-stream",
        });
      } catch (err) {
        console.warn("[AUQ] paste_attachment failed:", err);
      }
    }
    attachments.push({ mime: blob.type || "application/octet-stream", data, path, filename });
    render();
  }

  async function attachFromPath(srcPath: string): Promise<void> {
    const filename = srcPath.split(/[\\/]/).pop() ?? srcPath;
    let result: { path: string; mime: string; base64: string } | null = null;
    if (opts.sessionId) {
      try {
        result = await invoke<{ path: string; mime: string; base64: string }>(
          "paste_attachment_from_path",
          { sessionId: opts.sessionId, path: srcPath },
        );
      } catch (err) {
        console.warn("[AUQ] paste_attachment_from_path failed:", err);
      }
    }
    attachments.push({
      filename,
      mime: result?.mime ?? "application/octet-stream",
      data: result?.base64 ?? "",
      path: result?.path ?? null,
    });
    render();
  }

  // Wired onto every free-text input on the card (per-question "other" field +
  // the review-step additional-message field) so an image can be pasted from
  // any step, same as the composer. Mirrors ComposerAttachments.handlePaste;
  // not reused directly since that class persists to localStorage keyed by
  // session id, which would collide with the main composer's own draft for
  // the same session (see AuqAttachment doc in types.ts).
  async function handleAttachmentPaste(e: ClipboardEvent): Promise<void> {
    if (!opts.supportsExtras || !e.clipboardData) return;
    const blobs = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => ({ blob: item.getAsFile(), type: item.type }))
      .filter((b): b is { blob: File; type: string } => b.blob !== null);
    if (blobs.length === 0) return;
    e.preventDefault();
    let usedNativeFiles = false;
    try {
      if (await hasFiles()) {
        const paths = await readFiles();
        if (paths.length > 0) {
          for (const path of paths) await attachFromPath(path);
          usedNativeFiles = true;
        }
      }
    } catch (err) {
      console.warn("[AUQ] clipboard readFiles failed, falling back to blob paste:", err);
    }
    if (usedNativeFiles) return;
    for (const { blob, type } of blobs) {
      await attachBlob(blob, blob.name || `paste.${type.split("/")[1] ?? "bin"}`);
    }
  }

  function renderAttachmentsStrip(container: HTMLElement): void {
    container.innerHTML = "";
    attachments.forEach((a, i) => {
      const div = document.createElement("div");
      const isImage = a.mime.startsWith("image/");
      div.className = `attachment${isImage ? "" : " file-chip"}`;
      if (isImage && a.data) {
        const img = document.createElement("img");
        img.src = `data:${a.mime};base64,${a.data}`;
        img.alt = a.filename;
        img.addEventListener("click", () => openLightbox({ type: "image", mime: a.mime, base64: a.data, filename: a.filename }));
        div.appendChild(img);
      } else {
        const icon = mimeToIcon(a.mime);
        div.innerHTML = `<i class="ph ${icon}"></i>`;
        const label = document.createElement("span");
        label.textContent = a.filename;
        div.appendChild(label);
      }
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.title = "Remove";
      rm.innerHTML = '<i class="ph ph-x"></i>';
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        attachments.splice(i, 1);
        render();
      });
      div.appendChild(rm);
      container.appendChild(div);
    });
  }

  const messagesEl = document.querySelector<HTMLElement>(".session-messages");
  const savedScrollTop = messagesEl?.scrollTop ?? 0;
  const savedPaddingBottom = messagesEl?.style.paddingBottom ?? "";
  let resizeObs: ResizeObserver | null = null;
  const syncMessagesPadding = (): void => {
    if (!messagesEl) return;
    const card = host.querySelector<HTMLElement>(".prompt-card");
    if (!card) return;
    messagesEl.style.paddingBottom = `${card.offsetHeight + 12}px`;
    messagesEl.scrollTop = messagesEl.scrollHeight - messagesEl.clientHeight;
  };

  // Phone back button skips the question (same as Escape / the Skip button) so
  // the card never traps the user, and the prompt resolves rather than silently
  // hiding. Registered below once `cancel` exists; disposed on teardown.
  let backDisposer: (() => void) | null = null;

  const teardown = () => {
    backDisposer?.();
    backDisposer = null;
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
    attachments: [...attachments],
  });
  if (opts.id) {
    setActiveCard({
      id: opts.id,
      sessionId: opts.sessionId,
      teardown,
      getDraft: currentDraft,
    });
  }

  const keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      teardown();
      void opts.onCancel();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      triggerPrimaryShortcut();
    }
  };
  document.addEventListener("keydown", keydownHandler);

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
    void opts.onSubmit(answers, { additionalMessage: additionalMessage.trim(), attachments: [...attachments] });
  };

  const cancel = () => {
    teardown();
    void opts.onCancel();
  };

  backDisposer = registerOverlayBack(() => {
    cancel();
    return true;
  });

  const answeredAt = (qi: number): boolean =>
    isQuestionAnswered(questions[qi], freeText.get(qi) ?? "", selections.get(qi));

  const answerPreview = (qi: number): string => {
    const a = answerFor(qi);
    if (Array.isArray(a)) return a.length ? a.join(", ") : "Not answered";
    return typeof a === "string" && a ? a : "Not answered";
  };

  const showTabs = questions.length > 1;
  let isCollapsed = false;
  let activeTab = opts.initialDraft?.activeTab ?? 0;
  // Only meaningful when showTabs: "answer" is the per-question tab/form view,
  // "summary" is the final recap-before-send screen.
  let mode: "answer" | "summary" = "answer";
  let firstRender = true;

  const goNext = () => {
    activeTab = Math.min(activeTab + 1, questions.length - 1);
    render();
  };
  const goToSummary = () => {
    mode = "summary";
    render();
  };
  const goBackToAnswers = () => {
    mode = "answer";
    render();
  };
  const triggerPrimaryShortcut = () => {
    const allAnsweredNow = questions.every((_, i) => answeredAt(i));
    if (!showTabs || mode === "summary") {
      if (allAnsweredNow) submit();
      return;
    }
    if (!answeredAt(activeTab)) return;
    if (activeTab < questions.length - 1) goNext();
    else goToSummary();
  };

  const render = () => {
    const title = `
      <span class="prompt-card__title">
        <i class="ph ${opts.titleIcon}"></i>
        ${escapeHtml(opts.titleText)}
      </span>
      ${opts.rightChipHtml ?? ""}
    `;

    const isSummary = showTabs && mode === "summary";
    const tabsHtml = showTabs && !isSummary
      ? `<div class="prompt-tabs" role="tablist">
          ${questions.map((q, qi) => {
            const label = q.header?.trim() || `Question ${qi + 1}`;
            const answered = answeredAt(qi);
            const isActive = qi === activeTab;
            return `
              <button type="button" role="tab" class="prompt-tab${isActive ? " is-active" : ""}${answered ? " is-answered" : ""}" data-tab="${qi}" aria-selected="${isActive}">
                <span class="prompt-tab__dot"><i class="${answered ? "ph-fill ph-check-circle" : "ph ph-circle"}"></i></span>
                <span class="prompt-tab__label">${escapeHtml(label)}</span>
              </button>
            `;
          }).join("")}
        </div>`
      : "";

    const q = questions[activeTab];
    const qHeaderTag = !showTabs && q?.header
      ? `<span class="prompt-q__tag">${escapeHtml(q.header)}</span>`
      : "";
    const modeHtml = q?.options?.length
      ? `<span class="prompt-q__mode">${q.multiSelect ? "Select all that apply" : "Pick one"}</span>`
      : "";
    const rows = (q?.options ?? []).map((opt) => {
      const selected = q!.multiSelect
        ? (selections.get(activeTab) as Set<string> | undefined)?.has(opt.label) ?? false
        : selections.get(activeTab) === opt.label;
      const inputType = q!.multiSelect ? "checkbox" : "radio";
      const desc = opt.description
        ? `<div class="prompt-opt__desc">${renderMarkdown(opt.description)}</div>`
        : "";
      const isNone = q!.multiSelect && opt.label === NONE_LABEL;
      return `
        <label class="prompt-opt${selected ? " is-selected" : ""}${isNone ? " prompt-opt--none" : ""}">
          <input type="${inputType}" name="q-${activeTab}" data-label="${escapeHtml(opt.label)}" ${selected ? "checked" : ""} />
          <span class="prompt-opt__body">
            <span class="prompt-opt__label">${escapeHtml(opt.label)}</span>
            ${desc}
          </span>
        </label>
      `;
    }).join("");

    const typedValue = freeText.get(activeTab) ?? "";
    const summaryRows = questions.map((sq, qi) => {
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

    // Attachments are shared across every step (paste on any question tab or
    // the review step), so the strip shows wherever there's something to see -
    // never gated on isSummary - and only for the flow that can actually
    // deliver them (see QuestionUIOpts.supportsExtras doc).
    const attachmentsStripHtml = opts.supportsExtras && attachments.length
      ? `<div class="prompt-attachments composer-attachments"></div>`
      : "";
    const extraMessageHtml = opts.supportsExtras
      ? `
        <label class="prompt-q__other prompt-extra-message">
          <span class="prompt-q__other-label">Add a message (optional):</span>
          <textarea class="prompt-extra-input" rows="1" placeholder="Anything else to add...">${escapeHtml(additionalMessage)}</textarea>
        </label>
      `
      : "";

    const body = isSummary
      ? `
        <div class="prompt-summary" role="tabpanel">
          <div class="prompt-summary__intro">Review your answers before sending:</div>
          ${summaryRows}
          ${extraMessageHtml}
          ${attachmentsStripHtml}
        </div>
      `
      : `
        ${tabsHtml}
        <div class="prompt-q" role="tabpanel">
          <div class="prompt-q__head">${qHeaderTag}${modeHtml}</div>
          ${questionTextHtml(q?.question ?? "")}
          <div class="prompt-q__opts">${rows}</div>
          <label class="prompt-q__other">
            <span class="prompt-q__other-label">Add your own (combines with a pick above):</span>
            <textarea class="prompt-q__other-input" rows="1" placeholder="Type your own answer...">${escapeHtml(typedValue)}</textarea>
          </label>
          ${attachmentsStripHtml}
        </div>
      `;

    const allAnswered = questions.every((_, i) => answeredAt(i));
    const submitDisabled = allAnswered ? "" : "disabled";
    let footer: string;
    if (!showTabs) {
      footer = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-primary" data-act="submit" ${submitDisabled}>
          <i class="ph ${opts.submitIcon}"></i> ${escapeHtml(opts.submitLabel)}
        </button>
      `;
    } else if (isSummary) {
      footer = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-secondary" data-act="back"><i class="ph ph-arrow-left"></i> Back</button>
        <button type="button" class="btn btn-primary" data-act="submit" ${submitDisabled}>
          <i class="ph ${opts.submitIcon}"></i> ${escapeHtml(opts.submitLabel)}
        </button>
      `;
    } else {
      const isLast = activeTab === questions.length - 1;
      const stepDisabled = answeredAt(activeTab) ? "" : "disabled";
      footer = `
        <button type="button" class="btn btn-secondary" data-act="cancel">${escapeHtml(opts.cancelLabel)}</button>
        <button type="button" class="btn btn-primary" data-act="${isLast ? "review" : "next"}" ${stepDisabled}>
          <i class="ph ${isLast ? "ph-list-checks" : "ph-arrow-right"}"></i> ${isLast ? "Review" : "Next"}
        </button>
      `;
    }

    host.innerHTML = renderCardShell(title, body, footer);
    const card = host.querySelector<HTMLElement>(".prompt-card");
    if (!firstRender) card?.classList.add("prompt-card--no-anim");
    firstRender = false;

    if (card) {
      if (isCollapsed) card.classList.add("prompt-card--collapsed");
      const header = card.querySelector<HTMLElement>(".prompt-card__header");
      if (header) {
        const collapseBtn = document.createElement("button");
        collapseBtn.type = "button";
        collapseBtn.className = "prompt-card__collapse";
        collapseBtn.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
        collapseBtn.innerHTML = `<i class="ph ${isCollapsed ? "ph-caret-up" : "ph-caret-down"}"></i>`;
        collapseBtn.addEventListener("click", () => {
          isCollapsed = !isCollapsed;
          card.classList.toggle("prompt-card--collapsed", isCollapsed);
          collapseBtn.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
          const icon = collapseBtn.querySelector("i");
          if (icon) icon.className = `ph ${isCollapsed ? "ph-caret-up" : "ph-caret-down"}`;
          requestAnimationFrame(() => syncMessagesPadding());
        });
        header.appendChild(collapseBtn);
      }
    }

    host.querySelectorAll<HTMLButtonElement>(".prompt-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        const idx = Number(tabBtn.dataset.tab);
        if (Number.isFinite(idx)) {
          activeTab = idx;
          render();
        }
      });
    });

    host.querySelectorAll<HTMLInputElement>('.prompt-opt input').forEach((input) => {
      input.addEventListener("change", () => {
        const qi = activeTab;
        const label = input.dataset.label ?? "";
        const q = questions[qi];
        if (!q) return;
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
        // Single-select: auto-advance to next unanswered tab.
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
    host.querySelectorAll<HTMLInputElement>('.prompt-opt input[type="radio"]').forEach((input) => {
      input.addEventListener("click", () => {
        const qi = activeTab;
        const label = input.dataset.label ?? "";
        if (selections.get(qi) !== label) return;
        selections.delete(qi);
        render();
      });
    });

    const otherEl = host.querySelector<HTMLTextAreaElement>(".prompt-q__other-input");
    if (otherEl) {
      const autoSize = () => {
        otherEl.style.height = "auto";
        otherEl.style.height = `${Math.min(otherEl.scrollHeight, 160)}px`;
      };
      autoSize();
      otherEl.addEventListener("input", () => {
        freeText.set(activeTab, otherEl.value);
        autoSize();
        const allAnsweredNow = questions.every((_, i) => answeredAt(i));
        const submitBtn = host.querySelector<HTMLButtonElement>('[data-act="submit"]');
        if (submitBtn) submitBtn.disabled = !allAnsweredNow;
        const stepBtn = host.querySelector<HTMLButtonElement>('[data-act="next"], [data-act="review"]');
        if (stepBtn) stepBtn.disabled = !answeredAt(activeTab);
        const tabBtn = host.querySelector<HTMLElement>(`.prompt-tab[data-tab="${activeTab}"]`);
        if (tabBtn) {
          tabBtn.classList.toggle("is-answered", answeredAt(activeTab));
          const dotIcon = tabBtn.querySelector("i");
          if (dotIcon) dotIcon.className = answeredAt(activeTab) ? "ph-fill ph-check-circle" : "ph ph-circle";
        }
        syncMessagesPadding();
        opts.onDraftChange?.(currentDraft());
      });
      if (opts.supportsExtras) {
        otherEl.addEventListener("paste", (e) => void handleAttachmentPaste(e));
      }
    }

    const extraEl = host.querySelector<HTMLTextAreaElement>(".prompt-extra-input");
    if (extraEl) {
      const autoSize = () => {
        extraEl.style.height = "auto";
        extraEl.style.height = `${Math.min(extraEl.scrollHeight, 160)}px`;
      };
      autoSize();
      extraEl.addEventListener("input", () => {
        additionalMessage = extraEl.value;
        autoSize();
        syncMessagesPadding();
        opts.onDraftChange?.(currentDraft());
      });
      extraEl.addEventListener("paste", (e) => void handleAttachmentPaste(e));
    }

    const attachmentsEl = host.querySelector<HTMLElement>(".prompt-attachments");
    if (attachmentsEl) renderAttachmentsStrip(attachmentsEl);

    host.querySelector<HTMLButtonElement>('[data-act="submit"]')
      ?.addEventListener("click", submit);
    host.querySelector<HTMLButtonElement>('[data-act="cancel"]')
      ?.addEventListener("click", cancel);
    host.querySelector<HTMLButtonElement>('[data-act="next"]')
      ?.addEventListener("click", goNext);
    host.querySelector<HTMLButtonElement>('[data-act="review"]')
      ?.addEventListener("click", goToSummary);
    host.querySelector<HTMLButtonElement>('[data-act="back"]')
      ?.addEventListener("click", goBackToAnswers);
    host.querySelectorAll<HTMLButtonElement>('[data-summary-tab]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.summaryTab);
        if (Number.isFinite(idx)) {
          activeTab = idx;
          mode = "answer";
          render();
        }
      });
    });

    requestAnimationFrame(() => syncMessagesPadding());
    if (!resizeObs && messagesEl && typeof ResizeObserver !== "undefined") {
      const card = host.querySelector<HTMLElement>(".prompt-card");
      if (card) {
        resizeObs = new ResizeObserver(() => syncMessagesPadding());
        resizeObs.observe(card);
      }
    }
    opts.onDraftChange?.(currentDraft());
  };

  render();
}

