// Shared hover tooltip for `.info-tooltip` boxes (widgets.css), delegated so
// it survives re-renders. Two placements: "side" (sidebar rows, anchor via
// [data-tip]) and "above" (settings info-icons, anchor + text via .info-wrap).
// Outside-tap dismiss builds on outside-dismiss.ts, shared with
// anchored-popover.ts (ai_todo 470).

import { wireOutsideDismiss } from "./outside-dismiss";

const PAD_SIDE = 10;
const PAD_ABOVE = 8;
// Backstop for a tap that shows the tooltip but is then followed by
// navigation away, so the box (parented to document.body) can't survive
// past this on a view where nothing else ever dismisses it.
const AUTO_HIDE_MS = 3000;

let box: HTMLElement | null = null;
let currentAnchor: HTMLElement | null = null;
let autoHideTimer: ReturnType<typeof setTimeout> | null = null;
let globalDismissWired = false;

function ensureBox(): HTMLElement {
  if (box?.isConnected) return box;
  box = document.createElement("div");
  box.className = "info-tooltip cc-row-tip";
  document.body.appendChild(box);
  return box;
}

export function hideRowTooltip(): void {
  if (box) box.style.display = "none";
  currentAnchor = null;
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}

// Touch has no hover-out, so mouseover/mouseout alone (below) never dismiss a
// tap-shown tooltip. Mobile's touch-to-mouse mapping fires pointerdown BEFORE
// the compatibility mouseover, so this always resolves the PREVIOUS tooltip
// before show() reacts to the new tap - wired lazily on first show().
function wireGlobalDismiss(): void {
  if (globalDismissWired) return;
  globalDismissWired = true;
  wireOutsideDismiss({
    isInside: (target) => !currentAnchor || currentAnchor.contains(target) || !!box?.contains(target),
    onDismiss: hideRowTooltip,
    eventType: "pointerdown",
  });
}

// Prefer the right side (sidebar rail lives on the left edge); flip left when
// there isn't room, and clamp vertically so it never leaves the viewport.
function placeSide(a: DOMRect, t: DOMRect): { left: number; top: number } {
  let left = a.right + PAD_SIDE;
  if (left + t.width > window.innerWidth - PAD_SIDE) left = a.left - t.width - PAD_SIDE;
  if (left < PAD_SIDE) left = PAD_SIDE;
  let top = a.top + a.height / 2 - t.height / 2;
  if (top < PAD_SIDE) top = PAD_SIDE;
  if (top + t.height > window.innerHeight - PAD_SIDE) top = window.innerHeight - PAD_SIDE - t.height;
  return { left, top };
}

// Centered above the icon; flips below when there isn't room above. Clamps
// horizontally only, matching the original settings behaviour.
function placeAbove(a: DOMRect, t: DOMRect): { left: number; top: number } {
  let top = a.top - t.height - PAD_ABOVE;
  let left = a.left + a.width / 2 - t.width / 2;
  if (left < PAD_ABOVE) left = PAD_ABOVE;
  if (left + t.width > window.innerWidth - PAD_ABOVE) left = window.innerWidth - PAD_ABOVE - t.width;
  if (top < PAD_ABOVE) top = a.bottom + PAD_ABOVE;
  return { left, top };
}

function show(anchor: HTMLElement, text: string, placement: "side" | "above"): void {
  const el = ensureBox();
  el.textContent = text;
  el.style.display = "block";
  const a = anchor.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  const { left, top } = placement === "above" ? placeAbove(a, t) : placeSide(a, t);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  currentAnchor = anchor;
  if (autoHideTimer) clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(hideRowTooltip, AUTO_HIDE_MS);
  wireGlobalDismiss();
}

export interface TooltipOpts {
  /** "side" (default): anchor + text via `[data-tip]`. "above": anchor is
   *  `.info-icon`, text read from the sibling `.info-tooltip` in `.info-wrap`. */
  placement?: "side" | "above";
}

/** Wire delegated hover tooltips for every anchor inside `root`. Safe to call
 *  repeatedly; only the first call per element binds. */
export function attachTooltips(root: HTMLElement, opts?: TooltipOpts): void {
  if (root.dataset.tipWired === "1") return;
  root.dataset.tipWired = "1";
  const placement = opts?.placement ?? "side";
  const selector = placement === "above" ? ".info-icon" : "[data-tip]";

  const textOf = (anchor: HTMLElement): string | undefined =>
    placement === "above"
      ? anchor.closest(".info-wrap")?.querySelector(".info-tooltip")?.textContent ?? undefined
      : anchor.dataset.tip;

  root.addEventListener("mouseover", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLElement>(selector);
    const text = anchor && textOf(anchor);
    if (anchor && text) show(anchor, text, placement);
  });
  root.addEventListener("mouseout", (e) => {
    const anchor = (e.target as HTMLElement).closest<HTMLElement>(selector);
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (anchor && (!to || !anchor.contains(to))) hideRowTooltip();
  });
  root.addEventListener("scroll", hideRowTooltip, true);
}

/** Sidebar-row wrapper: side placement via `[data-tip]`. */
export function attachRowTooltips(root: HTMLElement): void {
  attachTooltips(root, { placement: "side" });
}
