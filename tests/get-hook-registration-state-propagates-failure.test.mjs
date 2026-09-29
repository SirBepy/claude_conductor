// Todo 1001: api.getHookRegistrationState() swallowed a failed
// get_hook_registration_state call and returned {registered:false,
// declined:false, port:null} - identical to "never registered, never
// declined". That value gates the register-hooks onboarding nag (see
// boot.ts's maybeShowHookModal), so a failed read used to re-show or hide the
// nag as though the user had made no choice. Fix: let it reject; the caller
// now catches explicitly.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { api } = await import("../src/shared/api.ts");

beforeEach(() => {
  invokeMock.mockReset();
});

describe("api.getHookRegistrationState - failure is no longer disguised as a real state", () => {
  it("rejects when the backend call fails, instead of resolving with a plausible fallback", async () => {
    invokeMock.mockRejectedValue(new Error("backend unreachable"));
    await expect(api.getHookRegistrationState()).rejects.toThrow("backend unreachable");
  });

  it("still resolves with the real state on success", async () => {
    invokeMock.mockResolvedValue({ registered: true, declined: false, port: 4317 });
    await expect(api.getHookRegistrationState()).resolves.toEqual({
      registered: true, declined: false, port: 4317,
    });
  });
});
