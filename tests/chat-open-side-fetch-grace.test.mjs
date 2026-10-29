// @vitest-environment jsdom
//
// loadFromStore's skip-mark and channel-backlog fetches ride the daemon pipe,
// whose calls have no timeout. They used to sit in one Promise.all with the
// history page, so a stuck pipe left the chat blank however fast the page was.
// Now the transcript paints after a short grace, and a late answer that
// changes something re-renders it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent, finalEvent, toolUseEvent } from "./helpers/chat-events.mjs";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { ChatRenderer } = await import("../src/shared/chat/chat-renderer.ts");

const PAGE = {
  events: [userEvent("question", 0), finalEvent("answer", 1)],
  oldest_seq: 0,
  newest_seq: 1,
  has_more: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
});

describe("chat open with a stuck daemon pipe", () => {
  it("paints the transcript even when skip marks and the channel backlog never answer", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "load_history_page") return Promise.resolve(PAGE);
      if (cmd === "get_skipped_question_marks" || cmd === "list_channel_messages") {
        return new Promise(() => { /* wedged pipe */ });
      }
      return Promise.resolve(undefined);
    });
    const r = new ChatRenderer(document.createElement("div"));
    await r.attach(`sess-stuck-${Math.random()}`);

    await r.loadFromStore();

    expect(r.messages.map((m) => m.kind)).toEqual(["user", "assistant"]);
  });

  it("re-renders with the channel backlog once a late answer lands", async () => {
    let answerChannel;
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "load_history_page") return Promise.resolve(PAGE);
      if (cmd === "get_skipped_question_marks") return Promise.resolve([]);
      if (cmd === "list_channel_messages") return new Promise((res) => { answerChannel = res; });
      return Promise.resolve(undefined);
    });
    const r = new ChatRenderer(document.createElement("div"));
    await r.attach(`sess-late-${Math.random()}`);
    await r.loadFromStore();
    expect(r.channelMessages).toBeUndefined();

    const posts = [{ id: "p1", session_id: "peer", author: "peer", text: "hi", posted_at: "2026-10-29T00:00:00Z" }];
    answerChannel({ messages: posts });
    await vi.waitFor(() => expect(r.channelMessages).toEqual(posts));
    // The late answer is applied without fetching again.
    expect(invokeMock.mock.calls.filter(([c]) => c === "list_channel_messages")).toHaveLength(1);
  });
});

const ASK_TOOL = "mcp__cc_conductor__ask_user_question";
const ASK_PAGE = {
  events: [
    userEvent("start", 1_000),
    toolUseEvent(ASK_TOOL, { questions: [{ question: "Pick one?", header: "Choice" }] }, "q1", 1_100),
    { type: "tool_result", tool_use_id: "q1", output: { type: "text", text: '{"acknowledged":true}' }, is_error: false, timestamp: 1_150 },
  ],
  oldest_seq: 0,
  newest_seq: 2,
  has_more: false,
};

// pc-1474: a late answer used to rebuild the whole chat, which could race a load
// still hydrating or wipe the pages the user had since scrolled in.
describe("a late side-fetch answer is applied in place", () => {
  it("resolves the skipped card without rebuilding the transcript the user is looking at", async () => {
    let answerMarks;
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "load_history_page") return Promise.resolve(ASK_PAGE);
      if (cmd === "get_skipped_question_marks") return new Promise((res) => { answerMarks = res; });
      return Promise.resolve(undefined);
    });
    const container = document.createElement("div");
    const r = new ChatRenderer(container);
    await r.attach(`sess-late-skip-${Math.random()}`);
    const install = vi.spyOn(r.paginator, "install");
    await r.loadFromStore();
    const card = () => r.messages.find((m) => m.kind === "question");
    expect(card().text).toBeUndefined();

    // Stands in for an older page the user paged in: a rebuild empties the container.
    const olderPage = document.createElement("div");
    olderPage.className = "paged-in-older-page";
    container.prepend(olderPage);

    answerMarks([{ timestamp: 1_200, question_id: "q1" }]);
    await vi.waitFor(() => expect(card().text).toBeDefined());

    expect(container.querySelector(".paged-in-older-page")).toBe(olderPage);
    expect(install).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === "load_history_page")).toHaveLength(1);
  });

  it("leaves one transcript and installs once when the answer lands while the first load is still hydrating", async () => {
    let answerMarks;
    const events = [];
    for (let i = 0; i < 1500; i++) events.push(userEvent(`q${i}`, i * 2), finalEvent(`a${i}`, i * 2 + 1));
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "load_history_page") return Promise.resolve({ events, oldest_seq: 0, newest_seq: events.length, has_more: false });
      if (cmd === "get_skipped_question_marks") return new Promise((res) => { answerMarks = res; });
      return Promise.resolve(undefined);
    });
    const r = new ChatRenderer(document.createElement("div"));
    await r.attach(`sess-late-mid-${Math.random()}`);
    const install = vi.spyOn(r.paginator, "install");

    const loading = r.loadFromStore();
    // Past the 500ms grace the load carries on without the marks; answer them
    // as soon as that happens, whichever side of the hydrate it lands on.
    setTimeout(() => answerMarks([{ timestamp: 1, question_id: null }]), 520);
    await loading;
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(r.messages).toHaveLength(events.length);
    expect(install).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([c]) => c === "load_history_page")).toHaveLength(1);
  }, 20_000);
});
