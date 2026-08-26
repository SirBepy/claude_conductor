// @vitest-environment jsdom
// A custom-view tool (Read/File Changes/Skills/Questions) removes its own rows
// from the DOM, so recoverGroupsFromDom's row-driven pass cannot find its group
// when a turn closes - which minted a second "Read x1" chip beside "Read x4".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";

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
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.window.__TAURI__ = undefined;
});

function res(id, text = "ok") {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: 0 };
}

function chipsFor(container, tool) {
  return [...container.querySelectorAll(`.tool-chip[data-tool="${tool}"]`)];
}

describe("tool chip dedupe across a flush boundary", () => {
  // The bulk loader flushes every 8 events, so a 5-Read turn folds most of its
  // rows on an early chunk and the rest when the closing user message lands.
  it("history replay keeps one Read chip carrying every call", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);

    const events = [userEvent("go")];
    for (let i = 0; i < 5; i++) {
      events.push(toolUseEvent("Read", { file_path: `/a/f${i}.ts` }, `r${i}`), res(`r${i}`));
    }
    events.push(toolUseEvent("Bash", { command: "ls" }, "b1"), res("b1"));
    events.push(assistantEvent("done"), userEvent("next"));
    await r.loadHistory(events);

    const readChips = chipsFor(container, "Read");
    expect(readChips.length).toBe(1);
    expect(readChips[0].querySelector(".tool-chip-count").textContent).toBe("x5");
    expect(chipsFor(container, "Bash").length).toBe(1);

    // One chip means one bucket: the panel must not carry a second empty group.
    expect(container.querySelectorAll('.tool-strip-group[data-tool="Read"]').length).toBe(1);
    r.detach();
  });
});
