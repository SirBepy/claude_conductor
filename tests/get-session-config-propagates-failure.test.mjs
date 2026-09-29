// Todo 1001: api.getSessionConfig() swallowed a failed get_session_config call
// and returned null - identical to the legitimate "no config recorded"
// result. That value feeds a scheduled chat's model/effort inheritance (see
// session-detail.ts's enrichHistorical), so a failed read used to silently
// fall back to defaults instead of surfacing as a failure. Fix: let it
// reject; the caller already has a try/catch that falls back to the
// transcript-derived model on rejection.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { api } = await import("../src/shared/api.ts");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("api.getSessionConfig - failure is no longer disguised as an empty config", () => {
  it("rejects when the backend call fails, instead of resolving with null", async () => {
    invokeMock.mockRejectedValue(new Error("backend unreachable"));
    await expect(api.getSessionConfig("sess-1")).rejects.toThrow("backend unreachable");
  });

  it("still resolves with null when the backend genuinely has no config recorded", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(api.getSessionConfig("sess-1")).resolves.toBeNull();
  });

  it("still resolves with the real config on success", async () => {
    invokeMock.mockResolvedValue({ model: "opus", effort: "high" });
    await expect(api.getSessionConfig("sess-1")).resolves.toEqual({ model: "opus", effort: "high" });
  });
});
