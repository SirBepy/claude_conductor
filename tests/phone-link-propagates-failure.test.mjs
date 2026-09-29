// Todo 1017: api.phoneLink() swallowed a failed phone_link call and returned
// null - identical to the legitimate "no phone link yet" result, so a copy-
// link click could not tell "unavailable" from "the read failed". Fix: let it
// reject; the caller (session-detail.ts's phone action) already has a
// try/catch that shows a distinct "phone failed: ..." toast on rejection.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { api } = await import("../src/shared/api.ts");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("api.phoneLink - failure is no longer disguised as no link yet", () => {
  it("rejects when the backend call fails, instead of resolving with null", async () => {
    invokeMock.mockRejectedValue(new Error("backend unreachable"));
    await expect(api.phoneLink("sess-1")).rejects.toThrow("backend unreachable");
  });

  it("still resolves with null when there genuinely is no link yet", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(api.phoneLink("sess-1")).resolves.toBeNull();
  });

  it("still resolves with the real URL on success", async () => {
    invokeMock.mockResolvedValue("https://example.test/phone/sess-1");
    await expect(api.phoneLink("sess-1")).resolves.toBe("https://example.test/phone/sess-1");
  });
});
