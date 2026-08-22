import { buildMoreMenuButton } from "./lightbox-more-menu";
import { closeAllMenus } from "../../views/sessions/menu-registry";
import { registerOverlayBack } from "../back-button";
import { setupImageZoomPan } from "./image-zoom-pan";
import { ComposerCore } from "./composer-core/core";
import { SlashProvider } from "./caret-popup/providers/slash";
import { FileProvider } from "./caret-popup/providers/file";
import type { SuggestProvider } from "./caret-popup/types";
import "./caret-popup/popup.css";
import "./composer-core/core.css";

export type LightboxContent =
  | { type: "image"; mime: string; base64: string; filename?: string; sourcePath?: string }
  | { type: "pdf"; base64: string; filename?: string }
  | { type: "text"; content: string; filename?: string };

let overlay: HTMLDivElement | null = null;
// Phone back button closes an open lightbox first, mirroring modal.ts.
let backDisposer: (() => void) | null = null;

/** Single definition site for the overlay class - consumed by question-ui.ts's
 *  dismissUnlessOverlayAbove() guard so a rename here can't silently drift out
 *  of sync with that check again (todo 443). */
export const LIGHTBOX_OVERLAY_CLASS = "lightbox-overlay";

export interface LightboxComposerBridge {
  getDraftText(): string;
  /** `clearAttachments` false when the lightbox caption round-trips text back
   *  on close - preview-close must never wipe staged attachments. */
  setDraftText(text: string, clearAttachments?: boolean): void;
  /** Project cwd for the "/" and "@" suggestion providers - same source as
   *  the main composer's own SlashProvider.start()/FileProvider.start().
   *  Omit or return null to still surface user/builtin skills with no
   *  @file results (mirrors Composer's own null fallback). */
  getCwd?(): string | null;
}

// Set by the sessions view (active-session-composer.ts) to the currently mounted
// Composer, so the lightbox's own textbox can seed from / hand back to the
// real draft without importing the views layer - same seam as
// setFileEditsProvider in file-viewer.ts.
let composerBridge: LightboxComposerBridge | null = null;
export function setLightboxComposerBridge(bridge: LightboxComposerBridge | null): void {
  composerBridge = bridge;
}

// Same shared composer-core as main composer/AUQ card/preview-panel. No
// onEnter (Enter stays a plain newline) and no paste adapter (attachments
// out of scope here).
let composerCore: ComposerCore | null = null;
let slashProvider: SlashProvider | null = null;
let fileProvider: FileProvider | null = null;

export function openLightbox(content: LightboxContent): void {
  closeLightbox();

  overlay = document.createElement("div");
  overlay.className = LIGHTBOX_OVERLAY_CLASS;
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
  // .lightbox-content--image stretches to fill the overlay, so clicks around
  // a small image land on `inner` not `overlay` - mirror the click-outside
  // check here (never the img itself, which has its own pan/zoom handlers).
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
  } else if (content.type === "pdf") {
    // This blob: URL is checked twice by CSP - object-src for the <embed>, then
    // frame-src for the PDF viewer's inner frame. Both index.html and
    // tauri.conf.json must allow blob: on both, or the embed paints nothing.
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

  // Caption/reply textbox: same draft box regardless of preview type (image,
  // pdf, or text), gated only on a bridge being wired (active-session-composer.ts).
  if (composerBridge) {
    const wrap = document.createElement("div");
    wrap.className = "lightbox-composer-wrap cc-typing-wrap";
    const highlight = document.createElement("div");
    highlight.className = "cc-typing-highlight cc-typing-highlight--lightbox";
    highlight.setAttribute("aria-hidden", "true");
    const box = document.createElement("textarea");
    box.className = "lightbox-composer cc-typing-input";
    box.placeholder = "Type a message...";
    box.value = composerBridge.getDraftText();
    wrap.append(highlight, box);
    overlay.appendChild(wrap);

    const cwd = composerBridge.getCwd?.() ?? null;
    slashProvider = new SlashProvider();
    fileProvider = new FileProvider();
    void slashProvider.start(cwd);
    fileProvider.start(cwd);
    composerCore = new ComposerCore({
      textarea: box,
      highlightEl: highlight,
      anchor: wrap,
      providers: [slashProvider, fileProvider] as unknown as SuggestProvider<unknown>[],
      features: { paste: false },
    });
  }

  overlay.appendChild(close);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLTextAreaElement>(".lightbox-composer")?.focus();
  document.addEventListener("keydown", onEsc);
  backDisposer?.();
  backDisposer = registerOverlayBack(() => {
    closeLightbox();
    return true;
  });
}

export function closeLightbox(): void {
  if (!overlay) return;
  backDisposer?.();
  backDisposer = null;
  closeAllMenus();
  const box = overlay.querySelector<HTMLTextAreaElement>(".lightbox-composer");
  if (box && composerBridge) composerBridge.setDraftText(box.value, false);
  composerCore?.destroy();
  composerCore = null;
  slashProvider?.stop();
  slashProvider = null;
  fileProvider?.stop();
  fileProvider = null;
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
