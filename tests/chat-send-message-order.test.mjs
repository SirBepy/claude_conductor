// @vitest-environment jsdom

// A send_message bubble must never render above a user message that opened its
// turn. The history window is cut by assistant-reply count, so a long turn is
// often split: the newest page holds the turn's tail (tool rows plus the final
// summary send_message) and an older page holds its opening user message and
// the earlier progress bubbles. Scrolling up prepends that older page; its rows
// have to land ABOVE the tail, in transcript order.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";
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

if (!globalThis.window) {
  globalThis.window = {};
}

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

const SEND = "mcp__cc_conductor__send_message";

function toolResultEvent(id, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text: "ok" }, is_error: false, timestamp: ts };
}

function sendMessage(text, id, ts) {
  return toolUseEvent(SEND, { text }, id, ts);
}

let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-order-test-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

/** Visible bubble texts (user rows + send_message rows) in DOM order. */
function bubbleOrder(container) {
  return [...container.querySelectorAll(".msg")]
    .filter((el) => !el.classList.contains("chat-narration") && !el.closest(".turn-footer"))
    .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
}

function indexOfText(order, needle) {
  return order.findIndex((t) => t.includes(needle));
}

describe("send_message bubbles keep transcript order across pagination", () => {
  it("prepends the opener and earlier progress bubbles above a tail already folded at load", async () => {
    invokeRouter.queueOnce("load_history_page", {
      // Newest window cut MID-turn: tool work then the closing summary bubble.
      events: [
        toolUseEvent("Bash", { command: "git commit" }, "t5", 2_040_000),
        toolResultEvent("t5", 2_041_000),
        sendMessage("SUMMARY both changes are committed", "s3", 2_050_000),
      ],
      oldest_seq: 20,
      newest_seq: 30,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      // Older page: the turn's opening user message and its progress bubbles.
      events: [
        userEvent("OPENER lets use impeccable", 2_000_000),
        sendMessage("PROGRESS ONE reading the mount", "s1", 2_010_000),
        toolUseEvent("Read", { file_path: "a.ts" }, "t1", 2_011_000),
        toolResultEvent("t1", 2_012_000),
        sendMessage("PROGRESS TWO starting edits", "s2", 2_020_000),
        toolUseEvent("Edit", { file_path: "a.ts" }, "t2", 2_021_000),
        toolResultEvent("t2", 2_022_000),
      ],
      oldest_seq: 0,
      newest_seq: 19,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    const order = bubbleOrder(container);
    const opener = indexOfText(order, "OPENER");
    const one = indexOfText(order, "PROGRESS ONE");
    const two = indexOfText(order, "PROGRESS TWO");
    const summary = indexOfText(order, "SUMMARY");
    expect([opener, one, two, summary].every((i) => i >= 0)).toBe(true);
    expect(opener).toBeLessThan(one);
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(summary);
  });

  it("keeps order when the tail is only a summary bubble with no tool rows", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [sendMessage("SUMMARY alone", "s3", 2_050_000)],
      oldest_seq: 20,
      newest_seq: 30,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        userEvent("OPENER ask", 2_000_000),
        sendMessage("PROGRESS ONE", "s1", 2_010_000),
      ],
      oldest_seq: 0,
      newest_seq: 19,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    const order = bubbleOrder(container);
    expect(indexOfText(order, "OPENER")).toBeLessThan(indexOfText(order, "PROGRESS ONE"));
    expect(indexOfText(order, "PROGRESS ONE")).toBeLessThan(indexOfText(order, "SUMMARY"));
  });

  it("keeps order across three pages when the middle page is tool-only", async () => {
    invokeRouter.queueOnce("load_history_page", {
      events: [
        toolUseEvent("Bash", { command: "x" }, "t9", 2_060_000),
        toolResultEvent("t9", 2_061_000),
        sendMessage("SUMMARY end", "s3", 2_070_000),
      ],
      oldest_seq: 40,
      newest_seq: 50,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        toolUseEvent("Grep", { pattern: "x" }, "t7", 2_030_000),
        toolResultEvent("t7", 2_031_000),
      ],
      oldest_seq: 20,
      newest_seq: 39,
      has_more: true,
    });
    invokeRouter.queueOnce("load_history_page", {
      events: [
        userEvent("OPENER ask", 2_000_000),
        sendMessage("PROGRESS ONE", "s1", 2_010_000),
      ],
      oldest_seq: 0,
      newest_seq: 19,
      has_more: false,
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();
    await renderer.fetchOlder();

    const order = bubbleOrder(container);
    expect(indexOfText(order, "OPENER")).toBeLessThan(indexOfText(order, "PROGRESS ONE"));
    expect(indexOfText(order, "PROGRESS ONE")).toBeLessThan(indexOfText(order, "SUMMARY"));
  });

  it("renders a live turn in send order", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const r = new ChatRenderer(container);
    r.handleEvent(userEvent("OPENER ask"));
    r.handleEvent(sendMessage("PROGRESS ONE", "s1"));
    r.handleEvent(toolUseEvent("Bash", { command: "x" }, "t1"));
    r.handleEvent(toolResultEvent("t1"));
    r.handleEvent(sendMessage("SUMMARY end", "s3"));

    const order = bubbleOrder(container);
    expect(indexOfText(order, "OPENER")).toBeLessThan(indexOfText(order, "PROGRESS ONE"));
    expect(indexOfText(order, "PROGRESS ONE")).toBeLessThan(indexOfText(order, "SUMMARY"));
  });
});
