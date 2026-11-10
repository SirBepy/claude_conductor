// One renderer per dashboard zone (src/shared/chat/dashboard/dashboard-model.ts
// says what each zone holds). Typed against ZoneId, so a zone added to the
// model's ZONES without a renderer here fails typecheck. Every card inside a
// zone is the transcript's own renderMessage output, so a card reads the same
// in both views; only the zone frames and the strip are dashboard markup.

import { escapeHtml } from "../../../shared/escape-html";
import { localTime } from "../../../shared/formatters";
import { renderBlocks, renderMarkdown, renderMessage } from "../../../shared/chat/chat-transforms";
import { headlineOf } from "../../../shared/chat/chat-message-kinds";
import { renderQuestionCardHtml } from "../../../shared/chat/tool-views";
import { stripAuqAnswerBlock, stripAuqExtraBlock } from "../../../shared/chat/chat-event-to-message";
import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import type {
  PlanStep, StripState, WaitingItem, ZoneId, ZoneState,
} from "../../../shared/chat/dashboard/dashboard-model";
import { plainUserText } from "../../../shared/chat/dashboard/answers-model";
import { renderVisuals } from "../../../shared/chat/message-visuals-render";
import { basename } from "../../../shared/path-utils";
import type { LinkItem } from "../../../shared/chat/dashboard/links-model";

/** The quick-view buttons in the Links and files card. */
export const QUICK_VIEWS = [
  { id: "plan", label: "Bigger plan", icon: "ph-map-trifold", none: "No bigger plan yet" },
  { id: "decided", label: "Decided", icon: "ph-seal-check", none: "Nothing decided yet" },
  { id: "memory", label: "Project memory", icon: "ph-brain", none: "No project memory yet" },
] as const;
export type QuickViewId = (typeof QUICK_VIEWS)[number]["id"];

/** What the dashboard remembers between derives. In memory only: none of it
 *  needs to survive a reload (each is one click to redo). */
export interface DashUi {
  /** The Result is up but Joe flipped the card back to the finished plan. */
  showPlan: boolean;
  /** Key (`index:label`) of the plan step whose detail line is open. */
  openStep: string | null;
  /** Index into the strip's messages Joe picked from "N earlier", or null for the latest. */
  stripPick: number | null;
  stripExpanded: boolean;
  earlierOpen: boolean;
}

export function initialUi(): DashUi {
  return { showPlan: false, openStep: null, stripPick: null, stripExpanded: false, earlierOpen: false };
}

export interface ZoneCtx {
  ui: DashUi;
  /** The chat's status line is running (or holding messages): the Plan card
   *  hosts it, so its idle footer is left out. */
  busy: boolean;
  /** Whether each quick view has anything to read; a view not listed has not
   *  been looked up yet and draws as if it has. */
  quick?: Partial<Record<QuickViewId, boolean>>;
}

// renderMessage is the costly part of a derive pass and a row object is
// replaced, never mutated, when it changes, so the HTML is cached per object.
const cardCache = new WeakMap<RenderedMessage, string>();
export function cardHtml(m: RenderedMessage): string {
  let html = cardCache.get(m);
  if (html === undefined) {
    html = renderMessage(m);
    cardCache.set(m, html);
  }
  return html;
}

const head = (icon: string, title: string, extra = ""): string =>
  `<h4 class="cdash-h"><i class="ph ${icon}"></i><span class="cdash-h-t">${escapeHtml(title)}</span>${extra}</h4>`;

function stampOf(m: RenderedMessage): string {
  if (!m.ts) return "";
  const ms = m.ts < 1e10 ? m.ts * 1000 : m.ts;
  return localTime(new Date(ms));
}

// ---- Joe's message strip -----------------------------------------------------------

export { plainUserText };

export function renderStrip(strip: StripState | null, ui: DashUi): string {
  if (!strip) return "";
  const msgs = strip.messages;
  const idx = ui.stripPick !== null && ui.stripPick < msgs.length ? ui.stripPick : msgs.length - 1;
  const m = msgs[idx]!;
  const earlier = msgs.length - 1;
  const stamp = stampOf(m);
  const body = renderBlocks(stripAuqExtraBlock(stripAuqAnswerBlock(m.content ?? [])), true, true);
  const back = idx !== msgs.length - 1
    ? `<button type="button" class="cdash-strip-btn" data-act="strip-latest">Back to latest</button>` : "";
  const more = earlier > 0
    ? `<button type="button" class="cdash-strip-btn${ui.earlierOpen ? " on" : ""}" data-act="strip-earlier" aria-expanded="${ui.earlierOpen}"><i class="ph ph-clock-counter-clockwise"></i>${earlier} earlier</button>` : "";
  const list = ui.earlierOpen && earlier > 0
    ? `<div class="cdash-pop" role="listbox">${msgs.map((x, i) => `<button type="button" class="cdash-pop-row${i === idx ? " on" : ""}" data-act="strip-pick" data-i="${i}"><span class="cdash-pop-t">${escapeHtml(plainUserText(x))}</span>${stampOf(x) ? `<em>${escapeHtml(stampOf(x))}</em>` : ""}</button>`).reverse().join("")}</div>`
    : "";
  return `<div class="cdash-strip-row"><span class="cdash-strip-l"><i class="ph ph-user"></i>You${stamp ? `<em>${escapeHtml(stamp)}</em>` : ""}</span>`
    + `<div class="cdash-strip-msg${ui.stripExpanded ? " open" : ""}" data-act="strip-expand" role="button" tabindex="0" title="${ui.stripExpanded ? "Click to clamp" : "Click to show it all"}"><div class="cdash-strip-text">${body}</div></div>`
    + `${back}${more}</div>${list}`;
}

// ---- Zones -------------------------------------------------------------------------

/** A fixed host: the Answers card (answers-card.ts) draws and animates inside
 *  it, so a re-derive never replaces the card under Joe's pointer or wipes a
 *  thread's message box. */
function renderAnswers(): string {
  return `<section class="cdash-zone cdash-answers ax-host"></section>`;
}

/** A question is the transcript's own question card, so the pane's existing
 *  click handler (sessions.ts) reopens the answerable card from it. */
function waitingItemHtml(item: WaitingItem): string {
  if (item.type !== "question") return cardHtml(item.message);
  const id = item.message.id ? ` data-question-id="${escapeHtml(item.message.id)}"` : "";
  // The figures the question's own message carried (an approval question asks
  // about them), shown with it instead of two cards apart.
  const figures = item.figures.length > 0 ? `<div class="msg cdash-figs">${renderVisuals(item.figures)}</div>` : "";
  return `${figures}<div class="msg question-card"${id}>${renderQuestionCardHtml(item.message)}</div>`
    + `<div class="cdash-hint"><i class="ph ph-arrow-down"></i>Answer on the card by the message box</div>`;
}

function renderWaiting(s: ZoneState<"waiting">): string {
  return `<section class="cdash-zone cdash-waiting${s.blocked ? " is-blocked" : ""}">${head("ph-bell-ringing", "Waiting on you")}`
    + `<div class="cdash-stack">${s.items.map(waitingItemHtml).join("")}</div></section>`;
}

const STEP_ICON: Record<PlanStep["status"], string> = {
  done: "ph-check-circle",
  active: "ph-circle-notch",
  pending: "ph-circle",
  skipped: "ph-minus-circle",
};

export const stepKey = (i: number, step: PlanStep): string => `${i}:${step.label}`;

function stepHtml(step: PlanStep, key: string, open: boolean): string {
  const icon = `<i class="ph ${STEP_ICON[step.status]}"></i>`;
  const cls = `cdash-step cdash-step--${step.status}${open ? " open" : ""}`;
  if (!step.detail) return `<div class="${cls}">${icon}<span>${escapeHtml(step.label)}</span></div>`;
  const detail = open ? `<em class="cdash-step-d">${escapeHtml(step.detail)}</em>` : "";
  return `<button type="button" class="${cls}" data-act="step" data-step="${escapeHtml(key)}" aria-expanded="${open}" title="${open ? "Hide what this step does" : "Show what this step does"}">${icon}<span>${escapeHtml(step.label)}${detail}</span></button>`;
}

/** The foot of the Plan card. The chat's real status line (Stop, elapsed, its
 *  detail block) is moved into the slot while it runs; idle, a quiet line says so. */
function statusSlot(busy: boolean): string {
  const idle = busy ? "" : `<div class="cdash-pstatus"><span class="cdash-pdot"></span><span>Idle</span></div>`;
  return `<div class="cdash-status" data-slot="status">${idle}</div>`;
}

function renderPlan(s: ZoneState<"plan">, ctx: ZoneCtx): string {
  const total = s.steps.length;
  const count = total > 0 ? `${s.done}/${total}` : "";
  if (s.result && !ctx.ui.showPlan) {
    const flip = total > 0
      ? `<button type="button" class="cdash-flip" data-act="show-plan" title="Show the finished plan"><i class="ph ph-list-checks"></i>Plan ${count}</button>` : "";
    return `<section class="cdash-zone cdash-result">${head("ph-flag-checkered", "Result", flip)}${cardHtml(s.result)}${statusSlot(ctx.busy)}</section>`;
  }
  const flip = s.result
    ? `<button type="button" class="cdash-flip" data-act="show-result" title="Back to the result"><i class="ph ph-flag-checkered"></i>Result</button>` : "";
  const extra = (count ? `<span class="cdash-count">${count}</span>` : "") + flip;
  const lead = s.lead?.text ? `<div class="cdash-plan-lead">${renderMarkdown(headlineOf(s.lead.text))}</div>` : "";
  const steps = s.steps.map((st, i) => stepHtml(st, stepKey(i, st), ctx.ui.openStep === stepKey(i, st))).join("");
  return `<section class="cdash-zone cdash-card cdash-plan">${head("ph-list-checks", "Plan", extra)}${lead}${steps ? `<div class="cdash-steps">${steps}</div>` : ""}${statusSlot(ctx.busy)}</section>`;
}

const LINK_ICON: Record<LinkItem["kind"], string> = {
  pr: "ph-git-pull-request",
  ci: "ph-play-circle",
  ticket: "ph-ticket",
  link: "ph-link-simple",
  draft: "ph-git-pull-request",
};

function linkHtml(l: LinkItem): string {
  const inner = `<i class="ph ${LINK_ICON[l.kind]}"></i><span>${escapeHtml(l.label)}</span>`;
  return l.url
    ? `<a class="cdash-link" href="${escapeHtml(l.url)}" title="${escapeHtml(l.url)}" data-link-kind="${l.kind}">${inner}</a>`
    : `<span class="cdash-link is-draft" data-link-kind="${l.kind}">${inner}</span>`;
}

/** The same chip markup file-refs.ts builds, so the dashboard's click handler
 *  for file refs (which opens Code mode or the editor) serves it unchanged. */
export function fileChipHtml(path: string, extra = ""): string {
  const folder = /[\\/]$/.test(path);
  return `<span class="file-ref" tabindex="0" role="button" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}"><i class="ph ${folder ? "ph-folder" : "ph-file"}"></i><span class="file-ref-name">${escapeHtml(basename(path))}</span></span>${extra}`;
}

function quickButtons(ctx: ZoneCtx): string {
  return `<div class="cdash-qv" role="group" aria-label="Quick views">${QUICK_VIEWS.map((q) => {
    const none = ctx.quick?.[q.id] === false;
    return `<button type="button" class="cdash-qv-btn${none ? " is-none" : ""}" data-act="quick-view" data-view="${q.id}" title="${escapeHtml(none ? q.none : q.label)}"><i class="ph ${q.icon}"></i>${escapeHtml(q.label)}</button>`;
  }).join("")}</div>`;
}

function renderLinks(s: ZoneState<"links">, ctx: ZoneCtx): string {
  const links = s.links.length > 0 ? `<div class="cdash-chips">${s.links.map(linkHtml).join("")}</div>` : "";
  const files = s.files.length > 0
    ? `<div class="cdash-chips">${s.files.map((f) => fileChipHtml(f.path, f.touched ? `<i class="ph ph-pencil-simple cdash-touched" title="Edited by the chat"></i>` : "")).join("")}</div>` : "";
  return `<section class="cdash-zone cdash-card cdash-links">${head("ph-link", "Links and files")}${links}${files}${quickButtons(ctx)}</section>`;
}

const PREVIEW_VIEW_W = 1280;

function renderPreviewWindow(s: ZoneState<"preview">): string {
  const m = s.newest;
  const more = s.others > 0 ? `<span class="cdash-pv-more">+${s.others} more in the panel</span>` : "";
  return `<section class="cdash-zone cdash-card cdash-preview">${head("ph-monitor-play", "Preview window")}`
    + `<button type="button" class="cdash-pv-tile" data-act="open-preview" data-slug="${escapeHtml(m.slug)}" data-pv-id="${escapeHtml(m.id)}" data-pv-version="${m.version}" title="Open in the preview panel" style="--pv-w:${PREVIEW_VIEW_W}px">`
    + `<iframe class="cdash-pv-frame" sandbox="allow-scripts" tabindex="-1" aria-hidden="true"></iframe></button>`
    + `<div class="cdash-pv-foot"><span class="cdash-pv-title">${escapeHtml(m.title)}</span>${more}</div></section>`;
}

function renderChanges(s: ZoneState<"changes">): string {
  const rows = s.files.map((f) => `<div class="cdash-change">${fileChipHtml(f.path)}<em>${f.edits} ${f.edits === 1 ? "edit" : "edits"}</em></div>`).join("");
  return `<section class="cdash-zone cdash-card cdash-changes">${head("ph-git-diff", "Changes", `<span class="cdash-count">${s.files.length} ${s.files.length === 1 ? "file" : "files"}</span>`)}${rows}</section>`;
}

const listZone = (cls: string, icon: string, title: string) => (s: { cards: RenderedMessage[] }): string =>
  `<section class="cdash-zone cdash-list ${cls}">${head(icon, title)}<div class="cdash-stack">${s.cards.map(cardHtml).join("")}</div></section>`;

/** A fixed host like Answers': the Subchats card (subs-card.ts) draws inside it,
 *  so a re-derive never replaces the avatars under Joe's pointer or wipes the
 *  message he is typing to a sub. */
function renderSubchats(): string {
  return `<section class="cdash-zone cdash-card cdash-subs">${head("ph-users-three", "Subchats")}<div class="sx-host"></div></section>`;
}

export const ZONE_VIEWS: { [K in ZoneId]: (state: ZoneState<K>, ctx: ZoneCtx) => string } = {
  answers: renderAnswers,
  waiting: renderWaiting,
  plan: renderPlan,
  subchats: renderSubchats,
  notes: listZone("cdash-notes", "ph-note", "Notes"),
  preview: renderPreviewWindow,
  links: renderLinks,
  changes: renderChanges,
};

export function renderZone<K extends ZoneId>(id: K, state: ZoneState<K>, ctx: ZoneCtx): string {
  return (ZONE_VIEWS[id] as (s: ZoneState<K>, c: ZoneCtx) => string)(state, ctx);
}
