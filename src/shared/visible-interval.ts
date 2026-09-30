// Owns hidden-window polling behaviour (todo 1008), so a new poller opts in
// here instead of hand-rolling its own `visibilitychange` check. Default is
// PAUSE-WHEN-HIDDEN: the timer itself is cleared, not just skipped, so a
// hidden window pays nothing. A poller whose whole point is reaching the user
// while they look elsewhere (a turn-completion signal, a tray indicator) opts
// in via `whileHidden: true`, which the types force to carry a `reason`.
//
// Flushes once on becoming visible if the window was hidden for at least one
// full period, so a poller that slept never leaves stale data on screen.

export interface KeepRunningWhileHidden {
  whileHidden: true;
  /** Why this poller must not pause while hidden - named in code. */
  reason: string;
}

/**
 * Runs `fn` every `ms` while `document` is visible. While hidden, the timer
 * is stopped (default) or keeps running if `opts.whileHidden` is set. On
 * becoming visible after at least `ms` hidden, calls `fn` once immediately,
 * then resumes the cadence. Returns a disposer that clears the timer and
 * removes the listener.
 */
export function visibleInterval(fn: () => void, ms: number): () => void;
export function visibleInterval(fn: () => void, ms: number, opts: KeepRunningWhileHidden): () => void;
export function visibleInterval(fn: () => void, ms: number, opts?: KeepRunningWhileHidden): () => void {
  if (opts?.whileHidden === true) {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let hiddenSince: number | null = null;

  function start(): void {
    if (timer === null) timer = setInterval(fn, ms);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      if (hiddenSince === null) hiddenSince = Date.now();
      stop();
      return;
    }
    const missedATick = hiddenSince !== null && Date.now() - hiddenSince >= ms;
    hiddenSince = null;
    if (missedATick) fn();
    start();
  }

  if (document.visibilityState === "hidden") hiddenSince = Date.now();
  else start();
  document.addEventListener("visibilitychange", onVisibilityChange);

  return function dispose(): void {
    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
