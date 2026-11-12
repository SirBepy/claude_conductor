// The dashboard's rows from above the loaded history page (docs/forever-chat-plan.md
// B2). A chat window loads only its newest page, so a dashboard built from the
// transcript renderer's rows alone loses an old answer, plan or open question
// once it scrolls past that page. The window rebuilds those older rows from the
// transcript's digest (chat/dashboard_digest.rs) with the renderer's own code
// (chat-dashboard/history-prefix-source.ts); this file joins them to the loaded
// rows, so every zone derives from the chat's whole life while Messages view
// still shows only what it loaded.

import type { RenderedMessage } from "../chat-classifiers";
import type { DashboardPlan, PlanStep } from "./plan-record";

export interface HistoryPrefix {
  /** Rows from above the loaded page, oldest first, as a renderer that had
   *  loaded everything would hold them (answers that came later applied). */
  messages: RenderedMessage[];
  /** Plans whose first write_plan call lies above the loaded page, `at` and
   *  `lastAt` counted in `messages`. */
  plans: DashboardPlan[];
  /** The last of `plans` went on into the loaded page, so the loaded rows' first
   *  plan is its continuation, not a job of its own. */
  continued: boolean;
}

export interface DashboardRows {
  messages: readonly RenderedMessage[];
  plans: readonly DashboardPlan[];
}

/** A step's time from before the loaded page, when the loaded page's renderer
 *  could only stamp it with a later one. */
function earlier(loaded: number | undefined, prefix: number | undefined, pageStart: number): number | undefined {
  return prefix !== undefined && prefix < pageStart && (loaded === undefined || prefix < loaded) ? prefix : loaded;
}

/** One job split by the page edge, as one plan: the loaded half has the live
 *  steps, the prefix half the job's key, start and the times its steps got
 *  before the page began. A step that went straight to done at the page's first
 *  call can still show a later start than a full load would: only its row
 *  length, shown when the step is clicked open, can differ. */
function joinPlan(prefix: DashboardPlan, loaded: DashboardPlan): DashboardPlan {
  const pageStart = loaded.startedAt;
  const steps = loaded.steps.map((s): PlanStep => {
    const old = prefix.steps.find((p) => p.label === s.label);
    const out: PlanStep = { ...s };
    const startedAt = earlier(s.startedAt, old?.startedAt, pageStart);
    if (startedAt !== undefined) out.startedAt = startedAt;
    // A step finished before the page, reopened and finished again inside it
    // keeps its first finish time here (a full load keeps the second).
    if (s.doneAt !== undefined) out.doneAt = earlier(s.doneAt, old?.doneAt, pageStart);
    return out;
  });
  return { ...loaded, steps, id: prefix.id, at: prefix.at, startedAt: prefix.startedAt };
}

/** The rows and plans every zone derives from: the prefix's, then the loaded
 *  ones, with the loaded plans' row counts moved past the prefix. */
export function joinHistoryPrefix(prefix: HistoryPrefix | null, loaded: DashboardRows): DashboardRows {
  if (!prefix || (prefix.messages.length === 0 && prefix.plans.length === 0)) return loaded;
  const n = prefix.messages.length;
  const plans = loaded.plans.map((p) => ({ ...p, at: p.at + n, lastAt: p.lastAt + n }));
  let head = prefix.plans;
  if (prefix.continued && head.length > 0 && plans.length > 0) {
    plans[0] = joinPlan(head.at(-1)!, plans[0]!);
    head = head.slice(0, -1);
  }
  return { messages: [...prefix.messages, ...loaded.messages], plans: [...head, ...plans] };
}
