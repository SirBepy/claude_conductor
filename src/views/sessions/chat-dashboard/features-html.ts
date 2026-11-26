// The merged Plan card's feature lines as markup (features-card.ts owns the DOM around it). Pure:
// strings in, strings out, so a spec reads the same HTML the card draws. One line per feature, the
// title with its todo and ticket ids under it as icons, a trail of one kind icon per chat coloured
// by the chat-state tokens, and a fixed time column; the opened feature shows one chat's plan.

import { escapeHtml } from "../../../shared/escape-html";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import { CHAT_KIND_INFO } from "../../../shared/chat/chat-kinds";
import { shortDateTime } from "../../../shared/formatters";
import { trackerSvg, TRACKER_NAME } from "../../../shared/tracker-icons";
import type { FeatureChat, FeatureRow, FeaturesState } from "../../../shared/chat/dashboard/features-model";

const esc = escapeHtml;

/** Icons drawn in a feature's trail before the rest fold into its Earlier list. */
export const TRAIL_MAX = 5;

export interface FeaturesHtmlCtx {
  /** Key of the opened feature, or null. */
  open: string | null;
  /** The chat a feature shows: Joe's pick, else the one that needs him or works. */
  selOf(row: FeatureRow): FeatureChat;
  /** The latest preview or image drawn inside the opened plan, "" when the feature has none. */
  pic(row: FeatureRow, sel: FeatureChat): string;
  /** The first line of a chat's task, "" until its brief was read. */
  task(chatId: string): string;
  /** The fixed host the reply box lives in (features-card.ts moves the live one into it). */
  slot(chatId: string): string;
}

const STEP_ICON: Record<string, string> = { done: "ph-check-circle", active: "ph-circle-notch", pending: "ph-circle", skipped: "ph-minus-circle" };

/** A chat's steps as the Plan card draws them, read only: the cursor and the text stay as they
 *  are on hover. A finished chat's step that was never ticked off reads as left open. */
export function chatStepsHtml(c: FeatureChat): string {
  if (!c.steps) return "";
  const finished = c.state === "done";
  return `<div class="cdash-steps pf-steps">${c.steps.map((st) => {
    const left = finished && (st.status === "pending" || st.status === "active");
    const icon = left ? "ph-circle-dashed" : (STEP_ICON[st.status] ?? "ph-circle");
    return `<div class="cdash-step cdash-step--${left ? "left" : st.status}"><i class="ph ${icon}"></i><span class="cdash-step-b"><span class="cdash-step-l">${esc(st.text)}</span></span></div>`;
  }).join("")}</div>`;
}

/** The ids under a title: icons, never words. The todo opens in the backlog panel, the ticket at its address.
 *  They stay folded away (features-card.css `.pf-ids`) until the line is opened. */
export function idsHtml(row: FeatureRow): string {
  const out: string[] = [];
  if (row.todoId) {
    out.push(`<button type="button" class="pf-lk" data-act="pf-todo" data-todo="${esc(row.todoId)}" data-tip="Todo ${esc(row.todoId)}" aria-label="Open todo ${esc(row.todoId)}"><i class="ph ph-check-square-offset"></i></button>`);
  }
  if (row.ticket) {
    const name = TRACKER_NAME[row.ticket.tracker];
    const label = `${esc(name)} ${esc(row.ticket.id)}`;
    const mark = trackerSvg(row.ticket.tracker, "pf-tk");
    // Its address when the chat's links name it; else the button copies the id, the one thing the card knows.
    out.push(row.ticket.url
      ? `<a class="pf-lk" href="${esc(row.ticket.url)}" data-tip="${label}" aria-label="Open ${label}">${mark}</a>`
      : `<button type="button" class="pf-lk" data-act="pf-ticket" data-ticket="${esc(row.ticket.id)}" data-tip="${label}" aria-label="Copy ${label}">${mark}</button>`);
  }
  return out.length > 0 ? `<span class="pf-ids"><span class="pf-ids-in">${out.join("")}</span></span>` : "";
}

/** The time column: how long ago the feature started (patched by fillAgo), the full date on hover. A
 *  finished feature (the Done card's line) says when it finished instead. */
export function whenHtml(row: FeatureRow, verb?: string): string {
  const at = row.doneAt ?? row.startedAt;
  if (at === null) return `<span class="pf-when"><span class="pf-ago">Queued</span></span>`;
  return `<span class="pf-when" data-tip="${verb ?? (row.doneAt !== null ? "Finished" : "Started")} ${esc(shortDateTime(at))}"><span class="dn-at pf-ago" data-ms="${at}"></span></span>`;
}

function trailHtml(row: FeatureRow, ctx: FeaturesHtmlCtx): string {
  const sel = ctx.selOf(row);
  const hidden = row.chats.length - TRAIL_MAX;
  const shown = hidden > 0 ? row.chats.slice(hidden) : row.chats;
  const more = hidden > 0
    ? `<button type="button" class="pf-earlier" data-act="pf-earlier" data-feat="${esc(row.key)}" title="${hidden} earlier ${hidden === 1 ? "chat" : "chats"}" aria-label="${hidden} earlier ${hidden === 1 ? "chat" : "chats"}"><i class="ph ph-clock-counter-clockwise"></i></button>` : "";
  return `<span class="pf-trail">${more}${shown.map((c) => {
    const on = ctx.open === row.key && sel.id === c.id;
    const info = CHAT_KIND_INFO[c.kind];
    return `<button type="button" class="pf-ti${on ? " is-sel" : ""}" data-st="${c.state}" data-act="pf-chat" data-feat="${esc(row.key)}" data-chat="${esc(c.id)}"${chatMenuAttr(c.id)} aria-pressed="${on}" aria-label="${esc(info.label)}: ${esc(c.name)}, ${esc(c.item.progress)}"><i class="ph ph-${info.icon}"></i></button>`;
  }).join("")}</span>`;
}

/** The opened feature: one chat's header, what it waits on or asks, its steps with the latest
 *  picture beside them, and its reply box. */
function bodyHtml(row: FeatureRow, c: FeatureChat, ctx: FeaturesHtmlCtx): string {
  const info = CHAT_KIND_INFO[c.kind];
  const job = c.state === "queued" ? ctx.task(c.id) || c.name : "";
  const why = c.state === "working" || c.state === "done" ? "" : c.why;
  const note = why ? `<div class="pf-${c.state === "asking" ? "ask" : "wait"}"><i class="ph ph-${c.state === "asking" ? "chat-circle-dots" : "clock"}"></i><span>${esc(why)}</span></div>` : "";
  const steps = chatStepsHtml(c);
  const pic = ctx.pic(row, c);
  const plan = steps || pic ? `<div class="pf-plan-wrap">${steps ? `<div class="pf-plan">${steps}</div>` : ""}${pic}</div>` : "";
  return `<div class="pf-body" data-st="${c.state}" data-chat="${esc(c.id)}">`
    + `<div class="pf-bh"${chatMenuAttr(c.id)}><i class="ph ph-${info.icon}"></i><b>${esc(info.label)}</b><span class="pf-bn">${esc(c.name)}</span><em>${esc(c.item.progress)}</em></div>`
    + (job ? `<div class="pf-job">${esc(job)}</div>` : "") + note + plan
    + ctx.slot(c.id) + `</div>`;
}

/** One line, the same markup on the Plan card (a feature in progress) and the Done card (a finished one):
 *  the title with its ids under it, the trail, the time. The caller names the click (`act`) and what
 *  the trail holds. */
export function lineHtml(row: FeatureRow, o: { act: string; open: boolean; trail: string; verb?: string }): string {
  return `<div class="pf-row" role="button" tabindex="0" aria-expanded="${o.open}" data-act="${o.act}" data-feat="${esc(row.key)}">`
    + `<span class="pf-rmain"><span class="pf-title" title="${esc(row.title)}">${esc(row.title)}</span>${idsHtml(row)}</span>${o.trail}${whenHtml(row, o.verb)}</div>`;
}

export function featureHtml(row: FeatureRow, ctx: FeaturesHtmlCtx): string {
  const open = ctx.open === row.key;
  return `<div class="pf-feat${open ? " is-open" : ""}${row.queued ? " is-queued" : ""}" data-feat="${esc(row.key)}">`
    + lineHtml(row, { act: "pf-feat", open, trail: trailHtml(row, ctx) })
    + (open ? bodyHtml(row, ctx.selOf(row), ctx) : "") + `</div>`;
}

export function featuresHtml(state: FeaturesState, ctx: FeaturesHtmlCtx): string {
  return state.rows.map((r) => featureHtml(r, ctx)).join("");
}
