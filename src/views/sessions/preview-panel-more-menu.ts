// "More options" kebab menu for the preview panel - same shared
// session-more-menu/smore-item pattern as dashboard-more-menu.ts. The
// device-size row has no shared-menu equivalent, kept as bespoke .pv-seg-btn markup.

import { createMoreMenu } from "./more-menu-base";

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

const pvMenu = createMoreMenu<[PvMoreMenuDeps]>({
  build: (menu, close, deps) => {
    const refreshItem = document.createElement("button");
    refreshItem.type = "button";
    refreshItem.className = "smore-item";
    refreshItem.innerHTML = `<i class="ph ph-arrow-clockwise"></i><span>Refresh</span>`;
    refreshItem.onclick = () => { close(); deps.onRefresh(); };
    menu.appendChild(refreshItem);

    const browserItem = document.createElement("button");
    browserItem.type = "button";
    browserItem.className = "smore-item";
    browserItem.innerHTML = `<i class="ph ph-arrow-square-out"></i><span>Open in browser</span>`;
    browserItem.onclick = () => { close(); deps.onOpenBrowser(); };
    menu.appendChild(browserItem);

    const historyOn = deps.isHistoryOpen();
    const historyItem = document.createElement("button");
    historyItem.type = "button";
    historyItem.className = "smore-item" + (historyOn ? " is-on" : "");
    historyItem.innerHTML =
      `<i class="ph ph-clock-counter-clockwise"></i><span>Show history</span>` +
      (historyOn ? `<span class="smore-check-dot"></span>` : "");
    historyItem.onclick = () => { close(); deps.onToggleHistory(); };
    menu.appendChild(historyItem);

    const sep1 = document.createElement("div");
    sep1.className = "smore-sep";
    menu.appendChild(sep1);

    const sizeLabel = document.createElement("span");
    sizeLabel.className = "smore-section-label";
    sizeLabel.textContent = "Toggle size";
    menu.appendChild(sizeLabel);

    const curWidth = deps.getDeviceWidth();
    for (const s of SIZES) {
      const segBtn = document.createElement("button");
      segBtn.type = "button";
      segBtn.className = "pv-seg-btn" + (curWidth === s.w ? " on" : "");
      segBtn.dataset.w = s.w;
      segBtn.innerHTML = `<i class="ph ph-${s.icon}"></i>${s.label}`;
      segBtn.onclick = () => { close(); deps.onSetDeviceWidth(s.w); };
      menu.appendChild(segBtn);
    }

    const sep2 = document.createElement("div");
    sep2.className = "smore-sep";
    menu.appendChild(sep2);

    const popoutItem = document.createElement("button");
    popoutItem.type = "button";
    popoutItem.className = "smore-item is-disabled";
    popoutItem.disabled = true;
    popoutItem.innerHTML = `<i class="ph ph-arrows-out-simple"></i><span>Pop-out window (coming soon)</span>`;
    menu.appendChild(popoutItem);
  },
});

export function closePvMoreMenu(): void {
  pvMenu.close();
}

/** Toggle the menu open/closed for the given trigger button. */
export function togglePvMoreMenu(btn: HTMLButtonElement, deps: PvMoreMenuDeps): void {
  pvMenu.toggle(btn, deps);
}
