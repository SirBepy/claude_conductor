import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { setComposerDraft, clearComposerDraft, getSessionDrafts } = vi.hoisted(() => ({
  setComposerDraft: vi.fn(),
  clearComposerDraft: vi.fn(),
  getSessionDrafts: vi.fn(),
}));

vi.mock("../src/shared/chat/session-draft-sync.ts", () => ({
  setComposerDraft: (...a) => setComposerDraft(...a),
  clearComposerDraft: (...a) => clearComposerDraft(...a),
  getSessionDrafts: (...a) => getSessionDrafts(...a),
}));

const { ComposerDraftSync } = await import("../src/shared/chat/composer-draft-sync.ts");

beforeEach(() => {
  vi.useFakeTimers();
  setComposerDraft.mockReset().mockResolvedValue({ updated_at: "2026-08-13T00:00:01Z" });
  clearComposerDraft.mockReset().mockResolvedValue({ updated_at: "2026-08-13T00:00:02Z" });
  getSessionDrafts.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ComposerDraftSync - debounced push", () => {
  it("coalesces rapid keystrokes into one set_composer_draft call after 500ms", async () => {
    const sync = new ComposerDraftSync();
    sync.notifyTyped("s-debounce", "h");
    sync.notifyTyped("s-debounce", "he");
    sync.notifyTyped("s-debounce", "hel");
    sync.notifyTyped("s-debounce", "hello");
    expect(setComposerDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(setComposerDraft).toHaveBeenCalledTimes(1);
    expect(setComposerDraft).toHaveBeenCalledWith("s-debounce", "hello");
  });

  it("flush() sends the pending write immediately (blur / hidden path)", async () => {
    const sync = new ComposerDraftSync();
    sync.notifyTyped("s-flush", "mid-typing");
    expect(setComposerDraft).not.toHaveBeenCalled();

    sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(setComposerDraft).toHaveBeenCalledTimes(1);
    expect(setComposerDraft).toHaveBeenCalledWith("s-flush", "mid-typing");

    // The original 500ms timer must not also fire.
    await vi.advanceTimersByTimeAsync(1000);
    expect(setComposerDraft).toHaveBeenCalledTimes(1);
  });

  it("setSession() cancels a pending write for the outgoing session", async () => {
    const sync = new ComposerDraftSync();
    sync.notifyTyped("s-abandon", "abandoned");
    sync.setSession();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setComposerDraft).not.toHaveBeenCalled();
  });
});

describe("ComposerDraftSync - clear", () => {
  it("clear() cancels any pending push and calls clear_composer_draft", async () => {
    const sync = new ComposerDraftSync();
    sync.notifyTyped("s-clear", "typed then sent");
    await sync.clear("s-clear");
    expect(clearComposerDraft).toHaveBeenCalledWith("s-clear");
    await vi.advanceTimersByTimeAsync(1000);
    expect(setComposerDraft).not.toHaveBeenCalled();
  });
});

describe("ComposerDraftSync - reconcile (last-write-wins by server updated_at)", () => {
  it("returns remote text on first reconcile", async () => {
    getSessionDrafts.mockResolvedValue({
      composer: { text: "from another device", updated_at: "2026-08-13T00:00:05Z" },
      auq: null, held: [], held_updated_at: null,
    });
    const sync = new ComposerDraftSync();
    const text = await sync.reconcile("s-first-reconcile");
    expect(text).toBe("from another device");
  });

  it("returns null when the daemon has no composer draft", async () => {
    getSessionDrafts.mockResolvedValue({ composer: null, auq: null, held: [], held_updated_at: null });
    const sync = new ComposerDraftSync();
    expect(await sync.reconcile("s-empty")).toBeNull();
  });

  it("does not re-apply a remote draft no newer than what this instance already pushed", async () => {
    const sync = new ComposerDraftSync();
    // This instance pushes first, learning updated_at = ...01Z.
    sync.notifyTyped("s-echo", "mine");
    sync.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(setComposerDraft).toHaveBeenCalledTimes(1);

    // A reconcile call now sees a "remote" draft at or before that timestamp
    // (e.g. an echo of our own write) - must not be treated as fresher.
    getSessionDrafts.mockResolvedValue({
      composer: { text: "stale echo", updated_at: "2026-08-13T00:00:01Z" },
      auq: null, held: [], held_updated_at: null,
    });
    expect(await sync.reconcile("s-echo")).toBeNull();
  });

  it("degrades to null (never throws) when get_session_drafts fails", async () => {
    getSessionDrafts.mockRejectedValue(new Error("command not found"));
    const sync = new ComposerDraftSync();
    await expect(sync.reconcile("s-rpc-fail")).resolves.toBeNull();
  });

  // Regression for the "sent message reappears in the composer" bug: a
  // remounted Composer's fresh instance must still honor a version an
  // earlier instance already learned, not start from a blank baseline that
  // trusts any stale server read.
  it("a fresh instance still rejects a stale reconcile the previous instance's clear already superseded", async () => {
    const first = new ComposerDraftSync();
    await first.clear("s-remount"); // learns updated_at = ...02Z (the clear's own timestamp)

    // The remount: a brand-new instance, as if the Composer/pane was torn
    // down and rebuilt. A racy get_session_drafts response lands, echoing
    // the pre-clear draft with an older timestamp than the clear.
    const second = new ComposerDraftSync();
    getSessionDrafts.mockResolvedValue({
      composer: { text: "stale pre-clear text", updated_at: "2026-08-13T00:00:01Z" },
      auq: null, held: [], held_updated_at: null,
    });
    expect(await second.reconcile("s-remount")).toBeNull();
  });
});
