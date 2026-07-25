import { base64ToUtf8 } from "./chat-transforms";
import { openLightbox } from "./lightbox";
import { chipToLightboxContent } from "./attachment-hydrator";
import { showView } from "../navigation";
import { openPrPreviewModal } from "./pr-review-modal";
import { getScreenshotRowShots } from "./screenshot-row";
import { openScreenshotGallery } from "./screenshot-gallery";

let tableOverlay: HTMLDivElement | null = null;

function closeTableOverlay(): void {
  if (!tableOverlay) return;
  tableOverlay.remove();
  tableOverlay = null;
  document.removeEventListener("keydown", onTableEsc);
}

function onTableEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeTableOverlay();
}

export function handleTableFullscreen(e: MouseEvent): void {
  const btn = (e.target as Element).closest<HTMLButtonElement>(".table-fs-btn");
  if (!btn) return;
  const wrap = btn.closest<HTMLElement>(".table-wrap");
  const table = wrap?.querySelector("table");
  if (!table) return;

  closeTableOverlay();

  tableOverlay = document.createElement("div");
  tableOverlay.className = "table-overlay";
  tableOverlay.addEventListener("click", (ev) => {
    if (ev.target === tableOverlay) closeTableOverlay();
  });

  const close = document.createElement("button");
  close.className = "table-overlay-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = '<i class="ph ph-x"></i>';
  close.addEventListener("click", closeTableOverlay);

  const inner = document.createElement("div");
  inner.className = "table-overlay-inner";
  inner.appendChild(table.cloneNode(true));

  tableOverlay.appendChild(close);
  tableOverlay.appendChild(inner);
  document.body.appendChild(tableOverlay);
  document.addEventListener("keydown", onTableEsc);
}

/** Shared shape for base64-chip-to-text-lightbox handlers: find the chip by
 *  selector, base64-decode a data attribute, open it as a text lightbox. */
function openBase64TextChip(e: MouseEvent, selector: string, dataKey: string, filename: string): void {
  const chip = (e.target as Element).closest<HTMLElement>(selector);
  if (!chip) return;
  const text = base64ToUtf8((chip.dataset as Record<string, string>)[dataKey] || "");
  if (!text) return;
  openLightbox({ type: "text", content: text, filename });
}

export function handlePastedLogClick(e: MouseEvent): void {
  const chip = (e.target as Element).closest<HTMLElement>(".pasted-log-chip");
  if (!chip) return;
  const name = chip.dataset.pastedName || "pasted_log.txt";
  openBase64TextChip(e, ".pasted-log-chip", "pastedText", name);
}

export function handleAuqAnswerClick(e: MouseEvent): void {
  openBase64TextChip(e, ".auq-answer-chip", "auqAnswerText", "answer.txt");
}

export function handleSlashClick(e: MouseEvent): void {
  const span = (e.target as Element).closest<HTMLElement>(".slash-mention[data-skill-target]");
  if (!span) return;
  // Detached chat windows live on a `#detached?...` route - navigating
  // would discard the chat. Skip; future: open the main window's view via Tauri instead.
  if (window.location.hash.startsWith("#detached")) return;
  const target = span.dataset.skillTarget;
  if (!target) return;
  e.preventDefault();
  (window as unknown as { skillDetailTarget?: string }).skillDetailTarget = target;
  showView("skill-detail");
}

export function handlePrPreviewClick(e: MouseEvent): void {
  const btn = (e.target as Element).closest<HTMLButtonElement>(".pr-preview-btn");
  if (!btn) return;
  const card = btn.closest<HTMLElement>(".pr-preview-card");
  if (!card) return;
  openPrPreviewModal(card);
}

export function handleAttachmentClick(e: MouseEvent): void {
  const chip = (e.target as Element).closest<HTMLElement>(".attachment-chip.previewable");
  if (!chip) return;
  const content = chipToLightboxContent(chip);
  if (content) openLightbox(content);
}

/** Tapping an inline rendered image block (screenshots, image tool results) zooms it. */
export function handleBlockImageClick(e: MouseEvent): void {
  const img = (e.target as Element).closest<HTMLImageElement>("img.block.image");
  if (!img) return;
  const match = /^data:([^;]+);base64,(.+)$/.exec(img.src);
  const mime = match?.[1];
  const base64 = match?.[2];
  if (!mime || !base64) return;
  openLightbox({ type: "image", mime, base64 });
}

/** Tapping a screenshot-row thumbnail (turn-collapse.ts's screenshot-block)
 *  opens the multi-image gallery, starting at the clicked shot. Same
 *  delegated-container pattern as handleBlockImageClick, but the full shot
 *  list (for prev/next) is looked up via turn-collapse.ts's WeakMap rather
 *  than re-parsed from the DOM. */
export function handleScreenshotThumbClick(e: MouseEvent): void {
  const thumb = (e.target as Element).closest<HTMLElement>(".screenshot-thumb");
  if (!thumb) return;
  const row = thumb.closest<HTMLElement>(".screenshot-row");
  if (!row) return;
  const shots = getScreenshotRowShots(row);
  if (!shots) return;
  const idx = Number(thumb.dataset.shotIndex);
  if (!Number.isFinite(idx)) return;
  openScreenshotGallery(shots, idx);
}

export function handleCopyClick(e: MouseEvent): void {
  const btn = (e.target as Element).closest(".copy-btn") as HTMLButtonElement | null;
  if (!btn) return;

  let text = "";

  if (btn.classList.contains("cell-copy-btn")) {
    const cell = btn.closest<HTMLElement>("td, th");
    if (!cell) return;
    const clone = cell.cloneNode(true) as HTMLElement;
    clone.querySelector(".cell-copy-btn")?.remove();
    text = clone.textContent ?? "";
    void navigator.clipboard.writeText(text.trim()).then(() => {
      const icon = btn.querySelector("i");
      if (!icon) return;
      icon.className = "ph ph-check";
      btn.classList.add("copied");
      setTimeout(() => {
        icon.className = "ph ph-copy";
        btn.classList.remove("copied");
      }, 1500);
    });
    return;
  }

  const inlineWrap = btn.closest(".inline-code-wrap");
  if (inlineWrap) {
    text = inlineWrap.querySelector("code")?.textContent ?? "";
  } else {
    const block = btn.closest(".copyable-block");
    if (block) {
      const shikiPre = block.querySelector<HTMLElement>("pre.shiki");
      const fallbackPre = block.querySelector<HTMLElement>("pre");
      const pre = shikiPre ?? fallbackPre;
      if (pre) {
        text = pre.textContent ?? "";
      } else {
        const clone = block.cloneNode(true) as HTMLElement;
        clone.querySelector(".copy-btn")?.remove();
        text = clone.textContent ?? "";
      }
    } else {
      const msg = btn.closest(".msg") as HTMLElement | null;
      if (!msg) return;

      // Slack/Discord (Joe's actual paste targets) read the pasted <a>/<code>/
      // <strong> tags themselves, not computed CSS - so write real semantic
      // HTML directly rather than relying on execCommand('copy')'s Range-based
      // browser capture, which WebView2 has been dropping to plain-text-only.
      const clone = msg.cloneNode(true) as HTMLElement;
      clone.querySelector(".msg-copy-btn")?.remove();
      const html = clone.innerHTML;
      const plain = clone.textContent ?? "";

      void navigator.clipboard
        .write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain.trim()], { type: "text/plain" }),
          }),
        ])
        .then(() => {
          const icon = btn.querySelector("i");
          if (!icon) return;
          icon.className = "ph ph-check";
          btn.classList.add("copied");
          setTimeout(() => {
            icon.className = "ph ph-copy";
            btn.classList.remove("copied");
          }, 1500);
        });
      return;
    }
  }

  void navigator.clipboard.writeText(text.trim()).then(() => {
    const icon = btn.querySelector("i");
    if (!icon) return;
    icon.className = "ph ph-check";
    btn.classList.add("copied");
    setTimeout(() => {
      icon.className = "ph ph-copy";
      btn.classList.remove("copied");
    }, 1500);
  });
}
