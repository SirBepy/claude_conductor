// Long-task attribution for the chat render path. Windows marks the app
// "frozen" once the JS main thread blocks ~5s, and the stack that caused it is
// long gone by the time anyone looks - so phases register themselves here and a
// longtask observer names whichever ones were open when the block happened.

/** Phase slower than this logs on its own, even without a longtask entry. */
const SLOW_PHASE_MS = 250;
/** Browser longtask entries below this are normal render churn, not freezes. */
const LONG_TASK_MS = 200;

const openPhases = new Map<string, number>();
let observerArmed = false;

function armObserver(): void {
  if (observerArmed) return;
  observerArmed = true;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_MS) continue;
        const during = openPhases.size ? [...openPhases.keys()].join(" > ") : "(no chat phase open)";
        console.warn(`[perf] blocked main thread ${Math.round(entry.duration)}ms during ${during}`);
      }
    });
    obs.observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask unsupported (jsdom, older webviews) - phase timing still logs */
  }
}

/** Open a named phase. Returns a done() that closes it and logs if it was slow.
 *  `detail` is appended to the log line (event counts, session id, ...). */
export function perfPhase(label: string, detail?: () => string): () => void {
  armObserver();
  const started = performance.now();
  openPhases.set(label, started);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    openPhases.delete(label);
    const ms = performance.now() - started;
    if (ms >= SLOW_PHASE_MS) {
      const extra = detail ? ` ${detail()}` : "";
      console.warn(`[perf] ${label} took ${Math.round(ms)}ms${extra}`);
    }
  };
}
