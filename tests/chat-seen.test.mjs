// asserts: src/views/sessions/chat-seen.ts
// asserts: src/shared/chat/dashboard/answers-model.ts
//
// The chat heads' viewed marks (chat-seen.ts): the daemon keeps when Joe last had each chat on screen,
// so a view on one device clears a chat's purple and green badge on the others. This window keeps a
// copy: a view clears the badge here at once, the daemon's answer replaces the guess, and the list is
// read again now and then so a device that was offline catches up. Marks only ever move forward.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { toolUseEvent, userEvent } from "./helpers/chat-events.mjs";

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn(async () => ({})) }));

const seen = await import("../src/views/sessions/chat-seen.ts");
const { unreadAnswerCountFromEvents, unreadAnswerCount, emptyStore } = await import("../src/shared/chat/dashboard/answers-model.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));
/** A realistic clock: the mark gap counts from zero, so a tiny test time would sit inside it. */
const T = 1_800_000_000_000;

function fakeApi({ mark = async () => 0, list = async () => ({}) } = {}) {
  const api = { mark: vi.fn(mark), list: vi.fn(list) };
  seen.setSeenApi(api);
  return api;
}

describe("viewed marks", () => {
  beforeEach(() => {
    seen.onViewedChange(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("is never viewed until a mark is made", () => {
    fakeApi();
    expect(seen.viewedAtOf("a")).toBe(0);
  });

  it("marks at once from the local clock, then the daemon's own time replaces it", async () => {
    const api = fakeApi({ mark: async () => T + 5000 });
    seen.markViewed("a", T + 1000);
    expect(seen.viewedAtOf("a")).toBe(T + 1000);
    expect(api.mark).toHaveBeenCalledWith("a");
    await flush();
    expect(seen.viewedAtOf("a")).toBe(T + 5000);
  });

  it("does not send a call per render: a chat just marked is not marked again inside the gap", () => {
    const api = fakeApi();
    seen.markViewed("a", T + 1000);
    seen.markViewed("a", T + 1500);
    expect(api.mark).toHaveBeenCalledTimes(1);
    seen.markViewed("a", T + 3500);
    expect(api.mark).toHaveBeenCalledTimes(2);
  });

  it("leaving a chat marks it again at once, whatever the gap", () => {
    const api = fakeApi();
    seen.markViewed("a", T + 1000);
    seen.markViewed("a", T + 1100, true);
    expect(api.mark).toHaveBeenCalledTimes(2);
    expect(seen.viewedAtOf("a")).toBe(T + 1100);
  });

  it("a failed call keeps the local mark: the next view or list settles it", async () => {
    fakeApi({ mark: async () => { throw new Error("offline"); } });
    seen.markViewed("a", T + 1000);
    await flush();
    expect(seen.viewedAtOf("a")).toBe(T + 1000);
  });

  it("the list brings in another device's marks and only raises", async () => {
    const api = fakeApi({ list: async () => ({ a: T + 9000, b: T + 400 }) });
    seen.markViewed("b", T + 700);
    seen.refreshViewed(["a", "b"], T + 100_000);
    await flush();
    expect(api.list).toHaveBeenCalledWith(["a", "b"]);
    expect(seen.viewedAtOf("a")).toBe(T + 9000);
    expect(seen.viewedAtOf("b")).toBe(T + 700);
  });

  it("reads the list no faster than every few seconds, and not at all with no chats", async () => {
    const api = fakeApi();
    seen.refreshViewed([], T + 10_000);
    seen.refreshViewed(["a"], T + 10_000);
    await flush();
    seen.refreshViewed(["a"], T + 11_000);
    expect(api.list).toHaveBeenCalledTimes(1);
    seen.refreshViewed(["a"], T + 15_000);
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("an offline device retries the list at the next look and catches up", async () => {
    let up = false;
    const api = fakeApi({ list: async () => { if (!up) throw new Error("offline"); return { a: T + 7000 }; } });
    seen.refreshViewed(["a"], T + 10_000);
    await flush();
    expect(seen.viewedAtOf("a")).toBe(0);
    up = true;
    seen.refreshViewed(["a"], T + 10_500);
    expect(api.list).toHaveBeenCalledTimes(1);
    seen.refreshViewed(["a"], T + 14_500);
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(seen.viewedAtOf("a")).toBe(T + 7000);
  });

  it("tells the heads once when marks change, even for several in one go", async () => {
    fakeApi();
    const cb = vi.fn();
    seen.onViewedChange(cb);
    seen.markViewed("a", T + 1000);
    seen.markViewed("b", T + 1000);
    seen.markViewed("c", T + 1000);
    expect(cb).not.toHaveBeenCalled();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("unread answers after a viewed mark", () => {
  const SEND = "mcp__cc_conductor__send_message";
  const answer = (id, ts) => toolUseEvent(SEND, { kind: "answer", verdict: `Yes ${id}`, text: "Done." }, id, ts);
  const side = { store: emptyStore(), threads: [] };
  const events = [userEvent("q", T), answer("a1", T + 1000), answer("a2", T + 2000), answer("a3", T + 3000)];

  it("counts only the answers that came after the chat was last viewed", () => {
    expect(unreadAnswerCountFromEvents(events, side, T + 9000, 0)).toBe(3);
    expect(unreadAnswerCountFromEvents(events, side, T + 9000, T + 1000)).toBe(2);
    expect(unreadAnswerCountFromEvents(events, side, T + 9000, T + 2500)).toBe(1);
    expect(unreadAnswerCountFromEvents(events, side, T + 9000, T + 3000)).toBe(0);
  });

  it("a mark newer than every answer clears the count, and a chat never viewed keeps it", () => {
    expect(unreadAnswerCountFromEvents(events, side, T + 9000, T + 99_000)).toBe(0);
    expect(unreadAnswerCountFromEvents(events, side, T + 9000)).toBe(3);
  });

  it("counts rendered rows the same way", () => {
    const rows = [{ kind: "message", id: "a1", text: "x", ts: T + 1000, parentToolUseId: null, card: { kind: "answer", verdict: "Yes" } }];
    expect(unreadAnswerCount(rows, side, T + 9000, T + 500)).toBe(1);
    expect(unreadAnswerCount(rows, side, T + 9000, T + 1000)).toBe(0);
  });
});
