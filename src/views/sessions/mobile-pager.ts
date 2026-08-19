// Phone Chat / Preview / Todos pager (Joe, 2026-08-19); below 768px the rail
// was hidden outright. Swiping is CSS scroll-snap on `.sessions-layout`, not a
// JS gesture: an iframe swallows touch before it reaches us (same reason
// preview-panel-resize.ts inerts .pv-frame mid-drag), so the bar is the way out.

import type { PreviewController, RailTab } from "./preview-panel";

const PAGE_CHAT = 0;
const PAGE_RAIL = 1;
/** Below this a horizontal move is still a tap on a tab, not a page drag. */
const TAP_SLOP = 8;

export interface MobilePagerHandle {
  destroy(): void;
}

type Target = "chat" | RailTab;

const BUTTONS: Array<{ target: Target; icon: string; label: string }> = [
  { target: "chat", icon: "ph-chat-circle", label: "Chat" },
  { target: "preview", icon: "ph-monitor-play", label: "Preview" },
  { target: "todos", icon: "ph-list-checks", label: "Todos" },
];

function barHtml(): string {
  return BUTTONS.map(
    (b) =>
      `<button type="button" class="mtab" data-target="${b.target}">` +
      `<i class="ph ${b.icon}"></i><span class="mtab-lbl">${b.label}</span></button>`,
  ).join("");
}

/**
 * @param host   empty element the bar renders into (hidden above 768px by CSS)
 * @param layout `.sessions-layout`, the scroll-snap container
 */
export function mountMobilePager(
  host: HTMLElement,
  layout: HTMLElement,
  preview: PreviewController,
): MobilePagerHandle {
  host.className = "mobile-tabbar";
  host.innerHTML = barHtml();

  // Only decides which of the two rail buttons reads as active; the rail
  // itself owns the real value.
  let railTarget: RailTab = "preview";
  let dragStartX = 0;
  let dragStartY = 0;
  let dragFromScroll = 0;
  let dragging = false;
  let pointerId: number | null = null;
  let swallowNextClick = false;

  const paint = (): void => {
    const onRail = layout.scrollLeft > layout.clientWidth / 2;
    const active: Target = onRail ? railTarget : "chat";
    for (const btn of host.querySelectorAll<HTMLElement>(".mtab")) {
      btn.classList.toggle("on", btn.dataset.target === active);
    }
  };

  const scrollToPage = (page: number): void => {
    layout.scrollTo({ left: page * layout.clientWidth, behavior: "smooth" });
  };

  const onClick = (e: MouseEvent): void => {
    // A drag ends in a click on whichever tab the finger lifted over; without
    // this the gesture would also fire that tab's target.
    if (swallowNextClick) { swallowNextClick = false; return; }
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".mtab");
    const target = btn?.dataset.target as Target | undefined;
    if (!target) return;
    if (target === "chat") {
      scrollToPage(PAGE_CHAT);
    } else {
      railTarget = target;
      preview.setTab(target);
      // Unconditional: re-tapping the active tab is how you return from a page
      // the iframe owns, so it must scroll even when nothing else changed.
      scrollToPage(PAGE_RAIL);
    }
    paint();
  };

  // Passive: this only reads scrollLeft, so it must never block the scroll it
  // is following.
  const onScroll = (): void => paint();

  // ── Dragging the bar itself ───────────────────────────────────────────────
  // The swipe surface that always works (Joe, 2026-08-19): paging by dragging a
  // page relies on the browser's scrolling, which the iframe swallows, but the
  // bar is our DOM on every page.
  const onDown = (e: PointerEvent): void => {
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragFromScroll = layout.scrollLeft;
    dragging = false;
    pointerId = e.pointerId;
  };

  const onMove = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    const dx = e.clientX - dragStartX;
    if (!dragging) {
      // Vertical-dominant movement is a scroll attempt, not a page drag, and a
      // move under the slop is still a tap.
      if (Math.abs(dx) < TAP_SLOP || Math.abs(dx) <= Math.abs(e.clientY - dragStartY)) return;
      dragging = true;
      host.setPointerCapture(e.pointerId);
      // Snapping fights a manually-driven scrollLeft, so it is off until release.
      layout.style.scrollSnapType = "none";
    }
    const max = layout.scrollWidth - layout.clientWidth;
    layout.scrollLeft = Math.max(0, Math.min(max, dragFromScroll - dx));
  };

  /** Glides to `page`, restoring snapping only once we arrive. Restore it
   *  mid-page and the browser snaps to whichever side is nearer, cancelling
   *  the scroll we asked for and silently reversing the drag. */
  const settleTo = (page: number): void => {
    const left = page * layout.clientWidth;
    layout.scrollTo({ left, behavior: "smooth" });
    const started = performance.now();
    const tick = (): void => {
      if (Math.abs(layout.scrollLeft - left) < 2 || performance.now() - started > 700) {
        layout.style.scrollSnapType = "";
        paint();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const endDrag = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return;
    pointerId = null;
    if (!dragging) return;
    dragging = false;
    swallowNextClick = true;
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
    // Past a third of a page commits, so a short flick still pages rather than
    // springing back the way a strict halfway rule would.
    const width = layout.clientWidth || 1;
    const moved = layout.scrollLeft - dragFromScroll;
    const from = Math.round(dragFromScroll / width);
    const page = Math.abs(moved) > width / 3 ? from + Math.sign(moved) : from;
    settleTo(Math.max(PAGE_CHAT, Math.min(PAGE_RAIL, page)));
  };

  host.addEventListener("click", onClick);
  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);
  layout.addEventListener("scroll", onScroll, { passive: true });
  paint();

  return {
    destroy(): void {
      host.removeEventListener("click", onClick);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", endDrag);
      host.removeEventListener("pointercancel", endDrag);
      layout.removeEventListener("scroll", onScroll);
      layout.style.scrollSnapType = "";
      host.innerHTML = "";
    },
  };
}
