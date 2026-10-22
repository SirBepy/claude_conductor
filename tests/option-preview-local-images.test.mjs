// A file: <img> in an ask_user_question option preview must become
// a data: URL (the sandboxed frame's CSP blocks file:), via the desktop-only
// read_image_file command, and only for raster image extensions.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = [];
let impl = async () => ({ mime: "image/png", base64: "QUJD" });
vi.mock("../src/shared/ipc", () => ({
  invoke: (cmd, args) => {
    calls.push({ cmd, args });
    return impl(cmd, args);
  },
}));

const mod = await import("../src/views/sessions/permission-modal/option-preview-images.ts");

beforeEach(() => {
  calls.length = 0;
  impl = async () => ({ mime: "image/png", base64: "QUJD" });
  mod.clearLocalImageCache();
});

describe("option preview local images", () => {
  it("inlines a file: png as a data: URL after prefetch", async () => {
    const frag = `<p>hi</p><img src="file:///C:/Users/me/a%20b.png" alt="x">`;
    expect(mod.inlineLocalImages(frag)).toBe(frag);
    expect(await mod.prefetchLocalImages([frag])).toBe(true);
    expect(calls).toEqual([{ cmd: "read_image_file", args: { path: "C:/Users/me/a b.png" } }]);
    expect(mod.inlineLocalImages(frag)).toBe(`<p>hi</p><img src="data:image/png;base64,QUJD" alt="x">`);
  });

  it("handles a plain Windows path and single quotes", async () => {
    const frag = `<img src='C:\\pics\\a.JPG'>`;
    await mod.prefetchLocalImages([frag]);
    expect(calls[0].args.path).toBe("C:\\pics\\a.JPG");
    expect(mod.inlineLocalImages(frag)).toContain("data:image/png;base64,QUJD");
  });

  it("leaves non-image and svg srcs untouched and never reads them", async () => {
    const frag = `<img src="file:///C:/x/a.txt"><img src="file:///C:/x/a.svg"><img src="data:image/png;base64,AA"><img src="https://e.com/a.png">`;
    expect(await mod.prefetchLocalImages([frag])).toBe(false);
    expect(calls).toEqual([]);
    expect(mod.inlineLocalImages(frag)).toBe(frag);
  });

  it("keeps the src when the read fails or returns a non-image", async () => {
    const frag = `<img src="file:///C:/x/a.png">`;
    impl = async () => { throw new Error("unknown command"); };
    expect(await mod.prefetchLocalImages([frag])).toBe(false);
    expect(mod.inlineLocalImages(frag)).toBe(frag);
    mod.clearLocalImageCache();
    impl = async () => ({ mime: "text/plain", base64: "QUJD" });
    await mod.prefetchLocalImages([frag]);
    expect(mod.inlineLocalImages(frag)).toBe(frag);
  });

  it("retries a path whose earlier read failed", async () => {
    const frag = `<img src="file:///C:/x/late.png">`;
    impl = async () => { throw new Error("not written yet"); };
    expect(await mod.prefetchLocalImages([frag])).toBe(false);
    impl = async () => ({ mime: "image/png", base64: "QUJD" });
    expect(await mod.prefetchLocalImages([frag])).toBe(true);
    expect(mod.inlineLocalImages(frag)).toContain("data:image/png;base64,QUJD");
  });

  it("a second caller naming a path with a read in flight also resolves true", async () => {
    const frag = `<img src="file:///C:/x/shared.png">`;
    let release;
    impl = () => new Promise((r) => { release = () => r({ mime: "image/png", base64: "QUJD" }); });
    const a = mod.prefetchLocalImages([frag]);
    const b = mod.prefetchLocalImages([frag]);
    release();
    expect([await a, await b]).toEqual([true, true]);
    expect(calls).toHaveLength(1);
    expect(mod.inlineLocalImages(frag)).toContain("data:image/png;base64,QUJD");
  });

  it("leaves HTML-only previews byte-identical with no invoke", async () => {
    const frag = `<div class="btn">Go</div><img src="/icons/a.png">`;
    expect(await mod.prefetchLocalImages([frag])).toBe(false);
    expect(mod.inlineLocalImages(frag)).toBe(frag);
    expect(calls).toEqual([]);
  });
});
