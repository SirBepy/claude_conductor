// @vitest-environment jsdom
// moveSpawnedChat is called by the draft composer from inside the try that
// rolls a failed start_session back to a draft. The chat has already spawned
// by then, so nothing in the move may throw out of it: a failure must surface
// as the failure toast, never as a rollback of a live chat.

import { describe, it, expect, vi, beforeEach } from "vitest";

const apiMock = vi.hoisted(() => ({ moveSessionToAccount: vi.fn(async () => "moved-id") }));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => toast);
vi.mock("../src/shared/chat/rate-limit-banner.ts", () => ({
  capitalize: (s) => s,
  getCachedAccount: vi.fn(() => ({ label: "LocalCacheLabel" })),
}));
const applyAccountMove = vi.fn(async () => {});
vi.mock("../src/views/sessions/active-session-account.ts", () => ({ applyAccountMove }));
vi.mock("../src/views/sessions/active-session.ts", () => ({ selectSession: vi.fn() }));

const { moveSpawnedChat } = await import("../src/views/sessions/pending-pane-spawn.ts");

beforeEach(() => {
  apiMock.moveSessionToAccount.mockClear();
  toast.showToast.mockClear();
  applyAccountMove.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("moveSpawnedChat", () => {
  it("moves the chat, announces the account and follows it to the new id", async () => {
    await moveSpawnedChat("sess-1", "acct-2", "Work", false);

    expect(apiMock.moveSessionToAccount).toHaveBeenCalledWith("sess-1", "acct-2");
    expect(toast.showToast).toHaveBeenCalledWith("Now on Work.");
    expect(applyAccountMove).toHaveBeenCalledWith("sess-1", "moved-id", expect.anything());
  });

  it("names a machine-aimed pick with no label generically, never from the local cache", async () => {
    await moveSpawnedChat("sess-1", "peer-acct", null, true);

    expect(toast.showToast).toHaveBeenCalledWith("Now on the other account.");
  });

  it("falls back to the local cache for a local pick with no label", async () => {
    await moveSpawnedChat("sess-1", "acct-2", null, false);

    expect(toast.showToast).toHaveBeenCalledWith("Now on LocalCacheLabel.");
  });

  it("resolves with the failure toast when the move itself fails", async () => {
    apiMock.moveSessionToAccount.mockRejectedValueOnce(new Error("daemon down"));

    await expect(moveSpawnedChat("sess-1", "acct-2", "Work", false)).resolves.toBeUndefined();

    expect(toast.showToast).toHaveBeenCalledWith("Failed to move chat to that account.");
    expect(applyAccountMove).not.toHaveBeenCalled();
  });
});
