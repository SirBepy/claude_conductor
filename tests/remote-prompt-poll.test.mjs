import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  reconcilePendingPrompts,
  findPendingPromptsForSession,
} from "../src/views/sessions/permission-modal/remote-prompt-poll.ts";

// The phone had no way to learn about AskUserQuestion / permission prompts: the
// desktop got them via a Rust-side poll + Tauri events, but the phone's
// transport never polled list_pending_prompts. reconcilePendingPrompts is the
// JS demux that drives the phone poll, mirroring daemon_link.rs. Each stored
// prompt is { id, event, payload }.

function cbs() {
  return {
    onQuestion: vi.fn(),
    onPermission: vi.fn(),
    onResolved: vi.fn(),
  };
}

const QUESTION = { id: "q1", event: "question-requested", payload: { id: "q1", session_id: "s1", questions: [] } };
const PERMISSION = { id: "p1", event: "permission-requested", payload: { id: "p1", session_id: "s1", tool_name: "Bash", input: {} } };

describe("reconcilePendingPrompts", () => {
  let emitted;
  let cb;
  beforeEach(() => { emitted = new Map(); cb = cbs(); });

  it("surfaces a new question prompt once and marks it emitted", () => {
    reconcilePendingPrompts([QUESTION], emitted, cb);
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
    expect(cb.onQuestion).toHaveBeenCalledWith(QUESTION.payload);
    expect(emitted.has("q1")).toBe(true);
  });

  it("surfaces a new permission prompt", () => {
    reconcilePendingPrompts([PERMISSION], emitted, cb);
    expect(cb.onPermission).toHaveBeenCalledTimes(1);
    expect(cb.onPermission).toHaveBeenCalledWith(PERMISSION.payload);
  });

  it("does not re-emit a prompt still present on the next poll", () => {
    reconcilePendingPrompts([QUESTION], emitted, cb);
    reconcilePendingPrompts([QUESTION], emitted, cb);
    expect(cb.onQuestion).toHaveBeenCalledTimes(1);
    expect(cb.onResolved).not.toHaveBeenCalled();
  });

  it("fires onResolved exactly once when a prompt disappears", () => {
    reconcilePendingPrompts([QUESTION], emitted, cb);
    reconcilePendingPrompts([], emitted, cb);
    expect(cb.onResolved).toHaveBeenCalledTimes(1);
    expect(cb.onResolved).toHaveBeenCalledWith("q1", false);
    expect(emitted.has("q1")).toBe(false);
    // A further empty poll must not re-resolve it.
    reconcilePendingPrompts([], emitted, cb);
    expect(cb.onResolved).toHaveBeenCalledTimes(1);
  });

  it("ignores a non-array snapshot (network/parse hiccup)", () => {
    reconcilePendingPrompts(null, emitted, cb);
    reconcilePendingPrompts(undefined, emitted, cb);
    expect(cb.onQuestion).not.toHaveBeenCalled();
    expect(cb.onResolved).not.toHaveBeenCalled();
  });

  it("skips malformed entries (missing id / payload / unknown event)", () => {
    reconcilePendingPrompts([
      { event: "question-requested", payload: {} },       // no id
      { id: "x", event: "question-requested" },           // no payload
      { id: "y", event: "something-else", payload: {} },  // unknown event
    ], emitted, cb);
    expect(cb.onQuestion).not.toHaveBeenCalled();
    expect(cb.onPermission).not.toHaveBeenCalled();
    expect(emitted.size).toBe(0);
  });
});

// The bug: the parked-prompt Map is in-memory and per-window-realm, and the
// push path emits each id once, so a chats-window rebuild lost the card for
// good - transcript stuck on "awaiting answer", clicking it a silent no-op.
describe("findPendingPromptsForSession", () => {
  const OTHER = { id: "q2", event: "question-requested", payload: { id: "q2", session_id: "s2", questions: [] } };

  it("finds a question the daemon still holds for this session", () => {
    const found = findPendingPromptsForSession([QUESTION], "s1");
    expect(found).toEqual([{ kind: "question", id: "q1", payload: QUESTION.payload }]);
  });

  it("finds a permission prompt too", () => {
    const found = findPendingPromptsForSession([PERMISSION], "s1");
    expect(found).toEqual([{ kind: "permission", id: "p1", payload: PERMISSION.payload }]);
  });

  it("never returns another chat's prompt", () => {
    expect(findPendingPromptsForSession([OTHER], "s1")).toEqual([]);
    expect(findPendingPromptsForSession([QUESTION, OTHER], "s1")).toHaveLength(1);
  });

  it("is stateless - repeated calls keep returning the same open prompt", () => {
    expect(findPendingPromptsForSession([QUESTION], "s1")).toHaveLength(1);
    expect(findPendingPromptsForSession([QUESTION], "s1")).toHaveLength(1);
  });

  it("preserves snapshot order so the oldest waiter surfaces first", () => {
    const second = { id: "q9", event: "question-requested", payload: { id: "q9", session_id: "s1", questions: [] } };
    expect(findPendingPromptsForSession([QUESTION, second], "s1").map((r) => r.id)).toEqual(["q1", "q9"]);
  });

  it("returns nothing for a bad snapshot, empty session id, or malformed rows", () => {
    expect(findPendingPromptsForSession(null, "s1")).toEqual([]);
    expect(findPendingPromptsForSession([QUESTION], "")).toEqual([]);
    expect(findPendingPromptsForSession([
      { event: "question-requested", payload: { session_id: "s1" } }, // no id
      { id: "x", event: "question-requested" },                       // no payload
      { id: "y", event: "nope", payload: { session_id: "s1" } },      // unknown event
    ], "s1")).toEqual([]);
  });
});
