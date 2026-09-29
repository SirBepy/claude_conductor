// Shared focus-restore helper for the project/location/worktree picker chain
// (todo 1021). All three call `document.activeElement` once at open time as
// "trigger" (kebab-menu.ts precedent) and used to call `trigger?.focus?.()`
// unconditionally on close. That silently no-ops when the trigger is the
// kebab menu's "New chat" item: view-more-menu.ts relocates it back into
// #view-more-host on close, and that host carries the native `hidden`
// attribute (template.ts), so the captured element is still `.isConnected`
// but no longer focusable - focus falls through to <body> instead.

/** Whether `el` can accept focus right now: still attached to the document
 *  and not sitting inside a `hidden` ancestor. Deliberately checks
 *  `closest("[hidden]")` rather than `offsetParent`/layout: jsdom has no
 *  layout engine (offsetParent is always null there), but this is exactly
 *  the DOM shape that causes the real bug, so it stays both testable and
 *  correct for this case. */
function isFocusable(el: HTMLElement): boolean {
  return el.isConnected && el.closest("[hidden]") === null;
}

/** Restores focus to whatever opened a picker, same idiom as
 *  kebab-menu.ts's own Escape handling. Falls back to `#viewMoreBtn` (the
 *  visible control that opens the menu these pickers are reached from) when
 *  the captured trigger has gone stale by close time, so focus never
 *  silently drops to `<body>`. Does nothing if neither is focusable. */
export function restoreFocus(trigger: HTMLElement | null): void {
  if (trigger && isFocusable(trigger)) {
    trigger.focus();
    return;
  }
  const fallback = document.getElementById("viewMoreBtn");
  if (fallback && isFocusable(fallback)) {
    fallback.focus();
  }
}
