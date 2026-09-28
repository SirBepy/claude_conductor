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
  if (align === "right") {
    menu.style.right = `${window.innerWidth - rect.right}px`;
    menu.style.left = "";
  } else {
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 4) left = window.innerWidth - menuRect.width - 4;
    if (left < 4) left = 4;
    menu.style.left = `${left}px`;
    menu.style.right = "";
  }
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
