// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Covers todo 895: a draft chat whose first message was sent but whose real
// session id never arrived (spawn died, response dropped, daemon rejected
// after firstMessageSent flipped) used to read busy forever -
// session-thinking-bar.ts's isCurrentSessionBusy had an unconditional
// `return true` in that branch with no exit. The normal case (id lands a
// moment later) must keep reading busy for that whole gap with no flicker.
describe("pending session busy read with no realId", () => {
  let mod;
  let state;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    state = (await import("../src/views/sessions/state.ts")).state;
    mod = await import("../src/views/sessions/session-thinking-bar.ts");
  });

  afterEach(() => {
    mod.initThinkingBar(null);
    vi.useRealTimers();
  });

  function mountAwaitingRealId(firstMessageSentAt) {
    state.pendingNewSession = {
      placeholderId: "pending-1",
      projectPath: "/project",
      projectName: "project",
      config: {},
      realId: null,
      firstMessageSent: true,
      preExistingSessionIds: new Set(),
      firstMessageSentAt,
    };
    state.selectedId = "pending-1";
    state.sessions = [];
  }

  it("stays busy for the normal in-flight gap right after sending", () => {
    mountAwaitingRealId(Date.now());
    expect(mod.isCurrentSessionBusy()).toBe(true);
  });

  it("stops reporting busy once the awaiting-realId gap goes stale", () => {
    mountAwaitingRealId(Date.now());
    // Past the point where a real spawn would plausibly still be starting.
    vi.advanceTimersByTime(120_001);
    expect(mod.isCurrentSessionBusy()).toBe(false);
  });

  it("still reads busy once a realId resolves, even long after the send", () => {
    mountAwaitingRealId(Date.now());
    vi.advanceTimersByTime(120_001);
    state.pendingNewSession.realId = "real-1";
    state.sessions = [{ session_id: "real-1", busy: true, awaiting: null }];
    expect(mod.isCurrentSessionBusy()).toBe(true);
  });
});
