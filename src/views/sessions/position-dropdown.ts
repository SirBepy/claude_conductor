export interface PositionDropdownOpts {
  align?: "left" | "right";
}

/** Position a dropdown menu below an anchor button, clamped to viewport edges.
 *  align:"right" (default) right-aligns the menu to the button's right edge.
 *  align:"left" left-aligns the menu to the button's left edge.
 */
export function positionDropdown(
  menu: HTMLElement,
  anchor: HTMLElement,
  opts?: PositionDropdownOpts,
): void {
  const MARGIN = 4;
  const align = opts?.align ?? "right";
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - MARGIN) top = rect.top - menuRect.height - MARGIN;
  // Flipping above the anchor can still start off-screen for a menu taller
  // than both the space below AND above it - clamp so max-height (next) has
  // a real viewport-bottom to measure against instead of overshooting past
  // window.innerHeight. getBoundingClientRect, not offsetHeight: the latter
  // rounds and clips at DPI scale (see PopoverShell's positionPopoverShell).
  if (top < MARGIN) top = MARGIN;
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${Math.max(80, window.innerHeight - top - MARGIN)}px`;
  menu.style.overflowY = "auto";
  menu.style.overflowX = "hidden";
  // An anchor hugging either screen edge (a chat head, a kebab) must never
  // push the menu off it. A menu wider than the viewport is capped to it so
  // the clamp always has room.
  const maxWidth = window.innerWidth - MARGIN * 2;
  menu.style.maxWidth = `${maxWidth}px`;
  const width = Math.min(menuRect.width, maxWidth);
  // Right-aligned and room on the left: stay right-anchored so a menu that
  // grows after opening (late-loaded rows) keeps hugging the button's right
  // edge, held MARGIN in when the button itself sits flush against the screen.
  const right = Math.max(MARGIN, window.innerWidth - rect.right);
  if (align === "right" && window.innerWidth - right - width >= MARGIN) {
    menu.style.right = `${right}px`;
    menu.style.left = "";
    return;
  }
  const wanted = align === "right" ? rect.right - width : rect.left;
  const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));
  menu.style.left = `${left}px`;
  menu.style.right = "";
}

/** Position a submenu to the right (or left if no room) of its parent item,
 *  clamped to the viewport. */
export function positionSubmenu(sub: HTMLElement, parent: HTMLElement): void {
  const itemRect = parent.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();
  let left = itemRect.right + 4;
  if (left + subRect.width > window.innerWidth - 4) {
    left = itemRect.left - subRect.width - 4;
  }
  // Neither side has room on a phone: cap the width to the viewport and let
  // the submenu overlap its parent menu instead of clipping off-screen.
  sub.style.maxWidth = `${window.innerWidth - 8}px`;
  const width = Math.min(subRect.width, window.innerWidth - 8);
  if (left < 4) left = 4;
  if (left + width > window.innerWidth - 4) left = window.innerWidth - width - 4;
  let top = itemRect.top;
  if (top + subRect.height > window.innerHeight - 4) {
    top = window.innerHeight - subRect.height - 4;
  }
  if (top < 4) top = 4;
  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
  sub.style.maxHeight = `${Math.max(80, window.innerHeight - top - 4)}px`;
  sub.style.overflowY = "auto";
  sub.style.overflowX = "hidden";
}
