// @vitest-environment jsdom
// asserts: src/shared/chat/attachment-hydrator.ts

// A path-attached image only becomes a picture in the transcript after an
// async read, so the hydrator announces it on window: the dashboard's Images
// tab re-reads the chat's images on that event.

import { describe, it, expect, beforeEach } from "vitest";

const { resetTransportForTests } = await import("../src/shared/transport.ts");
const { hydrateAttachments, ATTACHMENT_SETTLED_EVENT } = await import("../src/shared/chat/attachment-hydrator.ts");

let answer;
beforeEach(() => {
  document.body.innerHTML = "";
  answer = { mime: "image/png", base64: "iVBORw0KGgo=" };
  globalThis.window.__TAURI__ = { core: { invoke: async () => answer }, event: { listen: async () => () => {} } };
  resetTransportForTests();
});

const host = () => {
  const el = document.createElement("div");
  el.innerHTML = `<div class="attachment-chip" data-attachment-path="C:\\shots\\a.png" data-filename="a.png"></div>`;
  document.body.appendChild(el);
  return el;
};

describe("attachment hydrator settled event", () => {
  it("fires once the image chip has become a thumbnail, not before", async () => {
    const el = host();
    let seenThumb = null;
    window.addEventListener(ATTACHMENT_SETTLED_EVENT, () => { seenThumb = el.querySelector(".sent-attachment-thumb"); }, { once: true });
    await hydrateAttachments(el, "s1");
    expect(seenThumb).not.toBeNull();
  });

  it("stays quiet for a file that is not an image", async () => {
    answer = { mime: "application/pdf", base64: "JVBERg==" };
    const el = host();
    let fired = false;
    window.addEventListener(ATTACHMENT_SETTLED_EVENT, () => { fired = true; }, { once: true });
    await hydrateAttachments(el, "s1");
    expect(fired).toBe(false);
  });
});
