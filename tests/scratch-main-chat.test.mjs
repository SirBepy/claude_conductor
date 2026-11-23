// @vitest-environment jsdom
// The "No project" folder (the Obsidian vault): every main chat there stands alone. A draft is a
// plain chat unless its "Make this a main chat" switch is on, and then it becomes a main chat of its
// own, never a message into another one (pc-1806 step 7 shared one scratch main chat, replaced
// 2026-11-23). Every other project's draft keeps the old behaviour (a main chat takes the message
// unless "Plain chat instead").

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/views/sessions/pending-draft-storage.ts", () => ({ savePendingSession: vi.fn() }));
vi.mock("../src/shared/api.ts", () => ({ api: { listProjects: vi.fn(async () => []) } }));

const { adoptSubchatsOn } = await import("../src/views/sessions/permission-modal/gating.ts");
const { setProjectMainChatsForTest, mainChatFor, reopenTargetFor, listedAsProjectMain, isPointedMainChat, ownMainChatsFor } = await import("../src/views/sessions/project-main-chats.ts");
const { mountDraftSubchats, draftRouteTarget, isScratchDraft, syncDraftSubchats } = await import("../src/views/sessions/draft-subchats.ts");
const { state } = await import("../src/views/sessions/state.ts");
const { setCachedAccounts } = await import("../src/shared/accounts-cache.ts");

const VAULT = "C:\\Users\\tecno\\Documents\\ObsidianVault";
const OTHER = "C:/Projects/cv";
const acct = (id, kind) => ({ id, label: id, icon: "x", colour: "#fff", kind });
const inst = (over = {}) => ({
  session_id: "scratch", pid: 1, cwd: VAULT, project_id: "p-vault", kind: "interactive", is_remote: false,
  started_at: "2026-11-21T10:00:00Z", transcript_path: null, name: "Scratch pad", ended_at: null, end_reason: null,
  busy: false, awaiting: null, closing: false, subchat_of: null, subchat_finished: false, progress: { plan: null, state_since: null },
  ...over,
});

let pane;
let config;

function draft(path, over = {}) {
  config = { model: "sonnet", effort: "low", accountId: "sub", ...over };
  state.pendingNewSession = { placeholderId: "p1", projectPath: path, config };
  mountDraftSubchats(pane, config);
  syncDraftSubchats(pane, config);
}

const route = () => pane.querySelector(".draft-main-route");
const routeInput = () => route().querySelector("input");
const useRow = () => pane.querySelector(".draft-subchats");
const flip = (checked) => {
  routeInput().checked = checked;
  routeInput().dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = `<div id="pane"><div class="session-messages"></div><div class="composer-shell"></div></div>`;
  pane = document.getElementById("pane");
  state.sessions = [];
  state.pendingNewSession = null;
  state.statusbar = { syncModelEffort: vi.fn() };
  setCachedAccounts([acct("sub", "subscription"), acct("api", "api_credit")]);
  setProjectMainChatsForTest([
    { id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: null },
    { id: "p-cv", path: OTHER, name: "cv-site", mainChatId: null },
  ]);
});

describe("a draft in the No project folder", () => {
  it("is a scratch draft only on this machine's vault", () => {
    expect(isScratchDraft({ ...{ model: "x", effort: "y" } })).toBe(false);
    draft(VAULT);
    expect(isScratchDraft(config)).toBe(true);
    draft(OTHER);
    expect(isScratchDraft(config)).toBe(false);
    draft(VAULT, { machineId: "m1" });
    expect(isScratchDraft(config)).toBe(false);
  });

  it("shows the Make this a main chat switch, off, and never the Use subchats row", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false });
    expect(route().hidden).toBe(false);
    expect(route().querySelector(".dmr-switch-label").textContent).toBe("Make this a main chat");
    expect(routeInput().getAttribute("aria-label")).toBe("Make this a main chat");
    expect(routeInput().checked).toBe(false);
    expect(route().querySelector(".dmr-line").textContent).toBe("A plain chat");
    expect(useRow().hidden).toBe(true);
  });

  it("switching on makes this draft a main chat of its own (mode on, not plain)", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false });
    flip(true);
    expect(config).toMatchObject({ plainChat: false, subchatsOn: true, model: "sonnet", effort: "high" });
    expect(route().querySelector(".dmr-line").textContent).toBe("A main chat of its own");
    expect(draftRouteTarget(config)).toBeNull();
    flip(false);
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false, effort: "low" });
  });

  it("an open main chat in the folder never takes a draft's message, switch on or off: the draft is its own main chat", () => {
    setProjectMainChatsForTest([{ id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: "scratch" }]);
    adoptSubchatsOn("scratch");
    state.sessions = [inst()];
    draft(VAULT, { plainChat: true, subchatsOn: false });
    expect(draftRouteTarget(config)).toBeNull();
    expect(routeInput().checked).toBe(false);

    flip(true);
    expect(draftRouteTarget(config)).toBeNull();
    expect(config).toMatchObject({ plainChat: false, subchatsOn: true });
    expect(route().querySelector(".dmr-line").textContent).toBe("A main chat of its own");
    expect(routeInput().checked).toBe(true);
    expect(route().classList.contains("is-on")).toBe(true);
  });

  it("a put-away main chat in the folder is not offered as a reopen either", () => {
    setProjectMainChatsForTest([{ id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: "scratch" }]);
    adoptSubchatsOn("scratch");
    state.sessions = [inst({ hidden_at: "2026-11-21T11:00:00Z" })];
    draft(VAULT, { plainChat: true, subchatsOn: false });
    flip(true);
    expect(route().querySelector(".dmr-line").textContent).toBe("A main chat of its own");
    expect(reopenTargetFor(VAULT, state.sessions)).toBeNull();
    expect(mainChatFor(VAULT, state.sessions)).toBeNull();
  });

  it("an API-credit account cannot switch it on, even with a main chat open in the folder", () => {
    adoptSubchatsOn("scratch");
    state.sessions = [inst()];
    draft(VAULT, { plainChat: true, subchatsOn: false, accountId: "api" });
    expect(routeInput().disabled).toBe(true);
    expect(route().title).toContain("API-credit");
    config.accountId = "sub";
    syncDraftSubchats(pane, config);
    expect(routeInput().disabled).toBe(false);
  });

  it("an account that moves to API credit under an on switch turns it back off", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false });
    flip(true);
    config.accountId = "api";
    syncDraftSubchats(pane, config);
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false });
    expect(routeInput().checked).toBe(false);
  });

  it("a draft that never chose (an older saved draft, the Chats window's +) is plain, whatever its mode flag said", () => {
    draft(VAULT, { subchatsOn: false });
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false });
    expect(routeInput().checked).toBe(false);
    draft(VAULT, { subchatsOn: true });
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false });
    expect(routeInput().checked).toBe(false);
    draft(VAULT);
    expect(config).toMatchObject({ plainChat: true });
    expect(routeInput().checked).toBe(false);
  });

  it("the switch never says on while the spawn would be plain: the mode comes back once the API-credit block is gone", () => {
    draft(VAULT, { plainChat: false, subchatsOn: false, accountId: "api" });
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false });
    flip(true);
    expect(config).toMatchObject({ plainChat: true, subchatsOn: false });
    // The account moves to a subscription: the next repaint of a draft that chose "on" brings the mode back.
    config.plainChat = false;
    config.accountId = "sub";
    syncDraftSubchats(pane, config);
    expect(routeInput().checked).toBe(true);
    expect(config).toMatchObject({ plainChat: false, subchatsOn: true });
  });

  it("a card chat (third-party text in hand) gets no switch and stays plain", () => {
    draft(VAULT, { plainChat: true, subchatsOn: false, initialMessage: "do the card" });
    expect(route().hidden).toBe(true);
    expect(useRow().hidden).toBe(true);
  });
});

describe("main chats in the No project folder", () => {
  const other = (id) => inst({ session_id: id, name: id });

  it("each one is listed and offers put-away, whichever the project's pointer names", () => {
    setProjectMainChatsForTest([{ id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: "first" }]);
    adoptSubchatsOn("first");
    adoptSubchatsOn("second");
    state.sessions = [other("first"), other("second"), other("plain")];
    expect(listedAsProjectMain(state.sessions[0], state.sessions)).toBe(true);
    expect(listedAsProjectMain(state.sessions[1], state.sessions)).toBe(true);
    expect(isPointedMainChat(state.sessions[0], state.sessions)).toBe(true);
    expect(isPointedMainChat(state.sessions[1], state.sessions)).toBe(true);
    expect(isPointedMainChat(state.sessions[2], state.sessions)).toBe(false);
  });

  it("the dashboard door lists every open one, put away or live, newest first, and nothing for another project", () => {
    setProjectMainChatsForTest([
      { id: "p-vault", path: VAULT, name: "ObsidianVault", mainChatId: null },
      { id: "p-cv", path: OTHER, name: "cv-site", mainChatId: null },
    ]);
    adoptSubchatsOn("old");
    adoptSubchatsOn("new");
    const old = other("old");
    const away = { ...old, hidden_at: "2026-11-22T10:00:00Z" };
    const fresh = { ...other("new"), started_at: "2026-11-23T10:00:00Z" };
    const door = ownMainChatsFor(VAULT, [away, fresh, other("plain")]);
    expect(door.map((d) => [d.chat.session_id, d.putAway])).toEqual([["new", false], ["old", true]]);
    expect(ownMainChatsFor(OTHER, [away, fresh])).toEqual([]);
  });

  it("another project still lists only its pointed main chat", () => {
    setProjectMainChatsForTest([{ id: "p-cv", path: OTHER, name: "cv-site", mainChatId: "first" }]);
    adoptSubchatsOn("first");
    adoptSubchatsOn("second");
    const a = inst({ session_id: "first", project_id: "p-cv", cwd: OTHER });
    const b = inst({ session_id: "second", project_id: "p-cv", cwd: OTHER });
    expect(listedAsProjectMain(b, [a, b])).toBe(false);
    expect(isPointedMainChat(b, [a, b])).toBe(false);
    expect(isPointedMainChat(a, [a, b])).toBe(true);
  });
});

describe("a draft anywhere else", () => {
  it("still routes to the project's main chat by default, with the Plain chat instead switch", () => {
    setProjectMainChatsForTest([{ id: "p-cv", path: OTHER, name: "cv-site", mainChatId: "main" }]);
    adoptSubchatsOn("main");
    state.sessions = [inst({ session_id: "main", cwd: OTHER, project_id: "p-cv", name: "CV redesign" })];
    draft(OTHER, { subchatsOn: true });
    expect(draftRouteTarget(config)?.chat.session_id).toBe("main");
    expect(route().hidden).toBe(false);
    expect(route().querySelector(".dmr-switch-label").textContent).toBe("Plain chat instead");
    expect(routeInput().checked).toBe(false);
    expect(route().querySelector(".dmr-line").textContent).toContain("cv-site's main chat");
    expect(useRow().hidden).toBe(true);
  });

  it("a project with no main chat keeps the Use subchats row and hides the route", () => {
    draft(OTHER, { subchatsOn: true });
    expect(route().hidden).toBe(true);
    expect(useRow().hidden).toBe(false);
  });
});
