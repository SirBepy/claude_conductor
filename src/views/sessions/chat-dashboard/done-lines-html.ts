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
export function doneLineHtml(row: FeatureRow, open: DoneOpen): string {
  const on = open.feat === row.key;
  const shown = row.chats.slice(-TRAIL_MAX);
  const trail = `<span class="pf-trail dl-trail">${shown.map(iconHtml).join("")}</span>`;
  return `<div class="pf-feat dl-feat${on ? " is-open" : ""}" data-feat="${esc(row.key)}">`
    + lineHtml(row, { act: "dl-open", open: on, trail })
    + `<div class="dl-det"><div class="dl-det-clip"><div class="dl-det-in"><div class="dl-chats">${row.chats.map((c) => chatRowHtml(row, c, open)).join("")}</div></div></div></div></div>`;
}

export function doneLinesHtml(rows: readonly FeatureRow[], open: DoneOpen): string {
  return rows.map((r) => doneLineHtml(r, open)).join("");
}

export interface DoneHeadState {
  /** The rows are showing. */
  shown: boolean;
  /** Features finished since Joe last looked, drawn as a badge while the card is folded. */
  fresh: number;
  /** More finished features wait in the popup. */
  hasMore: boolean;
}

/** The card's header: the Plan card's own `cdash-h` (same type, same icon size), the clock that opens
 *  the popup, and the fold toggle at the right edge where a chevron normally sits. The whole header is
 *  the toggle while the card is folded. */
export function doneHeadHtml(h: DoneHeadState): string {
  const word = h.shown ? "Hide" : "Show";
  const badge = h.fresh > 0 && !h.shown ? `<span class="dl-new" title="Finished since you last looked">${h.fresh} new</span>` : "";
  const earlier = h.hasMore
    ? `<button type="button" class="dl-earlier" data-act="dl-earlier" aria-haspopup="dialog" title="Earlier finished features" aria-label="Earlier finished features"><i class="ph ph-clock-counter-clockwise"></i></button>`
    : "";
  return `<h4 class="cdash-h dl-h" data-act="dl-toggle">`
    + `<button type="button" class="dl-tg" data-act="dl-toggle" aria-expanded="${h.shown}" title="${word} the finished features"><i class="ph ph-check-circle"></i><span class="cdash-h-t">Done</span>${badge}</button>`
    + `<span class="dl-gap"></span>${earlier}`
    + `<button type="button" class="dl-caret" data-act="dl-toggle" aria-expanded="${h.shown}" title="${word} the finished features" aria-label="${word} the finished features"><i class="ph ph-caret-down"></i></button></h4>`;
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
