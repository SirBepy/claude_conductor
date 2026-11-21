// The dashboard's Run card data (pc-1804 step 5): the plan a main chat holds with
// `run_plan` (daemon/subchats/run.rs), as the daemon's `run_plan_state` answers, and the
// pure derive the dashboard draws. DOM-free so tests read it directly. The card raises
// nothing: a step that is the chat's turn or a blocked lane is already a wake of the
// chat itself, so it is a place to look, never a Waiting-on-you item.

export type RunStepStatus = "waiting" | "ready" | "running" | "done" | "blocked" | "skipped";
export type RunStatus = "open" | "done" | "stopped";

/** One step, as `run_plan_state` returns it. */
export interface RunStep {
  id: string;
  title: string;
  /** `sub`: a hidden lane the daemon starts. `main`: the chat's own part. */
  owner: "sub" | "main";
  status: RunStepStatus;
  after: string[];
  todoIds: string[];
  /** The lane's sub name, and its session id once it is registered. */
  sub: string | null;
  subId: string | null;
  /** Why a blocked step is blocked, in the sub's or the daemon's words. */
  note: string;
}

export interface RunSide {
  id: string;
  title: string;
  goal: string;
  status: RunStatus;
  steps: RunStep[];
}

const STEP_STATUSES: ReadonlySet<string> = new Set(["waiting", "ready", "running", "done", "blocked", "skipped"]);
const RUN_STATUSES: ReadonlySet<string> = new Set(["open", "done", "stopped"]);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);

/** The daemon answers `{ session_id, run }`, `run` null for a chat with none. A step this build
 *  does not know the status of reads as waiting, so it is never drawn as done. */
export function normaliseRun(raw: unknown): RunSide | undefined {
  const run = (raw && typeof raw === "object" ? (raw as { run?: unknown }).run : null) as Record<string, unknown> | null | undefined;
  if (!run || typeof run !== "object" || typeof run["id"] !== "string" || !Array.isArray(run["steps"])) return undefined;
  const steps: RunStep[] = [];
  for (const s of run["steps"] as unknown[]) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    if (typeof o["id"] !== "string" || !o["id"]) continue;
    steps.push({
      id: o["id"],
      title: str(o["title"]) || o["id"],
      owner: o["owner"] === "main" ? "main" : "sub",
      status: typeof o["status"] === "string" && STEP_STATUSES.has(o["status"]) ? (o["status"] as RunStepStatus) : "waiting",
      after: list(o["after"]),
      todoIds: list(o["todo_ids"]),
      sub: str(o["sub"]) || null,
      subId: str(o["sub_id"]) || null,
      note: str(o["note"]),
    });
  }
  return {
    id: run["id"],
    title: str(run["title"]),
    goal: str(run["goal"]),
    status: typeof run["status"] === "string" && RUN_STATUSES.has(run["status"]) ? (run["status"] as RunStatus) : "open",
    steps,
  };
}

export type RunPhase = "done" | "blocked" | "yours" | "running" | "queued";

export interface RunState {
  id: string;
  title: string;
  goal: string;
  /** Lanes in rows: each row is one chain, a lane after another. */
  chains: RunChain[];
  /** What comes after the chains: joins (a step that waits for several lanes), main steps and what follows them. */
  end: RunStep[];
  done: number;
  total: number;
  phase: RunPhase;
  /** The words under the chains: what wakes the main chat. */
  wakes: string;
}

export interface RunChain {
  /** The id of the chain's first step: how the card keys the row. */
  key: string;
  lanes: RunStep[];
}

/** Steps the run still has to do (done and skipped are settled). */
export const stepSettled = (s: RunStep): boolean => s.status === "done" || s.status === "skipped";

/** Splits the plan into chains and end steps. An end step is the chat's own step, a step that
 *  waits for two or more others (a join: a review gate after every lane), or anything after one
 *  of those; a lane step has at most one `after` and nothing end-side before it, so what is left
 *  are chains, each a connected run of lanes (lane B after lane A is one row). A sub step cannot
 *  wait for a main step (the daemon refuses it), so a main step is always last in its path. */
export function layOut(steps: readonly RunStep[]): { chains: RunChain[]; end: RunStep[] } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ends = new Map<string, boolean>();
  const isEnd = (s: RunStep, seen: ReadonlySet<string> = new Set()): boolean => {
    const known = ends.get(s.id);
    if (known !== undefined) return known;
    // A cycle is refused by the daemon; reading one as "end" keeps the layout finite.
    if (seen.has(s.id)) return true;
    const deps = s.after.filter((a) => byId.has(a));
    const next = new Set(seen).add(s.id);
    const out = s.owner === "main" || deps.length >= 2 || deps.some((d) => isEnd(byId.get(d)!, next));
    ends.set(s.id, out);
    return out;
  };
  const end = steps.filter((s) => isEnd(s));
  const lanes = steps.filter((s) => !isEnd(s));
  // Union the lanes joined by an `after` edge; the plan is in dependency order, so a lane's
  // component is found from the first lane it hangs on.
  const root = new Map<string, string>();
  const find = (id: string): string => {
    let r = id;
    while (root.get(r) !== r) r = root.get(r)!;
    root.set(id, r);
    return r;
  };
  for (const s of lanes) root.set(s.id, s.id);
  for (const s of lanes) {
    for (const a of s.after) if (root.has(a)) root.set(find(s.id), find(a));
  }
  const rows = new Map<string, RunStep[]>();
  for (const s of lanes) {
    const r = find(s.id);
    rows.set(r, [...(rows.get(r) ?? []), s]);
  }
  const chains = [...rows.values()].map((ls) => ({ key: ls[0]!.id, lanes: ls }));
  return { chains, end };
}

/** Where the run stands, in one word the chip says. A blocked lane outranks everything: the chat
 *  was woken for it and Joe may be needed. */
export function phaseOf(run: RunSide): RunPhase {
  if (run.status === "done") return "done";
  if (run.steps.some((s) => s.status === "blocked")) return "blocked";
  if (run.steps.some((s) => s.owner === "main" && s.status === "ready")) return "yours";
  if (run.steps.some((s) => s.status === "running")) return "running";
  return "queued";
}

/** What wakes the main chat, as a sentence. The daemon wakes it for exactly three things: a step of
 *  its own becomes ready, a lane is blocked, the run ends. Anything else (a lane finishing with
 *  more lanes behind it) wakes nobody. */
export function wakeText(run: RunSide, phase: RunPhase): string {
  if (phase === "done") return "Finished. Nothing more wakes this chat.";
  const mine = run.steps.filter((s) => s.owner === "main" && !stepSettled(s));
  const ready = mine.filter((s) => s.status === "ready");
  const blocked = run.steps.filter((s) => s.status === "blocked");
  // Both can stand at once; the chip says Blocked, so the line names the lane first.
  if (blocked.length > 0 || ready.length > 0) {
    const out: string[] = [];
    if (blocked.length > 0) out.push(`Blocked: ${blocked.map((s) => s.title).join(", ")}.${ready.length > 0 ? "" : " This chat was woken for it."}`);
    if (ready.length > 0) out.push(`Your turn: ${ready.map((s) => s.title).join(", ")}.`);
    return out.join(" ");
  }
  const parts: string[] = [];
  if (mine.length > 0) parts.push("a step of yours is ready");
  parts.push("a lane is blocked");
  return `Wakes this chat when ${parts.join(", ")} or the run ends.`;
}

/** The lanes the steps after the chains wait for: every dependency of an end step that is not
 *  itself an end step, once each, in plan order. The card's "after ..." row names them. */
export function endAfter(chains: readonly RunChain[], end: readonly RunStep[]): { id: string; title: string }[] {
  const inEnd = new Set(end.map((s) => s.id));
  const titles = new Map(chains.flatMap((c) => c.lanes).map((s) => [s.id, s.title] as const));
  const out: { id: string; title: string }[] = [];
  for (const id of end.flatMap((s) => s.after)) {
    const title = titles.get(id);
    if (inEnd.has(id) || title === undefined || out.some((o) => o.id === id)) continue;
    out.push({ id, title });
  }
  return out;
}

/** Nothing to show for a chat without a run, a run it gave up, or with the card switched off. */
export function deriveRun(side: RunSide | undefined, on: boolean): RunState | null {
  if (!on || !side || side.status === "stopped" || side.steps.length === 0) return null;
  const { chains, end } = layOut(side.steps);
  const phase = phaseOf(side);
  return {
    id: side.id,
    title: side.title,
    goal: side.goal,
    chains,
    end,
    done: side.steps.filter(stepSettled).length,
    total: side.steps.length,
    phase,
    wakes: wakeText(side, phase),
  };
}

/** The chip's word for a phase. */
export const PHASE_LABEL: Readonly<Record<RunPhase, string>> = {
  done: "Finished",
  blocked: "Blocked",
  yours: "Your turn",
  running: "Running",
  queued: "Queued",
};

/** A step's state in one word, for a lane's tooltip and its screen-reader name. */
export const STEP_LABEL: Readonly<Record<RunStepStatus, string>> = {
  waiting: "Waiting",
  ready: "Ready",
  running: "Running",
  done: "Done",
  blocked: "Blocked",
  skipped: "Skipped",
};
