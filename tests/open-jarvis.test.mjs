// @vitest-environment jsdom
// The sidemenu's Jarvis entry: desktop opens the dedicated Jarvis window, the
// phone get-or-spawns the singleton and opens it in the Chats view.

import { describe, it, expect, vi, beforeEach } from "vitest";

let remote = false;
vi.mock("../src/shared/transport.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isRemote: () => remote };
});

const invoke = vi.fn();
vi.mock("../src/shared/ipc.ts", () => ({ invoke: (...a) => invoke(...a) }));

const showView = vi.fn();
vi.mock("../src/shared/navigation.ts", () => ({ showView: (...a) => showView(...a) }));

const showToast = vi.fn();
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => showToast(...a) }));

const queueSessionSelect = vi.fn();
vi.mock("../src/views/sessions/session-controls.ts", () => ({
  queueSessionSelect: (...a) => queueSessionSelect(...a),
}));

const { openJarvis } = await import("../src/views/sessions/open-jarvis.ts");

beforeEach(() => {
  remote = false;
  invoke.mockReset();
  showView.mockReset();
  showToast.mockReset();
  queueSessionSelect.mockReset();
  delete window.__TAURI__;
});

describe("openJarvis", () => {
  it("on the phone, ensures the Jarvis session and opens it in the Chats view", async () => {
    remote = true;
    invoke.mockResolvedValueOnce({ session_id: "jarvis-1" });
    await openJarvis();
    expect(invoke).toHaveBeenCalledWith("ensure_jarvis_session");
    expect(queueSessionSelect).toHaveBeenCalledWith("jarvis-1");
    expect(showView).toHaveBeenCalledWith("sessions");
  });

  it("on the phone, a failed spawn shows a toast instead of a dead click", async () => {
    remote = true;
    invoke.mockRejectedValueOnce(new Error("no default account"));
    await expect(openJarvis()).rejects.toThrow("no default account");
    expect(showToast).toHaveBeenCalledWith("Couldn't open Jarvis: no default account");
    expect(showView).not.toHaveBeenCalled();
  });

  it("on desktop, opens the dedicated Jarvis window", async () => {
    window.__TAURI__ = {};
    invoke.mockResolvedValueOnce(undefined);
    await openJarvis();
    expect(invoke).toHaveBeenCalledWith("open_jarvis_window");
    expect(showView).not.toHaveBeenCalled();
  });
});
