import { buildMoreMenuButton } from "./lightbox-more-menu";
import { closeAllMenus } from "../../views/sessions/menu-registry";
import { setupImageZoomPan } from "./image-zoom-pan";

export type LightboxContent =
  | { type: "image"; mime: string; base64: string; filename?: string; sourcePath?: string }
  | { type: "pdf"; base64: string; filename?: string }
  | { type: "text"; content: string; filename?: string };

let overlay: HTMLDivElement | null = null;

export interface LightboxComposerBridge {
  getDraftText(): string;
  setDraftText(text: string): void;
}

// Set by the sessions view (active-session-mount.ts) to the currently mounted
// Composer, so the lightbox's own textbox can seed from / hand back to the
// real draft without importing the views layer - same seam as
// setFileEditsProvider in file-viewer.ts.
let composerBridge: LightboxComposerBridge | null = null;
export function setLightboxComposerBridge(bridge: LightboxComposerBridge | null): void {
  composerBridge = bridge;
}

export function openLightbox(content: LightboxContent): void {
  closeLightbox();

  overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLightbox();
  });

  const close = document.createElement("button");
  close.className = "lightbox-close";
  close.setAttribute("aria-label", "Close preview");
  close.innerHTML = '<i class="ph ph-x"></i>';
  close.addEventListener("click", closeLightbox);

  const inner = document.createElement("div");
  inner.className = "lightbox-content";
  // .lightbox-content--image stretches to fill the whole overlay (see its CSS
  // doc) so a click in the empty space around a small/centered image lands on
  // `inner`, not `overlay` - the overlay's own click-outside check above never
  // sees it. Mirror that check here for clicks that land on `inner` itself
  // (never on the img, which has its own pointerdown/up pair for pan/zoom).
  inner.addEventListener("click", (e) => {
    if (e.target === inner) closeLightbox();
  });

  if (content.type === "image") {
    inner.classList.add("lightbox-content--image");
    const img = document.createElement("img");
    img.src = `data:${content.mime};base64,${content.base64}`;
    img.alt = content.filename ?? "";
    inner.appendChild(img);
    setupImageZoomPan(img, inner);
    overlay.appendChild(buildMoreMenuButton(content));
    if (composerBridge) {
      const box = document.createElement("textarea");
      box.className = "lightbox-composer";
      box.placeholder = "Type a message...";
      box.value = composerBridge.getDraftText();
      overlay.appendChild(box);
    }
  } else if (content.type === "pdf") {
    const blob = b64toBlob(content.base64, "application/pdf");
    const url = URL.createObjectURL(blob);
    const embed = document.createElement("embed");
    embed.src = url;
    embed.type = "application/pdf";
    inner.appendChild(embed);
    overlay.dataset.blobUrl = url;
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content.content;
    inner.appendChild(pre);
  }

  overlay.appendChild(close);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLTextAreaElement>(".lightbox-composer")?.focus();
  document.addEventListener("keydown", onEsc);
}

export function closeLightbox(): void {
  if (!overlay) return;
  closeAllMenus();
  const box = overlay.querySelector<HTMLTextAreaElement>(".lightbox-composer");
  if (box && composerBridge) composerBridge.setDraftText(box.value);
  const url = overlay.dataset.blobUrl;
  if (url) URL.revokeObjectURL(url);
  overlay.remove();
  overlay = null;
  document.removeEventListener("keydown", onEsc);
}

function onEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeLightbox();
}

function b64toBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
