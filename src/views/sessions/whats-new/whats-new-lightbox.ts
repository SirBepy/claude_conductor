// Opens a What's new card's picture in the app's lightbox, with the other cards of the same release
// as its gallery. The pictures are bundled asset URLs (or inlined data: URLs when small), and the
// lightbox wants base64, so each one is drawn through an <img> and a canvas: a fetch() would need
// connect-src to allow data:, an <img> only img-src, which the page already has.
import type { ChangelogEntry } from "../../../changelog/entries";
import { openLightbox, type LightboxContent } from "../../../shared/chat/lightbox";

type Item = ChangelogEntry["items"][number];

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function toContent(item: Item): Promise<LightboxContent | null> {
  const img = await loadImage(item.image);
  if (!img || !img.naturalWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  return { type: "image", mime: "image/png", base64: url.slice(comma + 1), filename: item.alt, title: item.title, caption: item.caption };
}

/** Shows `items[index]` fullscreen; arrows, keys and swipe step through the rest. No caption box
 *  (bridge null): the text under the picture is the card's own title and caption, not a draft. */
export async function openWhatsNewCard(items: readonly Item[], index: number): Promise<void> {
  const first = await toContent(items[index]!);
  if (!first) return;
  openLightbox(first, null, { count: items.length, index, load: (i) => toContent(items[i]!) });
}
