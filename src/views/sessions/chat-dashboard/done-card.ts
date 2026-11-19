// The Done card (docs/chat-dashboard-design.md, "Result and the Done card"): a
// checked-off list of what the chat's subs finished, one row per TASK, not per
// sub. A compact row is a tick, the task, a warning when a chat of it ran out of
// context and how long ago it was done ("20 min ago"): no avatar and no chevron, the
// whole row is the button. A click opens the details: the chats it took as an avatar
// stack with the full date and time, the todo id with an Open todo button, then each
// chat of the task with when it finished, the context it ended at and its finish card. The list scrolls inside a
// bounded height. A dismiss closes the task's subs through the app's own Close (a
// chat stays in history and wakes on a message); the optimistic part lives in
// chat-dashboard.ts, which marks a task `leaving` so its row animates out at once.
//
// MOTION. The dashboard replaces this card's whole HTML on every redraw (renderZones
// in chat-dashboard.ts), so a class flip on the old DOM can never transition. The HTML
// this file returns is therefore always the SETTLED state, and `<dn-list>` plays the
// change on connect: it compares the rows it was given with what the same dashboard's
// list held last time (`memory`), puts each changed row back in its old state for one
// frame, forces a reflow and lets the CSS transitions (done-card.css) run to the new
// one. A redraw that changes nothing visible plays nothing, so a data tick never
// replays an animation. The memory holds the settled state, so a second redraw that lands while a
// change is still moving snaps that change to its end rather than continuing it. A node the new HTML no longer holds (a collapsed detail, a row
// that vanished) is re-inserted from the HTML kept in memory as a ghost, shut, and
// removed at transitionend.

import { escapeHtml } from "../../../shared/escape-html";
import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import { agoLabel, type DoneState, type DoneTask } from "../../../shared/chat/dashboard/dashboard-model";
import { ringHtml, type RingSpec } from "../sidebar-ring";
import { avatarHtml } from "./sub-avatar";
import { chatMenuAttr } from "../../../shared/chat/chat-menu-target";
import "./done-card.css";

/** Context used (percent) from which a chat counts as having used too much: the
 *  status bar chip's own danger tier (statusbar-chips.ts). */
export const CTX_TOO_MUCH_PCT = 80;

/** Avatars the row's stack draws before the rest collapse into "+N". */
export const STACK_MAX = 3;

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
  /** A finish time as the full date and time ("19 Nov, 6:26 pm"), shown in the opened row. */
  full: (ms: number) => string;
}

/** The "N chats" count: the stack's text alternative. */
export function chatCount(n: number): string {
  return `${n} ${n === 1 ? "chat" : "chats"}`;
}

/** A task used too much context when any of its chats ended at or past the limit. */
export function overContext(t: DoneTask, ctxPct: DoneCtx["ctxPct"]): boolean {
  return t.subs.some(({ sub }) => (ctxPct(sub.id) ?? 0) >= CTX_TOO_MUCH_PCT);
}

function subRow(item: DoneTask["subs"][number], ctx: DoneCtx, i: number): string {
  const { sub, report } = item;
  const id = escapeHtml(sub.id);
  const open = ctx.card === sub.id && report !== null;
  const line = report?.subCard?.verdict?.trim() || sub.progress;
  const at = sub.finishedAt !== null ? `<em class="dn-at">${escapeHtml(ctx.when(sub.finishedAt))}</em>` : "";
  const main = `<button type="button" class="dn-sub-main" data-act="done-card" data-sub="${id}" aria-expanded="${open}"${report ? "" : " disabled"}>`
    + `<span class="dn-line">${escapeHtml(line)}</span>${at}${ctx.ctxChip(sub.id)}</button>`;
  return `<div class="dn-sub${open ? " is-open" : ""}" data-sub="${id}" style="--i:${i}"${chatMenuAttr(sub.id)}>`
    + `<span class="dn-av"${report ? ` data-act="done-card" data-sub="${id}"` : ""}>${avatarHtml(sub, ringHtml(sub.ring as RingSpec), false)}</span>${main}</div>`
    + (open ? `<div class="dn-card"><div class="dn-card-in">${ctx.cardHtml(report!)}</div></div>` : "");
}

function details(t: DoneTask, ctx: DoneCtx): string {
  const full = t.doneAt !== null ? `<span class="dn-sep">&middot;</span><time class="dn-full">${escapeHtml(ctx.full(t.doneAt))}</time>` : "";
  const meta = `<div class="dn-meta" style="--i:0">${stack(t)}<span class="dn-n">${chatCount(t.subs.length)}</span>${full}</div>`;
  const todo = t.todoId
    ? `<div class="dn-todo" style="--i:1"><span class="dn-todo-id">${escapeHtml(t.todoId)}</span>`
      + `<button type="button" class="dn-todo-btn" data-act="done-todo" data-todo="${escapeHtml(t.todoId)}"><i class="ph ph-list-checks"></i>Open todo</button></div>`
    : "";
  const first = t.todoId ? 2 : 1;
  return `<div class="dn-det"><div class="dn-det-in"><div class="dn-detail">${meta}${todo}${t.subs.map((s, i) => subRow(s, ctx, first + i)).join("")}</div></div></div>`;
}

/** The chats of a task as overlapping avatars (the Subchats card's own, so a ring and a hover card
 *  mean the same here), the last of them on top. Drawn only inside the opened row. They are no tab
 *  stops: the row's button is the one control. */
function stack(t: DoneTask): string {
  const shown = t.subs.slice(0, STACK_MAX);
  const faces = shown.map(({ sub }) => `<span class="dn-avs-i">`
    + `${avatarHtml(sub, ringHtml(sub.ring as RingSpec), false).replace("<button ", `<button tabindex="-1" `)}</span>`).join("");
  const more = t.subs.length > STACK_MAX ? `<span class="dn-avs-more">+${t.subs.length - STACK_MAX}</span>` : "";
  return `<span class="dn-avs">${faces}${more}</span>`;
}

function taskRow(t: DoneTask, ctx: DoneCtx): string {
  const key = escapeHtml(t.key);
  const open = ctx.open === t.key;
  // A sub already closing is not dismissed again, so it does not hold the row back from leaving.
  const live = t.subs.filter((s) => !s.sub.closing);
  const leaving = live.length > 0 && live.every((s) => ctx.leaving.has(s.sub.id));
  const warn = overContext(t, ctx.ctxPct)
    ? `<span class="dn-warn" title="A chat of this task used most of its context"><i class="ph ph-warning"></i></span>` : "";
  // The text is filled by fillAgo (on connect and on the card's tick), so the label ageing never
  // changes the HTML the dashboard diffs and never redraws the row.
  const at = t.doneAt !== null ? `<em class="dn-at" data-ms="${t.doneAt}" title="${escapeHtml(ctx.full(t.doneAt))}"></em>` : "";
  // A task already closing has nothing to dismiss; its row leaves with the instance list.
  const x = t.closing
    ? `<span class="dn-closing">closing</span>`
    : `<button type="button" class="dn-x" data-act="done-dismiss" data-task="${key}" title="Dismiss: closes ${t.subs.length === 1 ? "this chat" : "these chats"} (a message to one wakes it again)" aria-label="Dismiss ${escapeHtml(t.title)}"><i class="ph ph-x"></i></button>`;
  return `<div class="dn-task${open ? " is-open" : ""}${leaving ? " is-leaving" : ""}${t.closing ? " is-closing" : ""}" data-task="${key}"><div class="dn-in">`
    + `<div class="dn-row"><button type="button" class="dn-main" data-act="done-open" data-task="${key}" aria-expanded="${open}">`
    + `<i class="ph ph-check-circle dn-tick"></i><span class="dn-title">${escapeHtml(t.title)}</span>${warn}</button>`
    + `${at}${x}</div>`
    + (open ? details(t, ctx) : "")
    + `</div></div>`;
}

/** The list inside its bounded, scrolling box. */
export function renderDone(s: DoneState, ctx: DoneCtx): string {
  return `<dn-list class="dn-list" data-dn="${dashboardId(ctx.leaving)}">${s.tasks.map((t) => taskRow(t, ctx)).join("")}</dn-list>`;
}

/** Writes each compact row's "20 min ago" from its `data-ms`; touches a node only when its text
 *  changes, so the minute tick is a no-op for every row that did not cross a unit. */
export function fillAgo(root: ParentNode, now = Date.now()): void {
  for (const el of root.querySelectorAll<HTMLElement>(".dn-at[data-ms]")) {
    const text = agoLabel(Number(el.dataset.ms), now);
    if (el.textContent !== text) el.textContent = text;
  }
}

// ---- Motion ---------------------------------------------------------------------------

/** What `<dn-list>` last settled to for one task. */
interface TaskMem {
  open: boolean;
  leaving: boolean;
  /** The row as drawn, for a ghost when the row vanishes without a dismiss. */
  html: string;
  /** The opened details as drawn, for a ghost when they fold. */
  det: string | null;
  /** The finish card open under one of the task's chats, as drawn. */
  card: { sub: string; html: string } | null;
}

/** One dashboard's rows as of its last draw. The dashboard's own `leaving` set is the key
 *  (renderDone sees no other per-dashboard object), so two dashboards never share a memory. */
const memory = new Map<string, Map<string, TaskMem>>();
const dashboardIds = new WeakMap<object, string>();
let nextId = 1;

function dashboardId(owner: object): string {
  let id = dashboardIds.get(owner);
  if (!id) {
    id = String(nextId++);
    dashboardIds.set(owner, id);
  }
  return id;
}

const EXIT_FALLBACK_MS = 800;

/** Removes a ghost once its fold has run. The timer is only the net for a transition that never
 *  fires (a node already hidden, a tab in the background). */
function retire(el: HTMLElement): void {
  const done = (): void => el.remove();
  el.addEventListener("transitionend", (e) => {
    if (e.target === el || (e.target as HTMLElement).parentElement === el) {
      if ((e as TransitionEvent).propertyName === "grid-template-rows") done();
    }
  });
  window.setTimeout(done, EXIT_FALLBACK_MS);
}

function ghostFrom(html: string, cls: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  const el = t.content.firstElementChild as HTMLElement;
  el.classList.add("is-ghost", cls);
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("inert", "");
  return el;
}

function readTask(row: HTMLElement): TaskMem {
  const det = row.querySelector<HTMLElement>(":scope > .dn-in > .dn-det");
  const card = row.querySelector<HTMLElement>(".dn-card");
  const owner = card?.previousElementSibling as HTMLElement | null;
  return {
    open: row.classList.contains("is-open"),
    leaving: row.classList.contains("is-leaving"),
    html: row.outerHTML,
    det: det ? det.outerHTML : null,
    card: card && owner?.dataset.sub ? { sub: owner.dataset.sub, html: card.outerHTML } : null,
  };
}

/** Puts every row that changed back to how it looked before, and returns what flips it forward.
 *  Called once per connect; the caller reflows between the two. */
function rewind(list: HTMLElement, prev: Map<string, TaskMem>, now: Map<string, TaskMem>): Array<() => void> {
  const forward: Array<() => void> = [];
  const rows = new Map<string, HTMLElement>();
  for (const el of list.children) if (el instanceof HTMLElement && el.dataset.task !== undefined) rows.set(el.dataset.task, el);

  for (const [key, row] of rows) {
    const was = prev.get(key);
    const is = now.get(key)!;
    const inner = row.querySelector<HTMLElement>(":scope > .dn-in")!;
    // A row that was leaving and is back (a close the daemon refused) enters again like a new one.
    if (!was || (was.leaving && !is.leaving)) {
      row.classList.add("is-new");
      forward.push(() => row.classList.remove("is-new"));
      continue;
    }
    if (!was.leaving && is.leaving) {
      row.classList.remove("is-leaving");
      forward.push(() => row.classList.add("is-leaving"));
    }
    if (!was.open && is.open) {
      const det = inner.querySelector<HTMLElement>(":scope > .dn-det");
      row.classList.remove("is-open");
      det?.classList.add("is-shut");
      forward.push(() => {
        row.classList.add("is-open");
        det?.classList.remove("is-shut");
      });
    } else if (was.open && !is.open && was.det) {
      const ghost = ghostFrom(was.det, "dn-det-ghost");
      inner.appendChild(ghost);
      row.classList.add("is-open");
      forward.push(() => {
        row.classList.remove("is-open");
        ghost.classList.add("is-shut");
        retire(ghost);
      });
    } else if (was.open && is.open && was.card?.sub !== is.card?.sub) {
      // The card of one chat folds while another's (or none) opens.
      if (is.card) {
        const card = row.querySelector<HTMLElement>(".dn-card");
        card?.classList.add("is-shut");
        forward.push(() => card?.classList.remove("is-shut"));
      }
      const owner = was.card ? row.querySelector<HTMLElement>(`.dn-sub[data-sub="${CSS.escape(was.card.sub)}"]`) : null;
      if (was.card && owner) {
        const ghost = ghostFrom(was.card.html, "dn-card-ghost");
        owner.after(ghost);
        forward.push(() => {
          ghost.classList.add("is-shut");
          retire(ghost);
        });
      }
    }
  }

  // A row the new HTML dropped without Joe dismissing it (another window closed it): it folds away
  // where it stood. A dismissed row already played its exit, so it is not drawn again.
  const order = [...prev.keys()];
  order.forEach((key, i) => {
    const was = prev.get(key)!;
    if (rows.has(key) || was.leaving) return;
    const ghost = ghostFrom(was.html, "dn-task-ghost");
    const after = order.slice(i + 1).map((k) => rows.get(k)).find(Boolean) ?? null;
    list.insertBefore(ghost, after);
    forward.push(() => {
      ghost.classList.add("is-leaving");
      retire(ghost);
    });
  });
  return forward;
}

function settle(list: HTMLElement): void {
  const id = list.dataset.dn ?? "";
  const now = new Map<string, TaskMem>();
  for (const el of list.children) if (el instanceof HTMLElement && el.dataset.task !== undefined) now.set(el.dataset.task, readTask(el));
  const prev = memory.get(id);
  memory.set(id, now);
  // The first draw of a dashboard, or a redraw that changed nothing, plays nothing.
  if (!prev) return;
  const forward = rewind(list, prev, now);
  if (forward.length === 0) return;
  void list.offsetHeight;
  for (const f of forward) f();
}

if (typeof customElements !== "undefined" && typeof HTMLElement !== "undefined" && !customElements.get("dn-list")) {
  customElements.define("dn-list", class extends HTMLElement {
    private played = false;

    connectedCallback(): void {
      // Moving the zone (insertBefore) reconnects the same element: its change was played on the
      // first connect, and settling again would diff against a list that already holds ghosts.
      if (this.played) return;
      this.played = true;
      fillAgo(this);
      settle(this);
    }

    disconnectedCallback(): void {
      const id = this.dataset.dn ?? "";
      const doc = this.ownerDocument;
      // A redraw removes this list and connects its replacement in the same task, so only a list
      // that is still gone a microtask later (the card left the dashboard) forgets its rows.
      queueMicrotask(() => {
        if (!doc.querySelector(`dn-list[data-dn="${id}"]`)) memory.delete(id);
      });
    }
  });
}
