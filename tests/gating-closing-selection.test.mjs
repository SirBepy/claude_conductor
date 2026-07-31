import { describe, it, expect, beforeEach } from "vitest";
import {
  isForSelectedSession,
  setSelectedSessionId,
  storePendingPrompt,
  takePendingPrompt,
  pendingPromptSessionIds,
  clearPendingPrompt,
} from "../src/views/sessions/permission-modal/gating.ts";
import { state } from "../src/views/sessions/state.ts";

// Regression for the AUQ-card-bleed bug: since commit a3ef1d1a made `closing`
// a daemon-registry flag broadcast to EVERY window, isForSelectedSession's old
// `closing`-flag bypass fired in every window for ANY session running
// /close, admitting that session's question/permission card into whichever
// chat happened to be on screen. The fix removes the bypass so a closing
// session follows the same park/replay path as any other non-selected chat.

describe("isForSelectedSession vs the closing flag", () => {
  beforeEach(() => {
    state.sessions = [];
    state.selectedId = null;
    state.pendingNewSession = null;
    setSelectedSessionId(null);
    clearPendingPrompt("sess-A");
    clearPendingPrompt("sess-B");
  });

  it("returns false for a closing, non-selected session (red against the old bypass)", () => {
    state.sessions = [
      { session_id: "sess-A", closing: true },
      { session_id: "sess-B", closing: false },
    ];
    setSelectedSessionId("sess-B");
    expect(isForSelectedSession("sess-A")).toBe(false);
  });

  it("returns true for the actually-selected session, closing or not", () => {
    state.sessions = [{ session_id: "sess-B", closing: true }];
    setSelectedSessionId("sess-B");
    expect(isForSelectedSession("sess-B")).toBe(true);
  });

  it("returns false for an unknown session id", () => {
    setSelectedSessionId("sess-B");
    expect(isForSelectedSession("sess-unknown")).toBe(false);
  });

  it("a closing session's prompt still parks (and replays) instead of being dropped or surfaced inline", () => {
    state.sessions = [
      { session_id: "sess-A", closing: true },
      { session_id: "sess-B", closing: false },
    ];
    setSelectedSessionId("sess-B");
    expect(isForSelectedSession("sess-A")).toBe(false);

    storePendingPrompt("sess-A", {
      kind: "question",
      payload: { id: "q-1", questions: { question: "Proceed?" }, session_id: "sess-A" },
    });
    expect(pendingPromptSessionIds().has("sess-A")).toBe(true);

    const taken = takePendingPrompt("sess-A");
    expect(taken.kind).toBe("question");
    expect(taken.payload.id).toBe("q-1");
    // Consumed exactly once - the attention marker clears on replay.
    expect(pendingPromptSessionIds().has("sess-A")).toBe(false);
  });
});
