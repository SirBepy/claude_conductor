/**
 * Hardware / browser BACK button handling for the phone PWA.
 *
 * On Android the hardware back button drives browser history. The app's hash
 * router never pushed real history entries, so pressing back walked straight
 * off the SPA's single entry and CLOSED the app. This installs a history
 * "trap": one sentinel entry is kept on the stack and re-pushed on every
 * popstate, so back can never exit. Each press is routed to handleBack(), which:
 *
 *   1. closes the top open overlay (modal, sidemenu, prompt card, mobile chat
 *      pane, news article) if any is registered, else
 *   2. steps back one entry through the view-navigation stack, else
 *   3. falls back to the chats list (HOME_VIEW) from any other root, else
 *   4. stays put on the chats list (back never closes the app).
 *
 * The soft keyboard never reaches this: Android's IME consumes the press that
 * hides it. A text field can still hold focus after that, so every press that
 * does arrive drops it rather than spending the press on a silent blur.
 *
 * The Android shell does not rely on the history trap: Chromium skips history
 * entries pushed without a user gesture, so WebView.goBack() walked straight
 * past the sentinel and closed the app. MainActivity.kt intercepts back
 * natively and calls window.__ccHandleBack instead.
 *
 * Overlays register a handler via registerOverlayBack(); it returns true if it
 * consumed the press. The router feeds the view stack via noteNavigation().
 *
 * Desktop (Tauri webview) has no hardware back button, so initBackButton() is
 * only called there in the remote/phone client. The module no-ops cleanly when
 * window/history/document are absent (node tests).
 */

import { isTextEntryElement } from "./text-entry";

/** Back handler for a transient overlay. Returns true if it consumed the press
 *  (the overlay was open and is now closed), false to fall through. */
export type OverlayBack = () => boolean;

/** The phone's home screen - router.ts opens it when the URL names no view. */
const HOME_VIEW = "sessions";

let viewStack: string[] = [];
let suppressNote = false;
const overlays: OverlayBack[] = [];
let installed = false;

/**
 * Record a view navigation so hardware-back can step back through screens.
 * Navigating to a view already in the stack rewinds to it (so an in-screen Back
 * button doesn't leave a forward entry that hardware-back would bounce into);
 * a fresh view is pushed. The router calls this from navigateTo().
 */
export function noteNavigation(name: string): void {
  if (suppressNote) return;
  const top = viewStack[viewStack.length - 1];
  if (top === name) return;
  const existing = viewStack.lastIndexOf(name);
  if (existing >= 0) {
    viewStack.length = existing + 1;
  } else {
    viewStack.push(name);
  }
}

/**
 * Register an overlay's back handler. Handlers are consulted most-recently-
 * registered first (LIFO), so back closes the most recently opened thing.
 * Returns a disposer to call when the overlay closes by other means.
 */
export function registerOverlayBack(fn: OverlayBack): () => void {
  overlays.push(fn);
  return () => {
    const i = overlays.lastIndexOf(fn);
    if (i >= 0) overlays.splice(i, 1);
  };
}

function navigateWithoutNoting(name: string): void {
  const nav = (window as unknown as {
    navigateTo?: (n: string) => void | Promise<void>;
  }).navigateTo;
  suppressNote = true;
  try {
    void nav?.(name);
  } finally {
    suppressNote = false;
  }
}

function goBackView(): boolean {
  if (viewStack.length > 1) {
    viewStack.pop();
    navigateWithoutNoting(viewStack[viewStack.length - 1] ?? HOME_VIEW);
    return true;
  }
  // A root with no known previous screen (opened straight into settings, say)
  // still has somewhere to go: the chats list.
  if (viewStack.length === 1 && viewStack[0] !== HOME_VIEW) {
    viewStack = [HOME_VIEW];
    navigateWithoutNoting(HOME_VIEW);
    return true;
  }
  return false;
}

function blurFocusedTextEntry(): void {
  if (typeof document === "undefined") return;
  const el = document.activeElement;
  if (isTextEntryElement(el)) (el as HTMLElement).blur();
}

/** Resolve a single back press. Exported for unit tests; production triggers it
 *  from the popstate listener installed by initBackButton(). */
export function handleBack(): void {
  blurFocusedTextEntry();
  for (let i = overlays.length - 1; i >= 0; i--) {
    if (overlays[i]?.()) return;
  }
  if (goBackView()) return;
  // Root reached: do nothing. Back must never close the app.
}

/**
 * Install the history trap + popstate listener. Idempotent; no-op when there is
 * no window/history (node test env). Call once, on the phone client only.
 */
export function initBackButton(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof history === "undefined") return;
  installed = true;

  // Defensive seed: the router's first navigateTo normally records the initial
  // view before this runs, but seed it if the stack is still empty.
  if (viewStack.length === 0) {
    const initial =
      (typeof location !== "undefined" && location.hash.replace(/^#/, "")) ||
      "dashboard";
    viewStack.push(initial);
  }

  // Native hook for the Android shell (MainActivity.kt). Always true: the SPA
  // owns back once it's loaded, and "nothing left to close" means stay put.
  (window as unknown as { __ccHandleBack?: () => boolean }).__ccHandleBack = () => {
    handleBack();
    return true;
  };

  // Prime the trap: one extra entry that the first back press consumes instead
  // of exiting the SPA.
  history.pushState({ __backTrap: true }, "");
  window.addEventListener("popstate", () => {
    // Re-prime so the NEXT back also fires popstate (never escapes the SPA),
    // then resolve this press.
    history.pushState({ __backTrap: true }, "");
    handleBack();
  });
}

/** Test-only: reset all module state between cases. */
export function resetBackButtonForTests(): void {
  viewStack = [];
  suppressNote = false;
  overlays.length = 0;
  installed = false;
}

/** Test-only: read the current view stack. */
export function viewStackForTests(): string[] {
  return [...viewStack];
}
