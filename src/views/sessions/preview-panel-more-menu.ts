// "More options" kebab menu for the preview panel - same shared
// session-more-menu/smore-item pattern as dashboard-more-menu.ts. The
// device-size row has no shared-menu equivalent, kept as bespoke .pv-seg-btn markup.

import { createMoreMenu } from "./more-menu-base";

export type DeviceWidth = "desktop" | "tablet" | "phone";

// Two items left this menu in todo 692: "Show history" (the version number is
// the toggle now) and "Pop-out window" (it moved up into the rail strip, since
// it acts on the whole rail rather than on the Preview tab).
export interface PvMoreMenuDeps {
  onRefresh: () => void;
  onOpenBrowser: () => void;
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
  },
});

export function closePvMoreMenu(): void {
  pvMenu.close();
}

/** Toggle the menu open/closed for the given trigger button. */
export function togglePvMoreMenu(btn: HTMLButtonElement, deps: PvMoreMenuDeps): void {
  pvMenu.toggle(btn, deps);
}
