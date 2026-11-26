import { buildMoreMenuButton } from "./lightbox-more-menu";
import { closeAllMenus } from "../../views/sessions/menu-registry";
import { registerOverlayBack } from "../back-button";
import { setupImageZoomPan } from "./image-zoom-pan";
import {
  arrowStepsGallery, clampIndex, counterLabel, isNavigable, stepTarget, type LightboxGallery,
} from "./lightbox-gallery-model";
import { ComposerCore } from "./composer-core/core";
import { SlashProvider } from "./caret-popup/providers/slash";
import { FileProvider } from "./caret-popup/providers/file";
import type { SuggestProvider } from "./caret-popup/types";
import "./caret-popup/popup.css";
import "./composer-core/core.css";

export type { LightboxGallery } from "./lightbox-gallery-model";

export type LightboxContent =
  | { type: "image"; mime: string; base64: string; filename?: string; sourcePath?: string; title?: string; caption?: string }
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
  /** True while the composer is actively dictating (recording or
   *  connecting). The overlay's z-index:9999 covers the mic button, so
   *  without this, dictation looks stopped the moment an attachment preview
   *  opens even though audio capture never paused - Joe hit this directly
   *  (2026-10-18). */
  isVoiceRecording?(): boolean;
  /** Subscribe to recording-state flips while the overlay is open. Returns
   *  an unsubscribe function. */
  onVoiceStateChange?(cb: (recording: boolean) => void): () => void;
  /** Send the main composer's current draft now - used by the lightbox's own
   *  Ctrl+Enter (write back the caption, close, then send). */
  send?(): void;
}

// Registered by Composer itself (ctor/destroy), so the lightbox's own textbox
// can seed from / hand back to the real draft without importing the views
// layer. Composer owns
// it rather than a pane, because a pane that mounts a Composer and forgets to
// register leaves this pointing at the PREVIOUS session's composer: destroy()
// doesn't null that object's textarea, so setDraftText still runs saveDraft
// against the wrong session id and the caption surfaces in another chat.
let composerBridge: LightboxComposerBridge | null = null;
export function setLightboxComposerBridge(bridge: LightboxComposerBridge | null): void {
  composerBridge = bridge;
}

/** Unregister on teardown. No-ops unless `bridge` is still the live one, so a
 *  composer destroyed AFTER its successor registered can't wipe the successor. */
export function clearLightboxComposerBridge(bridge: LightboxComposerBridge): void {
  if (composerBridge === bridge) composerBridge = null;
}

// The bridge captured when the overlay opened. Seed and write-back both go
// through THIS one, never whatever is registered at close time: a session
// switch is reachable with a preview open (Ctrl+Num), and that swaps the
// registered composer mid-overlay - reading the live one on close would post
// the caption into the chat the user switched TO.
let openBridge: LightboxComposerBridge | null = null;

// Same shared composer-core as main composer/AUQ card/preview-panel. No
// onEnter (Enter stays a plain newline) and no paste adapter (attachments
// out of scope here).
let composerCore: ComposerCore | null = null;
let slashProvider: SlashProvider | null = null;
let fileProvider: FileProvider | null = null;

// Recording-still-live badge (see LightboxComposerBridge.isVoiceRecording).
let voiceBadge: HTMLDivElement | null = null;
let voiceUnsub: (() => void) | null = null;

function setVoiceBadge(recording: boolean): void {
  if (!overlay) return;
  if (recording && !voiceBadge) {
    voiceBadge = document.createElement("div");
    voiceBadge.className = "lightbox-voice-badge";
    voiceBadge.innerHTML = '<i class="ph ph-microphone"></i> Recording';
    overlay.appendChild(voiceBadge);
  } else if (!recording && voiceBadge) {
    voiceBadge.remove();
    voiceBadge = null;
  }
}

// Gallery mode (openLightbox's third argument). `galleryIndex` is the item on screen, `wantIndex`
// the one the last key press asked for: a slow load must not make a held arrow key retarget the
// same neighbour over and over.
let gallery: LightboxGallery | null = null;
let galleryIndex = 0;
let wantIndex = 0;
let navSeq = 0;
let innerEl: HTMLDivElement | null = null;
let slideEl: HTMLDivElement | null = null;
let moreBtn: HTMLButtonElement | null = null;
let prevBtn: HTMLButtonElement | null = null;
let nextBtn: HTMLButtonElement | null = null;
let counterEl: HTMLDivElement | null = null;
let captionEl: HTMLDivElement | null = null;
let disposeZoom: (() => void) | null = null;
let zoomScale = 1;
let blobUrl: string | null = null;
// Blob URLs of slides still fading out: revoked when the slide goes, or on close.
const pendingBlobs = new Set<string>();

/** Mirrors the slide transition in chat-overlays.css; only the fallback for a missed transitionend. */
const SLIDE_FALLBACK_MS = 400;
/** A horizontal touch drag past this many px, mostly sideways, steps the gallery. */
const SWIPE_MIN_PX = 56;

/** `bridge` picks whose draft the caption box edits: omitted = the main chat
 *  composer, `null` = no caption box, an object = that owner (the question card
 *  passes its own answer field, so a caption typed on its image never lands in
 *  the chat input hidden behind the card).
 *  `group` makes Left/Right, the prev/next buttons and a swipe step through the items it
 *  was opened from; `content` must be the item at `group.index`. */
export function openLightbox(content: LightboxContent, bridge?: LightboxComposerBridge | null, group?: LightboxGallery | null): void {
  closeLightbox(); // clears openBridge, so capture below must follow it
  openBridge = bridge === undefined ? composerBridge : bridge;
  gallery = isNavigable(group) ? group! : null;
  galleryIndex = wantIndex = gallery ? clampIndex(gallery.index, gallery.count) : 0;

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
  innerEl = inner;
  // .lightbox-content--image stretches to fill the overlay, and so does the slide
  // inside it, so clicks around a small image land on `inner` or the slide, not
  // `overlay` - mirror the click-outside check here (never the img itself, which
  // has its own pan/zoom handlers).
  inner.addEventListener("click", (e) => {
    if (e.target === inner || e.target === slideEl) closeLightbox();
  });
  if (gallery) wireSwipe(inner);

  showContent(content, 0);

  // Caption/reply textbox: same draft box regardless of preview type (image,
  // pdf, or text), gated only on a composer being mounted to hand the text to.
  if (openBridge) {
    const wrap = document.createElement("div");
    wrap.className = "lightbox-composer-wrap cc-typing-wrap";
    const highlight = document.createElement("div");
    highlight.className = "cc-typing-highlight cc-typing-highlight--lightbox";
    highlight.setAttribute("aria-hidden", "true");
    const box = document.createElement("textarea");
    box.className = "lightbox-composer cc-typing-input";
    box.placeholder = "Type a message...";
    box.value = openBridge.getDraftText();
    wrap.append(highlight, box);
    overlay.appendChild(wrap);

    const cwd = openBridge.getCwd?.() ?? null;
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
      // Ctrl/Cmd+Enter writes the caption back (closeLightbox syncs it via
      // the captured bridge, same as any other close), then sends - so
      // finishing a caption sends the message and dismisses the preview in
      // one keystroke instead of needing a separate close.
      onCtrlEnter: () => {
        const bridge = openBridge;
        closeLightbox();
        bridge?.send?.();
      },
    });
  }

  overlay.appendChild(close);
  if (gallery) buildGalleryChrome(overlay, gallery);
  overlay.appendChild(inner);
  document.body.appendChild(overlay);
  overlay.querySelector<HTMLTextAreaElement>(".lightbox-composer")?.focus();
  document.addEventListener("keydown", onKey);

  if (openBridge?.isVoiceRecording?.()) setVoiceBadge(true);
  voiceUnsub = openBridge?.onVoiceStateChange?.(setVoiceBadge) ?? null;
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
  voiceUnsub?.();
  voiceUnsub = null;
  voiceBadge = null;
  closeAllMenus();
  const box = overlay.querySelector<HTMLTextAreaElement>(".lightbox-composer");
  if (box && openBridge) openBridge.setDraftText(box.value, false);
  openBridge = null;
  composerCore?.destroy();
  composerCore = null;
  slashProvider?.stop();
  slashProvider = null;
  fileProvider?.stop();
  fileProvider = null;
  // A load still in flight must not paint into the next overlay.
  navSeq += 1;
  gallery = null;
  disposeZoom?.();
  disposeZoom = null;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  for (const url of pendingBlobs) URL.revokeObjectURL(url);
  pendingBlobs.clear();
  innerEl = slideEl = moreBtn = prevBtn = nextBtn = counterEl = captionEl = null;
  overlay.remove();
  overlay = null;
  document.removeEventListener("keydown", onKey);
}

/** Puts `content` on screen in a fresh slide. `dir` is the way the gallery moved (1 = next): the
 *  new slide enters from that side while the old one leaves the other way, so the swap reads as
 *  a step along the row. 0 (the first paint) draws at once with no motion. */
function showContent(content: LightboxContent, dir: -1 | 0 | 1): void {
  if (!overlay || !innerEl) return;
  const inner = innerEl;
  // The zoom container is reused across items, so the old image's listeners go first.
  disposeZoom?.();
  disposeZoom = null;
  zoomScale = 1;

  const old = slideEl;
  const oldBlob = blobUrl;
  blobUrl = null;
  moreBtn?.remove();
  moreBtn = null;
  // The caption belongs to the slide it was set for, so a pdf or text slide never inherits it.
  captionEl?.remove();
  captionEl = null;
  // The more menu acts on the image it was opened for.
  if (dir !== 0) closeAllMenus();

  const slide = document.createElement("div");
  slide.className = "lightbox-slide";
  if (dir === 0) slide.classList.add("lightbox-slide--still");
  else slide.style.setProperty("--lb-from", `${dir * 32}px`);
  inner.classList.toggle("lightbox-content--image", content.type === "image");

  if (content.type === "image") {
    const img = document.createElement("img");
    img.src = `data:${content.mime};base64,${content.base64}`;
    img.alt = content.filename ?? "";
    slide.appendChild(img);
    disposeZoom = setupImageZoomPan(img, inner, (s) => { zoomScale = s; });
    moreBtn = buildMoreMenuButton(content);
    overlay.appendChild(moreBtn);
    // Read-only text under the picture (What's new cards).
    if (content.title || content.caption) {
      captionEl = document.createElement("div");
      captionEl.className = "lightbox-caption";
      captionEl.innerHTML = '<strong class="lightbox-caption-title"></strong><span class="lightbox-caption-text"></span>';
      captionEl.querySelector(".lightbox-caption-title")!.textContent = content.title ?? "";
      captionEl.querySelector(".lightbox-caption-text")!.textContent = content.caption ?? "";
      overlay.appendChild(captionEl);
    }
  } else if (content.type === "pdf") {
    // This blob: URL is checked twice by CSP - object-src for the <embed>, then
    // frame-src for the PDF viewer's inner frame. Both index.html and
    // tauri.conf.json must allow blob: on both, or the embed paints nothing.
    const blob = b64toBlob(content.base64, "application/pdf");
    blobUrl = URL.createObjectURL(blob);
    const embed = document.createElement("embed");
    embed.src = blobUrl;
    embed.type = "application/pdf";
    slide.appendChild(embed);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = content.content;
    slide.appendChild(pre);
  }
  inner.appendChild(slide);
  slideEl = slide;
  retireSlide(old, oldBlob, dir);
}

/** Takes the previous slide off the screen. With a direction it slides and fades out first and is
 *  removed once the transition ends (a timer covers a transition that never fires, such as a
 *  hidden tab), so a quick second step never leaves a stale slide behind. */
function retireSlide(slide: HTMLElement | null, blob: string | null, dir: -1 | 0 | 1): void {
  if (blob) pendingBlobs.add(blob);
  if (!slide) return;
  const finish = (): void => {
    slide.remove();
    if (blob) {
      URL.revokeObjectURL(blob);
      pendingBlobs.delete(blob);
    }
  };
  if (dir === 0) {
    finish();
    return;
  }
  slide.style.setProperty("--lb-from", `${dir * 32}px`);
  slide.classList.add("is-leaving");
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    finish();
  };
  slide.addEventListener("transitionend", (e) => { if (e.target === slide) once(); });
  setTimeout(once, SLIDE_FALLBACK_MS);
}

function buildGalleryChrome(host: HTMLElement, g: LightboxGallery): void {
  const mk = (side: "prev" | "next"): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `lightbox-nav lightbox-nav--${side}`;
    b.setAttribute("aria-label", side === "prev" ? "Previous image" : "Next image");
    b.innerHTML = `<i class="ph ph-caret-${side === "prev" ? "left" : "right"}"></i>`;
    // A press must not pull focus out of the caption box, or the next keystroke would miss it.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigate(side === "prev" ? -1 : 1);
    });
    return b;
  };
  prevBtn = mk("prev");
  nextBtn = mk("next");
  counterEl = document.createElement("div");
  counterEl.className = "lightbox-counter";
  counterEl.setAttribute("aria-live", "polite");
  host.append(prevBtn, nextBtn, counterEl);
  updateGalleryChrome(g);
}

function updateGalleryChrome(g: LightboxGallery): void {
  if (counterEl) counterEl.textContent = counterLabel(galleryIndex, g.count);
  if (prevBtn) prevBtn.disabled = stepTarget(galleryIndex, -1, g.count) === null;
  if (nextBtn) nextBtn.disabled = stepTarget(galleryIndex, 1, g.count) === null;
}

/** Steps to the neighbour in `delta`'s direction, skipping any item that cannot be read. A later
 *  step supersedes one still loading (navSeq), and the old item stays up until the new one is ready. */
async function navigate(delta: -1 | 1): Promise<void> {
  const g = gallery;
  if (!g || !overlay) return;
  let target = stepTarget(wantIndex, delta, g.count);
  // Past either end there is nothing to do, and a load still in flight toward the end must keep going.
  if (target === null) return;
  const seq = ++navSeq;
  while (target !== null) {
    // Landing back on what is already on screen (a reversed step, or a skip past an unreadable
    // neighbour) drops the load instead of re-sliding the shown item.
    if (target === galleryIndex) {
      wantIndex = galleryIndex;
      return;
    }
    wantIndex = target;
    let next: LightboxContent | null = null;
    try {
      next = await g.load(target);
    } catch {
      next = null;
    }
    if (seq !== navSeq || gallery !== g || !overlay) return;
    if (next) {
      galleryIndex = target;
      showContent(next, delta);
      updateGalleryChrome(g);
      return;
    }
    target = stepTarget(target, delta, g.count);
  }
  wantIndex = galleryIndex;
}

/** Phone swipe: one finger dragged mostly sideways on an image that is not zoomed in. The zoom/pan
 *  helper owns the same pointer stream, so this only watches and never claims the gesture. */
function wireSwipe(inner: HTMLElement): void {
  const touches = new Map<number, { x: number; y: number }>();
  let multi = false;
  const reset = (): void => { touches.clear(); multi = false; };
  inner.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    if (touches.size > 0) multi = true;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  inner.addEventListener("pointerup", (e) => {
    const start = touches.get(e.pointerId);
    if (!start) return;
    touches.delete(e.pointerId);
    if (touches.size > 0) return;
    const was = multi;
    multi = false;
    if (was || zoomScale > 1.01) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    void navigate(dx < 0 ? 1 : -1);
  });
  inner.addEventListener("pointercancel", reset);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    closeLightbox();
    return;
  }
  if (!gallery) return;
  const t = e.target instanceof HTMLElement ? e.target : null;
  const field = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || !!t?.isContentEditable;
  const textEmpty = field && "value" in t! ? (t as HTMLTextAreaElement | HTMLInputElement).value === "" : false;
  const step = arrowStepsGallery(e, { inTextField: field, textEmpty });
  if (step === null) return;
  e.preventDefault();
  void navigate(step);
}

function b64toBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
