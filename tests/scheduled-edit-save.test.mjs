// @vitest-environment jsdom

// Saving an edited scheduled message must never blank the pending item's
// prompt: an attachment-only draft has no text block, so it throws (the
// composer then keeps the draft and the edit bar) instead of updating.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, toastMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), toastMock: vi.fn() }));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));

const { saveScheduledEdit } = await import("../src/views/sessions/scheduled-edit-save.ts");

const ITEM = { id: "s1", prompt: "old", fire_at: 1_900_000_000, status: { type: "pending" }, recurrence: null };

beforeEach(() => {
  invokeMock.mockReset();
  toastMock.mockReset();
  invokeMock.mockImplementation(async (cmd) => (cmd === "schedule_list" ? [ITEM] : undefined));
});

describe("saveScheduledEdit", () => {
  it("writes the new text onto the pending item", async () => {
    await saveScheduledEdit(ITEM, [{ type: "text", text: "new words" }]);
    expect(invokeMock).toHaveBeenCalledWith("schedule_update", { item: { ...ITEM, prompt: "new words" } });
  });

  it("refuses an attachment-only draft, keeping the prompt and telling Joe", async () => {
    const blocks = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }];
    await expect(saveScheduledEdit(ITEM, blocks)).rejects.toThrow();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "schedule_update")).toBe(false);
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a whitespace-only draft the same way", async () => {
    await expect(saveScheduledEdit(ITEM, [{ type: "text", text: "  \n " }])).rejects.toThrow();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "schedule_update")).toBe(false);
  });

  it("refuses when the item already fired", async () => {
    invokeMock.mockImplementation(async (cmd) => (cmd === "schedule_list" ? [{ ...ITEM, status: { type: "sent" } }] : undefined));
    await expect(saveScheduledEdit(ITEM, [{ type: "text", text: "x" }])).rejects.toThrow();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "schedule_update")).toBe(false);
  });

  it("tells the composer the item is gone (so it leaves edit mode), not a retryable failure", async () => {
    const { ScheduledEditGoneError } = await import("../src/shared/chat/scheduled-edit-gone.ts");
    invokeMock.mockImplementation(async (cmd) => (cmd === "schedule_list" ? [] : undefined));
    await expect(saveScheduledEdit(ITEM, [{ type: "text", text: "x" }])).rejects.toBeInstanceOf(ScheduledEditGoneError);
  });
});
