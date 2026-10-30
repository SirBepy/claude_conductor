// @vitest-environment jsdom
// The draft composer awaits moveSpawnedChat inside the try that rolls a failed
// start_session back to a draft. If the lazy active-session import fails after
// the chat has spawned, that must show the failure toast, not throw into the
// rollback and discard a chat that is running.

import { describe, it, expect, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ moveSessionToAccount: vi.fn(async () => "moved-id") }));
vi.mock("../src/shared/api.ts", () => ({ api: apiMock }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => toast);
vi.mock("../src/shared/chat/rate-limit-banner.ts", () => ({
  capitalize: (s) => s,
  getCachedAccount: vi.fn(() => undefined),
}));
vi.mock("../src/views/sessions/active-session-account.ts", () => ({ applyAccountMove: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/active-session.ts", () => {
  throw new Error("chunk failed to load");
});

const { moveSpawnedChat } = await import("../src/views/sessions/pending-pane-spawn.ts");

describe("moveSpawnedChat when a lazy import fails", () => {
  it("resolves with the failure toast instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(moveSpawnedChat("sess-1", "acct-2", "Work", false)).resolves.toBeUndefined();

    expect(toast.showToast).toHaveBeenLastCalledWith("Failed to move chat to that account.");
  });
});
