// G10 follow-up (docs/multi-machine.md): a chat mirrored from a paired peer
// machine now proxies Code mode's reads to the owning peer, so "View changes"
// (which opens Code mode) must stay enabled for one - only the items that
// launch THIS machine's own apps against `cwd` (VS Code / Terminal / File
// Explorer) stay disabled, since open-in-editor/explorer were never meant to
// be proxied (CLAUDE.md's "keep open-in-editor / open-in-explorer hidden").

import { describe, it, expect, vi } from "vitest";

const { isRemoteMock } = vi.hoisted(() => ({ isRemoteMock: vi.fn(() => false) }));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: isRemoteMock }));
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

const { buildOpenProjectItems, buildChatItems } = await import(
  "../src/views/sessions/chat-menu-items.ts"
);

function baseCtx(overrides = {}) {
  return {
    kind: "live",
    sessionId: "sess-1",
    cwd: "C:/repo",
    pid: 123,
    readOnly: false,
    autoAcceptOn: false,
    isHidden: false,
    viewChanges: () => {},
    ...overrides,
  };
}

describe("chat-menu-items for a chat mirrored from a paired peer machine", () => {
  it("keeps View changes (Code mode) enabled when mirrored - its reads now proxy to the owning peer", () => {
    const viewChanges = vi.fn();
    const items = buildChatItems(baseCtx({ mirrored: true, viewChanges }));
    const item = items.find((i) => i.label === "View changes");
    expect(item.run).toBeTypeOf("function");
    expect(item.disabledReason).toBeUndefined();

    item.run();
    expect(viewChanges).toHaveBeenCalledTimes(1);
  });

  it("View changes is unaffected by mirrored either way - same enabled state as a local chat", () => {
    const local = buildChatItems(baseCtx({ mirrored: false })).find((i) => i.label === "View changes");
    const mirrored = buildChatItems(baseCtx({ mirrored: true })).find((i) => i.label === "View changes");
    expect(!!local.run).toBe(!!mirrored.run);
    expect(local.disabledReason).toBe(mirrored.disabledReason);
  });

  it("still disables VS Code / Terminal / File Explorer (open-in-editor/explorer) for a mirrored chat", () => {
    const items = buildOpenProjectItems(baseCtx({ mirrored: true }));
    for (const label of ["VS Code", "Terminal", "File Explorer"]) {
      const item = items.find((i) => i.label === label);
      expect(item.run, `${label} must stay disabled when mirrored`).toBeUndefined();
      expect(item.disabledReason).toBe("Chat is on another machine");
    }
  });

  it("enables VS Code / Terminal / File Explorer for a non-mirrored chat with a cwd", () => {
    const items = buildOpenProjectItems(baseCtx({ mirrored: false }));
    for (const label of ["VS Code", "Terminal"]) {
      const item = items.find((i) => i.label === label);
      expect(item.run, `${label} must be enabled locally`).toBeTypeOf("function");
      expect(item.disabledReason).toBeUndefined();
    }
  });
});
