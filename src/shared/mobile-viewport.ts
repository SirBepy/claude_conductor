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

/** A phone-class device: narrow AND touch is the primary pointer. Opening a chat
 *  must not focus its composer from code on one (Android WebView then connects
 *  the keyboard as a raw key stream); a narrow desktop window has a mouse and no
 *  such problem, so it keeps the open-time focus. */
export function isTouchPhone(): boolean {
  if (!isMobileViewport()) return false;
  return window.matchMedia("(pointer: coarse)").matches;
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
