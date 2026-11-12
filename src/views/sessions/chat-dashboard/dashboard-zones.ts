// One renderer per dashboard zone (src/shared/chat/dashboard/dashboard-model.ts
// says what each zone holds). Typed against ZoneId, so a zone added to the
// model's ZONES without a renderer here fails typecheck. Every card inside a
// zone is the transcript's own renderMessage output, so a card reads the same
// in both views; only the zone frames and the strip are dashboard markup.

import { escapeHtml } from "../../../shared/escape-html";
import { localTime } from "../../../shared/formatters";
import { renderBlocks, renderMessage } from "../../../shared/chat/chat-transforms";
import { renderQuestionCardHtml } from "../../../shared/chat/tool-views";
import { stripAuqAnswerBlock, stripAuqExtraBlock } from "../../../shared/chat/chat-event-to-message";
import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import type { StripState, WaitingItem, ZoneId, ZoneState } from "../../../shared/chat/dashboard/dashboard-model";
import { initialPlanUi, renderPlan, type PlanUi } from "./plan-card";
import { plainUserText } from "../../../shared/chat/dashboard/answers-model";
import { renderVisuals } from "../../../shared/chat/message-visuals-render";
import { basename } from "../../../shared/path-utils";
import type { LinkItem } from "../../../shared/chat/dashboard/links-model";
import type { DraftItem } from "../../../shared/chat/dashboard/drafts-model";
import { renderDraftCardHtml } from "../../../shared/chat/chat-draft-card";
import type { PreviewMeta } from "../../../types/ipc.generated";

/** The quick-view buttons in the Links and files card. */
export const QUICK_VIEWS = [
  { id: "plan", label: "Bigger plan", icon: "ph-map-trifold", none: "No bigger plan yet" },
  { id: "decided", label: "Decided", icon: "ph-seal-check", none: "Nothing decided yet" },
  { id: "memory", label: "Project memory", icon: "ph-brain", none: "No project memory yet" },
] as const;
export type QuickViewId = (typeof QUICK_VIEWS)[number]["id"];

/** What the dashboard remembers between derives. In memory only: none of it
 *  needs to survive a reload (each is one click to redo). */
export interface DashUi extends PlanUi {
  /** Index into the strip's messages Joe picked from "N earlier", or null for the latest. */
  stripPick: number | null;
  stripExpanded: boolean;
  earlierOpen: boolean;
  /** Drafts Joe opened or folded by hand, by DraftItem key. Without an entry
   *  the newest draft to send is open and every other one folded. */
  draftOpen: Record<string, boolean>;
  /** The "N copied" fold of the Drafts card is open. */
  copiedOpen: boolean;
  /** The Preview card's "N more by other chats" fold is open. */
  pvOthersOpen: boolean;
}

export function initialUi(): DashUi {
  return { ...initialPlanUi(), stripPick: null, stripExpanded: false, earlierOpen: false, draftOpen: {}, copiedOpen: false, pvOthersOpen: false };
}

export interface ZoneCtx {
  ui: DashUi;
  /** The chat's status line is running (or holding messages): the Plan card
   *  hosts it, so its idle footer is left out. */
  busy: boolean;
  /** When the view saw the last turn end (ms): the idle footer's "since". */
  idleAt?: number | null;
  /** Whether each quick view has anything to read; a view not listed has not
   *  been looked up yet and draws as if it has. */
  quick?: Partial<Record<QuickViewId, boolean>>;
  /** The name a Preview card group is labelled with, by the chat that pushed it. */
  previewOwner?: (sessionId: string) => string;
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
  return `<section class="cdash-zone cdash-card cdash-waiting${s.blocked ? " is-blocked" : ""}">${head("ph-bell-ringing", "Waiting on you")}`
    + `<div class="cdash-stack">${s.items.map(waitingItemHtml).join("")}</div></section>`;
}

/** Blockers waiting on something other than Joe: amber-free, titled with what
 *  they wait on. The label comes from the model, which takes it from structured
 *  fields only. */
function renderWaitingElsewhere(s: ZoneState<"waitingElsewhere">): string {
  return `<section class="cdash-zone cdash-card cdash-waiting-else">${head("ph-hourglass-medium", s.label)}`
    + `<div class="cdash-stack">${s.items.map((it) => cardHtml(it.message)).join("")}</div></section>`;
}

function renderPlanZone(s: ZoneState<"plan">, ctx: ZoneCtx): string {
  return renderPlan(s, { ui: ctx.ui, busy: ctx.busy, idleAt: ctx.idleAt ?? null, card: cardHtml });
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

/** One live miniature of a preview; chat-dashboard.ts's mountTiles stages its page. */
function previewTile(m: PreviewMeta, thumb: boolean): string {
  const tip = thumb ? `${m.title}: open in the preview panel` : "Open in the preview panel";
  return `<button type="button" class="cdash-pv-tile${thumb ? " is-thumb" : ""}" data-act="open-preview" data-slug="${escapeHtml(m.slug)}" data-pv-id="${escapeHtml(m.id)}" data-pv-version="${m.version}" title="${escapeHtml(tip)}" style="--pv-w:${PREVIEW_VIEW_W}px">`
    + `<iframe class="cdash-pv-frame" sandbox="allow-scripts" tabindex="-1" aria-hidden="true"></iframe></button>`;
}

/** Thumbnails drawn per strip. Each is a live scripted frame plus two IPC calls
 *  to stage, so a chat with dozens of previews ends in a "+N" tile that opens the
 *  panel (which lists them all) instead of mounting every page. */
const PV_STRIP_MAX = 8;

function pvStrip(items: readonly PreviewMeta[]): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, PV_STRIP_MAX).map((m) => previewTile(m, true)).join("");
  const rest = items.length - PV_STRIP_MAX;
  const more = rest > 0
    ? `<button type="button" class="cdash-pv-rest" data-act="open-preview" data-slug="${escapeHtml(items[PV_STRIP_MAX]!.slug)}" title="Open the rest in the preview panel">+${rest}</button>` : "";
  return `<div class="cdash-pv-strip">${shown}${more}</div>`;
}

/** Clock time, not "5m ago": the card redraws only when its HTML changes, and a
 *  ticking age would rebuild (and reload) every tile's frame once a minute. */
function pvStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `<span class="cdash-pv-age">${escapeHtml(localTime(d))}</span>`;
}

function renderPreviewWindow(s: ZoneState<"preview">, ctx: ZoneCtx): string {
  const [newest, ...older] = s.own;
  const count = s.own.length > 0 ? `<span class="cdash-count">${s.own.length}</span>` : "";
  const top = newest
    ? previewTile(newest, false)
      + `<div class="cdash-pv-foot"><span class="cdash-pv-title">${escapeHtml(newest.title)}</span>${newest.created_at ? pvStamp(newest.created_at) : ""}</div>`
      + pvStrip(older)
    : `<p class="cdash-pv-none">This chat made no previews.</p>`;
  const open = ctx.ui.pvOthersOpen;
  const fold = s.otherCount > 0
    ? `<button type="button" class="cdash-pv-others" data-act="pv-others" aria-expanded="${open}"><i class="ph ph-stack"></i>${s.otherCount} more by other chats<i class="ph ${open ? "ph-caret-up" : "ph-caret-down"}"></i></button>`
      + (open ? s.others.map((g) => `<div class="cdash-pv-group"><div class="cdash-pv-owner">${escapeHtml(ctx.previewOwner?.(g.owner) ?? "Another chat")}</div>${pvStrip(g.items)}</div>`).join("") : "")
    : "";
  return `<section class="cdash-zone cdash-card cdash-preview">${head("ph-monitor-play", "Previews", count)}${top}${fold}</section>`;
}

function renderChanges(s: ZoneState<"changes">): string {
  const rows = s.files.map((f) => `<div class="cdash-change">${fileChipHtml(f.path)}<em>${f.edits} ${f.edits === 1 ? "edit" : "edits"}</em></div>`).join("");
  return `<section class="cdash-zone cdash-card cdash-changes">${head("ph-git-diff", "Changes", `<span class="cdash-count">${s.files.length} ${s.files.length === 1 ? "file" : "files"}</span>`)}${rows}</section>`;
}

/** One draft: the transcript's own draft card markup, with the version filled
 *  in and ⤢ shown as Edit (it opens the Drafts panel on this draft). */
function draftHtml(d: DraftItem, open: boolean): string {
  const m = {
    kind: "draft",
    draftAction: d.sent ? "sent" : "add",
    draftTopic: d.topic,
    draftRecipient: d.recipient,
    draftBody: d.body,
  } as RenderedMessage;
  const cls = `msg draft-card${open ? " open" : ""}${d.copied ? " copied" : ""}${d.id ? "" : " unresolved"}`;
  return `<div class="${cls}" data-dd-key="${escapeHtml(d.key)}">${renderDraftCardHtml(m, { version: d.version, edit: true })}</div>`;
}

function renderDrafts(s: ZoneState<"drafts">, ctx: ZoneCtx): string {
  const open = (d: DraftItem, byDefault: boolean): boolean => ctx.ui.draftOpen[d.key] ?? byDefault;
  const toSend = s.toSend.map((d, i) => draftHtml(d, open(d, i === 0))).join("");
  const n = s.copied.length;
  const fold = n > 0
    ? `<button type="button" class="cdash-drafts-fold" data-act="drafts-copied" aria-expanded="${ctx.ui.copiedOpen}"><i class="ph ph-check"></i>${n} copied<i class="ph ${ctx.ui.copiedOpen ? "ph-caret-up" : "ph-caret-down"}"></i></button>`
      + (ctx.ui.copiedOpen ? s.copied.map((d) => draftHtml(d, open(d, false))).join("") : "")
    : "";
  const count = `<span class="cdash-count">${s.toSend.length > 0 ? `${s.toSend.length} to send` : "all copied"}</span>`;
  return `<section class="cdash-zone cdash-card cdash-drafts">${head("ph-paper-plane-tilt", "Drafts", count)}<div class="cdash-stack">${toSend}${fold}</div></section>`;
}

const listZone = (cls: string, icon: string, title: string) => (s: { cards: RenderedMessage[] }): string =>
  `<section class="cdash-zone cdash-card cdash-list ${cls}">${head(icon, title)}<div class="cdash-stack">${s.cards.map(cardHtml).join("")}</div></section>`;

/** A fixed host like Answers': the Subchats card (subs-card.ts) draws inside it,
 *  so a re-derive never replaces the avatars under Joe's pointer or wipes the
 *  message he is typing to a sub. */
function renderSubchats(): string {
  return `<section class="cdash-zone cdash-card cdash-subs">${head("ph-users-three", "Subchats")}<div class="sx-host"></div></section>`;
}

export const ZONE_VIEWS: { [K in ZoneId]: (state: ZoneState<K>, ctx: ZoneCtx) => string } = {
  answers: renderAnswers,
  waiting: renderWaiting,
  waitingElsewhere: renderWaitingElsewhere,
  drafts: renderDrafts,
  plan: renderPlanZone,
  subchats: renderSubchats,
  notes: listZone("cdash-notes", "ph-note", "Notes"),
  preview: renderPreviewWindow,
  links: renderLinks,
  changes: renderChanges,
};

export function renderZone<K extends ZoneId>(id: K, state: ZoneState<K>, ctx: ZoneCtx): string {
  return (ZONE_VIEWS[id] as (s: ZoneState<K>, c: ZoneCtx) => string)(state, ctx);
}
