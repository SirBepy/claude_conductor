import { registerOverlayBack } from "./back-button";
import "../styles/sidemenu.css";

// While the slide-out menu is open, the phone's back button should close it
// (not navigate). Registered on open, disposed on close.
let sidemenuBackDisposer: (() => void) | null = null;

export function openSidemenu(): void {
  document.getElementById("sidemenu")?.classList.add("open");
  document.getElementById("sidemenuBackdrop")?.classList.add("open");
  sidemenuBackDisposer ??= registerOverlayBack(() => {
    closeSidemenu();
    return true;
  });
}

export function closeSidemenu(): void {
  document.getElementById("sidemenu")?.classList.remove("open");
  document.getElementById("sidemenuBackdrop")?.classList.remove("open");
  sidemenuBackDisposer?.();
  sidemenuBackDisposer = null;
}

export function updateSidemenuActive(viewName: string): void {
  document.querySelectorAll<HTMLElement>(".sidemenu-nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === viewName);
  });
}

// Back-compat: router.ts reads window.updateSidemenuActive to sync highlight.
(window as unknown as { updateSidemenuActive?: (n: string) => void }).updateSidemenuActive = updateSidemenuActive;
