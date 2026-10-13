// The per-session prompt queue behind permission-modal's sibling-question
// and secret-request queues: FIFO per session, deduped by id, sessions
// independent, and promote hands the oldest entry to the dispatch fn.

import { describe, it, expect, vi } from "vitest";

const { createPromptQueue } = await import("../src/views/sessions/permission-modal/prompt-queue.ts");

describe("createPromptQueue", () => {
  it("promotes in arrival order, one per call, then stops", () => {
    const dispatch = vi.fn();
    const q = createPromptQueue(dispatch);
    q.push("s1", { id: "a" });
    q.push("s1", { id: "b" });
    q.promote("s1");
    q.promote("s1");
    q.promote("s1");
    expect(dispatch.mock.calls.map((c) => c[0].id)).toEqual(["a", "b"]);
  });

  it("ignores a second push of an id already queued", () => {
    const dispatch = vi.fn();
    const q = createPromptQueue(dispatch);
    q.push("s1", { id: "a" });
    q.push("s1", { id: "a" });
    q.promote("s1");
    q.promote("s1");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps each session's queue separate", () => {
    const dispatch = vi.fn();
    const q = createPromptQueue(dispatch);
    q.push("s1", { id: "a" });
    q.push("s2", { id: "b" });
    q.promote("s2");
    expect(dispatch.mock.calls.map((c) => c[0].id)).toEqual(["b"]);
  });

  it("takeById removes only that entry and leaves order intact", () => {
    const dispatch = vi.fn();
    const q = createPromptQueue(dispatch);
    q.push("s1", { id: "a" });
    q.push("s1", { id: "b" });
    q.push("s1", { id: "c" });
    expect(q.takeById("s1", "b")).toEqual({ id: "b" });
    expect(q.takeById("s1", "b")).toBeNull();
    expect(q.takeById("s9", "a")).toBeNull();
    q.promote("s1");
    q.promote("s1");
    expect(dispatch.mock.calls.map((c) => c[0].id)).toEqual(["a", "c"]);
  });

  it("a fully drained session can be queued again", () => {
    const dispatch = vi.fn();
    const q = createPromptQueue(dispatch);
    q.push("s1", { id: "a" });
    expect(q.takeById("s1", "a")).toEqual({ id: "a" });
    q.push("s1", { id: "a" });
    q.promote("s1");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
