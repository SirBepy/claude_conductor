// Chat-wide image gallery: navigates every image in the chat (not one turn's
// screenshot row), plus a collapsible top-left rail listing turns with images.
// Same overlay-singleton pattern as lightbox.ts.

import { escapeHtml } from "../escape-html";
import { setupImageZoomPan } from "./image-zoom-pan";
import { registerOverlayBack } from "../back-button";
import type { ChatImageCollection } from "./chat-image-gallery-data";

const RAIL_PEEK_MS = 1600;

let overlay: HTMLDivElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let disposeZoomPan: (() => void) | null = null;
// Phone back button closes an open gallery first, mirroring modal.ts.
let backDisposer: (() => void) | null = null;
let idx = 0;
let railPinned = false;
let peekTimer: ReturnType<typeof setTimeout> | null = null;
let lastEntryIndex = -1;

export function closeChatImageGallery(): void {
  if (!overlay) return;
  backDisposer?.();
  backDisposer = null;
  overlay.remove();
  overlay = null;
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
  disposeZoomPan?.();
  disposeZoomPan = null;
  if (peekTimer) {
    clearTimeout(peekTimer);
    peekTimer = null;
  }
  railPinned = false;
  lastEntryIndex = -1;
}

export function openChatImageGallery(collection: ChatImageCollection, startIndex: number): void {
  closeChatImageGallery();
  if (collection.images.length === 0) return;
  idx = Math.min(Math.max(startIndex, 0), collection.images.length - 1);
  lastEntryIndex = collection.images[idx]!.entryIndex;

  overlay = document.createElement("div");
  overlay.className = "lightbox-overlay chat-image-gallery-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeChatImageGallery();
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "lightbox-close";
  closeBtn.setAttribute("aria-label", "Close preview");
  closeBtn.innerHTML = '<i class="ph ph-x"></i>';
  closeBtn.addEventListener("click", closeChatImageGallery);

  const totalCounter = document.createElement("div");
  totalCounter.className = "gallery-total-counter";

  const rail = document.createElement("div");
  rail.className = "gallery-rail";

  const railChip = document.createElement("div");
  railChip.className = "gallery-rail-chip";
  const railChipIcon = document.createElement("i");
  railChipIcon.className = "ph ph-images";
  const railChipLabel = document.createElement("span");
  railChipLabel.className = "gallery-rail-chip-label";
  const railChipCount = document.createElement("span");
  railChipCount.className = "gallery-rail-chip-count";
  railChip.appendChild(railChipIcon);
  railChip.appendChild(railChipLabel);
  railChip.appendChild(railChipCount);
  railChip.addEventListener("click", () => {
    railPinned = !railPinned;
    rail.classList.toggle("open", railPinned);
    railChip.classList.toggle("pinned", railPinned);
    if (peekTimer) {
      clearTimeout(peekTimer);
      peekTimer = null;
    }
  });

  const railDrawer = document.createElement("div");
  railDrawer.className = "gallery-rail-drawer";

  const railDrawerHeader = document.createElement("div");
  railDrawerHeader.className = "gallery-rail-drawer-header";
  railDrawerHeader.textContent = "Turns with images";

  const railList = document.createElement("div");
  railList.className = "gallery-rail-list";

  // Built once at open time (entries don't change mid-session-view); render()
  // only toggles .current and scrolls, it never rebuilds this list.
  const entryRows: HTMLDivElement[] = [];
  collection.entries.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "gallery-rail-entry";

    const top = document.createElement("div");
    top.className = "gallery-rail-entry-top";
    const name = document.createElement("span");
    name.className = "gallery-rail-entry-name";
    name.textContent = entry.name;
    const count = document.createElement("span");
    count.className = "gallery-rail-entry-count";
    count.textContent = entry.images.length === 1 ? "1 img" : `${entry.images.length} imgs`;
    top.appendChild(name);
    top.appendChild(count);

    const thumbs = document.createElement("div");
    thumbs.className = "gallery-rail-entry-thumbs";
    for (let i = 0; i < entry.images.length; i++) {
      const thumb = document.createElement("span");
      thumb.className = "gallery-rail-entry-thumb";
      thumbs.appendChild(thumb);
    }

    row.appendChild(top);
    row.appendChild(thumbs);
    row.addEventListener("click", () => {
      idx = entry.images[0]!;
      lastEntryIndex = collection.images[idx]!.entryIndex;
      render();
    });

    railList.appendChild(row);
    entryRows.push(row);
  });

  railDrawer.appendChild(railDrawerHeader);
  railDrawer.appendChild(railList);
  rail.appendChild(railChip);
  rail.appendChild(railDrawer);

  const stage = document.createElement("div");
  stage.className = "screenshot-gallery-stage";
  stage.addEventListener("click", (e) => {
    if (e.target === stage) closeChatImageGallery();
  });

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "screenshot-gallery-nav screenshot-gallery-nav--prev";
  prevBtn.setAttribute("aria-label", "Previous image");
  prevBtn.innerHTML = '<i class="ph ph-caret-left"></i>';
  prevBtn.addEventListener("click", () => go(-1));

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "screenshot-gallery-nav screenshot-gallery-nav--next";
  nextBtn.setAttribute("aria-label", "Next image");
  nextBtn.innerHTML = '<i class="ph ph-caret-right"></i>';
  nextBtn.addEventListener("click", () => go(1));

  overlay.appendChild(rail);
  overlay.appendChild(totalCounter);
  overlay.appendChild(closeBtn);
  overlay.appendChild(prevBtn);
  overlay.appendChild(stage);
  overlay.appendChild(nextBtn);
  document.body.appendChild(overlay);

  function render(): void {
    const image = collection.images[idx]!;
    const entry = collection.entries[image.entryIndex]!;
    const posInEntry = entry.images.indexOf(idx) + 1;

    disposeZoomPan?.();
    // base64's alphabet can't contain &<>"', so escaping image.data (can be
    // multiple MB) would scan the whole payload for zero benefit.
    stage.innerHTML = `<img src="data:${escapeHtml(image.mime)};base64,${image.data}" alt="${escapeHtml(image.title)}">`;
    const img = stage.querySelector("img");
    disposeZoomPan = img ? setupImageZoomPan(img, stage) : null;

    totalCounter.textContent = `${idx + 1} of ${collection.images.length}`;

    railChipLabel.textContent = entry.name;
    railChipCount.textContent = `${posInEntry}/${entry.images.length}`;

    entryRows.forEach((row, i) => {
      row.classList.toggle("current", i === image.entryIndex);
    });
    entryRows[image.entryIndex]?.scrollIntoView?.({ block: "nearest" });

    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === collection.images.length - 1;
  }

  function go(delta: number): void {
    const target = idx + delta;
    if (target < 0 || target >= collection.images.length) return;
    idx = target;
    render();
    const entryIndex = collection.images[idx]!.entryIndex;
    if (entryIndex !== lastEntryIndex) {
      lastEntryIndex = entryIndex;
      if (!railPinned) {
        rail.classList.add("open", "peek");
        if (peekTimer) clearTimeout(peekTimer);
        peekTimer = setTimeout(() => {
          rail.classList.remove("open", "peek");
        }, RAIL_PEEK_MS);
      }
    }
  }

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeChatImageGallery();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  };
  document.addEventListener("keydown", keyHandler);
  backDisposer = registerOverlayBack(() => {
    closeChatImageGallery();
    return true;
  });
  render();
}
