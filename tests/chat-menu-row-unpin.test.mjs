// @vitest-environment jsdom
// A pinned sub's sidebar row right-click menu offers "Unpin from sidemenu";
// an ordinary chat's row menu does not.

import { describe, it, expect, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/views/sessions/permission-modal", () => ({
  isAutoAccept: () => false,
  setAutoAccept: () => {},
  autoAcceptParked: () => {},
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadHiddenSessions: () => new Set(),
  saveHiddenSessions: () => {},
}));
vi.mock("../src/shared/chat/message-filter-pref.ts", () => ({
  isRawViewEnabled: () => false,
  setRawViewEnabled: () => {},
}));
vi.mock("../src/views/sessions/sidebar.ts", () => ({ refreshSessions: vi.fn(async () => {}) }));
vi.mock("../src/views/sessions/state.ts", () => ({ state: { renderer: null } }));
vi.mock("../src/views/sessions/active-session-account.ts", () => ({
  changeCharacterForSession: vi.fn(),
  changeAccountForSession: vi.fn(),
}));
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({
  sendWithFailureRecovery: vi.fn(),
}));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { pushSynthetic: vi.fn(), removeSynthetic: vi.fn() },
}));

const { buildRowMenuBlock } = await import("../src/views/sessions/chat-menu.ts");

function baseCtx(overrides = {}) {
  return {
    kind: "live",
    sessionId: "sub-1",
    cwd: "C:/repo",
    pid: 123,
    readOnly: false,
    autoAcceptOn: false,
    isHidden: false,
    viewChanges: () => {},
    ...overrides,
  };
}

const labels = (block) => [...block.querySelectorAll("button")].map((b) => b.textContent.trim());
const unpinBtn = (block) =>
  [...block.querySelectorAll("button")].find((b) => b.textContent.includes("Unpin from sidemenu"));

describe("sidebar row menu: Unpin from sidemenu", () => {
  it("a pinned sub's row shows it and clicking calls set_sub_pinned with false", async () => {
    const closeMenu = vi.fn();
    const block = buildRowMenuBlock(baseCtx({ isSub: true, isPinned: true }), closeMenu);
    const btn = unpinBtn(block);
    expect(btn, labels(block).join(" | ")).toBeTruthy();
    btn.click();
    expect(closeMenu).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_sub_pinned", { sessionId: "sub-1", pinned: false }),
    );
  });

  it("an ordinary chat's row does not show it", () => {
    expect(unpinBtn(buildRowMenuBlock(baseCtx(), () => {}))).toBeUndefined();
  });

  it("an unpinned sub's row does not show it", () => {
    expect(unpinBtn(buildRowMenuBlock(baseCtx({ isSub: true, isPinned: false }), () => {}))).toBeUndefined();
  });
});
