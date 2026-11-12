// asserts: src/views/sessions/chat-menu-items.ts
// @vitest-environment jsdom
// The Subchats card menu's Close ends the sub through the app's own close path
// (clear_session, the one the row's Close session takes) and sends the sub no
// message: /close is not a command any more.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, stateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  stateMock: { sessions: [], renderer: null },
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: invokeMock }));
vi.mock("../src/shared/api.ts", () => ({ api: { playCharacterSlot: vi.fn(async () => undefined) } }));
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
vi.mock("../src/views/sessions/state.ts", () => ({ state: stateMock }));
vi.mock("../src/views/sessions/session-characters.ts", () => ({ characterForSession: () => null }));
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

const { buildSubCardItems } = await import("../src/views/sessions/chat-menu-items.ts");

function subCtx(overrides = {}) {
  return {
    subId: "sub-1",
    anchor: {},
    model: "sonnet",
    effort: "medium",
    queued: false,
    finished: false,
    busy: false,
    frozen: false,
    pinned: false,
    mirrored: false,
    open: () => {},
    latestPreview: async () => null,
    ...overrides,
  };
}

const closeItem = (ctx) => buildSubCardItems(ctx).find((i) => i.label === "Close");

describe("Subchats card menu: Close", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async () => undefined);
    stateMock.sessions = [{ session_id: "sub-1", subchat_of: "main", busy: false, ended_at: null }];
  });

  it("closes the sub through clear_session and sends it no message", async () => {
    await closeItem(subCtx()).run();
    expect(invokeMock).toHaveBeenCalledWith("clear_session", { sessionId: "sub-1" });
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "send_message")).toBe(false);
  });

  it("stays unavailable for a queued or mirrored sub", () => {
    expect(closeItem(subCtx({ queued: true })).run).toBeUndefined();
    expect(closeItem(subCtx({ mirrored: true })).run).toBeUndefined();
  });
});
