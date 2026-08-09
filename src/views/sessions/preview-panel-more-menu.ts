// "More options" kebab menu for the preview panel - same shared
// session-more-menu/smore-item pattern as dashboard-more-menu.ts. The
// device-size row has no shared-menu equivalent, kept as bespoke .pv-seg-btn markup.

import { positionDropdown } from "./position-dropdown";
import { registerMenuCloser, closeAllMenus } from "./menu-registry";

export type DeviceWidth = "desktop" | "tablet" | "phone";

export interface PvMoreMenuDeps {
  onRefresh: () => void;
  onOpenBrowser: () => void;
  onToggleHistory: () => void;
  isHistoryOpen: () => boolean;
  onSetDeviceWidth: (w: DeviceWidth) => void;
  getDeviceWidth: () => DeviceWidth;
}

const SIZES: Array<{ w: DeviceWidth; icon: string; label: string }> = [
  { w: "desktop", icon: "monitor", label: "Desktop" },
  { w: "tablet", icon: "device-tablet", label: "Tablet" },
  { w: "phone", icon: "device-mobile", label: "Phone" },
];

let menu: HTMLElement | null = null;
let menuCleanup: (() => void) | null = null;

registerMenuCloser(closePvMoreMenu);

export function closePvMoreMenu(): void {
  menu?.remove();
  menu = null;
  if (menuCleanup) { menuCleanup(); menuCleanup = null; }
}

function openPvMoreMenu(btn: HTMLButtonElement, deps: PvMoreMenuDeps): void {
  closeAllMenus();
  const m = document.createElement("div");
  m.className = "session-more-menu";
  document.body.appendChild(m);
  menu = m;

  const refreshItem = document.createElement("button");
  refreshItem.type = "button";
  refreshItem.className = "smore-item";
  refreshItem.innerHTML = `<i class="ph ph-arrow-clockwise"></i><span>Refresh</span>`;
  refreshItem.onclick = () => { closePvMoreMenu(); deps.onRefresh(); };
  m.appendChild(refreshItem);

  const browserItem = document.createElement("button");
  browserItem.type = "button";
  browserItem.className = "smore-item";
  browserItem.innerHTML = `<i class="ph ph-arrow-square-out"></i><span>Open in browser</span>`;
  browserItem.onclick = () => { closePvMoreMenu(); deps.onOpenBrowser(); };
  m.appendChild(browserItem);

  const historyOn = deps.isHistoryOpen();
  const historyItem = document.createElement("button");
  historyItem.type = "button";
  historyItem.className = "smore-item" + (historyOn ? " is-on" : "");
  historyItem.innerHTML =
    `<i class="ph ph-clock-counter-clockwise"></i><span>Show history</span>` +
    (historyOn ? `<span class="smore-check-dot"></span>` : "");
  historyItem.onclick = () => { closePvMoreMenu(); deps.onToggleHistory(); };
  m.appendChild(historyItem);

  const sep1 = document.createElement("div");
  sep1.className = "smore-sep";
  m.appendChild(sep1);

  const sizeLabel = document.createElement("span");
  sizeLabel.className = "smore-section-label";
  sizeLabel.textContent = "Toggle size";
  m.appendChild(sizeLabel);

  const curWidth = deps.getDeviceWidth();
  for (const s of SIZES) {
    const segBtn = document.createElement("button");
    segBtn.type = "button";
    segBtn.className = "pv-seg-btn" + (curWidth === s.w ? " on" : "");
    segBtn.dataset.w = s.w;
    segBtn.innerHTML = `<i class="ph ph-${s.icon}"></i>${s.label}`;
    segBtn.onclick = () => { closePvMoreMenu(); deps.onSetDeviceWidth(s.w); };
    m.appendChild(segBtn);
  }

  const sep2 = document.createElement("div");
  sep2.className = "smore-sep";
  m.appendChild(sep2);

  const popoutItem = document.createElement("button");
  popoutItem.type = "button";
  popoutItem.className = "smore-item is-disabled";
  popoutItem.disabled = true;
  popoutItem.innerHTML = `<i class="ph ph-arrows-out-simple"></i><span>Pop-out window (coming soon)</span>`;
  m.appendChild(popoutItem);

  positionDropdown(m, btn);

  const onOutside = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (!m.contains(t) && t !== btn) closePvMoreMenu();
  };
  setTimeout(() => document.addEventListener("click", onOutside), 0);
  menuCleanup = () => document.removeEventListener("click", onOutside);
}

/** Toggle the menu open/closed for the given trigger button. */
export function togglePvMoreMenu(btn: HTMLButtonElement, deps: PvMoreMenuDeps): void {
  if (menu) closePvMoreMenu();
  else openPvMoreMenu(btn, deps);
}
