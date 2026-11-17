// The Done card (docs/chat-dashboard-design.md, "Result and the Done card"): a
// checked-off list of what the chat's subs finished, one row per TASK, not per
// sub. A row says the task, a warning when a chat of it ran out of context, how
// many chats it took and when it was done. A click opens the details: the todo
// id with an Open todo button, then each chat of the task with when it finished,
// the context it ended at and its finish card. The list scrolls inside a bounded
// height. A dismiss closes the task's subs through the app's own Close (a chat
// stays in history and wakes on a message); the optimistic part lives in
// chat-dashboard.ts, which marks a task `leaving` so its row animates out at once.

import { escapeHtml } from "../../../shared/escape-html";
import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import type { DoneState, DoneTask } from "../../../shared/chat/dashboard/dashboard-model";
import { ringHtml, type RingSpec } from "../sidebar-ring";
import { avatarHtml } from "./sub-avatar";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import "./done-card.css";

/** Context used (percent) from which a chat counts as having used too much: the
 *  status bar chip's own danger tier (statusbar-chips.ts). */
export const CTX_TOO_MUCH_PCT = 80;

export interface DoneCtx {
  /** Key of the task whose details are open, or null. */
  open: string | null;
  /** Id of the sub whose finish card is open under its row, or null. */
  card: string | null;
  /** Sub ids Joe dismissed that are still animating out. */
  leaving: ReadonlySet<string>;
  /** Renders a message card the way the transcript does (cached per row). */
  cardHtml: (m: RenderedMessage) => string;
  /** The context chip a finished sub ended with, "" until it has been read. */
  ctxChip: (subId: string) => string;
  /** Percent of its window a finished sub ended with, null until it has been read. */
  ctxPct: (subId: string) => number | null;
  /** A finish time as the clock (today) or the day and clock. */
  when: (ms: number) => string;
}

/** The "N chats" count the row shows. */
export function chatCount(n: number): string {
  return `${n} ${n === 1 ? "chat" : "chats"}`;
}

/** A task used too much context when any of its chats ended at or past the limit. */
export function overContext(t: DoneTask, ctxPct: DoneCtx["ctxPct"]): boolean {
  return t.subs.some(({ sub }) => (ctxPct(sub.id) ?? 0) >= CTX_TOO_MUCH_PCT);
}

function subRow(item: DoneTask["subs"][number], ctx: DoneCtx): string {
  const { sub, report } = item;
  const id = escapeHtml(sub.id);
  const open = ctx.card === sub.id && report !== null;
  const line = report?.subCard?.verdict?.trim() || sub.progress;
  const at = sub.finishedAt !== null ? `<em class="dn-at">${escapeHtml(ctx.when(sub.finishedAt))}</em>` : "";
  const main = `<button type="button" class="dn-sub-main" data-act="done-card" data-sub="${id}" aria-expanded="${open}"${report ? "" : " disabled"}>`
    + `<span class="dn-line">${escapeHtml(line)}</span>${at}${ctx.ctxChip(sub.id)}</button>`;
  return `<div class="dn-sub${open ? " is-open" : ""}" data-sub="${id}"${chatMenuAttr(sub.id)}>`
    + `<span class="dn-av"${report ? ` data-act="done-card" data-sub="${id}"` : ""}>${avatarHtml(sub, ringHtml(sub.ring as RingSpec), false)}</span>${main}</div>`
    + (open ? `<div class="dn-card">${ctx.cardHtml(report!)}</div>` : "");
}

function details(t: DoneTask, ctx: DoneCtx): string {
  const todo = t.todoId
    ? `<div class="dn-todo"><span class="dn-todo-id">${escapeHtml(t.todoId)}</span>`
      + `<button type="button" class="dn-todo-btn" data-act="done-todo" data-todo="${escapeHtml(t.todoId)}"><i class="ph ph-list-checks"></i>Open todo</button></div>`
    : "";
  return `<div class="dn-detail">${todo}${t.subs.map((s) => subRow(s, ctx)).join("")}</div>`;
}

function taskRow(t: DoneTask, ctx: DoneCtx): string {
  const key = escapeHtml(t.key);
  const open = ctx.open === t.key;
  // A sub already closing is not dismissed again, so it does not hold the row back from leaving.
  const live = t.subs.filter((s) => !s.sub.closing);
  const leaving = live.length > 0 && live.every((s) => ctx.leaving.has(s.sub.id));
  const warn = overContext(t, ctx.ctxPct)
    ? `<span class="dn-warn" title="A chat of this task used most of its context"><i class="ph ph-warning"></i></span>` : "";
  const at = t.doneAt !== null ? `<em class="dn-at">${escapeHtml(ctx.when(t.doneAt))}</em>` : "";
  // A task already closing has nothing to dismiss; its row leaves with the instance list.
  const x = t.closing
    ? `<span class="dn-closing">closing</span>`
    : `<button type="button" class="dn-x" data-act="done-dismiss" data-task="${key}" title="Dismiss: closes ${t.subs.length === 1 ? "this chat" : "these chats"} (a message to one wakes it again)" aria-label="Dismiss ${escapeHtml(t.title)}"><i class="ph ph-x"></i></button>`;
  return `<div class="dn-task${open ? " is-open" : ""}${leaving ? " is-leaving" : ""}${t.closing ? " is-closing" : ""}" data-task="${key}">`
    + `<div class="dn-row"><button type="button" class="dn-main" data-act="done-open" data-task="${key}" aria-expanded="${open}">`
    + `<i class="ph ph-check-circle dn-tick"></i><span class="dn-title">${escapeHtml(t.title)}</span>${warn}`
    + `<span class="dn-n">${chatCount(t.subs.length)}</span>${at}</button>${x}</div>`
    + (open ? details(t, ctx) : "")
    + `</div>`;
}

/** The list inside its bounded, scrolling box. */
export function renderDone(s: DoneState, ctx: DoneCtx): string {
  return `<div class="dn-list">${s.tasks.map((t) => taskRow(t, ctx)).join("")}</div>`;
}
