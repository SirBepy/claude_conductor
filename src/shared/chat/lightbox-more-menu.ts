// "More options" kebab menu for the single-image lightbox (lightbox.ts).
// Same session-more-menu/smore-item chrome as dashboard-more-menu.ts, kept
// minimal (one flat menu, no submenus) since there's only one item today.

import { invoke } from "../ipc";
import type { LightboxContent } from "./lightbox";
import { createMoreMenu } from "../../views/sessions/more-menu-base";

type ImageContent = Extract<LightboxContent, { type: "image" }>;

async function revealInExplorer(content: ImageContent): Promise<void> {
  try {
    const path = content.sourcePath
      ?? await invoke<string>("write_temp_image", { mime: content.mime, base64: content.base64 });
    await invoke<void>("reveal_file_in_explorer", { path });
  } catch (err) {
    alert(`Failed to show image in File Explorer: ${err}`);
  }
}

const moreMenu = createMoreMenu<[ImageContent]>({
  build: (menu, close, content) => {
    const item = document.createElement("button");
    item.className = "smore-item";
    item.innerHTML = `<i class="ph ph-folder-notch-open"></i><span>Show image in File Explorer</span>`;
    item.onclick = () => { close(); void revealInExplorer(content); };
    menu.appendChild(item);
  },
});

/** Builds the lightbox's "more options" kebab button, wired to open the menu
 *  for the given image content. */
export function buildMoreMenuButton(content: ImageContent): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "lightbox-close lightbox-more-btn";
  btn.setAttribute("aria-label", "More options");
  btn.innerHTML = '<i class="ph ph-dots-three-vertical"></i>';
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    moreMenu.toggle(btn, content);
  });
  return btn;
}
