// Generic trailing-edge debounce (coalesce rapid keystrokes into one network
// call every 500ms). `flush()` stays a separate function from the scheduling
// path: folding it into the timer's own callback risks the timer's cleanup
// silently swallowing a caller-triggered flush (e.g. blur).

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Run the pending call now, if one is queued. Bypasses the wait. */
  flush: () => void;
  /** Drop any pending call without running it. */
  cancel: () => void;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: A | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush(): void {
    if (pendingArgs === null) return;
    const args = pendingArgs;
    pendingArgs = null;
    clearTimer();
    fn(...args);
  }

  function cancel(): void {
    pendingArgs = null;
    clearTimer();
  }

  function schedule(...args: A): void {
    pendingArgs = args;
    clearTimer();
    timer = setTimeout(flush, ms);
  }

  const debounced = schedule as Debounced<A>;
  debounced.flush = flush;
  debounced.cancel = cancel;
  return debounced;
}
