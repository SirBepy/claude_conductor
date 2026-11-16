// Right-click on a sidebar row opens a flat menu (Joe, 2026-11-09; Freeze was
// dropped when freezing became automatic): Copy PID, Hide, Close. A draft row has no process, so it gets only
// Delete draft. No submenus: the full menu is the phone header's dropdown and, on desktop, the command palette.

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, stateMock, hiddenSet } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  stateMock: { sessions: [], selectedId: null, activeChatActions: null, renderer: null, pendingNewSession: null },
  hiddenSet: new Set(),
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
  isSubchatsOn: () => false,
}));
vi.mock("../src/views/sessions/sessions-helpers.ts", () => ({
  loadHiddenSessions: () => new Set(hiddenSet),
  saveHiddenSessions: (s) => { hiddenSet.clear(); for (const id of s) hiddenSet.add(id); },
  loadHiddenCollapsed: () => false,
  saveHiddenCollapsed: () => {},
  toggleSegCollapse: () => {},
  isMirrored: (i) => i?.machine != null,
  isSubchat: (i) => i?.subchat_of != null,
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
vi.mock("../src/views/sessions/send-with-failure-recovery.ts", () => ({ sendWithFailureRecovery: vi.fn() }));
vi.mock("../src/shared/chat/event-store.ts", () => ({
  sessionEvents: { pushSynthetic: vi.fn(), removeSynthetic: vi.fn() },
}));
vi.mock("../src/views/sessions/sidebar-anim.ts", () => ({
  loadAnimEnabled: () => false,
  markSessionExiting: vi.fn(),
}));

const { openCtxMenu, openDraftCtxMenu, closeCtxMenu } = await import("../src/views/sessions/sidebar-ctx-menu.ts");

const flush = () => new Promise((r) => setTimeout(r, 0));
const row = (id) => {
  document.body.innerHTML = `<ul id="sessions-list"><li data-session-id="${id}">${id}</li></ul>`;
  return document.querySelector("li");
};
const labels = () => [...document.querySelectorAll(".session-ctx-menu .smore-item")].map((b) => b.textContent);
const item = (label) => [...document.querySelectorAll(".session-ctx-menu .smore-item")].find((b) => b.textContent === label);

beforeEach(() => {
  closeCtxMenu();
  invokeMock.mockClear();
  hiddenSet.clear();
  stateMock.pendingNewSession = null;
});

describe("sidebar row menu", () => {
  it("lists exactly Copy PID, Hide and Close, with no Freeze and no submenu parents", () => {
    stateMock.sessions = [{ session_id: "a", pid: 4242, cwd: "/repo", kind: "interactive" }];
    openCtxMenu("a", row("a"));
    expect(labels()).toEqual(["Copy PID", "Hide chat", "Close session"]);
    expect(document.querySelector(".smore-has-sub")).toBeNull();
  });

  it("names the toggles by the chat's state", () => {
    stateMock.sessions = [{ session_id: "a", pid: 1, cwd: "/repo", kind: "interactive", frozen: true }];
    hiddenSet.add("a");
    openCtxMenu("a", row("a"));
    expect(labels()).toEqual(["Copy PID", "Unhide chat", "Close session"]);
  });

  it("Copy PID copies the process id and closes the menu", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    stateMock.sessions = [{ session_id: "a", pid: 4242, cwd: "/repo", kind: "interactive" }];
    openCtxMenu("a", row("a"));
    item("Copy PID").click();
    expect(writeText).toHaveBeenCalledWith("4242");
    expect(document.querySelector(".session-ctx-menu")).toBeNull();
  });

  it("Hide hides the chat and closes the menu", () => {
    stateMock.sessions = [{ session_id: "a", pid: 1, cwd: "/repo", kind: "interactive" }];
    openCtxMenu("a", row("a"));
    item("Hide chat").click();
    expect(hiddenSet.has("a")).toBe(true);
    expect(document.querySelector(".session-ctx-menu")).toBeNull();
  });

  it("a draft row gets only Delete draft, which runs the row's discard", () => {
    const onDiscard = vi.fn();
    openDraftCtxMenu(row("p"), onDiscard, "/repo");
    expect(labels()).toEqual(["Delete draft"]);
    item("Delete draft").click();
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
