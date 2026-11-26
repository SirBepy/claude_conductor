// @vitest-environment jsdom
// asserts: src/shared/chat/lightbox.ts
//
// A What's new card's caption belongs to its own slide: stepping from a captioned image to a slide of
// another type (or to an image with no caption) must not leave the previous slide's text on screen.

import { describe, it, expect, afterEach } from "vitest";

const { openLightbox, closeLightbox } = await import("../src/shared/chat/lightbox.ts");

const tick = () => new Promise((res) => setTimeout(res, 0));

afterEach(() => {
  closeLightbox();
  document.body.innerHTML = "";
});

const captioned = { type: "image", mime: "image/png", base64: "AAAA", title: "First", caption: "About the first" };
const items = [captioned, { type: "text", content: "log line", filename: "out.txt" }, { type: "image", mime: "image/png", base64: "AAAA" }];
const gallery = { count: items.length, index: 0, load: (i) => items[i] };

describe("the lightbox caption while stepping", () => {
  it("draws the caption of a captioned image", () => {
    openLightbox(captioned, null, gallery);
    expect(document.querySelector(".lightbox-caption-title").textContent).toBe("First");
    expect(document.querySelector(".lightbox-caption-text").textContent).toBe("About the first");
  });

  it("drops it on a slide that is not an image, and on an image without one", async () => {
    openLightbox(captioned, null, gallery);
    document.querySelector(".lightbox-nav--next").click();
    await tick();
    expect(document.querySelector(".lightbox-caption")).toBeNull();
    document.querySelector(".lightbox-nav--next").click();
    await tick();
    expect(document.querySelector(".lightbox-caption")).toBeNull();
  });
});
