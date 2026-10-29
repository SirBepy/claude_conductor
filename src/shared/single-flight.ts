/** Wraps an async refresh so only one run is ever in flight. A call that lands
 *  while one is running doesn't start a second: it queues exactly one rerun
 *  after the current one (however many calls arrived meanwhile), so the last
 *  caller still sees fresh data without N concurrent copies of the same work.
 *  The returned promise settles when the run that covers the call finishes. */
export function singleFlight(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
