// The Deploy action (Agent submenu, chat-menu.ts) must never reimplement
// `/deploy` - it only injects the literal text through the same
// sendWithFailureRecovery path the real composer uses. This locks the exact
// blocks/session/cwd shape and the disabled gating (draft / no session /
// read-only), so a future edit can't silently start shelling out or sending
// `/deploy go` (which would skip the skill's own ref-confirmation step).

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, sendMock, pushSyntheticMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sendMock: vi.fn(),
  pushSyntheticMock: vi.fn(),
}));

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
vi.mock("../src/views/sessions/close-chat.ts", () => ({ closeChat: vi.fn() }));
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
  sendWithFailureRecovery: sendMock,
}));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { pushSynthetic: pushSyntheticMock, removeSynthetic: vi.fn() },
}));

const { buildChatMenuBlock } = await import("../src/views/sessions/chat-menu.ts");

function baseCtx(overrides = {}) {
  return {
    kind: "live",
    sessionId: "sess-1",
    cwd: "/repo",
    pid: 123,
    readOnly: false,
    autoAcceptOn: false,
    isHidden: false,
    ...overrides,
  };
}

/** Open the Agent submenu and return its Deploy item button. */
function openAgentAndFindDeploy(block) {
  const agentParent = [...block.querySelectorAll(".smore-has-sub")].find(
    (b) => b.dataset.subLabel === "Agent",
  );
  agentParent.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const sub = document.querySelector('.chat-menu-submenu[data-sub-for="Agent"]');
  return [...sub.querySelectorAll(".smore-item")].find((b) => b.textContent.includes("Deploy"));
}

describe("chat-menu Deploy action", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    invokeMock.mockReset();
    sendMock.mockReset().mockResolvedValue(undefined);
    pushSyntheticMock.mockReset();
  });

  it("injects the literal /deploy via sendWithFailureRecovery, never a second implementation", async () => {
    const closeMenu = vi.fn();
    const block = buildChatMenuBlock(baseCtx(), closeMenu);
    document.body.appendChild(block);

    const deployBtn = openAgentAndFindDeploy(block);
    expect(deployBtn).toBeTruthy();
    expect(deployBtn.classList.contains("is-disabled")).toBe(false);

    deployBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    // Never calls invoke("send_message", ...) or anything else directly -
    // the only path to the daemon is the shared retry-safe helper.
    expect(invokeMock).not.toHaveBeenCalled();

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [sessionId, cwd, blocks] = sendMock.mock.calls[0];
    expect(sessionId).toBe("sess-1");
    expect(cwd).toBe("/repo");
    expect(blocks).toEqual([{ type: "text", text: "/deploy" }]);

    expect(pushSyntheticMock).toHaveBeenCalledTimes(1);
    expect(closeMenu).toHaveBeenCalled();
  });

  it("is disabled for a draft with no active agent yet", () => {
    const block = buildChatMenuBlock(baseCtx({ kind: "draft", sessionId: null }), vi.fn());
    document.body.appendChild(block);

    const deployBtn = openAgentAndFindDeploy(block);
    expect(deployBtn.classList.contains("is-disabled")).toBe(true);
    expect(deployBtn.title).toBe("No active agent");

    deployBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("is disabled for a read-only (external/automated) session", () => {
    const block = buildChatMenuBlock(baseCtx({ readOnly: true }), vi.fn());
    document.body.appendChild(block);

    const deployBtn = openAgentAndFindDeploy(block);
    expect(deployBtn.classList.contains("is-disabled")).toBe(true);
    expect(deployBtn.title).toBe("Only available for interactive chats");

    deployBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(sendMock).not.toHaveBeenCalled();
  });
});
