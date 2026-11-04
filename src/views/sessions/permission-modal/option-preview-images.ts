// Local images in an option's `preview` HTML. The preview frame is a sandboxed
// srcdoc under a CSP of `img-src 'self' data: blob:`, so a file: <img> renders
// broken. Each one is read through `read_image_file` (the same command the
// status bar uses for agent-surfaced paths) and swapped for a data: URL.
//
// `read_attachment`, which chat attachments use, is confined to the
// chat-attachments dir and so can never read a file Claude just made elsewhere.
// The question's session id rides along: for a chat hosted on a paired machine
// the file is on THAT machine's disk, so the read is routed to it (and the host
// only serves raster images under its project folders, see
// registry/image_read.rs). It also keys the cache, since the same path names
// different files on different machines.
//
// A read that fails (a path outside every project folder, which the host
// refuses for a phone, or a file that is not there) swaps the src for a small
// "Picture unavailable" tile, so the card never shows a broken-image icon.
//
// Raster types only: svg is excluded because it can carry script and external
// references, and anything but an image extension is never read at all, so a
// preview cannot be used to pull an arbitrary local file into the frame.

import { invoke } from "../../../shared/ipc";
import { isRasterImageName } from "../../../shared/chat/tool-meta";

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;
const WIN_PATH = /^[A-Za-z]:[\\/]/;

// Resolved data: URL per (session, source path); null = read in flight. A failed read is
// dropped again, so a later card naming the same path (often a file Claude was
// still writing the first time) tries once more.
const cache = new Map<string, string | null>();
// Keys whose last read failed. Kept apart from `cache` so a retry (which sets
// the cache slot to null again) keeps showing the tile instead of flashing back
// to the broken src until it settles.
const failed = new Set<string>();
// The read behind each null cache entry, shared so a second card naming the
// same path awaits it instead of seeing "already handled" and never refreshing.
const inflight = new Map<string, Promise<boolean>>();
// Counts clearLocalImageCache() calls: a read from an older generation never
// releases a slot, since that slot now belongs to a newer read.
let cacheGeneration = 0;

function cacheKey(path: string, sessionId?: string): string {
  return `${sessionId ?? ""}|${path}`;
}

const UNAVAILABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="100%" height="100%" fill="#888" fill-opacity=".14"/><text x="50%" y="50%" fill="#888" font-family="sans-serif" font-size="14" text-anchor="middle" dominant-baseline="middle">Picture unavailable</text></svg>`;
// encodeURIComponent leaves ' bare, which would end a single-quoted src.
const UNAVAILABLE_SRC = `data:image/svg+xml,${encodeURIComponent(UNAVAILABLE_SVG).replace(/'/g, "%27")}`;

export function clearLocalImageCache(): void {
  cache.clear();
  failed.clear();
  inflight.clear();
  cacheGeneration++;
}

/** The filesystem path a src points at, or null when it is not a local image. */
function localImagePath(src: string): string | null {
  let path: string;
  if (/^file:\/\//i.test(src)) {
    const rest = src.replace(/^file:\/\/\/?/i, "").replace(/[?#].*$/, "");
    try { path = decodeURIComponent(rest); } catch { return null; }
    if (!WIN_PATH.test(path)) path = `/${path}`;
  } else if (WIN_PATH.test(src)) {
    path = src;
  } else {
    return null;
  }
  return isRasterImageName(path) ? path : null;
}

function localPaths(fragment: string): string[] {
  const out: string[] = [];
  for (const m of fragment.matchAll(IMG_SRC)) {
    const p = localImagePath(m[3]!);
    if (p) out.push(p);
  }
  return out;
}

/** Sync swap of every already-loaded local image, and of every one whose read
 *  failed for the "Picture unavailable" tile; the fragment is returned
 *  untouched (same string) when there is nothing to swap. */
export function inlineLocalImages(fragment: string, sessionId?: string): string {
  return fragment.replace(IMG_SRC, (whole, pre: string, q: string, src: string) => {
    const p = localImagePath(src);
    if (!p) return whole;
    const key = cacheKey(p, sessionId);
    const data = cache.get(key);
    if (data) return `${pre}${q}${data}${q}`;
    return failed.has(key) ? `${pre}${q}${UNAVAILABLE_SRC}${q}` : whole;
  });
}

/** Loads every uncached local image in `fragments`. Resolves true when at least
 *  one image landed (or failed, which paints the unavailable tile) that this
 *  caller's frames do not show yet, so it knows to re-point them. A path another caller is already reading is awaited too:
 *  every caller refreshes its own frames, not only the one that started the read. */
export async function prefetchLocalImages(fragments: string[], sessionId?: string): Promise<boolean> {
  const paths = [...new Set(fragments.flatMap(localPaths))];
  const pending: Promise<boolean>[] = [];
  for (const p of paths) {
    const key = cacheKey(p, sessionId);
    const shared = inflight.get(key);
    if (shared) pending.push(shared);
    else if (!cache.has(key)) pending.push(startRead(p, key, sessionId));
  }
  if (!pending.length) return false;
  return (await Promise.all(pending)).some(Boolean);
}

function startRead(p: string, key: string, sessionId?: string): Promise<boolean> {
  cache.set(key, null);
  const generation = cacheGeneration;
  const read = (async () => {
    try {
      const data = await invoke<{ mime: string; base64: string }>("read_image_file", { path: p, sessionId });
      if (!data?.mime?.startsWith("image/") || data.mime.includes("svg")) {
        cache.delete(key);
        failed.add(key);
        return true;
      }
      cache.set(key, `data:${data.mime};base64,${data.base64}`);
      failed.delete(key);
      return true;
    } catch {
      cache.delete(key);
      failed.add(key);
      return true;
    } finally {
      // A read started before clearLocalImageCache() can finish after a newer
      // read for the same key took its slot; only a read from the current
      // generation can own the slot.
      if (generation === cacheGeneration) inflight.delete(key);
    }
  })();
  inflight.set(key, read);
  return read;
}
