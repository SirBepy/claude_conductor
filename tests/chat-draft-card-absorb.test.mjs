// @vitest-environment jsdom
// The write_draft tool_result is absorbed, never rendered, on BOTH paths - and
// it is what stamps the draft id onto the card. Driven through the real
// ChatRenderer rather than the converters, because the failure this guards is
// path drift: a card that goes live in a running chat but comes back as a dead
// snapshot (or a stray JSON tool_result row) after a reload or a scroll-up.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ getTransport: () => ({ listen: listenMock }) }));

const DRAFT_TOOL = "mcp__cc_conductor__write_draft";
const DRAFT_ID = "abcdef12-3456";

const DRAFT = {
  id: DRAFT_ID,
  topic: "Sprint slip",
  brief: "",
  receipts: [],
  variants: [{
    recipient: "Bruno",
    handle_n: 2,
    current: 1,
    versions: [{ n: 1, body: "hey there", author: "ai", note: "", created_at: "2026-09-26T00:00:00Z" }],
  }],
  state: "needs-you",
  origin_session_id: "s1",
  origin_label: "chat A",
  created_at: "2026-09-26T00:00:00Z",
  updated_at: "2026-09-26T00:00:00Z",
  seen_by_origin: true,
};

const ADD_INPUT = { action: "add", topic: "Sprint slip", recipient: "Bruno", body: "hey there" };

function draftResultEvent(id, ok = true, ts = 0) {
  return {
    type: "tool_result",
    tool_use_id: id,
    output: { type: "text", text: JSON.stringify(ok ? { ok: true, draft: DRAFT } : { ok: false, error: "topic is required" }) },
    is_error: !ok,
    timestamp: ts,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
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

let _seq = 0;
async function makeRenderer(pages) {
  invokeMock.mockImplementation((cmd, args) => {
    if (cmd === "get_skipped_question_marks") return Promise.resolve([]);
    if (cmd === "list_message_drafts") return Promise.resolve({ drafts: [DRAFT] });
    if (cmd === "load_history_page") {
      return Promise.resolve(args && "beforeSeq" in args ? pages.older : pages.newest);
    }
    return Promise.resolve(undefined);
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-draft-absorb-${++_seq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

const EMPTY_PAGE = { events: [], oldest_seq: 1, newest_seq: 1, has_more: false };

describe("live path", () => {
  it("renders one card and absorbs the tool_result that carries the id", async () => {
    const { renderer, container } = await makeRenderer({ newest: EMPTY_PAGE, older: EMPTY_PAGE });
    renderer.handleEvent(userEvent("write Bruno a note", 1_000_000));
    renderer.handleEvent(toolUseEvent(DRAFT_TOOL, ADD_INPUT, "tu-1", 1_000_100));
    renderer.handleEvent(draftResultEvent("tu-1", true, 1_000_200));

    const cards = container.querySelectorAll(".msg.draft-card");
    expect(cards.length).toBe(1);
    // Absorbed: the raw JSON never becomes its own row.
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(0);
    expect(container.textContent).not.toContain('"ok":true');
    // Live: the id from the result is what a refresh keys on.
    expect(cards[0].dataset.draftId).toBe(DRAFT_ID);
    expect(cards[0].querySelector(".dc-body").textContent).toContain("hey there");
  });

  it("marks the card dead when the write was rejected, rather than claiming a draft exists", async () => {
    const { renderer, container } = await makeRenderer({ newest: EMPTY_PAGE, older: EMPTY_PAGE });
    renderer.handleEvent(userEvent("write Bruno a note", 1_000_000));
    renderer.handleEvent(toolUseEvent(DRAFT_TOOL, { action: "add", recipient: "Bruno", body: "hey" }, "tu-2", 1_000_100));
    renderer.handleEvent(draftResultEvent("tu-2", false, 1_000_200));

    const card = container.querySelector(".msg.draft-card");
    expect(card.classList.contains("unresolved")).toBe(true);
    expect(card.dataset.draftId).toBeUndefined();
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(0);
  });
});

describe("scrollback path", () => {
  it("rebuilds the same live card from history instead of a snapshot", async () => {
    const page = {
      events: [
        userEvent("write Bruno a note", 1_000_000),
        toolUseEvent(DRAFT_TOOL, ADD_INPUT, "tu-1", 1_000_100),
        draftResultEvent("tu-1", true, 1_000_200),
      ],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    };
    const { container } = await makeRenderer({ newest: page, older: EMPTY_PAGE });

    const cards = container.querySelectorAll(".msg.draft-card");
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.draftId).toBe(DRAFT_ID);
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(0);
  });

  it("absorbs the result on a page fetched by scrolling up too", async () => {
    const older = {
      events: [
        userEvent("write Bruno a note", 1_000_000),
        toolUseEvent(DRAFT_TOOL, ADD_INPUT, "tu-1", 1_000_100),
        draftResultEvent("tu-1", true, 1_000_200),
      ],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    };
    const newest = { events: [userEvent("later", 2_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true };
    const { renderer, container } = await makeRenderer({ newest, older });
    await renderer.fetchOlder();

    const cards = container.querySelectorAll(".msg.draft-card");
    expect(cards.length).toBe(1);
    expect(cards[0].dataset.draftId).toBe(DRAFT_ID);
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(0);
  });
});
