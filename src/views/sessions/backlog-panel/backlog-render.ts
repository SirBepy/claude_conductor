// HTML builders for the Backlog panel: the list column, the reader and its
// footer. Strings only; backlog-panel.ts owns state, events and the DOM writes.
// Markdown goes through an injected renderer so these stay testable without
// the chat pipeline's dependencies.

import { escapeHtml as esc } from "../../../shared/escape-html";
import type { AiTodoDoc, AiTodoEntry } from "../../../types/ipc.generated";
import {
  UNPLANNED_LABEL, metaLine, readerSections, readerWhy, worthDots, type ListGroup,
} from "./backlog-model";

export type MarkdownFn = (md: string) => string;

export interface ListCtx {
  selectedId: string | null;
  /** Rows and plan headings show a drag grip and can be picked up. */
  draggable: boolean;
}

export function listHtml(groups: ListGroup[], ctx: ListCtx): string {
  return groups.map((g) => groupHtml(g, ctx)).join("");
}

function groupHtml(g: ListGroup, ctx: ListCtx): string {
  const planned = g.name != null;
  const label = planned ? g.name! : UNPLANNED_LABEL;
  const grip = planned && ctx.draggable ? `<i class="ph ph-dots-six-vertical bl-grip" aria-hidden="true"></i>` : "";
  return (
    `<section class="bl-group${planned ? "" : " is-unplanned"}" data-group="${planned ? esc(g.name!) : ""}" data-planned="${planned}">` +
    `<header class="bl-group-h"${planned && ctx.draggable ? ` data-bl-group-grab` : ""}>${grip}<span class="bl-group-name">${esc(label)}</span>` +
    `<span class="bl-group-n">${g.items.length}</span></header>` +
    `<div class="bl-group-items">${g.items.map((t) => rowHtml(t, ctx)).join("")}<div class="bl-group-end"></div></div>` +
    `</section>`
  );
}

function rowHtml(t: AiTodoEntry, ctx: ListCtx): string {
  const on = t.id === ctx.selectedId;
  // A claimed row swaps the origin dot for the live pulse: both are one glyph slot.
  const mark = t.claimed
    ? `<span class="bl-pulse" title="A chat is on it"></span>`
    : `<span class="bl-dot ${t.origin === "dev" ? "dev" : "ai"}" title="${t.origin === "dev" ? "Joe's" : "AI-written"}"></span>`;
  const grip = ctx.draggable ? `<i class="ph ph-dots-six-vertical bl-grip" aria-hidden="true"></i>` : "";
  return (
    `<button type="button" class="bl-row${on ? " is-on" : ""}" data-bl-id="${esc(t.id)}" aria-pressed="${on}">` +
    `${grip}<span class="bl-row-m"><span class="bl-title">${esc(t.title)}</span>` +
    `<span class="bl-meta">${mark}<span>${esc(metaLine(t))}</span></span></span></button>`
  );
}

export interface ReaderCtx {
  md: MarkdownFn;
  /** Footer shown: desktop, chat hosted on this machine. */
  actions: boolean;
  /** Plan group names for the move select, in plan order. */
  groups: string[];
}

export function readerHtml(doc: AiTodoDoc, ctx: ReaderCtx): string {
  const e = doc.entry;
  const why = readerWhy(doc);
  const dots = worthDots(e.worth);
  const origin = e.origin === "dev"
    ? `<span class="bl-tag bl-tag-dev"><i class="ph ph-user"></i>Joe</span>`
    : `<span class="bl-tag"><i class="ph ph-sparkle"></i>AI</span>`;
  const meta =
    (e.claimed ? `<span class="bl-tag bl-tag-live"><span class="bl-pulse"></span>A chat is on it</span>` : "") +
    origin +
    `<span class="bl-id">${esc(e.id)}</span>` +
    (e.complexity ? `<span class="bl-cx">${esc(e.complexity.toLowerCase())}</span>` : "") +
    (dots
      ? `<span class="bl-worth" title="worth ${e.worth}/10">${"<i></i>".repeat(dots.on)}${"<i class=\"off\"></i>".repeat(dots.total - dots.on)}</span>`
      : "");
  const sections = readerSections(doc.sections)
    .map((s) => `<details class="bl-sec"${s.open ? " open" : ""}><summary>${esc(s.label)}</summary><div class="bl-md">${ctx.md(s.markdown)}</div></details>`)
    .join("");
  const body =
    `<div class="bl-doc">` +
    `<div class="bl-doc-meta">${meta}</div>` +
    `<h2 class="bl-doc-title">${esc(e.title)}</h2>` +
    (e.summary ? `<p class="bl-summary">${esc(e.summary)}</p>` : "") +
    (why ? `<div class="bl-why"><span class="bl-why-label">Why</span><div class="bl-md">${ctx.md(why)}</div></div>` : "") +
    sections +
    `</div>`;
  return body + (ctx.actions ? footerHtml(e, ctx.groups) : "");
}

/** Move select's value for the unplanned group; a heading cannot be empty, so "" is free. */
export const UNPLANNED_VALUE = "";

function footerHtml(e: AiTodoEntry, groups: string[]): string {
  const options =
    groups.map((g) => `<option value="${esc(g)}"${e.group === g ? " selected" : ""}>${esc(g)}</option>`).join("") +
    `<option value="${UNPLANNED_VALUE}"${e.group == null ? " selected" : ""}>${UNPLANNED_LABEL}</option>`;
  const archiveTitle = e.claimed ? ` disabled title="A chat is working on it"` : ` title="Move to done"`;
  return (
    `<div class="bl-archive" data-bl-archive hidden>` +
    `<textarea class="bl-note" rows="2" placeholder="Note for the done file (optional), e.g. why it is no longer needed"></textarea>` +
    `<div class="bl-archive-row"><button type="button" class="bl-btn" data-bl-act="archive-cancel">Cancel</button>` +
    `<button type="button" class="bl-btn bl-btn-primary" data-bl-act="archive-go"><i class="ph ph-archive"></i>Archive</button></div></div>` +
    `<div class="bl-actions">` +
    `<button type="button" class="bl-btn bl-btn-primary" data-bl-act="start"><i class="ph ph-chat-circle-text"></i>Start a chat on it</button>` +
    `<label class="bl-move" title="Move to a plan group"><i class="ph ph-stack"></i><select data-bl-act="move" aria-label="Move to group">${options}</select></label>` +
    `<button type="button" class="bl-btn" data-bl-act="archive"${archiveTitle}><i class="ph ph-archive"></i>Archive</button>` +
    `<button type="button" class="bl-icon" data-bl-act="source" title="View source file" aria-label="View source file"><i class="ph ph-file-text"></i></button>` +
    `</div>`
  );
}
