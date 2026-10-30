// @vitest-environment jsdom

// The Chats window is the app's one desktop window. Two duties used to belong
// to the retired "main" window and silently went unowned: the renderer-crash
// heartbeat (gated on label "main") and the daemon disconnected/reconnected
// toasts (gated on NOT chats-window-mode). Prove the Chats window owns both now.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { onDaemonStatusMock, showToastMock } = vi.hoisted(() => ({
  onDaemonStatusMock: vi.fn(),
  showToastMock: vi.fn(),
}));
vi.mock("../src/shared/api.ts", () => ({ api: { onDaemonStatus: (cb) => onDaemonStatusMock(cb) } }));
vi.mock("../src/shared/toast.ts", () => ({ showToast: (...a) => showToastMock(...a) }));

const { runsRendererHeartbeat, ownsAppToasts, isChatsWindow, CHATS_WINDOW_MODE_CLASS, CHATS_WINDOW_LABEL } = await import(
  "../src/shared/window-roles.ts"
);
const { wireDaemonStatusToasts } = await import("../src/shared/daemon-status-toast.ts");

beforeEach(() => {
  onDaemonStatusMock.mockReset();
  showToastMock.mockReset();
});

describe("renderer heartbeat ownership", () => {
  it("is the Chats window and nothing else", () => {
    expect(CHATS_WINDOW_LABEL).toBe("session-chats");
    expect(runsRendererHeartbeat("session-chats")).toBe(true);
    expect(runsRendererHeartbeat("main")).toBe(false);
    expect(runsRendererHeartbeat("session-schedule")).toBe(false);
    expect(runsRendererHeartbeat("session-code")).toBe(false);
    expect(runsRendererHeartbeat(undefined)).toBe(false);
  });
});

describe("isChatsWindow", () => {
  it("follows the body class main.ts sets for the Chats window", () => {
    document.body.className = "";
    expect(isChatsWindow()).toBe(false);
    document.body.classList.add("detached-mode");
    expect(isChatsWindow()).toBe(false);
    document.body.classList.add(CHATS_WINDOW_MODE_CLASS);
    expect(isChatsWindow()).toBe(true);
    document.body.className = "";
  });

  it("uses the class base.css styles the Chats window by", () => {
    expect(CHATS_WINDOW_MODE_CLASS).toBe("chats-window-mode");
  });
});

describe("app toast ownership", () => {
  it("belongs to the Chats window on desktop", () => {
    expect(ownsAppToasts(true, false)).toBe(true);
  });

  it("belongs to a browser or phone client, which has no Chats window", () => {
    expect(ownsAppToasts(false, true)).toBe(true);
  });

  it("does not belong to any other desktop window", () => {
    expect(ownsAppToasts(false, false)).toBe(false);
  });
});

describe("daemon status toasts", () => {
  function fire(ownsToasts, ...statuses) {
    wireDaemonStatusToasts(ownsToasts);
    const handler = onDaemonStatusMock.mock.calls[0][0];
    for (const connected of statuses) handler({ connected });
  }

  it("the owning window toasts the drop and the recovery", () => {
    fire(true, false, true);
    expect(showToastMock.mock.calls.map((c) => c[0])).toEqual([
      "Daemon disconnected - reconnecting...",
      "Daemon reconnected.",
    ]);
  });

  it("a non-owning window shows nothing", () => {
    fire(false, false, true);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("does not announce a reconnect that never followed a drop", () => {
    fire(true, true);
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
