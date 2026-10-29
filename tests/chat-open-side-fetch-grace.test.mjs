// @vitest-environment jsdom
//
// loadFromStore's skip-mark and channel-backlog fetches ride the daemon pipe,
// whose calls have no timeout. They used to sit in one Promise.all with the
// history page, so a stuck pipe left the chat blank however fast the page was.
// Now the transcript paints after a short grace, and a late answer that
// changes something re-renders it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent, finalEvent } from "./helpers/chat-events.mjs";

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
    // The rebuild reused the late answer instead of fetching again.
    expect(invokeMock.mock.calls.filter(([c]) => c === "list_channel_messages")).toHaveLength(1);
  });
});
