// Screenshot block (turn-collapse.ts's mountScreenshotBlock) + gallery
// (chat-image-gallery.ts): a tool's image tool_results are pulled out of the
// raw action-log accordion into an always-visible thumbnail row, tagged by
// which agent (main turn vs Nth subagent) captured them. The tool's real chip
// relocates into the block's header but keeps toggling the same accordion for
// its NON-image calls.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

if (!globalThis.window) globalThis.window = {};

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

beforeEach(() => {
  invokeMock.mockReset();
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

function imageResultEvent(id, data = "AAAA") {
  return { type: "tool_result", tool_use_id: id, output: { type: "image", mime: "image/png", data }, is_error: false, timestamp: 0 };
}

function textResultEvent(id, text = "ok") {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: 0 };
}

function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = new ChatRenderer(container);
  r.handleEvent(userEvent("take some screenshots"));
  return { r, container };
}

describe("screenshot block", () => {
  it("pulls a top-level tool's image results into an always-visible, Main-tagged row", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("mcp__playwright__browser_navigate", { url: "https://x.test" }, "t1"));
    r.handleEvent(textResultEvent("t1", "navigated"));
    r.handleEvent(toolUseEvent("mcp__playwright__browser_take_screenshot", {}, "t2"));
    r.handleEvent(imageResultEvent("t2"));
    r.handleEvent(toolUseEvent("mcp__playwright__browser_take_screenshot", {}, "t3"));
    r.handleEvent(imageResultEvent("t3"));

    const block = container.querySelector('.screenshot-block[data-tool="mcp:playwright"]');
    expect(block).not.toBeNull();

    // The tool's chip stays on the turn's shared chip line, count intact
    // (3 calls total: navigate + 2 screenshots); the block sits under it.
    const chip = container.querySelector('.tool-strip > .tool-chip[data-tool="mcp:playwright"]');
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".tool-chip-count").textContent).toBe("x3");
    // No duplicate chip left behind in a normal .tool-strip.
    expect(container.querySelectorAll('.tool-chip[data-tool="mcp:playwright"]').length).toBe(1);

    const thumbs = block.querySelectorAll(".screenshot-row .screenshot-thumb");
    expect(thumbs.length).toBe(2);
    for (const thumb of thumbs) {
      expect(thumb.dataset.agent).toBe("main");
      expect(thumb.querySelector(".screenshot-agent-tag").textContent).toBe("Main");
      expect(thumb.querySelector("img").src).toContain("data:image/png;base64,AAAA");
    }

    // The raw image tool_result rows never stack in the chat flow / accordion.
    expect(container.querySelector('img[src^="data:image/png"].block.image')).toBeNull();

    // Clicking the chip still opens the accordion for the tool's NON-image
    // call (navigate) - the screenshots themselves aren't in there.
    // (DOM order: .tool-strip, the shared .tool-strip-panel, then the block.)
    chip.click();
    const panel = block.parentElement.querySelector(".tool-strip-panel");
    expect(panel).not.toBeNull();
    expect(panel.classList.contains("tool-strip-panel")).toBe(true);
    expect(panel.hidden).toBe(false);
    const bucket = panel.querySelector(':scope > .tool-strip-group[data-tool="mcp:playwright"]');
    expect(bucket.hidden).toBe(false);
    expect(bucket.querySelector(".tool-row-name").textContent).toBe("Playwright");
    // The action log still lists every CALL (navigate's use+result pair, plus
    // the 2 screenshot actions themselves) - only the image OUTPUTS moved to
    // the gallery.
    expect(bucket.querySelectorAll(".tool-row").length).toBe(4);
    expect(bucket.querySelectorAll(".tool-result").length).toBe(1); // navigate's text result only
    r.detach();
  });

  it("tags a subagent's screenshot as Sub 1 / Subagent 1, distinct from the main turn's", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("Task", { description: "Check the login flow" }, "agent1"));
    r.handleEvent({ type: "tool_use", tool_name: "mcp__playwright__browser_take_screenshot", input: {}, id: "c1", parent_tool_use_id: "agent1", timestamp: 0 });
    r.handleEvent(imageResultEvent("c1", "SUBDATA"));
    r.handleEvent(toolUseEvent("mcp__playwright__browser_take_screenshot", {}, "m1"));
    r.handleEvent(imageResultEvent("m1", "MAINDATA"));

    const block = container.querySelector('.screenshot-block[data-tool="mcp:playwright"]');
    expect(block).not.toBeNull();
    const thumbs = [...block.querySelectorAll(".screenshot-row .screenshot-thumb")];
    expect(thumbs.length).toBe(2);

    const subThumb = thumbs.find((t) => t.dataset.agent === "sub");
    const mainThumb = thumbs.find((t) => t.dataset.agent === "main");
    expect(subThumb).toBeTruthy();
    expect(mainThumb).toBeTruthy();
    expect(subThumb.querySelector(".screenshot-agent-tag").textContent).toBe("Sub 1");
    expect(mainThumb.querySelector(".screenshot-agent-tag").textContent).toBe("Main");
    r.detach();
  });

  it("clicking a thumbnail opens the gallery, clamped at both ends, closable via Escape", () => {
    const { r, container } = makeRenderer();
    r.handleEvent(toolUseEvent("mcp__playwright__browser_take_screenshot", {}, "t1"));
    r.handleEvent(imageResultEvent("t1", "ONE"));
    r.handleEvent(toolUseEvent("mcp__playwright__browser_take_screenshot", {}, "t2"));
    r.handleEvent(imageResultEvent("t2", "TWO"));

    const thumbs = container.querySelectorAll(".screenshot-thumb");
    expect(thumbs.length).toBe(2);
    thumbs[0].click();

    const overlay = document.querySelector(".chat-image-gallery-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector(".gallery-total-counter").textContent).toBe("1 of 2");
    const prevBtn = overlay.querySelector(".screenshot-gallery-nav--prev");
    const nextBtn = overlay.querySelector(".screenshot-gallery-nav--next");
    expect(prevBtn.disabled).toBe(true); // clamped at the first image
    expect(nextBtn.disabled).toBe(false);

    nextBtn.click();
    expect(overlay.querySelector(".gallery-total-counter").textContent).toBe("2 of 2");
    expect(overlay.querySelector(".screenshot-gallery-nav--next").disabled).toBe(true); // clamped at the last

    // ArrowRight is a no-op past the end; ArrowLeft steps back.
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(overlay.querySelector(".gallery-total-counter").textContent).toBe("2 of 2");
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(overlay.querySelector(".gallery-total-counter").textContent).toBe("1 of 2");

    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".chat-image-gallery-overlay")).toBeNull();
    r.detach();
  });
});
