// @vitest-environment jsdom
// show_preview cards through the real ChatRenderer, on BOTH paths: a re-push of
// a slug replaces its card in place (the tool's own promise), and a push the
// daemon refused never stays on screen as a blank frame. Driven through the
// renderer rather than the converters because the failure is path drift: a
// chat that is right live and stacks (or goes white) again after a reload.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { userEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/transport.ts", () => ({ getTransport: () => ({ listen: listenMock }), isRemote: () => false }));

const PREVIEW_TOOL = "mcp__cc_conductor__show_preview";
const REFUSAL = "relay error: HTTP 410 the card's iframe points at render id abc, which the daemon no longer holds";

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
    if (cmd === "list_channel_messages") return Promise.resolve({ messages: [] });
    // The staged page's url names the html it came from, so a card's frame can
    // be traced back to the push that fed it.
    if (cmd === "render_preview_doc") return Promise.resolve(`http://127.0.0.1:1/render/${/data-v="(\w+)"/.exec(args.html)?.[1]}`);
    if (cmd === "load_history_page") {
      return Promise.resolve(args && "beforeSeq" in args ? pages.older : pages.newest);
    }
    return Promise.resolve(undefined);
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const renderer = new ChatRenderer(container);
  await renderer.attach(`sess-preview-replace-${++_seq}`);
  await renderer.loadFromStore();
  return { renderer, container };
}

const EMPTY_PAGE = { events: [], oldest_seq: 1, newest_seq: 1, has_more: false };

const push = (id, slug, title, v, ts) =>
  toolUseEvent(PREVIEW_TOOL, { slug, title, html: `<p data-v="${v}">x</p>` }, id, ts);
const ok = (id, ts) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: "preview shown in chat" }, is_error: false, timestamp: ts });
const refused = (id, ts) => ({ type: "tool_result", tool_use_id: id, output: { type: "text", text: REFUSAL }, is_error: true, timestamp: ts });

const cardsOf = (container) => [...container.querySelectorAll(".msg.preview-card")];
const labels = (container) => cardsOf(container).map((c) => c.querySelector(".pc-label").textContent);
const framesOf = (container) => cardsOf(container).map((c) => c.querySelector(".pc-frame"));

/** Both paths are run on the same events: the first page is hydrated, the
 *  second arrives by scrolling up. */
const paths = {
  live: async (events) => {
    const { renderer, container } = await makeRenderer({ newest: EMPTY_PAGE, older: EMPTY_PAGE });
    for (const ev of events) renderer.handleEvent(ev);
    return container;
  },
  hydrate: async (events) => {
    const { container } = await makeRenderer({ newest: { events, oldest_seq: 1, newest_seq: 9, has_more: false }, older: EMPTY_PAGE });
    return container;
  },
  scrollback: async (events) => {
    const newest = { events: [userEvent("later", 9_000_000)], oldest_seq: 10, newest_seq: 12, has_more: true };
    const { renderer, container } = await makeRenderer({ newest, older: { events, oldest_seq: 1, newest_seq: 9, has_more: false } });
    await renderer.fetchOlder();
    return container;
  },
};

describe.each(Object.entries(paths))("%s path", (_name, run) => {
  it("replaces the card in place when the same slug is pushed again", async () => {
    const container = await run([
      userEvent("show me", 1_000_000),
      push("tu-1", "week", "First look", "one", 1_000_100),
      ok("tu-1", 1_000_150),
      userEvent("more", 1_000_200),
      push("tu-2", "week", "Second look", "two", 1_000_300),
      ok("tu-2", 1_000_350),
    ]);
    expect(labels(container)).toEqual(["Second look"]);
    await vi.waitFor(() => expect(framesOf(container)[0].getAttribute("src")).toBe("http://127.0.0.1:1/render/two"));
  });

  it("keeps a card per slug when the slugs differ", async () => {
    const container = await run([
      userEvent("show me", 1_000_000),
      push("tu-1", "week", "Week", "one", 1_000_100),
      ok("tu-1", 1_000_150),
      push("tu-2", "month", "Month", "two", 1_000_300),
      ok("tu-2", 1_000_350),
    ]);
    expect(labels(container)).toEqual(["Week", "Month"]);
  });

  it("shows a refused push as a reason, not a frame", async () => {
    const container = await run([
      userEvent("show me", 1_000_000),
      push("tu-1", "week", "Doomed", "one", 1_000_100),
      refused("tu-1", 1_000_150),
    ]);
    const cards = cardsOf(container);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".pc-frame")).toBeNull();
    expect(cards[0].querySelector(".pc-pop")).toBeNull();
    expect(cards[0].querySelector(".pc-label").textContent).toBe("Doomed");
    expect(cards[0].querySelector(".pc-failed").textContent).toContain("Preview was not accepted");
    expect(cards[0].querySelector(".pc-failed").textContent).toContain("HTTP 410");
    // Absorbed: the error text is not also a stray tool-result row.
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(0);
  });

  it("leaves the last accepted card on screen when a re-push is refused", async () => {
    const container = await run([
      userEvent("show me", 1_000_000),
      push("tu-1", "week", "Good", "one", 1_000_100),
      ok("tu-1", 1_000_150),
      push("tu-2", "week", "Bad retry", "two", 1_000_300),
      refused("tu-2", 1_000_350),
    ]);
    expect(labels(container)).toEqual(["Good"]);
    expect(cardsOf(container)[0].querySelector(".pc-failed")).toBeNull();
    await vi.waitFor(() => expect(framesOf(container)[0].getAttribute("src")).toBe("http://127.0.0.1:1/render/one"));
  });

  it("lets a good push replace a refused one", async () => {
    const container = await run([
      userEvent("show me", 1_000_000),
      push("tu-1", "week", "Doomed", "one", 1_000_100),
      refused("tu-1", 1_000_150),
      push("tu-2", "week", "Fixed", "two", 1_000_300),
      ok("tu-2", 1_000_350),
    ]);
    expect(labels(container)).toEqual(["Fixed"]);
    expect(cardsOf(container)[0].querySelector(".pc-failed")).toBeNull();
  });

  it("leaves an accepted push untouched", async () => {
    const container = await run([
      userEvent("show me", 1_000_000),
      push("tu-1", "week", "Fine", "one", 1_000_100),
      ok("tu-1", 1_000_150),
    ]);
    expect(labels(container)).toEqual(["Fine"]);
    expect(cardsOf(container)[0].querySelector(".pc-frame")).not.toBeNull();
    expect(cardsOf(container)[0].querySelector(".pc-pop")).not.toBeNull();
  });
});

describe("chats are independent", () => {
  it("does not touch another chat's card for the same slug", async () => {
    const a = await makeRenderer({ newest: EMPTY_PAGE, older: EMPTY_PAGE });
    const b = await makeRenderer({ newest: EMPTY_PAGE, older: EMPTY_PAGE });
    a.renderer.handleEvent(userEvent("a", 1_000_000));
    a.renderer.handleEvent(push("tu-1", "week", "In A", "one", 1_000_100));
    b.renderer.handleEvent(userEvent("b", 1_000_000));
    b.renderer.handleEvent(push("tu-2", "week", "In B", "two", 1_000_100));
    expect(labels(a.container)).toEqual(["In A"]);
    expect(labels(b.container)).toEqual(["In B"]);
  });
});

describe("a page fetched by scrolling up", () => {
  it("drops an older card whose slug a newer accepted card on screen already replaced", async () => {
    const newest = {
      events: [userEvent("later", 2_000_000), push("tu-2", "week", "Newer", "two", 2_000_100), ok("tu-2", 2_000_150)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    };
    const older = {
      events: [userEvent("first", 1_000_000), push("tu-1", "week", "Older", "one", 1_000_100), ok("tu-1", 1_000_150)],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    };
    const { renderer, container } = await makeRenderer({ newest, older });
    await renderer.fetchOlder();
    expect(labels(container)).toEqual(["Newer"]);
  });

  it("keeps an older card when the newer one on screen was refused", async () => {
    const newest = {
      events: [userEvent("later", 2_000_000), push("tu-2", "week", "Refused", "two", 2_000_100), refused("tu-2", 2_000_150)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    };
    const older = {
      events: [userEvent("first", 1_000_000), push("tu-1", "week", "Older", "one", 1_000_100), ok("tu-1", 1_000_150)],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    };
    const { renderer, container } = await makeRenderer({ newest, older });
    await renderer.fetchOlder();
    expect(labels(container)).toEqual(["Older", "Refused"]);
  });

  it("pairs a refusal that sits on the newer, already-rendered page with its push on this one", async () => {
    const newest = {
      events: [refused("tu-1", 2_000_150), userEvent("later", 2_000_200)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    };
    const older = {
      events: [userEvent("first", 1_000_000), push("tu-1", "week", "Doomed", "one", 1_000_100)],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    };
    const { renderer, container } = await makeRenderer({ newest, older });
    await renderer.fetchOlder();
    const cards = cardsOf(container);
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".pc-frame")).toBeNull();
    expect(cards[0].querySelector(".pc-failed").textContent).toContain("HTTP 410");
  });

  it("takes the stray error row off the newer page once the push it belongs to is paged in", async () => {
    const newest = {
      events: [refused("tu-1", 2_000_150), userEvent("later", 2_000_200)],
      oldest_seq: 10,
      newest_seq: 12,
      has_more: true,
    };
    const older = {
      events: [userEvent("first", 1_000_000), push("tu-1", "week", "Doomed", "one", 1_000_100)],
      oldest_seq: 1,
      newest_seq: 9,
      has_more: false,
    };
    const { renderer, container } = await makeRenderer({ newest, older });
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(1);
    await renderer.fetchOlder();
    expect(cardsOf(container)[0].querySelector(".pc-failed").textContent).toContain("HTTP 410");
    expect(container.querySelectorAll(".msg.tool-result").length).toBe(0);
  });
});
