const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
};

/** Image MIME type from a path or URL's extension, or null when it isn't one. */
export function imageMimeFromPath(path: string): string | null {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return m ? (IMG_MIME[m[1]!] ?? null) : null;
}
