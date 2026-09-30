// Owns hidden-window polling behaviour (todo 1008), so a new poller opts in
// here instead of hand-rolling its own `visibilitychange` check - 43 sites
// had that idea and not one of them applied it. Default is
// PAUSE-WHEN-HIDDEN: most pollers exist to refresh something on screen, and
// a hidden window has no screen to refresh, so running them is pure waste.
// The exception (a poller whose whole point is reaching the user while
// they're looking elsewhere, e.g. a turn-completion notification) must opt
// in explicitly via `whileHidden: true` - typed so that opt-in also
// requires a `reason` string, so the "why" lives in code, not only in chat.
//
// Always flushes once on becoming visible after skipping at least one tick,
// matching this codebase's 8 existing `visibilityState` call sites: a
// poller that slept must not leave stale data on screen.

export interface KeepRunningWhileHidden {
  whileHidden: true;
  /** Why this poller must not pause while hidden - named in code. */
  reason: string;
}

/**
 * Runs `fn` every `ms` while `document` is visible. While hidden, pauses
 * (default) or keeps running if `opts.whileHidden` is set. On the next
 * visibility change to "visible", if at least one tick was skipped while
 * hidden, calls `fn` immediately once before resuming the normal cadence.
 * Returns a disposer that clears the timer and removes the listener.
 */
export function visibleInterval(fn: () => void, ms: number): () => void;
export function visibleInterval(fn: () => void, ms: number, opts: KeepRunningWhileHidden): () => void;
export function visibleInterval(fn: () => void, ms: number, opts?: KeepRunningWhileHidden): () => void {
  const keepRunningWhileHidden = opts?.whileHidden === true;
  let skippedATick = false;

  function tick(): void {
    if (!keepRunningWhileHidden && document.visibilityState === "hidden") {
      skippedATick = true;
      return;
    }
    fn();
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "visible" && skippedATick) {
      skippedATick = false;
      fn();
    }
  }

  const timer = setInterval(tick, ms);
  if (!keepRunningWhileHidden) {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  return function dispose(): void {
    clearInterval(timer);
    if (!keepRunningWhileHidden) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}
