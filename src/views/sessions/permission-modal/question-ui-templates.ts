// Pure HTML builders for the AUQ question card, split out of
// question-ui-render.ts (ai_todo 600) so the stateful half stays under the
// project's ~300-line file-size guidance. No DOM reads/writes, no closures -
// every input the old closures read is now an explicit param.

import { escapeHtml } from "../../../shared/escape-html";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import { splitAsk } from "./question-state";
import { BADGE_META, DOMAIN_META } from "./types";
import type { AuqAttachmentsController } from "./attachments";
import type { OptionBadge, Question, QuestionDomain, QuestionUIOpts, Selection } from "./types";

/** Fields the renderer mutates that question-ui.ts also reads/writes
 *  directly (initial clamp, teardown, draft snapshots). One shared box. */
export interface QuestionRenderState {
  activeTab: number;
  additionalMessage: string;
  resizeObs: ResizeObserver | null;
  panelResizeObs: ResizeObserver | null;
}

export function domainVar(domain?: QuestionDomain): string {
  return domain ? `var(--color-domain-${domain})` : "var(--color-primary)";
}

export function domainChipHtml(domain?: QuestionDomain): string {
  if (!domain) return "";
  const meta = DOMAIN_META[domain];
  return `<span class="prompt-domain"><i class="${meta.icon}"></i>${meta.label}</span>`;
}

export function badgesHtml(badges?: OptionBadge[]): string {
  if (!badges?.length) return "";
  const chips = badges.map((b) => {
    const m = BADGE_META[b];
    return `<span class="prompt-badge prompt-badge--${m.cls}"><i class="${m.icon}"></i>${m.label}</span>`;
  }).join("");
  return `<span class="prompt-badges">${chips}</span>`;
}

// Zones 1+2: splitAsk() already separates the leading context from the
// final ask - zone 1 (dimmed context) is omitted entirely when there's no
// separate ask to highlight. The domain chip rides along in whichever zone
// survives, so a terse one-sentence question still shows it.
export function questionZonesHtml(q: Question): string {
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
      ${context ? "" : domainChipHtml(q.domain)}
    </div>
  `;
}

export function optsRowsHtml(q: Question, qi: number, selections: Map<number, Selection>, noneLabel: string): string {
  return (q.options ?? []).map((opt) => {
    const selected = q.multiSelect
      ? (selections.get(qi) as Set<string> | undefined)?.has(opt.label) ?? false
      : selections.get(qi) === opt.label;
    const inputType = q.multiSelect ? "checkbox" : "radio";
    const desc = opt.description
      ? `<div class="prompt-opt__desc">${renderMarkdown(opt.description)}</div>`
      : "";
    const isNone = q.multiSelect && opt.label === noneLabel;
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

export function extraMessageZoneHtml(additionalMessage: string): string {
  return `
    <label class="prompt-q__other prompt-extra-message">
      <span class="prompt-q__other-label">Add a message (optional):</span>
      <div class="cc-typing-wrap">
        <div class="cc-typing-highlight cc-typing-highlight--auq" aria-hidden="true"></div>
        <textarea class="prompt-extra-input cc-typing-input" rows="1" placeholder="Anything else to add...">${escapeHtml(additionalMessage)}</textarea>
      </div>
    </label>
  `;
}

// The per-question free-text field keeps its `.prompt-q__other` wrapper
// (unstyled by the new design) because slash-popup.ts anchors on
// `ta.closest(".prompt-q__other")` and is not this task's file to touch.
// Only ever rendered into the fixed `.prompt-card__answer-bar` now (via
// syncAnswerBar), never inline in the scrolling panel - see its doc comment.
// No `.prompt-sect` header anymore - the footer's pencil toggle
// (data-act="answer-toggle") now carries that "answer in your own words"
// meaning, so this zone only shows once the bar is actually open.
export function ownZoneHtml(qi: number, freeText: Map<number, string>): string {
  const typedValue = freeText.get(qi) ?? "";
  return `
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
export function panelHtml(
  q: Question,
  qi: number,
  activeTab: number,
  selections: Map<number, Selection>,
  noneLabel: string,
  opts: QuestionUIOpts,
  auqAttachments: AuqAttachmentsController,
): string {
  const isActive = qi === activeTab;
  const pickSect = q.options?.length
    ? `<div class="prompt-sect"><i class="ph ph-list-checks"></i><span class="prompt-sect__label">${q.multiSelect ? "Select all that apply" : "Pick one"}</span><span class="prompt-sect__rule"></span></div>
       <div class="prompt-q__opts">${optsRowsHtml(q, qi, selections, noneLabel)}</div>`
    : "";
  const attachHtml = opts.supportsExtras && auqAttachments.attachments.length
    ? `<div class="prompt-attachments composer-attachments"></div>`
    : "";
  return `
    <section class="prompt-panel${isActive ? " is-active" : ""}" data-panel="${qi}" style="--dom:${domainVar(q.domain)}">
      ${questionZonesHtml(q)}
      ${pickSect}
      ${attachHtml}
    </section>
  `;
}

export function summaryPanelHtml(
  questions: Question[],
  activeTab: number,
  answeredAt: (qi: number) => boolean,
  answerPreview: (qi: number) => string,
  opts: QuestionUIOpts,
  auqAttachments: AuqAttachmentsController,
): string {
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

  return `
    <section class="prompt-panel${isActive ? " is-active" : ""}" data-panel="${questions.length}" style="--dom:var(--color-primary)">
      <div class="prompt-summary" role="tabpanel">
        <div class="prompt-summary__intro">Review your answers before sending:</div>
        ${rows}
        ${attachmentsStripHtml}
      </div>
    </section>
  `;
}

// One definition of "can advance", shared by pagerHtml() and question-ui-render.ts's
// own in-place patch paths (free-text keystroke, step-only nav).
export function nextArrowDisabled(
  activeTab: number,
  totalPanels: number,
  questions: Question[],
  answeredAt: (qi: number) => boolean,
): boolean {
  return activeTab >= totalPanels - 1 || (activeTab < questions.length && !answeredAt(activeTab));
}

export function pagerHtml(
  totalPanels: number,
  hasSummary: boolean,
  questions: Question[],
  answeredAt: (qi: number) => boolean,
  activeTab: number,
): string {
  const dots = Array.from({ length: totalPanels }, (_, i) => {
    const isSummaryDot = hasSummary && i === questions.length;
    const answered = isSummaryDot ? questions.every((_, qi) => answeredAt(qi)) : answeredAt(i);
    const label = isSummaryDot ? "Review" : `Question ${i + 1}`;
    return `<button type="button" class="prompt-dot${answered ? " is-answered" : ""}${i === activeTab ? " is-current" : ""}"
      data-dot="${i}" aria-label="${label}, ${answered ? "answered" : "unanswered"}"></button>`;
  }).join("");
  const dotsHtml = `<span class="prompt-dots">${dots}</span>`;
  if (totalPanels < 2) return `<span class="prompt-pager">${dotsHtml}</span>`;

  const nextDisabled = nextArrowDisabled(activeTab, totalPanels, questions, answeredAt);
  return `<span class="prompt-pager">
    <button type="button" class="prompt-icon-btn" data-nav="-1" ${activeTab === 0 ? "disabled" : ""}><i class="ph ph-caret-left"></i></button>
    ${dotsHtml}
    <button type="button" class="prompt-icon-btn" data-nav="1" ${nextDisabled ? "disabled" : ""}><i class="ph ph-caret-right"></i></button>
  </span>`;
}

export function collapsedHtml(
  hasSummary: boolean,
  activeTab: number,
  questions: Question[],
  totalPanels: number,
): string {
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
