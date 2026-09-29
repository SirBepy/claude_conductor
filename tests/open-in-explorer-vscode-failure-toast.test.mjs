// Todo 1017: api.openInExplorer()/openInVSCode() swallowed a failed
// open_in_explorer/open_in_vscode call to a silent no-op (console.error only)
// - the user clicks and nothing visibly happens. Both now toast once inside
// api.ts (every caller - project-detail, characters - would otherwise want
// the same message, so it lives here rather than duplicated per caller).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invokeMock(...a) }));

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => toastMock(...a) }));

const { api } = await import("../src/shared/api.ts");

beforeEach(() => {
  invokeMock.mockReset();
  toastMock.mockReset();
});

describe("api.openInExplorer / openInVSCode - a failure is now visible", () => {
  it("openInExplorer toasts once on failure and does not throw", async () => {
    invokeMock.mockRejectedValue(new Error("no such path"));
    await expect(api.openInExplorer("C:/nope")).resolves.toBeUndefined();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatch(/folder/i);
  });

  it("openInExplorer does not toast on success", async () => {
    invokeMock.mockResolvedValue(undefined);
    await api.openInExplorer("C:/real");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("openInVSCode toasts once on failure and does not throw", async () => {
    invokeMock.mockRejectedValue(new Error("vscode not found"));
    await expect(api.openInVSCode("C:/nope")).resolves.toBeUndefined();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0][0]).toMatch(/vs code/i);
  });

  it("openInVSCode does not toast on success", async () => {
    invokeMock.mockResolvedValue(undefined);
    await api.openInVSCode("C:/real");
    expect(toastMock).not.toHaveBeenCalled();
  });
});
