import { escapeHtml } from "../../shared/escape-html";
import type { PlanStepSnapshot } from "../../types/ipc.generated";
import { STATIC_CHIPS } from "./statusline-catalog";
import type { QuestionProgress } from "./question-progress";
import { truncate } from "./project-dashboard/format";
import { planProgress } from "./sidebar-ring";
import type { RingTone } from "./sidebar-ring";
import type { SubKind } from "./main-chat";
import { localTime } from "../../shared/formatters";
import { formatActionAge, formatRunTime, type SubHover } from "../../shared/chat/dashboard/subs-model";

/** What the hover card needs from one row. Plain data so the builder is a
 *  pure string function (tests/sidebar-hover-card.test.mjs). */
export interface HoverCardInput {
  title: string;
  project: string;
  /** The row's `st-*` status class (`data-st` on the `<li>`). */
  st: string;
  plan: readonly PlanStepSnapshot[] | null | undefined;
  question: QuestionProgress | null;
  /** RFC3339 of the last busy/idle flip, or null before the first this run. */
  stateSince: string | null | undefined;
  /** Context window used, 0-100, or null while unknown / not yet fetched. */
  contextPct: number | null;
  now: number;
  /** A Use-subchats main chat's subs (main-chat.ts `hoverRows`). A non-empty
   *  list replaces the chat's own state and plan blocks: one chat has no single
   *  state once it has subs asking, working and finished. */
  subs?: ReadonlyArray<{ name: string; kind: SubKind; progress: string; tier?: string }>;
}

interface StateLine { label: string; tone: RingTone | "idle"; timer: "turn" | "waiting" | "ago" | null }

const STATE_LINES: Record<string, StateLine> = {
  "st-working": { label: "Working", tone: "working", timer: "turn" },
  "st-question": { label: "Needs your input", tone: "question", timer: "waiting" },
  "st-attention": { label: "Needs your permission", tone: "attention", timer: "waiting" },
  "st-done": { label: "Done, unread", tone: "done", timer: "ago" },
  "st-your-turn": { label: "Done", tone: "idle", timer: "ago" },
  "st-waiting": { label: "Waiting on a process", tone: "waiting", timer: "waiting" },
  "st-rate-limited": { label: "Usage limit, resumes on reset", tone: "rate-limited", timer: null },
  "st-external": { label: "External session", tone: "external", timer: null },
  "st-close-failed": { label: "Close did not confirm", tone: "close-failed", timer: null },
  "st-closing": { label: "Closing", tone: "closing", timer: null },
};

const TONE_VAR: Record<RingTone | "idle", string> = {
  working: "var(--st-working)", question: "var(--st-question)", done: "var(--st-done)",
  waiting: "var(--st-waiting)", "rate-limited": "var(--chat-state-error)", external: "var(--st-external)",
  attention: "var(--st-attention)", "close-failed": "var(--st-close-failed)",
  closing: "var(--chat-state-closing)", idle: "var(--st-your-turn)",
  dim: "var(--color-text-muted)",
};

/** "just now", "4m", "1h 12m", "3d". Minutes are enough for a sidebar glance.
 *  Named apart from shared/time.ts `formatElapsed` (m:ss), which a wrong
 *  auto-import would silently swap in. */
export function formatCompactElapsed(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  return `${Math.floor(hrs / 24)}d`;
}

function timerText(kind: StateLine["timer"], since: string | null | undefined, now: number): string {
  if (!kind || !since) return "";
  const t = Date.parse(since);
  if (Number.isNaN(t)) return "";
  const el = formatCompactElapsed(now - t);
  if (kind === "turn") return el === "just now" ? "just started" : `turn ${el}`;
  if (kind === "waiting") return el === "just now" ? "just now" : `waiting ${el}`;
  return el === "just now" ? "just now" : `${el} ago`;
}

/** Steps to show: the whole plan when short, else a window that keeps the
 *  active step visible. */
const MAX_PLAN_ROWS = 6;
function planWindow(plan: readonly PlanStepSnapshot[]): { rows: PlanStepSnapshot[]; more: number } {
  if (plan.length <= MAX_PLAN_ROWS) return { rows: [...plan], more: 0 };
  const active = Math.max(0, plan.findIndex((s) => s.status === "active"));
  const start = Math.min(Math.max(0, active - 2), plan.length - MAX_PLAN_ROWS);
  return { rows: plan.slice(start, start + MAX_PLAN_ROWS), more: plan.length - MAX_PLAN_ROWS };
}

function row(kind: "done" | "now" | "todo", icon: string, label: string, aside = ""): string {
  return `<div class="hc-row is-${kind}"><i class="ph ${icon}"></i><span class="hc-label">${escapeHtml(label)}</span>${aside ? `<span class="hc-aside">${escapeHtml(aside)}</span>` : ""}</div>`;
}

function planBlock(plan: readonly PlanStepSnapshot[]): string {
  const { rows, more } = planWindow(plan);
  const lines = rows.map((s) => {
    if (s.status === "done" || s.status === "skipped") return row("done", "ph-check", s.text);
    if (s.status === "active") return row("now", "ph-caret-right", s.text);
    return row("todo", "ph-circle", s.text);
  });
  if (more > 0) lines.push(`<div class="hc-more">+${more} more</div>`);
  return lines.join("");
}

function questionBlock(q: QuestionProgress): string {
  const firstOpen = q.answers.findIndex((a) => a === null);
  return q.questions.map((qu, i) => {
    // truncate() keeps n characters plus the ellipsis, so 33 and 21 cap the card at 34 and 22 rendered.
    const label = truncate(qu.header || qu.question, 33);
    const a = q.answers[i];
    if (a !== null && a !== undefined) return row("done", "ph-check", label, truncate(a, 21));
    return i === firstOpen ? row("now", "ph-caret-right", label) : row("todo", "ph-circle", label);
  }).join("");
}

// A sub that is not progressing never wears the working yellow: dim, like its ring.
const SUB_DOT_TONE: Record<SubKind, string> = {
  asking: TONE_VAR.question, working: TONE_VAR.working, finished: TONE_VAR.done,
  queued: TONE_VAR.dim, paused: TONE_VAR.dim, limited: TONE_VAR.dim, stopped: TONE_VAR.dim,
};

/** What the Subchats card's avatar hover card needs: the sub's row boiled down to
 *  plain data, so this stays a pure string function (tests/sub-hover-card.test.mjs). */
export interface SubHoverInput {
  name: string;
  tier: string;
  kind: SubKind;
  hover: SubHover;
  /** ISO start of the sub's row, for the time running. */
  startedAt: string | null;
  /** Context window used, 0-100, or null while unknown. */
  contextPct: number | null;
  now: number;
}

/** "Next in line", "Place 3 in line". */
function placeText(place: number): string {
  return place <= 1 ? "Next in line" : `Place ${place} in line`;
}

/** The hover card of one sub's avatar on the Subchats card: the sidebar row
 *  card's chrome with the state in words, the step it is on, how long it has run,
 *  its last action, and for a queued sub what it waits for and where it stands in
 *  line (the number lives here and not on the avatar, Joe's pick). */
export function buildSubHoverCardHtml(i: SubHoverInput): string {
  const { hover: h } = i;
  const started = Date.parse(i.startedAt ?? "");
  // Only a sub with a live turn shows a clock: a queued sub has not run, a finished one is done, and a
  // paused, limited or stopped one reading "running 2:10:00" would count up while nothing runs.
  const running = (i.kind === "working" || i.kind === "asking") && !Number.isNaN(started)
    ? `<span class="hc-timer">running ${escapeHtml(formatRunTime(i.now - started))}</span>` : "";
  const lines: string[] = [];
  if (h.queue) {
    lines.push(row("todo", "ph-clock", h.queue.waitingFor ?? "Waiting to start"));
    if (h.queue.place !== null) lines.push(row("todo", "ph-list-numbers", placeText(h.queue.place)));
    if (h.queue.behind) lines.push(row("todo", "ph-arrow-elbow-down-right", `Behind ${h.queue.behind}`));
  }
  if (h.resetsAt !== null) lines.push(row("todo", "ph-hourglass-medium", `Resets at ${localTime(new Date(h.resetsAt))}`));
  if (h.gaming) lines.push(row("todo", "ph-game-controller", "Gaming mode paused it"));
  const step = h.step
    ? `<div class="hc-heading">Step ${h.step.n} of ${h.step.total}</div>${h.step.text ? row("now", "ph-caret-right", h.step.text) : ""}`
    : "";
  const action = h.action
    ? row("todo", "ph-lightning", h.action.text, formatActionAge(i.now - h.action.at))
    : "";
  const ctx = i.contextPct === null
    ? ""
    : `<div class="hc-meta"><span class="hc-ctx" title="${escapeHtml(STATIC_CHIPS.context_pct.tooltip)}"><i class="ph ${STATIC_CHIPS.context_pct.icon}"></i>${Math.round(i.contextPct)}%</span></div>`;
  return `<div class="hc-title">${escapeHtml(i.name)}</div>
${i.tier ? `<div class="hc-sub">${escapeHtml(i.tier)}</div>` : `<div class="hc-sub"></div>`}
<div class="hc-state"><span class="hc-dot" style="background:${SUB_DOT_TONE[i.kind]}"></span>${escapeHtml(h.stateWord)}${running}</div>
${lines.join("")}${step}${action}${ctx}`;
}

function subsBlock(subs: NonNullable<HoverCardInput["subs"]>): string {
  return subs.map((s) =>
    `<div class="hc-subrow is-${s.kind}"><span class="hc-dot" style="background:${SUB_DOT_TONE[s.kind]}"></span><span class="hc-label">${escapeHtml(s.name)}${s.tier ? `<span class="hc-tier">${escapeHtml(s.tier)}</span>` : ""}</span><span class="hc-aside">${escapeHtml(s.progress)}</span></div>`,
  ).join("");
}

/** The desktop hover card for one sidebar row. Everything shown comes from
 *  the row's own state; nothing here is fetched except `contextPct`, which the
 *  caller fills in lazily. */
export function buildHoverCardHtml(i: HoverCardInput): string {
  const ctxHtml = i.contextPct === null
    ? ""
    : `<div class="hc-meta"><span class="hc-ctx" title="${escapeHtml(STATIC_CHIPS.context_pct.tooltip)}"><i class="ph ${STATIC_CHIPS.context_pct.icon}"></i>${Math.round(i.contextPct)}%</span></div>`;
  if (i.subs && i.subs.length > 0) {
    return `<div class="hc-title">${escapeHtml(i.title)}</div>
<div class="hc-sub">${escapeHtml(i.project)}</div>
${subsBlock(i.subs)}${ctxHtml}`;
  }
  const line = STATE_LINES[i.st] ?? { label: "", tone: "idle" as const, timer: null };
  const timer = timerText(line.timer, i.stateSince, i.now);
  const colour = TONE_VAR[line.tone];

  let progress = "";
  let list = "";
  let heading = "";
  const plan = planProgress(i.plan);
  if (i.question && i.question.total > 0) {
    const { answered, total } = i.question;
    heading = `${answered} of ${total} answered`;
    progress = `<div class="hc-bar"><span style="width:${(answered / total) * 100}%;background:${colour}"></span></div>`;
    list = questionBlock(i.question);
  } else if (plan && (i.st === "st-working" || plan.done < plan.total)) {
    heading = `Plan: ${plan.done} of ${plan.total} steps`;
    progress = `<div class="hc-bar"><span style="width:${(plan.done / plan.total) * 100}%;background:${colour}"></span></div>`;
    list = planBlock(i.plan!);
  }

  return `<div class="hc-title">${escapeHtml(i.title)}</div>
<div class="hc-sub">${escapeHtml(i.project)}</div>
<div class="hc-state"><span class="hc-dot" style="background:${colour}"></span>${escapeHtml(line.label)}${timer ? `<span class="hc-timer">${escapeHtml(timer)}</span>` : ""}</div>
${heading ? `<div class="hc-heading">${escapeHtml(heading)}</div>` : ""}${progress}${list}${ctxHtml}`;
}
