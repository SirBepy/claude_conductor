// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { userEvent, assistantEvent } from "./helpers/chat-events.mjs";

// The phone persists each chat's newest history page, so a chat tapped after
// a reload paints before the tunnel answers load_history_page.

const remote = { value: true };
const invoke = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const page = (events, extra = {}) => ({
  events,
  oldest_seq: 100,
  newest_seq: 900,
  has_more: true,
  continues_from: null,
  ...extra,
});

/** A fresh module graph over the same localStorage: what a phone reload does. */
async function reload() {
  vi.resetModules();
  vi.doMock("../src/shared/transport.ts", async (orig) => ({
    ...(await orig()),
    isRemote: () => remote.value,
  }));
  const { sessionEvents } = await import("../src/shared/chat/event-store.ts");
  return sessionEvents;
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  remote.value = true;
});

describe("phone history page cache", () => {
  it("paints the stored page after a reload while the network never answers", async () => {
    invoke.mockResolvedValueOnce(page([userEvent("hi"), assistantEvent("hello")]));
    await (await reload()).loadInitial("s1");

    const store = await reload();
    invoke.mockReturnValue(new Promise(() => {}));
    const events = await store.loadInitial("s1");
    expect(events.map((e) => e.content[0].text)).toEqual(["hi", "hello"]);
    expect(store.hasMore("s1")).toBe(true);
    expect(store.historyLoadFailed("s1")).toBe(false);
  });

  it("appends only what is new when the fresh page overlaps the cached one", async () => {
    invoke.mockResolvedValueOnce(page([userEvent("hi"), assistantEvent("hello")]));
    await (await reload()).loadInitial("s1");

    const store = await reload();
    invoke.mockResolvedValueOnce(page([assistantEvent("hello"), userEvent("next"), assistantEvent("reply")]));
    const seen = [];
    store.subscribe("s1", (ev) => seen.push(ev.content[0].text));
    await store.loadInitial("s1");
    await vi.waitFor(() => expect(seen).toEqual(["next", "reply"]));
    expect(store.events("s1").map((e) => e.content[0].text)).toEqual(["hi", "hello", "next", "reply"]);
  });

  it("replaces a cache the fresh page shares nothing with and tells the tail watchers", async () => {
    invoke.mockResolvedValueOnce(page([userEvent("old")]));
    await (await reload()).loadInitial("s1");

    const store = await reload();
    invoke.mockResolvedValueOnce(page([userEvent("much later")], { oldest_seq: 5000 }));
    const tails = [];
    store.subscribeTranscriptTail("s1", (sigs) => tails.push(sigs));
    await store.loadInitial("s1");
    await vi.waitFor(() => expect(tails).toHaveLength(1));
    expect(store.events("s1").map((e) => e.content[0].text)).toEqual(["much later"]);
  });

  it("replaces the cache when only a later repeated message matches, since a gap sits before it", async () => {
    invoke.mockResolvedValueOnce(page([userEvent("start"), userEvent("ok")]));
    await (await reload()).loadInitial("s1");

    const store = await reload();
    invoke.mockResolvedValueOnce(page([assistantEvent("far later"), userEvent("ok"), assistantEvent("done")], { oldest_seq: 9000 }));
    const tails = [];
    store.subscribeTranscriptTail("s1", (sigs) => tails.push(sigs));
    await store.loadInitial("s1");
    await vi.waitFor(() => expect(tails).toHaveLength(1));
    expect(store.events("s1").map((e) => e.content[0].text)).toEqual(["far later", "ok", "done"]);
  });

  it("does not store an empty page", async () => {
    invoke.mockResolvedValueOnce(page([], { oldest_seq: 0, has_more: false }));
    await (await reload()).loadInitial("s1");
    expect(localStorage.getItem("cc_history_page_v1:s1")).toBeNull();
  });

  it("strips image blocks before storing", async () => {
    const withImage = {
      type: "user_message",
      content: [{ type: "text", text: "look" }, { type: "image", mime: "image/png", data: "A".repeat(50_000) }],
      timestamp: 0,
    };
    const toolImage = {
      type: "tool_result", tool_use_id: "t1", is_error: false, timestamp: 0,
      output: { type: "image", mime: "image/png", data: "B".repeat(50_000) },
    };
    invoke.mockResolvedValueOnce(page([withImage, toolImage]));
    await (await reload()).loadInitial("s1");
    const stored = JSON.parse(localStorage.getItem("cc_history_page_v1:s1"));
    expect(stored.events[0].content).toEqual([{ type: "text", text: "look" }]);
    expect(stored.events[1].output).toEqual({ type: "text", text: "[image]" });
  });

  it("keeps an elided image placeholder so the cached page can still lazy-load it", async () => {
    const elided = {
      type: "tool_result", tool_use_id: "t1", is_error: false, timestamp: 0,
      output: { type: "image", mime: "image/png", data: "" },
      output_truncated: true, full_seq: 4200, output_bytes: 1572864,
    };
    invoke.mockResolvedValueOnce(page([elided]));
    await (await reload()).loadInitial("s1");
    const stored = JSON.parse(localStorage.getItem("cc_history_page_v1:s1"));
    expect(stored.events[0].output).toEqual({ type: "image", mime: "image/png", data: "" });
    expect(stored.events[0].full_seq).toBe(4200);
  });

  it("does not store a page over the byte cap", async () => {
    invoke.mockResolvedValueOnce(page([assistantEvent("x".repeat(200_000))]));
    await (await reload()).loadInitial("big");
    expect(localStorage.getItem("cc_history_page_v1:big")).toBeNull();
  });

  it("keeps only the 8 most recent chats", async () => {
    const store = await reload();
    for (let i = 0; i < 10; i++) {
      invoke.mockResolvedValueOnce(page([userEvent(`m${i}`)]));
      await store.loadInitial(`c${i}`);
    }
    expect(localStorage.getItem("cc_history_page_v1:c0")).toBeNull();
    expect(localStorage.getItem("cc_history_page_v1:c1")).toBeNull();
    expect(localStorage.getItem("cc_history_page_v1:c9")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem("cc_history_page_v1_index"))).toHaveLength(8);
  });

  it("survives a quota error", async () => {
    const store = await reload();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    invoke.mockResolvedValueOnce(page([userEvent("hi")]));
    const events = await store.loadInitial("s1");
    spy.mockRestore();
    expect(events).toHaveLength(1);
  });

  it("never stores or reads pages on the desktop", async () => {
    remote.value = false;
    invoke.mockResolvedValueOnce(page([userEvent("hi")]));
    await (await reload()).loadInitial("s1");
    expect(localStorage.getItem("cc_history_page_v1:s1")).toBeNull();
  });
});
