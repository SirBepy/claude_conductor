// The Done card's markup (done-lines-card.ts owns the DOM around it). Pure: strings in, strings out,
// so a spec reads the same HTML the card draws. A finished feature is the Plan card's own line
// (features-html.ts `lineHtml`): the same row, the same classes, the same fonts. Only what a
// finished line adds is drawn here: a trail of plain icons (the hover card and the chat menu hang on
// them), the opened line's chat rows, and the card's header.
//
// Every function emits the SETTLED state for the open/closed choices in `DoneOpen`; the card patches
// those choices in place afterwards (`applyOpen`), so opening a line animates and a data redraw that
// lands in the same state paints nothing new.

import { escapeHtml } from "../../../shared/escape-html";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import { CHAT_KIND_INFO } from "../../../shared/chat/chat-kinds";
import { EARLIER, UNRELEASED, type DoneGroup } from "../../../shared/chat/dashboard/done-model";
import type { FeatureChat, FeatureRow } from "../../../shared/chat/dashboard/features-model";
import { chatStepsHtml, lineHtml, TRAIL_MAX } from "./features-html";

const esc = escapeHtml;

/** Which line of a list is open, and which of its chats shows its steps. One line at a time. */
export interface DoneOpen {
  feat: string | null;
  chat: string | null;
}

/** A kind icon for a finished chat: the Plan trail's own `pf-ti`, a plain span here (the line is the button). */
function iconHtml(c: FeatureChat): string {
  const info = CHAT_KIND_INFO[c.kind];
  return `<span class="pf-ti dl-ti" data-st="done"${chatMenuAttr(c.id)} aria-label="${esc(info.label)}: ${esc(c.name)}"><i class="ph ph-${info.icon}"></i></span>`;
}

function chatRowHtml(row: FeatureRow, c: FeatureChat, open: DoneOpen): string {
  const info = CHAT_KIND_INFO[c.kind];
  const on = open.feat === row.key && open.chat === c.id;
  const steps = chatStepsHtml(c) || `<div class="pf-job">No steps were recorded.</div>`;
  return `<div class="dl-chatwrap${on ? " is-open" : ""}" data-chat-wrap="${esc(c.id)}">`
    + `<div class="dl-chat" role="button" tabindex="0" aria-expanded="${on}" data-act="dl-chat" data-feat="${esc(row.key)}" data-chat="${esc(c.id)}"${chatMenuAttr(c.id)}>`
    + `${iconHtml(c)}<span class="dl-cn">${esc(info.label)}</span><span class="dl-cv">${esc(c.verdict ?? "Done")}</span></div>`
    + `<div class="dl-cview"><div class="dl-cview-clip"><div class="dl-cview-in">${steps}</div></div></div></div>`;
}

/** One finished line: the shared row, then (folded until opened) its chats. */
/** Up to TRAIL_MAX chats draw in full; past that only the DONE_TRAIL_RECENT that finished last draw
 *  (kept in the row's own order) and a "+N" chip leads them, N being how many are hidden. */
export const DONE_TRAIL_RECENT = 3;

/** Splits a row's chats into the drawn ones and the hidden ones, both in the row's order. */
export function doneTrailSplit(chats: readonly FeatureChat[]): { shown: FeatureChat[]; hidden: FeatureChat[] } {
  if (chats.length <= TRAIL_MAX) return { shown: [...chats], hidden: [] };
  // A chat with no known finish ranks oldest; the sort is stable so ties keep the row's order.
  const ranked = chats.map((c, i) => ({ c, i })).sort((a, b) => (b.c.finishedAt ?? -Infinity) - (a.c.finishedAt ?? -Infinity) || b.i - a.i);
  const keep = new Set(ranked.slice(0, DONE_TRAIL_RECENT).map((r) => r.c));
  return { shown: chats.filter((c) => keep.has(c)), hidden: chats.filter((c) => !keep.has(c)) };
}

/** The "+N" chip: a span (the whole line is the button, so a nested button is invalid), whose title
 *  names each hidden chat and its kind. Clicking it falls through to the line, which opens every chat. */
function moreHtml(hidden: readonly FeatureChat[]): string {
  if (hidden.length === 0) return "";
  const names = hidden.map((c) => `${CHAT_KIND_INFO[c.kind].label}: ${c.name}`).join("\n");
  const label = `${hidden.length} more ${hidden.length === 1 ? "chat" : "chats"}`;
  return `<span class="dl-more" tabindex="0" title="${esc(`${label}\n${names}`)}" aria-label="${esc(`${label}: ${names.replace(/\n/g, ", ")}`)}">+${hidden.length}</span>`;
}

export function doneLineHtml(row: FeatureRow, open: DoneOpen): string {
  const on = open.feat === row.key;
  const { shown, hidden } = doneTrailSplit(row.chats);
  const trail = `<span class="pf-trail dl-trail">${moreHtml(hidden)}${shown.map(iconHtml).join("")}</span>`;
  return `<div class="pf-feat dl-feat${on ? " is-open" : ""}" data-feat="${esc(row.key)}">`
    + lineHtml(row, { act: "dl-open", open: on, trail })
    + `<div class="dl-det"><div class="dl-det-clip"><div class="dl-det-in"><div class="dl-chats">${row.chats.map((c) => chatRowHtml(row, c, open)).join("")}</div></div></div></div></div>`;
}

export function doneLinesHtml(rows: readonly FeatureRow[], open: DoneOpen): string {
  return rows.map((r) => doneLineHtml(r, open)).join("");
}

export interface DoneHeadState {
  /** More finished features wait in the popup. */
  hasMore: boolean;
}

/** The card's header: the Plan card's own `cdash-h` (same type, same icon size) and, when more wait,
 *  the clock that opens the popup. The card is always open, so the header has no fold toggle. */
export function doneHeadHtml(h: DoneHeadState): string {
  const earlier = h.hasMore
    ? `<button type="button" class="dl-earlier" data-act="dl-earlier" aria-haspopup="dialog" title="Earlier finished features" aria-label="Earlier finished features"><i class="ph ph-clock-counter-clockwise"></i></button>`
    : "";
  return `<h4 class="cdash-h dl-h"><i class="ph ph-check-circle"></i><span class="cdash-h-t">Done</span><span class="dl-gap"></span>${earlier}</h4>`;
}

/** A divider in the popup. A release opens its What's new; unreleased and earlier are plain labels. */
export function releaseDividerHtml(release: string): string {
  if (release === UNRELEASED || release === EARLIER) {
    return `<div class="dl-ver"><i class="ph ph-tag"></i><span>${release === UNRELEASED ? "Unreleased" : "Earlier"}</span></div>`;
  }
  return `<button type="button" class="dl-ver" data-act="dl-whatsnew" data-ver="${esc(release)}" title="What's new in v${esc(release)}"><i class="ph ph-tag"></i><span>v${esc(release)}</span><i class="ph ph-caret-right dl-ver-go"></i></button>`;
}

/** The popup's list: a divider wherever the release changes, the same lines under each. */
export function popupListHtml(groups: readonly DoneGroup[], open: DoneOpen): string {
  if (groups.length === 0) return `<div class="dl-empty">No matching features</div>`;
  return groups.map((g) => releaseDividerHtml(g.release) + `<div class="dl-pop-rows">${doneLinesHtml(g.rows, open)}</div>`).join("");
}
