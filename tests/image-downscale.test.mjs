// @vitest-environment jsdom
//
// jsdom has no createImageBitmap/canvas encoding, so deps are injected here.

import { describe, it, expect, vi } from "vitest";
import { downscaleImage } from "../src/views/sessions/permission-modal/image-downscale.ts";

function fakeDeps({ width = 4000, height = 3000, outputs = [] } = {}) {
  let call = 0;
  const bitmap = { width, height, close: vi.fn() };
  const canvas = {
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (cb, type) => {
      const size = outputs[Math.min(call++, outputs.length - 1)];
      cb(size == null ? null : new Blob([new Uint8Array(size)], { type }));
    },
  };
  return {
    createImageBitmap: vi.fn().mockResolvedValue(bitmap),
    createCanvas: vi.fn().mockReturnValue(canvas),
    bitmap,
  };
}

describe("downscaleImage", () => {
  it("no-ops when already under target", async () => {
    const deps = fakeDeps();
    const input = new Blob([new Uint8Array(100)], { type: "image/png" });
    const out = await downscaleImage(input, 500_000, deps);
    expect(out).toBe(input);
    expect(deps.createImageBitmap).not.toHaveBeenCalled();
  });

  it("no-ops for a non-image mime", async () => {
    const deps = fakeDeps();
    const input = new Blob([new Uint8Array(3_000_000)], { type: "application/pdf" });
    const out = await downscaleImage(input, 500_000, deps);
    expect(out).toBe(input);
  });

  it("caps the longest edge at 2000px", async () => {
    const deps = fakeDeps({ width: 4000, height: 3000, outputs: [400_000] });
    const input = new Blob([new Uint8Array(3_000_000)], { type: "image/png" });
    await downscaleImage(input, 500_000, deps);
    expect(deps.createCanvas).toHaveBeenCalledWith(2000, 1500);
  });

  it("stops at the first JPEG quality step that lands under target", async () => {
    const deps = fakeDeps({ outputs: [900_000, 400_000, 200_000] });
    const input = new Blob([new Uint8Array(3_000_000)], { type: "image/png" });
    const out = await downscaleImage(input, 500_000, deps);
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(400_000);
    expect(deps.bitmap.close).toHaveBeenCalled();
  });

  it("falls back to the smallest attempt reached if quality stepping never hits target", async () => {
    const deps = fakeDeps({ outputs: [900_000, 850_000, 800_000] });
    const input = new Blob([new Uint8Array(3_000_000)], { type: "image/png" });
    const out = await downscaleImage(input, 500_000, deps);
    expect(out.size).toBe(800_000);
  });

  it("returns the original blob unchanged when bitmap decode fails", async () => {
    const deps = { createImageBitmap: vi.fn().mockRejectedValue(new Error("unsupported")), createCanvas: vi.fn() };
    const input = new Blob([new Uint8Array(3_000_000)], { type: "image/png" });
    const out = await downscaleImage(input, 500_000, deps);
    expect(out).toBe(input);
  });
});
