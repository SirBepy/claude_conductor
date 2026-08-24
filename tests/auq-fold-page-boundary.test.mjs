// @vitest-environment jsdom
// todo 710: an ask on an OLDER page whose sentinel answer already rendered
// as a plain bubble on the NEWER page must still resolve the card.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

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

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");
const { AUQ_ANSWER_SENTINEL } = await import("../src/shared/chat/chat-transforms.ts");

const ASK_TOOL = "mcp__cc_conductor__ask_user_question";
const ACK_TEXT = '{"acknowledged":true,"note":"the card is now waiting for their answer."}';

function toolResultEvent(id, text, ts = 0) {
  return { type: "tool_result", tool_use_id: id, output: { type: "text", text }, is_error: false, timestamp: ts };
}

let _sessSeq = 0;
async function makeRenderer() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-auq-pageboundary-${++_sessSeq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

describe("AUQ fold across a fetched-page boundary (todo 710)", () => {
  it("resolves a card whose ask is on the older page once its sentinel answer, already rendered on the newer page, is reachable", async () => {
    // Dispatch by command/args, not call order: loadFromStore's Promise.all
    // also fires get_skipped_question_marks, which can resolve first and
    // desync a position-based mockResolvedValueOnce queue.
    invokeMock.mockImplementation((cmd, args) => {
      if (cmd === "get_skipped_question_marks") return Promise.resolve([]);
      if (cmd === "load_history_page" && args && "beforeSeq" in args) {
        // Older page (fetched on scroll-up): the ask, with no in-page answer -
        // its sentinel answer already rendered on the newer page below.
        return Promise.resolve({
          events: [
            userEvent("start", 1_000_000),
            toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1", 1_000_100),
            toolResultEvent("q1", ACK_TEXT, 1_000_150),
          ],
          oldest_seq: 1,
          newest_seq: 9,
          has_more: false,
        });
      }
      if (cmd === "load_history_page") {
        // Newest page (loaded first): the sentinel answer, with no ask card
        // yet present to match against - renders as a plain bubble.
        return Promise.resolve({
          events: [
            {
              type: "user_message",
              timestamp: 2_000_000,
              content: [{ type: "text", text: `${AUQ_ANSWER_SENTINEL}User answered the question(s):\nQ: Pick one?\nA: Option A` }],
            },
          ],
          oldest_seq: 10,
          newest_seq: 12,
          has_more: true,
        });
      }
      return Promise.resolve(undefined);
    });

    const { renderer, container } = await makeRenderer();
    await renderer.fetchOlder();

    const cards = container.querySelectorAll(".question-card-collapsible");
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.resolution).toBe("answered");
    expect(cards[0].textContent).toContain("Option A");
  });
});
