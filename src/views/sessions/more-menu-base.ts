// Shared open/close/toggle + outside-click-dismiss boilerplate behind every
// `session-more-menu` kebab (view/dashboard/lightbox/preview-panel/rate-limit
// banner). Each caller supplies only its content builder + anchoring quirks.

import { positionDropdown, type PositionDropdownOpts } from "./position-dropdown";
import { registerMenuCloser, closeAllMenus } from "./menu-registry";

export interface MoreMenuOpts<Args extends unknown[]> {
  className?: string;
  position?: PositionDropdownOpts;
  /** Extra outside-click exclusion beyond "not the menu, not the anchor". */
  isOutside?: (target: Node, menu: HTMLElement, btn: HTMLElement) => boolean;
  /** Runs before the menu DOM is removed, e.g. relocating borrowed elements back. */
  beforeClose?: (menu: HTMLElement) => void;
  build: (menu: HTMLElement, close: () => void, ...args: Args) => void;
}

export interface MoreMenuHandle<Args extends unknown[]> {
  open(btn: HTMLElement, ...args: Args): void;
  close(): void;
  toggle(btn: HTMLElement, ...args: Args): void;
  element(): HTMLElement | null;
}

/** One module-scoped open/close/toggle menu instance, registered with
 *  `closeAllMenus` and dismissed on outside click via a deferred listener. */
export function createMoreMenu<Args extends unknown[] = []>(
  opts: MoreMenuOpts<Args>,
): MoreMenuHandle<Args> {
  let menu: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;

  function close(): void {
    if (menu) opts.beforeClose?.(menu);
    menu?.remove();
    menu = null;
    if (cleanup) { cleanup(); cleanup = null; }
  }

  function open(btn: HTMLElement, ...args: Args): void {
    closeAllMenus();
    const m = document.createElement("div");
    m.className = opts.className ?? "session-more-menu";
    document.body.appendChild(m);
    menu = m;

    opts.build(m, close, ...args);

    positionDropdown(m, btn, opts.position);

    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const outside = opts.isOutside
        ? opts.isOutside(target, m, btn)
        : !m.contains(target) && target !== btn;
      if (outside) close();
    };
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    cleanup = () => document.removeEventListener("click", onOutside);
  }

  function toggle(btn: HTMLElement, ...args: Args): void {
    if (menu) close();
    else open(btn, ...args);
  }

  registerMenuCloser(close);

  return { open, close, toggle, element: () => menu };
}
