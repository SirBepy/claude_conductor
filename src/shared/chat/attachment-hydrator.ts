import { invoke } from "../ipc";
import { escapeHtml } from "../escape-html";
import { openLightbox, type LightboxContent } from "./lightbox";
import { basename } from "../path-utils";
import { collectChatImages } from "./chat-image-gallery-data";
import { openChatImageGallery } from "./chat-image-gallery";
import { getChatRendererSnapshot } from "./chat-renderer-bridge";

const chipData = new WeakMap<HTMLElement, { mime: string; base64: string; path: string }>();

/** Per-thumb attachment payload, so the chat-wide image gallery
 *  (chat-image-gallery-data.ts) can read a sent attachment's image data
 *  without duplicating it into DOM attributes. Mirrors screenshot-row.ts's
 *  rowShots map. */
export const attachmentShots = new WeakMap<
  HTMLElement,
  { mime: string; base64: string; filename?: string; sourcePath?: string }
>();

export function mimeToIcon(mime: string): string {
  if (mime === "application/pdf") return "ph-file-pdf";
  if (mime.startsWith("text/") || mime === "application/json") return "ph-file-text";
  return "ph-file";
}

export async function hydrateAttachments(el: HTMLElement): Promise<void> {
  const chips = Array.from(el.querySelectorAll<HTMLElement>(".attachment-chip[data-attachment-path]"));
  for (const chip of chips) {
    const path = chip.dataset.attachmentPath;
    if (!path) continue;
    const name = chip.dataset.filename ?? basename(path) ?? "file";
    try {
      const data = await invoke<{ mime: string; base64: string }>("read_attachment", { path });
      if (!document.contains(chip)) continue;
      if (data.mime.startsWith("image/")) {
        const thumb = document.createElement("div");
        thumb.className = "sent-attachment-thumb";
        const img = document.createElement("img");
        // base64 payload is never HTML-escaped: its alphabet ([A-Za-z0-9+/=])
        // can't contain &<>"' - escaping it wastes a full string scan (this
        // can be multiple MB for a screenshot) for zero benefit.
        img.src = `data:${escapeHtml(data.mime)};base64,${data.base64}`;
        img.alt = name;
        img.title = "Click to enlarge";
        thumb.appendChild(img);
        const { mime, base64 } = data;
        attachmentShots.set(thumb, { mime, base64, filename: name, sourcePath: path });
        thumb.addEventListener("click", () => {
          const snapshot = getChatRendererSnapshot();
          if (snapshot) {
            const collection = collectChatImages(snapshot.messages, snapshot.messageEls);
            const foundIndex = collection.images.findIndex((ci) => ci.kind === "attachment" && ci.data === base64 && ci.mime === mime);
            if (foundIndex >= 0) {
              openChatImageGallery(collection, foundIndex);
              return;
            }
          }
          openLightbox({ type: "image", mime, base64, filename: name, sourcePath: path });
        });
        chip.replaceWith(thumb);
      } else {
        chipData.set(chip, { ...data, path });
        chip.classList.remove("loading");
        const icon = mimeToIcon(data.mime);
        if (data.mime === "application/pdf" || data.mime.startsWith("text/") || data.mime === "application/json") {
          chip.classList.add("previewable");
        }
        chip.innerHTML = `<i class="ph ${escapeHtml(icon)}"></i><span class="chip-name">${escapeHtml(name)}</span>`;
      }
    } catch {
      chip.innerHTML = `<i class="ph ph-warning"></i><span class="chip-name">${escapeHtml(name)}</span>`;
    }
  }
}

export function chipToLightboxContent(chip: HTMLElement): LightboxContent | null {
  const data = chipData.get(chip);
  if (!data) return null;
  const name = chip.dataset.filename;
  if (data.mime.startsWith("image/")) return { type: "image", mime: data.mime, base64: data.base64, filename: name, sourcePath: data.path };
  if (data.mime === "application/pdf") return { type: "pdf", base64: data.base64, filename: name };
  if (data.mime.startsWith("text/") || data.mime === "application/json") {
    try { return { type: "text", content: atob(data.base64), filename: name }; } catch { return null; }
  }
  return null;
}
