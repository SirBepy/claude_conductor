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
// Raster types only: svg is excluded because it can carry script and external
// references, and anything but an image extension is never read at all, so a
// preview cannot be used to pull an arbitrary local file into the frame.

import { invoke } from "../../../shared/ipc";

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const WIN_PATH = /^[A-Za-z]:[\\/]/;

// Resolved data: URL per (session, source path); null = read in flight. A failed read is
// dropped again, so a later card naming the same path (often a file Claude was
// still writing the first time) tries once more.
const cache = new Map<string, string | null>();
// The read behind each null cache entry, shared so a second card naming the
// same path awaits it instead of seeing "already handled" and never refreshing.
const inflight = new Map<string, Promise<boolean>>();

function cacheKey(path: string, sessionId?: string): string {
  return `${sessionId ?? ""}|${path}`;
}

export function clearLocalImageCache(): void {
  cache.clear();
  inflight.clear();
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
  return IMAGE_EXT.test(path) ? path : null;
}

function localPaths(fragment: string): string[] {
  const out: string[] = [];
  for (const m of fragment.matchAll(IMG_SRC)) {
    const p = localImagePath(m[3]!);
    if (p) out.push(p);
  }
  return out;
}

/** Sync swap of every already-loaded local image; the fragment is returned
 *  untouched (same string) when there is nothing to swap. */
export function inlineLocalImages(fragment: string, sessionId?: string): string {
  return fragment.replace(IMG_SRC, (whole, pre: string, q: string, src: string) => {
    const p = localImagePath(src);
    const data = p ? cache.get(cacheKey(p, sessionId)) : null;
    return data ? `${pre}${q}${data}${q}` : whole;
  });
}

/** Loads every uncached local image in `fragments`. Resolves true when at least
 *  one image landed that this caller's frames do not show yet, so it knows to
 *  re-point them. A path another caller is already reading is awaited too:
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
  const read = (async () => {
    try {
      const data = await invoke<{ mime: string; base64: string }>("read_image_file", { path: p, sessionId });
      if (!data?.mime?.startsWith("image/") || data.mime.includes("svg")) {
        cache.delete(key);
        return false;
      }
      cache.set(key, `data:${data.mime};base64,${data.base64}`);
      return true;
    } catch {
      cache.delete(key);
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, read);
  return read;
}
