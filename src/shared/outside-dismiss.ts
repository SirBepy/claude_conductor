// `isInside` is checked live on every event, so this serves both a per-instance
// popover and a singleton tooltip whose anchor changes on every show().

export interface OutsideDismissOptions {
  /** True if a pointer/tap at `target` should NOT dismiss. */
  isInside: (target: Node) => boolean;
  onDismiss: () => void;
  /** "mousedown" (default) or "pointerdown". Touch's compat mouse events
   *  fire mouseover before mousedown, so a caller that reassigns "current"
   *  during mouseover (row-tooltip.ts) needs pointerdown to resolve the
   *  PREVIOUS target first - see row-tooltip.ts's wireGlobalDismiss. */
  eventType?: "mousedown" | "pointerdown";
  /** Also close on Escape. Off by default: a passive hover tooltip isn't a
   *  modal and has no topmost-overlay coordination (see question-ui.ts). */
  escape?: boolean;
}

export interface OutsideDismissHandle {
  /** Detach the listeners. Idempotent. */
  dispose: () => void;
}

export function wireOutsideDismiss(opts: OutsideDismissOptions): OutsideDismissHandle {
  const eventType = opts.eventType ?? "mousedown";
  let disposed = false;

  function onPointer(e: Event): void {
    const target = e.target as Node;
    if (opts.isInside(target)) return;
    opts.onDismiss();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      opts.onDismiss();
    }
  }

  // Deferred so the interaction that triggers registration doesn't itself
  // register as "outside" and immediately self-close it.
  const timer = setTimeout(() => {
    if (disposed) return;
    document.addEventListener(eventType, onPointer, true);
    if (opts.escape) document.addEventListener("keydown", onKey, true);
  }, 0);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener(eventType, onPointer, true);
      if (opts.escape) document.removeEventListener("keydown", onKey, true);
    },
  };
}
