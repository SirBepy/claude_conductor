// Todo 1017: api.getAccountIdentity() swallowed a failed get_account_identity
// call and returned null - identical to the legitimate "no identity resolved"
// result. That value gates the Settings reauth CTA, so a failed read used to
// silently render as "nothing to reauth" instead of surfacing as a failure.
// Fix: let it reject; the caller (accounts.ts's refreshList) already has a
// try/catch around the Promise.all that now shows the error card.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { api } = await import("../src/shared/api.ts");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("api.getAccountIdentity - failure is no longer disguised as no identity", () => {
  it("rejects when the backend call fails, instead of resolving with null", async () => {
    invokeMock.mockRejectedValue(new Error("backend unreachable"));
    await expect(api.getAccountIdentity("acc-1")).rejects.toThrow("backend unreachable");
  });

  it("still resolves with the real identity on success", async () => {
    invokeMock.mockResolvedValue({
      oauthAccount: { emailAddress: "a@x.com", organizationType: "pro" },
      tokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      hasCookie: true,
      drift: false,
      driftMessage: null,
    });
    await expect(api.getAccountIdentity("acc-1")).resolves.toMatchObject({ hasCookie: true });
  });
});
