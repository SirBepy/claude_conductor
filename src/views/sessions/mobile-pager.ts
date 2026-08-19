// Phone Chat / Preview / Todos pager (Joe, 2026-08-19); below 768px the rail
// was hidden outright. Swiping is CSS scroll-snap on `.sessions-layout`, not a
// JS gesture: an iframe swallows touch before it reaches us (same reason
// preview-panel-resize.ts inerts .pv-frame mid-drag), so the bar is the way out.

import type { PreviewController, RailTab } from "./preview-panel";

const PAGE_CHAT = 0;
const PAGE_RAIL = 1;

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

  host.addEventListener("click", onClick);
  layout.addEventListener("scroll", onScroll, { passive: true });
  paint();

  return {
    destroy(): void {
      host.removeEventListener("click", onClick);
      layout.removeEventListener("scroll", onScroll);
      host.innerHTML = "";
    },
  };
}
