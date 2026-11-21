// The Images tab of the Attachments card: the chat's images as the Messages
// gallery lists them. One collection (chat-image-gallery-data.ts) feeds both, so
// a tab row and a picture in the transcript open the same gallery at the same
// slot. The model only gets a byte-free list (DashImage); the bytes stay here and
// each thumbnail is pointed at them after the card is drawn, so the card's HTML
// stays small and a redraw never re-sends megabytes through the change check.

import { collectChatImages, type ChatImageCollection } from "../../../shared/chat/chat-image-gallery-data";
import { openChatImageGallery } from "../../../shared/chat/chat-image-gallery";
import type { ChatRenderer } from "../../../shared/chat/chat-renderer";
import type { DashImage } from "../../../shared/chat/dashboard/dashboard-model";

/** `data:` URL of one gallery image. */
const srcOf = (img: { mime: string; data: string }): string => `data:${img.mime};base64,${img.data}`;

/** The titles the gallery gives an image that has none of its own. */
const GENERIC_TITLE = new Set(["attachment", "image"]);

export class AttachmentImages {
  private coll: ChatImageCollection | null = null;

  constructor(private readonly renderer: ChatRenderer) {}

  /** Reads the chat's images afresh; the list the Images tab and the card's count draw from. */
  collect(): DashImage[] {
    this.coll = collectChatImages(this.renderer.messages, this.renderer.messageEls);
    const entries = this.coll.entries;
    // A pasted image has no name of its own ("attachment"), so its row says what the message around it said.
    return this.coll.images.map((i) => ({ index: i.index, title: GENERIC_TITLE.has(i.title) ? (entries[i.entryIndex]?.name ?? i.title) : i.title, label: i.agentLabel, size: i.data.length }));
  }

  /** Points every drawn thumbnail at its bytes. The `img` is new after each redraw of the card, so
   *  this runs after every render and costs one attribute read once a thumbnail has its source. */
  mount(root: HTMLElement): void {
    const coll = this.coll;
    if (!coll) return;
    for (const el of root.querySelectorAll<HTMLImageElement>("img[data-gimg]")) {
      // An opened sub's own Images rows index that sub's list, never this chat's; the peek fills them.
      if (el.closest(".sx-det")) continue;
      const img = coll.images[Number(el.dataset.gimg)];
      if (!img || el.dataset.bound === el.dataset.size) continue;
      el.src = srcOf(img);
      el.dataset.bound = el.dataset.size;
    }
  }

  /** Opens the Messages gallery at one image. Collected again at the click, so a row drawn before
   *  a late image landed still lands on the right picture. */
  open(index: number): void {
    const coll = collectChatImages(this.renderer.messages, this.renderer.messageEls);
    if (coll.images.length === 0) return;
    openChatImageGallery(coll, index);
  }
}
