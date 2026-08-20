// @vitest-environment jsdom
// Regression for todo 590: older-page pagination never applied update_message
// (revise/retract) to a same-batch send_message row. Cross-batch ordering is
// still out of scope - see chat-pagination.ts's resolveOrdinalInBatch.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, assistantEvent, toolUseEvent } from "./helpers/chat-events.mjs";
import { makeInvokeRouter } from "./helpers/invoke-router.mjs";

const invokeMock = vi.fn();
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

function updateMessageEvent(input, id, ts = 0) {
  return toolUseEvent("mcp__cc_conductor__update_message", input, id, ts);
}

function toolResultEvent(id, { isError = false } = {}, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "" }, is_error: isError, timestamp: ts };
}

let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-update-msg-test-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("older-page update_message rendering", () => {
  it("applies a same-batch revise to the earlier send_message bubble", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("later question", 2_000_000), assistantEvent("later answer", 2_001_000)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        userEvent("old question", 1_000_000),
        sendMessageEvent("original text", "m1", 1_001_000),
        toolResultEvent("m1", {}, 1_001_500),
        updateMessageEvent({ message: 1, text: "revised text" }, "u1", 1_002_000),
        toolResultEvent("u1", {}, 1_002_500),
      ],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    expect(container.textContent).toContain("revised text");
    expect(container.textContent).not.toContain("original text");
  });

  it("applies a same-batch retract to the earlier send_message bubble", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [userEvent("later question", 2_000_000), assistantEvent("later answer", 2_001_000)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        userEvent("old question", 1_000_000),
        sendMessageEvent("oops", "m2", 1_001_000),
        toolResultEvent("m2", {}, 1_001_500),
        updateMessageEvent({ message: 1, retract: true }, "u2", 1_002_000),
        toolResultEvent("u2", {}, 1_002_500),
      ],
      oldest_seq: 0,
      newest_seq: 9,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    expect(container.querySelector(".retracted-marker")).not.toBeNull();
    expect(container.textContent).toContain("Retracted");
  });
});
