// Draws a `kind:"message"` that declared a kind (chat-message-kinds.ts) as a
// verdict card. Every card is two forms of one box: the full card, and a
// one-line mini card that takes over once a later turn has spoken (the sweep
// that toggles `.is-old` is chat-card-turns.ts). Both live in the DOM so the
// swap is a CSS height transition and nothing is stored.
//
// The text fields go through the caller's markdown renderer, so file chips and
// `#d:id` drill links work the same as in a plain bubble.

import { escapeHtml } from "../escape-html";
import { bodyOf, headlineOf, openCounts, type MessageCard, type MessageKind } from "./chat-message-kinds";
import type { RenderedMessage } from "./chat-classifiers";

export type RenderText = (markdown: string) => string;

type Tone = "good" | "bad" | "warn" | "neutral";

/** What a sub's card adds to the common card: the sub's name (so Joe knows which
 *  job spoke), the fact chips under it, and a fixed verdict colour for a card
 *  whose verdict code, not a model, wrote. */
export interface CardExtras {
  tag?: string;
  /** A quiet word after the tag (a sub's "Sonnet high"). */
  tagNote?: string;
  extraHtml?: string;
  tone?: Tone;
}

interface KindStyle {
  icon: string;
  label: string;
}

/** The label a kind prints above its verdict. A report has none: it is the
 *  default shape of a turn's end and needs no name. */
const KIND_STYLE: Partial<Record<MessageKind, KindStyle>> = {
  answer: { icon: "ph-chat-circle-text", label: "Answer to you" },
  blocker: { icon: "ph-hand-palm", label: "Blocked" },
  do_this: { icon: "ph-hand-pointing", label: "Your turn" },
  plan: { icon: "ph-clipboard-text", label: "Plan for you" },
  rating: { icon: "ph-gauge", label: "Rating" },
  correction: { icon: "ph-arrow-u-up-left", label: "Correction" },
  call: { icon: "ph-signpost", label: "Claude's call" },
  handoff: { icon: "ph-arrow-square-out", label: "Handoff" },
  artifact: { icon: "ph-eye", label: "Ready to look at" },
  discovery: { icon: "ph-lightbulb", label: "Approach changed" },
};

/** Kinds that are information, not a demand: one size down, no tint. */
const FYI: ReadonlySet<MessageKind> = new Set(["call", "handoff", "artifact", "discovery"]);

/** The colour a verdict takes. Some kinds fix it (a blocker is never green);
 *  the rest follow the declared tone. A report is decided by its rows, see
 *  `reportVerdictHtml`. */
function toneOf(card: MessageCard): Tone {
  if (card.kind === "blocker") return "bad";
  if (card.kind === "do_this" || card.kind === "correction") return "warn";
  return card.tone === "good" ? "good" : card.tone === "bad" ? "bad" : "neutral";
}

const span = (tone: Tone, text: string) => `<span class="mc-t-${tone}">${escapeHtml(text)}</span>`;

/** A report with anything still open reads in two colours, what landed and then
 *  what did not; one with nothing open is all green. */
function reportVerdictHtml(card: MessageCard, verdict: string): string {
  if (openCounts(card).total === 0) return span("good", verdict);
  const at = verdict.indexOf(", ");
  if (at < 0) return span("warn", verdict);
  return `${span("good", verdict.slice(0, at + 1))} ${span("warn", verdict.slice(at + 2))}`;
}

function verdictHtml(card: MessageCard, verdict: string, extras?: CardExtras): string {
  if (extras?.tone) return span(extras.tone, verdict);
  return card.kind === "report" ? reportVerdictHtml(card, verdict) : span(toneOf(card), verdict);
}

/** The mini card's verdict is one colour: it is a label for a row, not a headline. */
function miniVerdictHtml(card: MessageCard, verdict: string, extras?: CardExtras): string {
  const tone: Tone = extras?.tone ?? (card.kind === "report" ? (openCounts(card).total === 0 ? "good" : "warn") : toneOf(card));
  return span(tone, verdict);
}

/** A headline reduced to plain text for the mini row, which truncates it on one
 *  line and sits inside a `<summary>`, where a link or chip would fight the toggle. */
function plainInline(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2");
}

const caret = `<i class="ph ph-caret-down mc-caret" aria-hidden="true"></i>`;

function rowsHtml(items: readonly string[] | undefined, icon: string, kind: string, text: RenderText): string {
  return (items ?? [])
    .map((t) => `<div class="mc-row mc-row--${kind}"><i class="ph ${icon}" aria-hidden="true"></i><div class="mc-row-text">${text(t)}</div></div>`)
    .join("");
}

function sectionHtml(label: string, kind: string, icon: string, items: readonly string[] | undefined, text: RenderText): string {
  if (!items?.length) return "";
  return `<div class="mc-sec mc-sec--${kind}"><div class="mc-sec-label">${label}</div><div class="mc-sec-rows">${rowsHtml(items, icon, kind, text)}</div></div>`;
}

/** What a closed report's `<details>` opens onto, and what the mini card shows
 *  for a report: the open sections first, the done list last. */
function reportSections(card: MessageCard, text: RenderText, withYourMove: boolean): string {
  return (
    (withYourMove ? sectionHtml("Your move", "yours", "ph-hand-pointing", card.yourMove, text) : "") +
    sectionHtml("Not done", "not", "ph-warning-circle", card.notDone, text) +
    sectionHtml("Waiting on", "wait", "ph-hourglass-medium", card.waitingOn, text) +
    sectionHtml("Done", "done", "ph-check", card.done, text)
  );
}

/** The existing drill chip: an `#d:id` link that drill-links.ts turns into a chip. */
function drillRowHtml(m: RenderedMessage): string {
  const links = (m.details ?? []).map((d) => `<a href="#d:${escapeHtml(d.id)}">${escapeHtml(d.label)}</a>`);
  return links.length > 0 ? `<div class="mc-drills">${links.join("")}</div>` : "";
}

/** Icon plus number, no words: the label rides `title` and `aria-label`. */
function chipsHtml(card: MessageCard): string {
  const chip = (n: number, tone: string, icon: string, name: string) =>
    n > 0 ? `<span class="mc-chip mc-chip--${tone}" role="img" title="${n} ${name}" aria-label="${n} ${name}"><i class="ph ${icon}" aria-hidden="true"></i>${n}</span>` : "";
  const { notDone, waiting } = openCounts(card);
  return chip(card.done?.length ?? 0, "done", "ph-check", "done") + chip(notDone, "not", "ph-warning-circle", "not done") + chip(waiting, "wait", "ph-hourglass-medium", "waiting");
}

function pointsDetailsHtml(points: readonly string[], text: RenderText): string {
  const n = points.length;
  return `<details class="mc-points"><summary class="mc-toggle"><span>${n} more point${n === 1 ? "" : "s"}</span>${caret}</summary><ul class="mc-points-list">${points.map((p) => `<li>${text(p)}</li>`).join("")}</ul></details>`;
}

function copyBlockHtml(copy: string): string {
  return `<div class="copyable-block code-card"><pre>${escapeHtml(copy)}</pre><button class="copy-btn" aria-label="Copy"><i class="ph ph-copy"></i></button></div>`;
}

/** The sub's name above its card: a quiet line with the subchat icon. */
function subTagHtml(tag: string, note?: string): string {
  const quiet = note ? `<span class="mc-sub-tier">${escapeHtml(note)}</span>` : "";
  return `<div class="mc-sub"><i class="ph ph-tree-structure" aria-hidden="true"></i><span class="mc-sub-name">${escapeHtml(tag)}</span>${quiet}</div>`;
}

function fullHtml(m: RenderedMessage, card: MessageCard, text: RenderText, extras?: CardExtras): string {
  const style = KIND_STYLE[card.kind];
  const head = headlineOf(m.text ?? "");
  const body = bodyOf(m.text ?? "");
  const parts: string[] = [];
  if (extras?.tag) parts.push(subTagHtml(extras.tag, extras.tagNote));
  if (style) parts.push(`<div class="mc-label"><i class="ph ${style.icon}" aria-hidden="true"></i>${style.label}</div>`);
  if (card.verdict) parts.push(`<p class="mc-verdict">${verdictHtml(card, card.verdict, extras)}</p>`);
  if (head) parts.push(`<div class="mc-head${card.verdict ? "" : " mc-head--main"}">${text(head)}</div>`);
  if (body) parts.push(`<div class="mc-body">${text(body)}</div>`);
  if (card.copy) parts.push(copyBlockHtml(card.copy));
  if (card.kind === "report") {
    const yours = sectionHtml("Your move", "yours", "ph-hand-pointing", card.yourMove, text);
    if (yours) parts.push(`<div class="mc-secs">${yours}</div>`);
    const chips = chipsHtml(card);
    const drills = drillRowHtml(m);
    if (chips) {
      parts.push(`<details class="mc-more"><summary class="mc-chips">${chips}${caret}</summary><div class="mc-secs">${reportSections(card, text, false)}</div>${drills}</details>`);
    } else if (drills) {
      parts.push(drills);
    }
  }
  if (card.points?.length) parts.push(pointsDetailsHtml(card.points, text));
  if (extras?.extraHtml) parts.push(extras.extraHtml);
  return parts.join("");
}

/** The words after a mini report's headline: what is still open. */
function miniOpenText(card: MessageCard): string {
  const { yours, notDone, waiting } = openCounts(card);
  return [yours > 0 ? "your move" : "", notDone > 0 ? `${notDone} not done` : "", waiting > 0 ? `${waiting} waiting` : ""].filter(Boolean).join(", ");
}

function miniHtml(m: RenderedMessage, card: MessageCard, text: RenderText, extras?: CardExtras): string {
  const style = KIND_STYLE[card.kind];
  const head = headlineOf(m.text ?? "");
  const body = bodyOf(m.text ?? "");
  // A kind with no verdict (plan, handoff, artifact) names itself instead, so the row is not an unlabelled sentence.
  const verdictLead = card.verdict ? miniVerdictHtml(card, card.verdict, extras) : style ? `<span class="mc-t-muted">${style.label}</span>` : "";
  // The name stays in the one-line form: a shrunken sub card must still say which job it is.
  const lead = extras?.tag ? `<span class="mc-sub-name mc-sub-name--mini">${escapeHtml(extras.tag)}</span> ${verdictLead}` : verdictLead;
  const open = card.kind === "report" ? miniOpenText(card) : "";
  const inner: string[] = [];
  if (body) inner.push(`<div class="mc-body">${text(body)}</div>`);
  if (card.copy) inner.push(copyBlockHtml(card.copy));
  if (card.points?.length) inner.push(`<ul class="mc-points-list">${card.points.map((p) => `<li>${text(p)}</li>`).join("")}</ul>`);
  if (card.kind === "report") inner.push(`<div class="mc-secs">${reportSections(card, text, true)}</div>`, drillRowHtml(m));
  if (extras?.extraHtml) inner.push(extras.extraHtml);
  // Always a <details>, even with nothing behind the row: opening it un-truncates the headline.
  const summary = `<summary class="mc-mini-row"><b class="mc-mini-lead">${lead}</b><span class="mc-mini-head">${escapeHtml(plainInline(head))}</span>${open ? `<em class="mc-mini-open">${open}</em>` : ""}${caret}</summary>`;
  return `<details class="mc-mini-d">${summary}${inner.length ? `<div class="mc-mini-body">${inner.join("")}</div>` : ""}</details>`;
}

/** The fold wrapper both forms sit in: the grid track is what animates from one to the other. */
const fold = (cls: string, inner: string) => `<div class="mc-fold ${cls}"><div class="mc-clip"><div class="mc-pad">${inner}</div></div></div>`;

/** The root keeps `msg assistant` and `data-details`: drill-links.ts, the copy
 *  button and `injectCta` all find a bubble by those. */
export function renderMessageCard(m: RenderedMessage, card: MessageCard, text: RenderText, extras?: CardExtras): string {
  const dim = m.dimmed ? " dimmed" : "";
  const details = m.details?.length ? ` data-details="${escapeHtml(JSON.stringify(m.details))}"` : "";
  if (card.kind === "ack") {
    // Draws nothing; "Show raw activity" reveals it as the plain bubble it would otherwise have been.
    return `<div class="msg assistant chat-narration${dim}" data-card-kind="ack"${details}><button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>${text(m.text ?? "")}</div>`;
  }
  const was = card.was ? `<div class="mc-was"><i class="ph ph-arrow-elbow-down-right" aria-hidden="true"></i><s>${escapeHtml(card.was)}</s></div>` : "";
  const classes = `msg assistant mc-root${FYI.has(card.kind) ? " mc-fyi" : ""}${dim}`;
  return (
    `<div class="${classes}" data-card-kind="${card.kind}"${extras ? ` data-sub-card="1"` : ""}${details}>` +
    was +
    `<div class="mc-card mc-k-${card.kind}">` +
    `<button class="copy-btn msg-copy-btn" aria-label="Copy message"><i class="ph ph-copy"></i></button>` +
    fold("mc-full", fullHtml(m, card, text, extras)) +
    fold("mc-mini", miniHtml(m, card, text, extras)) +
    `</div></div>`
  );
}
