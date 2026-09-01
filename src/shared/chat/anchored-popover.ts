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

export interface ActionPopoverOptions {
  /** Element the popover is positioned relative to. */
  anchor: HTMLElement;
  /** Class name(s) applied to the popover's root div. */
  className: string;
  /** innerHTML for the popover body. */
  bodyHtml: string;
  /** Selector matching the buttons inside bodyHtml that trigger onPick. */
  buttonSelector: string;
  onPick: (btn: HTMLButtonElement) => void;
  /** Index (into the buttonSelector matches, in DOM order) focused when the
   *  popover opens. Defaults to 0. */
  defaultIndex?: number;
  /** Extra teardown run after the popover element is removed (outside
   *  click, Escape, or an explicit `close()`) - not called on a pick. */
  onClose?: () => void;
}

export interface ActionPopoverHandle {
  close: () => void;
}

/** Shared create/append/reposition/dismiss scaffolding for a body-appended
 *  popover with a flat list of clickable rows (ai_todo 644). Callers own the
 *  result protocol (a per-item callback vs a resolved Promise); this only
 *  owns the DOM plumbing. */
export function openActionPopover(opts: ActionPopoverOptions): ActionPopoverHandle {
  const pop = document.createElement("div");
  pop.className = opts.className;
  pop.innerHTML = opts.bodyHtml;
  document.body.appendChild(pop);

  const popover = openAnchoredPopover({
    anchor: opts.anchor,
    el: pop,
    onClose: () => {
      pop.remove();
      opts.onClose?.();
    },
  });

  const buttons = Array.from(pop.querySelectorAll<HTMLButtonElement>(opts.buttonSelector));
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => opts.onPick(btn));
  });

  // Roving focus: Up/Down move it between rows; a focused <button>'s native
  // Enter/Space behavior fires the click listener above for free.
  pop.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    // -1 (focus outside the button set) must not fall through the modulo as-is:
    // that landed ArrowUp on the second-to-last row instead of the last.
    const from = current === -1 ? (delta > 0 ? -1 : 0) : current;
    buttons[(from + delta + buttons.length) % buttons.length]?.focus();
  });
  buttons[opts.defaultIndex ?? 0]?.focus();

  popover.reposition();
  return { close: popover.close };
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
