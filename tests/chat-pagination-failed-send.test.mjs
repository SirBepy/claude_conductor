// @vitest-environment jsdom
// A rejected send_message draws nothing on the older-page (scrollback) path
// either, same as the live path (chat-transforms.ts's `m.failed` branch): the
// daemon's rejected-sends log is where it is recorded.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

let invokeRouter;

beforeEach(() => {
  invokeMock.mockReset();
  invokeRouter = makeInvokeRouter(invokeMock);
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

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

function sendMessageEvent(text, id, ts = 0) {
  return toolUseEvent("mcp__cc_conductor__send_message", { text }, id, ts);
}

function toolResultEvent(id, { isError = false } = {}, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "" }, is_error: isError, timestamp: ts };
}

let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-failed-send-test-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("older-page failed send_message rendering", () => {
  it("draws neither a bubble nor a pill for a rejected send_message", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("later question", 2_000_000), assistantEvent("later answer", 2_001_000)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        userEvent("old question", 1_000_000),
        sendMessageEvent("too long, rejected", "m2", 1_001_000),
        toolResultEvent("m2", { isError: true }, 1_001_500),
      ],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    expect(container.querySelector(".failed-chip")).toBeNull();
    expect(container.textContent).not.toContain("Failed to send");
    expect(container.textContent).not.toContain("too long, rejected");
    expect(container.textContent).toContain("old question");
  });
});
