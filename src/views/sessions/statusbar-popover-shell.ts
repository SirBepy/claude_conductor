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
 * either edge (on a phone it spans the full width instead), and is height-capped to the remaining window so tall content
 * scrolls inside the shell instead of spilling off-screen.
 */

import { invoke } from "../../shared/ipc";
import { isMobileViewport } from "../../shared/mobile-viewport";

const MARGIN = 8;
const GAP = 4;

/** Place a body-appended `position:fixed` shell below `anchor`, centered on it,
 *  clamped to the window, with a max-height so it scrolls rather than overflow. */
export function positionPopoverShell(el: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  // Phone: every popover spans the screen edge to edge. Content classes set
  // fixed/min widths up to 420px, which a centre-and-clamp can't fit on a
  // ~390px screen - the clamp pins left to MARGIN and the right edge spills
  // off. The --full class (session-statusbar.css) drops those widths.
  const full = isMobileViewport();
  el.classList.toggle("sb-popover--full", full);
  if (full) {
    el.style.left = `${MARGIN}px`;
    el.style.right = `${MARGIN}px`;
  } else {
    const w = el.offsetWidth;
    const centered = rect.left + rect.width / 2 - w / 2;
    const maxLeft = window.innerWidth - w - MARGIN;
    el.style.left = `${Math.max(MARGIN, Math.min(centered, maxLeft))}px`;
    el.style.right = "";
  }
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
    // kebab-menu.ts precedent: Escape closes and returns focus to the chip
    // that opened the popover, not just outside-click.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.close();
        anchor.focus();
      }
    };
    // A rotate or a window resize across the phone breakpoint changes which
    // placement applies, so re-run it rather than leave the old geometry.
    const onResize = () => this.reanchor();
    setTimeout(() => document.addEventListener("click", onOutside), 0);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    this.cleanup = () => {
      document.removeEventListener("click", onOutside);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
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

export interface CommitChoiceCfg<T> {
  onChange?: ((v: T) => void) | null;
  sessionId: string | null;
  invokeCmd: string;
  paramName: string;
  onCommit: (v: T) => void;
}

/** One model/effort commit, shared by the popover sliders and the keyboard
 *  shortcuts: a local onChange callback (a draft) wins if present, else
 *  round-trip through `invokeCmd` and call onCommit on success (logs + skips
 *  onCommit on failure). Resolves whether the value was committed. */
export async function commitChoice<T>(next: T, cfg: CommitChoiceCfg<T>): Promise<boolean> {
  if (cfg.onChange) {
    cfg.onChange(next);
    cfg.onCommit(next);
    return true;
  }
  if (!cfg.sessionId) return false;
  try {
    await invoke<void>(cfg.invokeCmd, { sessionId: cfg.sessionId, [cfg.paramName]: next });
  } catch (err) {
    console.error(`[statusbar] ${cfg.invokeCmd} failed`, err);
    return false;
  }
  cfg.onCommit(next);
  return true;
}

/** Wire a value-slider's change handler shared by the effort/model popovers. */
export function wireCommitSlider<T>(
  el: HTMLElement,
  selector: string,
  options: readonly T[],
  cfg: CommitChoiceCfg<T>,
): void {
  const slider = el.querySelector<HTMLInputElement>(selector);
  slider?.addEventListener("change", () => {
    const next = options[Number(slider.value)];
    if (next === undefined) return;
    void commitChoice(next, cfg);
  });
}
