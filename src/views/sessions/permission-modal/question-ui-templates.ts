// Pure HTML builders for the AUQ question card, split out of
// question-ui-render.ts (ai_todo 600) so the stateful half stays under the
// project's ~300-line file-size guidance. No DOM reads/writes, no closures -
// every input the old closures read is now an explicit param.

import { escapeHtml } from "../../../shared/escape-html";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import { composerFieldHtml } from "../../../shared/chat/composer-field";
import { splitAsk } from "./question-state";
import { previewLayout, previewedOptions, stageHtml, tilePictureHtml } from "./option-previews";
import type { PreviewLayout } from "./option-previews";
import { BADGE_META, DOMAIN_META } from "./types";
import type { AuqAttachmentsController } from "./attachments";
import type { AuqAttachment, OptionBadge, Question, QuestionDomain, QuestionUIOpts, Selection } from "./types";

/** Fields the renderer mutates that question-ui.ts also reads/writes
 *  directly (initial clamp, teardown, draft snapshots). One shared box. */
export interface QuestionRenderState {
  activeTab: number;
  additionalMessage: string;
  /** The ticked option whose note box is open, if any. View state only, never
   *  part of the draft: a reload shows the saved note, not an open box. */
  editingNote: { qi: number; label: string } | null;
  /** Review step's "Add a note" row was tapped open. Also opens by itself
   *  whenever additionalMessage already has text. */
  reviewNoteOpen: boolean;
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
// survives, so a terse one-sentence question still shows it. The ask band's
// own Ask button is the phone page's copy of the header one
// (permission-modal-shell.css shows one or the other).
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
      <button type="button" class="icon-btn-sq prompt-icon-btn prompt-ask__btn" data-act="ask-inline" title="Ask about this question"><i class="ph ph-chat-teardrop-dots"></i></button>
    </div>
  `;
}

export function optsRowsHtml(
  q: Question,
  qi: number,
  selections: Map<number, Selection>,
  noneLabel: string,
  layout: PreviewLayout | null = null,
  sessionId?: string,
  notes?: Map<string, string>,
  editingLabel?: string | null,
): string {
  return (q.options ?? []).map((opt) => {
    const selected = q.multiSelect
      ? (selections.get(qi) as Set<string> | undefined)?.has(opt.label) ?? false
      : selections.get(qi) === opt.label;
    const inputType = q.multiSelect ? "checkbox" : "radio";
    const desc = opt.description
      ? `<div class="prompt-opt__desc">${renderMarkdown(opt.description)}</div>`
      : "";
    const isNone = q.multiSelect && opt.label === noneLabel;
    // Notes are for ticked options only (Joe, 2026-10-26: a note on an option
    // you didn't pick has no use), and never on "None of the above".
    const notable = selected && !isNone && layout !== "tiles";
    const note = notable ? (notes?.get(opt.label) ?? "") : "";
    const editing = notable && editingLabel === opt.label;
    return `
      <label class="prompt-opt${selected ? " is-selected" : ""}${isNone ? " prompt-opt--none" : ""}">
        ${layout === "tiles" ? tilePictureHtml(opt, sessionId) : ""}
        <input type="${inputType}" name="q-${qi}" data-label="${escapeHtml(opt.label)}" ${selected ? "checked" : ""} />
        <span class="prompt-opt__body">
          <span class="prompt-opt__top"><span class="prompt-opt__label">${escapeHtml(opt.label)}</span>${badgesHtml(opt.badges)}</span>
          ${desc}
          ${editing ? `<textarea class="prompt-opt__note-input" rows="2" placeholder="Note on this option..." data-note-for="${escapeHtml(opt.label)}">${escapeHtml(note)}</textarea>` : ""}
          ${!editing && note.trim() ? `<span class="prompt-opt__note">${escapeHtml(note.trim())}</span>` : ""}
        </span>
        ${notable ? `<button type="button" class="icon-btn-sq prompt-icon-btn prompt-opt__pencil${editing || note.trim() ? " is-on" : ""}" data-note-toggle="${escapeHtml(opt.label)}" title="${note.trim() ? "Edit note" : "Add a note"}"><i class="${note.trim() || editing ? "ph-fill" : "ph"} ph-pencil-simple"></i></button>` : ""}
      </label>
    `;
  }).join("");
}

// The answer box is the shared composer field (composer-field.ts), the same
// box + paper-plane the chat and Preview use, on desktop and phone alike. The
// AUQ hook classes (.prompt-q__other-input/.prompt-extra-input) ride along on
// the textarea for the wiring that looks them up. On the phone's fullscreen
// page it is docked edge to edge, like Preview's, and its arrow stands in for
// the hidden Next/Submit button; everywhere else syncAnswerBar drops the
// arrow, so the footer button is the only way forward.
function answerFieldHtml(hookClass: string, placeholder: string, value: string, page: boolean): string {
  return composerFieldHtml({
    rowClass: page ? "composer-field--docked pv-composer" : undefined,
    inputClass: hookClass,
    sendClass: "pv-composer-send prompt-answer-send",
    placeholder,
    value,
  });
}

// Rendered into the review panel's `.prompt-summary__note` slot (syncAnswerBar).
export function extraMessageZoneHtml(additionalMessage: string, page = false): string {
  return answerFieldHtml("prompt-extra-input", "Anything else to add...", additionalMessage, page);
}

// Only ever rendered into `.prompt-card__answer-bar` (via syncAnswerBar),
// which sits inline in the footer row next to Next - see its doc comment.
export function ownZoneHtml(qi: number, freeText: Map<number, string>, page = false): string {
  return answerFieldHtml("prompt-q__other-input", "Type your own answer...", freeText.get(qi) ?? "", page);
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
  notes?: Map<string, string>,
  editingLabel?: string | null,
): string {
  const isActive = qi === activeTab;
  const layout = previewLayout(q);
  // --tile-cols: one column per previewed option, so 2 tiles fill the width
  // instead of leaving a third column empty.
  const optsStyle = layout === "tiles" ? ` style="--tile-cols:${previewedOptions(q).length}"` : "";
  const pickSect = q.options?.length
    ? `<div class="prompt-sect"><i class="ph ph-list-checks"></i><span class="prompt-sect__label">${q.multiSelect ? "Select all that apply" : "Pick one"}</span><span class="prompt-sect__rule"></span></div>
       ${layout === "stage" ? stageHtml(q, qi, opts.sessionId) : ""}
       <div class="prompt-q__opts"${optsStyle}>${optsRowsHtml(q, qi, selections, noneLabel, layout, opts.sessionId, notes, editingLabel)}</div>`
    : "";
  // Emitted even while empty (`.composer-attachments:empty` hides it) - the
  // paste path patches this node in place instead of re-rendering.
  const attachHtml = opts.supportsExtras
    ? `<div class="prompt-attachments composer-attachments" data-attach-panel="${qi}"></div>`
    : "";
  return `
    <section class="prompt-panel${isActive ? " is-active" : ""}${layout ? ` prompt-panel--preview-${layout}` : ""}" data-panel="${qi}" style="--dom:${domainVar(q.domain)}">
      ${questionZonesHtml(q)}
      ${pickSect}
      ${attachHtml}
    </section>
  `;
}

// Review-step stand-in for a question's own thumbnail strip: the recap lists
// answers, so an attached image gets one muted chip rather than a 80px thumb.
function attachChipHtml(staged: AuqAttachment[]): string {
  if (!staged.length) return "";
  const allImages = staged.every((a) => a.mime.startsWith("image/"));
  const icon = allImages ? "ph-image" : "ph-paperclip";
  const noun = staged.length === 1 ? (allImages ? "image" : "file") : (allImages ? "images" : "files");
  return `<span class="prompt-summary-row__attach" title="${staged.length} ${noun} attached"><i class="ph ${icon}"></i>${staged.length}</span>`;
}

export function summaryPanelHtml(
  questions: Question[],
  activeTab: number,
  answeredAt: (qi: number) => boolean,
  answerPreview: (qi: number) => string,
  opts: QuestionUIOpts,
  auqAttachments: AuqAttachmentsController,
  notesFor: (qi: number) => [string, string][] = () => [],
): string {
  const isActive = activeTab === questions.length;
  const rows = questions.map((sq, qi) => {
    const label = sq.header?.trim() || `Question ${qi + 1}`;
    const answered = answeredAt(qi);
    const noteLines = notesFor(qi)
      .map(([opt, text]) => `<span class="prompt-summary-row__note"><b>${escapeHtml(opt)}:</b> ${escapeHtml(text)}</span>`)
      .join("");
    return `
      <button type="button" class="prompt-summary-row${answered ? "" : " is-unanswered"}" data-summary-tab="${qi}">
        <span class="prompt-summary-row__main">
          <span class="prompt-summary-row__label">${escapeHtml(label)}</span>
          <span class="prompt-summary-row__answer">${escapeHtml(answerPreview(qi))}</span>
          ${noteLines}
        </span>
        ${attachChipHtml(auqAttachments.attachmentsForPanel(qi))}
        <i class="ph ph-pencil-simple"></i>
      </button>
    `;
  }).join("");

  const attachmentsStripHtml = opts.supportsExtras
    ? `<div class="prompt-attachments composer-attachments" data-attach-panel="${questions.length}"></div>`
    : "";

  return `
    <section class="prompt-panel${isActive ? " is-active" : ""}" data-panel="${questions.length}" style="--dom:var(--color-primary)">
      <div class="prompt-summary" role="tabpanel">
        <div class="prompt-summary__intro">Review your answers before sending:</div>
        ${rows}
        ${opts.supportsExtras ? `<div class="prompt-summary__note"></div>` : ""}
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
  // A single panel has nothing to page between, so a dot here would just be
  // a ring glyph with no meaning (there's no sibling panel to contrast
  // against) - keep the (invisible, zero-size) .prompt-pager wrapper itself,
  // since the phone's fullscreen-page CSS (permission-modal-shell.css,
  // sessions-mobile.css) keys off its presence to tell a question card apart
  // from a permission card.
  if (totalPanels < 2) return `<span class="prompt-pager"></span>`;
  const dots = Array.from({ length: totalPanels }, (_, i) => {
    const isSummaryDot = hasSummary && i === questions.length;
    const answered = isSummaryDot ? questions.every((_, qi) => answeredAt(qi)) : answeredAt(i);
    const label = isSummaryDot ? "Review" : `Question ${i + 1}`;
    return `<button type="button" class="prompt-dot${answered ? " is-answered" : ""}${i === activeTab ? " is-current" : ""}"
      data-dot="${i}" aria-label="${label}, ${answered ? "answered" : "unanswered"}"></button>`;
  }).join("");
  const dotsHtml = `<span class="prompt-dots">${dots}</span>`;

  const nextDisabled = nextArrowDisabled(activeTab, totalPanels, questions, answeredAt);
  return `<span class="prompt-pager">
    <button type="button" class="icon-btn-sq prompt-icon-btn" data-nav="-1" ${activeTab === 0 ? "disabled" : ""}><i class="ph ph-caret-left"></i></button>
    ${dotsHtml}
    <button type="button" class="icon-btn-sq prompt-icon-btn" data-nav="1" ${nextDisabled ? "disabled" : ""}><i class="ph ph-caret-right"></i></button>
  </span>`;
}

export function collapsedHtml(
  hasSummary: boolean,
  activeTab: number,
  questions: Question[],
  totalPanels: number,
  cancelLabel: string,
): string {
  const isSummary = hasSummary && activeTab === questions.length;
  const q = isSummary ? undefined : questions[activeTab];
  const dom = domainVar(q?.domain);
  const text = q ? splitAsk(q.question).ask : "Review your answers before sending";
  // Skip lives only here (Joe, 2026-10-26): it throws the whole card away, so
  // it sits where you go to set the card aside, two taps from an accident.
  return `
    <div class="prompt-collapsed" style="--dom:${dom}">
      <span class="prompt-collapsed__dot"></span>
      <span class="prompt-collapsed__q">${escapeHtml(text)}</span>
      <span class="prompt-collapsed__step">${activeTab + 1}/${totalPanels}</span>
      <button type="button" class="prompt-collapsed__skip" data-act="cancel">${escapeHtml(cancelLabel)}</button>
      <button type="button" class="icon-btn-sq prompt-icon-btn" data-act="restore" title="Restore"><i class="ph ph-caret-up"></i></button>
    </div>
  `;
}
