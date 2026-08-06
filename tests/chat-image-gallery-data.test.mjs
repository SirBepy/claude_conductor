// Chat-wide image gallery data: flattens every attachment + tool-result
// screenshot into one ordered list, grouped into one entry per turn that has
// at least one image.

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

let collectChatImages;
let attachmentShots;

beforeEach(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  ({ collectChatImages } = await import("../src/shared/chat/chat-image-gallery-data.ts"));
  ({ attachmentShots } = await import("../src/shared/chat/attachment-hydrator.ts"));
});

function userMsg(text) {
  return { kind: "user", content: [{ type: "text", text }], ts: 0 };
}

function toolUse(id, tool, input = {}) {
  return { kind: "tool_use", id, tool, input, ts: 0 };
}

function toolImageResult(tool_use_id, data = "AAAA") {
  return { kind: "tool_result", tool_use_id, output: { type: "image", mime: "image/png", data }, ts: 0 };
}

function attachmentThumb(mime, base64, filename) {
  const thumb = document.createElement("div");
  thumb.className = "sent-attachment-thumb";
  attachmentShots.set(thumb, { mime, base64, filename });
  return thumb;
}

describe("collectChatImages", () => {
  it("returns empty collection for a chat with no images", () => {
    const messages = [userMsg("hello"), { kind: "assistant", content: [{ type: "text", text: "hi" }], ts: 0 }];
    const els = messages.map(() => document.createElement("div"));
    const result = collectChatImages(messages, els);
    expect(result.images).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it("groups attachments and screenshots into one entry per turn, ordering attachments before screenshots", () => {
    const messages = [
      userMsg("<file:/a.png::photo.png> look at this"),
      toolUse("t1", "mcp__playwright__browser_take_screenshot"),
      toolImageResult("t1"),
    ];
    const userEl = document.createElement("div");
    userEl.appendChild(attachmentThumb("image/png", "BBBB", "photo.png"));
    const els = [userEl, document.createElement("div"), document.createElement("div")];

    const result = collectChatImages(messages, els);
    expect(result.images.length).toBe(2);
    expect(result.images[0].kind).toBe("attachment");
    expect(result.images[0].title).toBe("photo.png");
    expect(result.images[0].agentTag).toBe("You");
    expect(result.images[1].kind).toBe("screenshot");
    expect(result.images[1].agentKind).toBe("main");
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].turnNumber).toBe(1);
    expect(result.entries[0].images).toEqual([0, 1]);
    // File token stripped from the derived entry name.
    expect(result.entries[0].name).toBe("look at this");
  });

  it("numbers turnNumber only among turns that actually contain an image", () => {
    const messages = [
      userMsg("no images here"),
      { kind: "assistant", content: [{ type: "text", text: "ok" }], ts: 0 },
      userMsg("now a screenshot"),
      toolUse("t2", "Bash"),
      toolImageResult("t2"),
    ];
    const els = messages.map(() => document.createElement("div"));
    const result = collectChatImages(messages, els);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].turnNumber).toBe(1);
    expect(result.entries[0].name).toBe("now a screenshot");
  });

  it("falls back to the first image's title when the opening text is empty after stripping file tokens", () => {
    const messages = [userMsg("<file:/a.png::photo.png>")];
    const userEl = document.createElement("div");
    userEl.appendChild(attachmentThumb("image/png", "CCCC", "photo.png"));
    const result = collectChatImages(messages, [userEl]);
    expect(result.entries[0].name).toBe("photo.png");
  });
});
