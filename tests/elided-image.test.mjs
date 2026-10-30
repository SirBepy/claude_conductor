// A history page leaves an oversized screenshot's base64 out (history_page.rs
// IMAGE_INLINE_MAX_B64): the tool_result arrives as an image with empty data
// plus output_truncated/full_seq/output_bytes. The renderer shows a sized
// placeholder and fills it from load_event_detail.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { collectChatImages } = await import("../src/shared/chat/chat-image-gallery-data.ts");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

const FULL = { type: "image", mime: "image/png", data: "iVBORw0KGgo=" };

function elidedResult(id, seq = 4200) {
  return {
    type: "tool_result",
    tool_use_id: id,
    output: { type: "image", mime: "image/png", data: "" },
    is_error: false,
    timestamp: 0,
    output_truncated: true,
    full_seq: seq,
    output_bytes: 1572864,
  };
}

function detailFor(id) {
  return { type: "tool_result", tool_use_id: id, output: FULL, is_error: false, timestamp: 0, output_truncated: false, full_seq: null, output_bytes: null };
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  r.sessionId = "s1";
  r.handleEvent(userEvent("take a screenshot"));
  r.handleEvent(toolUseEvent("mcp__playwright__browser_take_screenshot", {}, "t1"));
  r.handleEvent(elidedResult("t1"));
  return { r, container };
}

describe("elided screenshot", () => {
  it("renders a labelled placeholder thumbnail instead of an image", () => {
    const { r, container } = mount();
    const thumb = container.querySelector(".screenshot-row .screenshot-thumb");
    expect(thumb).not.toBeNull();
    expect(thumb.hasAttribute("data-elided-image")).toBe(true);
    expect(thumb.dataset.seq).toBe("4200");
    expect(thumb.dataset.toolUseId).toBe("t1");
    expect(thumb.querySelector("img")).toBeNull();
    expect(thumb.textContent).toContain("image/png, 1.5 MB");
    r.detach();
  });

  it("is left out of the gallery until its bytes load", () => {
    const { r, container } = mount();
    expect(collectChatImages(r.messages, r.messageEls).images).toHaveLength(0);
    r.detach();
    expect(container).toBeTruthy();
  });

  it("fetches through load_event_detail by full_seq and swaps in the real image", async () => {
    invokeMock.mockResolvedValue(detailFor("t1"));
    const { r, container } = mount();
    const thumb = container.querySelector(".screenshot-thumb");

    r.elidedImages.hydrate(thumb);
    await vi.waitFor(() => expect(thumb.querySelector("img")).not.toBeNull());

    expect(invokeMock).toHaveBeenCalledWith("load_event_detail", expect.objectContaining({ sessionId: "s1", seq: 4200, toolUseId: "t1" }));
    expect(thumb.querySelector("img").src).toBe(`data:image/png;base64,${FULL.data}`);
    expect(thumb.hasAttribute("data-elided-image")).toBe(false);
    // The message holds the bytes now, so the gallery sees the shot.
    const images = collectChatImages(r.messages, r.messageEls).images;
    expect(images.map((i) => i.data)).toEqual([FULL.data]);
    r.detach();
  });

  it("shows an orphan result (no tool_use on the page) as an inline placeholder that loads in place", async () => {
    invokeMock.mockResolvedValue(detailFor("orphan"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    r.sessionId = "s1";
    r.handleEvent(userEvent("hi"));
    r.handleEvent(elidedResult("orphan", 77));
    const box = container.querySelector(".msg.tool-result .elided-image");
    expect(box).not.toBeNull();
    expect(box.textContent).toContain("image/png, 1.5 MB");

    r.elidedImages.hydrate(box);
    await vi.waitFor(() => expect(container.querySelector(".msg.tool-result img.block.image")).not.toBeNull());
    expect(container.querySelector(".elided-image")).toBeNull();
    r.detach();
  });

  it("marks a failed load for retry and loads on the next try", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { r, container } = mount();
    const thumb = container.querySelector(".screenshot-thumb");

    r.elidedImages.hydrate(thumb);
    await vi.waitFor(() => expect(thumb.dataset.elidedState).toBe("error"));
    expect(thumb.querySelector("img")).toBeNull();

    invokeMock.mockResolvedValue(detailFor("t1"));
    r.elidedImages.hydrate(thumb);
    await vi.waitFor(() => expect(thumb.querySelector("img")).not.toBeNull());
    err.mockRestore();
    r.detach();
  });
});
