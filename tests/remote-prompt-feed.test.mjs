import { describe, it, expect, beforeEach, vi } from "vitest";
import { startPromptFeed } from "../src/views/sessions/permission-modal/remote-prompt-poll.ts";
import { GLOBAL_KEBAB_EVENTS } from "../src/shared/global-stream.ts";

// The phone shows a question or permission card from the frame the daemon pushes
// on the global stream, not from a poll tick; list_pending_prompts is the
// fallback for a lost frame and the only signal that a prompt was answered on
// the desktop. The daemon's 8s render-confirm window (question.rs) is why a
// card must not wait for a timer.

function setup(list = vi.fn(async () => [])) {
  const handlers = new Map();
  const cb = { onQuestion: vi.fn(), onPermission: vi.fn(), onSecret: vi.fn(), onResolved: vi.fn() };
  const feed = startPromptFeed({
    list,
    listen: async (event, h) => { handlers.set(event, h); },
    cb,
  });
  const frame = (event, payload) => handlers.get(event)(payload);
  return { feed, cb, list, frame, handlers };
}

const Q = { id: "q1", session_id: "s1", questions: [] };
const P = { id: "p1", session_id: "s1", tool_name: "Bash", input: {} };

describe("phone prompt feed", () => {
  beforeEach(() => vi.useFakeTimers());

  it("the daemon's prompt frames reach the page's event map under the desktop's event names", () => {
    for (const e of ["question-requested", "permission-requested", "secret-requested", "question-expired"]) {
      expect(GLOBAL_KEBAB_EVENTS.has(e)).toBe(true);
    }
  });

  it("raises a question card from its frame with no list_pending_prompts call", async () => {
    const { cb, list, frame } = setup();
    await vi.advanceTimersByTimeAsync(0);
    frame("question-requested", Q);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cb.onQuestion).toHaveBeenCalledWith(Q);
    expect(list).not.toHaveBeenCalled();
  });

  it("routes permission and secret frames to their own handlers", async () => {
    const { cb, frame } = setup();
    await vi.advanceTimersByTimeAsync(0);
    frame("permission-requested", P);
    frame("secret-requested", { id: "s9", session_id: "s1" });
    expect(cb.onPermission).toHaveBeenCalledWith(P);
    expect(cb.onSecret).toHaveBeenCalledTimes(1);
    expect(cb.onQuestion).not.toHaveBeenCalled();
  });

  it("a prompt the frame raised is not raised again by the fallback poll, and still open means no resolve", async () => {
    const list = vi.fn(async () => [{ id: "q1", event: "question-requested", payload: Q, durable: true }]);
    const { feed, cb, frame } = setup(list);
    await vi.advanceTimersByTimeAsync(0);
    frame("question-requested", Q);
    await feed.tick();
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
    expect(cb.onResolved).not.toHaveBeenCalled();
  });

  it("a prompt the poll raised is not raised again by its late frame", async () => {
    const list = vi.fn(async () => [{ id: "q1", event: "question-requested", payload: Q, durable: true }]);
    const { feed, cb, frame } = setup(list);
    await vi.advanceTimersByTimeAsync(0);
    await feed.tick();
    frame("question-requested", Q);
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
  });

  it("a prompt answered on the desktop leaves through the next poll", async () => {
    const list = vi.fn(async () => []);
    const { feed, cb, frame } = setup(list);
    await vi.advanceTimersByTimeAsync(0);
    frame("permission-requested", P);
    await feed.tick();
    expect(cb.onResolved).toHaveBeenCalledWith("p1", false);
  });

  it("question_expired resolves the card at once", async () => {
    const { cb, frame } = setup();
    await vi.advanceTimersByTimeAsync(0);
    frame("question-requested", Q);
    frame("question-expired", { session_id: "s1", id: "q1" });
    expect(cb.onResolved).toHaveBeenCalledWith("q1", true);
  });

  it("a snapshot requested before a frame landed cannot resolve the frame's card", async () => {
    let release;
    const list = vi.fn(() => new Promise((r) => { release = r; }));
    const { feed, cb, frame } = setup(list);
    await vi.advanceTimersByTimeAsync(0);
    const ticking = feed.tick();
    frame("question-requested", Q);
    release([]);
    await ticking;
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
    expect(cb.onResolved).not.toHaveBeenCalled();
  });

  it("a failed listen leaves the poll working", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = vi.fn(async () => [{ id: "q1", event: "question-requested", payload: Q, durable: true }]);
    const cb = { onQuestion: vi.fn(), onPermission: vi.fn(), onSecret: vi.fn(), onResolved: vi.fn() };
    const feed = startPromptFeed({ list, listen: () => { throw new Error("no stream"); }, cb });
    await vi.advanceTimersByTimeAsync(0);
    await feed.tick();
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
