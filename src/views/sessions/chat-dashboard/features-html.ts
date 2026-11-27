// The merged Plan card's feature lines as markup (features-card.ts owns the DOM around it). Pure:
// strings in, strings out, so a spec reads the same HTML the card draws. One line per feature, the
// title with its todo and ticket ids under it as icons, a trail of one kind icon per chat coloured
// by the chat-state tokens, and a fixed time column; the opened feature shows one chat's plan.

import { escapeHtml } from "../../../shared/escape-html";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import { CHAT_KIND_INFO } from "../../../shared/chat/chat-kinds";
import { shortDateTime } from "../../../shared/formatters";
import { trackerSvg, TRACKER_NAME } from "../../../shared/tracker-icons";
import { foldTrail, mostUrgent, trailSlots, type ChatState, type FeatureChat, type FeatureRow, type FeaturesState } from "../../../shared/chat/dashboard/features-model";

const esc = escapeHtml;

/** Chats a feature's trail draws as plain icons; past it the finished fold into a +N (the Done card's
 *  trail keeps this limit and its own rule). */
export const TRAIL_MAX = 5;

export interface FeaturesHtmlCtx {
  /** Key of the opened feature, or null. */
  open: string | null;
  /** Icon slots a trail has at the card's width (`trailSlots`); unset reads as the widest. */
  slots?: number;
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

function iconHtml(row: FeatureRow, c: FeatureChat, ctx: FeaturesHtmlCtx): string {
  const on = ctx.open === row.key && ctx.selOf(row).id === c.id;
  const info = CHAT_KIND_INFO[c.kind];
  return `<button type="button" class="pf-ti${on ? " is-sel" : ""}" data-st="${c.state}" data-act="pf-chat" data-feat="${esc(row.key)}" data-chat="${esc(c.id)}"${chatMenuAttr(c.id)} aria-pressed="${on}" aria-label="${esc(info.label)}: ${esc(c.name)}, ${esc(c.item.progress)}"><i class="ph ph-${info.icon}"></i></button>`;
}

const STATE_WORD: Record<ChatState, string> = { asking: "asking", working: "working", queued: "queued", idle: "queued", done: "finished" };

/** "1 working, 3 queued": the states inside a +N, most urgent first (the list a +N holds is already in that order). */
function summary(chats: readonly FeatureChat[]): string {
  const n = new Map<string, number>();
  for (const c of chats) n.set(STATE_WORD[c.state], (n.get(STATE_WORD[c.state]) ?? 0) + 1);
  return [...n].map(([w, k]) => `${k} ${w}`).join(", ");
}

/** A +N: the chats a many-chat line folds. `which` tells FeaturesCard which list to open
 *  (`foldTrail` gives it again), the colour is the most urgent chat inside. */
function foldHtml(row: FeatureRow, ctx: FeaturesHtmlCtx, which: "done" | "rest", list: readonly FeatureChat[]): string {
  const sel = ctx.open === row.key && list.some((c) => c.id === ctx.selOf(row).id);
  const noun = list.length === 1 ? "chat" : "chats";
  const title = which === "done" ? `${list.length} finished ${noun}` : `${list.length} more ${noun}`;
  const tip = which === "done" ? title : `${title}: ${summary(list)}`;
  return `<button type="button" class="pf-fold${sel ? " is-sel" : ""}" data-st="${mostUrgent(list)}" data-act="pf-fold" data-feat="${esc(row.key)}" data-which="${which}" data-tip="${esc(tip)}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(tip)}">+${list.length}</button>`;
}

/** Up to TRAIL_MAX chats draw one icon each, in the order they started. Past that the finished fold
 *  into a green +N at the front and, when the rest do not fit the card's width, the queued (then the
 *  working) into one at the end; a state is all icons or all in a +N (`foldTrail`). */
function trailHtml(row: FeatureRow, ctx: FeaturesHtmlCtx): string {
  if (row.chats.length <= TRAIL_MAX) return `<span class="pf-trail">${row.chats.map((c) => iconHtml(row, c, ctx)).join("")}</span>`;
  const f = foldTrail(row.chats, ctx.slots ?? trailSlots(0));
  return `<span class="pf-trail">${f.done.length > 0 ? foldHtml(row, ctx, "done", f.done) : ""}${f.shown.map((c) => iconHtml(row, c, ctx)).join("")}${f.rest.length > 0 ? foldHtml(row, ctx, "rest", f.rest) : ""}</span>`;
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
