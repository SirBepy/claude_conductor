// The 768px query already exists in composer.ts, composer-core/core.ts and
// permission-modal/host.ts. This adds the part none of them have: a live
// subscription, so the statusline's chip profile swaps on crossing rather
// than only on reload.

export const MOBILE_MQ = "(max-width: 768px)";

function mql(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(MOBILE_MQ);
}

export function isMobileViewport(): boolean {
  return mql()?.matches ?? false;
}

/** Fires only on an actual crossing of the breakpoint, not on every resize.
 *  Returns an unsubscribe. */
export function onMobileViewportChange(fn: (isMobile: boolean) => void): () => void {
  const m = mql();
  if (!m) return () => {};
  const handler = (e: MediaQueryListEvent) => fn(e.matches);
  m.addEventListener("change", handler);
  return () => m.removeEventListener("change", handler);
}
