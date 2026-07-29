import { buildMoreMenuButton } from "./lightbox-more-menu";
import { closeAllMenus } from "../../views/sessions/menu-registry";
import { setupImageZoomPan } from "./image-zoom-pan";

export type LightboxContent =
  | { type: "image"; mime: string; base64: string; filename?: string; sourcePath?: string }
  | { type: "pdf"; base64: string; filename?: string }
  | { type: "text"; content: string; filename?: string };

let overlay: HTMLDivElement | null = null;

// Composer/sidebar-visible windowed layout - TEMPORARILY REVERTED (2026-07-29)
// to bisect a reported app freeze from repeated open-image/close-image/
// switch-chat cycling. This was the newest, most cross-cutting addition (the
// only piece that reaches outside the lightbox's own subtree, tracking the
// composer element across chat switches via ResizeObserver). Re-add once
// confirmed innocent or once the actual freeze cause is found.
function watchOverlayBounds(): void {}
function unwatchOverlayBounds(): void {}

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

  if (content.type === "image") {
    inner.classList.add("lightbox-content--image");
    const img = document.createElement("img");
    img.src = `data:${content.mime};base64,${content.base64}`;
    img.alt = content.filename ?? "";
    inner.appendChild(img);
    setupImageZoomPan(img, inner);
    overlay.appendChild(buildMoreMenuButton(content));
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
  watchOverlayBounds();
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onEsc);
}

export function closeLightbox(): void {
  if (!overlay) return;
  closeAllMenus();
  unwatchOverlayBounds();
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
