// @vitest-environment jsdom
// Todo 990 (heldSend half): pending-pane.ts's heldSend used to silently
// `return` when the placeholder hadn't upgraded to a real session id yet -
// resolving as though the held bundle had been delivered. HeldMessages.flush()
// awaits this `send`, so a silent resolve meant its state was already cleared
// with nothing to roll back. heldSend must now reject instead, so flush()'s
// restage-on-failure catch has something to catch.
import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMock = { impl: async () => null };
vi.mock("../src/shared/ipc.ts", () => ({
  invoke: vi.fn((cmd, args) => ipcMock.impl(cmd, args)),
}));

vi.mock("../src/shared/api.ts", () => ({ api: { setSessionCharacter: vi.fn(async () => {}) } }));
vi.mock("../src/shared/chat/chat-renderer.ts", () => ({
  ChatRenderer: vi.fn().mockImplementation(() => ({
    detach: vi.fn(),
    attach: vi.fn(async () => {}),
    currentSessionId: vi.fn(() => null),
    swapSubscription: vi.fn(async () => {}),
    toolTally: { byType: [] },
    getFileEdits: vi.fn(() => []),
  })),
}));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: {
    subscribe: vi.fn(() => () => {}),
    pushSynthetic: vi.fn(),
    removeSynthetic: vi.fn(),
    hasMore: vi.fn(() => false),
  },
}));
vi.mock("../src/shared/chat/pr-review-modal.ts", () => ({ setPrReviewCwdProvider: vi.fn() }));
vi.mock("../src/shared/chat/composer.ts", () => ({
  Composer: vi.fn().mockImplementation(() => ({
    destroy: vi.fn(),
    setSessionId: vi.fn(),
    getDraftBlocks: vi.fn(() => []),
    isDraftEmpty: vi.fn(() => true),
    isComposing: vi.fn(() => false),
    clearComposer: vi.fn(),
    focus: vi.fn(),
  })),
}));

// The one mock this file cares about: capture the `send` (heldSend) closure
// pending-pane.ts hands to HeldMessages.attach, instead of exercising the
// real held-messages.ts controller.
let captured = null;
vi.mock("../src/shared/chat/held-messages.ts", () => ({
  HeldMessages: vi.fn().mockImplementation(() => ({
    attach: vi.fn((opts) => { captured = opts; }),
  })),
}));

vi.mock("../src/shared/chat/schedule-picker.ts", () => ({ formatFireAt: vi.fn((x) => String(x)) }));
vi.mock("../src/views/sessions/session-thinking-bar.ts", () => ({
  isCurrentSessionBusy: vi.fn(() => false),
  updateThinkingBar: vi.fn(),
  syncThinkingBar: vi.fn(),
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  projectName: vi.fn(() => ""),
  sessionSubtitle: vi.fn(() => ""),
}));
vi.mock("../src/views/sessions/sidebar.ts", () => ({
  renderSidebar: vi.fn(),
  refreshSessions: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/session-characters.ts", () => ({
  characterForSession: vi.fn(() => null),
  characterIconUrl: vi.fn(() => ""),
}));
vi.mock("../src/shared/projects.ts", () => ({
  hydrateCharacterAvatars: vi.fn(async () => {}),
  hydrateProjectTechIcons: vi.fn(async () => {}),
}));
vi.mock("../src/views/sessions/permission-modal/index.ts", () => ({
  isAutoAccept: vi.fn(() => false),
  setAutoAccept: vi.fn(),
  setSelectedSessionId: vi.fn(),
}));
vi.mock("../src/views/sessions/changes-panel.ts", () => ({
  ChangesPanel: vi.fn(),
  dedupeByPath: vi.fn(() => []),
}));
vi.mock("../src/views/sessions/active-session-mount.ts", () => ({ wireRenderer: vi.fn() }));
vi.mock("../src/views/sessions/chat-pane-cache.ts", () => ({ retainChat: vi.fn() }));

const sendWithFailureRecovery = vi.fn(async () => {});
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({ sendWithFailureRecovery }));

const { renderPendingPane } = await import("../src/views/sessions/pending-pane.ts");
const { state } = await import("../src/views/sessions/state.ts");

const PLACEHOLDER = "pending-1";

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

beforeEach(async () => {
  document.body.innerHTML = "";
  ipcMock.impl = async () => null;
  captured = null;
  sendWithFailureRecovery.mockClear();
  state.pendingNewSession = null;
  state.selectedId = null;

  const pane = document.createElement("div");
  document.body.appendChild(pane);
  await renderPendingPane(pane, PLACEHOLDER, { path: "/proj", name: "proj" }, { model: "opus", effort: "high" });
  await flush();
});

describe("pending-pane heldSend: unresolved real id", () => {
  it("rejects instead of silently resolving when no real id has landed yet", async () => {
    // No pendingNewSession.realId and no selectedId at all - the "!target" arm.
    expect(captured?.send).toBeTypeOf("function");
    await expect(captured.send([{ type: "text", text: "hi" }])).rejects.toThrow();
    expect(sendWithFailureRecovery).not.toHaveBeenCalled();
  });

  it("rejects when selectedId still points at the placeholder itself", async () => {
    state.selectedId = PLACEHOLDER;
    await expect(captured.send([{ type: "text", text: "hi" }])).rejects.toThrow();
    expect(sendWithFailureRecovery).not.toHaveBeenCalled();
  });

  it("delivers once a real session id has actually resolved", async () => {
    state.pendingNewSession = { placeholderId: PLACEHOLDER, realId: "real-xyz" };
    await expect(captured.send([{ type: "text", text: "hi" }])).resolves.toBeUndefined();
    expect(sendWithFailureRecovery).toHaveBeenCalledTimes(1);
  });
});
