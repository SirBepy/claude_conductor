// The Plan card (docs/chat-dashboard-design.md "Plan card across a chat's
// life"). It is always drawn. The latest job stays on it: its plan while it
// runs, its plan with the Result once it ends, and dimmed as "Last job" once Joe
// has written again with no new plan. Earlier plans are a pager in the header
// (older, the list, newer); the middle button swaps the card's body for the
// list of earlier plans and back. While an earlier plan shows, the status line
// at the foot is the way back to the current one.

import { escapeHtml } from "../../../shared/escape-html";
import { localTime } from "../../../shared/formatters";
import { renderMarkdown } from "../../../shared/chat/chat-transforms";
import { headlineOf } from "../../../shared/chat/chat-message-kinds";
import type { RenderedMessage } from "../../../shared/chat/chat-classifiers";
import { rowMs, type IdleStatus, type PlanJob, type PlanState, type PlanStep } from "../../../shared/chat/dashboard/dashboard-model";

/** What the Plan card remembers between derives. In memory only, like the rest
 *  of DashUi: each is one click to redo after a reload. */
export interface PlanUi {
  /** Key of the earlier job shown in the card, or null for the current one. */
  planSel: string | null;
  /** The list of earlier plans fills the card. */
  planList: boolean;
  /** What the list was opened over, so closing it goes back there. */
  planListFrom: string | null;
  planSearch: string;
  /** Key (`job key:index:label`) of the step whose times are open. */
  openStep: string | null;
}

export function initialPlanUi(): PlanUi {
  return { planSel: null, planList: false, planListFrom: null, planSearch: "", openStep: null };
}

export interface PlanCtx {
  ui: PlanUi;
  /** A turn is running: the chat's own status line is moved into the foot. */
  busy: boolean;
  /** When the view saw the last turn end (ms), later than any row stamp. */
  idleAt: number | null;
  /** Renders a message card the way the transcript does (cached per row). */
  card: (m: RenderedMessage) => string;
  /** Clock for "Yesterday" in the list; tests pass their own. */
  now?: number;
}

const STEP_ICON: Record<PlanStep["status"], string> = {
  done: "ph-check-circle",
  active: "ph-circle-notch",
  pending: "ph-circle",
  skipped: "ph-minus-circle",
};

/** Lists past this many earlier plans get a search box. */
const SEARCH_FROM = 7;

export const stepKey = (job: PlanJob, i: number, step: PlanStep): string => `${job.key}:${i}:${step.label}`;

const clock = (ms: number): string => localTime(new Date(ms));

/** "40s", "2 min", "1 h 5 min". */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayName(ms: number, now: number): string {
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - 86_400_000)) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** A step opens on click: its detail line, when it ran ("14:43 to 14:45" on its
 *  own line, room for more later) and how long, on the step's own row. */
function stepHtml(job: PlanJob, i: number, step: PlanStep, ui: PlanUi): string {
  const key = stepKey(job, i, step);
  const ran = step.startedAt !== undefined;
  const opens = ran || !!step.detail;
  const open = opens && ui.openStep === key;
  // A finished job's step still pending or active was never ticked off: it is
  // not running, so it gets no spinner, and says so on hover.
  const left = job.ended && (step.status === "pending" || step.status === "active");
  const icon = `<i class="ph ${left ? "ph-circle-dashed" : STEP_ICON[step.status]}"></i>`;
  const cls = `cdash-step cdash-step--${left ? "left" : step.status}${open ? " open" : ""}`;
  const leftTip = left ? ` title="Not ticked off before the job ended"` : "";
  const label = `<span class="cdash-step-l">${escapeHtml(step.label)}</span>`;
  if (!opens) return `<div class="${cls}"${leftTip}>${icon}<span class="cdash-step-b">${label}</span></div>`;
  let len = "";
  let range = "";
  if (open && ran) {
    const end = step.doneAt;
    len = `<em class="cdash-step-len">${end !== undefined ? spanText(end - step.startedAt!) : left ? "not ticked off" : "running"}</em>`;
    range = `<em class="cdash-step-t">${escapeHtml(clock(step.startedAt!))} to ${end !== undefined ? escapeHtml(clock(end)) : left ? "the job's end" : "now"}</em>`;
  }
  const detail = open && step.detail ? `<em class="cdash-step-d">${escapeHtml(step.detail)}</em>` : "";
  const tip = left ? "Not ticked off before the job ended" : open ? "Hide its details" : "Show when it ran";
  return `<button type="button" class="${cls}" data-act="step" data-step="${escapeHtml(key)}" aria-expanded="${open}" title="${tip}">${icon}`
    + `<span class="cdash-step-b"><span class="cdash-step-row">${label}${len}</span>${range}${detail}</span></button>`;
}

function stepsHtml(job: PlanJob, ui: PlanUi): string {
  if (job.steps.length === 0) return "";
  return `<div class="cdash-steps">${job.steps.map((st, i) => stepHtml(job, i, st, ui)).join("")}</div>`;
}

/** A job's body: its lead, its steps, and its report once it has one. */
function jobBody(job: PlanJob, ctx: PlanCtx): string {
  const lead = job.lead?.text ? `<div class="cdash-plan-lead">${renderMarkdown(headlineOf(job.lead.text))}</div>` : "";
  const result = job.result ? `<div class="cdash-result">${ctx.card(job.result)}</div>` : "";
  return `${lead}${stepsHtml(job, ctx.ui)}${result}`;
}

/** The foot's resting line: waiting on Joe's answer, or idle since when. */
function idleLine(status: IdleStatus, idleAt: number | null): string {
  if (status.kind === "wait") {
    const since = status.since ? ` · asked ${escapeHtml(clock(status.since))}` : "";
    return `<div class="cdash-pstatus is-wait"><i class="ph ph-chat-circle"></i><span><b>Waiting on your answer</b>${since}</span></div>`;
  }
  const at = Math.max(status.since ?? 0, idleAt ?? 0);
  return `<div class="cdash-pstatus"><span class="cdash-pdot"></span><span>${at ? `Idle since <b>${escapeHtml(clock(at))}</b>` : "Idle"}</span></div>`;
}

/** The foot. The chat's real status line (Stop, elapsed, its detail block) is
 *  moved into the slot while a turn runs; otherwise the resting line shows. On
 *  an earlier plan the whole foot is the way back to the current one. */
function statusSlot(s: PlanState, ctx: PlanCtx, away: boolean, hidden = false): string {
  const rest = ctx.busy ? "" : idleLine(s.status, ctx.idleAt);
  const awayAttrs = away ? ` role="button" tabindex="0" title="Back to the current plan"` : "";
  const go = away ? `<i class="ph ph-arrow-line-right cdash-away-go"></i>` : "";
  return `<div class="cdash-status${away ? " is-away" : ""}" data-slot="status"${awayAttrs}${hidden ? " hidden" : ""}>${rest}${go}</div>`;
}

/** Three fixed slots (older, the list, newer), so nothing in the header moves
 *  as Joe steps through. On the current plan the middle shows how many earlier
 *  plans there are; on an earlier one, where it is. */
function navHtml(all: readonly PlanJob[], at: number | null, list: boolean): string {
  const last = all.length - 1;
  const pos = at ?? last;
  const mid = at === null
    ? `<i class="ph ph-clock-counter-clockwise"></i>${last}`
    : `${pos + 1} / ${all.length}`;
  const midTitle = list ? "Close the list" : at === null ? `All ${last} earlier ${last === 1 ? "plan" : "plans"}` : "All plans";
  return `<span class="cdash-pnav">`
    + `<button type="button" data-act="plan-prev" title="Older plan"${pos === 0 || list ? " disabled" : ""}><i class="ph ph-caret-left"></i></button>`
    + `<button type="button" class="cdash-pnav-mid${list ? " on" : ""}" data-act="plan-list" title="${midTitle}" aria-expanded="${list}">${mid}</button>`
    + `<button type="button" data-act="plan-next" title="Newer plan"${at === null ? " hidden" : ""}${list ? " disabled" : ""}><i class="ph ph-caret-right"></i></button>`
    + `</span>`;
}

function listHtml(earlier: readonly PlanJob[], ui: PlanUi, now: number): string {
  const newest = [...earlier].reverse();
  const days = new Set(newest.map((j) => (j.startedAt ? dayKey(j.startedAt) : "")));
  const q = ui.planSearch.trim().toLowerCase();
  let day: string | null = null;
  const rows: string[] = [];
  for (const j of newest) {
    if (days.size > 1 && j.startedAt) {
      const d = dayName(j.startedAt, now);
      if (d !== day) {
        day = d;
        rows.push(`<div class="cdash-pl-day">${escapeHtml(d)}</div>`);
      }
    }
    const verdict = j.result?.card?.verdict ?? "";
    const hay = `${j.title} ${verdict}`.toLowerCase();
    const hidden = q && !hay.includes(q) ? " hidden" : "";
    const done = j.result || (j.steps.length > 0 && j.steps.every((s) => s.status === "done" || s.status === "skipped"));
    rows.push(`<button type="button" class="cdash-pl-row${ui.planSel === j.key ? " on" : ""}" data-act="plan-pick" data-key="${escapeHtml(j.key)}" data-q="${escapeHtml(hay)}"${hidden}>`
      + `<i class="ph ${done ? "ph-check-circle" : "ph-circle-dashed"}"></i><span class="cdash-pl-t">${escapeHtml(j.title || "Plan")}</span>`
      + `<em class="cdash-pl-at">${j.startedAt ? escapeHtml(clock(j.startedAt)) : ""}</em>`
      + (verdict ? `<em class="cdash-pl-v">${escapeHtml(verdict)}</em>` : "")
      + `</button>`);
  }
  const search = earlier.length >= SEARCH_FROM
    ? `<label class="cdash-pl-search"><i class="ph ph-magnifying-glass"></i><input type="text" placeholder="Search plans" value="${escapeHtml(ui.planSearch)}" aria-label="Search plans"></label>` : "";
  return `${search}<div class="cdash-pl-wrap"><div class="cdash-pl">${rows.join("")}</div></div>`;
}

const head = (icon: string, title: string, extra = ""): string =>
  `<h4 class="cdash-h"><i class="ph ${icon}"></i><span class="cdash-h-t">${title}</span>${extra}</h4>`;

const at = (ms: number | null): string => (ms ? ` <em class="cdash-h-at">${escapeHtml(clock(ms))}</em>` : "");

export function renderPlan(s: PlanState, ctx: PlanCtx): string {
  const ui = ctx.ui;
  const all = s.job ? [...s.earlier, s.job] : [];
  const selIdx = ui.planSel === null ? -1 : s.earlier.findIndex((j) => j.key === ui.planSel);
  const sel = selIdx >= 0 ? selIdx : null;
  const list = ui.planList && s.earlier.length > 0;
  const nav = s.earlier.length > 0 ? navHtml(all, sel, list) : "";
  const wrap = (cls: string, inner: string): string => `<section class="cdash-zone cdash-card cdash-plan${cls}">${inner}</section>`;

  if (list) {
    return wrap(" is-list", `${head("ph-clock-counter-clockwise", "Earlier plans", nav)}<div class="cdash-pbody">${listHtml(s.earlier, ui, ctx.now ?? Date.now())}</div>${statusSlot(s, ctx, false, true)}`);
  }
  if (sel !== null) {
    const job = s.earlier[sel]!;
    return wrap(" is-earlier", `${head("ph-clock-counter-clockwise", `Plan${at(job.startedAt)}`, nav)}<div class="cdash-pbody">${jobBody(job, ctx)}</div>${statusSlot(s, ctx, true)}`);
  }
  if (s.mode === "empty" || !s.job) {
    const none = ctx.busy ? "No plan yet." : "Nothing planned yet.";
    return wrap(" is-empty", `${head("ph-list-checks", "Plan", nav)}<div class="cdash-pbody"><div class="cdash-pnone">${none}</div></div>${statusSlot(s, ctx, false)}`);
  }
  const job = s.job;
  if (s.mode === "last") {
    const when = job.result?.ts ? at(rowMs(job.result)) : at(job.startedAt);
    return wrap(" is-last", `${head("ph-flag-checkered", `Last job${when}`, nav)}<div class="cdash-pbody cdash-dim">${jobBody(job, ctx)}</div>${statusSlot(s, ctx, false)}`);
  }
  const ended = !!job.result;
  return wrap(ended ? " is-result" : "", `${head(ended ? "ph-flag-checkered" : "ph-list-checks", ended ? "Result" : "Plan", nav)}<div class="cdash-pbody">${jobBody(job, ctx)}</div>${statusSlot(s, ctx, false)}`);
}

/** Filters the list in place as Joe types, so the box keeps its focus. */
export function filterPlanList(root: HTMLElement, query: string): void {
  const q = query.trim().toLowerCase();
  for (const row of root.querySelectorAll<HTMLElement>(".cdash-pl-row")) {
    row.hidden = !!q && !(row.dataset.q ?? "").includes(q);
  }
  for (const day of root.querySelectorAll<HTMLElement>(".cdash-pl-day")) {
    // A day heading hides with all its rows.
    let n = day.nextElementSibling as HTMLElement | null;
    let any = false;
    while (n && !n.classList.contains("cdash-pl-day")) {
      if (!n.hidden) any = true;
      n = n.nextElementSibling as HTMLElement | null;
    }
    day.hidden = !any;
  }
}

/** The list scrolls with no scrollbar; a fade says more rows wait below. */
export function syncPlanListFade(root: HTMLElement): void {
  const pl = root.querySelector<HTMLElement>(".cdash-pl");
  if (!pl) return;
  pl.parentElement?.classList.toggle("has-more", pl.scrollTop + pl.clientHeight < pl.scrollHeight - 4);
}
