// Shrinks an oversized pasted image before staging (see attachments.ts's
// MAX_DRAFT_ATTACHMENT_BYTES). Platform-only: createImageBitmap + canvas.toBlob.
// jsdom implements neither, so both are injectable - tests stub DEPS.

export interface DownscaleDeps {
  createImageBitmap: (blob: Blob) => Promise<ImageBitmap>;
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
}

export const PLATFORM_DOWNSCALE_DEPS: DownscaleDeps = {
  createImageBitmap: (blob) => createImageBitmap(blob),
  createCanvas: (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  },
};

// Longest-edge cap: a 4K screenshot stays legible at 2000px, and a JPEG
// re-encode at that size reliably lands in the low single-digit MB even
// before quality stepping.
const MAX_DIM = 2000;
const QUALITY_STEPS = [0.85, 0.7, 0.55];

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** Re-encodes `blob` as JPEG, shrinking to MAX_DIM and stepping quality down
 *  until under `targetBytes` (or the smallest attempt reached). No-ops for
 *  non-image mimes, already-small blobs, or a decode failure. */
export async function downscaleImage(
  blob: Blob,
  targetBytes: number,
  deps: DownscaleDeps = PLATFORM_DOWNSCALE_DEPS,
): Promise<Blob> {
  if (!blob.type.startsWith("image/") || blob.size <= targetBytes) return blob;
  let bitmap: ImageBitmap;
  try {
    bitmap = await deps.createImageBitmap(blob);
  } catch {
    return blob;
  }
  try {
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = deps.createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, w, h);

    let best = blob;
    for (const q of QUALITY_STEPS) {
      const out = await canvasToBlob(canvas, q);
      if (!out) continue;
      best = out;
      if (out.size <= targetBytes) break;
    }
    return best.size < blob.size ? best : blob;
  } finally {
    bitmap.close();
  }
}
