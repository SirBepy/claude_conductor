// @vitest-environment jsdom
// "Use subchats" in the chat's ... menu: sits next to "Wrap up when done", toggles
// the per-chat mode, and is unavailable (with the reason) on an API-credit chat.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { isSubchatsOnMock, setSubchatsOnMock, rerenderMock } = vi.hoisted(() => ({
  isSubchatsOnMock: vi.fn(() => false),
  setSubchatsOnMock: vi.fn(async () => {}),
  rerenderMock: vi.fn(),
}));

vi.mock("../src/shared/ipc.ts", () => ({ invoke: vi.fn() }));
vi.mock("../src/shared/http-transport.ts", () => ({
  RemoteUnavailableError: class RemoteUnavailableError extends Error {},
}));
vi.mock("../src/shared/transport.ts", () => ({ isRemote: () => false }));
vi.mock("../src/views/sessions/permission-modal", () => ({
  isAutoAccept: () => false,
  setAutoAccept: () => {},
  autoAcceptParked: () => {},
  isWrapUpOnDone: () => false,
  setWrapUpOnDone: () => {},
  isSubchatsOn: isSubchatsOnMock,
  setSubchatsOn: setSubchatsOnMock,
  rerenderSidebar: rerenderMock,
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadHiddenSessions: () => new Set(),
  saveHiddenSessions: () => {},
}));
vi.mock("../src/shared/chat/message-filter-pref.ts", () => ({
  isRawViewEnabled: () => false,
  setRawViewEnabled: () => {},
}));
vi.mock("../src/views/sessions/state.ts", () => ({
  state: { renderer: null, statusbar: null, selectedId: "s1" },
}));
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

const { buildConfigureItems } = await import("../src/views/sessions/chat-menu-items.ts");
const { subchatsBlockedReason, SUBCHATS_API_CREDIT_REASON } = await import("../src/views/sessions/subchats-gate.ts");
const { setCachedAccounts } = await import("../src/shared/accounts-cache.ts");

const ctx = (over = {}) => ({
  kind: "live", sessionId: "s1", cwd: "C:/p", pid: 1, readOnly: false, autoAcceptOn: false,
  wrapUpOnDoneOn: false, subchatsOn: false, isHidden: false, ...over,
});
const find = (items) => items.find((i) => i.label === "Use subchats");

beforeEach(() => {
  isSubchatsOnMock.mockReset().mockReturnValue(false);
  setSubchatsOnMock.mockReset().mockResolvedValue(undefined);
  rerenderMock.mockReset();
  vi.stubGlobal("alert", vi.fn());
  setCachedAccounts([]);
});

describe("Use subchats menu item", () => {
  it("is listed right after Wrap up when done", () => {
    const labels = buildConfigureItems(ctx()).map((i) => i.label);
    expect(labels.indexOf("Use subchats")).toBe(labels.indexOf("Wrap up when done") + 1);
  });

  it("is not offered to a sub, which cannot have subs of its own", () => {
    expect(find(buildConfigureItems(ctx({ isSub: true })))).toBeUndefined();
    expect(find(buildConfigureItems(ctx({ isSub: false })))).toBeDefined();
    const labels = buildConfigureItems(ctx({ isSub: true })).map((i) => i.label);
    expect(labels).toContain("Wrap up when done");
  });

  it("shows its on state as the check dot", () => {
    expect(find(buildConfigureItems(ctx({ subchatsOn: true }))).checkDot).toBe(true);
    expect(find(buildConfigureItems(ctx({ subchatsOn: false }))).checkDot).toBe(false);
  });

  it("turns the mode on when it is off, and off when it is on", async () => {
    await find(buildConfigureItems(ctx())).run();
    expect(setSubchatsOnMock).toHaveBeenLastCalledWith("s1", true);

    isSubchatsOnMock.mockReturnValue(true);
    await find(buildConfigureItems(ctx({ subchatsOn: true }))).run();
    expect(setSubchatsOnMock).toHaveBeenLastCalledWith("s1", false);
    expect(rerenderMock).toHaveBeenCalledTimes(2);
  });

  it("is disabled with the reason on an API-credit chat and cannot run", () => {
    const item = find(buildConfigureItems(ctx({ subchatsBlockedReason: SUBCHATS_API_CREDIT_REASON })));
    expect(item.disabledReason).toBe(SUBCHATS_API_CREDIT_REASON);
    expect(item.run).toBeUndefined();
  });

  it("can still be turned off on a chat that moved to API credit while it was on", async () => {
    isSubchatsOnMock.mockReturnValue(true);
    const item = find(buildConfigureItems(ctx({ subchatsOn: true, subchatsBlockedReason: SUBCHATS_API_CREDIT_REASON })));
    expect(item.disabledReason).toBeUndefined();
    await item.run();
    expect(setSubchatsOnMock).toHaveBeenLastCalledWith("s1", false);
  });

  it("is unavailable for a draft", () => {
    const item = find(buildConfigureItems(ctx({ kind: "draft", sessionId: null })));
    expect(item.disabledReason).toBe("Available once the chat starts");
    expect(item.run).toBeUndefined();
  });

  it("tells Joe when the daemon refuses the flip", async () => {
    setSubchatsOnMock.mockRejectedValue("refused: API-credit");
    await find(buildConfigureItems(ctx())).run();
    expect(globalThis.alert).toHaveBeenCalledWith(expect.stringContaining("refused: API-credit"));
  });
});

describe("subchatsBlockedReason (reads the session's account kind)", () => {
  const acct = (id, kind) => ({ id, label: id, icon: "x", colour: "#fff", kind });

  it("names the reason for an API-credit account only", () => {
    setCachedAccounts([acct("api", "api_credit"), acct("sub", "subscription")]);
    expect(subchatsBlockedReason("api")).toBe(SUBCHATS_API_CREDIT_REASON);
    expect(subchatsBlockedReason("sub")).toBeUndefined();
  });

  it("lets an unknown or missing account through; the daemon decides", () => {
    setCachedAccounts([acct("api", "api_credit")]);
    expect(subchatsBlockedReason("ghost")).toBeUndefined();
    expect(subchatsBlockedReason(null)).toBeUndefined();
    expect(subchatsBlockedReason(undefined)).toBeUndefined();
  });
});
