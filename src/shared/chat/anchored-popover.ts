// Shared scaffolding for a body-appended, position:fixed popover anchored off
// an element (ai_todo 233) - reposition (anchor rect -> left/top-or-bottom
// flip), outside-click close, and Escape close. Extracted out of
// schedule-picker.ts and composer-menu.ts, which both hand-rolled the same
// lifecycle. Callers own the popover's DOM/content and call `reposition()`
// themselves whenever content changes size (a re-render can grow/shrink the
// popover, which affects the flip decision). The outside-dismiss half itself
// lives in outside-dismiss.ts, shared with row-tooltip.ts (ai_todo 470).

import { wireOutsideDismiss } from "../outside-dismiss";

export interface AnchoredPopoverOptions {
  /** Element the popover is positioned relative to. */
  anchor: HTMLElement;
  /** The popover's own element (already appended to the DOM). */
  el: HTMLElement;
  /** Called once, when the popover closes (outside click, Escape, or an
   *  explicit `close()` call) - typically `pop.remove()`. */
  onClose: () => void;
}

export interface AnchoredPopoverHandle {
  /** Re-flip/re-position off the anchor's current rect. Call after any
   *  render that may have changed the popover's size. */
  reposition: () => void;
  /** Detach the outside-click/Escape listeners and run onClose. Idempotent. */
  close: () => void;
}

export function openAnchoredPopover(opts: AnchoredPopoverOptions): AnchoredPopoverHandle {
  const { anchor, el } = opts;
  let closed = false;

  function reposition(): void {
    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - el.offsetWidth - 8;
    el.style.left = `${Math.max(8, Math.min(rect.right - el.offsetWidth, maxLeft))}px`;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceAbove >= el.offsetHeight + 8 || spaceAbove >= spaceBelow) {
      el.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      el.style.top = "";
    } else {
      el.style.top = `${rect.bottom + 6}px`;
      el.style.bottom = "";
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    dismiss.dispose();
    opts.onClose();
  }

  const dismiss = wireOutsideDismiss({
    isInside: (target) => el.contains(target) || anchor.contains(target),
    onDismiss: close,
    escape: true,
  });

  return { reposition, close };
}
