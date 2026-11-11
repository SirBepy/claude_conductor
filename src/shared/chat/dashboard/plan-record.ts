// The write_plan record (ChatRenderer.dashPlans) and the turn's tool calls
// (ChatRenderer.turnActions), kept apart from dashboard-model.ts so the event
// handlers that record them load only this, not every card's model.

import type { RenderedMessage } from "../chat-classifiers";
import type { MessageKind } from "../chat-message-kinds";

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

export interface PlanStep {
  label: string;
  status: PlanStepStatus;
  detail?: string;
  /** When the step first went active (ms), as recordPlan saw it. */
  startedAt?: number;
  /** When it first went done or skipped (ms); cleared if it is reopened. */
  doneAt?: number;
}

/** One plan of the chat, as ChatRenderer.dashPlans records it: every write_plan
 *  call of the same job updates one entry (recordPlan). `at` is how many message
 *  rows existed at its first call, so the job's rows start there; `lastAt` is the
 *  same for its latest call. ChatRenderer.remapIndices keeps both aligned when
 *  older pages are prepended or a row is spliced out. */
export interface DashboardPlan {
  steps: PlanStep[];
  at: number;
  lastAt: number;
  /** When its first write_plan call came (ms). */
  startedAt: number;
  /** The tool_use id of its first write_plan call: a job key that stays put
   *  when rows are prepended and stays unique when calls share a timestamp. */
  id: string;
}

/** One tool call of the turn in flight, as ChatRenderer.turnActions keeps it. */
export interface TurnAction {
  /** The tool_use id, so a call seen twice counts once. */
  id?: string;
  /** Phosphor icon class of the tool (tool-meta.ts toolSummary). */
  icon: string;
  /** What the status line says for it ("Reading api.ts"). */
  label: string;
  /** The bucket it counts under (tool-meta.ts canonicalTool). */
  canon: string;
  at: number;
}

/** Most a turn keeps: the line shows the latest few and counts the rest. */
export const TURN_ACTIONS_MAX = 400;

const COUNT_WORDS: Record<string, [string, string]> = {
  Read: ["read", "read"],
  Edit: ["edit", "edits"],
  Bash: ["command", "commands"],
  Grep: ["search", "searches"],
  Search: ["web lookup", "web lookups"],
  Agent: ["subagent", "subagents"],
  Task: ["subagent", "subagents"],
};

/** "6 read · 2 edits · 1 command": the turn's calls by kind, biggest first.
 *  Kinds with no word of their own (MCP tools, skills) count as "other". */
export function turnCounts(actions: readonly TurnAction[]): string {
  const by = new Map<string, number>();
  for (const a of actions) {
    const k = COUNT_WORDS[a.canon] ? a.canon : "other";
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by].sort((x, y) => y[1] - x[1]).map(([k, n]) => {
    const w = COUNT_WORDS[k] ?? ["other", "other"];
    return `${n} ${n === 1 ? w[0] : w[1]}`;
  }).join(" · ");
}

/** A send_message row the main agent wrote that draws: not refused, not
 *  retracted, not a sub's card shown in this main chat. */
export function isOwnMessage(m: RenderedMessage): boolean {
  return m.kind === "message" && !m.failed && !m.retracted && !m.subCard;
}

/** The card kind of an own message, "legacy" for one sent before kinds existed. */
export function messageKindOf(m: RenderedMessage): MessageKind | "legacy" {
  return m.card?.kind ?? "legacy";
}

export const TURN_STATUS_TOOL = "mcp__cc_conductor__report_turn_status";

/** A tool result whose JSON body says `ok: false`: the daemon refused the call. */
export function refusedOutput(output: unknown): boolean {
  const o = output as { type?: unknown; text?: unknown } | null | undefined;
  if (!o || o.type !== "text" || typeof o.text !== "string" || !o.text.includes('"ok"')) return false;
  try {
    return (JSON.parse(o.text) as { ok?: unknown }).ok === false;
  } catch {
    return false;
  }
}

/** A report the main agent sent that draws. */
export function isReport(m: RenderedMessage): boolean {
  return isOwnMessage(m) && messageKindOf(m) === "report";
}

export const stepFinished = (s: PlanStep): boolean => s.status === "done" || s.status === "skipped";

/** Records one write_plan call. Calls of the same job update its entry: a job
 *  is the same while no report came since it started and the new steps share a
 *  label with it. Otherwise it is a new plan and the old one becomes history.
 *  Each step keeps when it first went active and when it finished; a step that
 *  went straight to done started when the step before it finished. */
export function recordPlan(
  plans: readonly DashboardPlan[],
  msgs: readonly RenderedMessage[],
  steps: readonly PlanStep[],
  now: number,
  id: string,
): DashboardPlan[] {
  const prev = plans.at(-1);
  const at = msgs.length;
  const reportSince = !!prev && msgs.some((m, i) => i >= prev.at && isReport(m));
  const same = !!prev && !reportSince && steps.some((s) => prev.steps.some((p) => p.label === s.label));
  const base = same ? prev : null;
  const startedAt = base?.startedAt ?? now;
  let lastDone: number | undefined;
  const timed = steps.map((s): PlanStep => {
    const old = base?.steps.find((p) => p.label === s.label);
    let begun = old?.startedAt;
    let ended = stepFinished(s) ? old?.doneAt : undefined;
    if (s.status === "active" && begun === undefined) begun = now;
    if (stepFinished(s) && ended === undefined) ended = now;
    if (stepFinished(s) && begun === undefined) begun = lastDone ?? startedAt;
    if (ended !== undefined) lastDone = ended;
    const out: PlanStep = { ...s };
    if (begun !== undefined) out.startedAt = begun;
    if (ended !== undefined) out.doneAt = ended;
    return out;
  });
  const entry: DashboardPlan = { steps: timed, at: base?.at ?? at, lastAt: at, startedAt, id: base?.id ?? id };
  return base ? [...plans.slice(0, -1), entry] : [...plans, entry];
}
