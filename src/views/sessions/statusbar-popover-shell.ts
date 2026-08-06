/**
 * Shared shell for every statusline-chip popover. One wrapper look, one
 * positioning rule, one dismissal path - so the six chip popovers stop drifting
 * apart. A popover class holds a PopoverShell instance and feeds it freshly
 * built HTML; the shell owns the body-append, the placement, the outside-click
 * teardown, and the scroll clamp.
 *
 * Placement contract (matches the statusbar living at the TOP of the pane, so
 * there is always room below a chip): the popover opens directly BELOW its chip,
 * is CENTERED on the chip horizontally, is pulled back inside the window on
 * either edge, and is height-capped to the remaining window so tall content
 * scrolls inside the shell instead of spilling off-screen.
 */

const MARGIN = 8;
const GAP = 4;

/** Place a body-appended `position:fixed` shell below `anchor`, centered on it,
 *  clamped to the window, with a max-height so it scrolls rather than overflow. */
export function positionPopoverShell(el: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const centered = rect.left + rect.width / 2 - w / 2;
  const maxLeft = window.innerWidth - w - MARGIN;
  el.style.left = `${Math.max(MARGIN, Math.min(centered, maxLeft))}px`;
  const top = rect.bottom + GAP;
  el.style.top = `${top}px`;
  el.style.maxHeight = `${Math.max(80, window.innerHeight - top - MARGIN)}px`;
}

export interface PopoverShellOptions {
  /** Content-specific class(es) on the root (width, inner padding/layout). */
  className?: string;
  /** Wire event handlers on the freshly built content before it is positioned. */
  wire?: (el: HTMLElement) => void;
  /** Fired from close() only (not from open()'s in-place rebuild teardown), so
   *  a popover can stop a background job tied to "is this popover open" no
   *  matter which path closed it (button toggle, outside-click, a sibling
   *  popover taking over). */
  onClose?: () => void;
}

/**
 * Owns one popover's DOM lifecycle. Rebuilds in place when `open` is called
 * while already open (used to refresh streamed content and re-anchor after the
 * chip row re-renders).
 */
export class PopoverShell {
  private el: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;
  private onCloseCb: (() => void) | null = null;

  get isOpen(): boolean { return this.el !== null; }

  open(anchor: HTMLElement, html: string, opts: PopoverShellOptions = {}): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();

    const pop = document.createElement("div");
    pop.className = opts.className ? `sb-popover ${opts.className}` : "sb-popover";
    pop.innerHTML = html;
    document.body.appendChild(pop);
    this.el = pop;
    this.anchor = anchor;
    this.onCloseCb = opts.onClose ?? null;
    opts.wire?.(pop);

    positionPopoverShell(pop, anchor);

    const onOutside = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
    };
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    this.cleanup = () => document.removeEventListener("click", onOutside);
  }

  /** Reposition against `anchor` (defaults to the last one) without rebuilding. */
  reanchor(anchor?: HTMLElement): void {
    if (anchor) this.anchor = anchor;
    if (this.el && this.anchor) positionPopoverShell(this.el, this.anchor);
  }

  close(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.el?.remove();
    this.el = null;
    this.anchor = null;
    const onClose = this.onCloseCb;
    this.onCloseCb = null;
    onClose?.();
  }
}
