// The finished tray under Result (docs/chat-dashboard-design.md, "Result and the
// finished tray"): every sub that finished and has not been dismissed, one row
// each: its avatar (the name is on its hover card), the verdict of its finish card
// as the one line, the context it ended with, and a Dismiss x. A click on the row
// opens the finish card under it. Dismiss closes the sub through the app's own
// Close, so its process stops and its chat stays in history; the instance list
// then drops the row, so nothing is stored here about what was dismissed.

import { escapeHtml } from "../../../shared/escape-html";
import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import type { FinishedState } from "../../../shared/chat/dashboard/dashboard-model";
import { ringHtml, type RingSpec } from "../sidebar-ring";
import { avatarHtml } from "./sub-avatar";
import "./finished-tray.css";

export interface FinishedCtx {
  /** Id of the sub whose finish card is open, or null. */
  open: string | null;
  /** Renders a message card the way the transcript does (cached per row). */
  card: (m: RenderedMessage) => string;
  /** The context chip a finished sub ended with, "" until it has been read. */
  ctxChip: (subId: string) => string;
}

export function renderFinished(s: FinishedState, ctx: FinishedCtx): string {
  const rows = s.items.map(({ sub, report }) => {
    const open = ctx.open === sub.id && report !== null;
    const line = report?.subCard?.verdict?.trim() || sub.progress;
    const id = escapeHtml(sub.id);
    // Closing is a dismiss already in flight: the row stays until the instance list drops it.
    const dismiss = sub.closing
      ? `<span class="ft-closing">closing</span>`
      : `<button type="button" class="ft-x" data-act="finished-dismiss" data-sub="${id}" title="Dismiss: closes this chat (a message to it wakes it again)" aria-label="Dismiss ${escapeHtml(sub.name)}"><i class="ph ph-x"></i></button>`;
    const main = `<button type="button" class="ft-main" data-act="finished-open" data-sub="${id}" aria-expanded="${open}"${report ? "" : " disabled"}>`
      + `<span class="ft-line">${escapeHtml(line)}</span>${ctx.ctxChip(sub.id)}</button>`;
    return `<div class="ft-row${open ? " is-open" : ""}${sub.closing ? " is-closing" : ""}" data-sub="${id}">`
      + `<span class="ft-av" data-act="finished-open" data-sub="${id}">${avatarHtml(sub, ringHtml(sub.ring as RingSpec), false)}</span>${main}${dismiss}</div>`
      + (open ? `<div class="ft-card">${ctx.card(report!)}</div>` : "");
  }).join("");
  return `<div class="ft-list">${rows}</div>`;
}
