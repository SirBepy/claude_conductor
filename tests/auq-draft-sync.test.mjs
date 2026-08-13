// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setAuqDraft = vi.fn();
const clearAuqDraft = vi.fn();
const getSessionDrafts = vi.fn();

vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  setAuqDraft: (...a) => setAuqDraft(...a),
  clearAuqDraft: (...a) => clearAuqDraft(...a),
  getSessionDrafts: (...a) => getSessionDrafts(...a),
}));

const { scheduleAuqPush, flushAuqPush, cancelAuqPush, clearAuqPush, fetchRemoteAuqDraft } = await import(
  "../src/views/sessions/permission-modal/auq-draft-sync.ts"
);

function draft(overrides = {}) {
  return {
    freeText: new Map([[0, "typed"]]),
    selections: new Map(),
    activeTab: 0,
    additionalMessage: "",
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  setAuqDraft.mockReset().mockResolvedValue({ updated_at: "t" });
  clearAuqDraft.mockReset().mockResolvedValue({ cleared: true });
  getSessionDrafts.mockReset();
  cancelAuqPush(); // module-level debounce - reset between tests
});

afterEach(() => {
  cancelAuqPush();
  vi.useRealTimers();
});

describe("AUQ draft sync - debounced push", () => {
  it("coalesces rapid draft changes into one set_auq_draft call", async () => {
    scheduleAuqPush("s1", "p1", draft({ freeText: new Map([[0, "t"]]) }));
    scheduleAuqPush("s1", "p1", draft({ freeText: new Map([[0, "ty"]]) }));
    scheduleAuqPush("s1", "p1", draft({ freeText: new Map([[0, "typed"]]) }));
    expect(setAuqDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(setAuqDraft).toHaveBeenCalledTimes(1);
    const [sid, promptId, payload] = setAuqDraft.mock.calls[0];
    expect(sid).toBe("s1");
    expect(promptId).toBe("p1");
    expect(payload.freeText).toEqual([[0, "typed"]]);
  });

  it("no-ops when sessionId is undefined", async () => {
    scheduleAuqPush(undefined, "p1", draft());
    await vi.advanceTimersByTimeAsync(1000);
    expect(setAuqDraft).not.toHaveBeenCalled();
  });

  it("flushAuqPush sends immediately, bypassing the wait (visibilitychange hidden)", async () => {
    scheduleAuqPush("s1", "p1", draft());
    flushAuqPush();
    await vi.advanceTimersByTimeAsync(0);
    expect(setAuqDraft).toHaveBeenCalledTimes(1);
  });
});

describe("AUQ draft sync - clear (submit/cancel only)", () => {
  it("clearAuqPush cancels any pending push and calls clear_auq_draft", async () => {
    scheduleAuqPush("s1", "p1", draft());
    await clearAuqPush("s1", "p1");
    expect(clearAuqDraft).toHaveBeenCalledWith("s1", "p1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(setAuqDraft).not.toHaveBeenCalled();
  });

  it("cancelAuqPush drops a pending push without a server call (prompt resolved elsewhere)", async () => {
    scheduleAuqPush("s1", "p1", draft());
    cancelAuqPush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setAuqDraft).not.toHaveBeenCalled();
    expect(clearAuqDraft).not.toHaveBeenCalled();
  });
});

describe("AUQ draft sync - reconcile on card open", () => {
  it("returns the remote draft when the daemon's prompt id matches", async () => {
    getSessionDrafts.mockResolvedValue({
      composer: null,
      auq: { prompt_id: "p1", payload: { freeText: [[0, "from daemon"]], selections: [], activeTab: 0 }, updated_at: "t" },
      held: [],
      held_updated_at: null,
    });
    const remote = await fetchRemoteAuqDraft("s1", "p1");
    expect(remote?.freeText.get(0)).toBe("from daemon");
  });

  it("returns null when the daemon's draft belongs to a superseded prompt", async () => {
    getSessionDrafts.mockResolvedValue({
      composer: null,
      auq: { prompt_id: "OLDER-PROMPT", payload: {}, updated_at: "t" },
      held: [],
      held_updated_at: null,
    });
    expect(await fetchRemoteAuqDraft("s1", "p1")).toBeNull();
  });

  it("returns null (never throws) when get_session_drafts fails", async () => {
    getSessionDrafts.mockRejectedValue(new Error("command not found"));
    await expect(fetchRemoteAuqDraft("s1", "p1")).resolves.toBeNull();
  });

  it("returns null when there is no session id", async () => {
    expect(await fetchRemoteAuqDraft(undefined, "p1")).toBeNull();
    expect(getSessionDrafts).not.toHaveBeenCalled();
  });
});
