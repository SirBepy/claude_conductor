// The dashboard's Test progress card data (pc-1684): the counts a test run reports
// to the daemon while it runs (daemon/hooks_server/test_progress.rs, posted by
// scripts/test-progress.mjs), and the pure derive the dashboard draws. DOM-free
// so tests read it directly. The card raises nothing: it is a place to look, not
// a Waiting-on-you item.

export type TestState = "running" | "passed" | "failed" | "error";

/** One runner's report, as the daemon relays it (`test-progress` event). */
export interface TestRun {
  runner: string;
  passed: number;
  failed: number;
  /** 0 = the runner has not said how many tests there are. */
  total: number;
  failing: string[];
  /** Failing names the daemon cut for its cap. */
  failingMore: number;
  state: TestState;
  /** When the daemon last heard from the runner (its clock, Unix ms); orders and dedupes reports. */
  atMs: number;
  /** When this window last heard from it (this window's clock): what the stale rule reads. */
  seenMs: number;
}

export interface TestProgressSide {
  runs: readonly TestRun[];
}

/** A run drawn on the card. */
export interface TestRunView extends TestRun {
  /** `running` that stopped reporting: the runner or its wrapper died without a final state. */
  stale: boolean;
  /** Passed and failed as fractions of the bar, 0..1. Both 0 while the total is unknown. */
  okFrac: number;
  badFrac: number;
  /** Running with no total: the bar shows motion instead of a fill it cannot compute. */
  indeterminate: boolean;
  /** The denominator the counts line shows ("of N"); 0 = unknown. */
  of: number;
}

export interface TestProgressState {
  runs: TestRunView[];
  /** At least one run is live (running and not stale). */
  live: boolean;
}

/** The wrapper re-posts every 5 s while a run is going (scripts/test-progress.mjs), so a
 *  run silent for this long was killed. */
export const STALE_MS = 30_000;

const STATES: ReadonlySet<string> = new Set(["running", "passed", "failed", "error"]);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** The event's runs as `TestRun`s; anything malformed reads as absent, an unknown
 *  state as a failed one so a run is never silently shown as fine. */
export function normaliseRuns(raw: unknown, seenMs: number): TestRun[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: TestRun[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o["runner"] !== "string" || !o["runner"]) continue;
    out.push({
      runner: o["runner"],
      passed: num(o["passed"]),
      failed: num(o["failed"]),
      total: num(o["total"]),
      failing: Array.isArray(o["failing"]) ? (o["failing"] as unknown[]).filter((x): x is string => typeof x === "string" && x !== "") : [],
      failingMore: num(o["failing_more"]),
      state: typeof o["state"] === "string" && STATES.has(o["state"]) ? (o["state"] as TestState) : "failed",
      atMs: num(o["at_ms"]),
      seenMs,
    });
  }
  return out;
}

export function viewRun(run: TestRun, now: number): TestRunView {
  const stale = run.state === "running" && now - run.seenMs > STALE_MS;
  const done = run.passed + run.failed;
  // A runner that has run more than it first announced (a cargo test binary after the first)
  // must not overflow the bar: the denominator grows to what was seen.
  const of = run.total > 0 ? Math.max(run.total, done) : 0;
  const finished = run.state !== "running";
  // A finished run with no announced total fills to what it ran, so a green "Passed" bar is whole.
  const whole = of > 0 ? of : finished ? done : 0;
  return {
    ...run,
    stale,
    okFrac: whole > 0 ? run.passed / whole : 0,
    badFrac: whole > 0 ? run.failed / whole : 0,
    indeterminate: run.state === "running" && !stale && of === 0,
    of,
  };
}

/** Nothing to show until a run reported, so a chat that never ran tests gains no card. */
export function deriveTestProgress(side: TestProgressSide | undefined, on: boolean, now: number): TestProgressState | null {
  if (!on || !side || side.runs.length === 0) return null;
  const runs = side.runs.map((r) => viewRun(r, now));
  return { runs, live: runs.some((r) => r.state === "running" && !r.stale) };
}

/** The earliest moment a live run turns stale, so the card can ask for one redraw then. */
export function nextStaleAt(side: TestProgressSide | undefined, now: number): number | null {
  let at: number | null = null;
  for (const r of side?.runs ?? []) {
    if (r.state !== "running" || now - r.seenMs > STALE_MS) continue;
    const t = r.seenMs + STALE_MS + 1;
    if (at === null || t < at) at = t;
  }
  return at;
}

/** The chip's word for a run. */
export function stateLabel(r: TestRunView): string {
  if (r.stale) return "Stopped";
  switch (r.state) {
    case "running": return "Running";
    case "passed": return "Passed";
    case "failed": return "Failed";
    case "error": return "Error";
  }
}

/** The counts under the bar: "142 passed · 2 failed · of 310". Only the parts that say something. */
export function countsParts(r: TestRunView): { passed: string; failed: string; of: string } {
  return {
    passed: `${r.passed} passed`,
    failed: r.failed > 0 ? `${r.failed} failed` : "",
    of: r.of > 0 && (r.state === "running" || r.passed + r.failed < r.of) ? `of ${r.of}` : "",
  };
}
