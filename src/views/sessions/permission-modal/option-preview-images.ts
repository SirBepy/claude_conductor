// Local images in an option's `preview` HTML. The preview frame is a sandboxed
// srcdoc under a CSP of `img-src 'self' data: blob:`, so a file: <img> renders
// broken. Each one is read through `read_image_file` (the same command the
// status bar uses for agent-surfaced paths) and swapped for a data: URL.
//
// `read_attachment`, which chat attachments use, is confined to the
// chat-attachments dir and so can never read a file Claude just made elsewhere.
// `read_image_file` is desktop-only (not an RPC, see registry/attachments.rs),
// so on the phone the invoke throws and the src is left as-is.
//
// Raster types only: svg is excluded because it can carry script and external
// references, and anything but an image extension is never read at all, so a
// preview cannot be used to pull an arbitrary local file into the frame.

import { invoke } from "../../../shared/ipc";

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const WIN_PATH = /^[A-Za-z]:[\\/]/;

// Resolved data: URL per source path; null = tried and failed (never retried).
const cache = new Map<string, string | null>();

export function clearLocalImageCache(): void {
  cache.clear();
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
export function inlineLocalImages(fragment: string): string {
  return fragment.replace(IMG_SRC, (whole, pre: string, q: string, src: string) => {
    const p = localImagePath(src);
    const data = p ? cache.get(p) : null;
    return data ? `${pre}${q}${data}${q}` : whole;
  });
}

/** Loads every uncached local image in `fragments`. Resolves true when at least
 *  one new image landed, so the caller knows to re-point its frames. */
export async function prefetchLocalImages(fragments: string[]): Promise<boolean> {
  const todo = [...new Set(fragments.flatMap(localPaths))].filter((p) => !cache.has(p));
  if (!todo.length) return false;
  for (const p of todo) cache.set(p, null);
  const loaded = await Promise.all(todo.map(async (p) => {
    try {
      const data = await invoke<{ mime: string; base64: string }>("read_image_file", { path: p });
      if (!data?.mime?.startsWith("image/") || data.mime.includes("svg")) return false;
      cache.set(p, `data:${data.mime};base64,${data.base64}`);
      return true;
    } catch {
      return false;
    }
  }));
  return loaded.some(Boolean);
}
