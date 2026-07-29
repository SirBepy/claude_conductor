// "More options" kebab menu for the single-image lightbox (lightbox.ts).
// Same session-more-menu/smore-item chrome + positionDropdown/menu-registry
// pattern as dashboard-more-menu.ts, kept minimal (one flat menu, no
// submenus) since there's only one item today.

import { invoke } from "../ipc";
import type { LightboxContent } from "./lightbox";
import { positionDropdown } from "../../views/sessions/position-dropdown";
import { registerMenuCloser, closeAllMenus } from "../../views/sessions/menu-registry";

type ImageContent = Extract<LightboxContent, { type: "image" }>;

let menu: HTMLElement | null = null;
let menuCleanup: (() => void) | null = null;

registerMenuCloser(closeMoreMenu);

function closeMoreMenu(): void {
  menu?.remove();
  menu = null;
  if (menuCleanup) { menuCleanup(); menuCleanup = null; }
}

async function revealInExplorer(content: ImageContent): Promise<void> {
  try {
    const path = content.sourcePath
      ?? await invoke<string>("write_temp_image", { mime: content.mime, base64: content.base64 });
    await invoke<void>("reveal_file_in_explorer", { path });
  } catch (err) {
    alert(`Failed to show image in File Explorer: ${err}`);
  }
}

function openMoreMenu(btn: HTMLButtonElement, content: ImageContent): void {
  closeAllMenus();
  const m = document.createElement("div");
  m.className = "session-more-menu";
  document.body.appendChild(m);
  menu = m;

  const item = document.createElement("button");
  item.className = "smore-item";
  item.innerHTML = `<i class="ph ph-folder-notch-open"></i><span>Show image in File Explorer</span>`;
  item.onclick = () => { closeMoreMenu(); void revealInExplorer(content); };
  m.appendChild(item);

  positionDropdown(m, btn);

  const onOutside = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (!m.contains(t) && t !== btn) closeMoreMenu();
  };
  setTimeout(() => document.addEventListener("click", onOutside), 0);
  menuCleanup = () => document.removeEventListener("click", onOutside);
}

/** Builds the lightbox's "more options" kebab button, wired to open the menu
 *  for the given image content. */
export function buildMoreMenuButton(content: ImageContent): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "lightbox-close lightbox-more-btn";
  btn.setAttribute("aria-label", "More options");
  btn.innerHTML = '<i class="ph ph-dots-three-vertical"></i>';
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) closeMoreMenu();
    else openMoreMenu(btn, content);
  });
  return btn;
}
