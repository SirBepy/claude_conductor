/** A user message's sent attachments live in a slim tray under its bubble, not
 *  inside it: the bubble's long-text clamp (turn-collapse.ts) would otherwise
 *  clip the images that follow the text. The tray stays INSIDE the message
 *  element, because the chat gallery collects a message's thumbs by querying
 *  that element (chat-image-gallery-data.ts). */

import { isRasterImageName } from "./tool-meta";

/** Images shown before the rest fold into one "+N" tile. Files never fold: the
 *  chat gallery that "+N" opens holds images only, so a folded PDF could not be
 *  reached from anywhere. */
export const TRAY_IMAGE_CAP = 6;

const ATTACHMENT_CHIP = ".attachment-chip[data-attachment-path]";

/** A tray item is a loading chip until hydrateAttachments swaps an image chip
 *  for a `.sent-attachment-thumb`, so an unhydrated chip is judged by its
 *  extension: the daemon's mime is the real answer but arrives later. A chip
 *  whose read failed is not an image any more: it has no click handler, so
 *  folding it behind "+N" would leave it unreachable. */
function isImageItem(item: HTMLElement): boolean {
  if (item.classList.contains("sent-attachment-thumb")) return true;
  if (item.dataset.attachmentFailed) return false;
  return isRasterImageName(item.dataset.filename ?? item.dataset.attachmentPath ?? "");
}

function trayItems(tray: HTMLElement): HTMLElement[] {
  return Array.from(tray.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains("msg-tray-more"),
  );
}

/** Moves a user message's attachment chips into a tray below its bubble.
 *  Idempotent. A message that is only attachments loses its empty bubble. */
export function groupAttachmentTray(el: HTMLElement): void {
  if (el.querySelector(":scope > .msg-tray")) return;
  const chips = Array.from(el.querySelectorAll<HTMLElement>(ATTACHMENT_CHIP));
  if (chips.length === 0) return;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  while (el.firstChild) bubble.appendChild(el.firstChild);

  const tray = document.createElement("div");
  tray.className = "msg-tray";
  for (const chip of chips) tray.appendChild(chip);

  el.classList.add("has-tray");
  const hasContent = bubble.children.length > 0 || (bubble.textContent ?? "").trim() !== "";
  if (hasContent) el.appendChild(bubble);
  el.appendChild(tray);
  foldTray(tray);
}

/** Marks every image past the cap as folded and (re)builds the "+N" tile.
 *  Safe to call again as attachments hydrate (once per settled chip): hydration
 *  replaces a chip with a fresh thumb node, which drops the earlier fold class. */
export function foldTray(tray: HTMLElement): void {
  tray.querySelector(":scope > .msg-tray-more")?.remove();
  const folded: HTMLElement[] = [];
  let images = 0;
  for (const item of trayItems(tray)) {
    const overflow = isImageItem(item) && ++images > TRAY_IMAGE_CAP;
    item.classList.toggle("msg-tray-folded", overflow);
    if (overflow) folded.push(item);
  }
  if (folded.length === 0) return;

  const more = document.createElement("button");
  more.type = "button";
  more.className = "msg-tray-more";
  more.textContent = `+${folded.length}`;
  more.title = `${folded.length} more, open in the gallery`;
  // Clicking the first folded thumb reuses its own handler, which opens the
  // gallery at that image. A chip still loading has no handler yet: no-op.
  more.addEventListener("click", () => {
    folded.find((f) => f.classList.contains("sent-attachment-thumb"))?.click();
  });
  tray.appendChild(more);
}

/** Re-folds a message's tray after its attachments hydrate. */
export function refoldAttachmentTray(el: HTMLElement): void {
  const tray = el.querySelector<HTMLElement>(":scope > .msg-tray");
  if (tray) foldTray(tray);
}
