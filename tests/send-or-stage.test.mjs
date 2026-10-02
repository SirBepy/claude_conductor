// @vitest-environment jsdom
//
// sendOrStage is the shared "busy -> stage, held queue has items -> flush,
// else hand off to the caller's own send" policy extracted from drafts-revise
// and preview-panel-composer (ai_todo 1050). isCurrentSessionBusy is mocked
// one level below the helper, same pattern as drafts-revise.test.mjs mocking
// sendWithFailureRecovery - a module cannot observe a mock of its own export.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { isCurrentSessionBusyMock } = vi.hoisted(() => ({
  isCurrentSessionBusyMock: vi.fn(),
}));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({
  isCurrentSessionBusy: (...a) => isCurrentSessionBusyMock(...a),
}));

const { sendOrStage } = await import("../src/views/sessions/send-or-stage.ts");
const { state } = await import("../src/views/sessions/state.ts");

function textBlocks(s) {
  return [{ type: "text", text: s }];
}

describe("sendOrStage", () => {
  const priorHeld = state.heldMessages;

  beforeEach(() => {
    isCurrentSessionBusyMock.mockReset().mockReturnValue(false);
  });

  it("stages when the active session is busy, and never calls send", async () => {
    isCurrentSessionBusyMock.mockReturnValue(true);
    const stage = vi.fn();
    state.heldMessages = { stage, hasItemsForActive: () => false };
    const send = vi.fn();

    const result = await sendOrStage(textBlocks("hi"), send);

    expect(result).toBe("staged");
    expect(stage).toHaveBeenCalledWith(textBlocks("hi"));
    expect(send).not.toHaveBeenCalled();
    state.heldMessages = priorHeld;
  });

  it("flushes with the draft when the held queue already has items, and never calls send", async () => {
    isCurrentSessionBusyMock.mockReturnValue(false);
    const flushHeldWithDraft = vi.fn().mockResolvedValue(true);
    state.heldMessages = { hasItemsForActive: () => true, flushHeldWithDraft };
    const send = vi.fn();

    const result = await sendOrStage(textBlocks("hi"), send);

    expect(result).toBe("flushed");
    expect(flushHeldWithDraft).toHaveBeenCalledWith(textBlocks("hi"));
    expect(send).not.toHaveBeenCalled();
    state.heldMessages = priorHeld;
  });

  it("calls the caller's send when idle and the held queue is empty", async () => {
    isCurrentSessionBusyMock.mockReturnValue(false);
    state.heldMessages = { hasItemsForActive: () => false };
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await sendOrStage(textBlocks("hi"), send);

    expect(result).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    state.heldMessages = priorHeld;
  });

  it("checkActive:false bypasses both checks even when the active session is busy", async () => {
    isCurrentSessionBusyMock.mockReturnValue(true);
    const stage = vi.fn();
    state.heldMessages = { stage, hasItemsForActive: () => true, flushHeldWithDraft: vi.fn() };
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await sendOrStage(textBlocks("hi"), send, { checkActive: false });

    expect(result).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
    state.heldMessages = priorHeld;
  });

  it("logs instead of throwing when flushHeldWithDraft rejects", async () => {
    isCurrentSessionBusyMock.mockReturnValue(false);
    const err = new Error("boom");
    const flushHeldWithDraft = vi.fn().mockRejectedValue(err);
    state.heldMessages = { hasItemsForActive: () => true, flushHeldWithDraft };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.fn();

    const result = await sendOrStage(textBlocks("hi"), send);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());

    expect(result).toBe("flushed");
    expect(send).not.toHaveBeenCalled();
    spy.mockRestore();
    state.heldMessages = priorHeld;
  });
});
