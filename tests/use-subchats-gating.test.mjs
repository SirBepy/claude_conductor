// The in-memory half of "Use subchats": hydrate from the persisted list, flip
// optimistically, and roll back when the daemon refuses (API-credit chat).
import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));

const { hydrateSubchatsOn, isSubchatsOn, setSubchatsOn } = await import(
  "../src/views/sessions/permission-modal/gating.ts"
);

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  await hydrateSubchatsOn();
  invokeMock.mockReset();
});

describe("subchats gating", () => {
  it("hydrates from list_subchats_on", async () => {
    invokeMock.mockResolvedValueOnce(["a", "b"]);
    await hydrateSubchatsOn();
    expect(invokeMock).toHaveBeenCalledWith("list_subchats_on");
    expect(isSubchatsOn("a") && isSubchatsOn("b")).toBe(true);
    expect(isSubchatsOn("c")).toBe(false);
    expect(isSubchatsOn(null)).toBe(false);
  });

  it("sets and persists through set_subchats_on, on then off", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setSubchatsOn("s1", true);
    expect(invokeMock).toHaveBeenLastCalledWith("set_subchats_on", { sessionId: "s1", value: true });
    expect(isSubchatsOn("s1")).toBe(true);
    await setSubchatsOn("s1", false);
    expect(invokeMock).toHaveBeenLastCalledWith("set_subchats_on", { sessionId: "s1", value: false });
    expect(isSubchatsOn("s1")).toBe(false);
  });

  it("rolls the flip back and rethrows when the daemon refuses", async () => {
    invokeMock.mockRejectedValue("Subchats are not available on an API-credit account");
    await expect(setSubchatsOn("s2", true)).rejects.toContain("API-credit");
    expect(isSubchatsOn("s2")).toBe(false);
  });

  it("keeps a chat on when turning it off is refused", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setSubchatsOn("s3", true);
    invokeMock.mockRejectedValue("boom");
    await expect(setSubchatsOn("s3", false)).rejects.toBe("boom");
    expect(isSubchatsOn("s3")).toBe(true);
  });
});
