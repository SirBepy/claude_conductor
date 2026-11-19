// Pure rules for the lightbox's gallery mode (lightbox.ts): which index a step lands on, what the
// counter says, and when an arrow key belongs to the caption box instead of the gallery. No DOM.

import type { LightboxContent } from "./lightbox";

/** The group of items a lightbox was opened from. `load` is lazy because a group such as a sub's
 *  images is hundreds of full-size reads: only the item being shown is fetched. A null result means
 *  the item could not be read; the lightbox then skips on in the direction it was going. */
export interface LightboxGallery {
  count: number;
  /** The index of the content passed to openLightbox. */
  index: number;
  load(index: number): LightboxContent | null | Promise<LightboxContent | null>;
}

/** The nearest valid index (0 for an empty group). Never wraps: Left on the first item has nothing
 *  to show, so the buttons disable at the ends instead of jumping across the whole group. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}

/** Where a step of `delta` from `index` lands, or null when it would leave the group. */
export function stepTarget(index: number, delta: number, count: number): number | null {
  const next = index + delta;
  return next < 0 || next >= count ? null : next;
}

/** "3 / 35" for a 1-based reading of a 0-based index. */
export function counterLabel(index: number, count: number): string {
  return `${clampIndex(index, count) + 1} / ${count}`;
}

/** A group needs arrows only when there is somewhere to go. */
export function isNavigable(gallery: Pick<LightboxGallery, "count"> | null | undefined): boolean {
  return !!gallery && gallery.count > 1;
}

/** A gallery over contents already in memory (a card's attachments, a message's images). */
export function galleryOfItems(items: readonly LightboxContent[], index: number): LightboxGallery {
  return { count: items.length, index: clampIndex(index, items.length), load: (i) => items[i] ?? null };
}

/** Whether an arrow key should step the gallery. Inside the caption box Left and Right move the
 *  caret, so they only step once the box is empty (nothing to move through) or with Alt held. A
 *  Ctrl, Meta or Shift arrow is a selection or word jump and always belongs to the box. */
export function arrowStepsGallery(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  focus: { inTextField: boolean; textEmpty: boolean }): -1 | 1 | null {
  const delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : null;
  if (delta === null) return null;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (focus.inTextField && !e.altKey && !focus.textEmpty) return null;
  return delta;
}

/** The loaded image attachments of one tray or card, with `current` marked as the one clicked, so
 *  the lightbox steps through the images beside it (files and still-uploading images are skipped).
 *  Null when `current` is the only image. */
export function attachmentGallery<T extends { mime: string; data?: string | null; filename?: string }>(
  list: readonly T[], current: T,
): LightboxGallery | null {
  const images = list.filter((a) => a.mime.startsWith("image/") && !!a.data);
  const index = images.indexOf(current);
  if (index < 0 || images.length < 2) return null;
  return galleryOfItems(images.map((a) => ({ type: "image", mime: a.mime, base64: a.data!, filename: a.filename })), index);
}
